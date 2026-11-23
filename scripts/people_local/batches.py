"""Sending passages to the Anthropic Message Batches API and reading the replies back.

Only this module talks to Anthropic. It signs in exactly as the Hacker News pipeline does (see
hn_local/anthropic_api.py): ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN when set, otherwise the sign-in
stored by `ant auth login`, read by Anthropic's own package, at the fixed address api.anthropic.com.
That package is not in the standard library, so a paid review runs with the Hacker News
environment's Python (.local/hn/venv/bin/python); every other command runs with the system python3.
"""

import json
import re
import time
from collections import Counter

from hn_local.sources import PipelineError

from .review import ReviewError, params, repair, validate
from .state import RATES

BATCH_SIZE = 2000
POLL_SECONDS = 60
BATCH_ID = re.compile(r'msgbatch_[A-Za-z\d]+')


def anthropic_client():
    """The Hacker News pipeline's client, built the same way. Raises PipelineError without a credential."""
    try:
        import anthropic
        from hn_local.anthropic_api import API_URL, api_error
    except ImportError:
        raise PipelineError('anthropic-package-missing') from None
    try:
        client = anthropic.Anthropic(base_url=API_URL, max_retries=6)
    except anthropic.AnthropicError as error:
        raise api_error(error) from None
    if client.api_key is None and client.auth_token is None and client.credentials is None:
        raise PipelineError('anthropic-api-credential-missing')
    return client, (anthropic.AnthropicError, api_error)


class Batches:
    """Batch calls on `client.messages.batches`. A test passes a stand-in client and no `errors`."""

    def __init__(self, client, errors=None):
        self.batches = client.messages.batches
        self.errors = errors

    def call(self, action, value):
        caught = self.errors[0] if self.errors else ()
        try:
            if action == 'create':
                return self.batches.create(requests=value).id
            if action == 'retrieve':
                return self.batches.retrieve(value).processing_status
            return [entry.model_dump(mode='json') for entry in self.batches.results(value)]
        except caught as error:
            raise self.errors[1](error) from None


def submit(checkpoint, api, limit=None):
    """Send queued passages in batches of up to 2,000; return the number sent. A batch whose creation
    was not confirmed blocks the next submission until it is checked by hand."""
    sent = 0
    db = checkpoint.db
    while limit is None or sent < limit:
        size = BATCH_SIZE if limit is None else min(BATCH_SIZE, limit - sent)
        with db:
            if db.execute("SELECT 1 FROM batches WHERE state='submitting'").fetchone():
                raise PipelineError('previous-submission-unconfirmed')
            rows = db.execute("SELECT * FROM jobs WHERE state='queued' ORDER BY id LIMIT ?", (size,)).fetchall()
            if not rows:
                return sent
            local = db.execute("INSERT INTO batches (state) VALUES ('submitting')").lastrowid
            db.executemany("UPDATE jobs SET batch=?, state='in batch' WHERE id=?", ((local, row['id']) for row in rows))
        requests = [{'custom_id': row['id'], 'params': params(row['payload'], row['attempts'] > 0)} for row in rows]
        try:
            remote = api.call('create', requests)
        except PipelineError as error:
            if str(error).startswith('anthropic-api-status-4') or 'credential' in str(error):
                with db:
                    db.execute("UPDATE jobs SET batch=NULL, state='queued' WHERE batch=?", (local,))
                    db.execute("UPDATE batches SET state='rejected' WHERE local_id=?", (local,))
            raise
        if not isinstance(remote, str) or not BATCH_ID.fullmatch(remote):
            raise PipelineError('unrecognized-batch-id')
        with db:
            db.execute("UPDATE batches SET remote_id=?, state='submitted' WHERE local_id=?", (remote, local))
            db.execute('UPDATE jobs SET attempts=attempts+1 WHERE batch=?', (local,))
        sent += len(rows)
        print(f'Submitted batch {local} with {len(rows):,} passages', flush=True)
    return sent


def judge(result, row, privacy):
    """(state, stored reply, issue) for one batch result. An invalid reply is queued once more;
    after its second attempt it is unresolved. Expired or cancelled requests stay queued."""
    message = result.get('message') or {}
    try:
        if result.get('type') != 'succeeded':
            raise ReviewError('provider-' + str(result.get('type', 'unknown')))
        if message.get('stop_reason') == 'max_tokens':
            raise ReviewError('response-truncated')
        if message.get('stop_reason') == 'refusal':
            raise ReviewError('refusal')
        text = ''.join(block['text'] for block in message['content'] if block['type'] == 'text').strip()
        job = json.loads(row['payload'])
        reply, fixes = repair(json.loads(text), job)
        return 'valid', validate(reply, job, privacy), f'repaired:{fixes}' if fixes else None
    except (ReviewError, ValueError, KeyError, TypeError) as error:
        issue = str(error) if isinstance(error, ReviewError) else 'invalid-response-json'
        expired = issue in ('provider-expired', 'provider-canceled')
        return ('queued' if row['attempts'] < 2 or expired else 'unresolved'), None, issue


def collect(checkpoint, api, privacy):
    """Store the replies of every ended batch, checked against the review's rules."""
    db = checkpoint.db
    for batch in db.execute("SELECT * FROM batches WHERE state='submitted' ORDER BY local_id").fetchall():
        if api.call('retrieve', batch['remote_id']) != 'ended':
            continue
        results = {entry.get('custom_id', ''): entry.get('result', {}) for entry in api.call('results', batch['remote_id'])}
        rows = db.execute('SELECT * FROM jobs WHERE batch=?', (batch['local_id'],)).fetchall()
        if set(results) != {row['id'] for row in rows}:
            raise PipelineError('result-ids-do-not-match-jobs')
        counted = Counter()
        with db:
            for row in rows:
                result = results[row['id']]
                usage = {name: ((result.get('message') or {}).get('usage') or {}).get(name, 0) or 0 for name in RATES}
                state, reply, issue = judge(result, row, privacy)
                counted[state] += 1
                db.execute('INSERT OR REPLACE INTO usage VALUES (?, ?, ?)', (batch['local_id'], row['id'], json.dumps(usage)))
                db.execute('UPDATE jobs SET state=?, result=?, issue=?, usage=? WHERE id=?',
                           (state, json.dumps(reply) if reply is not None else None, issue, json.dumps(usage), row['id']))
            db.execute("UPDATE batches SET state='collected' WHERE local_id=?", (batch['local_id'],))
        print(f'Collected batch {batch["local_id"]}: {dict(counted)}', flush=True)


def waiting(checkpoint):
    return checkpoint.db.execute("SELECT 1 FROM batches WHERE state='submitted'").fetchone() is not None


def wait(seconds=POLL_SECONDS):
    time.sleep(seconds)

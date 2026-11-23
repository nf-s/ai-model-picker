"""Collect named practitioners' public writing and review it into use records and method advice.

  status     print the stored state as JSON; reads nothing from the network and changes no file
  collect    read each person's feeds, sitemaps and series pages and keep new items
  review     split new items into passages, print the queue and its estimated cost, and with
             --backend anthropic send it for review (paid)
  export     write the use records, advice and status files again from the review checkpoint

People and their feeds come from people.json and sources.json in the state directory. See
docs/people-pipeline.md.
"""

import argparse
import datetime
import json
import os
import sqlite3
import sys
from collections import Counter
from contextlib import ExitStack
from pathlib import Path

from hn_local.classify import Targets
from hn_local.sources import PipelineError
from hn_local.state import writer_lock
from people_local import batches as batch_api
from people_local.collect import discover, gather, known, summary, url_key
from people_local.config import load, redaction_pattern
from people_local.fetch import Fetcher
from people_local.redact import Privacy
from people_local.review import METHODOLOGY, MODEL, PROMPT_SHA256, ReviewError, passages, prompt_hash
from people_local.state import (
    EXCLUSIONS, FETCH_LOG, ITEMS, REVIEW_STATUS, SUMMARY, USD_PER_PASSAGE, Checkpoint, append_line, export, items,
    read_lines, write_json,
)

ROOT = Path(__file__).resolve().parents[1]
STATE_DIR = ROOT / '.local/people'
MODEL_DATA = ROOT / 'src/lib/snapshot.json'


def positive_integer(text):
    value = int(text)
    if value < 1:
        raise argparse.ArgumentTypeError('expected a positive integer')
    return value


def iso_date(text):
    try:
        return datetime.date.fromisoformat(text).isoformat()
    except ValueError:
        raise argparse.ArgumentTypeError('expected a date such as 2026-11-23') from None


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8')) if path.is_file() else None


def status(directory):
    """The stored state, read without a lock, a network request or a write."""
    directory = Path(directory)
    config = load(directory)
    collected = items(directory)
    by_person = Counter(item['person'] for item in collected.values())
    with Checkpoint(directory, readonly=True) as checkpoint:
        prepared = checkpoint.prepared_ids()
        key = checkpoint.key() if checkpoint.db is not None else None
        queued, characters = checkpoint.queue()
        usage, cost = checkpoint.usage()
        states, batches = checkpoint.states(), checkpoint.batches()
    unprepared = sum(1 for item_id in collected if item_id not in prepared)
    review = read_json(directory / REVIEW_STATUS) or {}
    last = read_json(directory / SUMMARY) or {}
    return {
        'people': {
            'listed': len(config.people),
            'collected': sum(not person.dropped for person in config.people),
            'dropped': sum(person.dropped for person in config.people),
            'adviceOnly': sum(person.advice_only for person in config.people),
            'secondary': sum(person.source_class == 'secondary' for person in config.people),
        },
        'items': len(collected),
        'itemsByPerson': {person.name: by_person[person.key] for person in config.people},
        'lastCollection': {key: last[key] for key in ('window', 'discovered', 'new_items', 'items') if key in last},
        'review': {
            'model': MODEL,
            'methodology': METHODOLOGY,
            'instructionsUnchanged': prompt_hash() == PROMPT_SHA256 and (key is None or key[-1] == PROMPT_SHA256),
            'itemsPrepared': len(prepared & set(collected)),
            'itemsNotPrepared': unprepared,
            'passages': states,
            'queued': queued,
            'queuedCharacters': characters,
            'estimatedUsdForQueue': round(queued * USD_PER_PASSAGE, 2),
            'batches': batches,
            'usageTokens': usage,
            'usdFromUsage': cost,
            'useRecords': review.get('use_records'),
            'methodAdvice': review.get('method_advice'),
            'unresolved': states.get('unresolved', 0),
        },
    }


def collect(args):
    directory = args.state_dir
    config = load(directory)
    until = datetime.date.today().isoformat()
    since = args.since or (datetime.date.today() - datetime.timedelta(days=365)).isoformat()
    unknown = set(args.person or ()) - {person.name for person in config.people}
    if unknown:
        raise PipelineError('unknown-person')
    with writer_lock(directory):
        collected = items(directory)
        skip = known(collected, read_lines(directory / EXCLUSIONS), since)
        fetcher = Fetcher(directory / FETCH_LOG, max_requests=args.max_requests)
        jobs, notes = discover(config, fetcher, since, set(args.person or ()))
        print(f'Found {len(jobs):,} links, {sum(url_key(job["url"]) in skip for job in jobs):,} already handled', flush=True)
        kept, excluded = [], []
        for number, job in enumerate(jobs, 1):
            if url_key(job['url']) in skip:
                continue
            item, exclusion = gather(job, fetcher, since, until)
            if item is not None and item['id'] not in collected:
                append_line(directory / ITEMS, item)
                collected[item['id']] = item
                kept.append(item)
            elif exclusion is not None:
                append_line(directory / EXCLUSIONS, exclusion)
                excluded.append(exclusion)
            if number % 25 == 0:
                print(f'{number:,} of {len(jobs):,} links read, {len(kept):,} kept', flush=True)
            if fetcher.max_requests is not None and fetcher.requests >= fetcher.max_requests:
                print('Stopped at the request limit', flush=True)
                break
        result = summary(since, until, len(jobs), kept, excluded, collected, notes)
        write_json(directory / SUMMARY, result)
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


def prepare(config, checkpoint, collected):
    """Split every collected item not yet prepared into passages and queue them. Returns counts."""
    checkpoint.mark_prepared()
    done = checkpoint.prepared_ids()
    targets = None
    privacy = Privacy(redaction_pattern(config))
    added = Counter()
    for item in collected.values():
        if item['id'] in done:
            continue
        person = config.by_key(item['person'])
        if person is None:
            raise PipelineError('collected-item-from-unknown-person')
        if targets is None:
            models = json.loads(MODEL_DATA.read_text(encoding='utf-8'))['models']
            targets = Targets(models), {model['id']: model.get('status') or '' for model in models}
        rows = []
        if item.get('possibly_relevant', True):
            try:
                rows = list(passages(item, person, privacy, *targets))
            except ReviewError:
                added['blocked'] += 1
        checkpoint.add(item['id'], rows)
        added['items'] += 1
        added['passages'] += len(rows)
    return added, privacy


def review(args):
    directory = args.state_dir
    config = load(directory)
    with ExitStack() as stack:
        stack.enter_context(writer_lock(directory))
        checkpoint = stack.enter_context(Checkpoint(directory))
        checkpoint.check_key()
        collected = items(directory)
        added, privacy = prepare(config, checkpoint, collected)
        queued, characters = checkpoint.queue()
        print(json.dumps({
            'newItems': added['items'], 'newPassages': added['passages'], 'blockedByPrivacyCheck': added['blocked'],
            'queued': queued, 'queuedCharacters': characters,
            'estimatedUsd': round(queued * USD_PER_PASSAGE, 2), 'batchesOut': checkpoint.batches().get('submitted', 0),
        }, indent=2), flush=True)
        if args.queue_only:
            return 0
        api = batch_api.Batches(*batch_api.anthropic_client())
        sent = 0
        while True:
            batch_api.collect(checkpoint, api, privacy)
            limit = None if args.max_passages is None else args.max_passages - sent
            if limit is None or limit > 0:
                sent += batch_api.submit(checkpoint, api, limit)
            result = export(directory, checkpoint, collected, config)
            print(json.dumps({key: result[key] for key in ('passage_states', 'use_records', 'method_advice', 'usd_from_usage')}), flush=True)
            if not batch_api.waiting(checkpoint):
                return 0
            batch_api.wait()


def export_command(args):
    config = load(args.state_dir)
    with writer_lock(args.state_dir), Checkpoint(args.state_dir) as checkpoint:
        checkpoint.check_key()
        result = export(args.state_dir, checkpoint, items(args.state_dir), config)
    print(json.dumps(result, indent=2))
    return 0


def arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest='command', required=True)
    status_command = commands.add_parser('status', help='Print the stored state as JSON, without the network')
    collect_command = commands.add_parser('collect', help='Read feeds and pages and keep new items')
    review_command = commands.add_parser('review', help='Queue new passages and, with --backend anthropic, review them')
    exporting = commands.add_parser('export', help='Write the result files again from the review checkpoint')
    for command in (status_command, collect_command, review_command, exporting):
        command.add_argument('--state-dir', type=Path, default=STATE_DIR)
    collect_command.add_argument('--since', type=iso_date, help='First date kept (default: one year ago)')
    collect_command.add_argument('--person', action='append', help='Collect only this person (repeatable)')
    collect_command.add_argument('--max-requests', type=positive_integer, help='Stop after this many requests')
    mode = review_command.add_mutually_exclusive_group(required=True)
    mode.add_argument('--queue-only', action='store_true', help='Queue new passages and print the cost estimate; send nothing')
    mode.add_argument('--backend', choices=('anthropic',), help='anthropic: the paid Message Batches API')
    review_command.add_argument('--max-passages', type=positive_integer, help='Send at most this many passages')
    return parser.parse_args(argv)


def main(argv=None):
    args = arguments(argv)
    os.umask(0o077)
    try:
        if args.command == 'status':
            print(json.dumps(status(args.state_dir), indent=2, ensure_ascii=False))
            return 0
        if args.command == 'collect':
            return collect(args)
        if args.command == 'review':
            return review(args)
        return export_command(args)
    except PipelineError as error:
        print(str(error), file=sys.stderr)
    except KeyboardInterrupt:
        print('interrupted; batches already sent keep running and the next review stores them', file=sys.stderr)
    except (OSError, sqlite3.Error, ValueError, KeyError, TypeError):
        print('pipeline-state-or-dependency-error', file=sys.stderr)
    return 1


if __name__ == '__main__':
    sys.exit(main())

"""Scan Hacker News, expand threads about AI models and review their comments with a model."""

import argparse
import hashlib
import json
import os
import signal
import sqlite3
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path

from hn_local.classify import (
    DEFAULT_ENDPOINT, PIPELINE_VERSION, REMINDER, LocalClassifier, Review, Targets,
    parse_review, plain, review_prompt, sanitize_html,
)
from hn_local.clickhouse import CLICKHOUSE_BATCH_SIZE, ClickHouseReader
from hn_local.sources import RECONCILE_ID, FirebaseReader, Partition, PipelineError, archive_pages, build_plan
from hn_local.state import Counters, Found, State, writer_lock

ROOT = Path(__file__).resolve().parents[1]
MODEL_DATA = ROOT / 'src/lib/snapshot.json'
STATE_DIR = ROOT / '.local/hn'
MAX_BLOCK_SIZE = 64
EXPORT_INTERVAL = 5
REVIEW_PAGE = 32
CONTEXT_PAGE = 256
BATCH_PAGE = 256
BATCH_SIZE = 5_000
BATCH_WAVE = 100_000
BATCH_POLL = 30
# The default model name and classifier ID of each backend.
BACKENDS = {
    'local': ('default_model', 'qwen3.8-27b-4bit-thread-v1'),
    'anthropic': ('claude-haiku-5-5', 'claude-haiku-5.5-thread-v1'),
}
KNOWN_ITEMS = 20_000
MAX_THREAD_DEPTH = 128
STORY_KINDS = ('story', 'poll')


def positive_integer(text):
    value = int(text)
    if value < 1:
        raise argparse.ArgumentTypeError('expected a positive integer')
    return value


def process_block(state, partition, position, items, targets, classifier_key):
    """Count one block and queue what it names: comments by their text, stories by their title."""
    counters = Counters()
    found = Found()
    archive_ids = []
    window = state.scan_window()
    for item in items:
        in_scope = window is None or window.contains(item.created)
        queued = False
        if in_scope and item.kind == 'comment' and item.body:
            queued = bool(targets.mentions(sanitize_html(item.body)))
            if queued:
                found.comments.append((item.id, item.created, item.parent))
        elif in_scope and item.kind in STORY_KINDS and item.title:
            named, certain = targets.title_targets(item.title)
            if named:
                found.stories.append((item.id, item.created, plain(item.title), named, certain))
        counters.add(item, queued, in_scope)
        if partition.source == 'archive' and item.id is not None and item.kind != 'invalid':
            archive_ids.append(item.id)
    if counters.position:
        position = state.checkpoint(partition, position, counters, classifier_key, found, archive_ids)
    return position, counters.position


def consume_partition(state, partition, position, pages, targets, classifier_key, budget, stopped):
    progress = Progress(state)
    while not stopped() and budget[0]:
        page = next(pages, None)
        if page is None:
            break
        for offset in range(0, len(page), MAX_BLOCK_SIZE):
            if stopped() or budget[0] == 0:
                return position
            block = page[offset:offset + MAX_BLOCK_SIZE]
            position, scanned = process_block(state, partition, position, block, targets, classifier_key)
            budget[0] -= scanned
            progress.tick()
    return position


class Progress:
    def __init__(self, state):
        self.state = state
        self.last = time.monotonic()

    def tick(self):
        if time.monotonic() - self.last >= EXPORT_INTERVAL:
            export_progress(self.state)
            self.last = time.monotonic()


def mirror_pages(partition, position, maximum, mirror, firebase):
    high = partition.last_item - position
    low = max(partition.first_item, high - maximum + 1)
    for upper in range(high, low - 1, -CLICKHOUSE_BATCH_SIZE):
        lower = max(low, upper - CLICKHOUSE_BATCH_SIZE + 1)
        try:
            items = mirror.read(lower, upper)
        except PipelineError:
            fallback = Partition(partition.id, 'firebase', upper - lower + 1, lower, upper)
            yield from firebase.pages(fallback, 0, firebase.workers * 2, upper - lower + 1)
            continue
        missing = [
            item_id for item_id in range(upper, lower - 1, -1)
            if item_id not in items or items[item_id].kind == 'invalid'
        ]
        if missing:
            records = firebase.runner.run(firebase.fetch_all(missing))
            items.update((item.id, item) for item in records)
        yield [items[item_id] for item_id in range(upper, lower - 1, -1)]


def reconcile_pages(state, partition, position, maximum, firebase):
    remaining = min(partition.expected_items - position, maximum)
    while remaining:
        count = firebase.cap_page_size(min(remaining, firebase.workers * 2))
        ids = state.gap_ids(position, count)
        if len(ids) != count:
            raise PipelineError('archive-gap-count-mismatch')
        yield firebase.runner.run(firebase.fetch_all(ids))
        position += count
        remaining -= count


def story_targets(targets, story):
    named = (targets.by_label.get((kind, label)) for kind, label in json.loads(story['targets']))
    return tuple(target for target in named if target is not None)


def walk_thread(firebase, story_id, window):
    """Every available comment under a story, as (id, created, parent), inside the scan window."""
    story = firebase.read([story_id]).get(story_id)
    if story is None or story.kind not in STORY_KINDS:
        return []
    comments = []
    seen = set()
    level = list(story.kids)
    while level:
        level = [item_id for item_id in level if item_id not in seen]
        seen.update(level)
        items = firebase.read(level)
        replies = []
        for item_id in level:
            item = items.get(item_id)
            if item is None or item.kind != 'comment':
                continue
            replies.extend(item.kids)
            if item.available and item.parent and (window is None or window.contains(item.created)):
                comments.append((item.id, item.created, item.parent))
        level = replies
    return comments


def expand_stories(state, firebase, targets, classifier, classifier_key, stopped, certain_only=False):
    """Queue every comment under each story whose title names a target.

    With certain_only, titles that need the model's judgement stay pending for a later run.
    """
    window = state.scan_window()
    progress = Progress(state)
    for story in state.pending_stories():
        if stopped():
            return
        named = story_targets(targets, story)
        if certain_only and named and not story['certain']:
            continue
        if not named or not (story['certain'] or classifier.about_story(story['title'], named)):
            state.reject_story(story['item_id'])
        else:
            state.expand_story(classifier_key, story['item_id'], walk_thread(firebase, story['item_id'], window))
        progress.tick()


def read_ancestors(firebase, known, items):
    """Read every ancestor of these comments into known, with one read per thread level.

    Removed comments keep their parent, so the climb continues through them.
    """
    level = items
    for _ in range(MAX_THREAD_DEPTH):
        parents = list(dict.fromkeys(
            item.parent for item in level if item is not None and item.kind == 'comment' and item.parent
        ))
        if not parents:
            return
        missing = [item_id for item_id in parents if item_id not in known]
        if missing:
            known.update(firebase.read(missing))
        level = [known.get(item_id) for item_id in parents]


def thread_root(firebase, known, item):
    """Climb from a comment to the story it belongs to, reading ancestors as needed."""
    for _ in range(MAX_THREAD_DEPTH):
        if item is None or item.kind != 'comment':
            return item if item is not None and item.kind in STORY_KINDS else None
        if item.parent is None:
            return None
        if item.parent not in known:
            known.update(firebase.read([item.parent]))
        item = known.get(item.parent)
    return None


def read_subjects(state, firebase, targets, known, rows):
    """Read one page of queued comments with their parents and stories.

    Returns (subjects, records, cleared). Subjects are (item_id, parent, root, subject) for the
    comments a model must read, records are finished reviews of comments that name no target,
    and cleared lists comments that are no longer available.
    """
    if len(known) > KNOWN_ITEMS:
        known.clear()
    known.update(firebase.read([row['item_id'] for row in rows if row['item_id'] not in known]))
    comments = [known.get(row['item_id']) for row in rows]
    known.update(firebase.read({
        item.parent for item in comments
        if item is not None and item.parent and item.parent not in known
    }))
    read_ancestors(firebase, known, [
        item for row, item in zip(rows, comments)
        if row['root'] is None and item is not None and item.available
    ])
    subjects, records, cleared = [], [], []
    for row, item in zip(rows, comments):
        if item is None or item.kind != 'comment' or not item.available:
            cleared.append(row['item_id'])
            continue
        root = row['root']
        if root is None:
            story_item = thread_root(firebase, known, item)
            if story_item is not None and story_item.title:
                root = story_item.id
                state.remember_story(root, story_item.created, plain(story_item.title))
        story = state.story(root) if root is not None else None
        parent = known.get(item.parent)
        subject = targets.subject(
            item.body,
            parent.body if parent is not None and parent.body else '',
            story['title'] if story is not None else '',
            story_targets(targets, story) if story is not None and story['state'] == 'expanded' else (),
        )
        if subject is None:
            records.append((item.id, item.parent, root, Review((), 'other', '')))
        else:
            subjects.append((item.id, item.parent, root, subject))
    return subjects, records, cleared


def review_comments(state, firebase, targets, classifier, classifier_key, executor, budget, stopped, failed=False):
    """Read each queued comment with its story and parent, and store what it says about each target."""
    known = {}
    cursor = None
    progress = Progress(state)
    while not stopped() and budget[1] > 0:
        rows = state.queued(min(REVIEW_PAGE, budget[1]), failed, cursor)
        if not rows:
            break
        cursor = rows[-1]['item_id']
        subjects, records, cleared = read_subjects(state, firebase, targets, known, rows)
        pending = [
            (item_id, parent, root, executor.submit(classifier.review, subject))
            for item_id, parent, root, subject in subjects
        ]
        records.extend((item_id, parent, root, future.result()) for item_id, parent, root, future in pending)
        state.save_reviews(classifier_key, records, cleared)
        budget[1] -= len(pending)
        progress.tick()


def submit_batch(state, firebase, targets, classifier, classifier_key, known, cursor, limit, stopped, failed):
    """Send up to limit queued comments as one batch, with the stricter instruction when retrying.

    Returns (cursor, sent). The cursor is None once the queue has nothing further.
    """
    prompts, requests = [], []
    while len(prompts) < limit:
        if stopped():
            return cursor, 0
        rows = state.queued(min(BATCH_PAGE, limit - len(prompts)), failed, cursor)
        if not rows:
            cursor = None
            break
        cursor = rows[-1]['item_id']
        subjects, records, cleared = read_subjects(state, firebase, targets, known, rows)
        state.save_reviews(classifier_key, records, cleared)
        for item_id, parent, root, subject in subjects:
            prompts.append((str(item_id), review_prompt(subject) + (REMINDER if failed else '')))
            named = [[target.kind, target.label] for target in subject.targets]
            requests.append((item_id, parent, root, json.dumps(named)))
    if prompts:
        state.open_batch(classifier.submit(prompts), classifier_key, requests)
    return cursor, len(prompts)


def store_batch(state, targets, classifier, classifier_key, batch_id):
    """Store the reviews of one ended batch. A reply that fails validation is a failed attempt."""
    requests = {row['item_id']: row for row in state.batch_requests(batch_id)}
    records = []
    for custom_id, reply in classifier.results(batch_id):
        request = requests.pop(int(custom_id), None) if custom_id.isdecimal() else None
        if request is None:
            continue
        named = tuple(targets.by_label.get((kind, label)) for kind, label in json.loads(request['targets']))
        review = None
        if reply is not None and None not in named:
            try:
                review = parse_review(reply, named)
            except (RecursionError, TypeError, ValueError):
                pass
        records.append((request['item_id'], request['parent'], request['root'], review))
    state.save_reviews(classifier_key, records, batch=batch_id)
    print(json.dumps({'batch': batch_id, 'stored': len(records), **classifier.usage}), flush=True)


def collect_batches(state, targets, classifier, classifier_key, stopped):
    """Wait for every batch that was sent and store its reviews. Returns False when stopped first."""
    while True:
        for batch_id in state.batches():
            if stopped():
                return False
            if classifier.ended(batch_id):
                store_batch(state, targets, classifier, classifier_key, batch_id)
                export_progress(state)
        if not state.batches():
            return True
        for _ in range(BATCH_POLL):
            if stopped():
                return False
            time.sleep(1)


def review_batches(state, firebase, targets, classifier, classifier_key, budget, stopped, failed=False):
    """Review the queued comments through the provider's batch interface, several batches at a time.

    Batches left by an earlier invocation are stored first. A stop leaves the batches that were
    sent running; the next invocation stores them.
    """
    known = {}
    cursor = None
    exhausted = False
    while collect_batches(state, targets, classifier, classifier_key, stopped):
        while not exhausted and not stopped() and budget[1] > 0 and state.batched() < BATCH_WAVE:
            limit = min(BATCH_SIZE, budget[1], BATCH_WAVE - state.batched())
            cursor, sent = submit_batch(
                state, firebase, targets, classifier, classifier_key, known, cursor, limit, stopped, failed,
            )
            exhausted = cursor is None
            budget[1] -= sent
            export_progress(state)
        if not state.batches():
            break


def resolve_context(state, firebase, stopped, budget=None):
    """Store the parent and story of each comment that has no story yet, without the model.

    Newest first, one page at a time. budget caps the comments looked at. A comment whose
    story cannot be found keeps no story and is passed over until the next invocation.
    """
    known = {}
    cursor = None
    totals = {'checked': 0, 'resolved': 0, 'unresolved': 0}
    while not stopped() and (budget is None or budget > totals['checked']):
        limit = CONTEXT_PAGE if budget is None else min(CONTEXT_PAGE, budget - totals['checked'])
        rows = state.unrooted(limit, cursor)
        if not rows:
            break
        cursor = rows[-1]['item_id']
        if len(known) > KNOWN_ITEMS:
            known.clear()
        known.update(firebase.read([row['item_id'] for row in rows if row['item_id'] not in known]))
        comments = [known.get(row['item_id']) for row in rows]
        read_ancestors(firebase, known, comments)
        records, stories = [], {}
        for item in comments:
            if item is None or item.kind != 'comment' or item.parent is None:
                continue
            story_item = thread_root(firebase, known, item)
            root = None
            if story_item is not None and story_item.title:
                root = story_item.id
                stories[root] = story_item
            records.append((item.id, item.parent, root))
        for story_item in stories.values():
            state.remember_story(story_item.id, story_item.created, plain(story_item.title))
        state.save_context(records)
        resolved = sum(root is not None for *_ids, root in records)
        totals['checked'] += len(rows)
        totals['resolved'] += resolved
        totals['unresolved'] += len(rows) - resolved
        print(json.dumps(totals), flush=True)
    return totals


def export_progress(state):
    status = state.export()
    totals = status['totals']
    print(json.dumps({
        'state': status['state'],
        'reason': status['reason'],
        'itemsScanned': totals['itemsScanned'],
        'commentsScanned': totals['commentsScanned'],
        'stories': totals['stories'],
        'storiesPending': totals['storiesPending'],
        'commentsQueued': totals['commentsQueued'],
        'classified': totals['classified'],
        'classificationFailures': totals['classificationFailures'],
        'partitionsComplete': totals['partitionsComplete'],
        'partitionsTotal': totals['partitionsTotal'],
    }), flush=True)


def migrate_window(state, job):
    if job is None:
        raise PipelineError('no-checkpoint')
    if job['source'] != 'archive-and-tail':
        raise PipelineError('checkpoint-configuration-mismatch')
    if state.scan_window(job) is None:
        plan = build_plan(job['source'], previous_last=job['last_item'])
        state.restrict_to_plan(plan)


def build_classifier(args):
    if args.backend == 'anthropic':
        # Imported here so that the other commands and the local backend do not load the SDK.
        from hn_local.anthropic_api import AnthropicClassifier
        return AnthropicClassifier(args.model)
    return LocalClassifier(args.endpoint, args.model)


def run(args, state):
    models = json.loads(MODEL_DATA.read_text(encoding='utf-8'))['models']
    targets = Targets(models)
    identity = f'{PIPELINE_VERSION}/{args.classifier_id}/{args.model}/{targets.registry_id}'
    classifier_key = hashlib.sha256(identity.encode()).hexdigest()
    scan_key = hashlib.sha256(f'{PIPELINE_VERSION}/{targets.registry_id}'.encode()).hexdigest()
    classifier = build_classifier(args)
    job = state.job()
    if job is None:
        plan = build_plan(args.source, args.first_item, args.last_item)
        state.initialize(plan, args.classifier_id, classifier_key, scan_key)
    elif (
        job['source'] != args.source
        or (args.first_item is not None and args.first_item != job['first_item'])
        or (args.last_item is not None and args.last_item != job['last_item'])
        # A queue that no model has touched can be handed to another classifier.
        or (job['classifier_key'] != classifier_key and (job['scan_key'] != scan_key or state.model_used()))
    ):
        raise PipelineError('checkpoint-configuration-mismatch')
    else:
        if job['classifier_key'] != classifier_key:
            state.change_classifier(args.classifier_id, classifier_key)
        if args.source == 'archive-and-tail':
            migrate_window(state, job)
    state.ensure_reconciliation()
    job = state.job()
    if job['state'] == 'complete' and not state.queued(1, failed=True):
        export_progress(state)
        return 0

    stop = False

    def request_stop(_signum, _frame):
        nonlocal stop
        stop = True

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    budget = [args.max_items or 2**63, args.max_classifications or 2**63]
    mirror = ClickHouseReader(targets.prefilter)
    partition = None
    state.set_run('running')
    export_progress(state)
    try:
        with (
            FirebaseReader(args.workers, targets.prefilter) as firebase,
            ThreadPoolExecutor(max_workers=args.classifier_workers) as executor,
        ):
            firebase.request_limit = args.max_firebase_requests
            while not stop and all(budget):
                current = state.next_partition()
                if current is None:
                    partition = None
                    expand_stories(
                        state, firebase, targets, classifier, classifier_key, lambda: stop, args.collect_only,
                    )
                    for failed in () if args.collect_only else (False, True):
                        if args.backend == 'anthropic':
                            review_batches(
                                state, firebase, targets, classifier, classifier_key, budget, lambda: stop, failed,
                            )
                        else:
                            review_comments(
                                state, firebase, targets, classifier, classifier_key,
                                executor, budget, lambda: stop, failed,
                            )
                    break
                partition, position = current
                state.set_run('running', partition=partition)
                if partition.source == 'archive':
                    pages = archive_pages(
                        job['archive_revision'], partition, position, 2048, budget[0], targets.prefilter
                    )
                elif partition.source == 'clickhouse-and-firebase':
                    pages = mirror_pages(partition, position, budget[0], mirror, firebase)
                elif partition.id == RECONCILE_ID:
                    if partition.expected_items == 0:
                        state.materialize_gaps(partition.last_item, partition.first_item)
                        partition, position = state.next_partition()
                    pages = reconcile_pages(state, partition, position, budget[0], firebase)
                else:
                    pages = firebase.pages(partition, position, args.workers * 2, budget[0])
                with closing(pages):
                    position = consume_partition(
                        state, partition, position, pages, targets, classifier_key, budget, lambda: stop,
                    )
                if partition.expected_items == 0:
                    state.checkpoint(partition, position, Counters(), classifier_key)
                elif position != partition.expected_items and not stop and all(budget):
                    raise PipelineError('partition-size-mismatch')
    except PipelineError as error:
        if str(error) == 'request-limit':
            state.set_run('paused', 'request-limit', partition)
            export_progress(state)
            return 0
        state.set_run('blocked', str(error), partition)
        export_progress(state)
        return 1
    unfinished = state.next_partition() is not None or state.pending_stories() or state.queued(1)
    if not unfinished and not state.queued(1, failed=True):
        state.set_run('complete')
    elif not unfinished and not stop and all(budget):
        state.set_run('blocked', 'classification-unresolved')
        export_progress(state)
        return 1
    else:
        reason = (
            'user-stop' if stop else 'item-limit' if not budget[0]
            else 'collect-only' if args.collect_only else 'classifier-limit'
        )
        state.set_run('paused', reason, partition)
    export_progress(state)
    return 0


def context(args, state):
    """Backfill parent and story IDs and story titles for comments that have none."""
    if state.job() is None:
        raise PipelineError('no-checkpoint')
    stop = False

    def request_stop(_signum, _frame):
        nonlocal stop
        stop = True

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    with FirebaseReader(args.workers, None) as firebase:
        firebase.request_limit = args.max_firebase_requests
        try:
            resolve_context(state, firebase, lambda: stop)
        except PipelineError as error:
            if str(error) != 'request-limit':
                raise
    return 0


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    scan = commands.add_parser('run', help='Scan and classify, resuming the saved checkpoint')
    status = commands.add_parser('status', help='Print current coverage and progress as JSON')
    export = commands.add_parser('export', help='Rebuild the two sanitized JSON snapshots')
    migrate = commands.add_parser('migrate', help='Restrict an existing archive checkpoint to six months')
    backfill = commands.add_parser('context', help='Store parent and story IDs and story titles, without the model')
    for command in (scan, status, export, migrate, backfill):
        command.add_argument('--state-dir', type=Path, default=STATE_DIR)
    for command in (scan, backfill):
        command.add_argument('--workers', type=int, choices=range(1, 65), default=16, metavar='1..64')
        command.add_argument(
            '--max-firebase-requests', type=positive_integer, help='Cap item HTTP requests, including retries',
        )
    scan.add_argument('--source', choices=('archive-and-tail', 'firebase'), default='archive-and-tail')
    scan.add_argument(
        '--backend', choices=tuple(BACKENDS), default='local',
        help='local: a loopback model server. anthropic: the Anthropic API, which receives scrubbed comment text',
    )
    scan.add_argument('--endpoint', default=DEFAULT_ENDPOINT, help='Loopback model server, for the local backend')
    scan.add_argument('--model', help='Model name; the default depends on the backend')
    scan.add_argument('--classifier-id', help='Classifier ID; the default depends on the backend')
    scan.add_argument('--classifier-workers', type=int, choices=range(1, 33), default=8, metavar='1..32')
    scan.add_argument('--first-item', type=positive_integer, help='First Firebase item for a diagnostic range')
    scan.add_argument('--last-item', type=positive_integer, help='Last Firebase item for a diagnostic range')
    scan.add_argument('--max-items', type=positive_integer, help='Pause after this many rows in this invocation')
    scan.add_argument('--max-classifications', type=positive_integer, help='Pause after this many comment reviews')
    scan.add_argument('--collect-only', action='store_true', help='Scan and list threads without calling the model')
    args = parser.parse_args()
    if args.command == 'run':
        model, classifier_id = BACKENDS[args.backend]
        args.model = args.model or model
        args.classifier_id = args.classifier_id or classifier_id
        if args.source == 'firebase' and (args.first_item is None or args.last_item is None):
            parser.error('--source firebase requires --first-item and --last-item')
        if args.source != 'firebase' and (args.first_item is not None or args.last_item is not None):
            parser.error('the explicit item range requires --source firebase')
        if not all(
            value and len(value) <= 128 and all(c.isascii() and (c.isalnum() or c in '._/-:') for c in value)
            for value in (args.classifier_id, args.model)
        ):
            parser.error('invalid classifier name')
    return args


def main():
    args = arguments()
    os.umask(0o077)
    try:
        if args.command == 'status':
            with State(args.state_dir, readonly=True) as state:
                print(json.dumps(state.status(), indent=2))
            return 0
        with writer_lock(args.state_dir), State(args.state_dir) as state:
            if args.command == 'migrate':
                migrate_window(state, state.job())
                state.ensure_reconciliation()
                export_progress(state)
                return 0
            if args.command == 'export':
                export_progress(state)
                return 0
            if args.command == 'context':
                return context(args, state)
            return run(args, state)
    except PipelineError as error:
        print(str(error), file=sys.stderr)
    except (OSError, sqlite3.Error, ImportError, ValueError, TypeError, KeyError):
        print('pipeline-state-or-dependency-error', file=sys.stderr)
    return 1


if __name__ == '__main__':
    sys.exit(main())

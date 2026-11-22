"""Index arXiv papers that name tracked models, label their abstracts and record evaluation results locally."""

import argparse
import hashlib
import json
import os
import re
import signal
import sqlite3
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from arxiv_local.assess import ASSESS_VERSION, DEFAULT_ENDPOINT, Assessor
from arxiv_local.failure_review import export_failure_review
from arxiv_local.sources import OaiReader, today
from arxiv_local.state import Counters, State
from hn_local.classify import Targets
from hn_local.sources import PipelineError, recent_window
from hn_local.state import writer_lock

ROOT = Path(__file__).resolve().parents[1]
MODEL_DATA = ROOT / 'src/lib/snapshot.json'
STATE_DIR = ROOT / '.local/arxiv'
EXPORT_INTERVAL = 30
MATCH_VERSION = 'arxiv-match-v1'
# Family aliases that are ordinary words in research prose count only in their product spelling.
PRODUCT_SPELLING = {
    'MiniMax': re.compile(r'\bMiniMax\b'),
    'Microsoft Phi': re.compile(r'(?<![\\$^_{])\bPhi[- ]?\d|\bMicrosoft Phi\b'),
    'Cohere Command': re.compile(r'\bCommand[- ~]?[AR]\b|\bCohere\b'),
}
AI_ARCHIVES = frozenset({'cs', 'stat', 'eess'})
AI_CUE = re.compile(
    r'\b(?:LLMs?|AI|GPT|ChatGPT)\b|(?i:\b(?:language models?|artificial intelligence|machine learning|'
    r'chatbots?|generative|neural networks?|openai|anthropic|deepmind)\b)'
)


def positive_integer(text):
    value = int(text)
    if value < 1:
        raise argparse.ArgumentTypeError('expected a positive integer')
    return value


def load_targets():
    return Targets(json.loads(MODEL_DATA.read_text(encoding='utf-8'))['models'])


def registry(targets):
    return f'{MATCH_VERSION}/{targets.registry_id}'


def match(targets, title, abstract, categories):
    text = f'{title}\n\n{abstract}'
    if not targets.prefilter.search(text):
        return ()
    found = targets.mentions(text)
    # Outside the AI-heavy archives a family name alone is often another sense, such as a telescope.
    in_field = any(category.split('.')[0] in AI_ARCHIVES for category in categories) or AI_CUE.search(text)
    return tuple(
        target for target in found
        if target.kind == 'model' or (
            in_field and (target.label not in PRODUCT_SPELLING or PRODUCT_SPELLING[target.label].search(text))
        )
    )


def harvest_day(reader, targets, start_at, day):
    counters = Counters()
    papers = []
    cleared = []
    for page in reader.day(day):
        for record in page:
            in_scope = record.kind == 'paper' and record.submitted >= start_at
            matched = match(targets, record.title, record.abstract, record.categories) if in_scope else ()
            counters.add(record, in_scope)
            if in_scope:
                papers.append((record, matched))
            elif record.kind != 'paper' and record.id is not None:
                cleared.append(record.id)
    return counters, papers, cleared


def export_progress(state, *, review=False):
    status = state.export()
    if review:
        export_failure_review(state)
    totals = status['totals']
    print(json.dumps({
        'state': status['state'],
        'reason': status['reason'],
        'recordsScanned': totals['recordsScanned'],
        'recordsStored': totals['recordsStored'],
        'papers': totals['papers'],
        'assessed': totals['assessed'],
        'assessmentFailures': totals['assessmentFailures'],
        'results': totals['results'],
        'resultFailures': totals['resultFailures'],
        'daysComplete': totals['daysComplete'],
        'daysTotal': totals['daysTotal'],
    }), flush=True)


def stop_flag():
    stopped = False

    def request_stop(_signum, _frame):
        nonlocal stopped
        stopped = True

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    return lambda: stopped


def run(args, state):
    targets = load_targets()
    job = state.job()
    if job is None:
        state.initialize(registry(targets), recent_window().start)
        job = state.job()
    elif job['registry'] != registry(targets):
        state.rematch(registry(targets), lambda *paper: match(targets, *paper))
    state.extend(today())
    stopped = stop_flag()
    reader = OaiReader()
    remaining = args.max_days or 2**63
    last_export = time.monotonic()
    state.set_run('running')
    export_progress(state)
    try:
        for day in state.pending_days():
            if stopped() or not remaining:
                break
            # A day still open in UTC can gain records, so it is read again on the next run.
            closed = day < today().isoformat()
            counters, papers, cleared = harvest_day(reader, targets, job['start_at'], day)
            state.checkpoint(day, counters, papers, cleared, closed)
            remaining -= 1
            if time.monotonic() - last_export >= EXPORT_INTERVAL:
                export_progress(state)
                last_export = time.monotonic()
    except PipelineError as error:
        state.set_run('blocked', str(error))
        export_progress(state)
        return 1
    if stopped():
        state.set_run('paused', 'user-stop')
    elif not remaining and any(day < today().isoformat() for day in state.pending_days()):
        state.set_run('paused', 'day-limit')
    else:
        state.set_run('complete')
    export_progress(state, review=not stopped())
    return 0


def submit(state, request, names, rows, executor):
    pending = []
    for row in rows:
        targets = state.paper_targets(row['id'])
        named = [names.get(target, target[1]) for target in targets]
        pending.append((row, targets, executor.submit(request, row['title'], row['abstract'], named)))
    return pending


def assess(args, state):
    if state.job() is None:
        raise PipelineError('no-checkpoint')
    identity = f'{ASSESS_VERSION}/{args.assessor_id}/{args.model}'
    assessor_key = hashlib.sha256(identity.encode()).hexdigest()
    assessor = Assessor(args.endpoint, args.model)
    names = {key: target.name for key, target in load_targets().by_label.items()}
    state.set_assessor(args.assessor_id, assessor_key)
    stopped = stop_flag()
    remaining = args.max_papers or 2**63
    last_export = time.monotonic()

    def label(rows, executor):
        for row, _targets, future in submit(state, assessor.assess, names, rows, executor):
            state.add_assessment(assessor_key, row['id'], row['digest'], future.result())

    def extract(rows, executor):
        for row, targets, future in submit(state, assessor.extract, names, rows, executor):
            state.add_result(assessor_key, row['id'], row['digest'], future.result(), targets)

    # Each kind of work is followed by one retry of its failures. A newly labelled evaluation gets its
    # result in the same invocation.
    passes = (
        (lambda _after, limit: state.unassessed(assessor_key, limit, args.exact_models), label, False),
        (lambda after, limit: state.failed_assessments(assessor_key, after, limit, args.exact_models), label, True),
        (lambda _after, limit: state.unextracted(assessor_key, limit, args.exact_models), extract, False),
        (lambda after, limit: state.failed_results(assessor_key, after, limit, args.exact_models), extract, True),
    )
    try:
        with ThreadPoolExecutor(max_workers=args.workers) as executor:
            for fetch, handle, retry in passes:
                after = ''
                while not stopped() and remaining:
                    rows = fetch(after, min(remaining, args.workers * 2))
                    if not rows:
                        break
                    handle(rows, executor)
                    remaining -= len(rows)
                    if retry:
                        after = rows[-1]['id']
                    if time.monotonic() - last_export >= EXPORT_INTERVAL:
                        export_progress(state)
                        last_export = time.monotonic()
    except PipelineError as error:
        print(str(error), file=sys.stderr)
        export_progress(state)
        return 1
    export_progress(state)
    return 0


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    harvest = commands.add_parser('run', help='Harvest metadata and match model names, resuming the checkpoint')
    label = commands.add_parser(
        'assess', help='Label matched abstracts and record evaluation results on the local model',
    )
    status = commands.add_parser('status', help='Print coverage and progress as JSON')
    export = commands.add_parser('export', help='Rebuild papers.json, status.json and failure-review.json')
    for command in (harvest, label, status, export):
        command.add_argument('--state-dir', type=Path, default=STATE_DIR)
    harvest.add_argument('--max-days', type=positive_integer, help='Pause after this many datestamp days')
    label.add_argument('--endpoint', default=DEFAULT_ENDPOINT)
    label.add_argument('--model', default='default_model')
    label.add_argument('--assessor-id', default='qwen3.8-27b-4bit-v1')
    label.add_argument('--workers', type=int, choices=range(1, 9), default=4, metavar='1..8')
    label.add_argument('--max-papers', type=positive_integer, help='Pause after this many model requests')
    label.add_argument(
        '--exact-models', action='store_true', help='Work only on papers that name an exact tracked model',
    )
    args = parser.parse_args()
    if args.command == 'assess' and not all(
        value and len(value) <= 128 and all(c.isascii() and (c.isalnum() or c in '._/-:') for c in value)
        for value in (args.assessor_id, args.model)
    ):
        parser.error('invalid assessor name')
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
            if args.command == 'export':
                export_progress(state, review=True)
                return 0
            if args.command == 'assess':
                return assess(args, state)
            return run(args, state)
    except PipelineError as error:
        print(str(error), file=sys.stderr)
    except (OSError, sqlite3.Error, ImportError, ValueError, TypeError, KeyError):
        print('pipeline-state-or-dependency-error', file=sys.stderr)
    return 1


if __name__ == '__main__':
    sys.exit(main())

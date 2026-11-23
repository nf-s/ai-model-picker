"""Compare the HN classifier with reference labels.

Without --ids it checks stances against explicit exact-model reference labels. With --ids it reviews
the listed comments of a checkpoint, read-only, and writes each one's job, setting, run and stances
to --output, with agreement against --reference when given. No comment text is written.
"""

import argparse
import json
import re
import sys
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from hn_local.classify import (
    DEFAULT_ENDPOINT, PIPELINE_VERSION, REMINDER, SYSTEM, Targets, parse_review, plain, review_prompt,
)
from hn_local.sources import FirebaseReader, PipelineError
from hn_local.state import State
from hn_pipeline import BACKENDS, BATCH_POLL, BATCH_SIZE, build_classifier, read_subjects, thread_root

ROOT = Path(__file__).resolve().parents[1]
DEVELOPMENT_SIZE = 20
STRATA = ('positive', 'negative', 'mixed', 'neutral')
PROBES = (
    'Claude Exampleperson wrote excellent research papers.',
    'The mistral is too strong for the boat today.',
    'Bert is a great friend who works hard.',
)


def split_reference(comments):
    exact = {
        comment['id']: [
            (assessment['modelId'], assessment['sentiment'])
            for assessment in comment['assessments']
            if assessment.get('modelId') and assessment['matchBasis'] == 'explicit-model'
        ]
        for comment in sorted(comments, key=lambda record: record['id'])
    }
    exact = {item: labels for item, labels in exact.items() if labels}
    development = {}
    for sentiment in STRATA:
        selected = 0
        for item, labels in exact.items():
            if item in development:
                continue
            pair = next((label for label in labels if label[1] == sentiment), None)
            if pair is not None:
                development[item] = [pair]
                selected += 1
                if selected == 5:
                    break
    for item, labels in exact.items():
        if len(development) == DEVELOPMENT_SIZE:
            break
        if item not in development:
            development[item] = labels[:1]
    # Split by comment so none of its other assessments can enter holdout.
    holdout = {item: labels for item, labels in exact.items() if item not in development}
    return development, holdout


def read_subject(source, known, targets, item):
    """The comment as the pipeline reads it: with its story title and the text it replies to."""
    story = thread_root(source, known, item)
    title = plain(story.title) if story is not None and story.title else ''
    named, certain = targets.title_targets(title)
    parent = known.get(item.parent)
    return targets.subject(
        item.body, parent.body if parent is not None and parent.body else '', title, named if certain else (),
    )


def compare(subject, references, classifier):
    recognized = {target.label for target in subject.targets if target.kind == 'model'} if subject else set()
    review = classifier.review(subject) if recognized.intersection(model_id for model_id, _ in references) else None
    stances = {
        label.target.label: label.sentiment
        for label in (review.assessments if review else ())
        if label.target.kind == 'model'
    }
    outcomes = []
    for model_id, reference in references:
        stance = stances.get(model_id)
        if model_id not in recognized:
            outcome = 'exact_target_not_recognized'
        elif review is None:
            outcome = 'failed'
        elif stance is None:
            outcome = 'no_stance'
        elif stance == 'unclear':
            outcome = 'unclear'
        else:
            outcome = 'agrees' if stance == reference else 'disagrees'
        outcomes.append((reference, outcome, stance or outcome))
    return tuple(outcomes)


def evaluate(split, targets, classifier, source, executor):
    counts = Counter()
    by_reference = defaultdict(Counter)
    confusion = defaultdict(Counter)
    ids = list(split)
    for offset in range(0, len(ids), 32):
        batch = ids[offset:offset + 32]
        known = source.read(batch)
        outcomes, pending = [], []
        for item_id in batch:
            item = known.get(item_id)
            if item is None or item.kind != 'comment' or not item.available:
                outcomes.extend((reference, 'unavailable', 'unavailable') for _, reference in split[item_id])
            else:
                subject = read_subject(source, known, targets, item)
                pending.append(executor.submit(compare, subject, split[item_id], classifier))
        outcomes.extend(outcome for future in pending for outcome in future.result())
        for reference, outcome, prediction in outcomes:
            counts[outcome] += 1
            by_reference[reference][outcome] += 1
            confusion[reference][prediction] += 1
    return {
        'comments': len(split),
        'referenceAssessments': sum(map(len, split.values())),
        'outcomes': dict(counts),
        'byReferenceSentiment': dict(by_reference),
        'confusion': dict(confusion),
    }


class StoryView:
    """A read-only checkpoint's stories, with the titles found while reading kept in memory."""

    def __init__(self, state):
        self.state = state
        self.found = {}

    def story(self, item_id):
        return self.state.story(item_id) or self.found.get(item_id)

    def remember_story(self, item_id, _created, title):
        self.found.setdefault(item_id, {'item_id': item_id, 'title': title, 'state': 'context', 'targets': '[]'})


def read_listed(state_dir, ids, targets, workers=16):
    """The subjects of the comments listed in ids, read as `run` reads them, and what became of the rest."""
    outcomes, subjects = {}, {}
    with State(state_dir, readonly=True) as state, FirebaseReader(workers, targets.prefilter) as firebase:
        key = state.job()['classifier_key']
        view, known = StoryView(state), {}
        for offset in range(0, len(ids), 256):
            page = ids[offset:offset + 256]
            marks = ','.join('?' * len(page))
            rows = list(state.connection.execute(
                f'SELECT item_id, parent, root FROM comment WHERE classifier_key = ? AND item_id IN ({marks})',
                (key, *page),
            ))
            outcomes.update(dict.fromkeys(page, 'not-in-checkpoint'))
            found, records, cleared = read_subjects(view, firebase, targets, known, rows)
            outcomes.update(dict.fromkeys(cleared, 'unavailable'))
            outcomes.update((item_id, 'no-target') for item_id, *_rest in records)
            for item_id, _parent, _root, subject in found:
                outcomes.pop(item_id, None)
                subjects[item_id] = subject
    return subjects, outcomes


def review_listed(subjects, classifier, backend):
    """Each subject's review, or None after two invalid replies, and the count of invalid first replies."""
    reviews, invalid = {}, 0
    pending = dict(subjects)
    for reminder in ('', REMINDER):
        if not pending:
            break
        replies = {}
        if backend == 'anthropic':
            ids = list(pending)
            prompts = [(str(item_id), review_prompt(pending[item_id]) + reminder) for item_id in ids]
            batches = [classifier.submit(prompts[start:start + BATCH_SIZE]) for start in range(0, len(ids), BATCH_SIZE)]
            for batch_id in batches:
                while not classifier.ended(batch_id):
                    time.sleep(BATCH_POLL)
                replies.update((int(custom_id), reply) for custom_id, reply in classifier.results(batch_id))
        else:
            with ThreadPoolExecutor(max_workers=8) as executor:
                futures = {
                    item_id: executor.submit(
                        classifier.request, SYSTEM, review_prompt(subject) + reminder, classifier.review_tokens,
                    )
                    for item_id, subject in pending.items()
                }
                replies = {item_id: future.result() for item_id, future in futures.items()}
        retry = {}
        for item_id, subject in pending.items():
            reply = replies.get(item_id)
            try:
                reviews[item_id] = parse_review(reply, subject.targets) if reply is not None else None
            except (RecursionError, TypeError, ValueError):
                reviews[item_id] = None
            if reviews[item_id] is None:
                retry[item_id] = subject
        if not reminder:
            invalid = len(retry)
        pending = retry
    return reviews, invalid


def score_jobs(labels, reference):
    """Agreement of the reviewed job, setting and run with reference labels, by comment."""
    counts = {'job': Counter(), 'setting': Counter(), 'run': Counter()}
    confusion = defaultdict(Counter)
    for item_id, expected in reference.items():
        label = labels.get(str(item_id))
        if not isinstance(label, dict):
            counts['job'][label or 'missing'] += 1
            continue
        confusion[expected['job']][label['job']] += 1
        for field in counts:
            counts[field]['agrees' if label[field] == expected.get(field, '') else 'disagrees'] += 1
    return {
        'comments': len(reference),
        **{field: dict(value) for field, value in counts.items()},
        'confusion': {job: dict(found) for job, found in sorted(confusion.items())},
    }


def evaluate_listed(args, targets, classifier):
    ids = json.loads(Path(args.ids).read_text(encoding='utf-8'))
    if not isinstance(ids, list) or not all(type(item) is int and item > 0 for item in ids):
        raise ValueError
    subjects, outcomes = read_listed(args.state_dir, list(dict.fromkeys(ids)), targets)
    reviews, invalid = review_listed(subjects, classifier, args.backend)
    labels = dict((str(item_id), outcome) for item_id, outcome in outcomes.items())
    for item_id, review in reviews.items():
        labels[str(item_id)] = 'failed' if review is None else {
            'job': review.task,
            'setting': review.setting,
            'run': review.run,
            'stances': {f'{label.target.kind}|{label.target.label}': label.sentiment for label in review.assessments},
        }
    result = {
        'pipelineVersion': PIPELINE_VERSION,
        'classifierId': args.classifier_id,
        'comments': len(labels),
        'reviewed': len(subjects),
        'invalidFirstReplies': invalid,
        'failed': sum(review is None for review in reviews.values()),
        'outcomes': dict(Counter(value if isinstance(value, str) else 'labelled' for value in labels.values())),
        'jobs': dict(Counter(value['job'] for value in labels.values() if isinstance(value, dict))),
    }
    if args.reference:
        reference = json.loads(Path(args.reference).read_text(encoding='utf-8'))
        result['reference'] = score_jobs(labels, {int(item): value for item, value in reference.items()})
    if args.backend == 'anthropic':
        result['tokens'] = dict(classifier.usage)
    Path(args.output).write_text(json.dumps({**result, 'labels': labels}, indent=1) + '\n', encoding='utf-8')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--backend', choices=tuple(BACKENDS), default='local')
    parser.add_argument('--endpoint', default=DEFAULT_ENDPOINT)
    parser.add_argument('--model')
    parser.add_argument('--classifier-id')
    parser.add_argument('--ids', help='JSON list of comment IDs to review from --state-dir')
    parser.add_argument('--state-dir', type=Path, default=ROOT / '.local/hn/threads')
    parser.add_argument('--output', help='File for the labels of --ids; required with it')
    parser.add_argument('--reference', help='JSON object of comment ID to job, setting and run')
    args = parser.parse_args()
    if args.ids and not args.output:
        parser.error('--ids requires --output')
    model, classifier_id = BACKENDS[args.backend]
    args.model = args.model or model
    args.classifier_id = args.classifier_id or classifier_id
    if not re.fullmatch(r'[A-Za-z0-9._-]{1,128}', args.classifier_id):
        parser.error('invalid classifier identifier')
    try:
        targets = Targets(json.loads((ROOT / 'src/lib/snapshot.json').read_text())['models'])
        if args.ids:
            print(json.dumps(evaluate_listed(args, targets, build_classifier(args)), indent=2))
            return 0
        snapshot = json.loads((ROOT / 'research/hn-sentiment.json').read_text())
        development, holdout = split_reference(snapshot['comments'])
        classifier = build_classifier(args)
        with FirebaseReader(16, targets.prefilter) as source, ThreadPoolExecutor(max_workers=4) as executor:
            result = {
                'pipelineVersion': PIPELINE_VERSION,
                'classifierId': args.classifier_id,
                'referenceCheckedAt': snapshot['checkedAt'],
                'development': evaluate(development, targets, classifier, source, executor),
                'holdout': evaluate(holdout, targets, classifier, source, executor),
            }
        probes = Counter()
        for body in PROBES:
            subject = targets.subject(body)
            if subject is None:
                probes['screened_out'] += 1
                continue
            review = classifier.review(subject)
            if review is None:
                probes['failed'] += 1
            elif not review.assessments:
                probes['no_stance'] += 1
            for label in review.assessments if review else ():
                probes[label.sentiment] += 1
        result['syntheticNonAiMentions'] = dict(probes)
        if args.backend == 'anthropic':
            result['tokens'] = dict(classifier.usage)
        print(json.dumps(result, indent=2))
        return 0
    except PipelineError as error:
        print(str(error), file=sys.stderr)
    except (OSError, TypeError, ValueError, KeyError):
        print('reference-evaluation-error', file=sys.stderr)
    return 1


if __name__ == '__main__':
    sys.exit(main())

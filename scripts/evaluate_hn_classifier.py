"""Compare the HN classifier with explicit exact-model reference labels."""

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from hn_local.classify import DEFAULT_ENDPOINT, PIPELINE_VERSION, Targets, plain
from hn_local.sources import FirebaseReader, PipelineError
from hn_pipeline import BACKENDS, build_classifier, thread_root

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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--backend', choices=tuple(BACKENDS), default='local')
    parser.add_argument('--endpoint', default=DEFAULT_ENDPOINT)
    parser.add_argument('--model')
    parser.add_argument('--classifier-id')
    args = parser.parse_args()
    model, classifier_id = BACKENDS[args.backend]
    args.model = args.model or model
    args.classifier_id = args.classifier_id or classifier_id
    if not re.fullmatch(r'[A-Za-z0-9._-]{1,128}', args.classifier_id):
        parser.error('invalid classifier identifier')
    try:
        targets = Targets(json.loads((ROOT / 'src/lib/snapshot.json').read_text())['models'])
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

"""Publish a metadata-only arXiv paper index snapshot from one checkpoint."""

import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from arxiv_local.assess import AREAS, KINDS, MAX_FINDING, MAX_TAKEAWAY, MAX_TASK, MAX_TOPICS, TOPICS
from arxiv_local.sources import CATEGORY, DAY, MAX_TITLE, parse_day
from arxiv_local.state import COVERAGE, DATABASE, State
from hn_local.classify import FAMILIES
from hn_local.sources import PipelineError, iso_time, timestamp
from hn_local.state import atomic_write

ROOT = Path(__file__).resolve().parent.parent
RUN_STATES = ('pending', 'running', 'paused', 'blocked', 'complete')
PAPER_ID = re.compile(r'\d{4}\.\d{4,5}\Z')
MONTH = re.compile(r'\d{4}-(?:0[1-9]|1[0-2])\Z')
ASSESSOR = re.compile(r'[A-Za-z0-9._/:-]{1,128}\Z')


def check(condition):
    if not condition:
        raise PipelineError('invalid-published-checkpoint')


def integer(value, maximum=2**53 - 1):
    check(type(value) is int and 0 <= value <= maximum)
    return value


def enum(value, values):
    check(isinstance(value, str) and value in values)
    return value


def text(value, pattern):
    check(isinstance(value, str) and pattern.fullmatch(value))
    return value


def instant(value):
    check(isinstance(value, str))
    try:
        moment = timestamp(datetime.strptime(value, '%Y-%m-%dT%H:%M:%SZ'))
    except ValueError:
        moment = None
    check(moment is not None and iso_time(moment) == value)
    return value


def day(value):
    text(value, DAY)
    try:
        check(parse_day(value).isoformat() == value)
    except ValueError:
        check(False)
    return value


def counts(value, keys):
    check(isinstance(value, dict) and list(value) == list(keys))
    return {key: integer(value[key]) for key in keys}


def published_target(target, approved):
    check(isinstance(target, dict))
    kind = enum(target['kind'], approved)
    return {'kind': kind, 'target': enum(target['target'], approved[kind])}


def published_assessment(assessment):
    if assessment is None:
        return None
    check(isinstance(assessment, dict))
    topics = assessment['topics']
    check(isinstance(topics, list) and len(topics) <= MAX_TOPICS and len(set(topics)) == len(topics))
    takeaway = assessment['takeaway']
    check(takeaway is None or (
        isinstance(takeaway, str) and 0 < len(takeaway) <= MAX_TAKEAWAY and ' '.join(takeaway.split()) == takeaway
    ))
    return {
        'kind': enum(assessment['kind'], KINDS),
        'topics': [enum(topic, TOPICS) for topic in topics],
        'takeaway': takeaway,
    }


def published_standing(group, targets):
    """Each entry must be one of the paper's own published targets, named once."""
    check(isinstance(group, list) and all(ref in targets for ref in group))
    check(len({(ref['kind'], ref['target']) for ref in group}) == len(group))
    return [{'kind': ref['kind'], 'target': ref['target']} for ref in group]


def published_result(result, targets):
    if result is None:
        return None
    check(isinstance(result, dict))
    task, finding = result['task'], result['finding']
    check(isinstance(task, str) and 0 < len(task) <= MAX_TASK and ' '.join(task.split()) == task)
    check(finding is None or (
        isinstance(finding, str) and 0 < len(finding) <= MAX_FINDING and ' '.join(finding.split()) == finding
    ))
    best, weak = published_standing(result['best'], targets), published_standing(result['weak'], targets)
    check(not any(ref in weak for ref in best))
    return {'area': enum(result['area'], AREAS), 'task': task, 'best': best, 'weak': weak, 'finding': finding}


def published_paper(paper, approved):
    check(isinstance(paper, dict))
    title = paper['title']
    check(isinstance(title, str) and 0 < len(title) <= MAX_TITLE and ' '.join(title.split()) == title)
    categories = paper['categories']
    check(isinstance(categories, list) and categories and isinstance(paper['targets'], list) and paper['targets'])
    targets = [published_target(target, approved) for target in paper['targets']]
    return {
        'id': text(paper['id'], PAPER_ID),
        'title': title,
        'submittedAt': instant(paper['submittedAt']),
        'categories': [text(category, CATEGORY) for category in categories],
        'targets': targets,
        'assessment': published_assessment(paper['assessment']),
        'result': published_result(paper['result'], targets),
    }


def published_aggregate(aggregate, key, approved):
    check(isinstance(aggregate, dict) and isinstance(aggregate['months'], dict))
    return {
        key: enum(aggregate[key], approved),
        'papers': integer(aggregate['papers']),
        'months': {text(month, MONTH): integer(total) for month, total in aggregate['months'].items()},
        'kinds': counts(aggregate['kinds'], KINDS),
        'topics': counts(aggregate['topics'], TOPICS),
    }


def published_results(results, approved):
    coverage = results['coverage']
    assessor = results['assessor']
    check(isinstance(coverage, dict))
    return {
        'updatedAt': instant(results['updatedAt']),
        'assessor': None if assessor is None else text(assessor, ASSESSOR),
        'startAt': instant(results['startAt']),
        'coverage': {
            'state': enum(coverage['state'], RUN_STATES),
            'firstDay': day(coverage['firstDay']),
            'lastDay': day(coverage['lastDay']),
            **{key: integer(coverage[key]) for key in COVERAGE},
        },
        'models': [published_aggregate(model, 'modelId', approved['model']) for model in results['models']],
        'families': [
            published_aggregate(family, 'familyName', approved['family']) for family in results['families']
        ],
        'papers': [published_paper(paper, approved) for paper in results['papers']],
    }


def export_snapshot(directory, output):
    database = directory / DATABASE
    check(database.is_file() and not database.is_symlink())
    model_data = json.loads((ROOT / 'src/lib/snapshot.json').read_text(encoding='utf-8'))
    approved = {'model': {model['id'] for model in model_data['models']}, 'family': FAMILIES}

    with State(directory, readonly=True) as state:
        state.connection.execute('BEGIN')
        check(state.job() is not None)
        try:
            results = published_results(state.results(state.status()), approved)
        except (KeyError, TypeError, ValueError):
            raise PipelineError('invalid-published-checkpoint') from None

    # Write only after the read transaction has been released.
    atomic_write(output, {'schemaVersion': 1, 'publishedAt': datetime.now(timezone.utc).isoformat(), **results})
    return len(results['papers'])


if __name__ == '__main__':
    try:
        total = export_snapshot(ROOT / '.local/arxiv', ROOT / 'dist/arxiv-snapshot.json')
    except (PipelineError, OSError, sqlite3.Error, KeyError, TypeError, ValueError, OverflowError):
        raise SystemExit('Could not export the current arXiv checkpoint.') from None
    print(f'Exported {total:,} arXiv papers.')

"""Publish a metadata-only Hacker News reader snapshot from one checkpoint."""

import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from hn_local.classify import (
    ASPECTS, CLAIM_LIMIT, CONFIDENCES, FAMILIES, MAX_THEMES, RUNS, SENTIMENTS, SETTINGS, STORED_TASKS, THEMES,
)
from hn_local.sources import ARCHIVE_PATTERN, MAX_TIMESTAMP, RECONCILE_ID, PipelineError, iso_time
from hn_local.state import DATABASE, State, atomic_write

ROOT = Path(__file__).resolve().parent.parent
RUN_STATES = ('pending', 'running', 'paused', 'blocked', 'complete')
MAX_ID = 2**32 - 1
STORY_STATES = ('pending', 'expanded', 'rejected', 'context')
TITLE_LIMIT = 300
STORY_TARGET_LIMIT = 20
THREAD_TOTALS = ('commentsQueued', 'commentsAboutTargets', 'stories', 'storiesPending', 'threadComments')
# Cloudflare Pages accepts at most 25 MiB for one file, so the comments are written in parts.
PART_BYTES = 12 * 1024 * 1024
MAX_PARTS = 16


def check(condition):
    if not condition:
        raise PipelineError('invalid-published-checkpoint')


def integer(value, maximum=2**53 - 1):
    check(type(value) is int and 0 <= value <= maximum)
    return value


def enum(value, values):
    check(isinstance(value, str) and value in values)
    return value


def item_id(value):
    check(integer(value, MAX_ID) > 0)
    return value


def json_labels(value, values, limit):
    items = json.loads(value)
    check(isinstance(items, list) and len(items) <= limit)
    check(all(isinstance(item, str) and item in values for item in items))
    check(len(set(items)) == len(items))
    return items


def target(kind, label, targets):
    kind = enum(kind, targets)
    return {'kind': kind, 'target': enum(label, targets[kind])}


def text(value, limit):
    check(isinstance(value, str) and len(value) <= limit)
    return value


def partition_id(partition):
    name = partition['id']
    if partition['source'] == 'archive':
        match = ARCHIVE_PATTERN.fullmatch(name)
        check(match is not None)
        return f'archive-{match.group(1)}-{match.group(2)}'
    check(name == RECONCILE_ID or re.fullmatch(r'items-[1-9]\d{0,9}-[1-9]\d{0,9}', name))
    return name


def published_status(status, classifier, candidates, listed, classified, failed, untracked):
    totals = status['totals']
    for key, value in {
        'candidates': candidates,
        'classified': classified,
        'classificationFailures': failed,
        'classificationUntracked': untracked,
        'commentsQueued': untracked,
        'commentsAboutTargets': listed,
    }.items():
        totals[key] = value
    return {
        'schemaVersion': 1,
        'state': enum(status['state'], RUN_STATES),
        'reason': None,
        'updatedAt': status['updatedAt'],
        'classifier': enum(status['classifier'], (classifier,)),
        'source': enum(status['source'], ('archive-and-tail', 'firebase')),
        'archiveRevision': None,
        'firstItem': item_id(status['firstItem']),
        'lastItem': item_id(status['lastItem']),
        'startAt': status['startAt'],
        'endAt': status['endAt'],
        'totals': {key: integer(totals[key]) for key in (
            'itemsScanned', 'commentsScanned', 'commentsEligible', 'candidates',
            'classified', 'classificationFailures', 'classificationUntracked',
            'unavailable', 'invalid', 'failures', 'partitionsComplete', 'partitionsTotal',
        )} | {key: integer(totals[key]) for key in THREAD_TOTALS if key in totals},
        'firstCommentAt': status['firstCommentAt'],
        'lastCommentAt': status['lastCommentAt'],
        'partitions': [
            {
                'id': partition_id(partition),
                'source': enum(partition['source'], ('archive', 'firebase', 'clickhouse-and-firebase')),
                'state': enum(partition['state'], RUN_STATES),
                'itemsScanned': integer(partition['itemsScanned']),
                'expectedItems': integer(partition['expectedItems']),
                'firstCommentAt': partition['firstCommentAt'],
                'lastCommentAt': partition['lastCommentAt'],
            }
            for partition in status['partitions']
        ],
        'allPublicItemsScanned': status['allPublicItemsScanned'],
        'archiveIdsReconciled': status['archiveIdsReconciled'],
    }


def compact(value):
    return json.dumps(value, ensure_ascii=True, separators=(',', ':'))


def comment_parts(comments, stories, limit):
    """Split the comments, in order, into runs that each stay near `limit` bytes of JSON.

    The first part also carries the stories. Every part holds at least one comment, except
    the only part of an empty collection.
    """
    parts, size = [[]], len(compact(stories))
    for comment in comments:
        length = len(compact(comment)) + 1
        if parts[-1] and size + length > limit:
            parts.append([])
            size = 0
        parts[-1].append(comment)
        size += length
    return parts


def review_finished(directory):
    """Whether every partition is scanned and nothing waits for review. Failures do not count."""
    if not (directory / DATABASE).is_file():
        return False
    try:
        with State(directory, readonly=True) as state:
            totals = state.status()['totals']
    except (PipelineError, sqlite3.Error):
        return False
    counts = [totals.get(key) for key in ('partitionsTotal', 'partitionsComplete', 'storiesPending', 'commentsQueued')]
    if not all(type(count) is int for count in counts):
        return False
    partitions_total, partitions_complete, stories_pending, comments_queued = counts
    return (
        partitions_total > 0 and partitions_complete == partitions_total
        and stories_pending == 0 and comments_queued == 0
    )


def published_directory(state_dir):
    """Publish the new thread run once its review is finished, else the previous analysis."""
    run_dir = state_dir / 'threads'
    return run_dir if review_finished(run_dir) else state_dir


def read_checkpoint(directory):
    """Read the listed comments, their stories, the status and the results in one transaction."""
    database = directory / DATABASE
    check(database.is_file() and not database.is_symlink())
    model_data = json.loads((ROOT / 'src/lib/snapshot.json').read_text(encoding='utf-8'))
    classifier_check = json.loads((ROOT / 'research/hn-classifier-check.json').read_text(encoding='utf-8'))
    classifier = classifier_check['classifierId']
    targets = {'model': {model['id'] for model in model_data['models']}, 'family': FAMILIES}

    with State(directory, readonly=True) as state:
        state.connection.execute('BEGIN')
        job = state.job()
        check(job is not None and job['classifier'] == classifier)
        start = integer(job['start_at'], MAX_TIMESTAMP)
        end = integer(job['end_at'], MAX_TIMESTAMP)
        check(start <= end)
        window = (job['classifier_key'], start, end)
        # Checkpoints reviewed before the job list, opened read-only, have no setting or run column.
        columns = {row['name'] for row in state.connection.execute('PRAGMA table_info(comment)')}
        fields = ', '.join(f'c.{name}' if name in columns else f'NULL AS {name}' for name in ('setting', 'run'))
        rows = state.connection.execute(
            f"""SELECT c.item_id, c.created, c.failed_groups, c.parent, c.root, c.task, c.claim, {fields}, a.kind, a.target,
                      a.sentiment, a.aspects, a.confidence, a.themes
               FROM comment c LEFT JOIN assessment a
                 ON a.item_id = c.item_id AND a.classifier_key = c.classifier_key AND a.failed = 0
               WHERE c.classifier_key = ? AND c.created BETWEEN ? AND ?
               ORDER BY c.item_id DESC, a.kind, a.target""",
            window,
        )
        entries, labels = [], []
        current = None
        classified = failed = untracked = 0
        for row in rows:
            if current is None or current['id'] != row['item_id']:
                current = {
                    'id': item_id(row['item_id']),
                    'createdAt': iso_time(integer(row['created'], MAX_TIMESTAMP)),
                    'assessments': [],
                }
                entries.append((current, row['parent'], row['root'], row['task'], row['claim'], row['setting'], row['run']))
                failures = row['failed_groups']
                if failures is None:
                    untracked += 1
                elif integer(failures) == 0:
                    classified += 1
                else:
                    failed += 1
            if row['kind'] is not None:
                aspects = json_labels(row['aspects'], ASPECTS, len(ASPECTS))
                themes = json_labels(row['themes'], THEMES, MAX_THEMES)
                assessment = {
                    **target(row['kind'], row['target'], targets),
                    'sentiment': enum(row['sentiment'], SENTIMENTS),
                    'aspects': aspects,
                    'confidence': enum(row['confidence'], CONFIDENCES),
                }
                if themes:
                    assessment['themes'] = themes
                current['assessments'].append(assessment)
                labels.append({**assessment, 'item_id': current['id'], 'created': row['created'],
                               'aspects': json.dumps(aspects)})
        prefers = {}
        for row in state.connection.execute(
            """SELECT p.item_id, p.winner_kind, p.winner, p.loser_kind, p.loser
               FROM preference p JOIN comment c USING (item_id, classifier_key)
               WHERE c.classifier_key = ? AND c.created BETWEEN ? AND ?
               ORDER BY p.item_id, p.winner_kind, p.winner, p.loser_kind, p.loser""",
            window,
        ):
            prefers.setdefault(item_id(row['item_id']), []).append({
                'winner': target(row['winner_kind'], row['winner'], targets),
                'loser': target(row['loser_kind'], row['loser'], targets),
            })
        stories = {
            row['item_id']: row for row in state.connection.execute(
                """SELECT item_id, created, title, targets, state FROM story WHERE item_id IN (
                       SELECT root FROM comment WHERE classifier_key = ? AND created BETWEEN ? AND ?)""",
                window,
            )
        }

        # A comment is listed only when its review found an opinion about a target.
        comments, story_counts = [], {}
        for entry, parent, root, task, claim, setting, run in entries:
            if not entry['assessments']:
                continue
            if root is not None:
                entry['story'] = item_id(root)
                story_counts[root] = story_counts.get(root, 0) + 1
            if parent is not None:
                entry['parent'] = item_id(parent)
            if task is not None:
                entry['task'] = enum(task, STORED_TASKS)
            # Reviews made before the job list have neither field; a value is shown only when stated.
            if setting is not None and enum(setting, SETTINGS):
                entry['setting'] = setting
            if run is not None and enum(run, RUNS):
                entry['run'] = run
            if claim is not None and text(claim, CLAIM_LIMIT):
                entry['claim'] = claim
            if entry['id'] in prefers:
                entry['prefers'] = prefers[entry['id']]
            comments.append(entry)
        published_stories = []
        for story_id in sorted(story_counts, reverse=True):
            story = stories.get(story_id)
            if story is None:
                continue
            about = []
            if enum(story['state'], STORY_STATES) == 'expanded':
                pairs = json.loads(story['targets'])
                check(isinstance(pairs, list) and len(pairs) <= STORY_TARGET_LIMIT)
                check(all(isinstance(pair, list) and len(pair) == 2 for pair in pairs))
                about = [target(kind, label, targets) for kind, label in pairs]
            created = story['created']
            published_stories.append({
                'id': item_id(story_id),
                'title': text(story['title'], TITLE_LIMIT),
                'createdAt': None if created is None else iso_time(integer(created, MAX_TIMESTAMP)),
                'about': about,
                'comments': story_counts[story_id],
            })
        status = published_status(
            state.status(), classifier, len(entries), len(comments), classified, failed, untracked,
        )
        results = state.results(status, labels)
    return comments, published_stories, status, results


def export_snapshot(directory, output, part_bytes=PART_BYTES):
    comments, published_stories, status, results = read_checkpoint(directory)
    parts = comment_parts(comments, published_stories, part_bytes)
    check(len(parts) <= MAX_PARTS)

    # Write only after the read transaction has been released.
    published_at = datetime.now(timezone.utc).isoformat()
    names = [f'hn-comments-{number}.json' for number in range(1, len(parts) + 1)]
    for name, part in zip(names, parts):
        atomic_write(output.with_name(name), {
            'schemaVersion': 1,
            'publishedAt': published_at,
            'comments': part,
            **({'stories': published_stories} if name == names[0] else {}),
        })
    # Parts left by an earlier export with more of them would not belong to this one.
    for stale in output.parent.glob('hn-comments-*.json'):
        if stale.name not in names:
            stale.unlink()
    atomic_write(output, {
        'schemaVersion': 1,
        'publishedAt': published_at,
        'commentParts': len(parts),
        'status': status,
        'results': results,
    })
    return len(comments)


if __name__ == '__main__':
    try:
        total = export_snapshot(published_directory(ROOT / '.local/hn'), ROOT / 'dist/hn-snapshot.json')
    except (PipelineError, OSError, sqlite3.Error, KeyError, TypeError, ValueError, OverflowError):
        raise SystemExit('Could not export the current Hacker News checkpoint.') from None
    print(f'Exported {total:,} Hacker News comment records.')

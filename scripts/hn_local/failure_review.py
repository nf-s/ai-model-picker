"""Shortlist concrete failure reports from stored Hacker News reviews."""

import json
import re

from failure_review import REVIEW_LIMIT, matching_checks

from .classify import plain
from .sources import iso_time
from .state import atomic_write

REPORT_NAME = 'failure-review.json'
CODING_TASKS = {'coding', 'agents'}
CODING_THEMES = {'code-quality', 'agentic-work', 'harness'}
COMPARISON = re.compile(r'\b(?:than|unlike|compared (?:with|to)|whereas|versus|vs\.?)\b', re.I)


def failure_candidate(row, targets):
    themes = json.loads(row['themes'])
    if row['task'] not in CODING_TASKS and CODING_THEMES.isdisjoint(themes):
        return None
    claim = plain(row['claim']).strip()
    if COMPARISON.search(claim):
        return None
    checks = matching_checks(claim)
    if not checks:
        return None
    target = targets.by_label.get((row['kind'], row['target']))
    named = targets.mentions(claim, trusted=True)
    if target is None or (named and named != (target,)):
        return None
    return {
        'url': f'https://news.ycombinator.com/item?id={row["item_id"]}',
        'date': iso_time(row['created']),
        'targets': [{'kind': target.kind, 'target': target.label}],
        'attribution': 'named-in-claim' if named else 'review-context',
        'sourceKind': 'classifier-claim',
        'evidence': claim,
        'checks': checks,
        'task': row['task'],
        'themes': themes,
    }


def export_failure_review(state, status, targets):
    """Write a bounded review file from this checkpoint without fetching source text."""
    job = state.job()
    scope = (job['classifier_key'], job['start_at'], job['end_at'])
    reviewed = state.connection.execute(
        """SELECT COUNT(*) FROM comment WHERE classifier_key = ? AND failed_groups = 0
           AND created BETWEEN COALESCE(?, created) AND COALESCE(?, created)""",
        scope,
    ).fetchone()[0]
    rows = state.connection.execute(
        """SELECT c.item_id, c.created, c.task, c.claim, a.kind, a.target, a.themes
           FROM comment c JOIN assessment a USING (item_id, classifier_key)
           WHERE c.classifier_key = ? AND c.failed_groups = 0 AND c.claim IS NOT NULL
             AND c.created BETWEEN COALESCE(?, c.created) AND COALESCE(?, c.created)
             AND a.failed = 0 AND a.sentiment IN ('negative', 'mixed') AND a.confidence IN ('high', 'medium')
             AND NOT EXISTS (
                SELECT 1 FROM assessment other WHERE other.item_id = a.item_id
                  AND other.classifier_key = a.classifier_key
                  AND (other.kind != a.kind OR other.target != a.target)
             )
           ORDER BY c.created DESC, c.item_id DESC""",
        scope,
    )
    total = 0
    candidates = []
    for row in rows:
        candidate = failure_candidate(row, targets)
        if candidate is not None:
            total += 1
            if len(candidates) < REVIEW_LIMIT:
                candidates.append(candidate)
    atomic_write(state.directory / REPORT_NAME, {
        'schemaVersion': 1,
        'source': 'hacker-news',
        'classifier': status['classifier'],
        'startAt': status['startAt'],
        'endAt': status['endAt'],
        'state': status['state'],
        'reason': status['reason'],
        'reviewedComments': reviewed,
        'candidateLimit': REVIEW_LIMIT,
        'totalCandidates': total,
        'candidates': candidates,
        'limitations': [
            'Evidence is a classifier summary of an HN comment. The reported failure is unverified.',
            'Only successfully reviewed comments with a single critical target and a specific coding or agent failure signal are eligible.',
            'A target inferred from review context needs attribution checked against the linked comment.',
        ],
    })

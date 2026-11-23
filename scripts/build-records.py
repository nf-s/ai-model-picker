"""Build the shared evidence records into core.json and named-private.json, and print job coverage.

Reads, and never writes: src/lib/snapshot.json (models, benchmark results and published
reports), research/lmarena.json and research/epoch-runs.json (imported arena ratings and
Epoch runs), research/openrouter-usage.json (OpenRouter usage), research/app-model-choices.json (App guide tasks), research/jobs.json (jobs,
crosswalk, keyword rules), Hacker News, from the local checkpoint when there is one,
else from the published export in dist/, and the people review in .local/people/ when it
exists. Restricted benchmarks are not read.

Writes ignored files outside .local, in build/records/ by default:

- core.json: models, product lines, jobs, benchmarks, measured records, Hacker News counts per
  target, job and month, stated preferences, the coverage table and OpenRouter usage. Usage is
  not a record: it sits in its own block and never enters the measured records, the coverage
  counts or any ordering. It names no person and holds no named record or count; its
  namedBehindSignIn flag says whether named records were built.
- named-private.json, only when .local/people/ exists: use records and method advice from the
  people review, with their quotes, and the people list. It is served only behind sign-in.
- search/: the public word-search index, static files of measured records and Hacker News labels
  only, which the published app copies into dist/search/ (see scripts/search_index.py).
- search-local.sqlite: the same records plus use records and method advice with their quotes,
  for `npm run search` on this machine. It is never published.

A job id the job file does not list, or a source label it does not map, stops the build with
the records concerned.

Usage: python3 scripts/build-records.py [--hn-root DIR] [--hn-source auto|checkpoint|export]
                                        [--people-root DIR] [--jobs FILE] [--out FILE]
                                        [--named-out FILE] [--search-out DIR] [--search-local FILE]
"""

import argparse
import collections
import datetime
import gzip
import json
import math
import re
import runpy
import sqlite3
import sys
from pathlib import Path

from hn_local.classify import ASPECTS as HN_ASPECTS, THEMES as HN_THEMES
from hn_local.sources import PipelineError
from hn_local.state import DATABASE
from people_local.review import (
    ADVICE_FIELDS, ADVICE_SCOPE, BASIS, COMPARISON, JOBS, OUTCOMES, SCALE, USE_FIELDS, EFFORT as REVIEW_EFFORT,
)
from records_schema import (
    DATE_PATTERN, FIELDS, JOB_PATTERN, RUNS, SETTINGS, STANCES, SURFACES, RecordError, check_people, check_record,
    is_date, is_text, is_url,
)
from search_index import write_local as write_search_local, write_public as write_search_public

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / 'build/records/core.json'
DEFAULT_NAMED_OUT = ROOT / 'build/records/named-private.json'
DEFAULT_SEARCH_OUT = ROOT / 'build/records/search'
DEFAULT_SEARCH_LOCAL = ROOT / 'build/records/search-local.sqlite'
LIST_LIMIT = 20

JOB_FILE_FIELDS = {'version', 'status', 'jobs', 'crosswalk', 'keywords', 'surface', 'replaces', 'guide'}
JOB_FIELDS = {'id', 'label', 'parent', 'benchmarks', 'guideTask'}
CROSSWALK_SOURCES = (
    'hn-task', 'hn-theme', 'report-category', 'benchmark',
    'arena-leaderboard', 'epoch-run', 'openrouter-tag', 'review-job', 'benchmark-category',
)
# The sources this build loads. A label missing from a strict table stops the build;
# Hacker News themes are optional, so a theme without an entry gives no job.
LOADED_CROSSWALKS = (
    'hn-task', 'hn-theme', 'report-category', 'benchmark', 'arena-leaderboard', 'epoch-run', 'openrouter-tag',
    'review-job', 'benchmark-category',
)
STRICT_CROSSWALKS = (
    'hn-task', 'report-category', 'benchmark', 'arena-leaderboard', 'epoch-run', 'openrouter-tag', 'review-job',
)
IMPORTED = {'lmarena': ROOT / 'research/lmarena.json', 'epoch': ROOT / 'research/epoch-runs.json'}
IMPORT_FIELDS = {
    'lmarena': ({'source', 'fetchedAt', 'checkedAt', 'leaderboards', 'results'}, 'leaderboards', 'leaderboard'),
    'epoch': ({'source', 'fetchedAt', 'checkedAt', 'files', 'results'}, 'files', 'file'),
}
BENCHMARK_FIELDS = {
    'lmarena': {'id', 'leaderboard', 'name', 'what', 'unit', 'scale', 'countOf', 'url', 'publishedAt', 'rows', 'kept'},
    'epoch': {'id', 'file', 'name', 'what', 'unit', 'scale', 'url', 'rows', 'kept'},
}
RESULT_FIELDS = {
    'lmarena': {'leaderboard', 'model', 'modelId', 'effort', 'tool', 'score', 'lower', 'upper', 'count', 'rank', 'date'},
    'epoch': {'file', 'model', 'modelId', 'effort', 'score', 'mean', 'stderr', 'date', 'log', 'run'},
}
AGENT_FIELDS = {'sessions', 'costPerTask'}
USAGE = ROOT / 'research/openrouter-usage.json'
USAGE_FIELDS = {'source', 'fetchedAt', 'checkedAt', 'tokens30d', 'tasks7d'}
USAGE_BLOCK_FIELDS = {'endpoint', 'meta', 'asOf', 'period', 'attribution', 'what'}
USAGE_TOKEN_FIELDS = USAGE_BLOCK_FIELDS | {'totalTokens', 'rows', 'models'}
USAGE_TASK_FIELDS = USAGE_BLOCK_FIELDS | {'tags'}
USAGE_MODEL_FIELDS = {'modelId', 'routes', 'tokens', 'share', 'daysInTop50'}
USAGE_TAG_FIELDS = {'tag', 'label', 'macroCategory', 'share', 'tokenShare', 'top'}
USAGE_TOP_FIELDS = {'route', 'modelId', 'share', 'tokenShare'}
USAGE_CITATION = 'Source: OpenRouter (openrouter.ai/rankings), as of {}. Licensed under CC BY 4.0.'
METHODOLOGY = {
    'lmarena': 'Bradley-Terry rating from pairwise votes between anonymous models on visitors\' own prompts, '
               'latest published leaderboard; compares models on the same leaderboard and date only.',
    'lmarena-agent': 'Inverse-propensity score from real agent sessions; compares models on the same leaderboard '
                     'and date only.',
    'epoch': "Epoch AI's own run; best score across scorers; the interval is 1.96 standard errors either side.",
}
HN_STANCE = {'positive': 'positive', 'negative': 'critical', 'mixed': 'mixed', 'neutral': 'neutral', 'unclear': 'neutral'}
HN_KEY_KINDS = {'model': 'model', 'family': 'line'}
# The people review's files, read from .local/people/ in the checkout given by --people-root.
PEOPLE_DIR = ('.local', 'people')
REVIEW_COMMON_FIELDS = {
    'source_id', 'person', 'practitioner', 'source_class', 'source_url', 'source_date', 'source_channel',
    'source_title', 'passage',
}
SOURCE_ID = re.compile(r'[0-9a-f]{24}')
BASIS_SHORT = {'first-hand use': 'first', 'measured': 'measured', 'second-hand': 'second', 'vendor statement': 'vendor'}
OUTCOME_STANCE = {
    'worked': 'positive', 'failed': 'critical', 'abandoned': 'critical', 'worked after rework': 'mixed',
    'no outcome stated': 'neutral',
}
REVIEW_JOB_AGREEMENT = {'share': 0.5, 'check': 'the review instructions against a reference set of 100 passages, 23 November 2026'}

TOOLS = [
    (name, re.compile(pattern)) for name, pattern in (
        ('Claude Code', r'\bClaude Code\b'),
        ('Codex', r'\bCodex (?:CLI|app)\b|\bCodex\b(?= (?:CLI|app|agent|run|session))'),
        ('Cursor', r'\bCursor\b'),
        ('Aider', r'\b[Aa]ider\b'),
        ('GitHub Copilot', r'\bCopilot\b'),
        ('Gemini CLI', r'\bGemini CLI\b'),
        ('OpenCode', r'\bOpenCode\b'),
        ('Amp', r'\bAmp\b(?= (?:agent|code|CLI))'),
        ('Antigravity', r'\bAntigravity\b'),
        ('Windsurf', r'\bWindsurf\b'),
        ('Cline', r'\bCline\b'),
        ('ChatGPT', r'\bChatGPT\b'),
    )
]
EFFORT = re.compile(
    r'\b(minimal|low|medium|high|xhigh|extra[- ]high|max(?:imum)?)[ -](?:effort|reasoning|thinking)\b'
    r'|\b(?:reasoning[_ ])?effort(?: level)?[:= ]+["\'`]?(minimal|low|medium|high|xhigh|max)\b'
    r'|\b(ultrathink|extended thinking|thinking mode|deep think)\b',
    re.I,
)


class BuildError(ValueError):
    """An input does not have the expected shape, or the job file does not cover a record."""


def need(condition, message):
    if not condition:
        raise BuildError(message)


def within(path, *parts):
    """Whether `path`, symlinks resolved, lies under a folder named by `parts` (for example .local/hn)."""
    names = Path(path).resolve().parts
    return any(names[i:i + len(parts)] == parts for i in range(len(names) - len(parts) + 1))


def read_json(path):
    need(not within(path, '.local', 'restricted'), f'refusing to read restricted data: {path}')
    return json.loads(Path(path).read_text(encoding='utf-8'))


def write_json(path, value):
    """Write `value` to `path`; never anywhere under a .local folder."""
    path = Path(path)
    need(not within(path, '.local'), f'refusing to write under .local: {path}')
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n'
    temporary = path.with_suffix('.tmp')
    try:
        temporary.write_text(text, encoding='utf-8')
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
    return len(text.encode()), len(gzip.compress(text.encode(), mtime=0))


def tool_in(text):
    return next((name for name, pattern in TOOLS if pattern.search(text)), '')


def effort_in(text):
    match = EFFORT.search(text)
    if not match:
        return ''
    value = (match.group(1) or match.group(2) or match.group(3)).lower()
    return {'maximum': 'max', 'extra high': 'xhigh', 'extra-high': 'xhigh'}.get(value, value)


def tokens(name):
    return re.findall(r'[a-z]+|[0-9]+(?:\.[0-9]+)*', name.lower())


def slug(name):
    """A source's model name as it appears in a record id: 'GPT-6.2 Sol (Max)' -> 'gpt-6.2-sol-max'."""
    return re.sub(r'[^a-z0-9.]+', '-', name.lower()).strip('-')


# ---- The job file ---------------------------------------------------------------------


class Jobs:
    """A checked job file: jobs, crosswalk tables, keyword rules, tool surfaces and replacements."""

    def __init__(self, data, benchmark_ids, guide_tasks):
        problems = []

        def check(condition, message):
            if not condition:
                problems.append(message)
            return condition

        need(type(data) is dict and set(data) == JOB_FILE_FIELDS, 'job file fields differ: ' + ', '.join(
            sorted(set(data) ^ JOB_FILE_FIELDS) if type(data) is dict else ['not an object']))
        check(type(data['version']) is int and data['version'] >= 1, 'version is not a positive integer')
        check(data['status'] in ('draft', 'approved'), 'status is neither draft nor approved')
        jobs = data['jobs']
        need(type(jobs) is list and jobs and all(type(job) is dict for job in jobs), 'jobs is not a list of objects')
        self.jobs = jobs
        self.ids = [job.get('id') for job in jobs]
        current = set(self.ids)
        check(len(current) == len(jobs), 'a job id is repeated')
        by_id = {job.get('id'): job for job in jobs}
        for job in jobs:
            job_id = job.get('id')
            if not check(set(job) <= JOB_FIELDS and {'id', 'label', 'benchmarks'} <= set(job), f'job {job_id}: fields differ'):
                continue
            check(is_text(job_id) and JOB_PATTERN.fullmatch(job_id), f'job {job_id}: id is not lower-case words')
            check(is_text(job['label']) and job['label'].strip(), f'job {job_id}: no label')
            parent = job.get('parent')
            if parent is not None:
                check(parent in current and parent != job_id, f'job {job_id}: parent {parent} does not exist')
                check(parent not in by_id or 'parent' not in by_id[parent], f'job {job_id}: parent {parent} has a parent')
            benchmarks = job['benchmarks']
            if check(type(benchmarks) is list and len(set(map(str, benchmarks))) == len(benchmarks), f'job {job_id}: benchmarks are not a list of distinct ids'):
                for benchmark in benchmarks:
                    check(benchmark in benchmark_ids, f'job {job_id}: benchmark {benchmark} does not exist')
            if 'guideTask' in job:
                check(job['guideTask'] in guide_tasks, f'job {job_id}: App guide task {job["guideTask"]} does not exist')
        self.guide = self.check_guide(data['guide'], guide_tasks, check)

        replaces = data['replaces']
        need(type(replaces) is dict, 'replaces is not an object')
        self.replaces = {}
        for old, new in replaces.items():
            if not check(type(new) is dict and 'job' in new and set(new) <= {'job', 'setting', 'run'}, f'replaces {old}: fields differ'):
                continue
            check(JOB_PATTERN.fullmatch(old) and old not in current, f'replaces {old}: not an old job id')
            check(new['job'] is None or new['job'] in current, f'replaces {old}: {new["job"]} is not a job')
            check(new.get('setting', 'local') in SETTINGS[1:], f'replaces {old}: unknown setting')
            check(new.get('run', 'parallel') in RUNS[1:], f'replaces {old}: unknown run')
            self.replaces[old] = (new['job'] or '', new.get('setting', ''), new.get('run', ''))

        crosswalk = data['crosswalk']
        need(type(crosswalk) is dict, 'crosswalk is not an object')
        check(set(crosswalk) <= set(CROSSWALK_SOURCES), 'crosswalk has an unknown source: ' + ', '.join(sorted(set(crosswalk) - set(CROSSWALK_SOURCES))))
        self.crosswalk = {}
        self.unknown_targets = collections.defaultdict(list)
        for source in LOADED_CROSSWALKS:
            check(source in crosswalk, f'crosswalk has no {source} table')
        for source, table in crosswalk.items():
            if not check(type(table) is dict and set(table) == {'version', 'labels'} and type(table['version']) is int and type(table['labels']) is list, f'crosswalk {source}: not a version and a list of labels'):
                continue
            mapping = {}
            for entry in table['labels']:
                if not check(type(entry) is dict and set(entry) == {'label', 'job'} and is_text(entry['label']) and entry['label'], f'crosswalk {source}: an entry is not a label and a job'):
                    continue
                label, target = entry['label'], entry['job']
                check(label not in mapping, f'crosswalk {source}: {label} is listed twice')
                check(target is None or is_text(target), f'crosswalk {source}: {label} maps to {target}')
                if is_text(target) and target not in current and target not in self.replaces:
                    self.unknown_targets[target].append(f'{source}:{label}')
                mapping[label] = target or ''
            self.crosswalk[source] = mapping
        for benchmark in self.crosswalk.get('benchmark', {}):
            check(benchmark in benchmark_ids, f'crosswalk benchmark: {benchmark} does not exist')

        keywords = data['keywords']
        need(type(keywords) is dict and set(keywords) == {'version', 'rules'} and type(keywords['rules']) is list, 'keywords is not a version and a list of rules')
        check(type(keywords['version']) is int, 'keywords version is not an integer')
        self.rules = []
        for number, rule in enumerate(keywords['rules'], 1):
            if not check(type(rule) is dict and set(rule) == {'job', 'within', 'pattern', 'caseSensitive'}, f'keyword rule {number}: fields differ'):
                continue
            check(is_text(rule['job']) and rule['job'] in current, f'keyword rule {number}: job {rule["job"]} does not exist')
            check(type(rule['within']) is list and rule['within'] and all(job is None or (is_text(job) and job in current) for job in rule['within']), f'keyword rule {number}: within names a job that does not exist')
            check(type(rule['caseSensitive']) is bool, f'keyword rule {number}: caseSensitive is not true or false')
            try:
                pattern = re.compile(rule['pattern'], 0 if rule['caseSensitive'] is True else re.I)
            except (re.error, TypeError):
                problems.append(f'keyword rule {number}: pattern does not compile')
                continue
            if type(rule['within']) is list:
                self.rules.append((rule['job'], {job or '' for job in rule['within']}, pattern))

        surface = data['surface']
        need(type(surface) is dict and set(surface) == {'version', 'tools'} and type(surface['tools']) is dict, 'surface is not a version and a table of tools')
        check(type(surface['version']) is int, 'surface version is not an integer')
        for tool, value in surface['tools'].items():
            check(value in SURFACES[1:], f'surface: {tool} has unknown surface {value}')
        self.surfaces = surface['tools']

        need(not problems, 'The job file is not valid:\n  ' + '\n  '.join(problems))
        self.current = current

    def check_guide(self, guide, guide_tasks, check):
        """The brief each App guide task links to. Every guide task is listed once, with the job whose
        guideTask names it, or with no job and a note saying why; a task with no job is never the guide
        task of a job."""
        need(type(guide) is dict and set(guide) == {'version', 'tasks'} and type(guide['tasks']) is list,
             'guide is not a version and a list of tasks')
        check(type(guide['version']) is int, 'guide version is not an integer')
        by_id = {job.get('id'): job for job in self.jobs}
        pointed = collections.defaultdict(list)
        for job in self.jobs:
            if 'guideTask' in job:
                pointed[job['guideTask']].append(job.get('id'))
        out, listed = [], set()
        for entry in guide['tasks']:
            if not check(type(entry) is dict and {'task', 'job'} <= set(entry) <= {'task', 'job', 'note'}
                         and is_text(entry['task']), 'guide: an entry is not a task, a job and an optional note'):
                continue
            task, job_id = entry['task'], entry['job']
            check(task in guide_tasks, f'guide: App guide task {task} does not exist')
            check(task not in listed, f'guide: {task} is listed twice')
            listed.add(task)
            if job_id is None:
                check(is_text(entry.get('note')) and entry['note'].strip(), f'guide: {task} has no job and no note')
                check(not pointed[task], f'guide: {task} has no job, but {", ".join(pointed[task])} names it as guide task')
                out.append({'task': task, 'job': None, 'note': entry.get('note', '')})
                continue
            check('note' not in entry, f'guide: {task} has a job and a note')
            if check(job_id in by_id, f'guide: {task} links to {job_id}, which is not a job'):
                check(by_id[job_id].get('guideTask') == task, f'guide: {task} links to {job_id}, whose guide task is {by_id[job_id].get("guideTask")}')
            out.append({'task': task, 'job': job_id})
        for task in sorted(guide_tasks - listed):
            check(False, f'guide: App guide task {task} is not listed')
        return out
        self.parents = {job['id']: job.get('parent', '') for job in jobs}

    def label(self, source, value):
        """The job a source label maps to, as stored: a job id, an old id, an unknown id or ''."""
        return self.crosswalk[source].get(value)

    def resolve(self, job):
        """(job, setting, run) for a stored job id, through `replaces`; None when it is not covered."""
        if job == '' or job in self.current:
            return job, '', ''
        return self.replaces.get(job)

    def assign(self, base, via, text):
        """(job, how, via) for a record whose label gave the current job `base` through `via`."""
        for job, allowed, pattern in self.rules:
            if base in allowed and pattern.search(text):
                return job, 'keywords', 'kw:' + job
        if base:
            return base, 'label', via
        return '', '', ''


# ---- Records ---------------------------------------------------------------------------


class Records:
    """Collects records, checks each against the shared schema and tracks job coverage."""

    def __init__(self, jobs):
        self.jobs = jobs
        self.problems = collections.defaultdict(list)
        self.uncovered = set()
        self.coverage = collections.Counter()

    def make(self, label, via, words, how='label', **values):
        """A record whose job comes from `label`, the job id a source label maps to (None when the
        source label is not in the crosswalk), refined or filled in by keyword rules over `words`
        (None: no keyword rules apply). `how` says how a job given by the label was assigned."""
        record = dict.fromkeys(FIELDS, '')
        record.update(keys=[], stance='neutral', x=None)
        record.update(values)
        if label is None:
            self.problems[f'{via} is not in the crosswalk'].append(record['id'])
            return record
        resolved = self.jobs.resolve(label)
        if resolved is None:
            self.uncovered.add(label)
            self.problems[f'{label} is neither a job nor replaced (from {via})'].append(record['id'])
            return record
        base, setting, run = resolved
        if words is not None:
            job, how, assigned = self.jobs.assign(base, via, words)
        else:
            job, how, assigned = (base, how, via) if base else ('', '', '')
        record.update(job=job, how=how, via=assigned, setting=setting, run=run)
        record['surface'] = self.jobs.surfaces.get(record['tool'], '')
        try:
            check_record(record)
        except RecordError as error:
            raise BuildError(f'{record["id"]}: {error}') from None
        self.coverage[record['job'], record['src']] += 1
        return record

    def stop_if_uncovered(self):
        lines = [
            f'{target} is neither a job nor replaced (in crosswalk {", ".join(entries)}): 0 records'
            for target, entries in sorted(self.jobs.unknown_targets.items())
            if target not in self.uncovered
        ]
        for problem, ids in sorted(self.problems.items()):
            shown = ', '.join(ids[:LIST_LIMIT]) + (f' and {len(ids) - LIST_LIMIT:,} more' if len(ids) > LIST_LIMIT else '')
            lines.append(f'{problem}: {len(ids):,} records: {shown}')
        need(not lines, 'The job file does not cover these records:\n  ' + '\n  '.join(lines))


def measured_records(snapshot, records):
    names = {model['id']: model['name'] for model in snapshot['models']}
    benchmarks = {benchmark['id']: benchmark for benchmark in snapshot['benchmarks']}
    checked = snapshot['checkedAt']
    out = []
    for result in snapshot['results']:
        benchmark = benchmarks[result['benchmarkId']]
        config = result.get('configuration', '')
        tool, _, setting = config.partition(' · ')
        unit = '%' if '%' in benchmark['unit'] else ' ' + benchmark['unit'].replace(' points', '')
        out.append(records.make(
            records.jobs.label('benchmark', benchmark['id']), 'benchmark:' + benchmark['id'], None,
            id='bm:' + result['id'],
            cls='measured',
            src='benchmark',
            keys=[['model|' + result['modelId'], 'neutral']],
            text=f'{names[result["modelId"]]}: {result["score"]}{unit} on {benchmark["name"]}',
            cond=benchmark.get('costMethod', '') if result.get('costUsd') is not None else '',
            tool=tool if setting else '',
            effort=effort_in(config) or setting,
            url=result['sourceUrl'],
            title=benchmark['name'],
            kind='benchmark result',
            checked=checked,
            x={
                'b': benchmark['id'],
                'score': result['score'],
                'config': config,
                'cost': result.get('costUsd'),
                'time': result.get('timeSeconds'),
                'interval': result.get('interval', ''),
                'trials': result.get('trials'),
            },
        ))
    for report in snapshot['reports']:
        config = report.get('configuration', '')
        published = (report.get('publishedAt') or '')[:10]
        out.append(records.make(
            records.jobs.label('report-category', report['category']), 'category:' + report['category'],
            f'{report["title"]} {report["summary"]} {config}',
            id='rp:' + report['id'],
            cls='measured',
            src='report',
            keys=[['model|' + model_id, 'neutral'] for model_id in report['modelIds']],
            text=report['summary'],
            cond=report['limitation'],
            tool=tool_in(config + ' ' + report['summary']),
            effort=effort_in(config),
            date=published if is_date(published) else '',
            url=report['url'],
            title=f'{report["sourceName"]} · {report["title"]}',
            kind=report['evidenceType'],
            checked=checked,
            x={'config': config},
        ))
    return out


# ---- Imported measured sources -----------------------------------------------------------


def number(value):
    return type(value) in (int, float) and math.isfinite(value)


def check_imported(kind, data, model_ids):
    """Raise BuildError unless `data` is a reviewed import of `kind` whose models are all in the snapshot."""
    name = IMPORTED[kind].name
    fields, list_field, label_field = IMPORT_FIELDS[kind]
    need(type(data) is dict and set(data) == fields, f'{name}: fields differ from {sorted(fields)}')
    source = data['source']
    need(type(source) is dict and is_text(source.get('attribution')) and source['attribution'].endswith('Licensed under CC BY 4.0.'),
         f'{name}: no CC BY 4.0 attribution line')
    need(is_date(data['fetchedAt']), f'{name}: fetchedAt is not a date')
    need(is_date(data['checkedAt']), f'{name}: checkedAt is not set; review the import and set it (docs/updating.md)')
    entries = data[list_field]
    need(type(entries) is list and entries, f'{name}: no {list_field}')
    labels, agent_labels = set(), set()
    for entry in entries:
        need(type(entry) is dict and set(entry) == BENCHMARK_FIELDS[kind], f'{name}: a {label_field} entry has other fields')
        for field in ('id', 'name', 'what', 'unit', 'scale', 'url', label_field):
            need(is_text(entry[field]) and entry[field], f'{name}: {entry.get("id")} has no {field}')
        need(entry['id'] not in labels and entry[label_field] not in labels, f'{name}: {entry["id"]} is listed twice')
        labels.update((entry['id'], entry[label_field]))
        if kind == 'lmarena':
            need(entry['scale'] == 'rating' and 'Preference votes, not a pass rate' in entry['what'],
                 f'{name}: {entry["id"]} does not say its ratings are preference votes, not a pass rate')
            need(is_date(entry['publishedAt']), f'{name}: {entry["id"]} has no publish date')
            need(entry['countOf'] in ('votes', 'observations'), f'{name}: {entry["id"]} counts neither votes nor observations')
            if entry['countOf'] == 'observations':
                agent_labels.add(entry[label_field])
        else:
            need(entry['scale'] == 'percent', f'{name}: {entry["id"]} is not a percentage')
    results = data['results']
    need(type(results) is list, f'{name}: results is not a list')
    for result in results:
        need(type(result) is dict, f'{name}: a result is not an object')
        where = f'{name}: {result.get(label_field)} {result.get("model")}'
        expected = RESULT_FIELDS[kind] | (AGENT_FIELDS if result.get(label_field) in agent_labels else set())
        need(set(result) == expected, f'{where}: fields differ')
        need(result[label_field] in labels, f'{where}: unknown {label_field}')
        need(result['modelId'] in model_ids, f'{where}: model {result["modelId"]} is not in the snapshot')
        need(is_text(result['model']) and result['model'] and is_text(result['effort']), f'{where}: no model name')
        if kind == 'lmarena':
            need(is_text(result['tool']), f'{where}: tool is not text')
        else:
            need(number(result['mean']) and is_text(result['run']) and result['run'], f'{where}: mean or run missing')
        if AGENT_FIELDS <= set(result):
            need(type(result['sessions']) is int and (result['costPerTask'] is None or number(result['costPerTask'])),
                 f'{where}: sessions or cost per task is not a number')
        need(number(result['score']), f'{where}: score is not a number')
        need(result['date'] == '' or is_date(result['date']), f'{where}: date is not a date')
        if kind == 'lmarena':
            need(number(result['lower']) and number(result['upper']) and result['lower'] <= result['score'] <= result['upper'],
                 f'{where}: the score is outside its interval')
            need(type(result['count']) is int and type(result['rank']) is int and is_date(result['date']),
                 f'{where}: count, rank or date missing')
        else:
            need(result['stderr'] is None or number(result['stderr']), f'{where}: stderr is not a number')
            need(result['log'] == '' or is_url(result['log']), f'{where}: the log link is not a link')


def imported_benchmarks(kind, data, jobs):
    crosswalk = 'arena-leaderboard' if kind == 'lmarena' else 'epoch-run'
    label_field = IMPORT_FIELDS[kind][2]
    out = []
    for entry in data[IMPORT_FIELDS[kind][1]]:
        agent = entry.get('countOf') == 'observations'
        out.append({
            'id': entry['id'],
            'name': entry['name'],
            'category': jobs.label(crosswalk, entry[label_field]) or '',
            'general': False,
            'unit': entry['unit'],
            'scale': entry['scale'],
            'what': entry['what'],
            'methodology': METHODOLOGY['lmarena-agent' if agent else kind],
            'costMethod': "Median cost per task from the arena's sessions." if agent else '',
            'url': entry['url'],
            'source': kind,
            'publishedAt': entry.get('publishedAt', ''),
            'attribution': data['source']['attribution'],
            'rows': entry['rows'],
        })
    return out


def arena_records(data, records, names):
    boards = {board['leaderboard']: board for board in data['leaderboards']}
    out = []
    for result in data['results']:
        board = boards[result['leaderboard']]
        effort = f' ({result["effort"]})' if result['effort'] else ''
        counted = f'{result["count"]:,} {board["countOf"]}'
        if 'sessions' in result:
            counted += f' in {result["sessions"]:,} sessions'
        out.append(records.make(
            records.jobs.label('arena-leaderboard', board['leaderboard']), 'arena:' + board['leaderboard'], None,
            id=f'la:{board["leaderboard"]}/{slug(result["model"])}/{result["date"]}',
            cls='measured',
            src='arena',
            keys=[['model|' + result['modelId'], 'neutral']],
            text=f'{names[result["modelId"]]}{effort}: {board["unit"]} {result["score"]}, rank {result["rank"]} on {board["name"]}',
            cond=f'Preference votes, not a pass rate; relative to this leaderboard on {result["date"]}. '
                 f'{counted}. Listed as {result["model"]}.',
            tool=result['tool'],
            effort=result['effort'],
            date=result['date'],
            url=board['url'],
            title=board['name'],
            kind='arena rating',
            checked=data['checkedAt'],
            x={
                'b': board['id'],
                'score': result['score'],
                'unit': board['unit'],
                'config': result['model'],
                'interval': f'{result["lower"]}–{result["upper"]} · confidence bounds from the dataset',
                'trials': result['count'],
                'rank': result['rank'],
                **({'sessions': result['sessions'], 'cost': result['costPerTask']} if 'sessions' in result else {}),
            },
        ))
    return out


def epoch_records(data, records, names):
    files = {entry['file']: entry for entry in data['files']}
    out = []
    for result in data['results']:
        entry = files[result['file']]
        effort = f' ({result["effort"]})' if result['effort'] else ''
        stderr = result['stderr']
        out.append(records.make(
            records.jobs.label('epoch-run', entry['file']), 'epoch-run:' + entry['file'], None,
            id=f'ep:{entry["file"]}/{result["model"]}',
            cls='measured',
            src='benchmark',
            keys=[['model|' + result['modelId'], 'neutral']],
            text=f'{names[result["modelId"]]}{effort}: {result["score"]}% on {entry["name"]}',
            cond="Epoch AI's own run" + ('' if result['effort'] else '; reasoning setting not stated'),
            effort=result['effort'],
            date=result['date'],
            url=result['log'] or entry['url'],
            title=entry['name'],
            kind='benchmark result',
            checked=data['checkedAt'],
            x={
                'b': entry['id'],
                'score': result['score'],
                'unit': '%',
                'config': result['model'],
                'interval': '' if stderr is None else f'±{round(stderr * 1.96, 1)} · 95% interval from the standard error',
                'mean': result['mean'],
                'run': result['run'],
            },
        ))
    return out


# ---- OpenRouter usage ------------------------------------------------------------------


def share(value):
    return number(value) and 0 <= value <= 1


def check_usage(data, model_ids, jobs):
    """Raise BuildError unless `data` is a reviewed OpenRouter usage file whose models are all in the
    snapshot and whose task tags are all in the openrouter-tag crosswalk."""
    name = USAGE.name
    need(type(data) is dict and set(data) == USAGE_FIELDS, f'{name}: fields differ from {sorted(USAGE_FIELDS)}')
    need(type(data['source']) is dict and is_text(data['source'].get('attribution')), f'{name}: no attribution line')
    need(is_date(data['fetchedAt']), f'{name}: fetchedAt is not a date')
    need(is_date(data['checkedAt']), f'{name}: checkedAt is not set; review the import and set it (docs/updating.md)')
    blocks = (('tokens30d', USAGE_TOKEN_FIELDS), ('tasks7d', USAGE_TASK_FIELDS))
    for key, fields in blocks:
        block = data[key]
        need(type(block) is dict and set(block) == fields, f'{name}: {key} fields differ from {sorted(fields)}')
        need(type(block['meta']) is dict and block['meta'].get('as_of') == block['asOf'], f'{name}: {key} has no meta block with its as_of')
        need(block['attribution'] == USAGE_CITATION.format(block['asOf']), f'{name}: {key} attribution does not cite its as_of')
        period = block['period']
        need(type(period) is dict and set(period) == {'start', 'end'} and is_date(period['start']) and is_date(period['end'])
             and period['start'] <= period['end'], f'{name}: {key} period is not two dates')
    need(data['source']['attribution'] == data['tokens30d']['attribution'], f'{name}: source attribution differs from tokens30d')
    tokens = data['tokens30d']
    need(type(tokens['totalTokens']) is int and tokens['totalTokens'] > 0, f'{name}: totalTokens is not a count')
    need(type(tokens['models']) is list, f'{name}: tokens30d models is not a list')
    seen = set()
    for model in tokens['models']:
        need(type(model) is dict and set(model) == USAGE_MODEL_FIELDS, f'{name}: a tokens30d model has other fields')
        where = f'{name}: tokens30d {model["modelId"]}'
        need(is_text(model['modelId']) and model['modelId'] in model_ids, f'{where}: model is not in the snapshot')
        need(model['modelId'] not in seen, f'{where}: listed twice')
        seen.add(model['modelId'])
        need(type(model['tokens']) is int and 0 < model['tokens'] <= tokens['totalTokens'] and share(model['share']),
             f'{where}: tokens or share out of range')
        need(type(model['daysInTop50']) is int and model['daysInTop50'] >= 1, f'{where}: daysInTop50 is not a count')
        need(type(model['routes']) is list and model['routes'] and all(is_text(r) and r for r in model['routes']), f'{where}: no routes')
    tags = data['tasks7d']['tags']
    need(type(tags) is list and tags, f'{name}: tasks7d has no tags')
    unmapped = []
    for tag in tags:
        need(type(tag) is dict and set(tag) == USAGE_TAG_FIELDS, f'{name}: a task tag has other fields')
        where = f'{name}: tasks7d {tag["tag"]}'
        need(is_text(tag['tag']) and is_text(tag['label']) and tag['label'], f'{where}: no tag or label')
        need(share(tag['share']) and share(tag['tokenShare']), f'{where}: share out of range')
        label = jobs.label('openrouter-tag', tag['tag'])
        if label is None:
            unmapped.append(tag['tag'])
        else:
            need(jobs.resolve(label) is not None, f'{where}: {label} is neither a job nor replaced')
        need(type(tag['top']) is list, f'{where}: top is not a list')
        for top in tag['top']:
            need(type(top) is dict and set(top) == USAGE_TOP_FIELDS, f'{where}: a top model has other fields')
            need(is_text(top['route']) and top['route'], f'{where}: a top model has no route')
            need(is_text(top['modelId']) and (top['modelId'] == '' or top['modelId'] in model_ids),
                 f'{where}: {top["modelId"]} is not in the snapshot')
            need(share(top['share']) and share(top['tokenShare']), f'{where}: {top["route"]} share out of range')
    need(not unmapped, 'OpenRouter task tags are not in the openrouter-tag crosswalk: ' + ', '.join(unmapped))


def tag_job(jobs, tag):
    """The current job an OpenRouter task tag maps to, through `replaces`; '' for none."""
    resolved = jobs.resolve(jobs.label('openrouter-tag', tag))
    return resolved[0] if resolved else ''


def usage_block(data, jobs):
    """OpenRouter usage as core.json carries it, apart from the records: per model its 30-day share,
    per task tag its share, job and top models, each block with its as_of, period, meta and citation."""
    tokens, tasks = data['tokens30d'], data['tasks7d']
    period = {key: {'asOf': data[key]['asOf'], 'period': data[key]['period'], 'meta': data[key]['meta'],
                    'attribution': data[key]['attribution'], 'what': data[key]['what']}
              for key in ('tokens30d', 'tasks7d')}
    return {
        'source': 'openrouter',
        'url': data['source']['url'],
        'licence': data['source']['licence'],
        'terms': data['source']['terms'],
        'fetchedAt': data['fetchedAt'],
        'checkedAt': data['checkedAt'],
        'note': 'Usage, not quality: volume follows price, free routes and app defaults. It orders nothing.',
        'tokens': {
            **period['tokens30d'],
            'models': [
                {'modelId': model['modelId'], 'share': model['share'], 'tokens': model['tokens'], 'days': model['daysInTop50']}
                for model in tokens['models']
            ],
        },
        'tasks': {
            **period['tasks7d'],
            'tags': [
                {
                    'tag': tag['tag'],
                    'label': tag['label'],
                    'job': tag_job(jobs, tag['tag']),
                    'share': tag['share'],
                    'top': [{'modelId': top['modelId'], 'route': top['route'], 'share': top['share']} for top in tag['top']],
                }
                for tag in tasks['tags']
            ],
        },
    }


# ---- Hacker News -----------------------------------------------------------------------


def read_hn(hn_root, source):
    """The listed comments, their stories and the run's status, from the checkpoint or the export."""
    checkpoint = Path(hn_root) / '.local/hn'
    if source == 'checkpoint' or (source == 'auto' and (checkpoint / DATABASE).is_file()):
        export = runpy.run_path(str(ROOT / 'scripts/export-hn-site.py'))
        try:
            comments, stories, status, _results = export['read_checkpoint'](export['published_directory'](checkpoint))
        except (PipelineError, sqlite3.Error, OSError) as error:
            raise BuildError(f'Could not read the Hacker News checkpoint: {error}') from None
        return {'from': 'checkpoint', 'publishedAt': '', 'comments': comments, 'stories': stories, 'status': status}
    dist = Path(hn_root) / 'dist'
    need((dist / 'hn-snapshot.json').is_file(), f'No Hacker News checkpoint or export under {hn_root}')
    meta = read_json(dist / 'hn-snapshot.json')
    parts = [read_json(dist / f'hn-comments-{number}.json') for number in range(1, meta['commentParts'] + 1)]
    need(all(part['publishedAt'] == meta['publishedAt'] for part in parts), 'Hacker News comment parts come from different exports')
    return {
        'from': 'export',
        'publishedAt': meta['publishedAt'],
        'comments': [comment for part in parts for comment in part['comments']],
        'stories': parts[0].get('stories', []) if parts else [],
        'status': meta['status'],
    }


def check_comment(comment):
    need(type(comment.get('id')) is int and comment['id'] > 0, 'a Hacker News comment has no item id')
    need(is_text(comment.get('createdAt')) and DATE_PATTERN.match(comment['createdAt']), f'hn:{comment["id"]}: no date')
    need(type(comment.get('assessments')) is list and comment['assessments'], f'hn:{comment["id"]}: no assessments')
    for assessment in comment['assessments']:
        need(assessment.get('kind') in HN_KEY_KINDS and is_text(assessment.get('target')), f'hn:{comment["id"]}: unknown target')
        need(assessment.get('sentiment') in HN_STANCE, f'hn:{comment["id"]}: unknown sentiment')
        themes = assessment.get('themes', [])
        need(type(themes) is list and all(theme in HN_THEMES for theme in themes), f'hn:{comment["id"]}: unknown theme')
        aspects = assessment.get('aspects', [])
        need(type(aspects) is list and all(aspect in HN_ASPECTS for aspect in aspects), f'hn:{comment["id"]}: unknown aspect')
    for preference in comment.get('prefers', []):
        for side in ('winner', 'loser'):
            need(preference[side].get('kind') in HN_KEY_KINDS, f'hn:{comment["id"]}: unknown preference target')


def hn_key(target):
    return HN_KEY_KINDS[target['kind']] + '|' + target['target']


def comment_time(comment):
    time = datetime.datetime.fromisoformat(comment['createdAt'].replace('Z', '+00:00'))
    return time.astimezone(datetime.timezone.utc) if time.tzinfo else time.replace(tzinfo=datetime.timezone.utc)


def weekly_counts(comments):
    """Each exact model's labels per week, in Monday-UTC weeks from the Monday on or before the first
    comment, as the comment index buckets them, and per legacy aspect of the label. The Board reads
    these, so it needs no comment part."""
    if not comments:
        return {'start': '', 'count': 0, 'targets': {}}, {}
    times = {comment['id']: comment_time(comment) for comment in comments}
    first = min(times.values())
    origin = datetime.datetime(first.year, first.month, first.day, tzinfo=datetime.timezone.utc) - datetime.timedelta(days=first.weekday())
    week = datetime.timedelta(weeks=1)
    count = (max(times.values()) - origin) // week + 1
    weeks = {}
    aspects = collections.defaultdict(lambda: collections.defaultdict(lambda: [0, 0, 0, 0]))
    for comment in comments:
        number = (times[comment['id']] - origin) // week
        for assessment in comment['assessments']:
            key = hn_key(assessment)
            if not key.startswith('model|'):
                continue
            stance = STANCES.index(HN_STANCE[assessment['sentiment']])
            weeks.setdefault(key, [[0, 0, 0, 0] for _ in range(count)])[number][stance] += 1
            for aspect in assessment.get('aspects', []):
                aspects[key][aspect][stance] += 1
    return ({'start': origin.date().isoformat(), 'count': count, 'targets': dict(sorted(weeks.items()))},
            {key: {aspect: aspects[key][aspect] for aspect in HN_ASPECTS if aspect in aspects[key]} for key in sorted(aspects)})


def crowd(hn, records, model_ids):
    """Hacker News records, counts per target, job and month, the same counts per theme of the
    label, stated preferences, and the item ids of the comments in each job, so the app can open the
    comments behind a count. The app renders every count from these aggregates and loads the
    comments themselves only when someone opens them."""
    jobs = records.jobs
    themes_order = list(jobs.crosswalk['hn-theme'])
    stories = {story['id']: story.get('title', '') for story in hn['stories']}
    counts = collections.defaultdict(lambda: collections.defaultdict(lambda: collections.defaultdict(lambda: [0, 0, 0, 0])))
    theme_counts = collections.defaultdict(lambda: collections.defaultdict(lambda: collections.defaultdict(
        lambda: collections.defaultdict(lambda: [0, 0, 0, 0]))))
    preferences = []
    comment_ids = collections.defaultdict(list)
    unknown_models = collections.defaultdict(list)
    rows = []
    for comment in hn['comments']:
        check_comment(comment)
    for comment in sorted(hn['comments'], key=lambda c: (c['createdAt'], c['id']), reverse=True):
        record_id = f'hn:{comment["id"]}'
        date = comment['createdAt'][:10]
        claim = comment.get('claim') or ''
        task = comment.get('task') or 'other'
        themes = sorted({theme for assessment in comment['assessments'] for theme in assessment.get('themes', [])})
        label, via = jobs.label('hn-task', task), 'task:' + task
        if label == '':
            theme = next((theme for theme in themes_order if theme in themes), None)
            if theme is not None:
                label, via = jobs.label('hn-theme', theme), 'theme:' + theme
        keys = [[hn_key(a), HN_STANCE[a['sentiment']]] for a in comment['assessments']]
        for key, _ in keys:
            if key.startswith('model|') and key[6:] not in model_ids:
                unknown_models[key[6:]].append(record_id)
        record = records.make(
            label, via if label is not None else 'hn-task:' + task, claim,
            id=record_id,
            cls='crowd',
            src='hn',
            keys=keys,
            stance=keys[0][1] if len(keys) == 1 else 'neutral',
            text=claim,
            tool=tool_in(claim),
            effort=effort_in(claim),
            date=date,
            url=f'https://news.ycombinator.com/item?id={comment["id"]}',
            title=stories.get(comment.get('story'), ''),
            kind=task,
            x={'themes': themes},
        )
        rows.append(record)
        comment_ids[record['job']].append(comment['id'])
        for key, stance in keys:
            counts[key][record['job']][date[:7]][STANCES.index(stance)] += 1
        # A theme belongs to one label, so it counts toward that label's target only.
        for assessment in comment['assessments']:
            stance = STANCES.index(HN_STANCE[assessment['sentiment']])
            for theme in assessment.get('themes', []):
                theme_counts[hn_key(assessment)][record['job']][date[:7]][theme][stance] += 1
        for preference in comment.get('prefers', []):
            preferences.append({
                'winner': hn_key(preference['winner']),
                'loser': hn_key(preference['loser']),
                'job': record['job'],
                'date': date,
                'id': record_id,
            })
    need(not unknown_models, 'Hacker News names models that are not in the snapshot:\n  ' + '\n  '.join(
        f'{model}: {", ".join(ids[:LIST_LIMIT])}' for model, ids in sorted(unknown_models.items())))
    weeks, aspects = weekly_counts(hn['comments'])
    return rows, {'counts': counts, 'themes': theme_counts, 'weeks': weeks, 'aspects': aspects}, preferences, {
        job: sorted(ids) for job, ids in sorted(comment_ids.items())}


# ---- Named: the people review ------------------------------------------------------------


def read_lines(path):
    return [json.loads(line) for line in Path(path).read_text(encoding='utf-8').splitlines() if line.strip()]


def read_people(root):
    """The people review under `root`/.local/people, read without writing; None when there is none."""
    directory = Path(root).joinpath(*PEOPLE_DIR)
    if not directory.is_dir():
        return None
    try:
        data = {
            'people': read_json(directory / 'people.json'),
            'use': read_lines(directory / 'use-records.jsonl'),
            'advice': read_lines(directory / 'method-advice.jsonl'),
            'unresolved': read_lines(directory / 'unresolved.jsonl'),
            'status': read_json(directory / 'review-status.json'),
        }
    except (OSError, ValueError) as error:
        raise BuildError(f'Could not read the people review in {directory}: {error}') from None
    return data


def check_named(data, model_ids):
    """Raise BuildError unless the people review's files are whole, agree with its status file and
    name only people in the people file and models in the snapshot."""
    try:
        check_people(data['people'])
    except RecordError as error:
        raise BuildError(f'people.json: {error}') from None
    names = {person['name'] for person in data['people']['people']}
    status = data['status']
    need(type(status) is dict and len(data['use']) == status.get('use_records') and len(data['advice']) == status.get('method_advice')
         and len(data['unresolved']) == (status.get('passage_states') or {}).get('unresolved', 0),
         'The people review files differ from review-status.json; run the pipeline\'s export again')
    for kind, rows, fields in (('use record', data['use'], set(USE_FIELDS)), ('method advice', data['advice'], set(ADVICE_FIELDS))):
        for row in rows:
            need(type(row) is dict and set(row) == fields | REVIEW_COMMON_FIELDS, f'A {kind} has other fields')
            where = f'{kind} from {row["source_id"]}'
            need(is_text(row['source_id']) and SOURCE_ID.fullmatch(row['source_id']), f'{where}: source id is not 24 hex digits')
            need(row['practitioner'] in names, f'{where}: its person is not in people.json')
            need(is_url(row['source_url']) and is_text(row['source_date']) and is_text(row['source_title']), f'{where}: no source link')
            need(all(is_text(row[field]) for field in fields - {'exact'}), f'{where}: a field is not text')
    for row in data['use']:
        where = f'use record from {row["source_id"]}'
        need(row['job'] in JOBS and row['outcome'] in OUTCOMES and row['basis'] in BASIS and row['scale'] in SCALE
             and row['effort'] in REVIEW_EFFORT and row['comparison'] in COMPARISON and type(row['exact']) is bool, f'{where}: unknown label')
        need(row['model_id'] == '' or row['model_id'] in model_ids, f'{where}: model {row["model_id"]} is not in the snapshot')
        need(row['compared_id'] == '' or row['compared_id'] in model_ids, f'{where}: model {row["compared_id"]} is not in the snapshot')
        need(row['model_id'] == '' or row['exact'], f'{where}: has a model id but is not exact')
        need(row['model_named'].strip() != '', f'{where}: names no model')
    for row in data['advice']:
        need(row['applies_to'] in ADVICE_SCOPE, f'method advice from {row["source_id"]}: unknown label')


def plain(text):
    return ' '.join(text.split())


def use_keys(row, stance):
    """The model, line or version key of a use record, then its tool. A product line stays a line and
    an exact version outside the model list keeps its own key."""
    keys = []
    if row['model_id']:
        keys.append(['model|' + row['model_id'], stance])
    elif row['exact']:
        keys.append(['version|' + plain(row['model_named']), stance])
    elif row['model_line'].strip():
        keys.append(['line|' + plain(row['model_line']), stance])
    if row['tool'].strip():
        keys.append(['tool|' + plain(row['tool']), stance])
    return keys


def named_records(data, records):
    """(use records, method advice, use records left out per person). Ids are `ur:<source id>/<n>`
    and `ma:<source id>/<n>`, numbered in file order within each source, so they do not change when
    other sources are reviewed again. Advice-only people's use records are numbered and left out."""
    people = {person['name']: person for person in data['people']['people']}
    numbers, use, advice, excluded = collections.Counter(), [], [], collections.Counter()
    for row in data['use']:
        numbers['ur', row['source_id']] += 1
        person = people[row['practitioner']]
        if person['adviceOnly']:
            excluded[person['name']] += 1
            continue
        stance = OUTCOME_STANCE[row['outcome']]
        secondary = person['sourceClass'] == 'secondary'
        basis = BASIS_SHORT[row['basis']]
        date = row['source_date'][:10]
        use.append(records.make(
            records.jobs.label('review-job', row['job']), 'review:' + row['job'], None, how='review',
            id=f'ur:{row["source_id"]}/{numbers["ur", row["source_id"]]}',
            cls='named',
            src='use',
            keys=use_keys(row, stance),
            stance=stance,
            text=row['summary'],
            quote=row['quote'],
            cond=' · '.join(value for value in (
                row['setting'], row['scale'] if row['scale'] != 'not stated' else '', row['sample_size'], row['cost_time'],
            ) if value),
            tool=row['tool'],
            effort='' if row['effort'] == 'other' else row['effort'],
            date=date if is_date(date) else '',
            person=person['name'],
            url=row['source_url'],
            title=row['source_title'],
            kind=row['outcome'],
            x={
                'named': row['model_named'],
                'exact': row['exact'],
                'line': row['model_line'],
                'task': row['task'],
                'basis': row['basis'],
                # A secondary source's "measured" is a figure it reports, filtered as second-hand.
                'b': 'second' if secondary and basis == 'measured' else basis,
                'sec': secondary,
                'cmpNamed': row['compared_named'],
                'cmpId': row['compared_id'],
                'cmp': row['comparison'],
                'channel': row['source_channel'],
            },
        ))
    for row in data['advice']:
        numbers['ma', row['source_id']] += 1
        person = people[row['practitioner']]
        date = row['source_date'][:10]
        advice.append(records.make(
            records.jobs.label('review-job', row['applies_to']), 'review:' + row['applies_to'], None, how='review',
            id=f'ma:{row["source_id"]}/{numbers["ma", row["source_id"]]}',
            cls='named',
            src='advice',
            text=row['advice'],
            quote=row['quote'],
            tool=row['tool'],
            date=date if is_date(date) else '',
            person=person['name'],
            url=row['source_url'],
            title=row['source_title'],
            kind='method advice',
            x={'channel': row['source_channel'], 'sec': person['sourceClass'] == 'secondary'},
        ))
    return use, advice, excluded


def newest_first(rows):
    def order(record):
        source, number = record['id'].split(':', 1)[1].split('/')
        return record['date'], source, int(number)
    return sorted(rows, key=order, reverse=True)


def build_named(snapshot, guide, job_data, imported, data):
    """named-private.json for the people review `data` (see read_people), or raise BuildError.
    Method advice never counts toward a model or toward job coverage."""
    model_ids = {model['id'] for model in snapshot['models']}
    check_named(data, model_ids)
    benchmark_ids = {benchmark['id'] for benchmark in snapshot['benchmarks']}
    imported_ids = {entry['id'] for kind, (_, field, _) in IMPORT_FIELDS.items() for entry in imported[kind][field]}
    jobs = Jobs(job_data, benchmark_ids | imported_ids, {task['id'] for task in guide['tasks']})
    records = Records(jobs)
    use, advice, excluded = named_records(data, records)
    records.stop_if_uncovered()
    ids = [record['id'] for record in use + advice]
    need(len(set(ids)) == len(ids), 'Named record ids are repeated')
    use_by, advice_by = collections.Counter(r['person'] for r in use), collections.Counter(r['person'] for r in advice)
    status = data['status']
    return {
        'version': 1,
        'private': 'Served only behind sign-in. Never copy this file into a public build.',
        'review': {
            'model': status.get('model', ''),
            'methodology': status.get('methodology', ''),
            'passages': status.get('passage_states', {}),
            'unresolvedByIssue': status.get('issues', {}),
            'jobAgreement': REVIEW_JOB_AGREEMENT,
            'note': "Summaries, outcome, basis and job were written by a model review; the quote is the source's own words.",
        },
        'people': [
            {
                'name': person['name'],
                'sourceClass': person['sourceClass'],
                'adviceOnly': person['adviceOnly'],
                'trusted': person['trusted'],
                'added': person['added'],
                'dropped': person['dropped'],
                'use': use_by[person['name']],
                'advice': advice_by[person['name']],
                'useLeftOut': excluded[person['name']],
            }
            for person in data['people']['people']
        ],
        'coverage': [
            {'job': job_id, 'use': sum(r['job'] == job_id for r in use), 'advice': sum(r['job'] == job_id for r in advice)}
            for job_id in [*jobs.ids, '']
        ],
        'use': newest_first(use),
        'advice': newest_first(advice),
    }


# ---- Core ------------------------------------------------------------------------------


def build_core(snapshot, guide, job_data, hn, imported, usage=None, named=False):
    """Return (core, records) for the given inputs, or raise BuildError. `imported` holds the
    reviewed LMArena and Epoch files by kind (see IMPORTED); `usage` is the reviewed OpenRouter
    usage file, which adds the usage block and changes nothing else. `named` says whether named
    records were built (into named-private.json); core.json carries only that flag about them."""
    model_ids = {model['id'] for model in snapshot['models']}
    names = {model['id']: model['name'] for model in snapshot['models']}
    for kind in IMPORTED:
        check_imported(kind, imported[kind], model_ids)
    imported_ids = [entry['id'] for kind, (_, field, _) in IMPORT_FIELDS.items() for entry in imported[kind][field]]
    benchmark_ids = {benchmark['id'] for benchmark in snapshot['benchmarks']}
    need(not benchmark_ids & set(imported_ids), 'An imported benchmark id is also in the snapshot: '
         + ', '.join(sorted(benchmark_ids & set(imported_ids))))
    jobs = Jobs(job_data, benchmark_ids | set(imported_ids), {task['id'] for task in guide['tasks']})
    if usage is not None:
        check_usage(usage, model_ids, jobs)
    records = Records(jobs)
    measured = (
        measured_records(snapshot, records)
        + arena_records(imported['lmarena'], records, names)
        + epoch_records(imported['epoch'], records, names)
    )
    hn_rows, aggregates, preferences, comment_ids = crowd(hn, records, model_ids)
    counts = aggregates['counts']
    categories = {}
    for category, label in jobs.crosswalk['benchmark-category'].items():
        resolved = jobs.resolve(label)
        need(resolved is not None, f'crosswalk benchmark-category: {category} maps to {label}, which is not a job')
        categories[category] = resolved[0]
    missing = sorted({benchmark['category'] for benchmark in snapshot['benchmarks']} - set(categories))
    need(not missing, 'crosswalk benchmark-category has no entry for ' + ', '.join(missing))
    records.stop_if_uncovered()
    ids = [record['id'] for record in measured + hn_rows]
    duplicates = sorted(record_id for record_id, n in collections.Counter(ids).items() if n > 1)
    need(not duplicates, 'Record ids are repeated: ' + ', '.join(duplicates[:LIST_LIMIT]))

    line_names = sorted({key.split('|', 1)[1] for key in counts if key.startswith('line|')})
    lines = []
    for name in line_names:
        own = tokens(name)
        lines.append({'name': name, 'models': [
            model['id'] for model in snapshot['models'] if own and all(t in tokens(model['name']) for t in own)
        ]})
    sources = ('benchmark', 'arena', 'report', 'hn')
    rows = [
        {'job': job_id, 'counts': {source: records.coverage[job_id, source] for source in sources}}
        for job_id in [*jobs.ids, '']
    ]
    core = {
        'sources': {
            'snapshot': snapshot['checkedAt'],
            **{
                kind: {
                    'fetchedAt': imported[kind]['fetchedAt'],
                    'checkedAt': imported[kind]['checkedAt'],
                    'attribution': imported[kind]['source']['attribution'],
                    'records': sum(record['id'].startswith(prefix) for record in measured),
                }
                for kind, prefix in (('lmarena', 'la:'), ('epoch', 'ep:'))
            },
            'hn': {
                'from': hn['from'],
                'publishedAt': hn['publishedAt'],
                'classifier': hn['status']['classifier'],
                'startAt': hn['status']['startAt'],
                'endAt': hn['status']['endAt'],
                'comments': len(hn_rows),
                'labels': sum(len(record['keys']) for record in hn_rows),
            },
        },
        'jobs': {'version': job_data['version'], 'status': job_data['status'], 'list': jobs.jobs, 'categories': categories,
                 'guide': jobs.guide},
        'models': [
            {
                'id': model['id'],
                'name': model['name'],
                'provider': model['provider'],
                'status': model.get('status', ''),
                'input': model.get('pricing', {}).get('input'),
                'output': model.get('pricing', {}).get('output'),
                'priceUrl': model.get('pricing', {}).get('url', ''),
                'contextTokens': model.get('pricing', {}).get('contextTokens'),
            }
            for model in snapshot['models']
        ],
        'lines': lines,
        'benchmarks': [
            {
                'id': benchmark['id'],
                'name': benchmark['name'],
                'category': benchmark['category'],
                'general': benchmark['category'] == 'general',
                'unit': benchmark['unit'],
                'scale': 'percent' if '%' in benchmark['unit'] else 'index',
                'what': benchmark['description'],
                'methodology': benchmark['methodology'],
                'costMethod': benchmark.get('costMethod', ''),
                'url': benchmark['url'],
                'source': 'snapshot',
                'publishedAt': '',
                'attribution': '',
                'rows': None,
            }
            for benchmark in snapshot['benchmarks']
        ] + [entry for kind in IMPORTED for entry in imported_benchmarks(kind, imported[kind], jobs)],
        'measured': measured,
        'crowd': {'stances': list(STANCES), 'counts': counts, 'themes': aggregates['themes'],
                  'weeks': aggregates['weeks'], 'aspects': aggregates['aspects'], 'comments': comment_ids},
        'preferences': preferences,
        'coverage': {'sources': list(sources), 'rows': rows},
        'usage': None if usage is None else usage_block(usage, jobs),
        'namedBehindSignIn': named,
    }
    return core, measured + hn_rows


def coverage_table(core, named=None):
    """Records per job and source. With named records, a column of use records (jobs by review)."""
    labels = {job['id']: ('↳ ' if job.get('parent') else '') + job['label'] for job in core['jobs']['list']}
    labels[''] = 'No job'
    sources = list(core['coverage']['sources'])
    headings = {'benchmark': 'Benchmark', 'arena': 'Arena', 'report': 'Report', 'hn': 'Hacker News', 'use': 'Use (review)'}
    rows = [dict(row['counts']) for row in core['coverage']['rows']]
    if named is not None:
        sources.append('use')
        for counts, row in zip(rows, named['coverage']):
            counts['use'] = row['use']
    width = max(len(label) for label in labels.values())
    lines = [f'{"Job":{width}} ' + ' '.join(f'{headings[source]:>12}' for source in sources)]
    totals = collections.Counter()
    for row, counts in zip(core['coverage']['rows'], rows):
        totals.update(counts)
        lines.append(f'{labels[row["job"]]:{width}} ' + ' '.join(f'{counts[source]:>12,}' for source in sources))
    lines.append(f'{"Total":{width}} ' + ' '.join(f'{totals[source]:>12,}' for source in sources))
    return '\n'.join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(
        description='Build core.json from the snapshot, the reports, LMArena, Epoch runs, OpenRouter usage and Hacker News.')
    parser.add_argument('--hn-root', type=Path, default=ROOT, help='checkout whose .local/hn or dist/ holds Hacker News')
    parser.add_argument('--hn-source', choices=('auto', 'checkpoint', 'export'), default='auto')
    parser.add_argument('--people-root', type=Path,
                        help='checkout whose .local/people holds the people review (default: the --hn-root checkout)')
    parser.add_argument('--jobs', type=Path, default=ROOT / 'research/jobs.json')
    parser.add_argument('--out', type=Path, default=DEFAULT_OUT)
    parser.add_argument('--named-out', type=Path, default=DEFAULT_NAMED_OUT)
    parser.add_argument('--search-out', type=Path, default=DEFAULT_SEARCH_OUT)
    parser.add_argument('--search-local', type=Path, default=DEFAULT_SEARCH_LOCAL)
    args = parser.parse_args(argv)
    people_root = args.people_root or args.hn_root
    try:
        for out in (args.out, args.named_out, args.search_out, args.search_local):
            need(not within(out, '.local'), f'refusing to write under .local: {out}')
        snapshot = read_json(ROOT / 'src/lib/snapshot.json')
        guide = read_json(ROOT / 'research/app-model-choices.json')
        job_data = read_json(args.jobs)
        imported = {kind: read_json(path) for kind, path in IMPORTED.items()}
        usage = read_json(USAGE)
        hn = read_hn(args.hn_root, args.hn_source)
        people = read_people(people_root)
        named = None if people is None else build_named(snapshot, guide, job_data, imported, people)
        core, records = build_core(snapshot, guide, job_data, hn, imported, usage, named is not None)
        size, packed = write_json(args.out, core)
        named_size = None if named is None else write_json(args.named_out, named)[0]
        names = {model['id']: model['name'] for model in snapshot['models']}
        labels = {job['id']: job['label'] for job in core['jobs']['list']}
        built_at = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')
        manifest = write_search_public(args.search_out, records, names, labels, built_at)
        local = write_search_local(args.search_local, records, [] if named is None else named['use'],
                                   [] if named is None else named['advice'], names, labels, built_at)
    except BuildError as error:
        raise SystemExit(str(error)) from None
    print(coverage_table(core, named))
    for kind, label in (('lmarena', 'LMArena'), ('epoch', 'Epoch runs')):
        source = core['sources'][kind]
        print(f'{label}: {source["records"]:,} records, fetched {source["fetchedAt"]}, checked {source["checkedAt"]}.')
    usage = core['usage']
    print(
        f'OpenRouter usage (orders nothing): {len(usage["tokens"]["models"]):,} models with 30-day tokens as of '
        f'{usage["tokens"]["asOf"]}, {len(usage["tasks"]["tags"]):,} task tags as of {usage["tasks"]["asOf"]}, '
        f'checked {usage["checkedAt"]}.'
    )
    print(f'Hacker News from the {core["sources"]["hn"]["from"]}: {core["sources"]["hn"]["comments"]:,} comments.')
    if named is None:
        print(f'No people review under {people_root / ".local/people"}: no named records; core.json says none exist.')
    else:
        left_out = sum(person['useLeftOut'] for person in named['people'])
        print(
            f'Named records (private, behind sign-in): {len(named["use"]):,} use records ({left_out:,} left out as '
            f'advice-only), {len(named["advice"]):,} method advice, {len(named["people"])} people. '
            f'Wrote {args.named_out}: {named_size:,} bytes.'
        )
    print(f'Wrote {args.out}: {size:,} bytes, {packed:,} gzipped.')
    files = 1 + manifest['shards'] + manifest['files']['facts'] + manifest['files']['records']
    print(f'Wrote the search index {args.search_out}: {manifest["records"]:,} public records in {files:,} files.')
    print(f'Wrote the local search index {args.search_local} (private): {local["public"]:,} public records, '
          f'{local["use"]:,} use records, {local["advice"]:,} method advice.')


if __name__ == '__main__':
    sys.exit(main())

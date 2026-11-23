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
    ADVICE_FIELDS, ADVICE_SCOPE, BASIS, COMPARISON, JOBS, OUTCOMES, RUN as REVIEW_RUN, SCALE,
    SETTING as REVIEW_SETTING, USE_FIELDS, EFFORT as REVIEW_EFFORT,
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

JOB_FILE_FIELDS = {'version', 'status', 'jobs', 'crosswalk', 'keywords', 'replaces', 'fields', 'surface', 'tags', 'guide'}
JOB_FIELDS = {'id', 'label', 'parent', 'benchmarks', 'bySurface', 'guideTask'}
CROSSWALK_SOURCES = (
    'hn-task', 'hn-theme', 'report', 'report-category', 'benchmark',
    'arena-leaderboard', 'epoch-run', 'openrouter-tag', 'review-job', 'benchmark-category',
)
# The sources this build loads. A label missing from a strict table stops the build;
# Hacker News themes are optional, so a theme without an entry gives no job, and a report
# without an entry of its own takes its category's.
LOADED_CROSSWALKS = CROSSWALK_SOURCES
STRICT_CROSSWALKS = (
    'hn-task', 'report-category', 'benchmark', 'arena-leaderboard', 'epoch-run', 'openrouter-tag', 'review-job',
)
# How well a source label matches the job it gives: the same task, an overlapping one, or no job.
FITS = ('direct', 'loose', 'none')
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
    """A checked job file: jobs, crosswalk tables, keyword rules, replacements, field rules, tool
    surfaces and tags."""

    def __init__(self, data, benchmark_ids, guide_tasks, general_ids=frozenset()):
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
                    check(benchmark not in general_ids, f'job {job_id}: {benchmark} is a general index, which orders no job')
                self.check_surfaces(job, check)
            if 'guideTask' in job:
                check(job['guideTask'] in guide_tasks, f'job {job_id}: App guide task {job["guideTask"]} does not exist')
        self.guide = self.check_guide(data['guide'], guide_tasks, check)

        replaces = data['replaces']
        need(type(replaces) is dict, 'replaces is not an object')
        self.replaces = {}
        for old, new in replaces.items():
            if not check(type(new) is dict and {'label', 'job'} <= set(new) <= {'label', 'job', 'into', 'setting', 'run'}, f'replaces {old}: fields differ'):
                continue
            check(JOB_PATTERN.fullmatch(old) and old not in current, f'replaces {old}: not an old job id')
            check(is_text(new['label']) and new['label'].strip(), f'replaces {old}: no label')
            check(new['job'] is None or new['job'] in current, f'replaces {old}: {new["job"]} is not a job')
            into = new.get('into', [])
            check(type(into) is list and all(job in current for job in into), f'replaces {old}: into names a job that does not exist')
            check(new['job'] is None or not into, f'replaces {old}: a replacement job and jobs it was split into')
            check(new['job'] is not None or into or 'setting' in new or 'run' in new,
                  f'replaces {old}: no job, no jobs it was split into and no field it sets')
            check(new.get('setting', 'local') in SETTINGS[1:], f'replaces {old}: unknown setting')
            check(new.get('run', 'parallel') in RUNS[1:], f'replaces {old}: unknown run')
            self.replaces[old] = (new['job'] or '', new.get('setting', ''), new.get('run', ''), new['job'] is None)

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
                if not check(type(entry) is dict and {'label', 'job', 'fit'} <= set(entry) <= {'label', 'job', 'fit', 'note'}
                             and is_text(entry['label']) and entry['label'], f'crosswalk {source}: an entry is not a label, a job, a fit and an optional note'):
                    continue
                label, target = entry['label'], entry['job']
                check(label not in mapping, f'crosswalk {source}: {label} is listed twice')
                check(target is None or is_text(target), f'crosswalk {source}: {label} maps to {target}')
                check(entry['fit'] in FITS, f'crosswalk {source}: {label} has unknown fit {entry["fit"]}')
                check(is_text(entry.get('note', '-')) and entry.get('note', '-').strip(), f'crosswalk {source}: {label} has an empty note')
                if is_text(target) and target not in current and target not in self.replaces:
                    self.unknown_targets[target].append(f'{source}:{label}')
                else:
                    gives = target in current or (is_text(target) and self.replaces[target][0] != '')
                    check(gives == (entry['fit'] != 'none'), f'crosswalk {source}: {label} has fit {entry["fit"]} but '
                          + ('gives a job' if gives else 'gives no job'))
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
            pattern = self.compile(rule, f'keyword rule {number}', check)
            if pattern is not None and type(rule['within']) is list:
                self.rules.append((rule['job'], {job or '' for job in rule['within']}, pattern))

        self.check_fields(data['fields'], check)

        surface = data['surface']
        need(type(surface) is dict and set(surface) == {'version', 'surfaces'} and type(surface['surfaces']) is list,
             'surface is not a version and a list of surfaces')
        check(type(surface['version']) is int, 'surface version is not an integer')
        self.surfaces = []
        for entry in surface['surfaces']:
            if not check(type(entry) is dict and set(entry) == {'surface', 'words'} and type(entry['words']) is list
                         and entry['words'] and all(is_text(word) and word == word.lower() and word.strip() == word and word for word in entry['words']),
                         'surface: an entry is not a surface and a list of lower-case words'):
                continue
            check(entry['surface'] in SURFACES[1:], f'surface: unknown surface {entry["surface"]}')
            words = '|'.join(re.escape(word) for word in entry['words'])
            self.surfaces.append((entry['surface'], re.compile(f'(?<![a-z])(?:{words})(?![a-z])')))
        check(len({name for name, _ in self.surfaces}) == len(self.surfaces), 'surface: a surface is listed twice')

        tags = data['tags']
        need(type(tags) is dict and set(tags) == {'version', 'rules'} and type(tags['rules']) is list, 'tags is not a version and a list of rules')
        check(type(tags['version']) is int, 'tags version is not an integer')
        self.tags = []
        for number, rule in enumerate(tags['rules'], 1):
            if not check(type(rule) is dict and set(rule) == {'tag', 'label', 'pattern', 'caseSensitive'}
                         and is_text(rule['tag']) and JOB_PATTERN.fullmatch(rule['tag']) and is_text(rule['label']) and rule['label'].strip(),
                         f'tag rule {number}: not a tag, a label, a pattern and caseSensitive'):
                continue
            check(rule['tag'] not in current, f'tag rule {number}: {rule["tag"]} is a job id')
            pattern = self.compile(rule, f'tag rule {number}', check)
            if pattern is not None:
                self.tags.append((rule['tag'], pattern))
        check(len({tag for tag, _ in self.tags}) == len(self.tags), 'tags: a tag is listed twice')

        need(not problems, 'The job file is not valid:\n  ' + '\n  '.join(problems))
        self.current = current

    @staticmethod
    def compile(rule, where, check):
        """A rule's pattern compiled, or None (with a problem noted) when it does not compile."""
        check(type(rule['caseSensitive']) is bool, f'{where}: caseSensitive is not true or false')
        try:
            return re.compile(rule['pattern'], 0 if rule['caseSensitive'] is True else re.I)
        except (re.error, TypeError):
            check(False, f'{where}: pattern does not compile')
            return None

    @staticmethod
    def check_surfaces(job, check):
        """A job measured differently per surface lists, per surface, the benchmarks that order it there;
        the first surface listed is the default."""
        if 'bySurface' not in job:
            return
        by_surface = job['bySurface']
        if not check(type(by_surface) is dict and by_surface, f'job {job["id"]}: bySurface is not a table of surfaces'):
            return
        for surface, ids in by_surface.items():
            check(surface in SURFACES[1:], f'job {job["id"]}: unknown surface {surface}')
            check(type(ids) is list and ids and len(set(map(str, ids))) == len(ids) and all(i in job['benchmarks'] for i in ids),
                  f'job {job["id"]}: the {surface} benchmarks are not distinct benchmarks of the job')

    def check_fields(self, fields, check):
        """Rules that set the setting or run field from a Hacker News theme or a record's surface."""
        need(type(fields) is dict and set(fields) == {'version', 'hn-theme', 'surface'}
             and all(type(fields[part]) is list for part in ('hn-theme', 'surface')),
             'fields is not a version and lists of hn-theme and surface rules')
        check(type(fields['version']) is int, 'fields version is not an integer')

        def values(rule, key, where):
            if not check(type(rule) is dict and key in rule and set(rule) - {key} and set(rule) <= {key, 'setting', 'run'},
                         f'fields {where}: a rule is not a {key} with a setting or run'):
                return None
            check(rule.get('setting', 'local') in SETTINGS[1:] and rule.get('run', 'parallel') in RUNS[1:], f'fields {where}: unknown value')
            return rule.get('setting', ''), rule.get('run', '')

        self.theme_fields = {}
        for rule in fields['hn-theme']:
            found = values(rule, 'label', 'hn-theme')
            if found is not None:
                check(rule['label'] in HN_THEMES, f'fields hn-theme: unknown theme {rule["label"]}')
                self.theme_fields[rule['label']] = found
        self.surface_fields = {}
        for rule in fields['surface']:
            found = values(rule, 'surface', 'surface')
            if found is not None:
                check(rule['surface'] in SURFACES[1:], f'fields surface: unknown surface {rule["surface"]}')
                self.surface_fields[rule['surface']] = found

    def check_guide(self, guide, guide_tasks, check):
        """The brief each App guide task links to. Every guide task is listed once, with the job whose
        guideTask names it, or with no job and a note saying why; a task with no job is never the guide
        task of a job. A loose link says how the task and the job differ."""
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
            if not check(type(entry) is dict and {'task', 'job'} <= set(entry) <= {'task', 'job', 'fit', 'note'}
                         and is_text(entry['task']), 'guide: an entry is not a task, a job, an optional fit and an optional note'):
                continue
            task, job_id = entry['task'], entry['job']
            check(task in guide_tasks, f'guide: App guide task {task} does not exist')
            check(task not in listed, f'guide: {task} is listed twice')
            listed.add(task)
            noted = is_text(entry.get('note')) and entry['note'].strip() != ''
            if job_id is None:
                check(noted, f'guide: {task} has no job and no note')
                check('fit' not in entry, f'guide: {task} has no job and a fit')
                check(not pointed[task], f'guide: {task} has no job, but {", ".join(pointed[task])} names it as guide task')
                out.append({'task': task, 'job': None, 'note': entry.get('note', '')})
                continue
            fit = entry.get('fit', 'direct')
            check(fit in ('direct', 'loose'), f'guide: {task} has unknown fit {fit}')
            check(noted == (fit == 'loose') and ('note' in entry) == noted, f'guide: {task} needs a note when, and only when, its fit is loose')
            if check(job_id in by_id, f'guide: {task} links to {job_id}, which is not a job'):
                check(by_id[job_id].get('guideTask') == task, f'guide: {task} links to {job_id}, whose guide task is {by_id[job_id].get("guideTask")}')
            out.append({'task': task, 'job': job_id, **({'fit': 'loose', 'note': entry.get('note', '')} if fit == 'loose' else {})})
        for task in sorted(guide_tasks - listed):
            check(False, f'guide: App guide task {task} is not listed')
        return out

    def label(self, source, value):
        """The job a source label maps to, as stored: a job id, an old id, an unknown id or ''."""
        return self.crosswalk[source].get(value)

    def resolve(self, job):
        """(job, setting, run, needs reading) for a stored job id, through `replaces`; None when it is
        not covered. A stored id that was split or became a field gives no job and needs reading."""
        if job == '' or job in self.current:
            return job, '', '', False
        return self.replaces.get(job)

    def assign(self, base, via, text):
        """(job, how, via) for a record whose label gave the current job `base` through `via`."""
        for job, allowed, pattern in self.rules:
            if base in allowed and pattern.search(text):
                return job, 'keywords', 'kw:' + job
        if base:
            return base, 'label', via
        return '', '', ''

    def surface_of(self, tool):
        """The surface a tool is, from the surface table: the first whose word the tool names."""
        text = tool.lower()
        return next((name for name, pattern in self.surfaces if pattern.search(text)), '')

    def tags_of(self, text):
        """The tags whose rule matches `text`, as a record's x carries them: {'tags': [...]} or {}."""
        found = [tag for tag, pattern in self.tags if pattern.search(text)]
        return {'tags': found} if found else {}


# ---- Records ---------------------------------------------------------------------------


class Records:
    """Collects records, checks each against the shared schema and tracks job coverage."""

    def __init__(self, jobs):
        self.jobs = jobs
        self.problems = collections.defaultdict(list)
        self.uncovered = set()
        self.coverage = collections.Counter()
        # Records that need reading until the next review, by the old job they were given and source.
        self.pending = collections.Counter()

    def make(self, label, via, words, how='label', **values):
        """A record whose job comes from `label`, the job id a source label maps to (None when the
        source label is not in the crosswalk), refined or filled in by keyword rules over `words`
        (None: no keyword rules apply). `how` says how a job given by the label was assigned.

        A label whose old job was split or became a field gives no job: the record is marked as
        needing reading (`how` 'pending', `via` the label) and is never given a job by guess. The
        setting and run fields come from `replaces`, from the caller, and from the surface table,
        which also gives the surface of the record's tool."""
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
        base, setting, run, pending = resolved
        if words is not None:
            job, how, assigned = self.jobs.assign(base, via, words)
        else:
            job, how, assigned = (base, how, via) if base else ('', '', '')
        if pending and job == '':
            how, assigned = 'pending', via
        record.update(job=job, how=how, via=assigned)
        record['surface'] = self.jobs.surface_of(record['tool'])
        by_surface = self.jobs.surface_fields.get(record['surface'], ('', ''))
        record['setting'] = setting or record['setting'] or by_surface[0]
        record['run'] = run or record['run'] or by_surface[1]
        try:
            check_record(record)
        except RecordError as error:
            raise BuildError(f'{record["id"]}: {error}') from None
        if how == 'pending':
            self.pending[label, record['src']] += 1
        else:
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
        # A report listed by its id takes that job; any other takes its category's.
        own = records.jobs.label('report', report['id'])
        out.append(records.make(
            *((own, 'report:' + report['id']) if own is not None
              else (records.jobs.label('report-category', report['category']), 'category:' + report['category'])),
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
    need(comment.get('setting', '') in SETTINGS and comment.get('run', '') in RUNS, f'hn:{comment["id"]}: unknown setting or run')
    for preference in comment.get('prefers', []):
        for side in ('winner', 'loser'):
            need(preference[side].get('kind') in HN_KEY_KINDS, f'hn:{comment["id"]}: unknown preference target')


def hn_key(target):
    return HN_KEY_KINDS[target['kind']] + '|' + target['target']


def nested(depth):
    """Tables `depth` keys deep whose leaves are tallies of the four stances."""
    return [0, 0, 0, 0] if depth == 0 else collections.defaultdict(lambda: nested(depth - 1))


def cell_of(record):
    """A record's setting and run as one key, 'local|unattended'; '|' is the default (hosted or not
    stated, interactive or not stated)."""
    return f'{record["setting"]}|{record["run"]}'


def crowd(hn, records, model_ids):
    """Hacker News records, counts per target, job and month, the same counts per theme of the
    label, stated preferences, and the item ids of the comments in each job, so the app can open the
    comments behind a count. The same counts, themes and ids are kept again for each setting and
    run other than the default (`cells`), so the app can filter by them, and the comments each tag
    rule matches by target and month. The app renders every count from these aggregates and loads the
    comments themselves only when someone opens them."""
    jobs = records.jobs
    themes_order = list(jobs.crosswalk['hn-theme'])
    stories = {story['id']: story.get('title', '') for story in hn['stories']}
    counts, theme_counts = nested(3), nested(4)
    cells = collections.defaultdict(lambda: {'counts': nested(3), 'themes': nested(4), 'comments': collections.defaultdict(list)})
    tags = collections.defaultdict(lambda: collections.defaultdict(lambda: collections.defaultdict(list)))
    preferences = []
    comment_ids = collections.defaultdict(list)
    pending = collections.defaultdict(list)
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
        # A theme with a field rule sets that field whatever the task.
        fields = [jobs.theme_fields[theme] for theme in themes if theme in jobs.theme_fields]
        keys = [[hn_key(a), HN_STANCE[a['sentiment']]] for a in comment['assessments']]
        for key, _ in keys:
            if key.startswith('model|') and key[6:] not in model_ids:
                unknown_models[key[6:]].append(record_id)
        tagged = jobs.tags_of(claim)
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
            # The review states setting and run; a theme rule sets them for reviews made before it did.
            setting=comment.get('setting') or next((setting for setting, _ in fields if setting), ''),
            run=comment.get('run') or next((run for _, run in fields if run), ''),
            date=date,
            url=f'https://news.ycombinator.com/item?id={comment["id"]}',
            title=stories.get(comment.get('story'), ''),
            kind=task,
            x={'themes': themes, **tagged},
        )
        rows.append(record)
        if record['how'] == 'pending':
            pending[label].append(comment['id'])
        cell = cell_of(record)
        tallies = [(counts, theme_counts, comment_ids)]
        if cell != '|':
            tallies.append((cells[cell]['counts'], cells[cell]['themes'], cells[cell]['comments']))
        for to_counts, to_themes, to_ids in tallies:
            to_ids[record['job']].append(comment['id'])
            for key, stance in keys:
                to_counts[key][record['job']][date[:7]][STANCES.index(stance)] += 1
            # A theme belongs to one label, so it counts toward that label's target only.
            for assessment in comment['assessments']:
                stance = STANCES.index(HN_STANCE[assessment['sentiment']])
                for theme in assessment.get('themes', []):
                    to_themes[hn_key(assessment)][record['job']][date[:7]][theme][stance] += 1
        for tag in tagged.get('tags', []):
            for key, _ in keys:
                tags[tag][key][date[:7]].append(comment['id'])
        for preference in comment.get('prefers', []):
            preferences.append({
                'winner': hn_key(preference['winner']),
                'loser': hn_key(preference['loser']),
                'job': record['job'],
                'setting': record['setting'],
                'run': record['run'],
                'date': date,
                'id': record_id,
            })
    need(not unknown_models, 'Hacker News names models that are not in the snapshot:\n  ' + '\n  '.join(
        f'{model}: {", ".join(ids[:LIST_LIMIT])}' for model, ids in sorted(unknown_models.items())))

    def by_job(ids):
        return {job: sorted(values) for job, values in sorted(ids.items())}

    return rows, {
        'counts': counts,
        'themes': theme_counts,
        'cells': {cell: {'counts': value['counts'], 'themes': value['themes'], 'comments': by_job(value['comments'])}
                  for cell, value in sorted(cells.items())},
        'tags': {tag: {key: {month: sorted(ids) for month, ids in sorted(by_month.items())}
                       for key, by_month in sorted(by_key.items())} for tag, by_key in sorted(tags.items())},
        # Comments with no job that need reading, by the old job their label gave.
        'pending': {old: sorted(ids) for old, ids in pending.items()},
    }, preferences, by_job(comment_ids)


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
    for row in data['use'] + data['advice']:
        need(row['setting'] in REVIEW_SETTING and row['run'] in REVIEW_RUN, f'record from {row["source_id"]}: unknown setting or run')


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
                row['other_settings'], row['scale'] if row['scale'] != 'not stated' else '', row['sample_size'], row['cost_time'],
            ) if value),
            tool=row['tool'],
            effort='' if row['effort'] == 'other' else row['effort'],
            setting=row['setting'],
            run=row['run'],
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
                **records.jobs.tags_of(row['task']),
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
            setting=row['setting'],
            run=row['run'],
            date=date if is_date(date) else '',
            person=person['name'],
            url=row['source_url'],
            title=row['source_title'],
            kind='method advice',
            x={'channel': row['source_channel'], 'sec': person['sourceClass'] == 'secondary'},
        ))
    return use, advice, excluded


def general_ids(snapshot):
    """The snapshot's general indexes, which order no job."""
    return {benchmark['id'] for benchmark in snapshot['benchmarks'] if benchmark['category'] == 'general'}


def pending_order(jobs, records):
    """The old job ids that left records needing reading, in the order `replaces` lists them."""
    seen = {old for old, _source in records.pending}
    return [old for old in jobs.replaces if old in seen]


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
    jobs = Jobs(job_data, benchmark_ids | imported_ids, {task['id'] for task in guide['tasks']}, general_ids(snapshot))
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
            {'job': job_id, 'use': records.coverage[job_id, 'use'], 'advice': records.coverage[job_id, 'advice']}
            for job_id in [*jobs.ids, '']
        ],
        # Records whose old job was split or became a field, by that old job: no job until the next review.
        'pending': [
            {'old': old, 'use': records.pending[old, 'use'], 'advice': records.pending[old, 'advice']}
            for old in pending_order(jobs, records)
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
    jobs = Jobs(job_data, benchmark_ids | set(imported_ids), {task['id'] for task in guide['tasks']}, general_ids(snapshot))
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
    pending = [
        {'old': old, 'counts': {source: records.pending[old, source] for source in sources}}
        for old in pending_order(jobs, records)
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
                  'comments': comment_ids, 'cells': aggregates['cells'], 'tags': aggregates['tags'],
                  'pending': {old: aggregates['pending'][old] for old in jobs.replaces if old in aggregates['pending']}},
        'preferences': preferences,
        'coverage': {'sources': list(sources), 'rows': rows, 'pending': pending},
        'usage': None if usage is None else usage_block(usage, jobs),
        'namedBehindSignIn': named,
    }
    return core, measured + hn_rows


def coverage_table(core, named=None, old_labels=None):
    """Records per job and source. With named records, a column of use records (jobs by review).
    Records that need reading until the next review are counted apart from those with no job, in
    total and by the old job they were given."""
    labels = {job['id']: ('↳ ' if job.get('parent') else '') + job['label'] for job in core['jobs']['list']}
    labels[''] = 'No job'
    old_labels = old_labels or {}
    sources = list(core['coverage']['sources'])
    headings = {'benchmark': 'Benchmark', 'arena': 'Arena', 'report': 'Report', 'hn': 'Hacker News', 'use': 'Use (review)'}
    rows = [(labels[row['job']], dict(row['counts'])) for row in core['coverage']['rows']]
    pending = {row['old']: dict(row['counts']) for row in core['coverage']['pending']}
    if named is not None:
        sources.append('use')
        for (_, counts), row in zip(rows, named['coverage']):
            counts['use'] = row['use']
        for row in named['pending']:
            pending.setdefault(row['old'], collections.Counter())['use'] = row['use']
    needs = collections.Counter()
    for counts in pending.values():
        needs.update(counts)
    no_job = rows.pop()
    rows.append(('Needs reading until the next review', needs))
    rows.extend((f'  from {old_labels.get(old, old)}', counts) for old, counts in pending.items())
    rows.append(no_job)
    width = max(len(label) for label, _ in rows)
    lines = [f'{"Job":{width}} ' + ' '.join(f'{headings[source]:>12}' for source in sources)]
    totals = collections.Counter()
    for label, counts in rows:
        if not label.startswith('  from '):
            totals.update(counts)
        lines.append(f'{label:{width}} ' + ' '.join(f'{counts.get(source, 0):>12,}' for source in sources))
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
    print(coverage_table(core, named, {old: entry['label'] for old, entry in job_data['replaces'].items()}))
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

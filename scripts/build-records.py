"""Build the shared evidence records into core.json and print job coverage.

Reads, and never writes: src/lib/snapshot.json (models, benchmark results and published
reports), research/app-model-choices.json (App guide tasks), research/jobs.json (jobs,
crosswalk, keyword rules) and Hacker News, from the local checkpoint when there is one,
else from the published export in dist/. Restricted benchmarks are not read.

Writes one ignored file, build/records/core.json by default: models, product lines, jobs,
benchmarks, measured records, Hacker News counts per target, job and month, stated
preferences and the coverage table. A job id the job file does not list, or a source label
it does not map, stops the build with the records concerned.

Usage: python3 scripts/build-records.py [--hn-root DIR] [--hn-source auto|checkpoint|export]
                                        [--jobs FILE] [--out FILE]
"""

import argparse
import collections
import gzip
import json
import re
import runpy
import sqlite3
import sys
from pathlib import Path

from hn_local.sources import PipelineError
from hn_local.state import DATABASE
from records_schema import (
    DATE_PATTERN, FIELDS, JOB_PATTERN, RUNS, SETTINGS, STANCES, SURFACES, RecordError, check_record, is_date,
    is_text,
)

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / 'build/records/core.json'
LIST_LIMIT = 20

JOB_FILE_FIELDS = {'version', 'status', 'jobs', 'crosswalk', 'keywords', 'surface', 'replaces'}
JOB_FIELDS = {'id', 'label', 'parent', 'benchmarks', 'guideTask'}
CROSSWALK_SOURCES = (
    'hn-task', 'hn-theme', 'report-category', 'benchmark',
    'arena-leaderboard', 'epoch-run', 'openrouter-tag', 'review-job',
)
# The sources this build loads. A label missing from a strict table stops the build;
# Hacker News themes are optional, so a theme without an entry gives no job.
LOADED_CROSSWALKS = ('hn-task', 'hn-theme', 'report-category', 'benchmark')
STRICT_CROSSWALKS = ('hn-task', 'report-category', 'benchmark')
HN_STANCE = {'positive': 'positive', 'negative': 'critical', 'mixed': 'mixed', 'neutral': 'neutral', 'unclear': 'neutral'}
HN_KEY_KINDS = {'model': 'model', 'family': 'line'}

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

    def make(self, label, via, words, **values):
        """A record whose job comes from `label`, the job id a source label maps to (None when the
        source label is not in the crosswalk), refined or filled in by keyword rules over `words`
        (None: no keyword rules apply)."""
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
            job, how, assigned = (base, 'label', via) if base else ('', '', '')
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
    for preference in comment.get('prefers', []):
        for side in ('winner', 'loser'):
            need(preference[side].get('kind') in HN_KEY_KINDS, f'hn:{comment["id"]}: unknown preference target')


def hn_key(target):
    return HN_KEY_KINDS[target['kind']] + '|' + target['target']


def crowd(hn, records, model_ids):
    """Hacker News records, counts per target, job and month, and stated preferences."""
    jobs = records.jobs
    themes_order = list(jobs.crosswalk['hn-theme'])
    stories = {story['id']: story.get('title', '') for story in hn['stories']}
    counts = collections.defaultdict(lambda: collections.defaultdict(lambda: collections.defaultdict(lambda: [0, 0, 0, 0])))
    preferences = []
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
        for key, stance in keys:
            counts[key][record['job']][date[:7]][STANCES.index(stance)] += 1
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
    return rows, counts, preferences


# ---- Core ------------------------------------------------------------------------------


def build_core(snapshot, guide, job_data, hn):
    """Return (core, records) for the given inputs, or raise BuildError."""
    benchmark_ids = {benchmark['id'] for benchmark in snapshot['benchmarks']}
    jobs = Jobs(job_data, benchmark_ids, {task['id'] for task in guide['tasks']})
    records = Records(jobs)
    model_ids = {model['id'] for model in snapshot['models']}
    measured = measured_records(snapshot, records)
    hn_rows, counts, preferences = crowd(hn, records, model_ids)
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
    sources = ('benchmark', 'report', 'hn')
    rows = [
        {'job': job_id, 'counts': {source: records.coverage[job_id, source] for source in sources}}
        for job_id in [*jobs.ids, '']
    ]
    core = {
        'sources': {
            'snapshot': snapshot['checkedAt'],
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
        'jobs': {'version': job_data['version'], 'status': job_data['status'], 'list': jobs.jobs},
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
                'what': benchmark['description'],
                'methodology': benchmark['methodology'],
                'costMethod': benchmark.get('costMethod', ''),
                'url': benchmark['url'],
            }
            for benchmark in snapshot['benchmarks']
        ],
        'measured': measured,
        'crowd': {'stances': list(STANCES), 'counts': counts},
        'preferences': preferences,
        'coverage': {'sources': list(sources), 'rows': rows},
    }
    return core, measured + hn_rows


def coverage_table(core):
    labels = {job['id']: ('↳ ' if job.get('parent') else '') + job['label'] for job in core['jobs']['list']}
    labels[''] = 'No job'
    sources = core['coverage']['sources']
    headings = {'benchmark': 'Benchmark', 'report': 'Report', 'hn': 'Hacker News'}
    width = max(len(label) for label in labels.values())
    lines = [f'{"Job":{width}} ' + ' '.join(f'{headings[source]:>12}' for source in sources)]
    totals = collections.Counter()
    for row in core['coverage']['rows']:
        totals.update(row['counts'])
        lines.append(f'{labels[row["job"]]:{width}} ' + ' '.join(f'{row["counts"][source]:>12,}' for source in sources))
    lines.append(f'{"Total":{width}} ' + ' '.join(f'{totals[source]:>12,}' for source in sources))
    return '\n'.join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description='Build core.json from the snapshot, the reports and Hacker News.')
    parser.add_argument('--hn-root', type=Path, default=ROOT, help='checkout whose .local/hn or dist/ holds Hacker News')
    parser.add_argument('--hn-source', choices=('auto', 'checkpoint', 'export'), default='auto')
    parser.add_argument('--jobs', type=Path, default=ROOT / 'research/jobs.json')
    parser.add_argument('--out', type=Path, default=DEFAULT_OUT)
    args = parser.parse_args(argv)
    try:
        need(not within(args.out, '.local'), f'refusing to write under .local: {args.out}')
        snapshot = read_json(ROOT / 'src/lib/snapshot.json')
        guide = read_json(ROOT / 'research/app-model-choices.json')
        job_data = read_json(args.jobs)
        hn = read_hn(args.hn_root, args.hn_source)
        core, _ = build_core(snapshot, guide, job_data, hn)
        size, packed = write_json(args.out, core)
    except BuildError as error:
        raise SystemExit(str(error)) from None
    print(coverage_table(core))
    print(
        f'Hacker News from the {core["sources"]["hn"]["from"]}: {core["sources"]["hn"]["comments"]:,} comments. '
        f'Wrote {args.out}: {size:,} bytes, {packed:,} gzipped.'
    )


if __name__ == '__main__':
    sys.exit(main())

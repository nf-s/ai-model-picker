"""Import LMArena ratings from the Arena leaderboard dataset on Hugging Face into research/lmarena.json.

Reads the `latest` split of the leaderboards listed in LEADERBOARDS through the Hugging Face
datasets server (no key), after checking that the dataset is still licensed CC BY 4.0. The
rows are saved in a new folder under .local/imports/lmarena/ and treated as untrusted data.
A model name is kept only when it, or the name with its effort setting and harness taken out,
is an exact key in research/aliases/lmarena.json. Dates and versions are never stripped.
Unmatched names are printed and left out. The output has an empty `checkedAt` until a person
has reviewed it (docs/updating.md).

Usage: python3 -B scripts/import_lmarena.py [--from DOWNLOAD_DIR] [--out FILE] [--aliases FILE]
"""

import argparse
import collections
import json
import re
import sys
import time
from pathlib import Path
from urllib.parse import urlencode

from import_common import (
    ROOT, SourceError, date_range, downloaded_on, fetch, is_date, is_number, mark_downloaded, model_ids, need,
    new_download_dir, read_aliases, read_json, report, write_reviewed,
)

DATASET = 'lmarena-ai/leaderboard-dataset'
DATASET_URL = f'https://huggingface.co/datasets/{DATASET}'
DATASET_API = f'https://huggingface.co/api/datasets/{DATASET}'
ROWS_API = 'https://datasets-server.huggingface.co/filter'
SPLIT = 'latest'
LICENCE = 'cc-by-4.0'
PAGE = 100
OUT = ROOT / 'research/lmarena.json'
ALIASES = ROOT / 'research/aliases/lmarena.json'

VOTES = 'Preference votes, not a pass rate: a rating relative to the other models on the same leaderboard and date.'
STYLE = ' Style control on.'
# config, category, name, what it measures. The order is the order of the output.
LEADERBOARDS = (
    ('webdev', 'overall', 'Code Arena (WebDev) · overall',
     'Votes between two web apps built from the same prompt. ' + VOTES),
    ('agent', 'overall', 'Agent Arena · overall',
     'Inverse-propensity score from real agent sessions in which people keep or reject the work. ' + VOTES),
    ('text_style_control', 'overall', 'Text Arena · overall',
     "Votes between two answers to people's own prompts, all categories." + STYLE + ' ' + VOTES),
    ('text_style_control', 'instruction_following', 'Text Arena · instruction following',
     'Votes on prompts with explicit instructions.' + STYLE + ' ' + VOTES),
    ('text_style_control', 'creative_writing', 'Text Arena · creative-writing prompts',
     'Votes on creative-writing prompts; votes reward style and length.' + STYLE + ' ' + VOTES),
    ('text_style_control', 'industry_writing_and_literature_and_language', 'Text Arena · writing, literature and language',
     'Votes on writing, literature and language prompts; votes reward style and length.' + STYLE + ' ' + VOTES),
    ('text_style_control', 'longer_query', 'Text Arena · longer query',
     'Votes on longer prompts; a proxy for long inputs, not a document test.' + STYLE + ' ' + VOTES),
    ('text_style_control', 'coding', 'Text Arena · coding',
     'Votes on coding prompts in a chat; not repository work.' + STYLE + ' ' + VOTES),
    ('text_style_control', 'math', 'Text Arena · math',
     'Votes on maths prompts; answers are not checked for correctness.' + STYLE + ' ' + VOTES),
    ('vision_style_control', 'overall', 'Vision Arena · overall',
     'Votes on prompts with an image.' + STYLE + ' ' + VOTES),
    ('vision_style_control', 'ocr', 'Vision Arena · OCR',
     'Votes on image prompts that need text read from the image.' + STYLE + ' ' + VOTES),
    ('vision_style_control', 'diagram', 'Vision Arena · diagrams',
     'Votes on prompts about diagrams.' + STYLE + ' ' + VOTES),
    ('document_style_control', 'overall', 'Document Arena · overall',
     'Votes between two answers about an uploaded document.' + STYLE + ' ' + VOTES),
    ('search_style_control', 'overall', 'Search Arena · overall',
     'Votes between two answers from models with web search.' + STYLE + ' ' + VOTES),
    ('text_to_image', 'overall', 'Text-to-Image Arena · overall',
     'Votes between two images generated from the same prompt. ' + VOTES),
    ('image_edit', 'overall', 'Image Edit Arena · overall',
     'Votes between two edits of the same image. ' + VOTES),
)
AGENT = 'agent'
ARENA_FIELDS = ('rating', 'rating_lower', 'rating_upper', 'vote_count')
AGENT_FIELDS = ('score', 'score_ci_lower', 'score_ci_upper', 'observation_count', 'session_count')
EFFORTS = {'max': 'max', 'xhigh': 'xhigh', 'high': 'high', 'medium': 'medium', 'low': 'low', 'minimal': 'minimal'}
TOOLS = {'codex harness': 'Codex'}
NAME = re.compile(r'(.*?) \((.*)\)')


def leaderboard_key(config, category):
    return f'{config}/{category}'


def file_name(config, category):
    return f'{config}.{category}.json'


def split_name(name):
    """(lookup key, effort, tool): '<base> (<parts>)' loses its effort and harness parts, nothing else."""
    match = NAME.fullmatch(name)
    if not match:
        return name, '', ''
    base, parts = match.group(1), [part.strip() for part in match.group(2).split(',')]
    effort = next((EFFORTS[part.lower()] for part in parts if part.lower() in EFFORTS), '')
    tool = next((TOOLS[part.lower()] for part in parts if part.lower() in TOOLS), '')
    rest = [part for part in parts if part.lower() not in EFFORTS and part.lower() not in TOOLS]
    return (f'{base} ({", ".join(rest)})' if rest else base), effort, tool


def match(name, aliases):
    """(model id, effort, tool) for a source name, or None. The full name is tried first."""
    key, effort, tool = split_name(name)
    model_id = aliases.get(name) or aliases.get(key)
    return (model_id, effort, tool) if model_id else None


# ---- Download ------------------------------------------------------------------------


def download(folder, get=fetch, pause=time.sleep):
    """Save the dataset card and every listed leaderboard's rows in `folder`."""
    (folder / 'dataset.json').write_bytes(get(DATASET_API))
    for config, category, *_ in LEADERBOARDS:
        rows, offset, total = [], 0, None
        while total is None or offset < total:
            query = urlencode({
                'dataset': DATASET, 'config': config, 'split': SPLIT,
                'where': f'"category"=\'{category}\'', 'offset': offset, 'length': PAGE,
            })
            page = json.loads(get(f'{ROWS_API}?{query}'))
            need(type(page) is dict and type(page.get('num_rows_total')) is int and type(page.get('rows')) is list,
                 f'{config}/{category}: the datasets server returned no rows')
            need(total is None or page['num_rows_total'] == total, f'{config}/{category}: the row count changed while paging')
            total = page['num_rows_total']
            need(page['rows'] or offset >= total, f'{config}/{category}: an empty page at offset {offset}')
            rows += [item.get('row') if type(item) is dict else None for item in page['rows']]
            offset += PAGE
            pause(0.5)
        need(len(rows) == total, f'{config}/{category}: {len(rows)} rows read, {total} listed')
        (folder / file_name(config, category)).write_text(json.dumps(rows), encoding='utf-8')
    mark_downloaded(folder)


# ---- Validation and matching -----------------------------------------------------------


def check_licence(card):
    need(type(card) is dict and type(card.get('cardData')) is dict, 'the dataset card has no metadata')
    licence = card['cardData'].get('license')
    need(licence == LICENCE, f'the dataset licence is now {licence!r}, not {LICENCE}: stop and report')


def check_row(row, config, category):
    """Raise SourceError when a row does not have the dataset's shape."""
    where = f'{config}/{category}'
    need(type(row) is dict, f'{where}: a row is not an object')
    name = row.get('model_name')
    need(type(name) is str and name.strip() == name and name != '', f'{where}: a row has no model name')
    where = f'{where} {name}'
    need(row.get('category') == category, f'{where}: category {row.get("category")!r}')
    need(is_date(row.get('leaderboard_publish_date')), f'{where}: no publish date')
    need(type(row.get('rank')) is int and row['rank'] >= 1, f'{where}: rank is not a positive whole number')
    fields = AGENT_FIELDS if config == AGENT else ARENA_FIELDS
    for field in fields:
        need(is_number(row.get(field)), f'{where}: {field} is not a number')
    score, lower, upper = (row[field] for field in fields[:3])
    need(lower <= score <= upper, f'{where}: the score is outside its interval')
    for field in fields[3:]:
        need(row[field] >= 0 and row[field] == int(row[field]), f'{where}: {field} is not a whole number')
    if config == AGENT:
        cost = row.get('cost_per_task_p50')
        need(cost is None or is_number(cost) and cost >= 0, f'{where}: cost_per_task_p50 is not a number')


def result(row, config, category, model_id, effort, tool):
    """One kept row in the reviewed file's shape."""
    common = {
        'leaderboard': leaderboard_key(config, category),
        'model': row['model_name'],
        'modelId': model_id,
        'effort': effort,
        'tool': tool,
    }
    if config == AGENT:
        cost = row.get('cost_per_task_p50')
        return {
            **common,
            'score': round(row['score'], 3),
            'lower': round(row['score_ci_lower'], 3),
            'upper': round(row['score_ci_upper'], 3),
            'count': int(row['observation_count']),
            'sessions': int(row['session_count']),
            'costPerTask': None if cost is None else round(cost, 4),
            'rank': row['rank'],
            'date': row['leaderboard_publish_date'],
        }
    return {
        **common,
        'score': round(row['rating']),
        'lower': round(row['rating_lower']),
        'upper': round(row['rating_upper']),
        'count': int(row['vote_count']),
        'rank': row['rank'],
        'date': row['leaderboard_publish_date'],
    }


def convert(folder, aliases):
    """(reviewed file, counts per leaderboard, unmatched names) from a finished download."""
    card = read_json(folder / 'dataset.json')
    check_licence(card)
    leaderboards, results, counts, unmatched = [], [], {}, set()
    for config, category, title, what in LEADERBOARDS:
        key = leaderboard_key(config, category)
        rows = read_json(folder / file_name(config, category))
        need(type(rows) is list and rows, f'{key}: no rows')
        for row in rows:
            check_row(row, config, category)
        dates = {row['leaderboard_publish_date'] for row in rows}
        need(len(dates) == 1, f'{key}: rows from {len(dates)} publish dates in the {SPLIT} split')
        # A name listed more than once on one leaderboard cannot say which row is meant.
        names = collections.Counter(row['model_name'] for row in rows)
        kept = []
        for row in sorted(rows, key=lambda r: (r['rank'], r['model_name'])):
            name = row['model_name']
            found = match(name, aliases)
            need(found is None or names[name] == 1, f'{key}: {name} has an alias but is listed {names[name]} times')
            if found is None:
                unmatched.add(name if names[name] == 1 else f'{name} (listed {names[name]} times on {key})')
            else:
                kept.append(result(row, config, category, *found))
        leaderboards.append({
            'id': f'lmarena-{config}-{category}',
            'leaderboard': key,
            'name': title,
            'what': what,
            'unit': 'IPS score' if config == AGENT else 'Arena rating',
            'scale': 'rating',
            'countOf': 'observations' if config == AGENT else 'votes',
            'url': f'{DATASET_URL}/viewer/{config}/{SPLIT}',
            'publishedAt': dates.pop(),
            'rows': len(rows),
            'kept': len(kept),
        })
        results += kept
        counts[key] = (len(rows), len(kept))
    published = date_range([entry['publishedAt'] for entry in leaderboards])
    return {
        'source': {
            'name': 'Arena leaderboard dataset',
            'dataset': DATASET,
            'split': SPLIT,
            'url': DATASET_URL,
            'licence': 'CC BY 4.0',
            'licenceUrl': 'https://creativecommons.org/licenses/by/4.0/',
            'modifiedAt': card.get('lastModified', ''),
            'attribution': (
                f'Source: Arena leaderboard dataset (huggingface.co/datasets/{DATASET}), '
                f'{SPLIT} split as published {published}. Licensed under CC BY 4.0.'
            ),
        },
        'fetchedAt': downloaded_on(folder),
        'checkedAt': '',
        'leaderboards': leaderboards,
        'results': results,
    }, counts, unmatched


def main(argv=None):
    parser = argparse.ArgumentParser(description='Import LMArena ratings into research/lmarena.json.')
    parser.add_argument('--from', dest='source', type=Path, help='read an earlier download instead of fetching')
    parser.add_argument('--out', type=Path, default=OUT)
    parser.add_argument('--aliases', type=Path, default=ALIASES)
    args = parser.parse_args(argv)
    try:
        aliases = read_aliases(args.aliases, model_ids())
        folder = args.source
        if folder is None:
            folder = new_download_dir('lmarena')
            print(f'Downloading into {folder}')
            download(folder)
        data, counts, unmatched = convert(folder, aliases)
        write_reviewed(args.out, data)
    except (SourceError, OSError, json.JSONDecodeError) as error:
        raise SystemExit(f'LMArena import stopped: {error}') from None
    report(counts, unmatched, args.out)


if __name__ == '__main__':
    sys.exit(main())

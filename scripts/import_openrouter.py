"""Import OpenRouter usage from the OpenRouter Data API into research/openrouter-usage.json.

Usage is not a measured result and orders nothing: it says how much public OpenRouter traffic
each model carries, not how good it is. Two calls to the Data API, which needs the owner's key:
the 30-day daily token rankings (top 50 public models per day and an `other` row) and the
7-day task classifications (each task tag's share of requests and its top models). The key is
read from the OPENROUTER_API_KEY environment variable inside each call and sent only as the
Authorization header to the Data API; it is never written, logged or printed, and a response
that repeats it is not saved. The responses are saved in a new folder under
.local/imports/openrouter/ and treated as untrusted data.

A route is kept only when it, with a ':free' suffix removed, is an exact key in
research/aliases/openrouter.json. Unmatched routes are printed and left out of the token
shares; in a task tag's top list they keep their place with no model id. The output has an
empty `checkedAt` until a person has reviewed it (docs/updating.md).

Usage: python3 -B scripts/import_openrouter.py [--from DOWNLOAD_DIR] [--out FILE] [--aliases FILE]
"""

import argparse
import collections
import datetime
import json
import os
import re
import sys
import time
from pathlib import Path

from import_common import (
    ROOT, SourceError, downloaded_on, fetch, is_date, is_number, mark_downloaded, model_ids, need, new_download_dir,
    read_aliases, read_json, report, write_reviewed,
)

KEY_VARIABLE = 'OPENROUTER_API_KEY'
API = 'https://openrouter.ai/api/v1'
RANKINGS_URL = f'{API}/datasets/rankings-daily'
TASKS_URL = f'{API}/classifications/task?window=7d'
RANKINGS_FILE = 'rankings-daily-30d.json'
TASKS_FILE = 'task-7d.json'
# The Data API allows 30 requests a minute and 500 a day per key; two calls, a few seconds apart.
PAUSE = 3
OUT = ROOT / 'research/openrouter-usage.json'
ALIASES = ROOT / 'research/aliases/openrouter.json'

RANKINGS_DAYS = 30
TASK_DAYS = 7
TOP_DAILY = 50
OTHER = 'other'
FREE = ':free'
SHARE_SUM_SLACK = 0.02
DIGITS = re.compile(r'[0-9]+')
TIMESTAMP = re.compile(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z')
RANKINGS_LABEL = f'rankings-daily ({RANKINGS_DAYS} days)'
TASKS_LABEL = f'classifications/task ({TASK_DAYS} days)'


def attribution(as_of):
    """The citation the Data API asks for, with the licence line for republished data."""
    return f'Source: OpenRouter (openrouter.ai/rankings), as of {as_of}. Licensed under CC BY 4.0.'


def match(route, aliases):
    """The model id for an OpenRouter route, or None. Only a ':free' suffix is taken out."""
    return aliases.get(route.removesuffix(FREE))


# ---- Download ------------------------------------------------------------------------


def authorised_get(url, environ=os.environ, get=fetch):
    """The body at a Data API `url`, sent with the key from the environment and nowhere else."""
    need(url.startswith(API + '/'), f'refusing to send the key outside the Data API: {url}')
    key = environ.get(KEY_VARIABLE, '').strip()
    need(key, f'{KEY_VARIABLE} is not set. Run the command in your own terminal with the key in that variable.')
    body = get(url, headers={'Authorization': f'Bearer {key}'})
    need(key.encode() not in body, f'{url}: the response repeats the key, so it was not saved')
    return body


def download(folder, get=authorised_get, pause=time.sleep):
    """Save the 30-day token rankings and the 7-day task classifications in `folder`."""
    (folder / RANKINGS_FILE).write_bytes(get(RANKINGS_URL))
    pause(PAUSE)
    (folder / TASKS_FILE).write_bytes(get(TASKS_URL))
    mark_downloaded(folder)


# ---- Validation ------------------------------------------------------------------------


def is_share(value):
    return is_number(value) and 0 <= value <= 1


def is_route(value):
    return type(value) is str and value != '' and value.strip() == value


def token_count(value, where):
    """The API gives token counts as strings of digits."""
    need(type(value) is str and DIGITS.fullmatch(value) or type(value) is int and value >= 0, f'{where}: total_tokens is not a count')
    return int(value)


def days_between(start, end):
    first, last = datetime.date.fromisoformat(start), datetime.date.fromisoformat(end)
    return [(first + datetime.timedelta(days=n)).isoformat() for n in range((last - first).days + 1)]


def check_rankings(data):
    """(meta, rows) from a rankings-daily response; raise SourceError when its shape differs."""
    need(type(data) is dict and type(data.get('data')) is list and type(data.get('meta')) is dict,
         'rankings-daily: no data list or meta block')
    meta = data['meta']
    need(type(meta.get('as_of')) is str and TIMESTAMP.fullmatch(meta['as_of']), 'rankings-daily: meta.as_of is not a timestamp')
    need(is_date(meta.get('start_date')) and is_date(meta.get('end_date')), 'rankings-daily: meta has no start and end date')
    days = days_between(meta['start_date'], meta['end_date'])
    need(len(days) == RANKINGS_DAYS, f'rankings-daily: the window is {len(days)} days, not {RANKINGS_DAYS}')
    rows, seen = [], set()
    for row in data['data']:
        need(type(row) is dict, 'rankings-daily: a row is not an object')
        date, route = row.get('date'), row.get('model_permaslug')
        need(is_date(date) and date in days, f'rankings-daily: a row is dated {date!r}, outside the window')
        need(is_route(route), f'rankings-daily {date}: a row has no model_permaslug')
        need((date, route) not in seen, f'rankings-daily {date}: {route} is listed twice')
        seen.add((date, route))
        rows.append((date, route, token_count(row.get('total_tokens'), f'rankings-daily {date} {route}')))
    per_day = collections.Counter(date for date, _route, _tokens in rows)
    others = collections.Counter(date for date, route, _tokens in rows if route == OTHER)
    for day in days:
        need(others[day] == 1, f'rankings-daily {day}: no "{OTHER}" row')
        need(per_day[day] <= TOP_DAILY + 1, f'rankings-daily {day}: {per_day[day]} rows, more than the top {TOP_DAILY} and "{OTHER}"')
    return meta, rows


def check_tasks(data):
    """(meta, classifications) from a classifications/task response; raise SourceError when its shape differs."""
    need(type(data) is dict and type(data.get('data')) is dict, 'classifications/task: no data block')
    block = data['data']
    need(block.get('window_days') == TASK_DAYS, f'classifications/task: window_days is {block.get("window_days")!r}, not {TASK_DAYS}')
    need(is_date(block.get('as_of')), 'classifications/task: as_of is not a date')
    macros = block.get('macro_categories')
    need(type(macros) is list and macros and all(type(m) is dict and is_route(m.get('key')) for m in macros),
         'classifications/task: no macro categories')
    tags = block.get('classifications')
    need(type(tags) is list and tags, 'classifications/task: no classifications')
    seen = set()
    for tag in tags:
        need(type(tag) is dict and is_route(tag.get('tag')), 'classifications/task: a classification has no tag')
        where = f'classifications/task {tag["tag"]}'
        need(tag['tag'] not in seen, f'{where}: listed twice')
        seen.add(tag['tag'])
        need(is_route(tag.get('display_name')), f'{where}: no display_name')
        need(tag.get('macro_category') in {m['key'] for m in macros}, f'{where}: unknown macro_category')
        for field in ('usage_share', 'token_share', 'category_usage_share', 'category_token_share'):
            need(is_share(tag.get(field)), f'{where}: {field} is not a share between 0 and 1')
        models = tag.get('models')
        need(type(models) is list, f'{where}: models is not a list')
        routes = [model.get('id') if type(model) is dict else None for model in models]
        need(all(is_route(route) for route in routes), f'{where}: a top model has no id')
        need(len(set(routes)) == len(routes), f'{where}: a top model is listed twice')
        for model in models:
            for field in ('tag_usage_share', 'tag_token_share'):
                need(is_share(model.get(field)), f'{where} {model["id"]}: {field} is not a share between 0 and 1')
    total = sum(tag['usage_share'] for tag in tags)
    need(abs(total - 1) <= SHARE_SUM_SLACK, f'classifications/task: request shares add up to {total:.3f}, not 1')
    return {'window_days': block['window_days'], 'as_of': block['as_of']}, tags


# ---- Conversion ------------------------------------------------------------------------


def token_block(meta, rows, aliases, unmatched):
    total = sum(tokens for _date, _route, tokens in rows)
    need(total > 0, 'rankings-daily: no tokens')
    tokens, days, routes = collections.Counter(), collections.defaultdict(set), collections.defaultdict(set)
    for date, route, count in rows:
        if route == OTHER:
            continue
        model_id = match(route, aliases)
        if model_id is None:
            unmatched.add(route)
            continue
        tokens[model_id] += count
        days[model_id].add(date)
        routes[model_id].add(route)
    kept = sum(1 for _date, route, _tokens in rows if route != OTHER and match(route, aliases))
    models = [
        {
            'modelId': model_id,
            'routes': sorted(routes[model_id]),
            'tokens': count,
            'share': round(count / total, 4),
            'daysInTop50': len(days[model_id]),
        }
        for model_id, count in sorted(tokens.items(), key=lambda item: (-item[1], item[0]))
    ]
    return {
        'endpoint': RANKINGS_URL,
        'meta': meta,
        'asOf': meta['as_of'],
        'period': {'start': meta['start_date'], 'end': meta['end_date']},
        'attribution': attribution(meta['as_of']),
        'what': ('Tokens (prompt and completion) per model over the period, summed from the daily top 50 public models. '
                 'The share is of all public tokens, the `other` row included.'),
        'totalTokens': total,
        'rows': len(rows),
        'models': models,
    }, kept


def task_block(meta, tags, aliases, unmatched):
    end = datetime.date.fromisoformat(meta['as_of'])
    out, kept = [], 0
    for tag in tags:
        top = []
        for model in tag['models']:
            model_id = match(model['id'], aliases)
            if model_id is None:
                unmatched.add(model['id'])
            else:
                kept += 1
            top.append({
                'route': model['id'],
                'modelId': model_id or '',
                'share': model['tag_usage_share'],
                'tokenShare': model['tag_token_share'],
            })
        out.append({
            'tag': tag['tag'],
            'label': tag['display_name'],
            'macroCategory': tag['macro_category'],
            'share': tag['usage_share'],
            'tokenShare': tag['token_share'],
            'top': top,
        })
    return {
        'endpoint': TASKS_URL,
        'meta': meta,
        'asOf': meta['as_of'],
        'period': {'start': (end - datetime.timedelta(days=TASK_DAYS - 1)).isoformat(), 'end': meta['as_of']},
        'attribution': attribution(meta['as_of']),
        'what': ("Each task tag's share of classified requests over the trailing 7 days, and its top models by share "
                 "of that tag's requests. Sampled; no absolute volumes. A route with no model id is not in the model list."),
        'tags': out,
    }, kept


def convert(folder, aliases):
    """(reviewed file, counts per endpoint, unmatched routes) from a finished download."""
    rankings_meta, rows = check_rankings(read_json(folder / RANKINGS_FILE))
    tasks_meta, tags = check_tasks(read_json(folder / TASKS_FILE))
    unmatched = set()
    tokens, tokens_kept = token_block(rankings_meta, rows, aliases, unmatched)
    tasks, tasks_kept = task_block(tasks_meta, tags, aliases, unmatched)
    counts = {
        RANKINGS_LABEL: (sum(1 for _date, route, _tokens in rows if route != OTHER), tokens_kept),
        TASKS_LABEL: (sum(len(tag['top']) for tag in tasks['tags']), tasks_kept),
    }
    return {
        'source': {
            'name': 'OpenRouter Data API',
            'url': 'https://openrouter.ai/rankings',
            'licence': 'CC BY 4.0',
            'licenceUrl': 'https://creativecommons.org/licenses/by/4.0/',
            'terms': ('Aggregated public data. Not to be re-served as a competing free API. Figures may be restated as '
                      'snapshots refresh, so each block keeps the meta block it was published with.'),
            'attribution': attribution(rankings_meta['as_of']),
        },
        'fetchedAt': downloaded_on(folder),
        'checkedAt': '',
        'tokens30d': tokens,
        'tasks7d': tasks,
    }, counts, unmatched


def main(argv=None):
    parser = argparse.ArgumentParser(description='Import OpenRouter usage into research/openrouter-usage.json.')
    parser.add_argument('--from', dest='source', type=Path, help='read an earlier download instead of fetching')
    parser.add_argument('--out', type=Path, default=OUT)
    parser.add_argument('--aliases', type=Path, default=ALIASES)
    args = parser.parse_args(argv)
    try:
        aliases = read_aliases(args.aliases, model_ids())
        folder = args.source
        if folder is None:
            need(os.environ.get(KEY_VARIABLE, '').strip(),
                 f'{KEY_VARIABLE} is not set. Run the command in your own terminal with the key in that variable.')
            folder = new_download_dir('openrouter')
            print(f'Downloading into {folder}')
            download(folder)
        data, counts, unmatched = convert(folder, aliases)
        write_reviewed(args.out, data)
    except (SourceError, OSError, json.JSONDecodeError) as error:
        raise SystemExit(f'OpenRouter import stopped: {error}') from None
    report(counts, unmatched, args.out)


if __name__ == '__main__':
    sys.exit(main())

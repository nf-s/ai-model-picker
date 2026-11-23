"""Steps shared by the importers (scripts/import_lmarena.py, scripts/import_epoch.py, scripts/import_openrouter.py).

An importer downloads its source into a new, empty folder under .local/imports/,
validates what it reads, keeps the results whose model name has an exact entry in its alias
table under research/aliases/, and writes one reviewed file under research/. It never adds a
model and never writes src/lib/snapshot.json: an alias must name a model id that the snapshot
already lists.
"""

import datetime
import json
import math
import re
import time
from http.client import HTTPException
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
SNAPSHOT = ROOT / 'src/lib/snapshot.json'
DOWNLOADS = ROOT / '.local/imports'
USER_AGENT = 'model-reference-import/1'
ATTEMPTS = 4
RETRY_STATUS = {429, 500, 502, 503, 504}
ALIAS_FIELDS = {'version', 'rule', 'aliases'}
DATE_PATTERN = re.compile(r'[0-9]{4}-[0-9]{2}-[0-9]{2}')


class SourceError(ValueError):
    """A download, an alias table or a source row does not have the expected shape."""


def need(condition, message):
    if not condition:
        raise SourceError(message)


def is_number(value):
    return type(value) in (int, float) and math.isfinite(value)


def is_date(value):
    if type(value) is not str or not DATE_PATTERN.fullmatch(value):
        return False
    try:
        datetime.date.fromisoformat(value)
    except ValueError:
        return False
    return True


def fetch(url, *, headers=None, timeout=90, wait=10, sleep=time.sleep):
    """The body at `url`. Retries rate limits, server errors and dropped connections.

    `headers` are sent to `url` only, never on to a redirect, and never appear in an error."""
    for attempt in range(1, ATTEMPTS + 1):
        request = Request(url, headers={'User-Agent': USER_AGENT})
        for name, value in (headers or {}).items():
            request.add_unredirected_header(name, value)
        try:
            with urlopen(request, timeout=timeout) as response:
                return response.read()
        except HTTPError as error:
            if error.code not in RETRY_STATUS or attempt == ATTEMPTS:
                raise SourceError(f'{url}: HTTP {error.code}') from None
        except (URLError, TimeoutError, ConnectionError, HTTPException) as error:
            if attempt == ATTEMPTS:
                raise SourceError(f'{url}: {error}') from None
        sleep(wait * attempt)
    raise SourceError(f'{url}: no response')


def new_download_dir(source, root=DOWNLOADS):
    """A new, empty folder for one download, named by the UTC time."""
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    path = Path(root) / source / stamp
    path.mkdir(parents=True, exist_ok=False)
    return path


def mark_downloaded(folder):
    """Record, beside a finished download, when it was fetched."""
    stamp = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')
    (Path(folder) / 'download.json').write_text(json.dumps({'fetchedAt': stamp}) + '\n', encoding='utf-8')


def downloaded_on(folder):
    """The UTC date a download in `folder` finished, from mark_downloaded."""
    path = Path(folder) / 'download.json'
    need(path.is_file(), f'{folder} holds no finished download')
    stamp = read_json(path).get('fetchedAt')
    need(type(stamp) is str and is_date(stamp[:10]), f'{path}: no fetchedAt date')
    return stamp[:10]


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def model_ids(snapshot_path=SNAPSHOT):
    return {model['id'] for model in read_json(snapshot_path)['models']}


def read_aliases(path, known):
    """{source name: model id} from an alias table; every id must already be in `known`."""
    data = read_json(path)
    need(type(data) is dict and set(data) == ALIAS_FIELDS, f'{path}: fields differ from {sorted(ALIAS_FIELDS)}')
    need(type(data['version']) is int and type(data['rule']) is str and data['rule'], f'{path}: no version or rule')
    aliases = data['aliases']
    need(type(aliases) is dict, f'{path}: aliases is not an object')
    for name, model_id in aliases.items():
        need(name.strip() == name and name != '', f'{path}: alias {name!r} is empty or padded')
        need(type(model_id) is str and model_id in known, f'{path}: {name} names {model_id}, which is not in the snapshot')
    return aliases


def write_reviewed(path, value):
    """Write a reviewed file with two-space indents, as `npm run format` leaves it."""
    path = Path(path)
    need('.local' not in path.resolve().parts, f'refusing to write under .local: {path}')
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    try:
        temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def long_date(day):
    """'2026-11-09' -> '9 November 2026'."""
    value = datetime.date.fromisoformat(day)
    return f'{value.day} {value:%B %Y}'


def date_range(days):
    """The span of ISO dates in words: '22 November 2026', '9–22 November 2026' or '28 October–2 November 2026'."""
    first, last = datetime.date.fromisoformat(min(days)), datetime.date.fromisoformat(max(days))
    if first == last:
        return long_date(first.isoformat())
    if (first.year, first.month) == (last.year, last.month):
        return f'{first.day}–{last.day} {last:%B %Y}'
    if first.year == last.year:
        return f'{first.day} {first:%B}–{last.day} {last:%B %Y}'
    return f'{long_date(first.isoformat())}–{long_date(last.isoformat())}'


def report(counts, unmatched, out):
    """Print kept results per leaderboard or file, then the names that matched no alias."""
    width = max(len(name) for name in counts)
    print(f'{"":{width}} {"rows":>6} {"kept":>6}')
    for name, (rows, kept) in counts.items():
        print(f'{name:{width}} {rows:>6,} {kept:>6,}')
    print(f'Wrote {out}: {sum(kept for _rows, kept in counts.values()):,} results.')
    print(f'{len(unmatched):,} names matched no alias and were left out:')
    for name in sorted(unmatched, key=str.casefold):
        print(f'  {name}')

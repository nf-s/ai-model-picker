"""Discover public HN comment IDs or verify the reviewed sentiment snapshot."""

import argparse
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, time, timedelta, timezone
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen

SNAPSHOT = Path(__file__).resolve().parents[1] / 'research' / 'hn-sentiment.json'
SEARCH_URL = 'https://hn.algolia.com/api/v1/search'
ITEM_URL = 'https://hacker-news.firebaseio.com/v0/item/{}.json'
PERMALINK = 'https://news.ycombinator.com/item?id={}'
HITS_PER_QUERY = 20


def fetch_json(url):
    with urlopen(url, timeout=20) as response:
        return json.load(response)


def timestamp(day):
    return int(datetime.combine(day, time.min, timezone.utc).timestamp())


def iso_time(seconds):
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat().replace('+00:00', 'Z')


def search(query, start, end):
    params = {
        'query': query,
        'tags': 'comment',
        'numericFilters': f'created_at_i>={start},created_at_i<{end}',
        'restrictSearchableAttributes': 'comment_text',
        'attributesToRetrieve': 'objectID,story_id,created_at_i',
        'attributesToHighlight': '[]',
        'hitsPerPage': HITS_PER_QUERY,
        'page': 0,
    }
    result = fetch_json(f'{SEARCH_URL}?{urlencode(params)}')
    if not isinstance(result, dict) or type(result.get('nbHits')) is not int:
        raise ValueError('Invalid Algolia search result')
    hits = result.get('hits')
    if not isinstance(hits, list):
        raise ValueError('Invalid Algolia hit list')
    candidates = []
    for hit in hits:
        if not isinstance(hit, dict):
            raise ValueError('Invalid Algolia hit')
        item_id = hit.get('objectID')
        story_id = hit.get('story_id')
        created = hit.get('created_at_i')
        if not (
            isinstance(item_id, str)
            and item_id.isascii()
            and item_id.isdecimal()
            and int(item_id) > 0
            and type(story_id) is int
            and story_id > 0
            and type(created) is int
            and start <= created < end
        ):
            raise ValueError('Invalid Algolia item identifier, story identifier or timestamp')
        candidates.append({'id': int(item_id), 'storyId': story_id, 'createdAt': iso_time(created)})
    return result['nbHits'], candidates


def discover(snapshot, start_date, end_date):
    start = timestamp(start_date)
    end = timestamp(end_date + timedelta(days=1))
    queries = []
    candidate_ids = set()
    for entry in snapshot['coverage']:
        for query in entry['queries']:
            matched, candidates = search(query, start, end)
            candidate_ids.update(candidate['id'] for candidate in candidates)
            queries.append({
                'modelId': entry['modelId'],
                'query': query,
                'matchedCommentCount': matched,
                'candidates': candidates,
            })
    return {
        'windowStart': start_date.isoformat(),
        'windowEnd': end_date.isoformat(),
        'queryCount': len(queries),
        'retrievedCandidateCount': len(candidate_ids),
        'queries': queries,
    }


@lru_cache(maxsize=1024)
def item_metadata(item_id):
    data = fetch_json(ITEM_URL.format(item_id))
    if not isinstance(data, dict) or data.get('id') != item_id:
        raise ValueError(f'Item {item_id} missing or invalid')
    if data.get('dead') or data.get('deleted'):
        raise ValueError(f'Item {item_id} is dead or deleted')
    body = data.get('text')
    has_body = isinstance(body, str) and bool(body.strip())
    return data.get('type'), data.get('time'), data.get('parent'), has_body


def verify_comment(comment):
    item_id = comment['id']
    try:
        kind, created, parent, has_body = item_metadata(item_id)
        if kind != 'comment' or not has_body:
            raise ValueError('Item is not a live comment with a body')
        if type(created) is not int or iso_time(created) != comment['createdAt']:
            raise ValueError('Official timestamp differs from the snapshot')
        visited = {item_id}
        while True:
            if type(parent) is not int or parent <= 0 or parent in visited:
                raise ValueError('Invalid or circular parent chain')
            visited.add(parent)
            kind, _, ancestor, _ = item_metadata(parent)
            if kind in ('story', 'poll'):
                break
            if kind != 'comment':
                raise ValueError(f'Parent {parent} is not a story, poll or comment')
            parent = ancestor
        if parent != comment['storyId']:
            raise ValueError(f'Official discussion ID is {parent}')
        if (
            comment['url'] != PERMALINK.format(item_id)
            or comment['storyUrl'] != PERMALINK.format(parent)
        ):
            raise ValueError('Permalink differs from the official item ID')
    except json.JSONDecodeError:
        return item_id, 'Official API returned invalid JSON'
    except (OSError, ValueError) as error:
        return item_id, str(error)
    return item_id, None


def verify(snapshot):
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(verify_comment, snapshot['comments']))
    failures = [{'id': item_id, 'reason': reason} for item_id, reason in results if reason is not None]
    return {'verifiedCommentCount': len(results) - len(failures), 'failures': failures}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    discovery = commands.add_parser('discover', help='Fetch relevance-ranked candidate metadata')
    discovery.add_argument('--start', type=date.fromisoformat, help='First UTC date (YYYY-MM-DD)')
    discovery.add_argument('--end', type=date.fromisoformat, help='Last UTC date (YYYY-MM-DD)')
    commands.add_parser('verify', help='Verify selected comments against the official API')
    args = parser.parse_args()

    snapshot = json.loads(SNAPSHOT.read_text(encoding='utf-8'))
    try:
        if args.command == 'verify':
            report = verify(snapshot)
            print(json.dumps(report, indent=2))
            return int(bool(report['failures']))
        start = args.start or date.fromisoformat(snapshot['windowStart'])
        end = args.end or date.fromisoformat(snapshot['windowEnd'])
        if start > end:
            parser.error('start date must be on or before the end date')
        print(json.dumps(discover(snapshot, start, end), indent=2))
    except json.JSONDecodeError:
        print('Public API returned invalid JSON', file=sys.stderr)
        return 1
    except (OSError, ValueError) as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())

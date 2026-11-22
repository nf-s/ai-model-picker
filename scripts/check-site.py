"""Check the site build in dist/ before it is uploaded. Prints counts, never the text that matched."""

import json
from datetime import date
from pathlib import Path
import re
from urllib.parse import urlsplit

from hn_local.classify import PII

ROOT = Path(__file__).resolve().parent.parent
# Cloudflare Pages accepts at most 25 MiB for one file.
FILE_BYTES = 25 * 1024 * 1024
MUST_BE_ZERO = ('mixedReleases', 'oversizeFiles', 'personalDetails', 'restrictedIdentifiers',
                'expertArticleLeaks', 'localPaths')


def load(path):
    return json.loads(path.read_text(encoding='utf-8'))


def identifiers(value, found):
    """Every string stored under an `id` key, at any depth."""
    if isinstance(value, dict):
        for key, item in value.items():
            if key == 'id' and isinstance(item, str):
                found.add(item)
            identifiers(item, found)
    elif isinstance(value, list):
        for item in value:
            identifiers(item, found)
    return found


def expert_article_urls(catalog):
    data = load(catalog)
    if not isinstance(data, dict) or data.keys() != {'articles'} or not isinstance(data['articles'], list):
        raise ValueError('Invalid expert article catalog.')
    urls = set()
    for article in data['articles']:
        if (not isinstance(article, dict) or article.keys() != {'title', 'date', 'url'}
                or any(not isinstance(value, str) or not value.strip() for value in article.values())):
            raise ValueError('Invalid expert article metadata.')
        url = urlsplit(article['url'])
        if date.fromisoformat(article['date']).isoformat() != article['date']:
            raise ValueError('Invalid expert article date.')
        if (url.scheme != 'https' or not url.hostname or url.username or url.password
                or url.query or url.fragment or article['url'] in urls):
            raise ValueError('Invalid expert article link.')
        urls.add(article['url'])
    if not urls:
        raise ValueError('The expert article catalog is empty.')
    return urls


def site_report(dist, restricted, public, local_paths, expert_catalog, file_bytes=FILE_BYTES):
    """Totals for the build, and the counts in MUST_BE_ZERO, which block an upload when above zero."""
    snapshot = load(dist / 'hn-snapshot.json')
    parts = [load(dist / f'hn-comments-{number}.json') for number in range(1, snapshot['commentParts'] + 1)]
    # The only free text in the comment files: claims written by the model and story titles.
    texts = [comment['claim'] for part in parts for comment in part['comments'] if 'claim' in comment]
    texts += [story['title'] for part in parts for story in part.get('stories', ())]
    files = [path for path in dist.rglob('*') if path.is_file()]
    bundle = ''.join(path.read_text(encoding='utf-8', errors='ignore') for path in files)
    restricted_only = identifiers(load(restricted), set()) - identifiers(load(public), set())
    article_urls = expert_article_urls(expert_catalog)
    article_links = re.compile('|'.join(map(re.escape, sorted(article_urls, key=len, reverse=True))))
    return {
        'commentFiles': len(parts),
        'comments': sum(len(part['comments']) for part in parts),
        'claimsAndTitles': len(texts),
        'restrictedOnlyIdentifiers': len(restricted_only),
        'mixedReleases': len({snapshot['publishedAt'], *(part['publishedAt'] for part in parts)}) - 1,
        'oversizeFiles': sum(path.stat().st_size > file_bytes for path in files),
        'personalDetails': sum(bool(PII.search(text)) for text in texts),
        'restrictedIdentifiers': sum(identifier in bundle for identifier in restricted_only),
        'expertArticleLeaks': len(set(article_links.findall(bundle))) + sum(
            path.name == expert_catalog.name for path in files
        ),
        'localPaths': sum(str(path) in bundle for path in local_paths),
    }


if __name__ == '__main__':
    try:
        report = site_report(
            ROOT / 'dist', ROOT / '.local/restricted/payload.json', ROOT / 'src/lib/snapshot.json',
            (ROOT, Path.home()), ROOT / '.local/expert-articles/catalog.json',
        )
    except (OSError, KeyError, TypeError, ValueError):
        raise SystemExit('Could not check the site build and private payloads. See docs/updating.md.') from None
    for name, count in report.items():
        print(f'{name}: {count:,}')
    failed = [name for name in MUST_BE_ZERO if report[name]]
    if failed:
        raise SystemExit(f'Do not upload. These must be 0: {", ".join(failed)}.')
    print('The site build passed the checks.')

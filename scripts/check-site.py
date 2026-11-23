"""Check the site build in dist/ before it is uploaded. Prints counts, never the text that matched."""

import json
from datetime import date
from pathlib import Path
import re
from urllib.parse import urlsplit

from hn_local.classify import PII

ROOT = Path(__file__).resolve().parent.parent
# Cloudflare Pages accepts at most 25 MiB for one file and 20,000 files on the Free plan.
FILE_BYTES = 25 * 1024 * 1024
SITE_FILES = 20_000
# A search for the index's commonest word reads the manifest, that word's shard, every fact file and
# a page of record files in each public band (src/lib/search.ts: searchLimits.page, 10). It must stay
# under this many bytes before compression.
SEARCH_WORD_BYTES = 4 * 1024 * 1024
SEARCH_PAGE = 10
MUST_BE_ZERO = ('mixedReleases', 'oversizeFiles', 'tooManyFiles', 'personalDetails', 'restrictedIdentifiers',
                'expertArticleLeaks', 'localPaths', 'namedRecords', 'namedFiles', 'personNames',
                'restrictedNames', 'arxivExport', 'searchIndexMissing', 'searchMixedReleases', 'searchOverBudget')
# Practitioners' use records and method advice stay behind sign-in: their ids, and the file
# the records build writes them to, must not reach a static build.
NAMED_ID = re.compile(r'\b(?:ur|ma):[0-9a-f]{24}/\d+')
NAMED_FILE = 'named-private.json'
# Hacker News comment files hold public story titles and claims, which may name anyone. The search
# index's record files hold the same claims and titles on its Hacker News records.
COMMENT_FILE = re.compile(r'hn-comments-\d+\.json')
# arXiv papers left the app; their old export must not be uploaded again.
ARXIV_FILE = 'arxiv-snapshot.json'


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


def named_records(value):
    """Records at any depth that are named, carry a named id or keep a quote."""
    if isinstance(value, list):
        return sum(named_records(item) for item in value)
    if not isinstance(value, dict):
        return 0
    own = int(
        value.get('cls') == 'named'
        or (isinstance(value.get('id'), str) and NAMED_ID.fullmatch(value['id']) is not None)
        or (isinstance(value.get('quote'), str) and value['quote'] != '')
    )
    return own + sum(named_records(item) for item in value.values())


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


def person_names(people_file):
    """The names in the people file; a static build must name none of them."""
    data = load(people_file)
    if not isinstance(data, dict) or not isinstance(data.get('people'), list):
        raise ValueError('Invalid people file.')
    names = [person.get('name') if isinstance(person, dict) else None for person in data['people']]
    if not names or any(not isinstance(name, str) or not name.strip() for name in names):
        raise ValueError('Invalid people file.')
    return names


def restricted_names(research_file):
    """The names and short names of the benchmarks that cannot be republished. They are matched as
    whole words, ignoring case, and never printed."""
    data = load(research_file)
    if not isinstance(data, dict) or not isinstance(data.get('benchmarks'), list) or not data['benchmarks']:
        raise ValueError('Invalid restricted research file.')
    names = set()
    for benchmark in data['benchmarks']:
        if not isinstance(benchmark, dict) or not isinstance(benchmark.get('name'), str) or not benchmark['name'].strip():
            raise ValueError('Invalid restricted research file.')
        names.add(benchmark['name'].strip())
        short = benchmark.get('shortName')
        if isinstance(short, str) and short.strip():
            names.add(short.strip())
    return sorted(names)


def word(name):
    return re.compile(r'(?<![\w-])' + re.escape(name) + r'(?![\w-])', re.IGNORECASE)


def without_hn_text(path):
    """A search record file's text with the claims and story titles of its Hacker News records left out."""
    data = load(path)
    for record in data['records']:
        if record.get('src') == 'hn':
            record.pop('text', None)
            record.pop('title', None)
    return json.dumps(data, ensure_ascii=False)


def search_report(search, word_bytes):
    """The search index's files, its largest file and what a search for its commonest word reads."""
    if not (search / 'index.json').is_file():
        return {'searchFiles': 0, 'searchBytes': 0, 'searchLargestFile': 0, 'searchWordBytes': 0,
                'searchIndexMissing': 1, 'searchMixedReleases': 0, 'searchOverBudget': 0}
    files = [path for path in search.rglob('*') if path.is_file()]
    manifest = load(search / 'index.json')
    parts = [path for path in files if path.parent != search]
    shards = [(len(gaps), path) for path in (search / 't').glob('*.json') for gaps in load(path)['terms'].values()]
    commonest = max(shards, key=lambda item: item[0])[1] if shards else None
    records = sorted(path.stat().st_size for path in (search / 'r').glob('*.json'))
    read = (
        (search / 'index.json').stat().st_size
        + (commonest.stat().st_size if commonest else 0)
        + sum(path.stat().st_size for path in (search / 'a').glob('*.json'))
        + sum(records[-2 * SEARCH_PAGE:])
    )
    return {
        'searchRecords': manifest['records'],
        'searchFiles': len(files),
        'searchBytes': sum(path.stat().st_size for path in files),
        'searchLargestFile': max((path.stat().st_size for path in files), default=0),
        'searchWordBytes': read,
        'searchIndexMissing': 0,
        'searchMixedReleases': sum(load(path).get('release') != manifest.get('builtAt') for path in parts),
        'searchOverBudget': int(read > word_bytes),
    }


def site_report(dist, restricted, public, local_paths, expert_catalog, people_file, restricted_research,
                file_bytes=FILE_BYTES, site_files=SITE_FILES, word_bytes=SEARCH_WORD_BYTES):
    """Totals for the build, and the counts in MUST_BE_ZERO, which block an upload when above zero."""
    snapshot = load(dist / 'hn-snapshot.json')
    core = load(dist / 'core.json')
    parts = [load(dist / f'hn-comments-{number}.json') for number in range(1, snapshot['commentParts'] + 1)]
    # The only free text in the comment files: claims written by the model and story titles.
    texts = [comment['claim'] for part in parts for comment in part['comments'] if 'claim' in comment]
    texts += [story['title'] for part in parts for story in part.get('stories', ())]
    files = [path for path in dist.rglob('*') if path.is_file()]
    bundle = ''.join(path.read_text(encoding='utf-8', errors='ignore') for path in files)
    restricted_only = identifiers(load(restricted), set()) - identifiers(load(public), set())
    json_files = [load(path) for path in files if path.suffix == '.json']
    article_urls = expert_article_urls(expert_catalog)
    article_links = re.compile('|'.join(map(re.escape, sorted(article_urls, key=len, reverse=True))))
    # Named records stay behind sign-in, so no person's name belongs in a static file, and no restricted
    # benchmark is named in one. Public story titles and claims may name either.
    search_records = dist / 'search' / 'r'
    outside_comments = ''.join(
        without_hn_text(path) if path.parent == search_records else path.read_text(encoding='utf-8', errors='ignore')
        for path in files if not COMMENT_FILE.fullmatch(path.name)
    )
    return {
        'commentFiles': len(parts),
        'comments': sum(len(part['comments']) for part in parts),
        'claimsAndTitles': len(texts),
        'measuredRecords': len(core['measured']),
        'restrictedOnlyIdentifiers': len(restricted_only),
        'mixedReleases': len({snapshot['publishedAt'], *(part['publishedAt'] for part in parts)}) - 1,
        'siteFiles': len(files),
        'oversizeFiles': sum(path.stat().st_size > file_bytes for path in files),
        'tooManyFiles': int(len(files) > site_files),
        'personalDetails': sum(bool(PII.search(text)) for text in texts),
        'restrictedIdentifiers': sum(identifier in bundle for identifier in restricted_only),
        'expertArticleLeaks': len(set(article_links.findall(bundle))) + sum(
            path.name == expert_catalog.name for path in files
        ),
        'localPaths': sum(str(path) in bundle for path in local_paths),
        'namedRecords': sum(named_records(data) for data in json_files) + sum(
            len(NAMED_ID.findall(path.read_text(encoding='utf-8', errors='ignore')))
            for path in files if path.suffix != '.json'
        ),
        'namedFiles': sum(path.name == NAMED_FILE for path in files),
        'personNames': sum(name in outside_comments for name in person_names(people_file)),
        'restrictedNames': sum(
            len(word(name).findall(outside_comments)) for name in restricted_names(restricted_research)
        ),
        'arxivExport': sum(path.name == ARXIV_FILE for path in files),
        **search_report(dist / 'search', word_bytes),
    }


if __name__ == '__main__':
    try:
        report = site_report(
            ROOT / 'dist', ROOT / '.local/restricted/payload.json', ROOT / 'src/lib/snapshot.json',
            (ROOT, Path.home()), ROOT / '.local/expert-articles/catalog.json',
            ROOT / '.local/people/people.json', ROOT / '.local/restricted/research.json',
        )
    except (OSError, KeyError, TypeError, ValueError):
        raise SystemExit('Could not check the site build and private payloads. See docs/updating.md.') from None
    for name, count in report.items():
        print(f'{name}: {count:,}')
    failed = [name for name in MUST_BE_ZERO if report[name]]
    if failed:
        raise SystemExit(f'Do not upload. These must be 0: {", ".join(failed)}.')
    print('The site build passed the checks.')

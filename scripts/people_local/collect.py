"""Finding each person's items through their feeds, sitemaps and series pages, and keeping those
whose date and byline the item's own page confirms."""

import re
import xml.etree.ElementTree as ET
from collections import Counter
from hashlib import sha256

from .pages import PAYWALL, RELEVANT, clean_url, links_on, parse_feed, read_page, scrub, sitemap_entries

FEED_TYPES = 'application/rss+xml, application/atom+xml'
MIN_BODY = 200


def url_key(url):
    return clean_url(url).rstrip('/')


def sitemap_urls(fetcher, entry, since, depth=0):
    """Page links of a sitemap (following nested sitemaps two levels) that match `include` and were
    not last modified before `since`; and a note of what was read."""
    status, data, _ = fetcher.fetch(entry['url'] if depth == 0 else entry['nested'], 'application/xml')
    where = entry['url'] if depth == 0 else entry['nested']
    if status != 200:
        return [], [f'{where}: {status}']
    try:
        rows = sitemap_entries(data)
    except ET.ParseError:
        return [], [f'{where}: not a sitemap']
    found, notes = [], []
    for kind, loc, modified in rows:
        if kind == 'index':
            if depth < 2 and re.search(entry.get('index', ''), loc):
                more, more_notes = sitemap_urls(fetcher, entry | {'nested': loc}, since, depth + 1)
                found += more
                notes += more_notes
        elif re.search(entry['include'], loc) and (not modified or modified >= since):
            found.append(loc)
    notes.append(f'{where}: {len(found)} candidate links')
    return found, notes


def feed_rows(fetcher, url):
    status, data, _ = fetcher.fetch(url, FEED_TYPES)
    if status != 200:
        return [], [f'{url}: {status}']
    try:
        rows = parse_feed(data)
    except ET.ParseError:
        return [], [f'{url}: not a feed']
    return rows, [f'{url}: {len(rows)} entries']


def discover(config, fetcher, since, names=None):
    """Candidate items of every person still collected: (jobs, notes). A job is one link to read."""
    jobs, notes = {}, []

    def add(person, entry, url, via, feed=None):
        url = clean_url(url)
        if url and url_key(url) not in jobs:
            jobs[url_key(url)] = {'person': person, 'channel': entry['channel'], 'url': url, 'via': via, 'feed': feed}

    for person in config.people:
        if person.dropped or (names and person.name not in names):
            continue
        for entry in person.discover:
            kind = entry['kind']
            if kind == 'feed':
                rows, more = feed_rows(fetcher, entry['url'])
                notes += more
                for row in rows:
                    if 'author' not in entry or any(entry['author'] in author for author in row['authors']):
                        add(person, entry, row['url'], 'feed', row)
            elif kind == 'sitemap':
                urls, more = sitemap_urls(fetcher, entry, since)
                notes += more
                for url in urls:
                    add(person, entry, url, 'sitemap')
            elif kind == 'series':
                status, data, final = fetcher.fetch(entry['url'])
                links = [link for link in links_on(data, final) if re.search(entry['include'], link)
                         and url_key(link) != url_key(entry['url'])] if status == 200 else []
                notes.append(f'{entry["url"]}: {status}, {len(links)} links')
                for link in links:
                    add(person, entry, link, 'series page')
            else:
                add(person, entry, entry['url'], 'listed page')
    return list(jobs.values()), notes


def byline_ok(person, authors, whole):
    if any(word in author for word in person.byline for author in authors):
        return True
    return person.byline_in_page and any(word in whole[:4000] for word in person.byline)


def gather(job, fetcher, since, until):
    """(item, None) for a kept item, or (None, exclusion) with the reason it was not kept."""
    person = job['person']
    feed = job['feed'] or {}
    excluded = {'person': person.key, 'url': job['url']}
    status, data, final = fetcher.fetch(job['url'])
    if status == 200:
        page = read_page(data, final, person.page_byline)
    elif feed.get('body'):
        page = {'body': '', 'title': feed['title'], 'date': '', 'authors': [], 'paywalled': False, 'whole': '', 'links': []}
    else:
        return None, excluded | {'reason': f'page status {status}'}
    authors = page['authors'] or feed.get('authors', [])
    when = page['date'] or feed.get('date', '')
    if not when:
        return None, excluded | {'reason': 'date unverified'}
    if not since <= when <= until:
        return None, excluded | {'reason': 'outside window', 'date': when}
    if not byline_ok(person, authors, page['whole']):
        return None, excluded | {'reason': 'byline unverified', 'authors': authors[:4]}
    body, fidelity = page['body'], 'public page'
    if feed.get('fidelity') == 'feed content' and len(feed.get('body', '')) > len(body):
        body, fidelity = feed['body'], 'feed content'
    if len(body) < MIN_BODY:
        return None, excluded | {'reason': 'body unavailable'}
    paywalled = page['paywalled'] or bool(PAYWALL.search(page['whole']))
    url = clean_url(final if status == 200 else job['url']) or job['url']
    title = scrub(page['title'] or feed.get('title', ''))
    return {
        'person': person.key, 'channel': job['channel'], 'url': url, 'date': when, 'title': title,
        'bylines': authors[:6], 'role': 'author prose', 'source_class': person.source_class,
        'discovered_from': [job['via']], 'body': body,
        'fidelity': fidelity + (', public part of a paid post' if paywalled else ''),
        'links': page['links'][:200], 'possibly_relevant': bool(RELEVANT.search(title + ' ' + body)),
        'id': sha256((person.key + '\n' + url).encode()).hexdigest()[:24],
    }, None


def known(collected, exclusions, since):
    """Link keys that a collection skips: items already kept, items by someone else, and items dated
    before `since`. Other exclusions (a failed request, no date, no text) are tried again."""
    keys = {url_key(item['url']) for item in collected.values()}
    keys |= {url_key(item['requested_url']) for item in collected.values() if item.get('requested_url')}
    for row in exclusions:
        if row.get('reason') == 'byline unverified' or (row.get('reason') == 'outside window' and row.get('date', '') < since):
            keys.add(url_key(row['url']))
    return keys


def summary(since, until, discovered, kept, excluded, collected, notes):
    return {
        'window': [since, until],
        'discovered': discovered,
        'new_items': len(kept),
        'new_by_person': dict(Counter(item['person'] for item in kept)),
        'new_paid_post_public_parts': sum('paid' in item['fidelity'] for item in kept),
        'new_characters': sum(len(item['body']) for item in kept),
        'exclusions': dict(Counter(row['reason'] for row in excluded)),
        'excluded_by_person': dict(Counter(row['person'] for row in excluded)),
        'items': len(collected),
        'discovery_notes': notes,
    }

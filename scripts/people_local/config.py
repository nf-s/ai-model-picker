"""The two local files that say whom to collect and how: people.json and sources.json.

people.json is the people file of scripts/records_schema.py: each person's name, feeds, source
class, advice-only flag, trusted default and the date and reason they were added or dropped.
sources.json says how to read each person's feeds and which names to remove from their text:

  {"version": 1, "people": [{
      "name": the name in people.json,
      "key": the short key stored on each collected item, lower-case letters, digits and hyphens,
      "byline": words, any of which in a page's author names confirms the byline,
      "bylineInPage": also accept a byline word in the first 4,000 characters of the page,
      "pageByline": also read authors from elements of class "author", and a date shown in the text,
      "bylineNames": remove the names in each item's byline from its text, not the person's name,
      "redact": names and handles removed from every passage, whoever wrote it,
      "discover": [{"kind": "feed" | "sitemap" | "series" | "page", "url": one of the person's feeds,
                    "channel": the kind of writing found there ("site", "newsletter", "outlet article"),
                    "include": a pattern a found link must match (sitemap and series),
                    "index": a pattern a nested sitemap must match (sitemap),
                    "author": a word a feed entry's author must contain (feed)}]}]}

Both files stay on this machine. No name in them is written into tracked files.
"""

import json
import re
from dataclasses import dataclass
from pathlib import Path

from hn_local.sources import PipelineError
from records_schema import JOB_PATTERN, RecordError, check_people, is_text

PEOPLE_FILE = 'people.json'
SOURCES_FILE = 'sources.json'
RULE_FIELDS = {'name', 'key', 'byline', 'bylineInPage', 'pageByline', 'bylineNames', 'redact', 'discover'}
DISCOVER_FIELDS = {
    'feed': ({'kind', 'url', 'channel'}, {'author'}),
    'sitemap': ({'kind', 'url', 'channel', 'include'}, {'index'}),
    'series': ({'kind', 'url', 'channel', 'include'}, set()),
    'page': ({'kind', 'url', 'channel'}, set()),
}
NEVER = re.compile(r'(?!x)x')


@dataclass(frozen=True)
class Person:
    name: str
    key: str
    source_class: str
    advice_only: bool
    dropped: bool
    byline: tuple
    byline_in_page: bool
    page_byline: bool
    byline_names: bool
    discover: tuple
    feeds: tuple


@dataclass(frozen=True)
class Config:
    people: tuple
    data: dict

    def by_key(self, key):
        return next((person for person in self.people if person.key == key), None)

    def by_name(self, name):
        return next((person for person in self.people if person.name == name), None)


def read(path):
    try:
        return json.loads(Path(path).read_text(encoding='utf-8'))
    except FileNotFoundError:
        raise PipelineError(f'missing-{Path(path).name}') from None
    except ValueError:
        raise PipelineError(f'unreadable-{Path(path).name}') from None


def need(condition, message):
    if not condition:
        raise PipelineError('sources-file-invalid: ' + message)


def compiles(pattern):
    try:
        re.compile(pattern)
    except (re.error, TypeError):
        return False
    return True


def check_discover(name, entry, feeds):
    need(type(entry) is dict and entry.get('kind') in DISCOVER_FIELDS, f'{name}: a discover entry has an unknown kind')
    required, optional = DISCOVER_FIELDS[entry['kind']]
    need(required <= set(entry) <= required | optional, f'{name}: a {entry["kind"]} entry has other fields')
    need(entry['url'] in feeds, f'{name}: {entry["url"]} is not one of the feeds in people.json')
    need(is_text(entry['channel']) and entry['channel'].strip(), f'{name}: a discover entry has no channel')
    for field in ('include', 'index'):
        if field in entry:
            need(is_text(entry[field]) and compiles(entry[field]), f'{name}: {field} is not a pattern')
    if 'author' in entry:
        need(is_text(entry['author']) and entry['author'].strip(), f'{name}: author is empty')


def load(directory):
    """The checked people and their collection rules, or PipelineError naming what is wrong."""
    directory = Path(directory)
    people = read(directory / PEOPLE_FILE)
    try:
        check_people(people)
    except RecordError as error:
        raise PipelineError(f'people-file-invalid: {error}') from None
    sources = read(directory / SOURCES_FILE)
    need(type(sources) is dict and set(sources) == {'version', 'people'}, 'fields differ')
    need(type(sources['version']) is int and sources['version'] >= 1, 'version is not a positive integer')
    rules = sources['people']
    need(type(rules) is list, 'people is not a list')
    by_name = {person['name']: person for person in people['people']}
    seen, keys, out = set(), set(), []
    for rule in rules:
        need(type(rule) is dict and set(rule) == RULE_FIELDS, 'a person has other fields')
        name = rule['name']
        need(name in by_name, 'a person is not in people.json')
        need(name not in seen, 'a person is listed twice')
        seen.add(name)
        need(is_text(rule['key']) and JOB_PATTERN.fullmatch(rule['key']) and rule['key'] not in keys, f'{name}: key is not a new short key')
        keys.add(rule['key'])
        need(type(rule['byline']) is list and rule['byline'] and all(is_text(word) and word.strip() for word in rule['byline']),
             f'{name}: byline is not a list of words')
        need(all(type(rule[flag]) is bool for flag in ('bylineInPage', 'pageByline', 'bylineNames')), f'{name}: a flag is not true or false')
        need(type(rule['redact']) is list and all(is_text(word) and len(word.strip()) >= 3 for word in rule['redact']),
             f'{name}: redact is not a list of names')
        need(type(rule['discover']) is list, f'{name}: discover is not a list')
        person = by_name[name]
        for entry in rule['discover']:
            check_discover(name, entry, person['feeds'])
        out.append(Person(
            name=name,
            key=rule['key'],
            source_class=person['sourceClass'],
            advice_only=person['adviceOnly'],
            dropped=person['dropped'] is not None,
            byline=tuple(rule['byline']),
            byline_in_page=rule['bylineInPage'],
            page_byline=rule['pageByline'],
            byline_names=rule['bylineNames'],
            discover=tuple(rule['discover']),
            feeds=tuple(person['feeds']),
        ))
    need(seen == set(by_name), 'a person in people.json has no collection rules')
    return Config(people=tuple(out), data={'people': people, 'sources': sources})


def redaction_pattern(config):
    """One pattern for every listed name and handle, longest first, matched as whole words in any case."""
    words = sorted({word.strip() for rule in config.data['sources']['people'] for word in rule['redact']},
                   key=lambda word: (-len(word), word))
    if not words:
        return NEVER
    return re.compile(r'(?<![\w])(?:' + '|'.join(re.escape(word) for word in words) + r')(?!\w)', re.I)

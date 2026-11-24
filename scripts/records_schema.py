"""Validate the shared evidence record and the people file with the standard library.

src/lib/records.ts holds the same rules as a Zod schema; tests/records.test.ts checks
that both accept and reject the same fixtures. Run as a script, it reads
{"records": [...], "people": [...]} on standard input and prints whether each is valid.
"""

import datetime
import json
import math
import re
import sys

FIELDS = (
    'id', 'cls', 'src', 'keys', 'job', 'how', 'via', 'stance', 'text', 'quote', 'cond', 'tool',
    'effort', 'setting', 'run', 'surface', 'date', 'person', 'url', 'title', 'kind', 'x', 'checked',
)
CLASSES = ('measured', 'named', 'crowd')
SOURCES = {
    'benchmark': 'measured', 'arena': 'measured', 'report': 'measured',
    'use': 'named', 'advice': 'named', 'hn': 'crowd',
}
ID_SOURCES = {
    'hn': ('hn',), 'bm': ('benchmark',), 'ep': ('benchmark',), 'rp': ('report',),
    'la': ('arena',), 'ur': ('use',), 'ma': ('advice',),
}
# 'pending': no job until the next review, because the old job the label gave was split or became a
# field; `via` keeps the label. 'tag': no job, because a tag rule that gives none (the drawing test)
# matched; `via` keeps the label the record came with.
HOW = ('', 'label', 'keywords', 'review', 'pending', 'tag')
STANCES = ('positive', 'critical', 'mixed', 'neutral')
SETTINGS = ('', 'local', 'hosted')
RUNS = ('', 'interactive', 'unattended', 'parallel')
SURFACES = ('', 'coding-agent', 'chat-app', 'api', 'local-runner')
KEY_KINDS = ('model', 'line', 'version', 'tool')
SOURCE_CLASSES = ('first-hand', 'secondary')

ID_PATTERN = re.compile(r'(hn|bm|ep|rp|la|ur|ma):(\S+)')
HN_ID_PATTERN = re.compile(r'[1-9][0-9]*')
KEY_PATTERN = re.compile(r'(model|line|version|tool)\|\S(?:.*\S)?')
JOB_PATTERN = re.compile(r'[a-z][a-z0-9-]*')
DATE_PATTERN = re.compile(r'[0-9]{4}-[0-9]{2}-[0-9]{2}')
URL_PATTERN = re.compile(r'https?://[^\s/?#]+\S*')


class RecordError(ValueError):
    """A record or people file does not have the shared shape."""


def need(condition, message):
    if not condition:
        raise RecordError(message)


def is_text(value):
    return type(value) is str


def is_date(value):
    if not is_text(value) or not DATE_PATTERN.fullmatch(value):
        return False
    try:
        datetime.date.fromisoformat(value)
    except ValueError:
        return False
    return True


def is_url(value):
    return is_text(value) and URL_PATTERN.fullmatch(value) is not None


def is_json(value):
    if value is None or type(value) in (bool, str, int):
        return True
    if type(value) is float:
        return math.isfinite(value)
    if type(value) is list:
        return all(is_json(item) for item in value)
    if type(value) is dict:
        return all(is_text(key) and is_json(item) for key, item in value.items())
    return False


def check_record(record):
    """Raise RecordError with the first broken rule of one record."""
    need(type(record) is dict, 'record is not an object')
    need(set(record) == set(FIELDS), 'record fields differ: ' + ', '.join(sorted(set(record) ^ set(FIELDS))))
    for field in ('via', 'text', 'quote', 'cond', 'tool', 'effort', 'person', 'title', 'kind'):
        need(is_text(record[field]), f'{field} is not text')
    record_id = record['id']
    match = ID_PATTERN.fullmatch(record_id) if is_text(record_id) else None
    need(match is not None, 'id has no known prefix')
    need(match.group(1) != 'hn' or HN_ID_PATTERN.fullmatch(match.group(2)), 'hn id is not an item number')
    need(is_text(record['src']) and record['src'] in SOURCES, 'unknown src')
    need(record['src'] in ID_SOURCES[match.group(1)], 'id prefix does not match src')
    need(record['cls'] == SOURCES[record['src']], 'cls does not match src')
    keys = record['keys']
    need(type(keys) is list, 'keys is not a list')
    for pair in keys:
        need(type(pair) is list and len(pair) == 2, 'a key is not a [key, stance] pair')
        need(is_text(pair[0]) and KEY_PATTERN.fullmatch(pair[0]), 'a key has no known kind')
        need(pair[1] in STANCES, 'a key has an unknown stance')
    need(len({pair[0] for pair in keys}) == len(keys), 'a key is repeated')
    job, how, via = record['job'], record['how'], record['via']
    need(is_text(job) and (job == '' or JOB_PATTERN.fullmatch(job)), 'job is not a job id')
    need(how in HOW, 'unknown how')
    if how == 'pending':
        need(job == '' and via != '', 'a record that needs reading has no job and keeps its label')
    elif how == 'tag':
        need(job == '' and via != '', 'a record a tag rule gave no job has no job and keeps its label')
    else:
        need((job == '') == (how == '') == (via == ''), 'job, how and via must be all set or all empty')
    need(how != 'review' or record['cls'] == 'named', 'only named records have jobs by review')
    need(record['stance'] in STANCES, 'unknown stance')
    need(record['quote'] == '' or record['cls'] == 'named', 'only named records keep quotes')
    need((record['person'] != '') == (record['cls'] == 'named'), 'a person is named on named records only')
    need(record['setting'] in SETTINGS, 'unknown setting')
    need(record['run'] in RUNS, 'unknown run')
    need(record['surface'] in SURFACES, 'unknown surface')
    for field in ('date', 'checked'):
        need(record[field] == '' or is_date(record[field]), f'{field} is not a date')
    need(is_url(record['url']), 'url is not an http or https link')
    x = record['x']
    need(x is None or (type(x) is dict and is_json(x)), 'x is not an object of JSON values')


def check_people(data):
    """Raise RecordError with the first broken rule of a people file."""
    need(type(data) is dict and set(data) == {'version', 'people'}, 'people file fields differ')
    need(type(data['version']) is int and data['version'] >= 1, 'version is not a positive integer')
    people = data['people']
    need(type(people) is list, 'people is not a list')
    fields = {'name', 'feeds', 'sourceClass', 'adviceOnly', 'trusted', 'added', 'dropped'}
    for person in people:
        need(type(person) is dict and set(person) == fields, 'person fields differ')
        name = person['name']
        need(is_text(name) and name.strip() == name and name != '', 'name is empty or padded')
        need(type(person['feeds']) is list and person['feeds'], f'{name}: no feeds')
        need(all(is_url(feed) for feed in person['feeds']), f'{name}: a feed is not an http or https link')
        need(len(set(person['feeds'])) == len(person['feeds']), f'{name}: a feed is repeated')
        need(person['sourceClass'] in SOURCE_CLASSES, f'{name}: unknown source class')
        need(type(person['adviceOnly']) is bool and type(person['trusted']) is bool, f'{name}: flags are not true or false')
        for change in ('added', 'dropped'):
            value = person[change]
            if change == 'dropped' and value is None:
                continue
            need(type(value) is dict and set(value) == {'date', 'reason'}, f'{name}: {change} is not a date and reason')
            need(is_date(value['date']), f'{name}: {change} date is not a date')
            need(is_text(value['reason']) and value['reason'].strip() != '', f'{name}: {change} has no reason')
        need(person['dropped'] is None or person['dropped']['date'] >= person['added']['date'], f'{name}: dropped before added')
    need(len({person['name'] for person in people}) == len(people), 'a name is repeated')


def verdict(check, value):
    try:
        check(value)
    except RecordError as error:
        return str(error)
    return None


if __name__ == '__main__':
    payload = json.load(sys.stdin)
    print(json.dumps({
        'records': [verdict(check_record, record) is None for record in payload['records']],
        'people': [verdict(check_people, people) is None for people in payload['people']],
    }))

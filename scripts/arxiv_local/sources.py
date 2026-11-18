"""Read arXiv descriptive metadata over OAI-PMH without keeping author fields."""

import re
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from hn_local.sources import MAX_TIMESTAMP, PipelineError

ENDPOINT = 'https://oaipmh.arxiv.org/oai'
AGENT = 'model-reference-arxiv/1'
OAI = '{http://www.openarchives.org/OAI/2.0/}'
RAW = '{http://arxiv.org/OAI/arXivRaw/}'
PREFIX = 'oai:arXiv.org:'
# arXiv asks for at most one request every three seconds on one connection.
REQUEST_INTERVAL = 3.0
MAX_RETRY_DELAY = 600
MAX_PAGE_BYTES = 32 * 1024 * 1024
MAX_DAY_PAGES = 64
MAX_TITLE = 1_000
MAX_ABSTRACT = 8_000
PAPER_ID = re.compile(r'(?:\d{4}\.\d{4,5}|[a-z][a-z-]*(?:\.[A-Z]{2})?/\d{7})\Z')
CATEGORY = re.compile(r'[a-z][a-z-]*(?:\.[A-Za-z-]+)?\Z')
LICENSE = re.compile(
    r'https?://(?:arxiv\.org/licenses|creativecommons\.org/(?:licenses|publicdomain))/[\w./-]{1,64}\Z'
)
TOKEN = re.compile(r'[\x21-\x7e]{1,1024}\Z')
DAY = re.compile(r'\d{4}-\d{2}-\d{2}\Z')


@dataclass(frozen=True)
class Record:
    id: str | None
    kind: str
    title: str = ''
    abstract: str = field(default='', repr=False)
    categories: tuple[str, ...] = ()
    license: str | None = None
    submitted: int | None = None
    updated: int | None = None
    versions: int = 0


def version_time(element):
    try:
        moment = parsedate_to_datetime(element.findtext(f'{RAW}date') or '')
    except (TypeError, ValueError):
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    # arXiv e-prints date from 1991, earlier than the comment pipeline's lower bound.
    value = int(moment.timestamp())
    return value if 0 <= value <= MAX_TIMESTAMP else None


def read_record(element):
    header = element.find(f'{OAI}header')
    identifier = (header.findtext(f'{OAI}identifier') or '') if header is not None else ''
    paper_id = identifier.removeprefix(PREFIX)
    if not identifier.startswith(PREFIX) or not PAPER_ID.fullmatch(paper_id):
        return Record(None, 'invalid')
    if header.get('status') == 'deleted':
        return Record(paper_id, 'unavailable')
    raw = element.find(f'{OAI}metadata/{RAW}arXivRaw')
    if raw is None:
        return Record(paper_id, 'invalid')
    times = [version_time(version) for version in raw.findall(f'{RAW}version')]
    title = ' '.join((raw.findtext(f'{RAW}title') or '').split())
    abstract = ' '.join((raw.findtext(f'{RAW}abstract') or '').split())
    categories = tuple((raw.findtext(f'{RAW}categories') or '').split())
    license_url = (raw.findtext(f'{RAW}license') or '').strip()
    if (
        not times or None in times or not title or len(title) > MAX_TITLE or len(abstract) > MAX_ABSTRACT
        or not categories or not all(CATEGORY.fullmatch(category) for category in categories)
    ):
        return Record(paper_id, 'invalid')
    return Record(
        paper_id, 'paper', title, abstract, categories,
        license_url if LICENSE.fullmatch(license_url) else None,
        min(times), max(times), len(times),
    )


def parse_page(data):
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        raise PipelineError('arxiv-oai-response') from None
    error = root.find(f'{OAI}error')
    if error is not None:
        if error.get('code') == 'noRecordsMatch':
            return [], None
        raise PipelineError('arxiv-oai-error')
    listing = root.find(f'{OAI}ListRecords')
    if listing is None:
        raise PipelineError('arxiv-oai-response')
    token = (listing.findtext(f'{OAI}resumptionToken') or '').strip()
    if token and not TOKEN.fullmatch(token):
        raise PipelineError('arxiv-oai-response')
    return [read_record(element) for element in listing.findall(f'{OAI}record')], token or None


def fetch(url):
    request = Request(url, headers={'User-Agent': AGENT})
    with urlopen(request, timeout=120) as response:
        data = response.read(MAX_PAGE_BYTES + 1)
    if len(data) > MAX_PAGE_BYTES:
        raise PipelineError('arxiv-oai-page-too-large')
    return data


def retry_delay(error, attempt):
    try:
        requested = int(error.headers.get('Retry-After', ''))
    except (AttributeError, TypeError, ValueError):
        requested = 0
    return min(MAX_RETRY_DELAY, max(requested, REQUEST_INTERVAL * 2**attempt))


class OaiReader:
    def __init__(self, read=fetch, sleep=time.sleep, clock=time.monotonic):
        self.read = read
        self.sleep = sleep
        self.clock = clock
        self.ready = 0.0
        self.requests = 0

    def request(self, parameters):
        url = f'{ENDPOINT}?{urlencode(parameters)}'
        for attempt in range(4):
            wait = self.ready - self.clock()
            if wait > 0:
                self.sleep(wait)
            delay = REQUEST_INTERVAL
            self.requests += 1
            try:
                return self.read(url)
            except HTTPError as error:
                if error.code not in {429, 500, 502, 503, 504}:
                    raise PipelineError('arxiv-oai-unavailable') from None
                delay = retry_delay(error, attempt)
            except OSError:
                delay = REQUEST_INTERVAL * 2**attempt
            finally:
                self.ready = self.clock() + delay
        raise PipelineError('arxiv-oai-unavailable')

    def day(self, day):
        """Yield one page of records at a time for a UTC datestamp day."""
        if not DAY.fullmatch(day):
            raise PipelineError('arxiv-oai-day')
        parameters = {'verb': 'ListRecords', 'metadataPrefix': 'arXivRaw', 'from': day, 'until': day}
        for _page in range(MAX_DAY_PAGES):
            records, token = parse_page(self.request(parameters))
            yield records
            if token is None:
                return
            parameters = {'verb': 'ListRecords', 'resumptionToken': token}
        raise PipelineError('arxiv-oai-page-limit')


def utc_day(value):
    return datetime.fromtimestamp(value, timezone.utc).date()


def days_between(first, last):
    return [
        (first + timedelta(days=offset)).isoformat()
        for offset in range((last - first).days + 1)
    ]


def today():
    return datetime.now(timezone.utc).date()


def parse_day(value):
    return date.fromisoformat(value)

"""Read public HN records in bounded batches without writing source text to disk."""

import asyncio
import csv
import io
import json
import re
import time
from calendar import monthrange
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

ARCHIVE = 'https://huggingface.co/datasets/open-index/hacker-news'
FIREBASE = 'https://hacker-news.firebaseio.com/v0'
ARCHIVE_PATTERN = re.compile(r'data/(\d{4})/\1-(0[1-9]|1[0-2])\.parquet\Z')
ARCHIVE_COLUMNS = ('id', 'type', 'time', 'parent', 'dead', 'deleted', 'text', 'title')
ARCHIVE_TYPES = {1: 'story', 2: 'comment', 3: 'poll', 4: 'pollopt', 5: 'job'}
ITEM_TYPES = frozenset(ARCHIVE_TYPES.values())
TAIL_PARTITION_SIZE = 10_000
RECONCILE_ID = 'archive-gaps'
MIN_TIMESTAMP = 1_100_000_000
MAX_TIMESTAMP = 4_102_444_800


class PipelineError(Exception):
    """A fixed, text-free diagnostic safe for status, CLI output and logs."""


@dataclass(frozen=True)
class DateWindow:
    start: int
    end: int

    def contains(self, created: int | None) -> bool:
        return created is not None and self.start <= created <= self.end


@dataclass(frozen=True)
class Partition:
    id: str
    source: str
    expected_items: int
    first_item: int | None = None
    last_item: int | None = None
    row_offset: int = 0
    archive_rows: int | None = None


@dataclass(frozen=True)
class SourcePlan:
    source: str
    archive_revision: str | None
    first_item: int | None
    last_item: int
    partitions: tuple[Partition, ...]
    full_range: bool = False
    window: DateWindow | None = None


@dataclass(frozen=True)
class Item:
    id: int | None
    kind: str
    created: int | None = None
    body: str | None = field(default=None, repr=False)
    available: bool = False
    parent: int | None = None
    title: str | None = field(default=None, repr=False)
    kids: tuple[int, ...] = ()


def positive_integer(value):
    return type(value) is int and 0 < value < 2**53


def timestamp(value):
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        value = int(value.timestamp())
    if type(value) is int and MIN_TIMESTAMP <= value <= MAX_TIMESTAMP:
        return value
    return None


def iso_time(value):
    if value is None:
        return None
    return datetime.fromtimestamp(value, timezone.utc).isoformat().replace('+00:00', 'Z')


def recent_window(now=None):
    local = ZoneInfo('Australia/Hobart')
    now = datetime.now(local) if now is None else now.astimezone(local)
    year, month = divmod(now.year * 12 + now.month - 1 - 6, 12)
    month += 1
    start = datetime(year, month, min(now.day, monthrange(year, month)[1]), tzinfo=local)
    return DateWindow(int(start.timestamp()), int(now.timestamp()))


def public_read(url, code):
    for attempt in range(3):
        try:
            request = Request(url, headers={'User-Agent': 'model-reference-hn/1'})
            with urlopen(request, timeout=30) as response:
                return response.read(4 * 1024 * 1024)
        except OSError:
            if attempt < 2:
                time.sleep(2**attempt)
    raise PipelineError(code)


def get_maxitem():
    try:
        value = json.loads(public_read(f'{FIREBASE}/maxitem.json', 'firebase-maxitem'))
    except (UnicodeError, ValueError):
        raise PipelineError('firebase-maxitem') from None
    if not positive_integer(value):
        raise PipelineError('firebase-maxitem')
    return value


def get_archive():
    registry_url = 'https://huggingface.co/api/datasets/open-index/hacker-news'
    try:
        registry = json.loads(public_read(registry_url, 'archive-manifest'))
        revision = registry['sha']
        if not isinstance(revision, str) or not re.fullmatch(r'[a-f0-9]{40}', revision):
            raise ValueError
        paths = {
            sibling['rfilename'] for sibling in registry['siblings']
            if ARCHIVE_PATTERN.fullmatch(sibling['rfilename'])
        }
        stats = public_read(f'{ARCHIVE}/raw/{revision}/stats.csv', 'archive-manifest')
        partitions = {}
        for row in csv.DictReader(io.StringIO(stats.decode('utf-8'))):
            year, month = int(row['year']), int(row['month'])
            key = f'data/{year:04d}/{year:04d}-{month:02d}.parquet'
            count = int(row['count'])
            first, last = int(row['lowest_id']), int(row['highest_id'])
            if key in partitions or count < 0 or first < 0 or last < first:
                raise ValueError
            if count and (not first or not last):
                raise ValueError
            partitions[key] = Partition(key, 'archive', count, first or None, last or None)
        if not partitions or set(partitions) != paths:
            raise ValueError
        months = sorted(
            int(path[-15:-11]) * 12 + int(path[-10:-8]) for path in partitions
        )
        if months != list(range(months[0], months[-1] + 1)):
            raise ValueError
        return revision, tuple(partitions[key] for key in sorted(partitions, reverse=True))
    except (AttributeError, KeyError, TypeError, UnicodeError, ValueError, csv.Error):
        raise PipelineError('archive-manifest') from None


def build_plan(source, first_item=None, last_item=None, window=None, previous_last=None):
    if source == 'firebase' and (first_item is None or last_item is None):
        raise PipelineError('firebase-item-range')
    if source == 'archive-and-tail' and window is None:
        window = recent_window()
    maximum = get_maxitem()
    if source == 'archive-and-tail':
        revision, archive = get_archive()
        watermark = max(partition.last_item or 0 for partition in archive)
        if not watermark or watermark > maximum:
            raise PipelineError('archive-watermark')
        first, last = watermark + 1, maximum
        archive = scoped_archive(revision, archive, window)
        if not archive and first <= last:
            from .clickhouse import find_tail_start

            first = find_tail_start(first, last, window.start)
    else:
        revision, archive = None, ()
        first, last = first_item, last_item
        if not 1 <= first <= last <= maximum:
            raise PipelineError('firebase-item-range')
    anchor = previous_last if previous_last is not None and first <= previous_last < last else last
    tail_source = 'clickhouse-and-firebase' if source == 'archive-and-tail' else 'firebase'
    tail = []
    for start, end in ((anchor + 1, last), (first, anchor)):
        for upper in range(end, start - 1, -TAIL_PARTITION_SIZE):
            lower = max(start, upper - TAIL_PARTITION_SIZE + 1)
            tail.append(Partition(f'items-{lower}-{upper}', tail_source, upper - lower + 1, lower, upper))
    plan_first = min(
        (p.first_item for p in archive if p.first_item is not None), default=min(first, last),
    )
    return SourcePlan(
        source, revision, plan_first, last, tuple(tail) + archive,
        full_range=source == 'firebase' and window is None and first == 1 and last == maximum,
        window=window,
    )


def scoped_archive(revision, archive, window):
    start = datetime.fromtimestamp(window.start, timezone.utc)
    end = datetime.fromtimestamp(window.end, timezone.utc)
    partitions = []
    for partition in archive:
        match = ARCHIVE_PATTERN.fullmatch(partition.id)
        if match is None:
            raise PipelineError('archive-manifest')
        year, month = map(int, match.groups())
        month_start = datetime(year, month, 1, tzinfo=timezone.utc)
        next_year, next_month = divmod(year * 12 + month, 12)
        month_end = datetime(next_year, next_month + 1, 1, tzinfo=timezone.utc)
        if month_start > end or month_end <= start:
            continue
        if start <= month_start and end >= month_end:
            partitions.append(partition)
            continue
        clipped = clip_archive_partition(revision, partition, window)
        if clipped is not None:
            partitions.append(clipped)
    return tuple(partitions)


def clip_archive_partition(revision, partition, window):
    first_row = last_row = first_id = last_id = previous_id = None
    position = 0
    with archive_reader(revision, partition) as reader:
        for group in range(reader.num_row_groups):
            metadata = reader.metadata.row_group(group)
            columns = {column.path_in_schema: column.statistics for column in (
                metadata.column(index) for index in range(metadata.num_columns)
            )}
            times = columns.get('time')
            ids = columns.get('id')
            if times is not None and times.has_min_max and ids is not None and ids.has_min_max:
                earliest, latest = timestamp(times.min), timestamp(times.max)
                if latest is not None and latest < window.start and positive_integer(ids.max):
                    previous_id = ids.max
                    position += metadata.num_rows
                    continue
                if earliest is not None and earliest > window.end:
                    position += metadata.num_rows
                    continue
            for batch in reader.iter_batches(batch_size=16384, row_groups=[group], columns=['id', 'time']):
                for item_id, created in zip(batch['id'].to_pylist(), batch['time'].to_pylist()):
                    if positive_integer(item_id) and window.contains(timestamp(created)):
                        if first_row is None:
                            first_row = position
                            first_id = min(item_id, previous_id + 1) if previous_id is not None else item_id
                        first_id = min(first_id, item_id)
                        last_row = position
                        last_id = max(last_id or item_id, item_id)
                    if positive_integer(item_id):
                        previous_id = item_id
                    position += 1
    if first_row is None:
        return None
    if (
        first_row == 0 and last_row + 1 == partition.expected_items
        and first_id == partition.first_item and last_id == partition.last_item
    ):
        return partition
    return Partition(
        partition.id, partition.source, last_row - first_row + 1, first_id, last_id,
        row_offset=first_row, archive_rows=partition.expected_items,
    )


def read_item(data, expected_id):
    if data is None:
        return Item(expected_id, 'unavailable')
    if not isinstance(data, dict) or type(data.get('id')) is not int or data['id'] != expected_id:
        return Item(expected_id, 'invalid')
    kind = data.get('type')
    created = timestamp(data.get('time'))
    kids = data.get('kids')
    kids = tuple(kid for kid in kids if positive_integer(kid)) if isinstance(kids, list) else ()
    if data.get('dead') is True or data.get('deleted') is True:
        # Replies to a removed comment are still public, so the thread stays walkable through it.
        if kind != 'comment':
            return Item(expected_id, 'unavailable', created, kids=kids)
        parent = data.get('parent')
        return Item(expected_id, kind, created, parent=parent if positive_integer(parent) else None, kids=kids)
    if not isinstance(kind, str) or kind not in ITEM_TYPES:
        return Item(expected_id, 'invalid')
    body = data.get('text')
    body = body if isinstance(body, str) and body.strip() else None
    if kind != 'comment':
        title = data.get('title')
        title = title if isinstance(title, str) and title.strip() else None
        return Item(expected_id, kind, created, body, True, title=title, kids=kids)
    parent = data.get('parent')
    if created is None or not positive_integer(parent):
        return Item(expected_id, 'invalid')
    return Item(expected_id, kind, created, body, body is not None, parent, kids=kids)


def screened(item, prefilter):
    """Drop text that names no target, so the scan holds only what it may queue."""
    body = item.body if item.kind == 'comment' and item.body and prefilter.search(item.body) else None
    title = item.title if item.title and prefilter.search(item.title) else None
    return Item(item.id, item.kind, item.created, body, item.available, item.parent, title)


class FirebaseReader:
    def __init__(self, workers, prefilter):
        self.workers = workers
        self.prefilter = prefilter
        self.runner = asyncio.Runner()
        self.session = None
        self.requests = 0
        self.request_limit = None

    async def open(self):
        import aiohttp

        self.session = aiohttp.ClientSession(
            connector=aiohttp.TCPConnector(limit=self.workers, ttl_dns_cache=300),
            timeout=aiohttp.ClientTimeout(total=15),
            headers={'User-Agent': 'model-reference-hn/1'},
            trust_env=False,
        )

    def __enter__(self):
        self.runner.run(self.open())
        return self

    def __exit__(self, *_args):
        try:
            self.runner.run(self.session.close())
        finally:
            self.runner.close()

    async def fetch(self, item_id, full=False):
        import aiohttp

        for attempt in range(4):
            if self.request_limit is not None and self.requests >= self.request_limit:
                raise PipelineError('request-limit')
            self.requests += 1
            try:
                async with self.session.get(f'{FIREBASE}/item/{item_id}.json') as response:
                    response.raise_for_status()
                    item = read_item(await response.json(), item_id)
                    if item.kind == 'invalid':
                        raise ValueError
                    return item if full else screened(item, self.prefilter)
            except (aiohttp.ClientError, TimeoutError, UnicodeError, ValueError):
                if attempt < 3:
                    await asyncio.sleep(2**attempt)
        raise PipelineError('firebase-item-request')

    async def fetch_all(self, item_ids, full=False):
        outcomes = await asyncio.gather(
            *(self.fetch(item_id, full) for item_id in item_ids), return_exceptions=True
        )
        for outcome in outcomes:
            if isinstance(outcome, PipelineError):
                raise outcome
            if isinstance(outcome, BaseException):
                raise PipelineError('firebase-item-request')
        return outcomes

    def read(self, item_ids):
        """Complete public items by id, for reading a comment in its thread."""
        item_ids = list(dict.fromkeys(item_ids))
        items = {}
        for offset in range(0, len(item_ids), self.workers * 4):
            batch = item_ids[offset:offset + self.workers * 4]
            for item in self.runner.run(self.fetch_all(batch, full=True)):
                items[item.id] = item
        return items

    def cap_page_size(self, count):
        if self.request_limit is not None:
            count = min(count, self.request_limit - self.requests)
            if count <= 0:
                raise PipelineError('request-limit')
        return count

    def pages(self, partition, position, page_size, maximum):
        high = partition.last_item - position
        low = max(partition.first_item, high - maximum + 1)
        while high >= low:
            count = self.cap_page_size(page_size)
            lower = max(low, high - count + 1)
            yield self.runner.run(self.fetch_all(range(high, lower - 1, -1)))
            high = lower - 1


def archive_items(batch, prefilter):
    import pyarrow.compute as compute

    kinds = batch.column('type').to_pylist()
    times = batch.column('time').to_pylist()
    ids = batch.column('id').to_pylist()
    parents = batch.column('parent').to_pylist()
    hidden = [
        bool(dead or deleted)
        for dead, deleted in zip(batch.column('dead').to_pylist(), batch.column('deleted').to_pylist())
    ]
    text = batch.column('text')
    matched = compute.match_substring_regex(text, prefilter.pattern, ignore_case=True).to_pylist()
    nonempty = compute.utf8_length(compute.utf8_trim_whitespace(text)).to_pylist()
    titles = batch.column('title')
    titled = compute.match_substring_regex(titles, prefilter.pattern, ignore_case=True).to_pylist()
    for index, (item_id, kind, created) in enumerate(zip(ids, kinds, times)):
        if not positive_integer(item_id):
            yield Item(None, 'invalid')
            continue
        kind = ARCHIVE_TYPES.get(kind)
        created = timestamp(created)
        if hidden[index]:
            yield Item(item_id, 'comment' if kind == 'comment' else 'unavailable', created)
        elif kind is None:
            yield Item(item_id, 'invalid')
        elif kind != 'comment':
            title = titles[index].as_py() if titled[index] else None
            yield Item(item_id, kind, created, available=True, title=title)
        elif created is None or not positive_integer(parents[index]):
            yield Item(item_id, 'invalid')
        else:
            available = bool(nonempty[index])
            body = text[index].as_py() if available and matched[index] else None
            yield Item(item_id, kind, created, body, available, parents[index])


@contextmanager
def archive_reader(revision, partition):
    import fsspec
    import pyarrow.parquet as parquet

    url = f'{ARCHIVE}/resolve/{revision}/{partition.id}'
    try:
        # This HTTP reader does not materialize a local file or fetch unprojected columns.
        with fsspec.open(url, 'rb', block_size=1024 * 1024, cache_type='none') as remote:
            reader = parquet.ParquetFile(remote, pre_buffer=False)
            if (
                reader.metadata.num_rows != (partition.archive_rows or partition.expected_items)
                or (partition.expected_items and not set(ARCHIVE_COLUMNS).issubset(reader.schema_arrow.names))
            ):
                raise PipelineError('archive-schema-or-row-count')
            yield reader
    except PipelineError:
        raise
    except Exception:
        raise PipelineError('archive-read') from None


def archive_pages(revision, partition, position, page_size, maximum, prefilter):
    maximum = min(maximum, partition.expected_items - position)
    position += partition.row_offset
    with archive_reader(revision, partition) as reader:
        for row_group in range(reader.num_row_groups):
            if maximum <= 0:
                break
            group_size = reader.metadata.row_group(row_group).num_rows
            if position >= group_size:
                position -= group_size
                continue
            for batch in reader.iter_batches(
                batch_size=page_size, row_groups=[row_group], columns=ARCHIVE_COLUMNS
            ):
                if position >= batch.num_rows:
                    position -= batch.num_rows
                    continue
                if position:
                    batch = batch.slice(position)
                    position = 0
                batch = batch.slice(0, maximum)
                maximum -= batch.num_rows
                yield list(archive_items(batch, prefilter))
                if maximum <= 0:
                    break

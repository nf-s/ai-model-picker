"""Read bounded item ranges from the public ClickHouse HN mirror."""

import json
import time
from http.client import HTTPException
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from .sources import ITEM_TYPES, MAX_TIMESTAMP, PipelineError, public_read, read_item, screened, timestamp

CLICKHOUSE = 'https://play.clickhouse.com/'
CLICKHOUSE_BATCH_SIZE = 512
MAX_ID = 2**32 - 1
MAX_LINE_BYTES = 1024 * 1024
MAX_RESPONSE_BYTES = 16 * 1024 * 1024


def find_tail_start(first, last, start):
    code = 'clickhouse-date-boundary'
    if not (1 <= first <= last <= MAX_ID and timestamp(start) is not None):
        raise PipelineError(code)
    query = (
        f'SELECT minIf(id, time >= toDateTime({start})), maxIf(id, time < toDateTime({start}) AND time > toDateTime(0)) '
        'FROM default.hackernews_history FINAL '
        f'WHERE id BETWEEN {first} AND {last} FORMAT JSONCompactEachRow'
    )
    params = urlencode({'user': 'play', 'query': query})
    try:
        bounds = json.loads(public_read(f'{CLICKHOUSE}?{params}', code))
        if not isinstance(bounds, list) or len(bounds) != 2 or not all(
            type(item_id) is int and (item_id == 0 or first <= item_id <= last) for item_id in bounds
        ):
            raise ValueError
        earliest, predecessor = bounds
        if earliest == 0 and predecessor == 0:
            raise ValueError
        return min(earliest or last + 1, predecessor + 1 if predecessor else first)
    except (UnicodeError, ValueError):
        raise PipelineError(code) from None


def read_row(payload, lower, upper):
    row = json.loads(payload)
    if not isinstance(row, list) or len(row) != 8:
        raise ValueError
    item_id, kind, created, parent, dead, deleted, body, title = row
    if not (
        type(item_id) is int and lower <= item_id <= upper
        and isinstance(kind, str) and kind in ITEM_TYPES
        and type(created) is int and 0 <= created <= MAX_TIMESTAMP
        and type(parent) is int and 0 <= parent <= MAX_ID
        and type(dead) is int and dead in (0, 1)
        and type(deleted) is int and deleted in (0, 1)
        and isinstance(body, str)
        and isinstance(title, str)
    ):
        raise ValueError
    return read_item({
        'id': item_id,
        'type': kind,
        'time': created,
        'parent': parent,
        'dead': bool(dead),
        'deleted': bool(deleted),
        'text': body,
        'title': title,
    }, item_id)


class ClickHouseReader:
    def __init__(self, prefilter):
        self.prefilter = prefilter

    def read(self, start, end):
        if not (
            type(start) is int and type(end) is int and 1 <= start <= end <= MAX_ID
            and end - start < CLICKHOUSE_BATCH_SIZE
        ):
            raise PipelineError('clickhouse-read')
        query = (
            'SELECT id, type, toUnixTimestamp(time), parent, dead, deleted, text, title '
            'FROM default.hackernews_history FINAL '
            f'WHERE id BETWEEN {start} AND {end} ORDER BY id FORMAT JSONCompactEachRow'
        )
        params = urlencode({'user': 'play', 'query': query})
        request = Request(f'{CLICKHOUSE}?{params}', headers={'User-Agent': 'model-reference-hn/1'})
        for attempt in range(3):
            try:
                return self._read_response(request, start, end)
            except (HTTPException, OSError, RecursionError, ValueError):
                if attempt < 2:
                    time.sleep(2**attempt)
        raise PipelineError('clickhouse-read') from None

    def _read_response(self, request, start, end):
        items = {}
        lower = start
        total_bytes = 0
        with urlopen(request, timeout=30) as response:
            if response.status != 200:
                raise ValueError
            for _ in range(end - start + 2):
                payload = response.readline(MAX_LINE_BYTES + 1)
                if not payload:
                    return items
                total_bytes += len(payload)
                if (
                    len(payload) > MAX_LINE_BYTES or total_bytes > MAX_RESPONSE_BYTES
                    or not payload.endswith(b'\n')
                ):
                    raise ValueError
                item = read_row(payload, lower, end)
                if item.id is None:
                    raise ValueError
                lower = item.id + 1
                items[item.id] = screened(item, self.prefilter)
        raise ValueError

"""Polite reading of public pages: one request every three seconds, robots.txt checked for every
host before any other request to it, a generic client name, no cookies and no sign-in."""

import json
import time
from urllib.error import HTTPError
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
from urllib.robotparser import RobotFileParser

AGENT = 'public-research-archive/1.0'
SPACING = 3.0
MAX_BYTES = 12_000_000
MAX_REDIRECTS = 5
TIMEOUT = 30
REDIRECTS = (301, 302, 303, 307, 308)


class NoRedirects(HTTPRedirectHandler):
    """Hand every redirect back, so the next address is checked against its own host's robots.txt."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = build_opener(ProxyHandler({}), NoRedirects())


def http_get(url, accept):
    """(status, body, Location header) for one GET with no cookies and no credentials."""
    request = Request(url, headers={'User-Agent': AGENT, 'Accept': accept})
    try:
        with OPENER.open(request, timeout=TIMEOUT) as response:
            return response.status, response.read(MAX_BYTES), ''
    except HTTPError as error:
        return error.code, b'', error.headers.get('Location', '') if error.headers else ''
    except (OSError, ValueError) as error:
        return type(error).__name__, b'', ''


class Fetcher:
    """Reads public pages one at a time. `transport` is http_get unless a test passes a stand-in."""

    def __init__(self, log_path=None, transport=http_get, clock=time.monotonic, sleep=time.sleep, max_requests=None):
        self.log_path = log_path
        self.transport = transport
        self.clock = clock
        self.sleep = sleep
        self.max_requests = max_requests
        self.requests = 0
        self.last = None
        self.robots = {}

    def request(self, url, accept):
        if self.max_requests is not None and self.requests >= self.max_requests:
            return 'request-limit', b'', ''
        if self.last is not None:
            gap = self.clock() - self.last
            if gap < SPACING:
                self.sleep(SPACING - gap)
        self.requests += 1
        status, data, location = self.transport(url, accept)
        self.last = self.clock()
        self.log(url, status, len(data))
        return status, data, location

    def log(self, url, status, size):
        if self.log_path is None:
            return
        with self.log_path.open('a', encoding='utf-8') as stream:
            stream.write(json.dumps({'url': url, 'status': status, 'bytes': size,
                                     'at': time.strftime('%Y-%m-%dT%H:%M:%S')}) + '\n')

    def allowed(self, url):
        parts = urlsplit(url)
        origin = f'{parts.scheme}://{parts.netloc}'
        if origin not in self.robots:
            status, data, _ = self.request(origin + '/robots.txt', 'text/plain')
            parser = RobotFileParser()
            if status == 200:
                parser.parse(data.decode('utf-8', 'replace').splitlines())
            elif status in (401, 403):
                parser.disallow_all = True
            else:
                parser.allow_all = True
            self.robots[origin] = parser
        return self.robots[origin].can_fetch(AGENT, url)

    def fetch(self, url, accept='*/*'):
        """(status, body, final address). Status is an HTTP code, 'robots' when robots.txt disallows
        the address or a redirect target, 'not-public' for a non-web address, or an error name."""
        for _ in range(MAX_REDIRECTS + 1):
            parts = urlsplit(url)
            if parts.scheme not in ('http', 'https') or not parts.hostname or parts.username or parts.password:
                return 'not-public', b'', url
            if not self.allowed(url):
                self.log(url, 'robots', 0)
                return 'robots', b'', url
            status, data, location = self.request(url, accept)
            if status not in REDIRECTS or not location:
                return status, data, url
            url = urljoin(url, location)
        return 'too-many-redirects', b'', url

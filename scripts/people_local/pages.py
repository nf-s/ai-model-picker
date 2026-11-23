"""Reading feeds, sitemaps and article pages into plain text, links, a date and a byline."""

import json
import re
import xml.etree.ElementTree as ET
from collections import defaultdict
from datetime import date, datetime
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit, urlunsplit

# A Unix home folder and the user name in it, wherever the path starts: after a space, quote,
# backtick or bracket, at the start of a line, or inside a longer path.
HOME_FOLDER = re.compile(r'/(?:Users|home)/[^/\s"`]+')
# Contact details, keys and home folders are replaced before any text is kept.
PRIVATE = [
    re.compile(r'(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b'),
    re.compile(r'(?i)\b(?:sk[-_](?:ant[-_])?[\w-]{16,}|gh[pousr]_[0-9A-Za-z_]{20,}|'
               r'github_pat_[0-9A-Za-z_]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[\w-]{12,})\b'),
    re.compile(r'(?im)\b(?:api[-_ ]?key|password|access[-_ ]?token|client[-_ ]?secret)\s*[:=]\s*[\x22\x27]?[\w./+=-]{12,}'),
    re.compile(r'(?<![\w-])(?:\+\d{1,3}[-. ]+|\(\d{3}\)[-. ]+)\d[\d -.]{6,13}\d(?!\w)'),
    HOME_FOLDER,
]
# Whether an item may be about models or agents at all; items that are not are kept but not reviewed.
RELEVANT = re.compile(
    r'\b(?:ai|llms?|gpt[- ]?\d\w*|chatgpt|claude|anthropic|openai|codex|haiku|sonnet|opus|'
    r'gemini|deepseek|qwen|llama|mistral|fable|astra|copilot|cursor|aider|amp|agents?|agentic|'
    r'autoresearch|prompt(?:ing|s)?|tokens?|inference|transformers?|hallucinat\w+|'
    r'benchmark\w*|evals?|mcp|vibe.coding|language.models?|model.weights?)\b', re.I,
)
# Text a page shows where the rest of a paid post would be.
PAYWALL = re.compile(r'(?i)(this post is for paid subscribers|keep reading with a \d+-day free trial|'
                     r'subscribe to .{0,60} to (?:keep|continue) reading|become a paid subscriber|'
                     r'upgrade to paid|this post is for paying subscribers|'
                     r'the rest of this (?:post|article) is for paid|member-only story)')
SHOWN_DATE = re.compile(r'\b\d{1,2} (?:January|February|March|April|May|June|July|August|September|'
                        r'October|November|December) 20\d\d\b')
OMIT = {'script', 'style', 'noscript', 'svg', 'nav', 'footer', 'form', 'template', 'iframe', 'button'}
VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'}
BLOCK = {'p', 'br', 'li', 'div', 'section', 'blockquote', 'pre', 'ul', 'ol', 'table', 'tr', 'hr', 'h1', 'h2', 'h3', 'h4'}
DATE_FIELDS = ('article:published_time', 'datePublished', 'date', 'pubdate', 'og:published_time')
REGIONS = [
    ('body', 'markup'), ('post-body',), ('post-content',), ('article-content',),
    ('entry-content',), ('quarto-title-block', 'default'), ('markdown-body',),
    ('blogmark-body',), ('entryBody',), ('entry-body',), ('article-body',),
]


def scrub(value):
    for pattern in PRIVATE:
        value = pattern.sub('[redacted]', value)
    return value


def clean_url(url, base=''):
    """An https link without credentials, query or fragment (except a Hacker News item or a GitHub
    comment anchor), or '' when the link is not a public web address."""
    parts = urlsplit(urljoin(base, url))
    if parts.scheme not in ('https', 'http') or not parts.hostname or parts.username or parts.password:
        return ''
    if any(pattern.search(url) for pattern in PRIVATE):
        return ''
    query = parts.query if parts.hostname == 'news.ycombinator.com' and re.fullmatch(r'id=\d+', parts.query) else ''
    fragment = parts.fragment if re.fullmatch(r'issuecomment-\d+', parts.fragment) else ''
    return urlunsplit(('https', parts.netloc.lower(), parts.path or '/', query, fragment))


def day(value):
    """An ISO date from a feed or page date in any of the usual forms, or ''."""
    if not value:
        return ''
    value = str(value).strip()
    if match := re.match(r'(20\d\d)[/-](\d{1,2})[/-](\d{1,2})', value):
        try:
            return date(*map(int, match.groups())).isoformat()
        except ValueError:
            return ''
    try:
        # The date as the source wrote it, in its own time zone.
        return parsedate_to_datetime(value).date().isoformat()
    except (ValueError, TypeError, OverflowError):
        pass
    for form in ('%Y/%b/%d', '%Y/%B/%d', '%B %d, %Y', '%b %d, %Y', '%d %b %Y', '%d %B %Y'):
        try:
            return datetime.strptime(value, form).date().isoformat()
        except ValueError:
            continue
    return ''


class Node:
    def __init__(self, tag='', attrs=None):
        self.tag = tag
        self.attrs = attrs or {}
        self.children = []

    def nodes(self, tag=''):
        for child in self.children:
            if isinstance(child, Node):
                if not tag or child.tag == tag:
                    yield child
                yield from child.nodes(tag)

    def rendered(self):
        if self.tag in OMIT:
            return ''
        content = ''.join(child.rendered() if isinstance(child, Node) else child for child in self.children)
        if self.tag == 'blockquote':
            return '\n\n' + '\n'.join('> ' + line for line in content.strip().splitlines()) + '\n\n'
        if self.tag == 'pre':
            return '\n\n```\n' + content.strip() + '\n```\n\n'
        if self.tag in BLOCK:
            return '\n' + content + '\n'
        return content


class Tree(HTMLParser):
    def __init__(self, data):
        super().__init__(convert_charrefs=True)
        self.root = Node()
        self.stack = [self.root]
        self.feed(data.decode('utf-8', 'replace') if isinstance(data, bytes) else data)
        self.close()

    def handle_starttag(self, tag, attrs):
        node = Node(tag, {name: value or '' for name, value in attrs})
        self.stack[-1].children.append(node)
        if tag not in VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                break

    def handle_data(self, data):
        self.stack[-1].children.append(data)


def tidy(text):
    text = re.sub(r'[\t\r\f\v ]+', ' ', text)
    text = re.sub(r' *\n *', '\n', text)
    return scrub(re.sub(r'\n{3,}', '\n\n', text).strip())


def anchors(node, base):
    return [link for link in dict.fromkeys(
        clean_url(anchor.attrs.get('href', ''), base) for anchor in node.nodes('a') if anchor.attrs.get('href')
    ) if link]


def properties(tree):
    """Meta tags and JSON-LD fields of a page: dates, headline and author names."""
    found = defaultdict(list)
    for node in tree.nodes('meta'):
        key = node.attrs.get('property') or node.attrs.get('name') or node.attrs.get('itemprop')
        if key and node.attrs.get('content'):
            found[key].append(node.attrs['content'])

    def inspect(value):
        if isinstance(value, list):
            for item in value:
                inspect(item)
        if not isinstance(value, dict):
            return
        for key in ('datePublished', 'dateModified', 'headline', 'author'):
            if key not in value:
                continue
            item = value[key]
            if key == 'author':
                for author in item if isinstance(item, list) else [item]:
                    name = author.get('name', '') if isinstance(author, dict) else str(author)
                    if isinstance(name, str) and name:
                        found[key].append(name)
            elif isinstance(item, str):
                found[key].append(item)
        if '@graph' in value:
            inspect(value['@graph'])

    for script in tree.nodes('script'):
        if script.attrs.get('type') == 'application/ld+json':
            try:
                inspect(json.loads(''.join(part for part in script.children if isinstance(part, str))))
            except ValueError:
                pass
    return found


def text_region(tree):
    """The element that holds an article's text: a known content class, else <article> or <main>."""
    for pattern in REGIONS:
        matched = [
            node for node in tree.nodes()
            if set(pattern) <= set((node.attrs.get('class', '') + ' ' + node.attrs.get('id', '')).split())
            and len(node.rendered().strip()) > 130
        ]
        if matched:
            return max(matched, key=lambda node: len(node.rendered()))
    for tag in ('article', 'main'):
        matches = list(tree.nodes(tag))
        if matches:
            return max(matches, key=lambda node: len(node.rendered()))
    return next(tree.nodes('body'), tree)


def parse_feed(data):
    """Entries of an RSS or Atom feed: link, title, date, authors and the text the feed carries."""
    root = ET.fromstring(data)
    rows = []
    for item in root.findall('.//item') + root.findall('.//{*}entry'):
        parts = defaultdict(list)
        for element in item:
            parts[element.tag.split('}')[-1]].append(element)

        def content(*fields):
            return next((''.join(parts[field][0].itertext()) for field in fields if parts[field]), '')

        link = next((anchor.attrib.get('href') or anchor.text or '' for anchor in parts['link']
                     if anchor.attrib.get('rel', 'alternate') == 'alternate'), '') or content('guid')
        authors = [''.join(author.itertext()).strip() for author in parts['creator']]
        for author in parts['author']:
            name = author.find('{*}name')
            authors.append(((name.text or '') if name is not None else ''.join(author.itertext())).strip())
        tree = Tree(content('encoded', 'content', 'description', 'summary')).root
        rows.append({
            'url': clean_url(link),
            'title': content('title').strip(),
            'date': day(content('published', 'pubDate', 'date', 'updated')),
            'authors': [author for author in authors if author],
            'body': tidy(tree.rendered()),
            'links': anchors(tree, ''),
            'fidelity': 'feed content' if parts['encoded'] or parts['content'] else 'feed excerpt',
        })
    return rows


def sitemap_entries(data):
    """('index', nested sitemap) and ('page', link, last modified date) entries of a sitemap."""
    root = ET.fromstring(data)
    if root.tag.endswith('sitemapindex'):
        return [('index', (loc.text or '').strip(), '') for loc in root.findall('.//{*}sitemap/{*}loc')]
    out = []
    for entry in root.findall('{*}url'):
        loc = entry.find('{*}loc')
        modified = entry.find('{*}lastmod')
        if loc is not None and loc.text:
            out.append(('page', loc.text.strip(), ((modified.text or '') if modified is not None else '')[:10]))
    return out


def links_on(data, base):
    return anchors(Tree(data).root, base)


def read_page(data, url, page_byline=False):
    """An article page's text, title, date, authors, links and whether it stops at a paywall.

    With `page_byline`, elements of class "author" add to the authors and a date shown in the
    page text ("4 March 2026") is used when no date field gives one.
    """
    tree = Tree(data).root
    found = properties(tree)
    region = text_region(tree)
    whole = tidy(tree.rendered())
    dates = [day(value) for key in DATE_FIELDS for value in found[key]]
    times = [day(node.attrs.get('datetime') or '') for node in tree.nodes('time')]
    authors = [name for name in found['author'] + found['article:author'] if not name.startswith('http') and len(name) < 120]
    if page_byline:
        authors += [tidy(node.rendered()).split('\n')[0] for node in tree.nodes()
                    if 'author' in node.attrs.get('class', '').split()]
    when = next((value for value in dates if value), '') or next((value for value in times if value), '')
    if not when and page_byline:
        shown = SHOWN_DATE.findall(whole)
        when = day(shown[0]) if shown else ''
    title = next((value for key in ('headline', 'og:title') for value in found[key] if value), '') or next(
        (tidy(node.rendered()) for node in tree.nodes('h1')), '')
    return {
        'body': tidy(region.rendered()),
        'title': title,
        'date': when,
        'authors': [name for name in dict.fromkeys(authors) if name],
        'paywalled': bool(PAYWALL.search(whole)),
        'whole': whole,
        'links': anchors(region, url),
    }

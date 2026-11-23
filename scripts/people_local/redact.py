"""Removing code, links, keys, contact details and people's names from text before review, and
splitting an item's text into overlapping passages."""

import re
from html import unescape

from hn_local.classify import PII

from .pages import scrub

PASSAGE_SIZE = 8200
OVERLAP = 600
URL_TEXT = re.compile(r'(?:(?:https?|ftp|file|s3|ssh|postgres(?:ql)?|redis|mongodb(?:\+srv)?)://|'
                      r'www\.|mailto:)[^\s<>)]+', re.I)
HN_HANDLE = re.compile(r'(?<!\w)@[A-Za-z\d_.-]{2,}')
PERSON_TITLE = re.compile(r'(?m)^([A-Z][a-z]+(?: [A-Z][a-z]+){1,2})(\s*(?:\[[\d:]+\]|\([\d:]+\))?\s*:)', re.M)
WINDOWS_HOME = re.compile(r'\b[A-Z]:[\\/]+(?:Users|Documents and Settings)[\\/]+[^\\/\r\n"<>`|*?]{1,120}', re.I)
AUTH_LINE = re.compile(
    r'(?im)\b(?:authorization|proxy-authorization|x-api-key|private-token|cookie|set-cookie|'
    r'cf-access-client-secret|anthropic[_-](?:api[_-]key|auth[_-]token))\b["\x27]?\s*[:=]\s*[^\r\n]+'
)
PROVIDER_SECRET = re.compile(
    r'(?i)\b(?:(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{35}|ya29\.[A-Za-z0-9_.-]{20,}|'
    r'(?:sk|rk)[-_](?:ant[-_]|proj[-_]|live[-_]|test[-_]|svcacct[-_])?[A-Za-z\d_-]{16,}|'
    r'gh[pousr]_[A-Za-z\d_-]{20,}|github_pat_[A-Za-z\d_-]{20,}|glpat-[A-Za-z\d_-]{15,}|'
    r'hf_[A-Za-z\d]{25,}|xox[baprs]-[A-Za-z\d_-]{12,}|'
    r'eyJ[A-Za-z\d_-]{12,}\.[A-Za-z\d_-]{12,}\.[A-Za-z\d_-]{12,}|'
    r'Bearer\s+[A-Za-z\d._~+/=-]{18,})\b'
)
PRIVATE_KEY = re.compile(
    r'-----BEGIN ([A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?)-----[\s\S]*?(?:-----END \1-----|\Z)', re.I
)
FENCED_CODE = re.compile(r'(?ms)^[ \t]*(```|~~~)[^\n]*\n.*?(?:^[ \t]*\1[ \t]*(?=\n|$)|\Z)')
REDACTION_MARKERS = re.compile(r'\[(?:redacted|[^\n\]]{1,25} omitted)\]')
LINK = re.compile(r'\[([^\]\n]{1,300})\]\(\s*\[(?:omitted|link omitted)\]\s*\)')
EMPTY_TARGET = re.compile(r'\(\s*\[(?:omitted|link omitted)\]\s*\)')


class Privacy:
    """The redaction for one set of people: `names` matches every listed name and handle."""

    def __init__(self, names):
        self.names = names
        self.output_patterns = (names, HN_HANDLE, URL_TEXT, WINDOWS_HOME, AUTH_LINE, PROVIDER_SECRET, PRIVATE_KEY)

    def redact(self, text, own_names):
        """`text` with code, keys, links and contact details replaced, each of `own_names` (the writer)
        replaced by [practitioner], and every other listed name or handle by [name omitted]."""
        text = unescape(text)
        text = FENCED_CODE.sub('[code omitted]', text)
        text = PRIVATE_KEY.sub('[key omitted]', text)
        text = WINDOWS_HOME.sub('[path omitted]', text)
        text = AUTH_LINE.sub('[auth omitted]', text)
        text = PROVIDER_SECRET.sub('[credential omitted]', text)
        text = URL_TEXT.sub('[link omitted]', scrub(text))
        for actual in own_names:
            parts = actual.split()
            first, last = parts[0], parts[-1]
            text = re.sub(r'(?im)^(\s*)(?:' + re.escape(actual) + '|' + re.escape(first) + '|' + re.escape(last) +
                          r')(?=\s*(?:[\[(][\d:]+[\])]\s*)?:)', r'\1[practitioner]', text)
            text = re.sub(re.escape(actual), '[practitioner]', text, flags=re.I)
        text = self.names.sub('[name omitted]', text)
        text = HN_HANDLE.sub('[handle omitted]', text)
        text = PERSON_TITLE.sub(r'[speaker]\2', text)
        # A number redaction can expose an adjacent handle that followed a word character, so the
        # result is checked again.
        text = PII.sub('[contact omitted]', text)
        return PII.sub('[contact omitted]', text)

    def leaks(self, texts, scrubbed=True):
        """Whether any text still holds a contact detail, link, key or listed name. Review replies are
        also checked against the collection's scrub (`scrubbed`); passages were scrubbed on the way in."""
        joined = ' '.join(texts)
        return (scrubbed and scrub(joined) != joined) or PII.search(joined) is not None or any(
            pattern.search(joined) for pattern in self.output_patterns)


def own_names(item, person):
    """The names replaced by [practitioner] in an item's text: the person's name, or for an outlet,
    the names in the item's byline."""
    if not person.byline_names:
        return [person.name]
    names = [part.strip() for byline in item.get('bylines', [])
             for part in re.split(r' / | and |, ', byline)
             if part.strip() and part.strip() not in person.byline]
    return [name for name in names if len(name.split()) >= 2 and name != 'GPT']


def plain_links(text):
    """Markdown links whose target was removed, rendered as their text so quotes can be copied exactly."""
    text = LINK.sub(r'\1', text)
    text = EMPTY_TARGET.sub('', text)
    return re.sub(r'[ \t]{2,}', ' ', text)


def hide_blocks(body):
    """`body` with keys, code, credentials, home folders and links masked at the same length, so
    passage offsets still point into the stored text."""
    def keep_offsets(match):
        mark = '[omitted]'
        return mark[:len(match[0])] + re.sub(r'[^\n]', ' ', match[0][len(mark):])

    for private in (PRIVATE_KEY, FENCED_CODE, AUTH_LINE, PROVIDER_SECRET, WINDOWS_HOME, URL_TEXT):
        body = private.sub(keep_offsets, body)
    return body


def passage_ranges(text):
    """(start, end) of passages of up to 8,200 characters, ending at a paragraph or line where one
    is near, each overlapping the one before by 600 characters."""
    start = 0
    while start < len(text):
        limit = min(start + PASSAGE_SIZE, len(text))
        end = limit
        if limit < len(text):
            boundary = max(text.rfind('\n\n', start + PASSAGE_SIZE // 2, limit),
                           text.rfind('\n', start + 3 * PASSAGE_SIZE // 4, limit))
            if boundary > start:
                end = boundary
        yield start, end
        if end == len(text):
            break
        start = end - OVERLAP

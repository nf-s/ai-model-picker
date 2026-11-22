"""Find reported agent and coding failures in matched arXiv abstracts for source review."""

import re

from failure_review import REVIEW_LIMIT, matching_checks, signal_labels
from hn_local.classify import TITLE_LIMIT, clip, sanitize_html
from hn_local.sources import iso_time
from hn_local.state import atomic_write

from .sources import PAPER_ID

AI = re.compile(
    r'\b(?:LLMs?|AI|artificial intelligence|language models?|ChatGPT|Claude|GPT|agentic|coding agents?)\b', re.I,
)
CODING = re.compile(
    r'\b(?:coding|software engineering|(?:code|software) (?:development|repair|review|generation|changes)|'
    r'bug fix(?:es|ing)?|SWE[- ]Bench|repository[- ]level|unit tests?|test suites?)\b', re.I,
)
WORKFLOW = re.compile(
    r'\b(?:agents?|agentic|(?:tool|function)[- ](?:use|calling|calls?)|(?:automated|AI|LLM) workflows?)\b', re.I,
)
WITHDRAWN = re.compile(
    r'^\s*[\[(]?(?:withdrawn|retracted)(?:\s*[\]):.]|\s+(?:by|at|on|paper|preprint)\b|\s*$)|'
    r'\b(?:paper|manuscript|preprint|submission) (?:is|was|has (?:now )?been) '
    r'(?:(?:since|now) )?(?:withdrawn|retracted)\b', re.I,
)
SENTENCES = re.compile(r'(?<=[.!?])\s+')
STUDY_VERB = r'(?:evaluate[ds]?|benchmark(?:ed)?|analy[sz]e[ds]?|test(?:ed)?)'
BACKGROUND = re.compile(
    r'^(?:(?:prior|previous|related|earlier|existing) (?:work|studies|research|evaluations?)|'
    r'it (?:is|has been) (?:known|shown|observed))\b', re.I,
)
METHOD = re.compile(
    rf'^(?:to (?:address|prevent|avoid|mitigate)|we (?:propose|introduce|present|aim|seek|{STUDY_VERB}))\b', re.I,
)
STUDY = re.compile(
    rf'\b(?:we {STUDY_VERB}|'
    r'our (?:evaluations?|experiments?|benchmark(?:s|ing)?|analysis)|'
    r'(?:this|the) study (?:evaluates?|examines?|tests?))\b', re.I,
)
RESULT = re.compile(
    r'(?:\bwe (?:find|found|observe[ds]?|document(?:ed)?|report(?:ed)?) (?:that )?|'
    r'\bwe (?:show|demonstrate) that |'
    r'\b(?:our |the )?(?:results|experiments|evaluations) (?:show|found|reveal|indicate|demonstrate)(?:s|ed)? '
    r'(?:that )?|^results:\s+|'
    rf'\bwe {STUDY_VERB}\b[^;]+?\band (?:find|found|observe[ds]?|report(?:ed)?|document(?:ed)?) (?:that )?)', re.I,
)
QUESTION = re.compile(r'^(?:whether|if|how|why|the (?:effect|impact|extent|frequency) of)\b', re.I)
MEASURED = re.compile(r'^(?:in|across|during) (?:our|[\d,]+) (?:evaluations?|experiments?|trials?|runs?)\b', re.I)
ACTOR = re.compile(r'\b(?:agents?|models?|assistants?|systems?|they|runs?|trials?)\b', re.I)
OBSERVED_FAILURE = re.compile(
    r'\b(?:skipped|omitted|bypassed|ignored|violated|missed|broke|failed to|did not|claimed|declared|'
    r'reported|hallucinated|fabricated|invented|lost|discarded|forgot|duplicated|degraded|reduced|'
    r'could not|retried|stalled)\b', re.I,
)


def abstract_evidence(title, abstract):
    """Return fixed evidence and procedures triggered by sentences about a study's own results."""
    if WITHDRAWN.search(title) or WITHDRAWN.search(abstract):
        return None
    text = f'{title} {abstract}'
    if not AI.search(text):
        return None
    scope = []
    if CODING.search(text):
        scope.append('AI-assisted software development')
    if WORKFLOW.search(text):
        scope.append('AI agents and tool-use workflows')
    if not scope:
        return None

    reported, clues = [], []
    study_started = False
    for sentence in SENTENCES.split(abstract):
        if sentence.endswith('?') or BACKGROUND.match(sentence):
            continue
        result = RESULT.search(sentence)
        if result:
            finding = sentence[result.end():]
            if not QUESTION.match(finding) and not BACKGROUND.match(finding):
                reported.extend(matching_checks(finding))
        elif not METHOD.match(sentence) and ACTOR.search(sentence) and OBSERVED_FAILURE.search(sentence):
            if MEASURED.match(sentence):
                reported.extend(matching_checks(sentence))
            elif study_started:
                clues.extend(matching_checks(sentence))
        study_started |= bool(STUDY.search(sentence))

    checks = list(dict.fromkeys(reported or clues))
    if not checks:
        return None
    return {
        'scope': scope,
        'sourceKind': 'abstract-result' if reported else 'abstract-clue',
        'evidence': ', '.join(signal_labels(checks)),
        'checks': checks,
    }


def export_failure_review(state):
    total = 0
    candidates = []
    for paper in state.failure_review_papers():
        if not PAPER_ID.fullmatch(paper['id']):
            continue
        evidence = abstract_evidence(paper['title'], paper['abstract'])
        if evidence is None:
            continue
        total += 1
        if len(candidates) < REVIEW_LIMIT:
            candidates.append({
                'url': f"https://arxiv.org/abs/{paper['id']}",
                'date': iso_time(paper['submitted']),
                'title': clip(' '.join(sanitize_html(paper['title']).split()), TITLE_LIMIT),
                'status': 'unverified',
                'targets': [{'kind': kind, 'target': target} for kind, target in state.paper_targets(paper['id'])],
                'attribution': 'paper-mentions',
                **evidence,
            })
    atomic_write(state.directory / 'failure-review.json', {
        'schemaVersion': 1,
        'source': 'arxiv',
        'candidateLimit': REVIEW_LIMIT,
        'totalCandidates': total,
        'candidates': candidates,
    })

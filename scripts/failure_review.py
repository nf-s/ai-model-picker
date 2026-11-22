"""Map reported symptoms to repeatable local checks for the two scrape reports."""

import re

REVIEW_LIMIT = 50

# Specific symptoms keep complaints about cost, model quality or speed alone out.
# These are retrieval rules. A source match always needs review in context.
CHECKS = (
    (
        'Premature completion',
        'Run the requested user flow after the agent reports completion and record which steps actually pass.',
        (
            r'(?:falsely|prematurely) (?:claim\w*|report\w*|declar\w*) (?:\w+ ){0,3}(?:done|complet\w*|success\w*)',
            r'(?:claim\w*|report\w*|declar\w*) (?:\w+ ){0,3}(?:done|complet\w*|success\w*) (?:even though|despite|without|while)',
        ),
    ),
    (
        'Skipped or broken tests',
        'Repeat the edit with a known failing test. Check the test log and run the regression suite on the final diff.',
        (
            r'(?:skip(?:s|ped|ping)?|omit(?:s|ted|ting)?|bypass\w*) (?:\w+ ){0,2}(?:tests?|testing|verification)',
            r'(?:broke|breaks?|breaking) (?:\w+ ){0,2}(?:tests?|existing (?:features?|behaviou?r))',
            r"(?:did not|didn['’]t|failed to) run (?:\w+ ){0,2}tests?",
        ),
    ),
    (
        'Missed instructions or scope',
        'Give the agent an explicit constraint and an agreed edit scope. Check the final diff and output against both.',
        (
            r'(?:ignor\w*|violat\w*|miss(?:ed|es|ing)?) (?:\w+ ){0,2}(?:instructions?|constraints?|requirements?)',
            r'(?:made|makes|making) (?:unrequested|unrelated|out.of.scope) (?:edits?|changes?)',
        ),
    ),
    (
        'Invented dependency or API',
        'Ask for a change against a pinned dependency. Resolve the cited symbols and run the example against that version.',
        (
            r'(?:hallucinat\w*|fabricat\w*|invent\w*|made up) (?:\w+ ){0,2}(?:apis?|methods?|libraries|functions?|packages?)',
            r'(?:used?|calls?|called|import\w*) (?:\w+ ){0,2}non[- ]?existent (?:apis?|methods?|libraries|functions?|packages?)',
        ),
    ),
    (
        'Lost context or stale state',
        'Resume an unfinished task from a handoff. Check whether the agent preserves the agreed constraint and the last verified state.',
        (
            r'(?:los(?:t|es?|ing)|forgot|forgets?|discard\w*|dropped) (?:\w+ ){0,3}(?:context|constraints?|prior decisions?|task state)',
            r'(?:follow\w*|reus\w*|rel(?:y|ies|ied) on) (?:\w+ ){0,2}(?:stale|superseded) (?:instructions?|state|decisions?)',
        ),
    ),
    (
        'Coordination failure',
        'Run the same task solo and with workers. Check the combined result against the shared interface and record total usage, time and rework.',
        (
            r'(?:duplicat\w*|repeat\w*) (?:\w+ ){0,2}(?:each other.s|another agent.s|other agents.) work',
            r'(?:conflicting|incompatible) (?:edits?|interfaces?|implementations?|changes?)',
            r'(?:coordination|handoff|integration) failures?|cross[- ]repository inconsistenc(?:y|ies)',
            r'(?:delegation|concurrency|multi-agent \w+|parallel agents?) (?:consistently |significantly )?(?:degrad\w*|reduc\w*|hurts?) (?:\w+ ){0,2}(?:accuracy|success|performance)',
            r'(?:delegation|concurrency|parallel agents?) (?:\w+ ){0,5}(?:costs?|tokens?|time) '
            r'(?:without (?:improving|increasing)|with no (?:gains?|improvement) in) '
            r'(?:task )?(?:accuracy|success|pass rate|performance)',
        ),
    ),
    (
        'Repeated or stalled tool calls',
        'Replay the task with a tool-call limit. Inspect the trace for repeated calls and check whether the requested action finished.',
        (
            r'(?:stuck|trapped|caught) in (?:an? )?(?:infinite |tool[- ]call |retry )?loop',
            r'(?:repeat\w*|retrying|retried) (?:the same|failed) (?:tool calls?|commands?)',
            r'(?:hung|timed out|stalled) (?:while|when) (?:calling|using|invoking) (?:\w+ ){0,2}tools?',
        ),
    ),
    (
        'Unsuccessful task action',
        'Recreate the reported action on a small fixture. Define its expected output, run the agent and inspect the actual result.',
        (
            r"(?:failed to|fails? to|unable to|couldn['’]t|could not|cannot) "
            r'(?:locate|retrieve|update|preserve|parse|compile|merge|restore|apply) '
            r'(?:[\w-]+ ){0,3}(?:files?|records?|patch(?:es)?|changes?|dependencies|symbols?|branches|state|inputs?|outputs?)',
        ),
    ),
)

RULES = [
    (check, re.compile(r'\b(?:' + '|'.join(patterns) + r')\b', re.I))
    for _, check, patterns in CHECKS
]


CLAUSE_BREAK = re.compile(r'[.!?;\n]|\b(?:but|whereas|however)\b', re.I)
# Scope negation to the left of the match, so an affirmative observation in
# another clause can still yield a check. Explicit "failed to run tests" is a
# symptom in its own right.
DISAVOWED = re.compile(
    r"\b(?:never|neither|no|not|without|no longer|\w+n['’]t|prevent\w*|avoid\w*|eliminat\w*|"
    r"mitigat\w*|reduc\w*|hypothetical|whether|could|might|may)\b"
    r"(?:[\s,-]+\w+){0,4}[\s,-]*$", re.I,
)


def signal_labels(checks):
    return [label for label, check, _ in CHECKS if check in checks]


def matching_checks(text):
    """Return each applicable local check once, in stable rule order."""
    clauses = CLAUSE_BREAK.split(text)
    return [
        check for check, pattern in RULES
        if any(
            not DISAVOWED.search(clause[:match.start()])
            for clause in clauses for match in pattern.finditer(clause)
        )
    ]

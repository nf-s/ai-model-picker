# People pipeline

The people pipeline collects the public writing of a short list of practitioners and outlets who publish their own work with these models, and asks a model to turn each passage into **use records** (a reported use, comparison or measurement of a model on a job) and **method advice** (advice on working with models that names none). The records build turns both into named records. They are served only behind sign-in; see [Privacy](#privacy-and-what-stays-on-this-machine).

Everything runs on this machine with the system `python3` and the standard library, except the paid review, which needs Anthropic's Python package (see [Review](#review)). State is kept in the ignored `.local/people/`. The commands are in `scripts/people_pipeline.py` and the code in `scripts/people_local/`. Updating step by step is in [Updating the data](updating.md#people).

```sh
python3 -B scripts/people_pipeline.py status
python3 -B scripts/people_pipeline.py collect
python3 -B scripts/people_pipeline.py review --queue-only
.local/hn/venv/bin/python -B scripts/people_pipeline.py review --backend anthropic
```

Every command accepts `--state-dir` (default `.local/people`). `collect`, `review` and `export` hold the directory's `pipeline.lock`, so a second command on the same directory stops with `already-running`. `status` takes no lock, makes no network request and changes no file.

## Who is collected

Two local files say whom to collect and how. Neither is tracked, and no tracked file names a person.

- `people.json` follows the people-file schema in `scripts/records_schema.py` and `src/lib/records.ts`: each person's or outlet's `name`, `feeds`, `sourceClass` (`first-hand` or `secondary`), `adviceOnly`, `trusted` (the trusted-list default), and the date and reason they were `added` and, when they left collection, `dropped`.
- `sources.json` gives, for each name in `people.json`, a short `key` stored on each collected item, the `byline` words that confirm authorship, the `redact` list of names and handles removed from every passage, and `discover`: which of the person's feeds to read and how. A discover entry is a `feed` (optionally only entries whose author contains `author`), a `sitemap` (links matching `include`, through nested sitemaps matching `index`), a `series` page (its links matching `include`) or a single `page`. Each has a `channel` (`site`, `newsletter`, `outlet article`). `bylineInPage` also accepts a byline word near the top of the page; `pageByline` also reads elements of class `author` and a date written in the page text; `bylineNames`, for an outlet, removes the names in each item's byline instead of the outlet's name. The full format is at the top of `scripts/people_local/config.py`.

A person is added or dropped only by editing these two files. A dropped person is not collected again; their stored records stay. A feed in `people.json` with no `discover` entry is not collected; for example, the replies, interviews and posts kept from earlier collections have no feed the pipeline reads.

## Collect

`collect` reads every discover entry of every person still collected, then each item's own page.

- One request every 3 seconds, across all hosts, with the client name `public-research-archive/1.0`, no cookies, no sign-in and no account.
- Before the first request to a host, its `robots.txt`. A page or a redirect target that it disallows is not read. Redirects are followed one at a time, so each new host's `robots.txt` is checked first.
- The date and byline come from the item's own page: its date fields, `<time>` elements or, with `pageByline`, the date shown in its text; its author fields. An item outside the window, with no date, by someone else, or with fewer than 200 characters of text is not kept, and the reason goes to `exclusions.jsonl`.
- A paid post keeps only the part a reader sees without signing in; such items are marked `public part of a paid post`.
- The window is the year before today; `--since` changes its start. `--person` limits a run to named people and `--max-requests` stops after that many requests.

An item already kept, an item by someone else and an item dated before the window are not read again. A failed request, a missing date or missing text is tried again on the next run. Items are appended one at a time, so an interrupted collection keeps what it had and a second run continues.

## Review

`review` first splits every collected item not yet prepared into passages and queues them, then prints the queue and its estimated cost. With `--queue-only` it stops there, sends nothing and needs no credential. With `--backend anthropic` it sends the queue to the Anthropic Message Batches API.

**Passages.** An item's text is cut into passages of up to 8,200 characters that overlap by 600. A passage is queued when it names a model or family from the model list, or an app or coding agent, or, from a first-hand source, uses AI wording. From a secondary source it needs a model or an app. Before a passage is queued it is redacted (see below) and checked again for anything private; an item that fails the check is counted as blocked and not sent.

**Request.** Each passage is one request to `claude-haiku-5-5`, with thinking off, the instructions marked for prompt caching, and the reply constrained by a JSON schema. The instructions ask for up to 4 use records and up to 2 pieces of method advice. A use record has the model as written, whether it names an exact version, the model id or family from the passage's candidate list, the tool, effort and other settings, a job from the job list (or `other`), the writer's task, the outcome (`worked`, `worked after rework`, `failed`, `abandoned`, `no outcome stated`), a compared model and result, the basis (`measured`, `first-hand use`, `second-hand`, `vendor statement`), sample size, scale, cost or time, a verbatim quote and a one-sentence summary. Method advice has the advice, the job it applies to (or `general`), the tool and a quote. The instructions and schema are in `scripts/people_local/review.py`; their hash is pinned there, and the pipeline refuses to run if they change, because the stored results were made with them.

**Checks.** Every reply is checked again in code: exactly the expected keys and labels, ids only from the passage's candidate list, quotes copied verbatim (ignoring whitespace) and not spanning a removed part, length limits, required text present, and no name, handle, link, contact detail or credential. Two changes are made before the check and counted: an id not in the candidate list is blanked, and a half-filled comparison is dropped. The words the model copied are kept. A reply that fails, or a request that ends in an error, is queued once more with a one-sentence reminder; a second failure leaves the passage unresolved. Expired or cancelled requests stay queued.

**Batches.** Up to 2,000 passages a batch. The command sends the queue, checks every 60 seconds for ended batches, stores their replies and writes the result files after each round. `--max-passages` caps what one run sends. `Ctrl+C` stops the command; batches already sent keep running at Anthropic and are charged, and the next `review` stores their replies before sending anything new. A batch whose creation was not confirmed blocks the next submission with `previous-submission-unconfirmed`.

**Sign-in.** The review signs in exactly as the [Hacker News pipeline](hn-pipeline.md#review-through-the-anthropic-api) does: `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` when set, otherwise the sign-in stored by `ant auth login`, at the fixed address `api.anthropic.com`. That sign-in is read by Anthropic's Python package, which is not in the standard library, so the paid step runs with the Hacker News environment's Python, `.local/hn/venv/bin/python`. Without the package the command stops with `anthropic-package-missing`; without a credential, with `anthropic-api-credential-missing`. The pipeline stores no credential.

**Measured cost.** The review of 23 November 2026 sent 18,345 passages in 10 batches plus two retry batches and cost US$1.75 at batch rates (14.1 million input tokens, 57.3 million cached input tokens and 3.0 million output tokens). 335 passages, 1.8%, were unresolved after the retry. The estimate `review` prints uses that run's cost per passage, about 10 US cents per 1,000 passages.

## What is stored

| File                                           | Contents                                                                                                                                                                                                                   |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `people.json`, `sources.json`                  | Who is collected and how (above). Written by hand.                                                                                                                                                                         |
| `items.jsonl`                                  | One line per kept item: person key, channel, link, date, title, byline names, source class, how it was found, the text as the page shows it (code included), how complete it is, its links and whether it may be about AI. |
| `exclusions.jsonl`                             | Items found but not kept: person key, link, reason and, for an item outside the window, its date.                                                                                                                          |
| `collection-summary.json`                      | Counts from the last collection and what each feed returned.                                                                                                                                                               |
| `fetch-log.jsonl`                              | Every request: address, status, size and time.                                                                                                                                                                             |
| `review.sqlite3`                               | The review checkpoint: each passage's offsets and the redacted text sent for it, its state, attempts, the validated reply and token counts; each batch's ID and state; which items have been prepared.                     |
| `use-records.jsonl`, `method-advice.jsonl`     | The validated records, each with its source's id, person key and name, source class, link, date, channel, title and the passage's offsets.                                                                                 |
| `unresolved.jsonl`                             | Passages without a valid reply: source id, offsets, attempts and the last issue.                                                                                                                                           |
| `review-status.json`                           | Counts of passages by state, records, unresolved issues, repairs, token use and cost.                                                                                                                                      |
| `review-plan.json`, `verification-report.json` | Kept from the review of 23 November 2026: what it selected, and its check of every stored reply.                                                                                                                           |
| `collect.log`, `review.log`                    | Output of the commands as [Updating the data](updating.md#people) runs them.                                                                                                                                               |

`export` writes the four result files again from the checkpoint. Raw HTML, prompts, raw replies, credentials and request headers are never written. Email addresses, phone numbers and keys are replaced when an item is collected, so `items.jsonl` holds none; names are removed only from what is sent for review. A checkpoint from the review of 23 November 2026 records its collection by a hash of the collection file; the items in that file count as prepared, and only items collected later are new.

## Redaction

Before a passage is sent: code blocks, private keys, credentials and authorisation lines, Windows home folders and links are replaced by markers; contact details by `[redacted]` or `[contact omitted]`; the writer's own name (or, for an outlet, the names in the byline) by `[practitioner]`; every other name and handle on any person's `redact` list by `[name omitted]`; `@handles` by `[handle omitted]`; and speaker labels such as `First Last:` by `[speaker]`. Markdown links whose target was removed are kept as their text, so quotes can be copied exactly. The same patterns check each reply.

## Privacy and what stays on this machine

The named records are private for the first release: use records, method advice, summaries and quotes are served only behind sign-in. The reason is that the summaries and job labels were written by the review and have not been checked by hand: in the check against 100 reference passages on 23 November 2026 about 4 in 10 extracted records did not match a reference record, and the job agreed with the reference half the time, so public cards would attribute unchecked summaries to named people. They may become public after a re-review, on the owner's word. `npm run records:build` writes them to the ignored `build/records/named-private.json`, never to `core.json`, which says only whether named records exist (`namedBehindSignIn`). No person's name, record or count per person reaches a public file. Everything under `.local/people/` stays on this machine and out of Git. The only text that leaves it is the redacted passages sent for review, with `--backend anthropic`.

## The records build

`npm run records:build` reads `.local/people/` when it exists, and only reads it. It takes `people.json`, the two record files, `unresolved.jsonl` and `review-status.json`, and stops when the record files do not match the status file, a record names a person missing from `people.json` or a model missing from the snapshot, or a label is unknown. In a worktree, `--people-root <checkout>` (by default the `--hn-root` checkout) points it at another checkout's `.local/people/`.

- **Ids.** `ur:<source id>/<n>` and `ma:<source id>/<n>`, where `n` counts that source's use records or advice in file order. They stay the same across builds and when other sources are reviewed again.
- **Keys.** An exact model in the list is `model|<id>`; an exact version outside the list keeps its own `version|<name as written>`; a record that names only a product line stays `line|<name>` and is never attached to a model. The tool adds `tool|<name>`.
- **Jobs.** The review labels a job from the earlier list of 17 jobs, in its own instructions; the label goes through the `review-job` crosswalk in `research/jobs.json` and its `replaces` map onto the approved list. It is marked `how: review`, `via: review:<label>`. `other` and `general` give no job. A label whose earlier job was split or became a field (hard reasoning, images, long agent runs, parallel work, local use) gives no job: the record needs reading until the next review (`how: pending`), and the field it became, such as setting local, is set. In a check against 100 reference passages on 23 November 2026, the review's job agreed half the time.
- **Secondary sources.** A record from a `secondary` person keeps the review's basis, but a `measured` basis is filtered as second-hand (`x.b`) and marked `x.sec`.
- **Advice only.** Use records of an `adviceOnly` person are numbered and left out; their method advice is kept.
- **Method advice** has no model key and never counts toward a model or job coverage.

`named-private.json` holds the review's model and passage counts, the people list with each person's use, advice and left-out counts, use records per job, and the records with their quotes, newest first.

## Known limitations

- One person supplies most of the records, and the review's job labels agree with a reference set about half the time. The reference labels were themselves written by AI agents reading the passages, not checked by a person. Counts must never rank a model.
- The review's labels are the earlier 17 jobs. Records whose earlier job was split or became a field need reading until a review with the approved list; changing the labels changes the instructions, so that is a new review of every stored passage (about US$2, the owner's decision).
- Line-only names are not resolved to a version by date.
- Unresolved passages are not sent a third time.
- A Unix home folder written after a space, quote or backtick (`/Users/<name>/…`) is not removed: the pattern only matches one that follows a letter or digit. The redaction is kept as the review of 23 November 2026 used it; 34 of that review's passages contained such a path. Fixing it belongs with the next full review.
- Collection reads feeds, sitemaps and pages only. Replies, interviews and posts on other sites, kept from earlier collections, are not collected again.

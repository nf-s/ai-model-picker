# Local arXiv paper index

The local index reads arXiv metadata for the same six-calendar-month window as the [HN pipeline](hn-pipeline.md) and keeps papers whose title or abstract names a tracked model or model family. It is a feed for reports reviewed by hand: its outputs and failure shortlist point to studies worth reading, and a study that controls its comparison is added to `research/reports.json` as a reviewed report. The app shows no paper, label or result from it, and `npm run build:pages` exports nothing from it. The Papers page was removed on 24 November 2026: on 23 November only 47 of 408 paper results ranked a current exact model, each from one line of an abstract. It is not a full-text search: paper bodies, PDFs and source files are never read, and a match means only that a name appears in the title or abstract.

## Run, pause and resume

The harvest uses the system Python 3 and the standard library; it needs no setup step and no model.

```sh
npm run arxiv:run
```

This runs `python3 -B scripts/arxiv_pipeline.py run`. The first run creates a checkpoint in the ignored `.local/arxiv/` directory and pins the window start. Later runs resume it: they read only days not yet complete, plus the still-open current day. `Ctrl+C`, `SIGTERM` and `--max-days` pause after the current day is saved. Use a separate state directory for a bounded validation step.

```sh
python3 -B scripts/arxiv_pipeline.py run --state-dir .local/arxiv/check --max-days 2
```

`status` prints detailed progress as JSON without taking the lock. `export` rebuilds `papers.json`, `status.json` and `failure-review.json` from SQLite. `assess` labels abstracts and records evaluation results. See [Labelling](#labelling). All four commands accept `--state-dir`. `run`, `assess` and `export` take the same writer lock, so only one of them can work on a state directory at a time. A second one exits with `already-running`.

A first full harvest of six months is paced by arXiv's three-second rule and takes on the order of an hour or more. While running, the command prints a JSON progress line and rewrites the local outputs about every 30 seconds.

## Coverage

The window starts at the start of `recent_window()`: six calendar months back in Australia/Hobart time from the first run. It is saved with the checkpoint and kept on resume. Each run extends the end to the current UTC day.

Records come from the OAI-PMH endpoint `https://oaipmh.arxiv.org/oai` in the `arXivRaw` format, one UTC datestamp day per request series (`from` and `until` set to the same day, then resumption tokens). Days are read newest first; the current day is read last and saved as `partial`, because it can still gain records. It is read again on the next run. A day with a source error is not marked complete and is retried on the next run.

An OAI-PMH datestamp is the day a record was last modified, so a day's listing also contains revisions of older papers. A paper is kept only if its first version was submitted inside the window. Older papers revised during the window are counted as scanned but not stored. When a stored paper is revised, its row moves to the newer day without duplication. A deleted record, or a stored paper whose new record is invalid, removes the stored paper, its matches and its labels.

Requests are spaced at least three seconds apart on one connection and send a fixed `User-Agent` with no contact details. HTTP 429, 500, 502, 503 and 504 and network errors are retried up to four attempts per request, waiting the larger of `Retry-After` and an exponential delay starting at 3 seconds, capped at 10 minutes. Any other HTTP status stops the run.

Roughly 2,000–5,000 OAI records are listed per weekday, and occasional bulk metadata updates of older papers list many more. About 5% of in-window papers name a tracked model or family.

Errors are reported as fixed strings, never as response text. A source error leaves the run `blocked` with the code as its reason; resume with `run`.

| Code                                   | Meaning                                                             |
| -------------------------------------- | ------------------------------------------------------------------- |
| `arxiv-oai-unavailable`                | Retries exhausted, or an HTTP status that is not retried            |
| `arxiv-oai-response`                   | Unparseable XML, missing listing or malformed resumption token      |
| `arxiv-oai-error`                      | An OAI-PMH error other than `noRecordsMatch` (an empty day)         |
| `arxiv-oai-page-too-large`             | A response over 32 MB                                               |
| `arxiv-oai-page-limit`                 | More than 64 pages for one day                                      |
| `arxiv-oai-day`                        | A malformed day value                                               |
| `no-checkpoint`                        | `status`, `export` or `assess` before the first `run`               |
| `already-running`                      | Another command holds the writer lock                               |
| `classifier-endpoint-must-be-loopback` | `assess --endpoint` is not an allowed loopback URL                  |
| `local-classifier-unavailable`         | The local model server cannot be reached                            |
| `local-classifier-response`            | The local model server returned a response with an unexpected shape |
| `pipeline-state-or-dependency-error`   | A local SQLite, file or import error                                |

## Retention

The reader keeps the identifier, title, abstract, categories, version dates and a licence URL when it matches the arXiv or Creative Commons patterns. It reads no other fields: author and submitter fields are never read, and no PDF or source file is requested. Records without valid version dates, title or categories, with a title over 1,000 characters or an abstract over 8,000 characters, are counted as `invalid`.

Every in-window paper is stored with its title and abstract, not only matched ones, so a change to the matching can be applied locally (see [Re-matching](#re-matching)). Abstracts stay in the local checkpoint and are not published.

## Matching

Matching uses the HN pipeline's alias registry: the app's model identities from `src/lib/snapshot.json` and its maintained set of historical families. Only the title and abstract are searched. The registry's own ambiguity rules apply, so names such as Gemini and Llama need nearby AI vocabulary.

An exact model name always counts. A family name counts only when the paper is in a `cs`, `stat` or `eess` category or the text has an AI cue such as "language model", "LLM" or "machine learning". Three families that are ordinary words in research prose count only in their product spelling: `MiniMax`, `Phi-<number>` or "Microsoft Phi", and `Command R`, `Command A` or "Cohere".

Limits:

- A model named only in the body of a paper is missed.
- A paper that mentions a model in passing is included, with the same weight as one about the model.
- Inside `cs`, `stat` and `eess` a family name can still have another sense. One known case: Vicuna is also the name of a RISC-V vector processor in `cs.AR` papers.
- False positives found and handled so far: "minimax" in mathematics, "phi-4" in physics field theory, "command a robot", and Gemini telescope papers. Others can remain.

## Re-matching

The registry identifier combines `MATCH_VERSION` with a hash of the alias inventory. When either changes, the next `run` re-matches every stored paper locally before harvesting new days, without reading arXiv again. It replaces each paper's matched models and families and recounts the per-day totals. Labels are kept for papers whose matched labels, title and abstract did not change; other labels are dropped and the papers are labelled again by the next `assess`. Change `MATCH_VERSION` whenever the matching rules in `scripts/arxiv_pipeline.py` change.

## Labelling

`assess` labels each matched abstract with one kind, up to three topics and an optional one-sentence takeaway, using a local model. The model sees the matched model names, the title and the abstract, and is told to treat them as data.

- Kinds: `usage`, `evaluation`, `application`, `behaviour`, `release`, `survey`, `other`.
- Topics: `prompting`, `context`, `reasoning`, `agents`, `tools`, `retrieval`, `structured-output`, `coding`, `cost`, `safety`, `multimodal`, `fine-tuning`.
- Takeaway: at most 300 characters, or null when the abstract supports no practical advice. Papers of kind `other` keep no takeaway.

The endpoint must be a plain `http` loopback address with the path `/v1/chat/completions` (OpenAI-compatible) or `/api/chat` (Ollama-compatible); the default is `http://127.0.0.1:8790/v1/chat/completions`. Requests bypass proxies and refuse redirects. Papers naming an exact model are labelled first, then newest first. A response that fails validation is asked once more with a stricter instruction; if that also fails, the paper is stored as a failure. After all unlabelled papers, each failure is retried once per `assess` invocation. An unreachable server stops the command with `local-classifier-unavailable`; labels saved so far are kept. `--workers` (1–8, default 4) sets parallel requests and `--max-papers` pauses after that many model requests. `--exact-models` limits every pass to papers that name an exact tracked model and leaves family-only papers untouched.

Labels are keyed to the assessor ID (`--assessor-id`, default `qwen3.8-27b-4bit-v1`), the model name (`--model`) and the prompt version. Changing any of them starts a separate set of labels; counts and exports show only the current set.

### Evaluation results

After labelling, `assess` reads each paper labelled `evaluation` once more and records what its abstract reports about the named models. This is the part meant to help choose a model; the general takeaways mostly do not name one.

- Area: `coding`, `agents`, `reasoning`, `research`, `writing`, `design`, `vision`, `domain`, `safety`, `other`. `domain` is a specialist field such as medicine, law or finance, `vision` is understanding images, video or audio, and `design` is generating them.
- Task: a phrase of at most 120 characters naming what was tested.
- Best and weak: the paper's own matched models and families that the abstract explicitly ranks first among the models it compares, or ranks last or clearly behind another model on the same test. The prompt forbids inferring a ranking. A model is in neither list when it is the only one tested, when its score has no comparison with another model, when it is said to struggle without a comparison, when it is compared only with the paper's own method or with people, when it is the base that the paper's method builds on, when it was used as a tool or judge, or when the abstract compares settings of that one model. A model that leads the existing models but is beaten by the paper's own method counts as best. Weak is kept only when the same abstract ranks another matched model or family best; a weak entry on its own is discarded after the response is parsed, because in the trial it mostly recorded a model behind the paper's own method. In practice the weak list often holds a close second, so read it as behind, not weak.
- Finding: one sentence of at most 300 characters, or null when the abstract reports no result for the named models.

Names the model returns are matched to the paper's targets ignoring case, spacing and punctuation. Other names are dropped, and a name in both lists makes the response invalid. Results follow the same rules as labels: one stricter second request, failures stored and retried once per invocation, and `--exact-models` and `--max-papers` apply, with label and result requests counted together. Results are keyed to the label set and `RESULT_VERSION`, so a new labelling identity or a changed result prompt starts a new set. A paper whose label is no longer `evaluation` has no result in exports.

**Current status:** on 18 November 2026 `assess` was run over the 1,383 papers that name an exact tracked model: 1,382 are labelled and 1 is stored as a failure. The 9,648 papers that name only a family have not been labelled; `--exact-models` keeps a later run to the same scope. The result pass over the 414 papers labelled `evaluation` ran the same day in two parts: 413 have a result and 1 is stored as a failure. Running the command below again retries the two stored failures and works on any papers added by a later harvest.

To run it, start a model server on loopback port 8790 first. The run used the MLX server from the HN pipeline's virtual environment with the model the HN pipeline currently uses:

```sh
.local/hn/venv/bin/mlx_lm.server --model .local/hn/models/qwen3.8-27b-4bit \
  --host 127.0.0.1 --port 8790 --log-level WARNING --max-tokens 384 \
  --chat-template-args '{"enable_thinking":false}'
npm run arxiv:assess -- --exact-models
```

Labelling took about 3.5 seconds per abstract with 4 workers on a 64 GB Apple Silicon machine (1,359 abstracts in 79 minutes). The result pass was slower while the machine was in use: 8 to 12 seconds per paper in its first part and about 7 seconds in its second (214 papers in 25 minutes). Stop the server when the run ends, and do not run it alongside the HN pipeline's model runtime: each process loads its own copy of the model. `run` and `assess` cannot run at the same time on one state directory.

## Local outputs

`status.json` holds the run state (`pending`, `running`, `paused`, `blocked` or `complete`) and its reason (`user-stop`, `day-limit` or an error code), `updatedAt`, the registry identifier, the assessor ID, `startAt`, `firstDay` and `lastDay`, and the submission times of the first and last matched papers. `totals` has `recordsScanned`, `recordsEligible` (in-window papers counted per day), `unavailable`, `invalid`, `recordsStored` (distinct in-window papers stored), `papers` (distinct matched papers), `assessed`, `assessmentFailures`, `daysComplete` and `daysTotal`. `days` lists each UTC day with its state (`pending`, `partial` or `complete`), records listed and `papers`: matched papers whose latest record is on that day.

`papers.json` holds `updatedAt`, `assessor`, `startAt` and a `coverage` summary of the same counters. `models` and `families` give each target's paper count, papers per submission month (UTC) and kind and topic counts from current labels. `papers` lists every matched paper newest first with its identifier, title, first-version submission time, categories (primary first), matched targets and label (or null). It contains no abstracts.

`failure-review.json` lists up to 50 unverified paper candidates, newest first by submission time, and counts all distinct candidates. The report refreshes when `run` finishes fetching its requested days or when `export` runs. It reads matched abstracts, including papers awaiting labelling. The review uses text rules and looks for specific failure signals in reported AI coding or agent workflow studies. An `abstract-result` comes from a sentence explicitly reporting a result. An `abstract-clue` comes from a sentence describing a failure after the abstract introduces a study. Both require checking the linked paper to confirm what was tested and what the study observed. The model and family names record mentions in the paper metadata. The report includes the source link, study scope, scrubbed title, the signals that matched and suggested local checks. It is generated without model requests, excludes abstract text and stays in the local state directory.

All of these stay in the local state directory. Nothing from the index is published: `npm run check:pages` fails if a `dist/arxiv-snapshot.json` from an older build is present. Old `#/papers` links open the Data page at the line saying why papers were removed.

## arXiv terms

arXiv's [API terms of use](https://info.arxiv.org/help/api/tou.html) apply to OAI-PMH:

- No more than one request every three seconds on a single connection, across all machines under one's control. Do not run two harvests at once, including against separate state directories.
- Descriptive metadata (titles, abstracts, identifiers, categories) is CC0 and may be stored, transformed and shared.
- E-print content (PDF and source) must not be stored and served. The pipeline does not request it.
- The project must not present itself as endorsed by arXiv.
- Linking to the abstract page is encouraged; a report added from a paper links to it.

## Tests

```sh
npm run arxiv:test
```

`tests/test_arxiv_pipeline.py` covers record parsing and the field allowlist, licence and identifier patterns, deleted, invalid and pre-window records, request pacing, retries and backoff, resumption tokens and page limits, window and matching rules including the known false positives, partial and open days, revisions and deletions, re-matching with label retention, label validation, loopback enforcement, labelling order, failure retries and the exact-model option, result validation and name matching, the result passes and their shared budget, and the export shape. `tests/test_arxiv_failure_review.py` covers eligibility, evidence strength, source attribution, redaction, ordering and the report limit.

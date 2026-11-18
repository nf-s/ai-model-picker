# Verification

Data checked 16 November 2026. Combined site checked 17 November 2026.

## Combined site

Board, Models, Discussion, Benchmark, App guide and Data were inspected in a browser at 1440 and 390 CSS pixels wide against a published-mode build with the 16 November comment index (52,712 comments). Each route rendered without console errors or page-level horizontal overflow. Checks covered the legacy `#/redesign/board` hash landing on the Board, an unknown hash falling back to the Board, an unknown benchmark identifier, Board column and leader links to benchmark pages, the all-configurations and best-per-model toggle, model links from every page, a model page's reports, an expanded App guide row, and the Data page's snapshot refresh and source search.

The Data page's local start, pause and resume controls keep the earlier dashboard's logic unchanged. They were compared against it line by line and were not exercised against a running local service after the restructure.

## Model filter

On 17 November 2026 the header filter was checked in a browser against the local app (52,690 comments) at 1440, 1280, 1024 and 800 CSS pixels wide, and at 390 against both the local app and a published-mode build. Every route rendered without console errors or page-level horizontal overflow, with the filter panel open and closed.

Checks covered a provider selection (ChatGPT and Claude: 18 of 53 Board rows on Coding, 34,482 of 52,690 comments in Discussion); an individual selection (Claude Fable 5.2 and Claude Opus 5.5), where family labels are left out; overall ranks kept in Board cells, leader panels and benchmark rows; the one-click clear; the selection surviving a reload; a page load with `localStorage` access throwing; direct links to a model and a family outside the selection on the Models, Discussion and Papers views, with the add and clear actions; and the empty sentences on the Board, a benchmark page, Discussion, Papers and the App guide.

Fourteen unit tests cover the selection rules, the mapping of family labels to providers, the narrowed comment and paper indexes, and reading and writing storage, including blocked storage and malformed stored values.

The 390-wide check found the Board's task row pushing the page 6 pixels wider than the screen, with or without a filter. The row now scrolls inside itself.

## App guide

The guide has eight chat tasks and three separate coding-agent workflows. Runtime validation checks source, model and benchmark references. Automated tests verify that every chat task has options in both apps, chat choices never silently become Codex/Claude Code settings, and coding workflows use their own choices. The page uses app picker names and labelled effort/thinking settings, with no API prices or index-based sorting.

## Local pipeline

The isolated Apple Silicon setup was exercised on the existing environment. An absent-pip failure was reproduced and fixed. Setup now seeds pip when needed. All downloaded local model files match the pinned public revision; the full weight file matches its published SHA-256. No account credentials were used.

A live source test processed 1,000 recent IDs through the bulk mirror with official fallback and the real local MLX model. After schema repairs, it classified 23 candidates with zero malformed-label failures. Resuming that checkpoint reached 1,128 IDs and 1,022 cumulative comments without duplicate counting; it had 25 valid candidates and zero failures.

Independent review found historical ID gaps, a Unicode alias edge, unsupported version suffixes, cached classifier failures and two bounded-network edges. The implementation now keeps atomic archive ID bitmaps, reconciles absent/malformed IDs, retries failed labels, excludes failed targets from evidence, handles aliases conservatively, and stops requesting pages once a budget or pause is reached. Two already-stored items affected by the suffix rule were reclassified while preserving the run cursor.

Python regression tests cover these behaviors, source boundaries, masked inputs, local-only inference, checkpoint replay and gap/resume semantics. Controller integration tests verify fixed loopback mutations, origin/host restrictions and bounded state-file access. Browser controls resumed and paused the actual job, with progress retained.

The six-month collection is incomplete. Live counters in the app are the authoritative progress report. A syntactically valid classifier output is not proof of sentiment accuracy. Inputs are short masked windows around recognized names, so implicit references, sarcasm and non-AI homonyms can be misinterpreted.

Quality checks exposed poor target attribution and lost evaluative context. The final classifier preserves more generic opinion vocabulary, sentence boundaries and quantity types, excludes ambiguous names without nearby AI context, and evaluates each target separately. Its 37-pair reference comparison produced 21 agreements, 11 disagreements (three opposite signs), three unclear labels and two missed targets. These references are prior AI assessments with fuller context, not human ground truth. A larger local model was evaluated and rejected; its downloaded weights were removed. The app displays the selected configuration's quality check, and these experimental labels do not set the task recommendations. The rejected run's generated state was archived outside Git before restarting collection with the final configuration.

## Thread pipeline

The sections above and below describe the previous analysis, which is still the one served. On 17 November 2026 its coverage of threads about a model was measured against the public archive: 7,867 stories in the window name a model in the title and hold 155,124 comments, of which the index held between 8% and 22% for four large threads. The pipeline was reworked to queue every comment in those threads and to review each comment with its story title and the text it replies to; see [pipeline instructions](hn-pipeline.md).

Python tests cover the scan, thread walks through removed comments, the review queue, retries of failed reviews, window migration, the scrubbing of links, contact details, handles, quoted lines and code before text reaches the model, and the absence of comment text in every state file. Reader, export and controller tests cover the rule that only comments with a valid assessment are listed, the new optional fields, rejection of unlisted stored values, and serving the previous analysis until the new run has nothing left to review. Against the existing checkpoint the dev index returns 52,690 comments (the 22 without a valid label are no longer listed) and validates against the app's schema.

The new run started on 18 November 2026 with the Qwen3.8 27B model. It reviews about 0.5 comments a second, so its roughly 190,000 queued comments take four to five days, and the app serves the previous analysis until it finishes. Before the run, the classifier evaluator was run for that model and for two faster ones (GLM-4.7-Flash and Qwen3.6 35B-A3B) against the same reference labels, and all three were timed on the same 248 queued comments. The 27B model agreed with 24 of 37 held-out labels and reversed none. The faster models ran at three to 4.5 times its speed but reversed signs and gave stances to comments that say nothing about the model, so they were rejected. The tables are in the [pipeline instructions](hn-pipeline.md#new-classifier). The reference labels are prior AI assessments, not human ground truth. The Discussion threads use the story and parent of each comment; the task, claim, preference and theme fields are not shown in any view yet.

An Anthropic API backend for the title checks and the review was added on 18 November 2026. Python tests run it against a stand-in client: the request shape, the fixed API address, the missing-key and unreachable-API reasons, batches that are sent, left running across a stop and stored on the next run without being sent twice, the retry of invalid and errored replies with the stricter instruction, expired requests staying queued, the budget and the cap on comments in batches, and the absence of comment text in the state files while a batch is out. No request had been made to the API when this was written, so the accepted parameters, cache behaviour, cost and label quality in this configuration are unverified.

## arXiv paper index

A full harvest on 17 November 2026 read every UTC day of the window over OAI-PMH: 314,096 records listed, 206,286 in-window papers stored, 71 records rejected as invalid and none deleted. 11,031 papers name a tracked model or family (57 models, 69 families); 1,383 of them name an exact tracked model. No weekday in the window is empty. The still-open final day held no records and is read again on the next run.

The run was paused at 143 days after the matching rules and the HN alias matcher changed. The 175,109 papers stored by then were re-matched locally without reading arXiv again, and the harvest resumed from its checkpoint to completion.

Matches were spot-checked on a partial index by reading four random matched papers for each of 44 family names. One had another sense: Vicuna, a RISC-V vector processor. Earlier readings of the largest families found "minimax" in mathematics, "phi-4" field theory, "command a robot" and Gemini telescope papers, which the rules now exclude. No precision or recall figure was measured, and exact-model matches were not sampled.

The labelling step was tried on 16 abstracts with a local Qwen3.8 27B model in 97 seconds with no invalid responses. The labels were read by hand, not scored. One position paper was labelled as a release, after which the `survey` kind was added and the definitions were tightened. The revised prompt was then tried on 24 abstracts in 90 seconds, and those labels were also read by hand.

On 18 November 2026 the revised prompt was run over the 1,383 papers that name an exact tracked model, with the same model and 4 workers: 1,381 labelled and 2 stored as failures after two attempts each, at about 3.5 seconds per abstract. One of the two was labelled when a later run retried it, leaving 1,382 labelled and 1 failure. The 9,648 papers that name only a family were left unlabelled. Kinds: 529 application, 414 evaluation, 230 usage, 160 behaviour, 27 other, 19 release and 2 survey; 1,354 labels carry a takeaway. 24 random labels were read by hand and looked plausible. None were scored, so there is no accuracy figure.

The evaluation-result prompt was tried on 18 November 2026 on 24 evaluation abstracts. Read against the abstracts, the first version marked the only model tested as best, treated "struggles" as weak and gave one family result to the wrong model. The rules were tightened and the same 24 re-extracted with no failures. A wider run was stopped at 68 results after reading them found a fine-tuning backbone marked best, one model's reasoning levels ranked against each other, and weak used for models behind the paper's own system. The exclusions were then listed one by one in the prompt and the 68 re-extracted: 10 changed, the backbone error remained and weak was still unreliable. A fixed rule was added that discards a weak list when the same result has no best.

The result pass was then stopped by request at 199 results and 1 failure out of 414 evaluation papers. Areas: 61 agents, 33 coding, 22 domain, 21 reasoning, 19 vision, 18 safety, 9 research, 7 other, 5 design, 4 writing. 133 results name a best model and 48 a weak one. Thirty random results were read against their abstracts by the AI assistant that wrote the pipeline, not by a person. All 30 findings restated the abstract correctly. Of 19 best lists, 16 rested on an explicit ranking, 2 were thin (a second place, and "on the Pareto frontier") and 1 was unsupported. Of 7 weak lists, 4 named models the abstract ranks last or far behind and 3 named a close second or a model behind non-LLM systems, which is why the views label that list Behind. At least one result left out a best that the abstract states. This is one reader and 30 results, so it is not an accuracy figure.

Python tests cover the reader, window, matching rules, resume, re-matching, label and result validation and the publish export; see [arXiv pipeline instructions](arxiv-pipeline.md). The local index and the publish export of the finished checkpoint both validate against the app's schema, before and after labelling and with the 199 results, and the publish export contains no abstract field.

The Papers page was inspected in a browser at 1440 and 390 CSS pixels wide against a partial index: a model deep link, a family deep link, title search, target chips, paging, the model and family counts and clearing filters. It rendered without page-level horizontal overflow. The finished index was then loaded in the running development app without console errors. A published-mode build was not viewed. With the 199 results loaded, a model page, the Board's Coding table and a Papers link filtered to one area were viewed in the development app at desktop width, and the model page and Papers page at 375 CSS pixels, without page-level horizontal overflow or console errors.

## Supporting data

Existing benchmark and pricing tests still pass: identifiers and source relationships, invalid URLs/numbers, duplicate IDs, required cost methods, trial denominators, matched configurations, price thresholds, date-dependent rates, context types, missingness, ECI scales and historical model identity.

The earlier 49-comment AI-reviewed sample is no longer shown in the app and is not combined with the automatic six-month counts. Its comment timestamps and ancestry were checked against the official API in a prior update.

TypeScript/Vite build and formatting are checked before commit. Vite emits a non-blocking bundle-size advisory because the static source snapshot is bundled. Local classification uses no paid inference or paid data query.

## Six-month scope and in-app comments

The paused checkpoint was migrated to 16 May–16 November 2026 in Hobart time, preserving 252,118 scanned comments and 6,461 candidates. The May starting ID was checked against live archive metadata and a bounded source read. SQLite contains zero out-of-window candidates. Tests cover calendar-month boundaries, clipped archive offsets, in-range reconciliation, migration/resume and classification timestamp guards. Unbounded Firebase diagnostics are rejected before source requests.

Reader tests exercise all candidate pages beyond the former 12-ID preview, source/date filters, per-item retries, unavailable ancestors, nested replies and stable reply pagination after ranking changes or deletion. Public bodies remain inside the local app: verification emits only metadata and uses synthetic comments for visual inspection.

## Pages build

The hosted mode uses a small summary snapshot and a lazy-loaded candidate index, with public discussion text fetched on demand. Export tests cover inclusive date boundaries, classifier isolation, failed-label exclusion, blocked private metadata, and a concurrent SQLite writer without mixing revisions. Reader tests cover snapshot revision mismatches, pagination and paired model/sentiment filters. The shared item reader retains the local reader's context, reply and failure checks.

The release export contains 52,712 distinct candidates and 52,655 completely classified comments. All 118 source sections have been processed; 57 comments retain unresolved classification failures. The UI reports that distinction. Summary and candidate assets are approximately 220 KB and 11.4 MB, both below Pages' per-file upload limit. They contain no raw source text or author fields.

The Pages release procedure checks crawler rules, response headers and the production browser experience separately; see [deployment](deployment.md). Real-source checks report metadata only, and visual checks use synthetic bodies.

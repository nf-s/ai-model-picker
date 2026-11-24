# Local Hacker News analysis

The local pipeline reads the last six calendar months of HN items, finds discussions about named models, apps and model families, and asks a model what each comment says about them. The model is a local one by default; a Claude model through the Anthropic API is the alternative. Open **Data** for collection status and controls.

## Why the pipeline changed

The previous pipeline (`v3`) queued a comment only when the comment's own text named a model, and its classifier saw only allowlisted words in a short window around the name. In the six-month window (2,365,587 items, 15 May to 16 November 2026 UTC) it queued 52,712 comments. Replies in a thread about a model usually do not repeat its name, so most of those threads were missed. Measured against the public archive, 7,867 stories name a model in the title and hold 155,124 comments. The index held about 20% of the Claude Opus 5.5 thread (227 of 1,116 comments), 8% of GPT-6 Astra (162 of 2,047), 22% of "Why does Opus 5 feel worse to work with?" (190 of 870) and 11% of Gemini 4 Argon (133 of 1,177).

The current pipeline, `hn-thread-v1`, also collects every comment in a thread whose story title names a model, and gives the local model the comment, the text it replies to and the story title.

## How a run works

One `run` performs three resumable phases in order. Each phase saves its progress to the checkpoint, so a stopped run continues where it left off.

1. **Scan** (no model). Reads the same sources as before. It queues in-window comments whose text names a model or family, and records in-window stories and polls whose title names one. A title whose only match is an ambiguous bare name, such as a word that is also an ordinary word or a person's name, is marked uncertain.
2. **Threads**. For each recorded story, the pipeline walks the story's replies through the official HN API and queues every available in-window comment, with the story as its root. Replies under removed comments are included. An uncertain title is first checked by the local model, which answers yes or no to whether the title uses the name in its AI sense; stories answered no are not walked.
3. **Review**. For each queued comment, newest first, the pipeline reads the comment and the comment it replies to from the official HN API, finds its story, and asks the local model what the comment says about each target. Targets are the story's subject models, models named in the comment and models named in the replied-to text, at most 8 per comment.

For each target the review stores a stance (positive, negative, mixed or neutral), up to three themes and a confidence (high, medium or low). An opinion given with low confidence is stored as unclear. For each comment it stores a job, a setting, a run, a one-sentence claim written by the model (at most 240 characters) and any explicit "A is better than B" preferences. A comment that says nothing about any target is kept as reviewed, with no assessments, and is not listed anywhere. An invalid model reply is retried once with a reminder; if the second reply is also invalid, the comment is counted as failed and retried in a later pass. Unresolved failures leave the run blocked and eligible to resume.

Themes are fixed: `code-quality`, `agentic-work`, `instruction-following`, `hallucination`, `regression`, `rate-limits`, `pricing`, `speed`, `context`, `reasoning-depth`, `writing-style`, `frontend-design`, `refusals`, `benchmarks`, `availability`, `harness`, `model-choice`, `local-use`, `policy` and `release`.

The job is one of the 13 approved jobs in `research/jobs.json` (`code`, `debug`, `review`, `plan`, `interface`, `research`, `documents`, `extraction`, `writing`, `maths`, `chat`, `read-media`, `make-images`) or `none`. The reviewer reads a one-line definition of each and the rules of the job list: a sub-job of code wins when the comment is about that part, media turned into text is `read-media`, prose from supplied material is `documents` and labels or rows are `extraction`, research needs the model to search, maths needs a checkable answer, a drawing test such as the SVG pelican is `none`, and a comment about the model in general (price, speed, release, benchmarks, safety, refusals, the company) is `none`. `setting` is `local` when the writer runs the model on their own hardware or from downloaded weights, and `run` is `unattended` for long runs with no one steering or `parallel` for subagents or several sessions at once; both are empty otherwise, and neither decides the job. A reply with a job, setting or run outside these lists is invalid. A test checks that the reviewer's jobs are the job file's.

The job is stored in the `task` column. Reviews made before the job list, by the classifiers whose IDs end in `-thread-v1`, hold a task instead: `coding`, `agents`, `design`, `writing`, `research`, `reasoning`, `images`, `chat` or `other`, and no setting or run. Nine topic values (`coding`, `reliability`, `cost`, `speed`, `design`, `agents`, `writing`, `research`, `reasoning`) are derived from the job or task, the run and the themes; a comment shows them as tags only when its label has no themes. The records build maps the stored value to a job through the job file's `hn-task` crosswalk, except that a comment whose claim the drawing-test rule tags has no job whatever its stored job (see [data provenance](data.md#shared-records-and-the-job-list)); the export keeps the stored value. The lists and the mapping are in `scripts/hn_local/classify.py`.

## Start, pause and resume

On Apple Silicon, run `npm run hn:setup` once and then `npm run dev`. Open **Data** and select **Start six-month scan**. The local control service starts the model server, stays up when the browser closes and provides **Pause** and **Resume scan**. If the control service or computer stops, reopen the app and resume from the last saved checkpoint.

To run from a terminal once the local model is listening on port 8788:

```sh
.local/hn/venv/bin/python -B scripts/hn_pipeline.py run --state-dir .local/hn/threads
```

Use a separate state directory for a bounded validation step.

```sh
.local/hn/venv/bin/python -B scripts/hn_pipeline.py run \
  --state-dir .local/hn/check \
  --max-items 1000 \
  --max-classifications 50
```

The same command without the limits resumes that directory's entire run. `Ctrl+C`, `SIGTERM`, `--max-items` (source rows) and `--max-classifications` (comment reviews) pause at a checkpoint. `--classifier-workers` sets the number of parallel model requests (default 8). `--collect-only` runs the scan and lists the threads whose titles are unambiguous without calling the model, then pauses with the reason `collect-only`; a later `run` without it checks the uncertain titles and reviews the queue. `status` prints detailed progress. `export` regenerates the local `status.json`, `results.json` and `failure-review.json` from SQLite. Both commands accept `--state-dir`. All flags are defined in `arguments()` in `scripts/hn_pipeline.py`.

`context` stores the parent and story IDs, and the story title, for comments that have no story recorded, such as those in the previous analysis, which predates these columns. It reads the comments and their ancestors from the official HN API one thread level at a time, 256 comments per page, newest first, and does not call the model. It changes no review, assessment or existing story. A comment whose story cannot be found (removed item, broken chain or more than 128 levels) keeps no story. It prints a line of counts per page; `Ctrl+C` or `SIGTERM` stops after the current page, and running it again only reads comments that still have no story. It accepts `--state-dir`, `--workers` and `--max-firebase-requests`, and like `run` it holds the state directory's lock, so it cannot run while another command uses that directory.

```sh
.local/hn/venv/bin/python -B scripts/hn_pipeline.py context --state-dir .local/hn
```

`extend` brings a run up to date without reviewing it again. It moves the end of the saved window to the present and adds the HN items posted since the run's last item as new partitions. Walked stories created in the last 30 days of the old window are set to be walked again, because their threads can have comments posted after the old end; in the first run no thread older than 30 days had a comment more than 28 days after its story. The command reads only the current maximum item ID from the official API and calls no model. The next `run`, with the same backend as before, scans the new items, walks the new and recent threads and reviews only comments that have no review. A story walked before is not sent for a title check again, because its title was accepted then. Every existing review is kept. The window's start does not move, so an extended window is longer than six months. It refuses a run whose target names have changed since it was scanned, because `run` would then refuse to finish it; it stops with `checkpoint-configuration-mismatch` and changes nothing. It accepts `--state-dir` and holds the directory's lock.

```sh
.local/hn/venv/bin/python -B scripts/hn_pipeline.py extend --state-dir .local/hn/threads
.local/hn/venv/bin/python -B scripts/hn_pipeline.py run --state-dir .local/hn/threads --backend anthropic
```

`retarget` keeps a run when the model list changes, instead of reviewing every comment again. The list is the `models` array in `src/lib/snapshot.json` together with the name tables and `MATCHER_VERSION` in `scripts/hn_local/classify.py`; raise `MATCHER_VERSION` when the matching rules change without a change to the names. The command finds the list the run was scanned with in Git, at the newest of the last 50 commits that changed those files whose list gives the run's scan key (`previous-targets-not-found` when none does), and checks that the run's classifier and model match `--backend`, `--model` and `--classifier-id`. It then moves every stored review to the new list and sets the whole window to be scanned again. A retarget before the previous one's scan has finished adds its new targets to that one's. It refuses a list that removes a target some review refers to (`removed-target-has-reviews`), an unchanged list (`targets-unchanged`) and a run with batches still out. Every story in the window whose stored title now names a target it was not stored with, by a new name or by new matching, has its thread's comments queued to be reviewed again with that target as the story's subject; a story that was not walked is judged and walked. The next `run` scans the window, which calls no model, and queues comments that are new to the run and reviewed comments whose text names a new target. Threads it walks that are about a new target have their reviewed comments queued too. Every other review is kept, so a reviewed comment that uses a new spelling of a target that existed before keeps its review, unless its thread is queued again. `run --collect-only` stops after the scan and the thread walks that need no title check, so the queue can be counted before anything is sent to a model.

```sh
.local/hn/venv/bin/python -B scripts/hn_pipeline.py retarget --state-dir .local/hn/threads --backend anthropic
.local/hn/venv/bin/python -B scripts/hn_pipeline.py run --state-dir .local/hn/threads --backend anthropic --collect-only
```

`rereview` reviews a finished run again after a change to the review itself, such as its instructions, without scanning or walking threads again. It takes the classifier ID that `run` will use (`--backend`, `--model` and `--classifier-id`, as for `run`), moves every stored review to that classifier and queues every comment in the window. The next `run` with the same options reviews them all, through the batch interface with `--backend anthropic`. Each comment keeps its earlier review until the new one is stored over it; a comment whose new reviews all fail loses it. The command refuses a run that is not finished (`run-unfinished`), whose target list has changed since its scan (`checkpoint-configuration-mismatch`: retarget first) or whose classifier is the one given (`classifier-unchanged`). It calls no model and holds the directory's lock. Copy the checkpoint first: the earlier reviews are not kept anywhere else. The whole procedure, with a pilot, is in [Updating the data](updating.md#when-the-comment-review-changes).

```sh
.local/hn/venv/bin/python -B scripts/hn_pipeline.py rereview --state-dir .local/hn/threads --backend anthropic
.local/hn/venv/bin/python -B scripts/hn_pipeline.py run --state-dir .local/hn/threads --backend anthropic
```

While an extended, retargeted or re-reviewed run is unfinished, the app and the export use the previous analysis, as for any unfinished run (see [Runs, models and files](#runs-models-and-files)). The full update procedure, with the copy made first, the expected output and what to do on each error, is in [Updating the data](updating.md#hacker-news-comments).

## Failure review

When a review run finishes, including with `classification-unresolved`, it writes `failure-review.json` in its state directory. To rebuild the report from reviews already stored in a checkpoint, run `export` with the same `--state-dir`. Building the file makes no requests to HN or a model. The file stays local.

The report counts the matching comments in the saved window and lists up to 50, newest first. Each has the comment's direct HN link and timestamp, an assessed model or family, the classifier's summary and suggested local checks. A comment needs a concrete failure signal in the summary and a single critical target assessed with medium or high confidence in a coding or agent workflow. The report skips comparisons and claims with conflicting model names. If the claim names no target, the report marks the attribution as coming from review context.

Follow the link to check what happened, who or what the comment attributes it to, and whether it gives enough detail for a local check. The summaries can miss or misread failures. Counts describe the shortlist criteria and coverage of this checkpoint. They cannot measure failure rates or compare models.

## Review through the Anthropic API

`--backend anthropic` sends the title checks and the review to the Anthropic API instead of a local model. It is paid, and it sends text off this machine: the scrubbed story title, replied-to text, comment and target names described under [what the model reads](#what-the-model-reads-and-what-is-stored), to `api.anthropic.com`. The address is fixed in the code, so an environment setting cannot redirect it. The Data page controls start only the local backend; this one runs from a terminal.

```sh
.local/hn/venv/bin/python -B scripts/hn_pipeline.py run \
  --state-dir .local/hn/threads \
  --backend anthropic
```

The app reads only `.local/hn/threads/`, so use that directory for a run the app should show and serve. Move a run made with another classifier out of it first, because `run` refuses to continue one. While the directory holds a run whose classifier is not the local one, the Data page shows its progress with the controls disabled, `/api/hn/start` answers 409 and `runner.external` is true.

The default model is `claude-haiku-5-5` and the default classifier ID is `claude-haiku-5.5-jobs-v1`; `--model` and `--classifier-id` change them. The command uses the `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` environment variable if one is set, and otherwise the sign-in that Anthropic's `ant` CLI stores under `~/.config/anthropic/`. The pipeline writes none of them anywhere. Sign in once, in a terminal:

```sh
brew install anthropics/tap/ant
ant auth login
```

The sign-in opens a browser and is tied to one Console organization and workspace, whose credit the run spends. It does not last long: the sign-in made on 18 November 2026 could no longer be renewed on 20 November. With no credential the command stops with `anthropic-api-credential-missing`. With a sign-in that can no longer be read or renewed it stops with `anthropic-api-credential-failed`; run `ant auth login` again and resume. A sign-in profile cannot change the address either: requests still go to `api.anthropic.com`.

An API key works instead of the sign-in. On macOS it can stay in the login keychain and be passed for one command only:

```sh
security add-generic-password -U -a "$USER" -s ai-help-anthropic-api-key -w
ANTHROPIC_API_KEY="$(security find-generic-password -a "$USER" -s ai-help-anthropic-api-key -w)" \
  .local/hn/venv/bin/python -B scripts/hn_pipeline.py run --state-dir .local/hn/threads --backend anthropic
```

The first command asks for the key without showing it.

Uncertain titles are checked with one request each. The review uses the Message Batches API, which costs half the standard rate and returns results within a day, usually within an hour. The pipeline reads comment text from the official HN API, sends batches of up to 5,000 comments, keeps at most 100,000 comments in batches at a time and checks every 30 seconds for batches that have ended. Requests use the same instructions and prompt as the local model, with thinking turned off and the shared instructions marked for prompt caching. Each reply is validated exactly as a local reply is.

A reply that fails validation, or a request that ends in an error, counts as a failed attempt. Failed comments are sent once more in a later batch with the stricter instruction, and what still fails leaves the run blocked and eligible to resume. Requests that expire or are cancelled stay queued for the next `run`. `--max-classifications` caps the comments sent in one invocation.

`Ctrl+C` or `SIGTERM` pauses the command but leaves the batches already sent running at Anthropic, where they are still charged. The next `run` stores their results before sending anything new. Results stay retrievable for 29 days. If the command dies between a batch's creation and the write that records it, that batch is charged but never read, and its comments are sent again.

After each stored batch the command prints a line with the batch ID, the number of reviews stored and the running token counts for the invocation (`inputTokens`, `cacheReadTokens`, `cacheWriteTokens` and `outputTokens`). The counts include the title checks made earlier in the same invocation.

The run the app serves was reviewed this way on 19 November 2026 with Claude Haiku 5.5. It sent 186,960 comments in 38 batches and the 707 invalid replies in one more, finished in 1 hour 56 minutes and cost about US$6.94 at batch rates. That evening `extend` brought it up to date: the next run reviewed 2,680 newer comments in one batch and sent the failed ones once more in another, in about 50 minutes, for about 12 US cents. 311 comments still have no valid review. On 21 November 2026 it was retargeted twice for a longer model list, whose two runs sent 11,577 comments for review, some of them reviewed before, for about 47 US cents in all. On 24 November 2026 `rereview` and one run reviewed all 194,648 comments again with the approved job list, as `claude-haiku-5.5-jobs-v1`, in 40 batches for about US$8.24; 448 still have no valid review. The measurements are in [verification](verification.md#thread-pipeline) and [the re-review record](verification.md#hacker-news-re-review-of-24-november-2026).

## Runs, models and files

All local state is in ignored `.local/hn/` directories.

| Path                                 | Contents                                                                                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.local/hn/`                         | The previous analysis: `checkpoint.sqlite3`, `status.json` and `results.json`, produced by classifier `qwen3-4b-instruct-2507-4bit-v3`. No longer served.           |
| `.local/hn/threads/`                 | The `hn-thread-v1` run, reviewed locally or through the Anthropic API, with the same three files. The current one was reviewed by Claude Haiku 5.5 through the API. |
| `.local/hn/threads-before-extend/`   | A copy of that run's three files made before `extend` on 19 November 2026.                                                                                          |
| `.local/hn/threads-backup-<time>/`   | The copy made before each later update, as in [Updating the data](updating.md#2-copy-the-checkpoint).                                                               |
| `.local/hn/models/qwen3.8-27b-4bit/` | Model weights from `mlx-community/Qwen3.8-27B-4bit` at a pinned revision with checksums. The download is 16.1 GB; the licence is Apache-2.0.                        |

The classifier ID for a local run is `qwen3.8-27b-4bit-jobs-v1`, and for a run through the Anthropic API `claude-haiku-5.5-jobs-v1`. The IDs ending in `-thread-v1` name the reviewer that gave each comment a task instead of a job; the paused local run in `.local/hn/threads-27b/` was made with `qwen3.8-27b-4bit-thread-v1`, so resuming it needs `--classifier-id qwen3.8-27b-4bit-thread-v1` and the code of that time. The local model is served through an OpenAI-compatible loopback endpoint. The CLI also accepts an Ollama-compatible loopback endpoint with `--endpoint`, `--model` and `--classifier-id`. A checkpoint is tied to one classifier, pipeline version and target list; `run` refuses a mismatch, so use a separate state directory when any of them changes. The exception is a checkpoint that no model has touched, such as one made with `--collect-only`: its queue does not depend on the model, so `run` continues it with a different classifier.

The controller and the export use `.local/hn/threads/` once all its partitions are complete, no stories are pending and no comments are queued. Unresolved failures do not hold that back. Until then the app, the dev API and the export keep using the previous analysis, the Data page status shows the new run's progress and `runner.showingPrevious` is true. The switch happened on 19 November 2026, when the review through the Anthropic API finished.

The scan uses no paid model API, and neither does the local backend. Collection transfers only the selected archive portions, recent data and scoped gap checks; the thread and review phases add official API requests for each walked story and each reviewed comment and its parent. The 6.8 GB full-archive measurement in the source audit is not the current run target.

## Coverage

The default plan uses six calendar months in Australia/Hobart time, from midnight on the starting date to the time the run starts. The served run's saved window was **17 May–17 November 2026** when it was first reviewed, and each update with `extend` moves its end; the first moved it to 19 November 2026, 21:40. The Data page shows the current range. The previous analysis covered 16 May–16 November. A new run pins its own window when its first `run` starts. `startAt` and `endAt` expose the inclusive UTC bounds; the app displays Hobart dates. Resume preserves the saved window; only `extend` moves its end.

Recent records come from bounded ranges in the public ClickHouse HN mirror, with official Firebase lookups for missing or malformed items. Archive selection excludes months before the cutoff. The boundary month is trimmed using ID/time metadata before comment text is read. The scan and thread walks check each comment's timestamp, so a reply outside the window is not queued even when its story is inside it. Archive gap reconciliation starts at the first in-scope ID, not ID 1.

Existing compatible checkpoints migrate automatically on `run`, keeping source cursors. To apply the date scope while paused:

```sh
.local/hn/venv/bin/python -B scripts/hn_pipeline.py migrate
```

When the previous checkpoint was migrated to six months, it retained all 6,461 existing candidate comments and its plan dropped from 352 to 118 source sections. The May boundary begins at ID 48,148,697.

Source counters include non-comment and unavailable items. Dates encountered and partial counters do not prove collection is complete. The archive/mirror may reflect earlier wording or visibility. [Archive verification](hn-archive-check.md) records source availability. Direct `--source firebase` diagnostics require both `--first-item` and `--last-item`; an unbounded official scan is rejected.

## What the model reads and what is stored

The model reads real public comment text, the replied-to text and the story title. Before they reach the model, HTML markup, quoted lines (lines starting with `>`), blockquotes and code are dropped, and links, email addresses, @handles, phone-like numbers and "my name is ..." clauses are replaced with `…`. Hyphens and dashes other than the ASCII hyphen, such as the non-breaking hyphen in "GPT‑6.2", are read as hyphens when names are matched. Long texts are shortened, keeping their start and end: the comment to 2,400 characters, the replied-to text to 700 and the title to 200. The local model runs only on a loopback address; the endpoint check rejects any other host. With `--backend anthropic` the same scrubbed text goes to the Anthropic API instead. Author fields are never read.

Raw comment text, prompts and model replies stay in memory and are never written to disk on this machine. The checkpoint stores source partitions, counters, timestamps, item IDs, each comment's parent and root story IDs, the target, stance, themes, topic values and confidence of each assessment, and each comment's task, claim and preferences. It also stores the scrubbed titles of recorded stories and of stories that hold a queued comment, and the model-written claims. Claims are scrubbed of the same personal details again before they are saved. A compact bitmap tracks historical ID coverage.

The `hn-thread-v1` checkpoint adds `parent`, `root`, `mention`, `task`, `claim`, `setting` and `run` to the `comment` table, `themes` to the `assessment` table, and the `story` and `preference` tables. Older checkpoints gain the new columns on open. The `batch` and `batch_request` tables hold, for each batch whose results are not stored yet, its ID and the item, parent and story IDs and target list of each comment in it.

Each scan block commits its queued comments, recorded stories, ID coverage and scan cursor together; each review page commits its reviews together. Replaying a block or page after interruption replaces the same item's reviews rather than duplicating them. The results count distinct items per target and can include multiple perspectives from one discussion. `classified` counts reviewed comments, `classificationFailures` counts comments whose last reply was invalid and `commentsQueued` counts comments awaiting review. `commentsAboutTargets` counts comments with at least one valid assessment. `stories` counts recorded stories that are pending or walked, `storiesPending` those not yet walked and `threadComments` the comments queued from walked threads. `failures` includes source interruptions.

Use the counts to find examples and recurring topics among the people who commented on HN. The model explorer presents benchmark results as a separate source of evidence.

## Known limitations

The local review is slow. On an M4 Max with 64 GB the 27B model reviews about 0.5 comments a second with 8 parallel requests, and more parallel requests did not raise that, so the roughly 190,000 queued comments take four to five days. Two faster local models were tested on 18 November 2026 and rejected for label quality (see below). Through the Anthropic API the same queue took under two hours.

The classifier of the served run, Claude Haiku 5.5, differs from the reference labels in about a third of checked pairs and leans neutral: 11 of its 12 holdout disagreements returned neutral for a positive reference (see below). Thread walks depend on the official HN API at the time of the run, so comments deleted since posting are missed. Outside threads whose title names a model, a comment is found only when its own text names one.

A comment whose scrubbed text is only the mark for a removed link leaves the model nothing to label, and Haiku 5.5 tends to say so in a sentence before the JSON, which fails validation. Most of the 331 unresolved failures of the first review were such comments, and another 34 were refused by the model with no output. After the first update's retry 311 remained; the re-review of 24 November 2026 left 448. Each update sends them once more.

## In-app comment reader

`GET /api/hn/comments` reads the served run's comments inside its saved date range. It lists a comment only if it has at least one valid assessment, so queued, failed and no-opinion comments are not shown. It accepts model/family and sentiment filters and paginates by descending item ID.

`GET /api/hn/index` returns the metadata for every listed comment in one response, with no comment text: item ID, timestamp and valid assessments. It takes no parameters. The evidence drawer, the thread reader under a model's Crowd band and the Data page's Crowd counts within the filters read it, and only when asked; Brief, Model, Switch and the App guide count labels from `core.json`, which the records build writes from the same checkpoint. The published build reads the same shape from the exported comment index.

Both endpoints and the export add optional fields for reviews made by `hn-thread-v1`; data from the previous analysis keeps its shape, except that `story` and `parent` appear once `context` has filled them in.

- Per comment: `story` (root story ID), `parent` (ID of the item it replies to), `task` (the job, or the earlier task), `setting` and `run` (only when stated), `claim` and `prefers` (`winner` and `loser` targets).
- Per assessment: `themes`.
- Top level of the index: `stories`, each with `id`, `title`, `createdAt`, `about` (the story's subject targets) and `comments` (its listed comments).
- Status totals: `commentsQueued`, `commentsAboutTargets`, `stories`, `storiesPending` and `threadComments`.

The thread reader uses `story`, `parent` and `stories` and can list each comment as its `claim`. The records build counts `themes` and `prefers` per target into `core.json`, and maps `task` (and, where the task gives no job, the first theme) to a job through the job file's crosswalk. See [design notes](design.md#themes-claims-and-preferences) and [data provenance](data.md#shared-records-and-the-job-list).

The service fetches public bodies only when they are requested for display. It strips account fields, decodes markup to plain text and sends responses with `Cache-Control: no-store`. React renders escaped text. Bodies fetched for display are not written to checkpoint files or logs. A five-minute memory cache is limited to 512 items and 8 MB.

The [published app](https://ai-model-picker.pages.dev/) uses the same reader with an exported comment index and direct browser requests to HN. It displays the snapshot publication time, does not poll the local controller, and has no start/pause controls. For a run made by `hn-thread-v1`, the published files also include scrubbed story titles, claims, themes, task, preferences and the story ID. Rebuilding and publishing updates its results. The served run was published on 19 November 2026, with its comments split across four files, and again after its extension that evening. See [deployment](deployment.md).

Thread requests follow parents to the root, with a bounded ancestry walk and an explicit incomplete-context flag. Replies paginate by ascending ID so changes in HN ranking cannot skip existing replies. Each branch can be expanded inside the app. Individual fetch failures leave retryable placeholders and do not block later pages. Deleted content is unavailable. Parent and reply context can fall outside the collection window; browsing it does not classify it or alter coverage counts.

## Agreement with reviewed feedback

`research/hn-classifier-check.json` describes the classifier of the served run, `claude-haiku-5.5-jobs-v1`. It holds the holdout row of that classifier's stance check, which is under [New classifier](#new-classifier), with the pair that got no stance counted as unclear. Its `backend` is `local` or `anthropic`, as in the pipeline's `--backend` option, and a local record also gives the size of the model download. Its optional `jobs` block holds the job check: comments in the reference, how many got the reference job from this classifier, and how many the earlier review's tasks gave through the crosswalk; the Data page shows it with the reference's description. The export refuses a run whose classifier ID differs from the record. The first table below describes the previous classifier, `qwen3-4b-instruct-2507-4bit-v3`.

The 16 November 2026 check compared local labels with the app's prior AI assessments for explicit exact-model mentions. Comments were split by item ID. The development sample contains 20 comments stratified by reference sentiment. The remaining 24 comments contribute 37 held-out assessments, which also informed the choice between the trial configurations. The reference labels have no independent human validation.

| Sample      | Assessed pairs | Agreed | Differed | Opposite sign | Unclear | Target missed |
| ----------- | -------------: | -----: | -------: | ------------: | ------: | ------------: |
| Development |             20 |      8 |        9 |             3 |       2 |             1 |
| Holdout     |             37 |     21 |       11 |             3 |       3 |             2 |

Four development disagreements narrowed a mixed reference to a single sentiment. Among the 11 holdout disagreements, three reversed the reference sign, five returned mixed and three returned neutral. The holdout references were positive or negative. The ambiguity filter excluded three synthetic non-AI mentions from aggregate counts.

On the same holdout, the earlier grouped 4B requests agreed with 20 of 37 reference assessments and reversed six signs. A focused 30B trial agreed with seven and labeled 20 of the differing pairs mixed. The previous scan used focused 4B requests. Treat the local polarity estimates as experimental and consult original comments when drawing conclusions.

Run the evaluation while the local model is listening, or with `--backend anthropic` and an Anthropic credential, which makes about 45 paid requests (under one US cent with Haiku 5.5) and adds the token counts to the output. It reads original items transiently and prints aggregate counts and a confusion matrix. Subsequent edits or deletions on HN can change the comparison.

```sh
.local/hn/venv/bin/python -B scripts/evaluate_hn_classifier.py
```

With `--ids`, a JSON list of comment IDs, it instead reviews those comments of a checkpoint (`--state-dir`, read-only) as `run` would, in batches with `--backend anthropic`, retries invalid replies once and writes each one's job, setting, run and stances to `--output`, with no comment text. With `--reference`, a JSON object of comment ID to `job`, `setting` and `run`, it adds agreement counts and a job confusion table. The pilot for a new review uses it: see [Updating the data](updating.md#when-the-comment-review-changes).

### New classifier

`scripts/evaluate_hn_classifier.py` targets the `hn-thread-v1` reviewer. On 18 November 2026 it was run against the same reference labels for the selected model and for two faster candidates. All three are 4-bit MLX builds. A reply that is still invalid after one retry counts as failed.

| Model                  | Sample      | Assessed pairs | Agreed | Differed | Opposite sign | Unclear | Failed | Target missed |
| ---------------------- | ----------- | -------------: | -----: | -------: | ------------: | ------: | -----: | ------------: |
| Qwen3.8 27B (selected) | Development |             20 |     12 |        7 |             0 |       0 |      0 |             1 |
| Qwen3.8 27B (selected) | Holdout     |             37 |     24 |       11 |             0 |       0 |      0 |             2 |
| Qwen3.6 35B-A3B        | Development |             20 |     12 |        7 |             1 |       0 |      0 |             1 |
| Qwen3.6 35B-A3B        | Holdout     |             37 |     25 |       10 |             5 |       0 |      0 |             2 |
| GLM-4.7-Flash          | Development |             20 |      7 |        8 |             4 |       1 |      3 |             1 |
| GLM-4.7-Flash          | Holdout     |             37 |     32 |        1 |             1 |       0 |      2 |             2 |

Of the 27B model's 11 holdout disagreements, eight returned neutral for a positive reference and three returned mixed. The holdout references are 26 positive and 11 negative, so a model that leans positive scores well on it; GLM-4.7-Flash did, while reversing four of 20 development labels.

The three models were also timed on the same 248 queued comments with the run's prompt, on an M4 Max with 64 GB. The figures are comments reviewed per second.

| Model           | 1 request | 8 parallel | 16 parallel | 32 parallel | Invalid first replies |
| --------------- | --------: | ---------: | ----------: | ----------: | --------------------: |
| Qwen3.8 27B     |      0.40 |       0.54 |        0.38 |        0.46 |                     0 |
| Qwen3.6 35B-A3B |      1.04 |       2.37 |        2.14 |        2.51 |                     0 |
| GLM-4.7-Flash   |      0.98 |       1.57 |        1.33 |        1.60 |                    19 |

On those comments the 35B-A3B model gave the same stance as the 27B model for 236 of 380 comment and model pairs, and GLM-4.7-Flash for 151. A reading of 22 and 16 of the disagreements found the same faults in both faster models: they attribute the opinion in the parent comment to the writer, and they give a stance to comments that say nothing about the model. The 35B-A3B model gave a stance for 79 pairs where the 27B model gave none; the reverse happened for 14. Both were rejected for those faults. A larger prompt cache did not change the 27B model's speed, because the shared instructions were already cached.

The same check was run that day for Claude Haiku 5.5 through the API, with thinking off as in a run. It agreed with 11 of 20 development pairs and 22 of 37 holdout pairs. Of its 12 holdout disagreements, 11 returned neutral for a positive reference and one reversed the sign. It returned no stance for one pair in each sample, missed one development and two holdout targets, and no reply failed. That is two holdout agreements fewer than the 27B model, on a sample too small to rank the two.

The check and timing outputs are kept in the ignored `.local/hn/thread-model-check/`.

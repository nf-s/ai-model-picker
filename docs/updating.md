# Updating the data

Procedures for bringing each data source up to date and for publishing the site. They are written to be followed exactly, by a person, an agent or a script. The rules in [AGENTS.md](../AGENTS.md) apply to every step.

Nothing updates on its own. Each source is updated separately, and the published site changes only when it is built and uploaded.

| Source                                     | Procedure                                                                                     | Cost                                          | Changes files in Git |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- | --------------------------------------------- | -------------------- |
| Hacker News comments                       | [Hacker News comments](#hacker-news-comments)                                                 | Paid: about 5 US cents per 1,000 new comments | No                   |
| arXiv papers                               | [arXiv papers](#arxiv-papers)                                                                 | Free                                          | No                   |
| Benchmarks, prices, reports, the app guide | [Benchmarks, prices, reports and the app guide](#benchmarks-prices-reports-and-the-app-guide) | Free, but someone has to read the sources     | Yes                  |
| LMArena ratings and Epoch runs             | [LMArena and Epoch runs](#lmarena-and-epoch-runs)                                             | Free                                          | Yes                  |
| OpenRouter usage                           | [OpenRouter usage](#openrouter-usage)                                                         | Free; needs the owner's OpenRouter key        | Yes                  |
| People: practitioners' use records         | [People](#people)                                                                             | Paid: about 10 US cents per 1,000 passages    | No                   |
| Practitioner findings                      | [Practitioner findings](#practitioner-findings)                                               | Free for existing reviewed findings           | Yes                  |
| Expert articles                            | [Expert articles](#expert-articles)                                                           | Free for existing verified articles           | No                   |
| Published site                             | [Publish](#publish)                                                                           | Free                                          | No                   |

The Hacker News, arXiv and people data live in the ignored `.local/` directory, and the published site carries its own publication time. An update of either therefore leaves nothing to commit. Do not edit the documentation to restate their counts: the app's Data page and the `status` commands below are the record.

## How to use these procedures

- Run every command from the repository root.
- A command block is one command. Some tools start a new shell for each command, so a block that sets a variable also uses it.
- Compare what you see with the expected result written under each step. If it differs and the step does not say what to do, stop and report the command and its output. Do not edit or delete state files to get past a step.
- The procedures need the working setup on the owner's Mac: `node_modules/`, `.local/hn/venv/`, `.local/hn/threads/`, `.local/arxiv/` and `.local/restricted/`. If one is missing, stop and report it. Do not run `npm run hn:setup` to recreate `.local/hn/venv/`: it also downloads a 16 GB model.

## Before any update

```sh
git status --short
```

```sh
pgrep -f '[h]n_pipeline|[a]rxiv_pipeline|[p]eople_pipeline'
```

Both must print nothing. Output from the first means someone has uncommitted work: leave those files alone and never stage them with yours. Output from the second is the process ID of a pipeline that is still running: wait for it to end. Each state directory takes one command at a time, and a second one stops with `already-running`.

## Hacker News comments

This reviews the comments posted since the last update and adds them to the served analysis. Reviews already made are kept. It needs the owner's Anthropic sign-in (see step 4) and is paid: the update of 19 November 2026 reviewed 2,680 new comments, two days' worth, for about 12 US cents in about 50 minutes.

### 1. Check that the run is finished

```sh
.local/hn/venv/bin/python -B scripts/hn_pipeline.py status --state-dir .local/hn/threads | python3 -c "import json,sys; s=json.load(sys.stdin); t=s['totals']; print(s['state'], s['reason'], s['endAt']); print({k: t[k] for k in ('commentsQueued','storiesPending','partitionsComplete','partitionsTotal','candidates','classified','classificationFailures','commentsAboutTargets')})"
```

Expected, with other numbers:

```text
blocked classification-unresolved 2026-11-19T10:40:14Z
{'commentsQueued': 0, 'storiesPending': 0, 'partitionsComplete': 122, 'partitionsTotal': 122, 'candidates': 190025, 'classified': 189714, 'classificationFailures': 311, 'commentsAboutTargets': 88309}
```

The run is finished when `commentsQueued` and `storiesPending` are 0 and `partitionsComplete` equals `partitionsTotal`. The first line is then `blocked classification-unresolved` or `complete None`. `blocked` with `classification-unresolved` is the normal finished state: a few hundred comments never get a valid review, and that does not stop the app or the export from using the run.

Keep these numbers for step 5. `candidates` is the comments collected, `classified` those with a valid review, `classificationFailures` those without one and `commentsAboutTargets` those listed in the app.

If the run is not finished, an earlier update was interrupted. Skip steps 2 and 3 and go to step 4, which resumes it.

### 2. Copy the checkpoint

```sh
BACKUP=.local/hn/threads-backup-$(date +%Y%m%d-%H%M%S) && mkdir "$BACKUP" && sqlite3 .local/hn/threads/checkpoint.sqlite3 ".backup '$BACKUP/checkpoint.sqlite3'" && cp .local/hn/threads/status.json .local/hn/threads/results.json "$BACKUP/" && ls -l "$BACKUP"
```

Expected: three files, with `checkpoint.sqlite3` at about 90 MB. Note the directory name. Do not delete older copies; the owner removes them.

### 3. Extend the run to the present

```sh
.local/hn/venv/bin/python -B scripts/hn_pipeline.py extend --state-dir .local/hn/threads
```

Expected: exit code 0 and one line of JSON that starts `{"state": "paused", "reason": null` and shows `storiesPending` above 0 and `partitionsTotal` above `partitionsComplete`. The command reads one number from the HN API and calls no model.

| Output                              | Meaning                                                                                                                       | What to do                                                             |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `checkpoint-configuration-mismatch` | The model list has changed since the run was reviewed, or no item has been posted since the last update. Nothing was changed. | Stop. See [When the model list changes](#when-the-model-list-changes). |
| `firebase-maxitem`                  | The HN API could not be read. Nothing was changed.                                                                            | Try again later.                                                       |
| `already-running`                   | Another command is using the directory.                                                                                       | Wait for it to end.                                                    |
| `no-checkpoint`                     | `.local/hn/threads/` holds no run.                                                                                            | Stop and report.                                                       |

From this step until step 4 finishes, the run is unfinished. The local app shows the older analysis kept in `.local/hn/`, and `npm run build:pages` stops with "Could not export the current Hacker News checkpoint." Do not publish in between.

### 4. Review the new comments

```sh
.local/hn/venv/bin/python -B scripts/hn_pipeline.py run --state-dir .local/hn/threads --backend anthropic >> .local/hn/update.log 2>&1; echo "exit $?"
```

This is the paid step. It sends the scrubbed text of the new comments to the Anthropic API, as described in the [pipeline instructions](hn-pipeline.md#review-through-the-anthropic-api). The one timed update took about 50 minutes for two days of comments; a longer gap takes longer. If your tool limits how long a command may run, start it in the background and read the log:

```sh
tail -n 2 .local/hn/update.log
```

Do not start a second copy. Stopping it is safe; batches already sent stay charged and are read by the next run.

| Exit code | Last lines of the log                                                                | Meaning                                                                         | What to do                                                                                                                                 |
| --------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 0         | `"state": "complete"`                                                                | Every comment has a valid review.                                               | Go to step 5.                                                                                                                              |
| 1         | `"state": "blocked", "reason": "classification-unresolved"`                          | Finished. A few comments have no valid review. This is the usual end.           | Go to step 5.                                                                                                                              |
| 1         | `anthropic-api-credential-missing` or `anthropic-api-credential-failed`              | There is no usable sign-in. Nothing was sent.                                   | Ask the owner to run `ant auth login` in a terminal, which opens a browser. Then repeat step 4. Never ask for a key or token in a message. |
| 1         | `anthropic-api-unreachable`                                                          | The API could not be reached.                                                   | Repeat step 4 later.                                                                                                                       |
| 1         | `clickhouse-read`, `firebase-item-request`, `firebase-item-range` or `request-limit` | A request to an HN source failed.                                               | Repeat step 4; it resumes from the checkpoint. After three failures in a row, stop and report.                                             |
| 1         | `checkpoint-configuration-mismatch`                                                  | The command differs from the one above, or the model list changed after step 3. | Check the command. If it is exact, stop and report; the owner may restore the copy from step 2.                                            |
| 1         | `already-running`                                                                    | Another copy is running.                                                        | Wait for it to end.                                                                                                                        |
| Other     | `"state": "paused"`                                                                  | The command was interrupted.                                                    | Repeat step 4.                                                                                                                             |

Repeating step 4 on a finished run is safe. It sends only the comments that have no valid review once more, for under one US cent, and most fail again.

### 5. Check the result

Run the command from step 1 again. Expected:

- The run is finished, as defined in step 1.
- The time on the first line is the time step 3 ran, in UTC.
- `candidates`, `classified` and `commentsAboutTargets` are at least what they were before.
- `classificationFailures` has grown by no more than 2% of the growth in `candidates`. On 19 November 2026, 6 of 2,680 new comments failed. If it grew by more, stop and report before anyone publishes.

There is nothing to commit. The local app (`npm run dev`, then http://127.0.0.1:5186/#/data) shows the new range and counts. The published site does not change until someone follows [Publish](#publish).

The review also writes the [local HN failure report](#local-failure-reports), including when the run finishes with `classification-unresolved`.

### Restoring the copy

Restore only when the owner says so, with no pipeline command running. Batches sent after the copy was made are unknown to it, so their reviews are lost although they were charged.

```sh
BACKUP=.local/hn/threads-backup-YYYYMMDD-HHMMSS && sqlite3 .local/hn/threads/checkpoint.sqlite3 ".restore '$BACKUP/checkpoint.sqlite3'" && cp "$BACKUP/status.json" "$BACKUP/results.json" .local/hn/threads/
```

Replace `YYYYMMDD-HHMMSS` with the name noted in step 2, then run step 1 to confirm the earlier numbers are back.

## arXiv papers

This reads the days of arXiv metadata published since the last harvest. It is free, needs no model and no sign-in, and is paced at one request every three seconds. The first harvest of 186 days took on the order of an hour, so a week of new days should take a few minutes; a short update has not been timed.

### 1. Check the state

```sh
python3 -B scripts/arxiv_pipeline.py status | python3 -c "import json,sys; s=json.load(sys.stdin); print(s['state'], s['reason'], s['lastDay']); print(s['totals'])"
```

Expected, with other numbers:

```text
complete None 2026-11-17
{'recordsScanned': 314096, 'recordsEligible': 206286, 'unavailable': 0, 'invalid': 71, 'recordsStored': 206286, 'papers': 11031, 'assessed': 1382, 'assessmentFailures': 1, 'results': 413, 'resultFailures': 1, 'daysComplete': 185, 'daysTotal': 186}
```

### 2. Harvest

```sh
npm run arxiv:run
```

Expected: JSON progress lines, then exit code 0. If the model list changed since the last harvest, the command first matches every stored paper again, without reading arXiv.

Never run two harvests at once, even in separate directories: arXiv allows one request every three seconds across all of them. If the command stops with a code that starts with `arxiv-oai-`, run it again later; it retries the unfinished days. The codes are listed in the [arXiv pipeline instructions](arxiv-pipeline.md#coverage). `already-running` means another command holds the directory.

### 3. Check the result

Run the command from step 1 again. Expected: `complete None` and today's or yesterday's date in UTC. `daysComplete` is one less than `daysTotal`, because the current UTC day stays open and is read again next time. `papers` is at least what it was. `assessed` and `results` can fall a little: a paper whose new version changes its title or abstract loses its label and result until labelling runs again. On 20 November 2026, 445 new papers took `papers` to 11,476 and 9 labels were dropped this way.

New papers have no label, and the Papers page counts them as Unlabelled. Labelling runs a local model for about 3.5 seconds a paper and is done only when the owner asks; see [Labelling](arxiv-pipeline.md#labelling). There is nothing to commit.

The harvest also writes the [local paper failure report](#local-failure-reports). Newly matched papers are eligible as soon as their abstracts arrive.

## Local failure reports

Open `failure-review.json` in the state directory used for the update. With the commands above, the files are `.local/hn/threads/failure-review.json` and `.local/arxiv/failure-review.json`. Both jobs run locally as part of the scrape and use data already collected. They make no additional model or network requests.

Each report lists up to 50 of the most recent matching sources, the total candidate count, source links and suggested local checks. Zero matches is a valid result. The selection rules cover specific symptoms and can miss unfamiliar wording. Use the HN link to read the comment in its thread. For a paper, open the source to check which model, task, comparison and measurement support the observation. A model mentioned in a paper may have served as a judge or a baseline.

To test a finding, choose a representative task, fix the starting state and acceptance check, then compare runs at the relevant model and effort settings. Record the pass or failure, parent rework, elapsed time and total usage through acceptance, including retries. The reports stay local and do not change the model rankings.

## Benchmarks, prices, reports and the app guide

No command fetches this data. Someone reads each source again and edits the reviewed files, and the build script only normalises what the files say. Do it when the owner asks, or when a source is known to have changed.

| File                                | Holds                                                           | Reaches the app through                                     |
| ----------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------- |
| `research/pricing.json`             | Priced models and their API rates                               | `npm run data:build`                                        |
| `research/benchmarks.json`          | Three benchmarks and their results                              | `npm run data:build`                                        |
| `research/creative-benchmarks.json` | One benchmark and its results                                   | `npm run data:build`                                        |
| `research/reports.json`             | Published reports                                               | `npm run data:build`                                        |
| `.local/restricted/research.json`   | Benchmarks whose terms do not allow republishing. Never in Git. | `npm run data:build`, into `.local/restricted/payload.json` |
| `research/app-model-choices.json`   | The app guide                                                   | Imported directly by `src/lib/guide.ts`                     |

1. Open each URL in the `sources` list of the file you are refreshing and compare it with the file. Edit the JSON to match the source. Keep each value's unit, uncertainty, cost basis and exact configuration. Leave out what the source does not state; never estimate a value or copy one from a similar model. Keep a dated model version as its own model.
2. Set `checkedAt` at the top of each file you compared to today's date, also when nothing in it changed.
3. Build and read the summary line:

   ```sh
   npm run data:build
   ```

   Expected, with other numbers: `Saved 98 model identities, 4 benchmarks, 153 results, 15 reports, 28 sources; …`. It writes `src/lib/snapshot.json` and `.local/restricted/payload.json`. Check the new model names for duplicates of existing ones under another spelling; add each such spelling to the `aliases` table in `scripts/build-snapshot.py` and build again. If the number of model identities changed, or you renamed a model, follow [When the model list changes](#when-the-model-list-changes) after the remaining steps.

   Give every new model a status, which the Board's "Current models only" filter reads. A priced model has `status` in `research/pricing.json`; any other model gets an entry in `research/model-status.json` with a one-sentence reason. A model is `previous` when a newer model of its line is in the data or its provider names a replacement, and the model it replaces becomes `previous` too; `preview` when its name says so and nothing has replaced it; `current` when it is the newest of its line. Leave a model out when the data does not settle it. The build stops if an entry names an unknown model or a priced one.

   To give comments about a new model their short spellings, such as "6.2 Sol" for GPT-6.2 Sol, add them to `SHORT_NAMES` in `scripts/hn_local/classify.py`, and add a family such as "Gemini Neon" to `FAMILIES`. Avoid spellings that are ordinary words.

4. Run the tests:

   ```sh
   npm test
   ```

   `tests/data.test.ts` states the number of results and of priced models. When a count changed because the source changed, update the number there.

5. Update the text that quotes the old check date and counts. Find it with:

   ```sh
   grep -rn "16 November 2026" README.md docs src/lib/attribution.ts research/*.md
   ```

   Replace the date in the command with the previous `checkedAt`. Change a line only where the fact it states was checked again. The counts are in the first paragraphs of `README.md` under "Data in the app" and in [data provenance](data.md).

6. Run the remaining checks, look at the Board, one benchmark page and one model page in `npm run dev`, then commit the files you changed by name:

   ```sh
   npm run build && npm run format && npm run format:check
   ```

The names of the benchmarks in `.local/restricted/` must not appear in a tracked file, a commit message or a log.

### When the model list changes

The model list is the `models` array in `src/lib/snapshot.json`. It changes when a model is added to or removed from `research/pricing.json`, when a benchmark or report row names a model that was not in the list, when a model's `id`, `name`, `apiId` or `version` changes, and when the name tables or `MATCHER_VERSION` in `scripts/hn_local/classify.py` change. Raise `MATCHER_VERSION` whenever the matching rules change without a change to the names.

- **arXiv:** the next `npm run arxiv:run` matches every stored paper again, without reading arXiv, in a few minutes. A paper whose matched models change loses its label until labelling runs again: on 21 November 2026, 22 new models left 18 labelled papers unlabelled. Nothing else is needed.
- **Hacker News:** the reviewed run keeps being served, but `extend` refuses it with `checkpoint-configuration-mismatch` until it is retargeted, because it was scanned for the old names. Retargeting keeps every review, scans the six months again for the new names (free) and reviews only the comments that are new or that name a new model (paid). It does not work if a model `id` that some comment was reviewed for was removed: keep such models in the list.
- **LMArena and Epoch runs:** an imported result or alias that names a model no longer in the list stops `npm run records:build` and the importers. A new model has no imported results until its exact source name is added as an alias. In both cases, run [LMArena and Epoch runs](#lmarena-and-epoch-runs) again after the change.
- **OpenRouter usage:** the same holds for `research/openrouter-usage.json` and its aliases. Run steps 2 to 5 of [OpenRouter usage](#openrouter-usage) on the last download; a new download needs the owner.

To retarget the Hacker News run, first make sure it is finished (step 1 of [Hacker News comments](#hacker-news-comments)) and copy the checkpoint (step 2). Then:

1. Retarget it:

   ```sh
   .local/hn/venv/bin/python -B scripts/hn_pipeline.py retarget --state-dir .local/hn/threads --backend anthropic
   ```

   Expected: exit code 0 and one line of JSON with `"state": "paused"` and `partitionsComplete` 0. The command finds the model list the run was scanned with in Git: it reads `src/lib/snapshot.json` and `scripts/hn_local/classify.py` at each of the last 50 commits that changed them, and uses the newest that matches the run. So commit each model-list change before the next one, or retarget in between.

   | Output                              | Meaning                                                                        | What to do                                                     |
   | ----------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------- |
   | `targets-unchanged`                 | The model list is the one the run was scanned with.                            | Nothing to do: use `extend`.                                   |
   | `previous-targets-not-found`        | No recent commit holds the list the run was scanned with. Nothing was changed. | Stop and report.                                               |
   | `removed-target-has-reviews`        | The new list removes a model or family that some review refers to.             | Put the model back in the research files, rebuild, and repeat. |
   | `checkpoint-configuration-mismatch` | The backend differs from the run's, or batches are still out. Nothing changed. | Check the command; finish step 4 of the HN procedure first.    |
   | `already-running`                   | Another command is using the directory.                                        | Wait for it to end.                                            |

   Retargeting again before the scan in step 2 has finished is safe: the targets of both changes are kept.

2. Scan again without the model. This is free and took about 50 minutes on 21 November 2026, because it reads all six months of items again; start it in the background as in step 4 of the Hacker News procedure:

   ```sh
   .local/hn/venv/bin/python -B scripts/hn_pipeline.py run --state-dir .local/hn/threads --backend anthropic --collect-only >> .local/hn/update.log 2>&1; echo "exit $?"
   ```

   Expected: exit code 0 and a last log line with `"state": "paused", "reason": "collect-only"` and `partitionsComplete` equal to `partitionsTotal`. Read `commentsQueued` there: at about 5 US cents per 1,000 comments, that is the cost of the next step. Report it to the owner and wait for their go-ahead if it is above US$1.

3. Review: run step 4 of [Hacker News comments](#hacker-news-comments), then step 5. `candidates` and `classified` grow; `commentsAboutTargets` can grow or fall a little, because some comments are reviewed again.

Until step 3 finishes, the local app shows the older analysis kept in `.local/hn/` and `npm run build:pages` stops with "Could not export the current Hacker News checkpoint." Do not publish in between.

A new full run, which reviews every comment again, is needed only after a change to the review itself, such as its prompt or classifier. Through the Anthropic API the first one cost about US$7 and took about two hours. Start one only when the owner asks; the steps are in the [pipeline instructions](hn-pipeline.md#review-through-the-anthropic-api).

## LMArena and Epoch runs

This imports the latest Arena leaderboard dataset from Hugging Face and the results of Epoch AI's own benchmark runs. Both are free, need no key and no sign-in, and change only tracked files: `research/lmarena.json`, `research/epoch-runs.json` and, when you add names, `research/aliases/lmarena.json` and `research/aliases/epoch.json`. Neither importer adds a model or changes `src/lib/snapshot.json`: a name that has no alias is listed and left out. What each file holds is in [data provenance](data.md#lmarena-and-epoch-runs).

### 1. Import

```sh
python3 -B scripts/import_lmarena.py
```

```sh
python3 -B scripts/import_epoch.py
```

Expected for each: `Downloading into` and a new folder under `.local/imports/`, a table with the rows read and the results kept per leaderboard or file, `Wrote … N results.`, then the names that matched no alias, one per line. The LMArena import makes about 50 requests to the Hugging Face datasets server, half a second apart; the Epoch import downloads one ZIP of about 2 MB. On 23 November 2026 the LMArena import kept 391 results from 16 leaderboards and the Epoch import 193 from 8 files. Leave the download folders in place; the owner removes old ones.

| Output                                                                                                                   | Meaning                                                                        | What to do                                                                          |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `HTTP 429`, `HTTP 5xx` or a connection error                                                                             | The source could not be read after four tries. Nothing was written.            | Run it again later.                                                                 |
| `the row count changed while paging`                                                                                     | The dataset was republished during the import. Nothing was written.            | Run it again. If it repeats, stop and report.                                       |
| `the dataset licence is now …`, `the README no longer gives the CC BY 4.0 licence` or `the README citation has changed`  | The source's terms or citation changed. Nothing was written.                   | Stop and report.                                                                    |
| `columns missing`, `is not a number`, `rows from N publish dates`, `no rows` or any other message naming a row or a file | The source's format changed. Nothing was written.                              | Stop and report.                                                                    |
| `… names <id>, which is not in the snapshot`                                                                             | An alias points to a model that has left the model list. Nothing was written.  | Remove that alias, or put the model back through the benchmark refresh, and repeat. |
| `… has an alias but is listed N times`                                                                                   | The leaderboard lists one name twice, so the alias cannot say which row it is. | Stop and report.                                                                    |

### 2. Add aliases for exact matches

Read the unmatched names. Add a name to the `aliases` table of `research/aliases/lmarena.json` or `research/aliases/epoch.json` only when it names exactly a model in `src/lib/snapshot.json`, read with the table's `rule`. The importer itself takes out the effort setting and harness of an LMArena name (`GPT-6.2 Sol (Max)` is looked up as `GPT-6.2 Sol`) and the reasoning setting of an Epoch version (`gpt-6.2-astra_high` as `gpt-6.2-astra`). Never take out anything else: a date, a version, a size, a quantisation, a provider suffix or a resolution marks a different release, which stays out. A model that is not in the model list stays out too. Adding one goes through [Benchmarks, prices, reports and the app guide](#benchmarks-prices-reports-and-the-app-guide) and then [When the model list changes](#when-the-model-list-changes).

After changing an alias table, run the importer again on the same download, without fetching:

```sh
python3 -B scripts/import_lmarena.py --from .local/imports/lmarena/<folder from step 1>
```

```sh
python3 -B scripts/import_epoch.py --from .local/imports/epoch/<folder from step 1>
```

Expected: the same table, with more results kept and the added names gone from the unmatched list.

### 3. Review the import

```sh
git diff --stat research/lmarena.json research/epoch-runs.json
```

Read the diff. Each leaderboard's `publishedAt` and `rows`, and each file's `rows`, say what the source published; a result that appears or disappears should follow from a new publication date, a new run or an alias you changed. Open three or more changed results at their source (each leaderboard's `url` opens the dataset viewer; each Epoch result has its `log` link or the file's `url`) and compare the score, interval, count, rank and date. Then set `checkedAt` at the top of each file you reviewed to today's date. The importer leaves it empty, and `npm run records:build` stops on an empty one.

### 4. Update the attribution lines

Each file's `source.attribution` must appear word for word as the `credit` of its entry in `src/lib/attribution.ts`: LMArena's names the publication dates of the leaderboards read, Epoch's the date of the download. Copy the new line into `src/lib/attribution.ts` when it changed. `npm test` fails until they agree.

### 5. Build and check

```sh
npm run records:build
```

Expected: the coverage table, which has an Arena column, then `LMArena: N records, fetched <date>, checked <date>.` and `Epoch runs: N records, …` with the counts from step 1 or 2. In a worktree, add `-- --hn-root <main checkout>` (see [data provenance](data.md#shared-records-and-the-job-list)).

| Output                                             | Meaning                                                                 | What to do                                                                                                                                                    |
| -------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checkedAt is not set`                             | Step 3 was skipped.                                                     | Do step 3.                                                                                                                                                    |
| `arena:… is not in the crosswalk` or `epoch-run:…` | The importer now reads a leaderboard or file the job file does not map. | Add it to `arena-leaderboard` or `epoch-run` in `research/jobs.json` with its job (or `null`), and to a job's `benchmarks` if it should set that job's order. |
| `model … is not in the snapshot`                   | The model list changed after the import.                                | Run step 1 again.                                                                                                                                             |

```sh
npm test
```

```sh
npm run format && npm run format:check
```

Commit the changed files under `research/` and `src/lib/attribution.ts` by name. The site shows the new ratings and runs only after it is built and published.

## OpenRouter usage

This imports how much public OpenRouter traffic each model carries: 30-day token shares and 7-day task tags. It is free but needs the owner's OpenRouter key, and changes only tracked files: `research/openrouter-usage.json` and, when you add names, `research/aliases/openrouter.json`. It never adds a model or changes `src/lib/snapshot.json`. Usage orders nothing: never use it to fill in a job that has no measure, to order a list or to break a tie. What the file holds is in [data provenance](data.md#openrouter-usage).

### 1. Import (the owner, in their own terminal)

The key is read from the `OPENROUTER_API_KEY` environment variable for this one command. Only the owner runs this step. An agent does not look for the key, read it, print the environment or run the command; it starts at step 2 with the folder the owner names.

```sh
printf 'OpenRouter key: '; read -rs key; echo; OPENROUTER_API_KEY="$key" python3 -B scripts/import_openrouter.py; unset key
```

The key is typed at the prompt, not shown, kept out of the shell history and passed to this command only. Expected: `Downloading into` and a new folder under `.local/imports/openrouter/`, a table with the rows read and kept for `rankings-daily (30 days)` and `classifications/task (7 days)`, `Wrote … N results.`, then the routes that matched no alias, one per line. The import makes two calls to the Data API, a few seconds apart; its limits are 30 requests a minute and 500 a day. On 23 November 2026 the same two responses gave 38 models with 30-day tokens and 29 task tags. Leave the download folder in place; the owner removes old ones.

| Output                                                                                                                  | Meaning                                                                       | What to do                                                                          |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `OPENROUTER_API_KEY is not set`                                                                                         | The key was not given. Nothing was fetched or written.                        | Run the command again and type the key at the prompt.                               |
| `HTTP 401` or `HTTP 403`                                                                                                | The key was refused. Nothing was written.                                     | Check the key in the OpenRouter settings and run it again.                          |
| `HTTP 429`, `HTTP 5xx` or a connection error                                                                            | The Data API could not be read after four tries. Nothing was written.         | Run it again later.                                                                 |
| `the response repeats the key, so it was not saved`                                                                     | A response contained the key. Nothing was written.                            | Stop and report the message only.                                                   |
| `no "other" row`, `is not a share`, `the window is …`, `request shares add up to …` or any other message naming a field | The Data API's format changed. Nothing was written.                           | Stop and report.                                                                    |
| `… names <id>, which is not in the snapshot`                                                                            | An alias points to a model that has left the model list. Nothing was written. | Remove that alias, or put the model back through the benchmark refresh, and repeat. |

### 2. Add aliases for exact matches

Read the unmatched routes. Add a route to the `aliases` table of `research/aliases/openrouter.json` only when it names exactly a model in `src/lib/snapshot.json`, read with the table's `rule`. The importer takes out a `:free` suffix and nothing else. A date, a variant (`:batch`, `-contributor`, `-pro`) or an undated route that serves another release marks a different model, which stays out. Then run the importer again on the same download, without the key:

```sh
python3 -B scripts/import_openrouter.py --from .local/imports/openrouter/<folder from step 1>
```

Expected: the same table, with more rows kept and the added routes gone from the unmatched list.

### 3. Review the import

```sh
git diff --stat research/openrouter-usage.json
```

Read the diff. `tokens30d.meta` and `tasks7d.meta` say what was published and when; `tokens30d.period` should end the day before the download, and `tasks7d.period` should end on its `as_of`. A model that appears or disappears should follow from the new period or an alias you changed. Compare three models' shares and three tags' top models with [openrouter.ai/rankings](https://openrouter.ai/rankings), which shows the same data. Then set `checkedAt` at the top of the file to today's date. The importer leaves it empty, and `npm run records:build` stops on an empty one.

### 4. Update the attribution line

The file's `source.attribution` names `tokens30d`'s `as_of`. Copy it word for word into the `credit` of the "OpenRouter" entry in `src/lib/attribution.ts`. `npm test` fails until they agree.

### 5. Build and check

```sh
npm run records:build
```

Expected: the coverage table unchanged by this import, then `OpenRouter usage (orders nothing): N models with 30-day tokens as of <as_of>, N task tags as of <date>, checked <date>.` with the counts from step 1 or 2. In a worktree, add `-- --hn-root <main checkout>`.

| Output                                                         | Meaning                                  | What to do                                                                                                   |
| -------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `checkedAt is not set`                                         | Step 3 was skipped.                      | Do step 3.                                                                                                   |
| `OpenRouter task tags are not in the openrouter-tag crosswalk` | OpenRouter added or renamed a task tag.  | Add it to `openrouter-tag` in `research/jobs.json` with the job whose work it describes, or `null` for none. |
| `model is not in the snapshot` or `… is not in the snapshot`   | The model list changed after the import. | Run step 2 again on the last download.                                                                       |

```sh
npm test
```

```sh
npm run format && npm run format:check
```

Commit `research/openrouter-usage.json`, any changed alias table, `research/jobs.json` if you changed it, and `src/lib/attribution.ts` by name. The site shows the new usage only after it is built and published.

## People

This collects new writing from the practitioners and outlets in `.local/people/people.json` and reviews it into use records and method advice. Collection is free; the review is paid and sends redacted passages to the Anthropic API. Nothing tracked changes. The named records are private: the build writes them only to the ignored `build/records/named-private.json`. How each step works is in the [people pipeline](people-pipeline.md).

### 1. Check the state

```sh
python3 -B scripts/people_pipeline.py status
```

Expected: JSON with `people`, `items` and `review`. `review.instructionsUnchanged` is `true`, `queued` is 0 and `batches` has only `collected` entries. `itemsNotPrepared` is 0 unless a collection ran without a review since.

| Output                                                | Meaning                                                     | What to do                                                                                     |
| ----------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `missing-people.json`                                 | There is no `.local/people/` on this machine.               | Stop and report. Only the owner restores it.                                                   |
| `people-file-invalid: …` or `sources-file-invalid: …` | A local file breaks its format; the message names the rule. | Fix the file as [Adding or dropping a person](#adding-or-dropping-a-person) says, then repeat. |
| `queued` above 0, or a `submitted` batch              | A review was stopped before it finished.                    | Go to step 3, then step 4, which finishes it.                                                  |
| `instructionsUnchanged` is `false`                    | The review instructions changed in code.                    | Stop and report. A changed prompt needs a new review of every passage.                         |

### 2. Collect

```sh
python3 -B scripts/people_pipeline.py collect >> .local/people/collect.log 2>&1; echo "exit $?"
```

It makes one request every 3 seconds, so a run takes from a few minutes to about half an hour. If your tool limits how long a command may run, start it in the background and read the log:

```sh
tail -n 5 .local/people/collect.log
```

Expected: exit 0, `Found N links, M already handled`, progress lines, then a JSON summary with `new_items`, `exclusions` and `discovery_notes`. `new_items` may be 0. Exclusions for `outside window` and `byline unverified` are normal.

| Output                                                     | Meaning                                                   | What to do                                                                  |
| ---------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------- |
| A discovery note ending in `403`, `robots` or `not a feed` | A feed refused the request, is closed to robots or moved. | Report the feed. Do not change the client name or work around `robots.txt`. |
| Most links of one person excluded with `page status …`     | That site refused the pages.                              | Report it; the next run tries them again.                                   |
| `already-running`                                          | Another command uses `.local/people/`.                    | Wait for it to end.                                                         |
| `Stopped at the request limit`                             | `--max-requests` was given.                               | Run it again without the limit; it continues.                               |

### 3. Queue the new passages and read the estimate

```sh
python3 -B scripts/people_pipeline.py review --queue-only
```

Expected: JSON with `newItems`, `newPassages`, `blockedByPrivacyCheck`, `queued` and `estimatedUsd`. It sends nothing and needs no sign-in. Running it twice queues nothing new.

- If `estimatedUsd` is above 1, report `queued` and `estimatedUsd` and ask the owner before step 4.
- `blockedByPrivacyCheck` counts items whose redacted text still matched a private pattern; they are not sent. Report a number above 0.
- With `queued` at 0 there is nothing to review: go to step 5.

### 4. Review the new passages

```sh
.local/hn/venv/bin/python -B scripts/people_pipeline.py review --backend anthropic >> .local/people/review.log 2>&1; echo "exit $?"
```

This is the paid step. It uses the Hacker News environment's Python, which has Anthropic's package, and the same sign-in as the [Hacker News review](#4-review-the-new-comments). It waits for its batches, usually under an hour, writing a line per batch. If your tool limits how long a command may run, start it in the background and read the log:

```sh
tail -n 3 .local/people/review.log
```

Do not start a second copy. Stopping it is safe; batches already sent stay charged and are read by the next run.

| Exit code | Last lines of the log                                                     | Meaning                                                            | What to do                                                                                                                                 |
| --------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 0         | `{"passage_states": …, "use_records": …}`                                 | Every batch ended and its replies are stored.                      | Go to step 5.                                                                                                                              |
| 1         | `anthropic-api-credential-missing` or `anthropic-api-credential-failed`   | There is no usable sign-in. Nothing was sent.                      | Ask the owner to run `ant auth login` in a terminal, which opens a browser. Then repeat step 4. Never ask for a key or token in a message. |
| 1         | `anthropic-package-missing`                                               | The command ran with the system `python3`.                         | Run it exactly as above.                                                                                                                   |
| 1         | `anthropic-api-unreachable` or `anthropic-api-status-5…`                  | The API could not be reached.                                      | Repeat step 4 later.                                                                                                                       |
| 1         | `previous-submission-unconfirmed`                                         | A run stopped while creating a batch, which may have been charged. | Stop and report.                                                                                                                           |
| 1         | `review-checkpoint-methodology-mismatch` or `review-instructions-changed` | The checkpoint was made with other instructions.                   | Stop and report.                                                                                                                           |
| 1         | `already-running`                                                         | Another command uses `.local/people/`.                             | Wait for it to end.                                                                                                                        |
| 1         | `interrupted; …`                                                          | The command was stopped.                                           | Repeat step 4.                                                                                                                             |

### 5. Check the result

Run the command from step 1 again. Expected: `queued` 0, every batch `collected`, and `useRecords` and `methodAdvice` at least what they were before. Compare `review.passages.unresolved` with step 1: on 23 November 2026, 335 of 18,345 passages (1.8%) were unresolved. If the unresolved passages grew by more than 3% of the passages sent in step 4, stop and report before anyone builds for publishing.

```sh
npm run records:build
```

Expected: the coverage table with a `Use (review)` column, then `Named records (private, behind sign-in): N use records (N left out as advice-only), N method advice, N people.` In a worktree, add `-- --hn-root <main checkout>`.

| Output                                                   | Meaning                                                            | What to do                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `The people review files differ from review-status.json` | The result files were written by another run than the status file. | Run `python3 -B scripts/people_pipeline.py export`, then build again.  |
| `… its person is not in people.json`                     | A person was removed from `people.json`.                           | Put them back with a `dropped` date and reason; never delete a person. |
| `… is not in the snapshot`                               | The model list changed since the review.                           | Stop and report.                                                       |
| `review:<label> is not in the crosswalk`                 | The job list changed without the `review-job` table.               | Add the label to `review-job` in `research/jobs.json` and build again. |

There is nothing to commit. Never copy `build/records/named-private.json` into `dist/` or a commit.

### Adding or dropping a person

People are added and dropped only in the two local files, never in a tracked file, a test or a commit message.

- To add one, append them to `.local/people/people.json` with their feeds, `sourceClass`, `adviceOnly`, `trusted` and `added` (today's date and the reason), and to `.local/people/sources.json` with a new `key`, their `byline` words, `redact` (their name and handles) and a `discover` entry for each feed to read. The format is in the [people pipeline](people-pipeline.md#who-is-collected).
- To drop one, set `dropped` to today's date and the reason. Keep the entry: their records stay and the build needs their name.

Then run step 1, which checks both files, and the remaining steps.

## Practitioner findings

Update [the reviewed selection](../research/practitioner-findings.json) by hand from existing reviewed findings. Check each summary, condition, date, attribution and match against the original public comment and the reply context. Keep family or tool mentions at the level the source supports. Use short paraphrases, and check the public download for text or identifiers that should stay private. Set `checkedAt` to the date of the source check. Run `npm test` and `npm run build`, then open an affected page and verify the original and context links. The Data download carries the same selection.

## Expert articles

1. Check candidates against the existing verified article sources. Keep original publication dates and canonical HTTPS links. Require an attributable byline for team-blog posts. Exclude replies, interviews, reposts and unresolved matches.
2. Use the reviewed export at `.local/expert-articles/catalog.json`. It is a JSON object with an `articles` array of `{ title, date, url }` objects. Dates use `YYYY-MM-DD`. The file and the source material stay out of Git and public downloads.
3. Open Expert articles in the loopback dev app and verify the title, source and year filters and an original-post link. For a release, run the build and pre-upload checks below. The catalog and its links must be absent from the static output. Compile the Pages Functions separately as described in [Google sign-in](../server/auth/README.md#verification).

## Publish

Publish only when the owner asks for it. A request to update data is not a request to publish.

### 1. Check what will be published

Run step 1 of [Hacker News comments](#hacker-news-comments): the run must be finished. Then:

```sh
npm test && npm run hn:test && npm run arxiv:test && npm run format:check
```

Expected: every command passes.

Check that the reviewed catalog is available at `.local/expert-articles/catalog.json` before building.

### 2. Build

```sh
npm run build:pages
```

Expected last lines, with other numbers:

```text
Exported 88,309 Hacker News comment records.
Exported 11,031 arXiv papers.
```

Use this command, not `npm run build`: only this one builds the published mode and writes the data files into `dist/`.

### 3. Check the build

```sh
npm run check:pages
```

Expected, with other numbers in the first four lines:

```text
commentFiles: 4
comments: 88,309
claimsAndTitles: 95,331
restrictedOnlyIdentifiers: 91
mixedReleases: 0
oversizeFiles: 0
personalDetails: 0
restrictedIdentifiers: 0
expertArticleLeaks: 0
localPaths: 0
The site build passed the checks.
```

The last six counts must be 0. They are comment files from different exports, files over the 25 MiB that Cloudflare Pages accepts, claims or story titles that still contain a link, an address, a handle or a phone number, identifiers that exist only in the restricted results, expert article catalog files or links, and paths on this computer. If the command ends with "Do not upload", report the output and stop. `comments` must equal the first number printed in step 2.

### 4. Upload

```sh
npx wrangler@4.163.0 pages deploy dist --project-name ai-model-picker --branch main
```

Expected: `Deployment complete!` followed by an address ending in `.ai-model-picker.pages.dev`. Upload only `dist/`.

If Wrangler reports that it is not signed in, ask the owner to run `npx wrangler@4.163.0 login` in a terminal. Do not run `wrangler whoami`, which prints the account's email address. `wrangler pages deployment list` prints an address that contains the account identifier; keep its output out of commits, documents and messages.

### 5. Check the live site

```sh
curl -s https://ai-model-picker.pages.dev/hn-snapshot.json | python3 -c "import json,sys; s=json.load(sys.stdin); print(s['publishedAt'], s['commentParts'], s['status']['endAt'], s['status']['totals']['commentsAboutTargets'])"
```

```sh
python3 -c "import json; s=json.load(open('dist/hn-snapshot.json')); print(s['publishedAt'], s['commentParts'], s['status']['endAt'], s['status']['totals']['commentsAboutTargets'])"
```

The two commands must print the same line. If the first still shows the earlier release, wait a minute and repeat it.

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://ai-model-picker.pages.dev/api/restricted
curl -s -o /dev/null -w '%{http_code}\n' https://ai-model-picker.pages.dev/api/expert-articles
```

Expected: `401` for both endpoints.

```sh
curl -sI https://ai-model-picker.pages.dev/hn-comments-1.json | grep -i -E '^(cache-control|x-robots-tag)'
```

Expected:

```text
cache-control: no-store
x-robots-tag: noindex, nofollow, noarchive, nosnippet
```

If a browser is available, open https://ai-model-picker.pages.dev/ and check that the header shows the new date range and comment count, that Discussion lists threads, that "Show comment" loads a comment, that the Data page has no scan controls and that the console has no errors. The remaining checks are listed under [release verification](deployment.md#release-verification).

## Automating the updates

Nothing is scheduled today. These notes are for whoever sets that up.

- **Safe to run unattended:** [Before any update](#before-any-update), the Hacker News steps 1 to 5, the arXiv steps 1 to 3, the [People](#people) steps 1 to 3 and step 1 of [LMArena and Epoch runs](#lmarena-and-epoch-runs). Every decision in them is a comparison of printed values. The review in its step 3 needs a person.
- **Order:** arXiv and Hacker News are independent and can run one after the other in either order. Do not build for publishing while the Hacker News update is between steps 3 and 5.
- **People review:** step 4 of [People](#people) is paid and follows the same rules as the Hacker News review: an unattended job needs an API key for that one command and a cost limit the owner set, checked against step 3's estimate.
- **Exit codes:** for the Hacker News review, exit code 1 with `classification-unresolved` is success. Decide from the step 1 command, not from the exit code alone.
- **Sign-in:** the `ant auth login` sign-in needs a browser to renew, and the one made on 18 November 2026 stopped working two days later. An unattended job needs an API key supplied through the environment for that one command, as the [pipeline instructions](hn-pipeline.md#review-through-the-anthropic-api) show with the macOS keychain. Wrangler's sign-in can expire too.
- **Cost and time:** an update pays for the new comments and for one more attempt at the unresolved ones, so a weekly update costs about the same as seven daily ones. Each update also walks the threads of the last 30 days again and sends two batches, whatever the number of new comments, so frequent small updates repeat that work. Only one update has been timed.
- **Copies:** every Hacker News update leaves a 90 MB copy in `.local/hn/`. A job that runs often needs the owner's rule for removing old ones.
- **Not suitable for a script:** the benchmark, price, report and app guide refresh, which needs someone to read the sources; a new full Hacker News run; and labelling arXiv papers with the local model.
- **Publishing:** steps 1 to 5 of [Publish](#publish) can be scripted, but the upload makes the data public. Publish from a script only if the owner has decided that updates go out without being looked at.

# Model picker

A reference for choosing an AI model for a job. It keeps three kinds of evidence apart and shows them side by side: measured results (published benchmarks, LMArena ratings, Epoch AI's own runs and controlled reports), which order models; practitioners' use records, reviewed from their public writing; and six months of Hacker News discussion. OpenRouter usage is shown beside them and orders nothing.

The question it exists to answer is which model to use for a given job. [Goal](docs/goal.md) states what counts as an answer and what the project does not try to do.

- **Brief** (home): choose one of 13 jobs. A brief names a first choice, a second and a lower-cost option, each with its reason, price and three bands of evidence (Measured, Named, Crowd), then the full ordered table. Only measured results set the order; the note above the cards says which benchmark sets it, or that the job has no measure.
- **Models**: the models and product lines within the filters. A model page shows its evidence by job, the three bands for the job chosen, stated preferences and themes from Hacker News, OpenRouter usage, and a thread reader for its comments. A product line's page holds the labels that name only the line.
- **Switch**: two models compared on the job's benchmarks (whether their intervals overlap), price, cost per task and stated preferences between them.
- **People**: practitioners' use records and method advice, a matrix of who reported on what, person pages and a trusted-people list. Behind sign-in: anonymous visitors see one line saying so.
- **Search**: word search over measured records and Hacker News labels, grouped by band and job, within the filters; use records and method advice for granted accounts. It reads a static index, so a search downloads only the files for its words and the results shown. `npm run search -- <words>` searches the same records and the practitioners' quotes on this machine and prints JSON for coding agents; see [Search](docs/search.md).
- **Benchmark pages**: every result for one benchmark, LMArena leaderboard or Epoch run, with all configurations, the source's method, limits and attribution. Reached from every benchmark name.
- **App guide**: which selection to make in ChatGPT and Claude on their highest-usage plans for eight tasks, with alternatives, settings and sources. Each task links to its job's brief. The Coding agents mode adds 13 hand-checked practitioner findings and, for granted accounts, method advice.
- **Data**: every source with its counts, dates and attribution; the limits; job coverage per source, in the whole build and within the filters, with the records that need reading until the next review; what each benchmark measures; how records get a job; the Hacker News collection status; licences; and a download of the public data.
- **Filter bar** (under the header, on every view): job, providers and models, and on the full views period, sources, basis, setting, run, surface and current models only. Ranks stay overall ranks. Everything except the job is remembered in the browser and cleared in one click.

Benchmarks, prices and the app guide were checked against their sources on **21 November 2026**, LMArena, Epoch AI runs and OpenRouter usage on **23 November 2026**. App labels are kept separate from API identities. Hacker News labels and practitioner records are assigned by a model and can be wrong; the app guide's recommendations are sourced starting points. None of it is a representative survey or a universal ranking.

## What is public

| Evidence                                                                       | Public site | Behind sign-in | This machine only                                            |
| ------------------------------------------------------------------------------ | ----------- | -------------- | ------------------------------------------------------------ |
| Benchmark snapshot, LMArena, Epoch AI runs, reports, prices, app guide         | Yes         |                |                                                              |
| Hacker News labels, claims, themes and scrubbed story titles                   | Yes         |                | Checkpoints; comment text is read from the HN API on request |
| OpenRouter usage                                                               | Yes         |                | Downloads                                                    |
| Practitioners' use records, method advice, quotes, names and counts per person | No          | Yes            | Collected texts, passages and review state                   |
| Articles by the practitioners                                                  | No          | Yes            | The catalog                                                  |
| Benchmarks whose terms do not allow republishing                               | No          | Yes            | Their reviewed rows                                          |
| arXiv metadata (a feed for reports reviewed by hand)                           | No          | No             | Yes                                                          |

Practitioner records are behind sign-in because their summaries and job labels were written by a model review and have not been checked by hand: the review's job agreed with a reference set half the time. Signing in uses Google; the administrator grants accounts under **Sign in → Manage access**. See [Google sign-in](server/auth/README.md).

## Run

Node 22.22 or newer:

```sh
npm install
npm run records:build
npm run dev
```

Open http://127.0.0.1:5186. `npm run records:build` writes `build/records/` (the records, the search index and, from `.local/people/`, the private named records), which the dev server serves. The dev launcher also starts a loopback-only local analysis controller, which serves the Hacker News comment index. On the loopback dev server the protected data (restricted benchmarks, named records, articles) is served from the local files without sign-in.

Views are hash routes: `#/` (job chooser), `#/brief/<job>`, `#/model`, `#/model/<id>`, `#/model/line/<name>`, `#/switch/<a>/<b>`, `#/people`, `#/people/<name>`, `#/search/<words>`, `#/benchmark/<id>`, `#/apps`, `#/data` and `#/account`. Model, Switch, People and Search take `?job=<id>`. Old addresses of the removed Board, Discussion, Papers and Expert articles pages, and old job ids, land on their replacements; see [design notes](docs/design.md#removed-pages-and-old-links).

The [published app](https://ai-model-picker.pages.dev/) is a static build with a dated Hacker News snapshot, the records file and the search index; it loads comment text from the public HN API on demand. Pages Functions serve the protected data to granted accounts only. See [Cloudflare Pages deployment](docs/deployment.md) for the build and release procedure.

## Local Hacker News analysis

For the local pipeline on an Apple Silicon Mac with Python 3.11 or newer:

```sh
npm run hn:setup
npm run dev
```

Open **Data**, then **Start six-month scan**. The setup uses an isolated environment and a pinned 4-bit Qwen3.8 27B model (a 16.1 GB download). With the local model there are no paid inference API calls. Downloads and local compute still consume resources. Collection reads only the archive portions and recent records needed for the selected six-month window. On an M4 Max with 64 GB the model reviews about 0.5 comments a second, so a full six-month run takes four to five days. From a terminal, the review can instead be sent to the Anthropic API in batches, which is paid and sends the scrubbed comment text to Anthropic; see [pipeline instructions](docs/hn-pipeline.md#review-through-the-anthropic-api).

The pipeline defaults to the last six calendar months in Australia/Hobart time. The analysis served starts on 17 May 2026. Its end moves forward each time the comments are updated with the pipeline's `extend` command, and the Data page shows the current range. The pipeline skips older archives, trims the boundary month and checks gaps only inside the selected ID range. It queues comments that name a model and every in-window comment in a thread whose story title names one, and reviews only comments whose timestamps are in the saved window. It preserves resumable progress in ignored `.local/hn/` directories. The UI shows processed counts, dates, model/family attribution and an in-app comment reader. **Pause** and **Resume scan** control processing. The date range is pinned when collection starts and retained on resume; `extend` moves its end to the present.

The model reads each comment with the text it replies to and the story title, after links, contact details, handles, quoted lines and code are removed. The local model runs only on a loopback address; the Anthropic backend sends the same scrubbed text to `api.anthropic.com`. For each model in the discussion it records a stance, up to three themes and a confidence, and for each comment a task, a one-sentence claim and any explicit preferences between models. Raw comment text and author fields are never written to disk on this machine; scrubbed story titles and the model-written claims are. Failed responses are tracked separately. Neither these labels nor the guide's recommendations should be treated as a representative survey of all model users.

The analysis served is reviewed by Claude Haiku 5.5 through the Anthropic API. The first review, on 19 November 2026, took under two hours and about US$7. An update reviews only the comments posted since the last one; the first, that evening, took in 2,680 comments for about 12 US cents. After it, 189,714 of 190,025 collected comments had a valid review, 88,309 of them said something about a model and were listed, and 311 had no valid review. The Data page shows the current counts. On 24 November 2026 every comment was reviewed again so that each carries one of the 13 approved jobs with its setting and run, for about US$8.24 (see [verification](docs/verification.md#hacker-news-re-review-of-24-november-2026)). The classifier's sentiment is experimental: in a 37-pair comparison with earlier AI assessments, the re-review's classifier matched 23 labels, none with the opposite sign. Its jobs matched 83 of 100 reference comments labelled by an AI reviewer. These are agreement measurements against another AI review, with no independent human validation. The [quality record](research/hn-classifier-check.json) describes this classifier and the [evaluator](scripts/evaluate_hn_classifier.py) repeats the check. The previous analysis, which classified only comments naming a model from short, masked context windows, stays in `.local/hn/` and is no longer served locally. The published app has shown the Haiku analysis since 19 November 2026 and shows whichever update was last published; its Data page gives the publication time.

The app counts labels from `core.json`, which the records build writes from the served run; the comment index is loaded only when a drawer lists comments or the thread reader under a model's Crowd band opens. The reader groups the comments under their stories and nests them by reply, with parent context and replies opened inside the app. Comment text is loaded from the public HN API on demand and kept in a bounded memory cache; author fields are omitted. Context may include older parents or newer replies, but these do not expand the collection window.

See [pipeline instructions](docs/hn-pipeline.md), [archive verification](docs/hn-archive-check.md) and [app picker sources](research/app-model-choices.md).

## Local arXiv index

`npm run arxiv:run` harvests arXiv metadata over OAI-PMH into ignored `.local/arxiv/` files, paced at one request every three seconds. It needs no model. It is a feed for reports reviewed by hand: a study it points to that controls its comparison is added to `research/reports.json`. The app shows nothing from it and the Pages build exports nothing from it; the Papers page was removed on 24 November 2026. Abstract labelling with a local model is optional. See [arXiv pipeline instructions](docs/arxiv-pipeline.md).

## Updating the data

Hacker News reviews and arXiv harvests each produce a local shortlist of reported agent failures worth testing. Each entry links to its source and suggests a check to run. See [local failure reports](docs/updating.md#local-failure-reports).

Nothing updates on its own. [Updating the data](docs/updating.md) has a step-by-step procedure for each source (Hacker News comments, arXiv metadata, the benchmark, price, report and app guide files, LMArena and Epoch runs, OpenRouter usage, the people pipeline, the job list and the model list), for publishing, and notes for automating them. Each step gives the command, the expected result and what to do when it differs. Agents start from [AGENTS.md](AGENTS.md).

## Data in the app

The public benchmark snapshot holds 153 published results across four benchmarks, 98 model/version identities, official API rates for 23 models and 15 reports. The imports of 23 November 2026 add 391 LMArena ratings from 16 leaderboards and 193 results of Epoch AI's own runs from 8 files, which with the snapshot and the reports make 752 measured records. Scores keep each benchmark's own scale, and arena ratings are preference votes, never shown as percentages. A model's score in a band or table is its best published configuration; the benchmark page lists every configuration. Missing prices and results are not estimated.

Every source becomes the same record (`src/lib/records.ts`, `scripts/records_schema.py`) with a class (measured, named or crowd) and one job from [`research/jobs.json`](research/jobs.json), the approved list of 13 jobs with a crosswalk from each source's own labels. Records also carry a setting (local or hosted), a run (interactive, unattended or parallel) and, for practitioner records, a surface (coding agent, chat app, API or local runner), set by rule. Practitioner records and Hacker News labels were reviewed against an earlier list of 17 jobs; those whose earlier job was split or became a field have no job until the next review and are counted apart as "needs reading" on the Data page. See [data provenance](docs/data.md#shared-records-and-the-job-list).

Positive share is positive ÷ (positive + critical) and is hidden below a stated minimum. Stated preferences need five before a share is given. Source links and check dates are on the Data page. See [design notes](docs/design.md).

## Known limitations

- Practitioner records are behind sign-in. Their job was assigned by a model review that agreed with a reference set half the time, and one person supplies most of them. Their counts never move an order.
- Records that need reading (their earlier job was split or became a field) have no job until the next people and Hacker News reviews with the new list.
- One benchmark from the restricted set gives no job under the new list until its category in the local restricted file is changed.
- Current image models are not in the model list. Only older image models have results, so the brief for "Make or edit images and video" shows models only after "Include older models". Adding models changes the model list, which needs a Hacker News retarget ([When the model list changes](docs/updating.md#when-the-model-list-changes)).
- Search is static: each search downloads the index manifest, one shard per word, the fact files of the matching records and the record files of the results shown, about 2 MB for a common word.
- The people review's redaction does not remove a home-folder path that follows a space or quote; see [people pipeline](docs/people-pipeline.md#known-limitations).

## Checks

```sh
npm test
npm run hn:test
npm run arxiv:test
npm run build
npm run format
npm run format:check
```

`npm run data:build` regenerates the benchmark snapshot from reviewed research files; it does not fetch current facts or update the app guide. HN data has its own resumable collection process. `npm run check:pages` checks a build made by `npm run build:pages` before it is uploaded. See [data provenance](docs/data.md) and [verification](docs/verification.md).

## Structure

- `src/App.tsx`, `src/lib/route.ts`: shell, navigation, hash routes and the old-address table.
- `src/components/FilterBar.tsx`, `ModelFilter.tsx`, `src/lib/model-filter.ts`, `src/lib/fields.ts`: the filter bar, the providers-and-models popover, the stored filters, and the setting, run and surface fields.
- `src/components/Brief.tsx`, `src/lib/brief.ts`: the job chooser, a brief and its ordering rules.
- `src/components/Bands.tsx`, `EvidenceDrawer.tsx`: the Measured, Named and Crowd bands, and the drawer every count opens.
- `src/components/Model.tsx`, `src/lib/model-page.ts`, `src/components/Switch.tsx`, `src/lib/switch.ts`: model and product-line pages, and Switch.
- `src/components/People.tsx`, `Named.tsx`, `src/lib/named.ts`, `src/lib/named-client.ts`: People, person pages, the Named band and loading the named records for granted accounts.
- `src/components/Search.tsx`, `src/lib/search.ts`, `src/lib/search-static.ts`, `scripts/search_index.py`, `scripts/search.mjs`: the Search view, the shared ranking, the browser's index reader, the index build and the local command. See [Search](docs/search.md).
- `src/components/Benchmark.tsx`, `Reports.tsx`, `src/lib/benchmark-page.ts`: one benchmark's results, and published reports.
- `src/components/AppGuide.tsx`, `PractitionerFindings.tsx`, `src/lib/guide.ts`, `src/lib/practitioner.ts`, `research/app-model-choices.json`, `research/practitioner-findings.json`: app selections, alternatives, their sources and the 13 hand-checked findings.
- `src/components/DataPage.tsx`, `DataSources.tsx`, `src/lib/data-page.ts`, `src/lib/job-rules.ts`, `src/lib/download.ts`, `src/lib/hn-client.ts`: the Data page, its counts, the job rules as shown, the download and the collection status and controls.
- `src/components/Account.tsx`, `src/lib/access.ts`, `src/lib/restricted.ts`, `src/lib/expert-articles.ts`: sign-in, access management and loading the protected data.
- `server/`, `functions/`: Google sign-in and the protected endpoints (`/api/restricted`, `/api/expert-articles`, `/api/named`, `/api/named/advice`) as Pages Functions. See [Google sign-in](server/auth/README.md).
- `src/lib/core-schema.ts`, `src/lib/core-client.ts`, `src/lib/records.ts`: reading `core.json`, and the shared record schema.
- `scripts/build-records.py`, `scripts/records_schema.py`, `research/jobs.json`: the records build and the job list. It writes `core.json`, the search index and, from `.local/people/`, the private `named-private.json`.
- `src/lib/snapshot.json`, `schema.ts`, `metrics.ts`, `scripts/build-snapshot.py`: the benchmark snapshot built from the reviewed `research/` files, its validation and cost formatting.
- `scripts/import_lmarena.py`, `scripts/import_epoch.py`, `scripts/import_common.py`, `research/lmarena.json`, `research/epoch-runs.json`, `research/aliases/`: imported LMArena ratings and Epoch runs, and the exact model names each maps to a model id.
- `scripts/import_openrouter.py`, `research/openrouter-usage.json`: imported OpenRouter usage, which orders nothing.
- `scripts/people_pipeline.py`, `scripts/people_local/`: collection of practitioners' public writing and its review into use records and method advice, with state in `.local/people/` (not in Git). See [people pipeline](docs/people-pipeline.md).
- `src/lib/attribution.ts`: source licences and credits.
- `src/components/parts.tsx`, `src/components/comment-views/`, `src/lib/hn-threads.ts`: shared sentiment bars and comment stream, and the thread reader with its loader.
- `src/lib/site-data.ts`, `hn-index.ts`, `hn-insights.ts`, `hn-published.ts`, `hn-reader.ts`, `hn-public-items.ts`, `crowd-totals.ts`: benchmark standings, the comment index (local or published), its filtering and the public HN item reader.
- `scripts/hn_pipeline.py`, `scripts/hn_local/`: collection, thread walks, text scrubbing, review on a local model or through the Anthropic API, and checkpointed storage.
- `scripts/arxiv_pipeline.py`, `scripts/arxiv_local/`: arXiv harvest, matching, optional labelling and the failure shortlist; nothing from it is published.
- `scripts/failure_review.py`: the shared rules of the local failure shortlists.
- `scripts/hn-control.mjs`, `scripts/hn-comments.mjs`: fixed local start/pause actions, choice of the served run, comment index and discussion context.
- `scripts/setup-hn.sh`, `scripts/dev.mjs`: isolated setup and local dev services.
- `scripts/export-hn-site.py`, `scripts/export-records-site.py`, `scripts/check-site.py`: the published HN snapshot, copying `core.json` and the search index into `dist/`, and the checks a Pages build must pass before upload.
- `.local/` (not in Git): pipeline state, the people data, the restricted benchmarks and the article catalog. Without it the app shows public data only; `npm run build:pages` and the Pages deploy need it.
- `AGENTS.md`, `docs/updating.md`: rules for agents, and the update and publish procedures.

All model weights, local state and generated classifier results remain outside Git. The published build includes only allowlisted HN metadata and derived assessments; these also include the story and parent IDs of each listed comment and scrubbed story titles once they are recorded, and, since the run published on 19 November 2026, the model-written claims. No account credentials, author fields or raw comment text are retained by the pipeline or included in the deployment.

## Made with AI

The code, documentation, app guide and report summaries were generated almost entirely by AI coding agents, directed by the author. Sentiment labels, themes, claims, the practitioners' use records and their jobs, and paper labels are assigned by language models. All of it can be wrong. Follow the source link on a figure before relying on it.

## Licence and attribution

Original code and documentation are dedicated to the public domain under [CC0 1.0](LICENSE), without warranty. Data from other publishers keeps its own terms, and its credit must stay with it when reused:

| Source                                                                           | Material                                                                        | Terms                                                         |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| [Epoch AI](https://epoch.ai/eci)                                                 | Epoch Capabilities Index scores                                                 | CC BY 4.0                                                     |
| [Epoch AI](https://epoch.ai/benchmarks/use-this-data)                            | Results of Epoch's own benchmark runs (not the external results it copies)      | CC BY 4.0                                                     |
| [LMArena](https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset)        | Arena leaderboard dataset: ratings, confidence bounds, vote counts and ranks    | CC BY 4.0                                                     |
| [OpenRouter](https://openrouter.ai/rankings)                                     | Usage from the Data API: 30-day token shares and 7-day task tags                | CC BY 4.0; not to be re-served as a competing API             |
| [SWE-rebench](https://huggingface.co/datasets/nebius/SWE-rebench-leaderboard)    | Leaderboard results (Badertdinov et al., 2025, arXiv:2505.20411)                | CC BY 4.0                                                     |
| [TokenSave](https://tokensave.app/data/claude-effort-cost)                       | Effort, cost and coding experiment datasets                                     | CC BY 4.0                                                     |
| [Terminal-Bench](https://www.tbench.ai/)                                         | Leaderboard runs                                                                | Apache-2.0 (benchmark code)                                   |
| [Plato Web Clone Bench](https://plato.so/research/web-clone-bench/)              | Results                                                                         | No data licence stated; cited with a link                     |
| [Contra Labs](https://contralabs.com/research) and other report publishers       | Findings from published reports                                                 | Summarised in this project's words with a link to each report |
| Practitioners' public posts and newsletters                                      | Use records and method advice with short quotes, shown only to granted accounts | Belong to their authors; each record links to its source      |
| [Hacker News](https://github.com/HackerNews/API)                                 | Comment and story IDs, timestamps, and comment text loaded on request           | Provided by Y Combinator; comments belong to their authors    |
| [open-index/hacker-news](https://huggingface.co/datasets/open-index/hacker-news) | Archive used to find comments                                                   | ODC-By 1.0                                                    |
| OpenAI, Anthropic, Google, DeepSeek and xAI                                      | API prices, model specifications and app documentation                          | Quoted from public documentation with links                   |
| Instrument Sans, Newsreader                                                      | Typefaces in `public/fonts/`                                                    | SIL Open Font License 1.1                                     |

The full credit lines and the changes made to each source are in [`src/lib/attribution.ts`](src/lib/attribution.ts) and on the app's Data page. The local arXiv harvest reads arXiv's metadata interface; nothing from it is published. Thank you to arXiv for use of its open access interoperability. This project was not reviewed or approved by arXiv. Product names are trademarks of their owners.

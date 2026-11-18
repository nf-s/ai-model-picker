# Model picker

A reference for choosing an AI model. It joins published benchmark results with six months of Hacker News discussion, so a model can be judged on both in one place.

- **Board** (home): choose a task. One table ranks models on that task's benchmarks beside HN comment volume, sentiment, its four-week change and sentiment on the matching topic.
- **Models**: one page per model or family, with its rank on every benchmark, API price, app selections, published reports, weekly sentiment, what people say, which models it is compared with, and the comments.
- **Discussion**: every collected comment, filtered by model, sentiment, topic, label confidence and period, with a ranking of models inside the current filter.
- **Papers**: arXiv papers from the same six months whose title or abstract names a tracked model or family, filtered by model or family and title words.
- **Benchmark pages**: every published result for one benchmark, including alternate configurations, with the source's method and limits. Reached from the Board's column headers and a model's benchmark tiles.
- **App guide**: which selection to make in ChatGPT and Claude on their highest-usage plans for eight tasks, with alternatives, settings and sources. Coding-agent choices are a separate mode.
- **Data**: HN collection status and controls, every source with its coverage and limits, and the snapshot download.
- **Model filter** (header, on every view): limits the whole site to chosen providers, such as ChatGPT and Claude, or to individual models. Ranks stay overall ranks. The selection is remembered in the browser and cleared in one click.

Benchmarks, prices and the app guide were checked against their sources on **16 November 2026**. App labels are kept separate from API identities. HN labels are automatic and can be wrong; the app guide's recommendations are sourced starting points. Neither is a representative survey or a universal ranking.

## Run

Node 22.22 or newer:

```sh
npm install
npm run dev
```

Open http://127.0.0.1:5186. The dev launcher also starts a loopback-only local analysis controller, which serves the comment index the HN views read.

Views are hash routes: `#/` (Board), `#/model/<key>`, `#/discussion/<key>`, `#/papers/<key>`, `#/benchmark/<id>`, `#/apps` and `#/data`. A key is `model:<id>` or `family:<name>`.

The [published app](https://ai-model-picker.pages.dev/) includes a dated HN results snapshot and loads comment text from the public HN API on demand. Benchmarks whose terms do not allow republishing are kept outside Git and shown only to Google accounts the administrator approves under **Sign in → Manage access**; the local dev server shows them from `.local/restricted/`. Source licences and credits are on the Data page. Processing continues locally; republishing updates the hosted snapshot. See [Cloudflare Pages deployment](docs/deployment.md) for the build and release procedure.

## Local Hacker News analysis

For the local pipeline on an Apple Silicon Mac with Python 3.11 or newer:

```sh
npm run hn:setup
npm run dev
```

Open **Data**, then **Start six-month scan**. The setup uses an isolated environment and a pinned 4-bit Qwen3.8 27B model (a 16.1 GB download). With the local model there are no paid inference API calls. Downloads and local compute still consume resources. Collection reads only the archive portions and recent records needed for the selected six-month window. On an M4 Max with 64 GB the model reviews about 0.5 comments a second, so a full six-month run takes four to five days. From a terminal, the review can instead be sent to the Anthropic API in batches, which is paid and sends the scrubbed comment text to Anthropic; see [pipeline instructions](docs/hn-pipeline.md#review-through-the-anthropic-api).

The pipeline defaults to the last six calendar months in Australia/Hobart time: 16 May–16 November 2026 for the analysis currently served. It skips older archives, trims the boundary month and checks gaps only inside the selected ID range. It queues comments that name a model and every in-window comment in a thread whose story title names one, and reviews only comments whose timestamps are in the saved window. It preserves resumable progress in ignored `.local/hn/` directories. The UI shows processed counts, dates, model/family attribution and an in-app comment reader. **Pause** and **Resume scan** control processing. The date range is pinned when collection starts and retained on resume.

The model reads each comment with the text it replies to and the story title, after links, contact details, handles, quoted lines and code are removed. The local model runs only on a loopback address; the Anthropic backend sends the same scrubbed text to `api.anthropic.com`. For each model in the discussion it records a stance, up to three themes and a confidence, and for each comment a task, a one-sentence claim and any explicit preferences between models. Raw comment text and author fields are never written to disk on this machine; scrubbed story titles and the model-written claims are. Failed responses are tracked separately. Neither these labels nor the guide's recommendations should be treated as a representative survey of all model users.

Until the new run has reviewed every queued comment, the app keeps serving the previous analysis, which classified only comments naming a model from short, masked context windows. Its sentiment is experimental: in a 37-pair comparison with earlier AI assessments, that classifier matched 21 labels and reversed three positive/negative labels. These are agreement measurements against another AI review, with no independent human validation. The [quality record](research/hn-classifier-check.json) describes that classifier. The [evaluator](scripts/evaluate_hn_classifier.py) now targets the new one, which matched 24 of the same 37 labels and reversed none. The record is replaced, and the new run can be published, once that run is complete.

Comments with at least one valid assessment are available through pagination, with model/family and sentiment filters. Open parent context, sibling branches and nested replies inside the app. Discussion text is loaded from the public HN API on demand and kept in a bounded memory cache; author fields are omitted. Context may include older parents or newer replies, but these do not expand the collection window.

See [pipeline instructions](docs/hn-pipeline.md), [archive verification](docs/hn-archive-check.md) and [app picker sources](research/app-model-choices.md).

## Local arXiv index

`npm run arxiv:run` harvests arXiv metadata over OAI-PMH into ignored `.local/arxiv/` files, paced at one request every three seconds. It needs no model. Abstract labelling with a local model is optional; so far it covers the papers that name an exact tracked model, and evaluation results cover 199 of the 414 evaluation papers among them. See [arXiv pipeline instructions](docs/arxiv-pipeline.md).

## Data in the app

The public benchmark snapshot holds 107 published results across four benchmarks, 76 model/version identities, official API rates for 20 models and 14 reports. Scores keep each benchmark's own scale. A model's Board and tile score is its best published configuration; the benchmark page lists every configuration. Missing prices and results are not estimated.

The HN views aggregate the full comment index in the browser: weekly sentiment, per-topic sentiment and co-mentions. Positive share is positive ÷ (positive + critical) and is hidden below a stated minimum. "What people say" on a model page comes from an AI-reviewed sample of recent comments for six models, [research/hn-themes-sample.json](research/hn-themes-sample.json); other models show only the automatic labels.

The earlier reviewed 49-comment HN sample stays in `research/` and is no longer shown in the app. Source links and check dates are on the Data page. See [design notes](docs/design.md).

## Checks

```sh
npm test
npm run hn:test
npm run arxiv:test
npm run build
npm run format
npm run format:check
```

`npm run data:build` regenerates the benchmark snapshot from reviewed research files; it does not fetch current facts or update the app guide. HN data has its own resumable collection process. See [data provenance](docs/data.md) and [verification](docs/verification.md).

## Structure

- `src/App.tsx`, `src/lib/route.ts`: shell, navigation and hash routes.
- `src/components/Board.tsx`: task-first table of benchmarks and HN discussion.
- `src/components/ModelFile.tsx`: one model or family.
- `src/components/Discussion.tsx`: filtered comment explorer with rankings.
- `src/components/Papers.tsx`, `src/components/ModelPapers.tsx`, `src/lib/arxiv-*.ts`: arXiv paper index, and the evaluation results shown on model pages and the Board.
- `src/components/Benchmark.tsx`, `Reports.tsx`: one benchmark's results, and published reports.
- `src/components/AppGuide.tsx`, `src/lib/guide.ts`, `research/app-model-choices.json`: app selections, alternatives and their sources.
- `src/components/DataPage.tsx`, `src/lib/hn-client.ts`: collection status and controls, sources and download.
- `src/components/Account.tsx`, `src/lib/access.ts`, `src/lib/restricted.ts`: sign-in, access management and loading the restricted payload.
- `server/`, `functions/`: Google sign-in and `/api/restricted` as Pages Functions. See [Google sign-in](server/auth/README.md).
- `.local/restricted/` (not in Git): benchmarks that cannot be republished. Without it the app shows public data only; `npm run data:build` and the Pages deploy need it.
- `src/lib/attribution.ts`: source licences and credits.
- `src/components/parts.tsx`: shared sentiment bars, weekly chart and comment stream.
- `src/components/comment-views/`, `src/lib/hn-threads.ts`: the Discussion comment section, which lists comments under their stories and nests them by reply, with its thread loader.
- `src/lib/site-data.ts`: benchmark standings joined to HN aggregates.
- `src/lib/hn-index.ts`, `hn-insights.ts`: comment index loading and browser-side aggregation.
- `src/lib/hn-themes.ts`, `research/hn-themes-sample.json`: AI-reviewed theme sample for six models.
- `src/lib/snapshot.json`, `schema.ts`, `metrics.ts`: sourced benchmark data, validation and cost formatting.
- `scripts/hn_pipeline.py`, `scripts/hn_local/`: collection, thread walks, text scrubbing, review on a local model or through the Anthropic API, and checkpointed storage.
- `scripts/arxiv_pipeline.py`, `scripts/arxiv_local/`, `scripts/export-arxiv-site.py`: arXiv harvest, matching, labelling, evaluation results and publish export.
- `scripts/hn-control.mjs`, `scripts/hn-comments.mjs`: fixed local start/pause actions, choice of the served run, comment index and discussion context.
- `scripts/setup-hn.sh`, `scripts/dev.mjs`: isolated setup and local dev services.

All model weights, local state and generated classifier results remain outside Git. The published build includes only allowlisted HN metadata and derived assessments; these also include the story and parent IDs of each listed comment and scrubbed story titles once they are recorded, and the model-written claims once a run made by the new pipeline is published. No account credentials, author fields or raw comment text are retained by the pipeline or included in the deployment.

## Made with AI

The code, documentation, app guide and report summaries were generated almost entirely by AI coding agents, directed by the author. Sentiment labels, topics, claims and paper labels are assigned by language models. All of it can be wrong. Follow the source link on a figure before relying on it.

## Licence and attribution

Original code and documentation are dedicated to the public domain under [CC0 1.0](LICENSE), without warranty. Data from other publishers keeps its own terms, and its credit must stay with it when reused:

| Source                                                                           | Material                                                              | Terms                                                         |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------- |
| [Epoch AI](https://epoch.ai/eci)                                                 | Epoch Capabilities Index scores                                       | CC BY 4.0                                                     |
| [SWE-rebench](https://huggingface.co/datasets/nebius/SWE-rebench-leaderboard)    | Leaderboard results (Badertdinov et al., 2025, arXiv:2505.20411)      | CC BY 4.0                                                     |
| [TokenSave](https://tokensave.app/data/claude-effort-cost)                       | Effort, cost and coding experiment datasets                           | CC BY 4.0                                                     |
| [Terminal-Bench](https://www.tbench.ai/)                                         | Leaderboard runs                                                      | Apache-2.0 (benchmark code)                                   |
| [Plato Web Clone Bench](https://plato.so/research/web-clone-bench/)              | Results                                                               | No data licence stated; cited with a link                     |
| [Contra Labs](https://contralabs.com/research) and other report publishers       | Findings from published reports                                       | Summarised in this project's words with a link to each report |
| [Hacker News](https://github.com/HackerNews/API)                                 | Comment and story IDs, timestamps, and comment text loaded on request | Provided by Y Combinator; comments belong to their authors    |
| [open-index/hacker-news](https://huggingface.co/datasets/open-index/hacker-news) | Archive used to find comments                                         | ODC-By 1.0                                                    |
| [arXiv](https://info.arxiv.org/help/api/tou.html)                                | Paper titles, identifiers, dates and categories                       | CC0 1.0 (metadata)                                            |
| OpenAI, Anthropic, Google, DeepSeek and xAI                                      | API prices, model specifications and app documentation                | Quoted from public documentation with links                   |
| Instrument Sans, Newsreader                                                      | Typefaces in `public/fonts/`                                          | SIL Open Font License 1.1                                     |

The full credit lines and the changes made to each source are in [`src/lib/attribution.ts`](src/lib/attribution.ts) and on the app's Data page. Thank you to arXiv for use of its open access interoperability. This project was not reviewed or approved by arXiv. Product names are trademarks of their owners.

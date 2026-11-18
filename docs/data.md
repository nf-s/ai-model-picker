# Data provenance

Snapshot checked 16 November 2026. Publication/evaluation dates differ and are retained where reported. This app links published findings; it has not independently rerun the evaluations.

Source terms were checked on 18 November 2026. Artificial Analysis, ARC Prize, DesignArena and Arena do not permit republishing their results. Their 80 result rows are kept outside Git in `.local/restricted/research.json`; `npm run data:build` requires that file and writes those results to `.local/restricted/results.json` instead of `src/lib/snapshot.json`. The published site shows them only to approved accounts and the JSON download leaves them out. Epoch AI, SWE-rebench and TokenSave data are CC BY 4.0; the open-index HN archive is ODC-By 1.0; arXiv metadata is CC0. Credits, licence links and changes made are listed in `src/lib/attribution.ts` and on the Data page.

| Dataset                                       | Imported results | Meaning and limitations                                                                                                                                                    |
| --------------------------------------------- | ---------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Artificial Analysis Intelligence Index v5.0.1 |               25 | Source-listed effort settings. Cost is weighted Intelligence Index workload cost. Time is a token/speed estimate, not observed end-to-end duration.                        |
| Terminal-Bench 4.1                            |               59 | Exact model/agent/effort runs. Mean trial cost is explicitly derived from total evaluation spend divided by trial count. Confidence intervals and raw totals are retained. |
| SWE-rebench                                   |               13 | Model-only entries for 15 May–1 July 2026. Historical versions are not relabelled as current versions.                                                                     |
| Epoch Capabilities Index                      |               25 | Unbounded index with credible intervals, not a percentage. Attribution: Epoch AI, CC-BY 4.0.                                                                               |
| ARC-AGI-3 Standard harness                    |               30 | Effort/checkpoint variants preserved. Provider Adapter runs are not mixed into the Standard table. Aggregate spend is not represented as task cost.                        |
| Plato Web Clone Bench                         |               10 | Best reported effort per model across nine cloning tasks. Mean run cost and duration, unequal budgets and vendor harnesses.                                                |
| DesignArena Overall Agentic                   |               15 | First 15 visible rows at the recorded source update. Bradley–Terry ratings and ambiguous percentage margin retained without reinterpreting it as percentage points.        |
| Arena Creative Writing                        |               10 | Selected source configurations; writing preference is not factual correctness. Original rating units and uncertainty retained.                                             |

The source catalog contains 35 distinct URLs. The 14 reports include professional creative critiques, repeated coding experiments and multi-agent research. A report may cover several models and is counted once. TokenSave's subscription experiments express API-equivalent usage cost, not additional subscription charges; each record retains that context and its CC BY 4.0 attribution is linked through the source catalog.

## Pricing

20 models have official standard API token rates: five OpenAI, five Anthropic, five Google, two DeepSeek and three xAI. Rates are USD per million tokens; they do not imply a per-project cost. Long-context tiers and DeepSeek peak/off-peak conditions are recorded. Gemini Carbon/Argon promotional rates and the announced 1 December change are retained.

76 model identities cover these price records plus benchmark-only and report-only models, including older releases and image models. The remaining identities have no verified price record in this snapshot. Missing values are never filled by analogy. Provider positioning is labelled as a provider description.

## Identity and normalization

The build script joins exact reviewed names and a small explicit spelling-alias table. It does not strip dates or merge generations automatically. DeepSeek's priced aliases retain the served 1017/0813 version; an older unversioned SWE-rebench record stays separate. Provider spelling variants are normalized without changing model identities.

`research/*.json` retain original numeric fields and detailed provenance. `src/lib/snapshot.json` holds the app's normalized records, per-result URLs, metadata and source catalog. Zod validates URLs, numeric values, unique IDs, model/benchmark references and cost/time context. Regression tests cover the cost denominator, missingness, configuration matching, price thresholds and scheduled rates.

## Refresh procedure

1. Reopen each relevant primary source. Record a new checked date; preserve evaluation dates and versions.
2. Update the reviewed JSON in `research/`, preserving units, uncertainty, cost basis and exact configuration.
3. Review model-name joins explicitly; an API alias can change its served release.
4. Run `npm run data:build`, `npm test`, `npm run build`, and formatting checks.
5. Check the chart, selected configurations, source links and mobile comparison before committing.

No background refresh, API keys or accounts are configured for the benchmark and guide data. Several data APIs require credentials or attribution; access notes are in the in-app source catalog. A future live integration must preserve the same provenance and version rules.

Detailed source notes: [benchmarks](../research/benchmarks.md), [pricing](../research/pricing.md), [reports and creative benchmarks](../research/reports.md).

## Hacker News feedback

The separate `research/hn-sentiment.json` snapshot contains 49 AI-assessed comments from 42 discussions, selected from 348 candidates returned by 20 model-name queries for 20 May–16 November 2026. Seventeen queried model identities have exact-version feedback. Gemini 4 Carbon and the dated DeepSeek releases remain explicit evidence gaps; unversioned DeepSeek comments are family evidence only.

All selected comment IDs, timestamps, visibility states and parent chains were checked against the official API. Sentiment, topic labels and paraphrases are AI inferences without independent human validation. The sample is relevance-ranked and selectively reviewed, with a five-comment discussion cap; it cannot establish population percentages or a universal model ranking.

`src/lib/community.ts` validates strict fields, exact model references, canonical UTC timestamps, permalinks, deduplication, the collection window and declared counts. Filtered counts use distinct comments and discussions after narrowing each assessment to its target. The downloadable data excludes account fields, raw comment bodies and quotations.

Eight additional public APIs, GitHub ingestion repositories and downloadable/hosted datasets are catalogued in [HN sources](../research/hn-sources.md). Current collection uses Algolia discovery and official API verification. Historical archives have separate freshness and access limitations.

The read-only `scripts/collect-hn.py` provides discovery metadata and official-item verification; it never overwrites labels or refreshes sentiment automatically. Verification does not detect changes to wording. See [HN methodology and refresh](../research/hn-sentiment.md).

## arXiv papers

The Papers page lists arXiv papers whose title or abstract names a tracked model or family, harvested from arXiv's OAI-PMH metadata for the same six-month window. Matching reads only the title and abstract, so papers that mention a model in passing are included and models named only in the body are missed. Abstract labels are produced by a local model. They exist for 1,382 of the 1,383 papers that name an exact tracked model; papers that name only a family are unlabelled. For papers labelled as evaluations, the same model also records the area and task tested, the named models the abstract reports as best or as behind the best, and a one-sentence finding. That pass is unfinished: 199 of 414 evaluation papers have a result. The published snapshot carries titles, identifiers, dates, categories, matched targets, labels and results; abstracts stay local. See [arXiv pipeline instructions](arxiv-pipeline.md).

## Reviewed theme sample

`research/hn-themes-sample.json` holds 217 AI-reviewed claims from the 50 most recent collected comments for each of six models (Opus 5.5, Fable 5.2, Sonnet 5.5, Astra, 6.1 Sol and Gemini 4 Argon), fetched 17 November 2026. Each entry has a stance, a one-sentence paraphrase, one to three themes from a fixed list of 18, the task and tool where stated, and any explicit comparison. 83 of the 300 comment-model pairs only mention the model in passing and are counted, not summarised. It is a single AI pass with no human validation, recency-biased, and far too small for rates. It exists to show what a theme-level pass over the full collection would add. The local `hn-thread-v1` pipeline uses 17 of these themes (all but `other`) plus `local-use`, `policy` and `release`. The sample contains no account fields or quotations.

## App recommendations and six-month processing

`research/app-model-choices.json` records eight tasks, exact app names/settings, separate chat and coding-agent choices, official source links and supporting benchmark references. The guide's starting choices are editorial recommendations. App/model identity and account rollout are distinct from API and benchmark identity; older image-model results are not assigned to the newer image tool.

The local HN pipeline supersedes the 49-comment collection as the route for broad coverage. It streams the selected six-month archive portions and recent mirror records, reconciles in-range gaps against the official API, and records processed counts. It does not use relevance-ranked top-20 search results as its corpus. The current version, `hn-thread-v1`, queues comments that name a model and every in-window comment in a thread whose story title names one, then has a local model review each comment with its replied-to text and story title. The model reads scrubbed public text on a loopback endpoint; raw text and author fields are never written to disk. The checkpoint stores derived labels, scrubbed story titles and one-sentence claims written by the model, and exposes failures separately. Until the new run has reviewed every queued comment, the app and the export keep using the previous analysis, whose classifier read only masked context around detected model mentions. Full details, verification and refresh boundaries are in [pipeline instructions](hn-pipeline.md) and [archive checks](hn-archive-check.md).

The Cloudflare Pages build exports the served run's summary and the metadata of every comment with at least one valid assessment, from one SQLite read transaction. Its counts use distinct comment records rather than cumulative source-partition counters. For a run made by `hn-thread-v1`, the export also includes the story ID, parent ID, task, claim, themes and preferences of each listed comment, and the scrubbed titles of their stories. The previous analysis gains the story ID, parent ID and scrubbed story titles once the `context` command has filled them in, so an export made after that includes them too. The export refuses a run whose classifier differs from the [quality record](../research/hn-classifier-check.json), which still describes the previous classifier, so the new run cannot be published until it has been evaluated. The in-app reader retrieves public comment text on demand, without adding bodies or author fields to the published files. The publication timestamp identifies the hosted snapshot; it does not update automatically when local processing continues.

# Benchmark snapshot provenance

Checked 21 November 2026. `benchmarks.json` then contained 143 result rows across three datasets, covering 76 models after the build's spelling aliases. This is a curated snapshot, not an automatically refreshed copy of each leaderboard.

| Dataset                                          | Imported results | Retrieval and interpretation                                                                                                                                                                                                                                               |
| ------------------------------------------------ | ---------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Terminal-Bench 4.1](https://www.tbench.ai/)     |               66 | Public page's embedded leaderboard data, identified by board name `4-1-0`, data updated 20 November 2026. All published rows imported, covering 53 models. Preserves agent, effort, 95% confidence half-width, trial count, total cost, average trial duration and pass@5. |
| [SWE-rebench](https://swe-rebench.com/)          |               13 | All model-only rows with numeric results in the 15 May–1 July 2026 window: 111 problems from 65 repositories. The four agent-product rows were excluded. On 21 November 2026 the site offered no later window.                                                             |
| [Epoch Capabilities Index](https://epoch.ai/eci) |               64 | [Official CSV](https://epoch.ai/data/eci_scores.csv), updated 20 November 2026: every model released on or after 1 June 2026, and earlier models the app already lists. Credible bounds retained. Attribution: Epoch AI, CC-BY 4.0.                                        |

## Cost and time

Terminal-Bench publishes total evaluation cost. `costUsd` is a derived mean per trial: `totalCostUsd / trials`. Both operands remain in the file. This is not cost per successful task. The raw average-trial duration is used for time. The source's `date` column denotes model release date, so it is stored as `releaseDate`, not a fabricated run date. The source data-update timestamp is retained at dataset level. The source shows a total cost of $0.00 for Muse Spark 1.3; the row keeps the published value, so its derived mean is also zero.

SWE-rebench cost is the source's mean cost per problem. Its reported uncertainty is standard error of the mean, not a 95% interval. [Methodology](https://swe-rebench.com/about)

Epoch does not provide task costs or times in the imported CSV. Missing fields are absent, never zero-filled.

## Configuration and date caveats

The `primary` flag selects an explicit initial configuration; it does not combine different runs. Terminal-Bench uses the first source-ranked run for each model. Alternate configurations remain available.

Terminal-Bench lists Copilot Fusion in its model column. [GitHub describes it](https://docs.github.com/en/copilot/concepts/models/copilot-fusion) as a router that chooses and combines several models for each task, so its result does not belong to a single model. Terminal-Bench's Gemini 3.1 Pro row is stored under the Gemini 3.1 Pro Preview identity, because [Google released 3.1 Pro to developers as a preview](https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-1-pro/).

SWE-rebench's older model versions must remain distinct from current versions.

Epoch aggregates component evaluations with different settings and evidence sources; its scores are an unbounded index, not percentages. Epoch revises scores, bounds and release dates as data arrives: between the 16 and 21 November 2026 checks, Gemini 4 Carbon's release date moved from 28 October to 10 November 2026 and Gemini 4 Argon's from 30 September to 13 October 2026. Release dates also differ between sources: Terminal-Bench dates Mistral Large 4 to 6 October 2026, while Epoch dates Mistral Large 4 to 29 October and lists a separate Mistral Large 4 Preview on 6 October.

Epoch spells some models differently from the other sources, for example `Inkling-Small`, `MiniMax-M3` and `DeepSeek-V4-Pro`. Rows keep Epoch's spelling and the build joins them through its explicit alias table. The CSV's DeepSeek V4.1 Flash, released 9 September 2026, is not imported: in the app that name is the identity of the later 1017 release, which the CSV lists separately. Reported API availability in separate sources may be newer than the Epoch model metadata, so availability is not imported from that CSV.

## Validation

Validated JSON parsing, dataset/result counts, finite numeric scores, nonnegative available cost/time values, HTTPS result source URLs, and exactly one initial configuration per model within each dataset. No credentials or private source material were used.

This snapshot does not schedule ingestion or authorize deployment.

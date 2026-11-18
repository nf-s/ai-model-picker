# Benchmark snapshot provenance

Verified 16 November 2026. `benchmarks.json` contains 152 result rows across five datasets, with 61 source model names. This is a curated snapshot, not an exhaustive or automatically refreshed copy of every leaderboard.

| Dataset                                                                                            | Imported results | Retrieval and interpretation                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------- | ---------------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Artificial Analysis Intelligence Index v5.0.1](https://artificialanalysis.ai/leaderboards/models) |               25 | Public HTML table. Preserves the configuration shown for each model. Includes source task cost, context, first-answer latency and estimated task time.                                                          |
| [Terminal-Bench 4.1](https://www.tbench.ai/)                                                       |               59 | Public page's embedded leaderboard data, identified by board name `4-1-0`. All published rows imported. Preserves agent, effort, 95% confidence half-width, trial count, total cost and average trial duration. |
| [SWE-rebench](https://swe-rebench.com/)                                                            |               13 | All model-only rows with numeric results in the visible 15 May–1 July 2026 window: 111 problems from 65 repositories. Product-level agent rows were excluded.                                                   |
| [Epoch Capabilities Index](https://epoch.ai/eci)                                                   |               25 | [Official CSV](https://epoch.ai/data/eci_scores.csv), prioritizing models also found on the current AA table. Credible bounds retained. Attribution: Epoch AI, CC-BY 4.0.                                       |
| [ARC-AGI-3, Standard harness](https://arcprize.org/leaderboard)                                    |               30 | Verified summary tables from seven individual model pages, with each published effort retained. No Provider Adapter result is substituted for a Standard result.                                                |

## Cost and time

Artificial Analysis defines cost/task against its weighted evaluation workload. Its time/task is estimated from token usage and representative API output speed, rather than timed evaluation runs. The imported minutes were converted to seconds. [Methodology](https://artificialanalysis.ai/methodology)

Terminal-Bench publishes total evaluation cost. `costUsd` is a derived mean per trial: `totalCostUsd / trials`. Both operands remain in the file. This is not cost per successful task. The raw average-trial duration is used for time. The source's `date` column denotes model release date, so it is stored as `releaseDate`, not a fabricated run date. The source data-update timestamp is retained at dataset level.

SWE-rebench cost is the source's mean cost per problem. Its reported uncertainty is standard error of the mean, not a 95% interval. [Methodology](https://swe-rebench.com/about)

Epoch does not provide task costs or times in the imported CSV. ARC's published aggregate spend is not imported as per-task cost. Missing fields are absent, never zero-filled.

## Configuration and date caveats

The `primary` flag selects an explicit initial configuration; it does not combine different runs. AA uses the configuration in its visible table. Terminal-Bench uses the first source-ranked run for each model. ARC uses the highest published effort within the Standard harness, even when a lower effort scores better. Alternate configurations remain available.

ARC's [Fable 5.2 page](https://arcprize.org/results/anthropic-claude-fable-5-2) notes changed release tuning at medium and xhigh effort; those imported rows identify the earlier checkpoint. Its max run hit the 12-hour cap in 28 of 55 games. Highest-effort Standard results are absent for [Carbon](https://arcprize.org/results/google-gemini-4-carbon) and [Argon](https://arcprize.org/results/google-gemini-4-argon); no missing score is treated as zero.

SWE-rebench's older model versions must remain distinct from current versions. Epoch aggregates component evaluations with different settings and evidence sources; its scores are an unbounded index, not percentages. Reported API availability in separate sources may be newer than the Epoch model metadata, so availability is not imported from that CSV.

## Validation

Validated JSON parsing, dataset/result counts, finite numeric scores, nonnegative available cost/time values, HTTPS result source URLs, and exactly one initial configuration per model within each dataset. No credentials or private source material were used.

This snapshot does not schedule ingestion or authorize deployment. The AA API is documented but requires a key; no key was used. Public table extraction and future redistribution should respect the source's applicable terms.

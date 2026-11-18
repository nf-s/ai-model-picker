# Evidence snapshot

Retrieved 16 November 2026. `reports.json` contains 14 cited reports and 19 source-discovery entries. `creative-benchmarks.json` contains 35 numeric rows across three original scales. All source links are primary publisher pages; no fabricated reports, quotations, star ratings or sentiment totals are included.

## Interpretation and integration

- `modelNames` identifies exactly the model versions discussed. Do not transfer older-version findings to a newer model.
- `configuration` retains effort or harness where the source states it. Missing effort remains unknown.
- `costType: api-equivalent` means observed token usage valued at list prices, including reported cache usage where applicable. TokenSave used paid subscriptions; these figures are not incremental subscription charges.
- `costType: reported-run-cost` means the publisher's run-level cost. Plato does not specify every billing inclusion in the visible results table. Do not combine its cost with a made-up token budget.
- Reports without a cost have no published cost captured here. Display a missing value, never zero.
- Benchmark ratings remain on their original scales. DesignArena preference ratings, Arena writing ratings and Plato replication percentages are not comparable units.
- A report is evidence about a particular experiment. Do not turn a favorable summary into a general endorsement or a current measured quality score.

## Numeric benchmark coverage

| Dataset                                                                           | Rows | Snapshot                | Selection                               |
| --------------------------------------------------------------------------------- | ---: | ----------------------- | --------------------------------------- |
| [Plato Web Clone Bench](https://plato.so/research/web-clone-bench/)               |   10 | Retrieved 16 Nov 2026   | Source's best-effort row for each model |
| [DesignArena Overall Agentic](https://www.designarena.ai/leaderboard)             |   15 | 16 Nov 2026, 02:03 UTC  | First 15 visible rows                   |
| [Arena Creative Writing](https://arena.ai/leaderboard/chat/text/creative-writing) |   10 | Source date 11 Nov 2026 | Selected contemporary configurations    |

DesignArena's search-engine snippet was older than the opened page. Only the opened-page values were retained. Its displayed margin field is preserved as shown, without interpreting it as a rating confidence interval; the general methodology and leaderboard footer use inconsistent descriptions of that field. Arena's default-view adjustment setting was not inferred from the text extraction. Its raw displayed rating and uncertainty are retained with the original URL.

## Access and limitations

[DesignArena's official API](https://docs.designarena.ai/api-reference/overview) requires an application, bearer authentication and attribution. No key was requested or used. The source catalog distinguishes public pages, downloadable research datasets and authenticated APIs.

The [GenPeach report](https://contralabs.com/research/genpeach-v1-preview-head-to-head) explicitly discloses commissioning by the evaluated vendor; that caveat is retained. The [Anthropic research-agent study](https://www.anthropic.com/research/multi-agent-research-system) is an internal vendor evaluation on earlier model versions. The [Google agent-scaling study](https://www.research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/) informs task decomposition, not a particular model's current price or quality.

TokenSave datasets are linked with organizational attribution and their CC BY 4.0 notice in the catalog. Reports paraphrase findings and link to the original experiments; no personal author names, contact details or source-page prompt fixtures are copied.

## Validation

Both JSON files were parsed and checked for required fields, unique IDs, HTTPS source links, supported categories, finite nonnegative numeric metrics, and cost-context presence. Numeric benchmark rows were checked against the opened primary tables. Unknown metrics are omitted rather than estimated.

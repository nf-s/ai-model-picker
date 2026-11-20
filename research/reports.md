# Evidence snapshot

Retrieved 21 November 2026. `reports.json` contains 15 cited reports and 16 source entries. `creative-benchmarks.json` contains 10 numeric rows from one benchmark. All source links are primary publisher pages; no fabricated reports, quotations, star ratings or sentiment totals are included.

## Interpretation and integration

- `modelNames` identifies exactly the model versions discussed. Do not transfer older-version findings to a newer model.
- `configuration` retains effort or harness where the source states it. Missing effort remains unknown.
- `costType: api-equivalent` means observed token usage valued at list prices, including reported cache usage where applicable. TokenSave used paid subscriptions; these figures are not incremental subscription charges.
- `costType: reported-run-cost` means the publisher's run-level cost. Plato does not specify every billing inclusion in the visible results table. Do not combine its cost with a made-up token budget.
- Reports without a cost have no published cost captured here. Display a missing value, never zero.
- Plato replication percentages stay on their original scale. They are not comparable with the preference ratings or win rates in the reports.
- A report is evidence about a particular experiment. Do not turn a favorable summary into a general endorsement or a current measured quality score.

## Numeric benchmark coverage

| Dataset                                                             | Rows | Snapshot                                     | Selection                               |
| ------------------------------------------------------------------- | ---: | -------------------------------------------- | --------------------------------------- |
| [Plato Web Clone Bench](https://plato.so/research/web-clone-bench/) |   10 | Retrieved 21 Nov 2026; page dated 5 Oct 2026 | Source's best-effort row for each model |

The results table was unchanged from the 16 November check. Durations are shown rounded to minutes and stored in seconds.

## Access and limitations

The [GenPeach report](https://contralabs.com/research/genpeach-v1-preview-head-to-head) explicitly discloses commissioning by the evaluated vendor; that caveat is retained. The [Frontier Design report](https://contralabs.com/research/frontier-design-benchmark) was run with a research partner, and Contra states that it works with frontier labs and with the team behind Gestalt, an unreleased model whose provider is not disclosed. Its ratings are read from the report's chart images; its run costs are plotted without stated values, so none are recorded. The [Anthropic research-agent study](https://www.anthropic.com/research/multi-agent-research-system) is an internal vendor evaluation on earlier model versions. The [Google agent-scaling study](https://www.research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/) informs task decomposition, not a particular model's current price or quality.

TokenSave datasets are linked with organizational attribution and their CC BY 4.0 notice in the catalog. Reports paraphrase findings and link to the original experiments; no personal author names, contact details or source-page prompt fixtures are copied. The source catalog distinguishes public pages and downloadable research datasets. No account or key was used.

## Validation

Both JSON files were parsed and checked for required fields, unique IDs, HTTPS source links, supported categories, finite nonnegative numeric metrics, and cost-context presence. Numeric benchmark rows were checked against the opened primary table. Unknown metrics are omitted rather than estimated.

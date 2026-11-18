# Hacker News comment sources

Checked 2026-11-16. [Source inventory](./hn-sources.json) contains eight verified APIs, archives and ingestion projects. They are different access routes to overlapping HN material, not eight independent communities.

Use **Algolia for discovery and the official HN API for validation and context**. The live search endpoint returned a newest comment timestamp of `2026-11-16T02:42:19Z` during this review. No bulk corpus was downloaded and no paid query was run.

| Source                                                                                                                | Useful for                                          | Coverage limitation                                              |
| --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------- |
| [Official API](https://github.com/HackerNews/API)                                                                     | Comment bodies, ancestors, children, deletion state | Item lookup requires traversal; no full-text search              |
| [Algolia HN Search](https://hn.algolia.com/api)                                                                       | Model/version and date searches                     | Search results can be capped or non-exhaustive                   |
| [Nixiesearch archive](https://huggingface.co/datasets/nixiesearch/hackernews-comments)                                | Downloadable raw historical items                   | Card ends at 2024-09-02                                          |
| [Nixiesearch scraper](https://github.com/nixiesearch/hnscrape)                                                        | Resumable GitHub ingestion example                  | Code rather than an additional discussion source                 |
| [Open-index archive](https://huggingface.co/datasets/open-index/hacker-news)                                          | Monthly Parquet and per-month statistics            | Card's freshness/coverage claims need verification against files |
| [Typedef snapshot](https://huggingface.co/datasets/typedef-ai/hacker-news-dataset)                                    | 2025 comment and relationship tables                | Some referenced comments are missing                             |
| [ClickHouse dataset](https://clickhouse.com/docs/get-started/sample-datasets/hacker-news)                             | SQL prototyping and bulk files                      | Documented sample, not verified current coverage                 |
| [BigQuery HN table](https://console.cloud.google.com/bigquery?p=bigquery-public-data&d=hacker_news&t=full&page=table) | Large historical SQL analysis                       | Current schema/freshness not queried; query costs apply          |

## Practical endpoints

These templates use placeholders; substitute encoded model terms, numeric IDs and Unix timestamps. They must not be copied literally as executable requests.

```text
GET https://hn.algolia.com/api/v1/search?query=<ENCODED_MODEL_VERSION>&tags=comment&page=0&hitsPerPage=50
GET https://hn.algolia.com/api/v1/search_by_date?query=<ENCODED_MODEL_VERSION>&tags=comment&numericFilters=created_at_i%3E<START_UNIX>,created_at_i%3C<END_UNIX>&page=0&hitsPerPage=50
GET https://hn.algolia.com/api/v1/search?tags=comment,story_<STORY_ID>&page=0&hitsPerPage=50
GET https://hn.algolia.com/api/v1/items/<ITEM_ID>
GET https://hacker-news.firebaseio.com/v0/item/<ITEM_ID>.json
```

Algolia response envelope: `hits`, `page`, `nbPages`, `nbHits`, `hitsPerPage`, `exhaustiveNbHits`. Useful hit fields: `objectID`, `comment_text`, `created_at_i`, `parent_id`, `story_id`. Its item endpoint exposes `children`. The [API documentation source](https://github.com/algolia/hn-search/blob/master/app/javascript/views/Api.tsx) documents tag/date filters and a 10,000-request hourly limit per IP. The source repository is archived, but the live API was reachable.

The official item response can include `id`, `type`, `time`, `text`, `parent`, `kids`, `dead` and `deleted`; fields can be absent and a lookup can be null. Validate at the boundary. `text` is HTML, so treat it as untrusted content. The official documentation defines `score` for stories/poll options; **do not infer comment upvotes from missing or zero scores**.

The global Algolia probe returned `exhaustiveNbHits: false` and `nbPages: 1000` with `hitsPerPage: 1`. This is an observation, not a universal pagination contract. Split broad searches into smaller date windows and report incomplete retrieval when it persists.

## Collection and analysis for this app

1. Search exact public model names and versions within a recorded date range. Maintain an explicit alias map. Broad terms such as a product family or an ambiguous model nickname should not automatically match a specific version.
2. Deduplicate by item ID, fetch the official item, and follow parent IDs to the story. A reply may agree with criticism or refer to another model; isolated text can reverse its meaning. Skip dead/deleted items and record missing context.
3. Process only the fields needed for model and aspect classification. Discard account names, profiles and other personal fields at ingestion. Do not retain or publish raw comment text under this project's current instructions. Persist derived counts, model/aspect labels, evidence IDs, timestamps and links; exclude text-bearing diagnostics.
4. Separate favorable, critical, mixed and unclear discussion. Classify the model and aspect together: coding, design, reliability, latency, price and agent workflows. An enthusiastic comment about AI in general is not favorable evidence about a named model. A positive word counter is only a heuristic, not a validated model-quality measure.
5. Report the analyzed-comment count, unique-thread count, date window, retrieval coverage and classification method beside every summary. Avoid displaying a percentage when there is too little evidence; a missing match means insufficient coverage, not neutral sentiment. Keep developer anecdotes separate from controlled benchmark results.
6. Preserve a reproducible manifest: query templates, model aliases, time windows, item IDs, retrieval timestamps, validation/classifier version, counts excluded and reasons. For archive experiments, record the repository revision/file checksum and exact date range. Since raw text is not retained, exact future reclassification may be impossible after source edits or deletions; state this limitation.

For this prototype, a bounded recent sample is more useful than importing tens of millions of unrelated comments. HN is one self-selected technical community. Search terms, launch-thread bursts and a few active discussions can skew the result; thread counts and visible coverage help users interpret it.

## Archive and access checks

- The [Open-index card](https://huggingface.co/datasets/open-index/hacker-news/raw/main/README.md) describes live polling but showed an August 2026 update and conflicting coverage descriptions. Inspect `stats.csv`, file inventory and actual maximum timestamps before trusting its current-data claim. Its integer `type` schema differs from the official API's string enum.
- [Typedef's card](https://huggingface.co/datasets/typedef-ai/hacker-news-dataset/blob/main/README.md) documents missing child records and snapshot limitations. Fetch only needed tables; its profile and submission-history tables are outside this app's purpose.
- [Google's HN example](https://cloud.google.com/blog/products/data-analytics/use-gemini-and-open-source-text-embedding-models-in-bigquery/) confirms the public table reference. [Public-dataset documentation](https://docs.cloud.google.com/bigquery/public-data) explains query charging, the free allowance and lack of an SLA. Check table metadata and use a dry run before a large query; a Marketplace page's update date is not the data's update date.
- Source licenses in the JSON are the publishers' stated labels. A scraper's code license and permission to access an API do not establish a blanket license for discussion text. Public accessibility also does not override this repository's restrictions on personal information.
- A stories-only dataset with a `comments` or `descendants` count is insufficient: sentiment needs comment bodies and parent context. None of these sources supplies validated per-model sentiment labels out of the box.

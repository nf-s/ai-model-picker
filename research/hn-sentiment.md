# Hacker News model feedback

The 16 November 2026 snapshot contains AI assessments of 49 comments in 42 public discussions. Discovery returned 348 distinct candidates across 20 search terms. The selected comments cover 17 of the 20 exact model identities searched. The search window runs from 20 May through 16 November 2026 in UTC. Retrieval took place on the last day of the window. [Reviewed snapshot](./hn-sentiment.json)

## Discovery and verification

One relevance-ranked page of up to 20 comments per search term came from Algolia's HN search endpoint. The queries are recorded beside each model in the snapshot. Searches used comment text, the `comment` tag and UTC creation-time bounds. Candidate IDs were deduplicated across queries. The index match count for each term includes any results Algolia matched, including other versions, quotations and irrelevant hits. Live index changes can alter counts and page contents on replay. [Algolia HN Search API](https://hn.algolia.com/api)

The official Hacker News API confirmed each selected item's type, visibility and creation time. Traversal from every selected comment through its parents confirmed the discussion ID and its permalink. An AI reviewer checked substantive feedback and exact-model attribution against the comment and relevant context. The review applied a cap of five selected comments per discussion and set no target sentiment balance. [Official Hacker News API](https://github.com/HackerNews/API)

## Labels and coverage

- **Positive** covers favorable experiences or opinions about the target. **Negative** covers criticism or dissatisfaction. **Mixed** covers substantial praise and criticism about the same target. **Neutral** covers informative observations without a clear evaluation.
- Each assessment can identify coding, reliability, cost, speed, design or agent workflows. A comment can assess multiple models separately. Model summaries count unique comments and discussions.
- Exact-model attribution requires a version in the comment or unambiguous discussion context. The snapshot records both match bases. Confidence describes attribution. Family-only assessments remain separate from exact-model counts.
- Gemini 4 Carbon, DeepSeek V4.1 Flash 1017 and DeepSeek V4 Pro 0813 had no exact-model assessments in the selected sample. Unversioned DeepSeek feedback is retained as family evidence.
- The reviewer inferred the labels and paraphrased the observations. The review did not independently validate these labels with a human reviewer or replicate reported experiences, cost estimates or alleged quality changes. This is a query-selected sample from one self-selected community.

The snapshot stores item and discussion IDs, timestamps, permalinks, classifications and original paraphrases. It excludes account fields, quotations and comment bodies. Future source edits and deletions can affect what can be verified.

## Refresh

Run candidate discovery for the desired UTC dates. The command emits query match counts and candidate identifiers and timestamps. It does not change the snapshot. Both flags default to the reviewed snapshot's dates.

```sh
python3 scripts/collect-hn.py discover --start 2026-05-20 --end 2026-11-16
```

Review the selected candidates and their parent context, then update the JSON with checked dates, counts, supported labels and original paraphrases. Exclude author information and raw text from review records. Rerun the official item checks and the app's tests after editing. Verification detects unavailable/deleted items, timestamp differences and changed or invalid ancestry. It does not compare comment wording with the reviewed text; edited wording and sentiment require a fresh review.

```sh
python3 scripts/collect-hn.py verify
npm test
```

# Hacker News source verification

Checked 16 November 2026.

The current scan selects six months only. The inventory below describes source availability, not the amount the app collects.

## Monthly archive

The Open Index repository at revision `c54ced5973b95d80cd934b8921f44ec8d87c3cd1` has 239 monthly Parquet files from October 2006 through August 2026. The file list, file sizes, row counts and minimum and maximum IDs agree with its monthly statistics. The monthly files contain 49,324,111 rows in 254 row groups. The latest August item is 49,395,220 at 23:59:48 UTC on 21 August. Date partitions can have overlapping ID ranges. [Pinned repository](https://huggingface.co/datasets/open-index/hacker-news/tree/c54ced5973b95d80cd934b8921f44ec8d87c3cd1) · [Monthly statistics](https://huggingface.co/datasets/open-index/hacker-news/blob/c54ced5973b95d80cd934b8921f44ec8d87c3cd1/stats.csv)

The live-file manifest lists 193 blocks for 23 August, but the pinned file tree contains 81 blocks for that date. The archive plan uses the verified monthly watermark and begins its catch-up at ID 49,395,221. [Live-file manifest](https://huggingface.co/datasets/open-index/hacker-news/blob/c54ced5973b95d80cd934b8921f44ec8d87c3cd1/stats_today.csv) · [Pinned live block inventory](https://huggingface.co/datasets/open-index/hacker-news/tree/c54ced5973b95d80cd934b8921f44ec8d87c3cd1/today/2026/08/23)

Parquet projection of ID, type, time, parent, visibility flags and body is approximately 6.69 GB compressed. The August smoke test read all 265,364 rows using HTTP byte ranges and in-memory batches. The projection omits author fields. The archive row count describes the records supplied by the mirror. Official Firebase queries can resolve items outside that coverage.

## Catch-up

ClickHouse Playground's `default.hackernews_history` table is a self-updating HN mirror ordered by ID. `FINAL` applies the table's version replacement, so the range reader receives at most one row per ID. The reader requests up to 512 IDs per call and validates the ordered result. It retains bodies in memory only for visible comments matching the model prefilter. [ClickHouse table definition](https://clickhouse.com/blog/clickhouse-release-25-04)

The Firebase high-water mark was 50,513,608 during verification. ClickHouse returned 1,113,086 unique rows for the inclusive 49,395,221–50,513,608 range, which covers 1,118,388 possible IDs. The 5,302 IDs missing from that response require individual Firebase reads to distinguish unavailable items from mirror omissions. The exact counts can change as new records arrive. A 512-ID live request verified the wire schema and in-memory prefilter. [Official Hacker News API](https://github.com/HackerNews/API)

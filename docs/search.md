# Search

Word search over the shared records (see [Shared records and the job list](data.md#shared-records-and-the-job-list)), in the app's Search view and from a local command. One tokeniser and one ranking serve both: `src/lib/search.ts`, with the same tokeniser, shard mapping and document text in `scripts/search_index.py` for the index files. `tests/fixtures/search-tokens.json` keeps the two tokenisers in step, and `tests/search.test.ts` checks that the browser and the local command return the same ordered records from an index built by the records build.

## What a search finds

- **Words.** Text is lower-cased and split into runs of letters or numbers (a number keeps its dots, as in `5.5`). Common words such as "the", "best" and "model" are dropped, and a final "-ing" or "-s" is cut, so "refactoring" and "refactor" match. The first 12 words of a query are searched; the page lists any left out.
- **Rule.** A record needs at least half of the words that are in the records; records holding all of them come first. A word no record holds does not count toward the half and is listed as not in the records.
- **Order.** Among records holding the same number of words, BM25 with each word counted once per record (k1 1.2, b 0.75): a rarer word and a shorter record count for more. Ties go to the newer record.
- **What a record is found by.** Its summary, quote (local command only), conditions, the names of the models and lines it names, its person (local command and granted accounts only), source title, kind, tool, effort, job and, for use records, the model as written, the task and the compared model.
- **Filters.** The filter bar applies as it does on Brief: job (with its sub-jobs; a measured record also passes through a benchmark that orders the job), sources, period (Hacker News records from the first of the month), models (a measured record through an exact model; other records through any model or line they name), current models only, the basis for use records, setting and run (Crowd and named records) and surface (named records). Method advice names no model, so the model filters leave it in.
- **Bands.** Results are grouped by band (Measured, Named, Crowd), then by job. Named jobs are marked "job by review". Each band lists its best 1,000; the counts cover every match.

## The public index

`npm run records:build` writes `build/records/search/` from the same records as `core.json`: measured records and the Hacker News labels with their claims. It holds no named record, quote, person or OpenRouter usage; the build stops if one reaches it. `npm run build:pages` copies it to `dist/search/`. Every file is named by a number, so a searched word reaches a file name only through a shard number.

| File         | Holds                                                                                                                                                                        |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.json` | Build time, record counts, which document numbers are Hacker News and which measured, average length, file counts, the job, benchmark, setting-and-run and target-key tables |
| `t/<n>.json` | 256 shards: for each word, the numbers of the records that hold it, as gaps. A word's shard is the FNV-1a hash of its bytes modulo 256                                       |
| `a/<n>.json` | Per record, 4,096 to a file: its length in words, job, benchmark, date, setting and run, and target keys, which the filters and the ranking read                             |
| `r/<n>.json` | The records, 32 to a file, without `quote` and `person`                                                                                                                      |

Records are numbered with Hacker News oldest first, then measured records, so a Hacker News update rewrites only the last record files and the measured ones. Every file carries the build time; the browser refuses a file from another build than its `index.json`.

A search reads `index.json`, the shard of each word, the fact files of the records holding enough of the words, and the record files of the results shown. Measured on 24 November 2026 in a local preview of the published build: "claude" read 37 files, 2.1 MB (333 KB compressed); "mirrorcode" read 5 files, 127 KB (26 KB compressed). The index then had 90,576 records in 3,111 files, 57 MB in all, the largest 111 KB. Each Hacker News update adds about one record file per 32 new comments; `npm run check:pages` stops a build over 20,000 files.

## Named results

Use records and method advice are never in the public index. A signed-in, granted account already holds them in the browser (`/api/named`, `/api/named/advice`), and the Search view ranks them there with the same module, each kind as its own collection. Anonymous visitors see the sign-in line in the Named band.

## The local command

```sh
npm run search -- <words> [--band measured|named|crowd] [--job <id>] [--model <model id or line name>] [--limit <n>]
```

It reads `build/records/search-local.sqlite` and `build/records/core.json`, both written by `npm run records:build`, and makes no network request. The SQLite file holds every public record, numbered as in the public index, and the use records and method advice with their quotes; an FTS5 index finds the records holding any of the words, and `src/lib/search.ts` ranks them. It prints JSON: the words searched and not found, the rule, the filters, the index's build time and counts, counts per band (`measured`, `use`, `advice`, `crowd`) and job, and the best `--limit` records of each band (default 10) with id, job and how it was assigned, words matched, score, summary, quote and person where held, targets with their stance, tool, effort, conditions, benchmark, date, title and source link.

The output holds practitioners' quotes and names. It is private: never write it to a tracked file, a commit message or a public page.

## For agents

A coding agent choosing a model for a subtask can ask the records instead of guessing:

1. Run `npm run records:build` once if `build/records/search-local.sqlite` is missing or older than the data.
2. Search for the subtask in a few words, with the job where one fits (`research/jobs.json` lists the ids): `npm run search -- refactor typescript migration --job code`.
3. Read `counts` first: a band with few records is thin evidence. Measured records order models; named and crowd records say where a model did well or failed, and never set an order by volume ([Goal](goal.md)).
4. Open the `url` of each record you rely on and name it in your answer, with the model, tool, effort and date the record states.
5. Keep the output out of tracked files.

# Design and implementation

## Purpose

[Goal](goal.md) states the question the project answers and what counts as an answer. This page describes the current views.

The site answers which model to use by putting two kinds of evidence side by side: published benchmark results and what people on Hacker News report. Every view joins the two. There is no synthetic aggregate score; benchmarks keep their own scales and HN labels keep their stated limits.

## Views

- **Brief** (`#/`) is the home page. `#/` shows the job chooser: each job with the number of its measured records within the filters, which opens those records, and the benchmarks that measure it (per surface where the job is measured per surface), or "No measure". Write or change code is shown as a group with its four sub-jobs inside it. It shows no practitioner counts. An old address naming a job that was split or became a field opens the chooser with one line saying what became of it. `#/brief/<job>` shows one job: for Write or change code (and a sub-job ordered by its measure), "Measure for" with a switch between Coding agent and Chat app, which sets `?surface=` in the address, and the benchmark that orders it; a note naming what sets the order (the benchmark, its source and dates, what it measures, and, where they apply, the wording for a parent job's benchmark, a benchmark that covers few models, or no measure); First choice, Second and Lower cost cards; the full ordered table with overall ranks; and the OpenRouter usage block, collapsed, with its limitation and attribution line. Each card shows the provider, the API price, the reason, the configuration and cost per task where the benchmark reports them, the App guide's selection for the job's guide task, and three bands: Measured, Named and Crowd. For a signed-in, granted account the table adds a Named column (use records and their outcome strip, headed "job by review"), which never moves a row. An unknown job id shows a notice, not another job. See [Brief's rules](#briefs-rules) and [People and the Named band](#people-and-the-named-band).
- **Models** (`#/model`) lists the models within the filters, by provider, with status and API prices, and every product line.
- **Model** (`#/model/<id>`) is one exact model: provider, status, API prices, context window, the product lines whose name its name contains, and the price source; "Compare with", which opens Switch; **evidence by job**, one row for all jobs, each job and records with no job, with the measured-record count, for a granted account the named use records with their outcome strip (headed "job by review"), the Hacker News label count and the Crowd stance, each count opening its records; the Measured, Named and Crowd bands for the job in the address (`?job=<id>`, all jobs without it), the Crowd band adding stated preferences by the other model and the themes of the model's labels; and the OpenRouter usage line with its period, source, licence and limitation, which shows nothing when the model is in neither published top list. "Open all in the thread reader" opens the comments behind the Crowd count under the band (`?comments=open`), limited to the model, the job and the period. An unknown id shows a notice, not another model. See [Model and Switch rules](#model-and-switch-rules).
- **Product line** (`#/model/line/<name>`) holds the Hacker News labels that name a line without a version, such as "Claude" or "GPT": the models in the line, each linked, evidence by job, and the Named and Crowd bands. Measured results name exact models and are not shown here. A line's records, named or Crowd, are never added to a model's counts.
- **Switch** (`#/switch/<a>/<b>`) compares two models in the job in the address: the API price and how the output price changes, each benchmark of the job with a result for both and whether their intervals overlap, cost per task where the benchmark reports it, stated preferences between the two, for a granted account the count of named comparisons (use records of one that compare it with the other, opening them), and both models' bands side by side. An unknown id shows a notice; no other model is put in its place.
- **People** (`#/people`, `#/people/<name>`, with `?job=<id>`) holds the practitioners' named records, for signed-in, granted accounts only. `#/people` shows who has reported on what and the trusted-people list; a person page shows their records, method advice and articles. `#/expert-articles` opens People: the article catalog moved onto person pages. See [People and the Named band](#people-and-the-named-band).
- **Search** (`#/search/<words>`, with `?job=<id>`) finds records by their words within the filter bar: it states the words searched and the rule (at least half of them, records with all of them first), and lists the results by band, then by job, each opening its record in the drawer with its source link; a measured result links to its Benchmark page. Granted accounts also get use records and method advice, marked "job by review"; anonymous visitors see the sign-in line there. If the index cannot be read, one line says search is unavailable. See [Search](search.md).
- **Benchmark** (`#/benchmark/<id>`) lists every result for one benchmark: the published results of the snapshot (and, for an approved account, the restricted ones), every LMArena leaderboard and every Epoch run. It is reached from every benchmark name: Brief's "Ordered by" note and table headers, the Measured band, the evidence drawer, Switch's rows, and the Data page's coverage and measures tables. See [Benchmark pages](#benchmark-pages).
- **App guide** (`#/apps`) lists which selection to make in ChatGPT and Claude on their highest-usage plans for eight tasks. Coding agents are a separate mode so API model names, Codex configurations and ordinary chat modes are not conflated. Rows open alternatives, tradeoffs, supporting evidence and sources. Model names link to their model pages, with the model's Hacker News comment count. Each task links to the brief of its job. See [App guide](#app-guide).
- **Data** (`#/data`) lists every source with its class, record count, dates and attribution line; the limits; job coverage in the build and within the filters; what each benchmark measures; how records get a job; the Hacker News collection status and classifier check (with the scan controls in development only); the source documents; licences and attribution; and the download of public data. See [Data page](#data-page).

The navigation is Brief, Models, Switch, People, Search, App guide and Data, with Account (or Sign in) beside it.

Model names link to the model page everywhere, benchmark names link to the benchmark page, and comment counts open their comments.

### Removed pages and old links

The Board, Discussion, Papers and Expert articles pages were removed: Brief, the Model page and its Crowd band replace the Board and Discussion, person pages hold the articles, and arXiv papers left the app (on 23 November 2026 only 47 of 408 paper results ranked a current exact model). Every old address still lands somewhere, as `src/lib/route.ts` maps it and `tests/route.test.ts` checks for each form:

| Old address                                                          | Opens                                                                                              |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `#/`, `#/board`, `#/redesign/board`, `#/redesign/`, any unknown hash | Brief's job chooser (`#/`)                                                                         |
| `#/model/model:<id>` (also `%3A`)                                    | `#/model/<id>`                                                                                     |
| `#/model/family:<name>`                                              | `#/model/line/<name>`                                                                              |
| `#/discussion/<key>`                                                 | the same model or line page with the thread reader open; `#/discussion` alone opens the model list |
| `#/papers`, `#/papers/<key>?area=<area>`                             | `#/data/papers`: the Data page at the line saying why papers were removed                          |
| `#/expert-articles`                                                  | `#/people`                                                                                         |
| `#/benchmark/<id>`, `#/apps`, `#/data`, `#/account`                  | unchanged                                                                                          |

Any of these behind `#/redesign/` lands the same way.

## Brief's rules

The rules are in `src/lib/brief.ts` and their tests in `tests/brief.test.ts`.

- Only a measured result orders models while one exists. The job's own benchmark with the most models in the filters sets the order; on a tie, the first listed in the job file.
- A general index (the Epoch Capabilities Index) never sets the order; it is shown on the model page only.
- A job measured per surface is ordered by the benchmarks of the surface chosen on the brief: Write or change code by Terminal-Bench for coding agents (the default) and by Text Arena coding for chat.
- When the best benchmark covers fewer than three models, it still sets the order, and the note says how many models it covers.
- A job without a benchmark has no measure, a sub-job included: the note says "No measure", and the order comes from reported evidence (below) where there is enough.
- A sub-job whose own benchmarks cover fewer than three models in the filters is ordered by its parent's benchmark, for the surface chosen, when that covers three. Its own benchmark stays in the table and in the Measured band, and the note names both. When the parent's covers fewer than three as well, the sub-job's own benchmark orders and the note says how many models it covers.
- With no benchmark result in the filters, Hacker News stated preferences set the order when three models have five or more; otherwise positive share, which needs 10 clearly positive or critical labels. The note says the order comes from reported evidence and is not a measurement.
- Models whose published interval overlaps the highest result come first and are marked. Inside that group the order is each model's share of stated preferences on the job over all dates, so the period filter never changes an order a benchmark sets. A switch orders the group by cost instead.
- Lower cost is the cheapest model at no more than half the first choice's cost and at 85% or more of the highest result. When an arena rating sets the order, its interval must overlap the highest instead.
- Arena ratings and percentages never share a column: the table has one column per benchmark.

Every count, rank and band opens a drawer listing the records behind it (`src/components/EvidenceDrawer.tsx`). Measured records show their configuration, interval, cost, job and a source link. Hacker News counts open the comments through the existing comment stream, limited to the item ids `core.json` lists for the job.

For a signed-in, granted account, and on the local dev server, the restricted payload's results join Measured. Which job a restricted benchmark measures comes from its category in the payload, through the job file's `benchmark-category` table. Those benchmarks are considered after the listed ones.

## Model and Switch rules

The Model page's rules are in `src/lib/model-page.ts`, Switch's in `src/lib/switch.ts`, and their tests in `tests/model-switch.test.ts`. Both read the same `core.json` and the same filter bar as Brief, and their bands are Brief's (`src/components/Bands.tsx`), so a count for a model and job is the same on all three.

- A row of evidence by job counts what the bands count for that job: measured records through the same job and period rules, and Hacker News labels for the exact model, a parent job including its sub-jobs.
- Tagged records: for each tag rule in the job file (the drawing test), the Hacker News labels and, for granted accounts, the use records it matched for the model or line within the filters, each count opening its records. A tag never gives a job.
- Labels that name only a product line stay on the line's page and appear in a model's Crowd band as a separate line ("N labels name only the line …"). Stated preferences against a line are listed as against the line.
- Switch compares the two models on one benchmark at a time, each with its best published result, as Brief shows it. Percentages, arena ratings and index points are never compared with each other, and nothing is summed across benchmarks. Where both intervals are published and overlap, the row says "Intervals overlap: no measured difference"; otherwise it gives the difference in the benchmark's own unit and says whether the intervals are apart or missing.
- Switch lists the job's own benchmarks on every surface, then the parent's for a sub-job, then any benchmark whose records carry the job; for all jobs, every benchmark.
- Stated preferences between the two need five before a share is given; below that the page shows the counts and says so.

## Benchmark pages

The page data for imported leaderboards and runs is in `src/lib/benchmark-page.ts` and its tests in `tests/benchmark-page.test.ts`.

- At the top, every benchmark with a page, by source: published results, then LMArena and Epoch AI runs, each folded until it holds the page shown.
- A page states what the benchmark measures, its scale and unit, the source and its dates (an arena's publication date, the first and last run date of an Epoch run), the method, the attribution line with its licence and the changes made, and a link to the source.
- Every result is a row: rank, model, configuration as the source lists it, score, interval, votes or observations (and sessions for the agent arena), cost where the source reports it, run date for a run, and a link to the row's source. "All configurations" and "Best per model" switch the rows; rows that are not a model's best are dimmed.
- Arena ratings are preference votes, not a pass rate. The page says so, gives the date the rating is relative to, shows the number without a percent sign and draws no bar. An Epoch run's shares are percentages with a bar.
- Only results for models in the model list are records. The page says how many of the source's rows that covers ("42 of the source's 162 rows …") and that the others are not shown.
- An arena's rank is the source's, among all its rows; a run's rank is among the rows shown, equal scores sharing a rank. The model filter hides rows, never renumbers them.
- An id that no benchmark has shows a notice. Restricted benchmarks use the published-results page, for approved accounts only, as before.

## App guide

- **Tasks and jobs.** The job file's `guide` table lists every App guide task once, with the job whose brief it links to, or with no job and the reason. A job's `guideTask` names the task whose selection Brief's cards show. The records build stops when the two disagree: a task linked to a job whose guide task is another, a task with no job that a job names, a guide task missing from the table or a job that does not exist. "Parallel work" describes a way of running, not a job, so it links to no brief and no job names it. Jobs without a guide task show no selection on Brief.
- **Method advice.** In the Coding agents mode, a signed-in, granted account sees practitioners' method advice from `/api/named/advice` below the tasks, grouped by the job the review applied it to: jobs whose guide task has coding-agent choices or no guide task, in the job file's order, then advice for any job. Each group shows its count, which opens the whole group in the evidence drawer, and its first two cards, trusted people first; a count above the groups opens all of them. A card shows the person, date, the summary marked as written by the review, the quote and the source link. The advice never counts toward a model or a job.
- **Hand-checked findings.** The 13 findings in `research/practitioner-findings.json` stay under their tasks in the Coding agents mode for everyone; for a granted account the heading marks them as hand-checked. An anonymous visitor sees them and one line saying more practitioners' advice needs sign-in, and the page requests nothing for it.
- **Comment counts** come from `core.json`, so the App guide loads no comment part.

## People and the Named band

The rules are in `src/lib/named.ts`, loading in `src/lib/named-client.ts`, and their tests in `tests/named.test.ts`.

**What an anonymous visitor sees.** No person's name, no named record and no count of them. Every Named position (the band on Brief cards, the Model page, line pages and both Switch columns, the named comparisons on Switch) shows one line, "Practitioner records need sign-in", with a sign-in link, and People and person pages show the same line. Named is disabled in Sources and the Basis filter is absent. The app requests nothing for them: it asks for named records only when the session's readable sign-in cookie is present, as it does for the restricted benchmarks.

**Where the records come from.** `/api/named` serves the people, the review's notes and the use records; `/api/named/advice` serves method advice and is requested only by a person page. Both use the same session and grant check as `/api/restricted`, so a request without a session, or after the grant is revoked, gets `401`. The app validates both with Zod. Each is requested once per page load. The local dev server serves the same two parts from `build/records/named-private.json` to loopback requests.

**Rules.**

- Order in every Named band and record list: the viewer's trusted people first, in their order; then a first-hand or measured basis before second-hand and vendor; then newest first.
- People flagged secondary in the people file are labelled "secondary". A record of theirs that the review labelled measured is shown as a reported figure and filtered as second-hand. People flagged advice-only appear for method advice only.
- A record that names only a product line stays on the line's page and appears in a model's band as a separate count ("N use records name only the line …"). A version outside the model list keeps its own key and appears on People and person pages, never under a model.
- The job was assigned by the review and is marked "by review" wherever it is shown or filters. It only filters: Named counts never change Brief's order, the overlap group or any ranking, and the job chooser shows none.
- Method advice names no model. It appears on person pages only and never counts toward a model or a job.
- Every count opens its records in the evidence drawer. A card shows the person, the date, the model as written and whether it is exact (in the model list, an exact version outside it, or a line only), the outcome, the review's summary (marked as written by the review), the verbatim quote, the task, tool, effort and conditions, a comparison where stated, the basis, the job by review and the source link.

**People** (`#/people`) shows a matrix of people by target: use-record counts per person for the models, product lines and versions named most (or, switched, the tools), each cell with an outcome strip and opening its records, a total per person, and the source class. Model columns follow the model filter and Current models only; lines, versions and tools are always columns. The line under it says a count shows where someone has written, not how often they use a model, and the share the person with the most records supplies.

**Trusted people** are the viewer's own list, kept in this browser under `model-picker:trusted-people` and read back through a Zod schema. Until the viewer changes it, it holds the people the people file flags as the default. A star on every card and row adds or removes a person; the People page orders the list. When storage is unavailable the list still works until the page is reloaded.

**A person page** (`#/people/<name>`) shows their use and advice counts and channels; what their records name, by basis and by job (by review), each count opening its records; a timeline of use records per month for the targets they name most; records naming a model in the list, comparisons, and failed or abandoned records, four cards each with a link to all; method advice; and their articles. An article from the catalog (`/api/expert-articles`) belongs to a person when the article's site is one that only that person's records link to; an article on a site shared by several people is left out.

## Comment threads

The thread reader under a model's or line's Crowd band shows each comment where it came from. The matching comments are grouped under their Hacker News story, and each story is one row: title, date posted, number of matching comments, sentiment split, positive share and date of the latest matching comment. The rows work as an index of what is being discussed. They sort by size, latest comment, or positive share from either end, and a text box finds stories by title. Positive share needs 10 clearly positive or critical labels, as in the ranking.

Opening a row shows that story's matching comments nested by reply, oldest first. A comment that replies to something not in the collection shows that parent above it, and the rest of the path up to the story opens on request. Replies that are not in the collection open below a comment. A thread starts with about six comments and grows by twenty at a time. The list has three densities, and the choice is kept in `localStorage`. "Claims" is the default when the analysis has claims. It opens five threads per page and shows each comment as the classifier's one-sentence claim followed by the themes of its labels, about twelve comments a thread to start, without loading any comment text. "Show comment" under a claim loads that comment's own words; its parent and its other replies are then offered as in the full view. A comment that has no claim is shown as its text. "With comments" opens the threads with the text of every comment. "Titles only" folds every thread, 25 per page, and a thread opened from there shows claims.

The story and parent of a comment come from the comment index (`story`, `parent`, and the `stories` list with titles). Comments whose story could not be recorded form one last row and are listed without it. Comment text, parents and replies are read from the public Hacker News API on demand, one item per request, and kept in memory for the page only. The view is `src/components/comment-views/Threads.tsx`, the thread context it shares is in `shared.tsx` beside it, and grouping, sorting, nesting and trimming are in `src/lib/hn-threads.ts`.

Five prototypes were compared on 17 and 18 November 2026: a flat list with context (Trail), conversations (Exchange), grouping by thread, a list with a reading pane (Reader) and a stories table. Grouping by thread and the stories table were combined into this view and the others removed. The evidence drawer still lists comments as the earlier flat list.

## Themes, claims and preferences

The thread pipeline's review records up to three themes for each label, and a task, a one-sentence claim and any stated preferences for each comment (see [pipeline instructions](hn-pipeline.md)).

- **Themes**, in the Crowd band on a model or line page, list the themes of that target's labels in the job and period with their label count and sentiment split. A theme belongs to one label, so a comment counts toward the themes of each target it names. A count opens the comments with that theme on the target's label, with their claims.
- **Stated preferences**, in the same band, count for each other model or line the comments that say this one is better and those that say the other is; each count opens its comments.

The weekly sentiment chart and the sentiment-by-task table of the earlier model page were removed: evidence by job replaces them.

## Filter bar

One bar under the header replaces the header model filter.

- **Job** opens `#/brief/<job>`; on Model, Switch and People it sets `?job=<id>` on the same page. The job lives in the address. For named records it is the job the people review assigned.
- **Models** is the providers-and-models popover. A selection has two levels that combine: providers, labelled with the name people use beside the company ("ChatGPT · OpenAI"), and individual models. A provider covers all of its models, including ones added to the snapshot later; individual models are explicit.
- On Brief, Model, Switch, People, Search and Data: **Period** (all dates, or the last 24, 12, 6 or 3 months, counted back from the last day of the Hacker News collection; Hacker News counts are monthly, so for them a period starts on the first of its month, and the bar says so), **Sources** (Measured, Named and Crowd; without the named records Named is disabled and marked "sign-in", and one of the other two stays on), **Basis** (first-hand, measured, second-hand, vendor; shown only with the named records while Named is on, and applied to use records only), **Setting** (any, local, hosted or not stated), **Run** (any, unattended, parallel, interactive or not stated), **Surface** (any, coding agent, chat app, API, local runner, not stated; shown only with the named records while Named is on) and **Current models only**. Setting and run filter Hacker News labels and practitioner records, surface practitioner records only; none of them filters measured results or changes an order, and a line under the bar says so while one is set. They are set by rule and are blank where nothing states them (see [Data](data.md#shared-records-and-the-job-list)).
- A Reset link appears when anything differs from the defaults.

Everything except the job is kept in `localStorage` under the existing key and read back through a Zod schema, with names the snapshot no longer has dropped. Older stored selections with only providers and models still read. When storage is unavailable the bar still works until the page is reloaded. The logic is in `src/lib/model-filter.ts` and works the same in the published build.

The model selection applies to each view as follows.

- **Brief**: the pool of models, the chooser counts and the table follow the selection. A band about one model shows that model's records.
- **Models**: the list shows selected models. A model or line page shows its own records whatever the selection; "Compare with" offers selected models, and the thread reader leaves labels outside the selection off its comments.
- **Switch**: the two pickers offer selected models and always keep the two chosen.
- **Benchmark**: only rows of selected models, and reports in the category only when they cover one.
- **App guide**: filtered per app. An app is shown when its provider is selected or one of that provider's models is. Recommendations inside an app are not trimmed by model, because they are written per app.
- **People**: model columns of the matrix follow the selection; lines, versions and tools stay.
- **Data**: the whole-build counts are not filtered; the "in filters" columns of job coverage apply the selection and the rest of the bar as Search does.

Ranks are always overall ranks across all published results and are never renumbered inside a selection. Ranked tables say so in one line while a filter is active; the Brief table says so while a filter narrows it, and Current models only counts as narrowing.

For HN labels, a provider covers its models' labels and its family-level labels, such as "Claude" or "Codex". A family belongs to a provider when its name shares its words with one of the provider's models, the company name or the common name, or is on a short list of product lines in `src/lib/model-filter.ts`. An individual model covers only its own label, not its family's. A mixed selection is the union. Labels outside the selection are removed from each comment before anything is aggregated, and a comment with no label left is not listed. A stated preference is kept only when both of its sides are in the selection. A claim is one sentence about the whole comment and is shown unchanged, so it can name a model outside the selection.

A direct link to a model or family outside the selection still opens. A notice above the page offers to add it to the filter or to clear the filter, and the page treats that one target as selected.

Not filtered: the model list inside a report card and the dataset counts in the header.

## Shared data

`src/lib/site-data.ts` computes each model's best result per benchmark with its rank in the field; equal scores share a rank. The benchmark page ranks all configurations and dims rows that are not a model's best.

Positive share is positive ÷ (positive + critical) and is hidden below a stated minimum. Family and version names are related by a name heuristic until models carry explicit lineage.

Brief, Model and Switch read `core.json` from `npm run records:build` through a Zod schema (`src/lib/core-schema.ts`). Its `crowd` block holds the Hacker News label counts per target, job and month, the same counts per theme of the label, the item ids of each job's comments, the same three again for each setting and run other than the default (so the Setting and Run filters subtract and add tables rather than read comments), the comments each tag rule matched and the comments that need reading, so these views render every count without the comment index. The index (in the published build, every comment part) is requested only when a drawer lists comments or the thread reader opens. `scripts/export-records-site.py` stops the build when `core.json` and the exported comment parts describe different collections (comment count or dates). The dev server serves `build/records/core.json` at `/core.json`, and `npm run build:pages` runs the records build and copies the file into `dist/` with `scripts/export-records-site.py`. `named-private.json` is never copied into `dist/` or loaded from a static file: the Pages Function serves it to granted accounts (see [People and the Named band](#people-and-the-named-band)), and `npm run check:pages` fails on any named record, that file, or the name of anyone in the people file in `dist/` outside the Hacker News comment files.

## Data page

The Data page (`src/components/DataPage.tsx`, `src/components/DataSources.tsx`, counts in `src/lib/data-page.ts`) reads `core.json`, so its counts are the records build's own; every count opens its records in the drawer.

- **Sources in the records**: the snapshot's benchmark results, Epoch AI runs, LMArena ratings and published reports (Measured), the restricted benchmarks for a granted account, the people review's use records and method advice (Named), Hacker News comments (Crowd), the 13 hand-checked findings in the App guide, and OpenRouter usage (which orders nothing), each with its dates and attribution line. For anonymous visitors the Named row says practitioner records need sign-in and shows no count.
- **Limits**: the thin-evidence minimums, arena ratings as preference votes, usage ordering nothing, the job list while it is a draft, and practitioner records needing sign-in with jobs assigned by review. Granted accounts also see the limits of the use records: the review's job agreement with the reference set, the largest single person's share (a count that opens the records; the page names nobody), records naming only a product line, a version outside the model list or no model, the passages left unresolved (counts only: they are not records), and the secondary sources' records labelled measured.
- **Job coverage**: per job, by each record's own job, the whole build's counts per source (and, for granted accounts, use records) beside the counts within the filter bar, filtered by the rule Search uses. Records that need reading until the next review have a row of their own, with one row per earlier job, apart from No job. Crowd counts within the filters need the comment index, which loads only when asked.
- **What each benchmark measures**, with its source, dates and results; **how records get a job**: the crosswalk tables with each label's fit, the earlier jobs and what replaced them, the setting, run and surface rules, and the keyword and tag rules from `research/jobs.json`, read through a schema in `src/lib/job-rules.ts`.
- The **Hacker News collection** status and classifier check as before, with the scan controls only on the development server; the **source documents** list; **licences and attribution**, each entry with the day it was checked (`checkedAt` in `src/lib/attribution.ts`); and the **download**.

The download (`src/lib/download.ts`) holds the public snapshot, the measured records with their jobs, the benchmark definitions, the job list and the attribution entries. It holds no practitioner record or quote, no restricted result (the snapshot is copied before they are added) and no OpenRouter usage, whose terms do not allow re-serving it as data. `tests/data-page.test.ts` checks it.

`#/data/papers` opens the page at the line saying why arXiv papers were removed, where old Papers links land.

## Search

Search reads a static index under `/search/` that the records build writes and the Pages build copies into `dist/` (see [Search](search.md)). A search fetches only the index files for the words searched and the records of the results shown, and no view requests them before a search. Use records and method advice stay out of it: for a granted account the view ranks the records it already holds with the same module. The local command `npm run search` ranks a private SQLite index the same way.

The approved plan put the index in a D1 database behind a Pages Function. Measured on 24 November 2026 with a local D1, loading the index wrote 93,000 to 181,000 rows, against the Free plan's 100,000 a day, and D1 counted every record a word matched as a row read: 44,681 for "claude", 139,000 to 163,000 for "claude code", against 5 million a day for the whole account, the sign-in database included. Static files have no such quota on Pages, so the index is static, and anonymous visitors make no Function request on any view, Search included. `src/lib/search-static.ts` is the only part that reads the files; a server endpoint could replace it without changing the ranking or the view.

## Density and appearance

Plato Explorer is the visual reference: cool grey canvas, white panels, dark text and restrained slate accents. The header is 46px and base text is 13px. Sentiment uses blue for positive, lavender for mixed, rust for critical and grey for neutral and unclear; there is no green. Copy is limited to functional labels and stated limitations.

At phone width the header stops being sticky, side rails move above the content, the App guide table becomes stacked rows, and wide tables scroll inside their own box so the page never scrolls sideways.

## Evidence and limits

HN labels are automatic. A reviewed sample of 300 recent comments found many passing mentions and some wrong targets or polarity, so counts are a way to find comments to read, not a survey. Claims, themes, tasks and stated preferences are written by the same classifier in the same pass, and none has been checked by a person. A claim summarises the whole comment, so one listed under a model can be mostly about another model. The reviewed theme sample of six models is no longer shown; its research file remains.

App guide recommendations are editorial starting points with source links. Benchmark evidence there stays behind a disclosure with the exact tested configuration and limitations.

## Local processing

The app polls a loopback controller, validates responses with Zod, and never supplies arbitrary commands or filesystem paths to the controller. The classifier runs locally by default; from a terminal the review can instead be sent to the Anthropic API, which sends the scrubbed text off this machine. Data and model weights are excluded from Git. Account fields and raw comment text are not retained on disk; the pipeline stores each comment's story and parent IDs and scrubbed story titles, and the reworked pipeline also stores one-sentence claims written by the reviewing model. Public comment text is loaded on demand for display, with a bounded memory cache. The pipeline reads each comment with its story title and the text it replies to. The analysis shown was reviewed that way by Claude Haiku 5.5 through the Anthropic API; the Data page shows its quality check and limitations. See [pipeline instructions](hn-pipeline.md).

## Published app

The public Pages build shows a dated HN snapshot instead of live processing controls. It reads the same comment index shape from an exported file and loads public comment text on demand directly from the HN API. Coverage and classifier limitations remain visible on the Data page. See [deployment](deployment.md).

## Replaced views

The combined site replaces three earlier views: an editorial task table as the home page, an HN dashboard with per-model count tables and a paginated reader, and a benchmark explorer with charts, a comparison picker and usage-cost estimates. The earlier 49-comment reviewed HN sample is no longer shown; its research files remain.

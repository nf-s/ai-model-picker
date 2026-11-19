# Design and implementation

## Purpose

The site answers which model to use by putting two kinds of evidence side by side: published benchmark results and what people on Hacker News report. Every view joins the two. A third, thinner kind sits beside them: which tracked model the abstract of an arXiv evaluation paper ranks first or behind, extracted automatically. There is no synthetic aggregate score; benchmarks keep their own scales and HN labels keep their stated limits.

## Views

- **Board** (`#/`) starts from a task. One table ranks models on that task's benchmarks beside HN comment volume, sentiment, four-week change and sentiment on the matching topic. Each task table also counts the evaluation papers whose abstract reports the model as best, or as behind the paper's best model, in the area matching the task; `General` counts every area. `All` shows all eight benchmarks at once and leaves the paper column out. Leader panels summarise each benchmark and the most-discussed models.
- **Models** (`#/model/<key>`) starts from a model or family. It shows rank on every benchmark, API price, app selections, published reports that cover the model, the evaluation papers that name it with the standing each abstract reports, weekly sentiment, what people say, stated preferences, sentiment by task, and a filterable comment stream. A family page lists its versions. See [Themes, claims and preferences](#themes-claims-and-preferences).
- **Discussion** (`#/discussion/<key>`) starts from the comments. Sentiment, theme, task, label confidence and period filters slice the whole collection; a ranking shows how each model or family fares inside the slice, and the matching comments are listed under their stories (see Comment threads).
- **Papers** (`#/papers/<key>`) lists arXiv papers whose title or abstract names a tracked model or family, with a per-target summary and filters by target and title words. Kind and topic filters appear once abstracts have local labels. An evaluation paper with a recorded result shows the area and task tested, marks the named models its abstract reports as best or as behind the best, and shows the stated finding in place of the general takeaway; an Area filter appears once results exist. `?area=<area>` after the address opens the evaluations in one area, which is how the Board links to them.
- **Benchmark** (`#/benchmark/<id>`) lists every published result for one benchmark, including alternate configurations, with the source's method, cost and time definitions, uncertainty where published, and reports in the same category. It is reached from the Board's column headers and leader panels and from a model's benchmark tiles.
- **App guide** (`#/apps`) lists which selection to make in ChatGPT and Claude on their highest-usage plans for eight tasks. Coding agents are a separate mode so API model names, Codex configurations and ordinary chat modes are not conflated. Rows open alternatives, tradeoffs, supporting evidence and sources. Model names link to their model pages.
- **Data** (`#/data`) holds the HN collection status and its start, pause and resume controls, the classifier quality check and limitations, every source with coverage and access notes, and the snapshot download.

Model names link to the model page everywhere, benchmark names link to the benchmark page, and comment counts link to Discussion. Hashes from the prototype period (`#/redesign/...`) map to the same views.

## Comment threads

The comment section of Discussion shows each comment where it came from. The matching comments are grouped under their Hacker News story, and each story is one row: title, date posted, number of matching comments, sentiment split, positive share and date of the latest matching comment. The rows work as an index of what is being discussed. They sort by size, latest comment, or positive share from either end, and a text box finds stories by title. Positive share needs 10 clearly positive or critical labels, as in the ranking.

Opening a row shows that story's matching comments nested by reply, oldest first. A comment that replies to something not in the collection shows that parent above it, and the rest of the path up to the story opens on request. Replies that are not in the collection open below a comment. A thread starts with about six comments and grows by twenty at a time. The list has three densities, and the choice is kept in `localStorage`. "Claims" is the default when the analysis has claims. It opens five threads per page and shows each comment as the classifier's one-sentence claim followed by the themes of its labels, about twelve comments a thread to start, without loading any comment text. "Show comment" under a claim loads that comment's own words; its parent and its other replies are then offered as in the full view. A comment that has no claim is shown as its text. "With comments" opens the threads with the text of every comment. "Titles only" folds every thread, 25 per page, and a thread opened from there shows claims.

The story and parent of a comment come from the comment index (`story`, `parent`, and the `stories` list with titles). Comments whose story could not be recorded form one last row and are listed without it. Comment text, parents and replies are read from the public Hacker News API on demand, one item per request, and kept in memory for the page only. The view is `src/components/comment-views/Threads.tsx`, the thread context it shares is in `shared.tsx` beside it, and grouping, sorting, nesting and trimming are in `src/lib/hn-threads.ts`.

Five prototypes were compared on 17 and 18 November 2026: a flat list with context (Trail), conversations (Exchange), grouping by thread, a list with a reading pane (Reader) and a stories table. Grouping by thread and the stories table were combined into this view and the others removed. The comment stream on a model's page is still the earlier flat list.

## Themes, claims and preferences

The thread pipeline's review records up to three themes for each label, and a task, a one-sentence claim and any stated preferences for each comment (see [pipeline instructions](hn-pipeline.md)). The comment index says whether it carries them; the views below replace older ones when it does.

- **Discussion** has a Theme filter and a Task filter in place of the topic tag filter. With a model selected, the theme has to be on that model's label; the task belongs to the comment. Counts beside each option are comments in the current slice, and options with none are hidden.
- **What people say**, on a model or family page, lists the themes of that target's labels with comment count, sentiment split and positive share. A theme opens into the claims of its comments, newest first, eight at a time, each with a dot for the sentiment toward the page's target and a link to the comment on HN. A theme can also filter the comment stream below.
- **Stated preferences** replaces the co-mention table. For each other model it counts the comments that label both, the comments that say this one is better and the comments that say the other is. A preference between a name and its own family or version line is left out, as for co-mentions.
- **By task** replaces the topic tag table and filters the comment stream. "Other" is the task of comments about no particular task and is listed last.

With an analysis made before the thread pipeline, which the published site still shows, the same places show the topic tag filter, the reviewed theme sample for six models, the co-mention table ("Mentioned together") and the topic tag table.

The tallies are built in `src/lib/hn-insights.ts` from the comment index, in the browser. Nothing is requested per theme or per claim.

## Model filter

One control in the header limits every view to chosen models. A selection has two levels that combine: providers, labelled with the name people use beside the company ("ChatGPT · OpenAI"), and individual models. A provider covers all of its models, including ones added to the snapshot later; individual models are explicit. The button names the selection ("All models", or the chosen names) and a clear button beside it removes the filter in one click.

The selection is kept in `localStorage` and read back through a Zod schema, with names the snapshot no longer has dropped. When storage is unavailable the filter still works and lasts until the page is reloaded. It is not part of the URL. The logic is in `src/lib/model-filter.ts` and works the same in the published build.

- **Board**: rows and leader panels list only selected models.
- **Models**: the rail lists selected models, and the families of selected providers. Co-mentions and the labels on comments leave out everything else.
- **Discussion**: every count, the period chart, the ranking, the name search and the comment threads use only labels in the selection.
- **Papers**: only papers that name a selected model or family, and only those names in the options, the per-model counts and the chips on a paper.
- **Benchmark**: only rows of selected models, and reports in the category only when they cover one.
- **App guide**: filtered per app. An app is shown when its provider is selected or one of that provider's models is. Recommendations inside an app are not trimmed by model, because they are written per app.
- **Data**: not filtered.

Ranks are always overall ranks across all published results and are never renumbered inside a selection. Ranked tables say so in one line while a filter is active.

For HN labels, a provider covers its models' labels and its family-level labels, such as "Claude" or "Codex". A family belongs to a provider when its name shares its words with one of the provider's models, the company name or the common name, or is on a short list of product lines in `src/lib/model-filter.ts`. An individual model covers only its own label, not its family's. A mixed selection is the union. Labels outside the selection are removed from each comment before anything is aggregated, so co-mention counts follow the same rule, and a comment with no label left is not listed. A stated preference is kept only when both of its sides are in the selection. A claim is one sentence about the whole comment and is shown unchanged, so it can name a model outside the selection.

A direct link to a model or family outside the selection still opens. A notice above the page offers to add it to the filter or to clear the filter, and the page treats that one target as selected.

Not filtered: the model list inside a report card, the "compared with" names in the reviewed theme sample, the field strip on a model's benchmark tiles, and the dataset counts in the header.

## Shared data

`src/lib/site-data.ts` computes each model's best result per benchmark with its rank in the field; equal scores share a rank. The benchmark page ranks all configurations and dims rows that are not a model's best.

The browser aggregates the full HN comment index: weekly sentiment in Monday-UTC buckets, per-topic sentiment and co-mentions. Positive share is positive ÷ (positive + critical) and is hidden below a stated minimum. The four-week change compares the latest four weeks with the four before and needs a minimum in both. Co-mention "ahead/behind" counts come from the automatic labels in one comment and inherit their errors. Family and version names are related by a name heuristic until models carry explicit lineage.

## Density and appearance

Plato Explorer is the visual reference: cool grey canvas, white panels, dark text and restrained slate accents. The header is 46px and base text is 13px. Sentiment uses blue for positive, lavender for mixed, rust for critical and grey for neutral and unclear; there is no green. Copy is limited to functional labels and stated limitations.

At phone width the header stops being sticky, side rails move above the content, the App guide table becomes stacked rows, and wide tables scroll inside their own box so the page never scrolls sideways.

## Evidence and limits

HN labels are automatic. A reviewed sample of 300 recent comments found many passing mentions and some wrong targets or polarity, so counts are a way to find comments to read, not a survey. Claims, themes, tasks and stated preferences are written by the same classifier in the same pass, and none has been checked by a person. A claim summarises the whole comment, so one listed under a model can be mostly about another model. The reviewed theme sample covers six models, is labelled as a sample where it appears, and is shown only with an analysis that has no themes.

App guide recommendations are editorial starting points with source links. Benchmark evidence there stays behind a disclosure with the exact tested configuration and limitations.

## Local processing

The app polls a loopback controller, validates responses with Zod, and never supplies arbitrary commands or filesystem paths to the controller. The classifier runs locally by default; from a terminal the review can instead be sent to the Anthropic API, which sends the scrubbed text off this machine. Data and model weights are excluded from Git. Account fields and raw comment text are not retained on disk; the pipeline stores each comment's story and parent IDs and scrubbed story titles, and the reworked pipeline also stores one-sentence claims written by the reviewing model. Public comment text is loaded on demand for display, with a bounded memory cache. The pipeline reads each comment with its story title and the text it replies to. The analysis shown was reviewed that way by Claude Haiku 5.5 through the Anthropic API; the Data page shows its quality check and limitations. See [pipeline instructions](hn-pipeline.md).

## Published app

The public Pages build shows a dated HN snapshot instead of live processing controls. It reads the same comment index shape from an exported file and loads public comment text on demand directly from the HN API. Coverage and classifier limitations remain visible on the Data page. See [deployment](deployment.md).

## Replaced views

The combined site replaces three earlier views: an editorial task table as the home page, an HN dashboard with per-model count tables and a paginated reader, and a benchmark explorer with charts, a comparison picker and usage-cost estimates. The earlier 49-comment reviewed HN sample is no longer shown; its research files remain.

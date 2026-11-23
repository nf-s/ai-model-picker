# Goal

The model picker exists to answer one question: **which model should I use for this job?**

A job is a real piece of work with its limits: the kind of task, the app or coding agent it runs in, the effort setting, the budget and how much checking the result will get. An answer names an exact model and setting, a second choice, a cheaper one where the evidence supports it, and the reasons for each.

## Who asks

- A person choosing a model and setting in ChatGPT, Claude or a coding agent.
- A person deciding which model to give each kind of delegated work, such as search, exact edits, implementation, design and diagnosis.
- An agent choosing a model for a subtask. On the owner's machine, `npm run search -- <words> --job <id>` gives it the matching records as JSON: counts per band and job, and the best records of each band with their model, tool, effort, conditions, date, job and source link, practitioners' quotes included. The output is private, and the published site offers agents nothing beyond its pages. See [Search](search.md#for-agents).

## What counts as an answer

1. It names an exact model, tool and setting. A product line such as "Claude" or "GPT" is not an answer.
2. It can be checked. Every recommendation, rank, count and summary opens the records behind it, and each record links to its source.
3. It keeps measured and reported evidence apart. Benchmarks and controlled studies order models. Accounts from practitioners and Hacker News show where a model does well or fails in use. They support or contradict an order and never set one by volume. Reported evidence may order models only where their measured intervals overlap.
4. It includes cost: the API price and, where a benchmark reports it, the cost of a task.
5. It states its conditions. A result belongs to a model, a tool, an effort level and a date, and is not carried over to another.
6. It says when the evidence is thin, old or about a replaced model. Missing values are not estimated.

## What the project collects

- Published benchmark results and official API prices, read by hand.
- LMArena leaderboard ratings and the results of Epoch AI's own benchmark runs, imported by script.
- Published reports and controlled experiments.
- OpenRouter usage: 30-day token shares and 7-day task tags. It is shown apart and orders nothing.
- arXiv metadata, as a feed for reports reviewed by hand. Nothing from it is shown.
- Hacker News discussion that names a model.
- Dated use records and method advice from a short list of practitioners and outlets who publish their work with these models, reviewed by a model and shown only behind sign-in.
- The selections that ChatGPT, Claude and the coding agents offer, for the app guide.

The coverage and limits of each source are in [Data provenance](data.md).

## Not goals

- One universal ranking, or a single score that mixes benchmarks with discussion.
- A survey of opinion. Hacker News and the practitioners are not a representative sample.
- Rerunning benchmarks. The app links published results.
- News about releases.

## Using this statement

A new view, data source or review step is worth adding when it shortens the path from a job to a model with reasons. One that only adds records to browse does not serve the goal.

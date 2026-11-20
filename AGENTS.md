# Agent instructions

This repository is public. The app's data comes from local pipelines and from reviewed research files. [README.md](README.md) describes the layout and [docs/](docs/) the details.

To update any data or to publish the site, follow [docs/updating.md](docs/updating.md) step by step. Each step states the command, the expected result and what to do when the result differs. When a step fails in a way it does not cover, stop and report the command and its output.

## Rules

- Publish only when the owner asks for it in the current request. A request to update data is not a request to publish.
- Do not start a local model unless the owner asks. That covers `npm run hn:setup`, the scan controls on the Data page, `mlx_lm.server`, `npm run arxiv:assess` and `scripts/hn_pipeline.py run` without `--backend anthropic`. They use tens of gigabytes of memory for hours or days.
- The Hacker News update in docs/updating.md is paid and usually costs cents. After a model-list change, report the queue that `--collect-only` leaves and ask before reviewing it if it would cost more than US$1. A new full Hacker News review costs about US$7: ask before starting one.
- Never commit, print or paste anything under `.local/`, `wrangler.jsonc`, `.dev.vars*`, credentials, account identifiers or email addresses. The names of the benchmarks in `.local/restricted/` stay out of tracked files, commit messages and logs.
- Do not read credential stores such as `~/.config/anthropic/` or the keychain. Do not run commands that print credentials or account details: `ant auth print-credentials`, `ant auth status`, `wrangler whoami`. The owner signs in, in a terminal.
- Do not delete or overwrite anything under `.local/`. Restoring a copy over a checkpoint needs the owner's word.
- Commit to `main` only and push no other branch. Stage files by name; never `git add -A` or `git commit -a`.
- One pipeline command per state directory at a time. `already-running` means wait. Do not remove `pipeline.lock`.

## Checks

Run these before a commit that changes code:

```sh
npm test
npm run hn:test
npm run arxiv:test
npm run build
npm run format
npm run format:check
```

A change to documentation needs only the last two.

## Conventions

- Interface text is limited to functional labels and stated limitations, and no view uses green; see [design notes](docs/design.md#density-and-appearance).
- `scripts/hn_pipeline.py`, `scripts/evaluate_hn_classifier.py` and the `npm run hn:test` tests run with `.local/hn/venv/bin/python`. Every other Python script runs with the system `python3` and uses only the standard library.
- A document states a count or a date for the Hacker News or arXiv data only as a dated record, never as the current state. The Data page and the `status` commands show the current state.

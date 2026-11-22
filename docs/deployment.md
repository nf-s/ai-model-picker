# Cloudflare Pages

Canonical URL: https://ai-model-picker.pages.dev/

The `ai-model-picker` Pages project uses Direct Upload and the `main` production branch. It is accessible without sign-in. The deployment contains the compiled app, public benchmark/guide data and a dated, metadata-only HN snapshot and arXiv paper index. It does not expose the local controller or classifier.

Benchmarks whose source terms do not allow republishing are not in the public bundle or in Git, and the public app does not mention them. Their records, sources, guide evidence and credits live in the ignored `.local/restricted/` directory: `research.json` holds the reviewed rows and `npm run data:build` writes `payload.json`. The `/api/restricted` Pages Function bundles `payload.json` and serves it to Google accounts the administrator has granted, using the `ai-model-picker-access` D1 database; the app adds the records before it renders. The dev and preview servers serve the same file locally. Deploying therefore needs `.local/restricted/payload.json`, as it needs the HN and arXiv checkpoints. Keep a private backup of `.local/restricted/`. See [Google sign-in](../server/auth/README.md).

## Build and publish

The Pages Functions also need `.local/expert-articles/catalog.json`. The Functions build bundles this file on the server. `GET` and `HEAD /api/expert-articles` use the same session and enabled-grant check as `/api/restricted`. Direct anonymous requests to the canonical origin receive `401`. A successful response uses `Cache-Control: private, no-store` and `Vary: Cookie`. A normal loopback `npm run dev` can read the local catalog. See [Updating expert articles](updating.md#expert-articles).

The step-by-step release, with the expected output of each command, is under [Publish](updating.md#publish) in Updating the data. In short:

```sh
npm test
npm run hn:test
npm run arxiv:test
npm run format
npm run format:check
npm run build:pages
npm run check:pages
npx wrangler@4.163.0 pages deploy dist --project-name ai-model-picker --branch main
```

`check:pages` reads `dist/` and stops the release if the comment files come from different exports, a file is over 25 MiB, a claim or story title still contains a link, an email address, a handle or a phone number, the build contains an identifier that exists only in the restricted results, the catalog file or an expert article link appears in static output, or it contains a path on this computer. It prints counts only.

Run the deploy command from the repository root so Wrangler compiles `functions/`. It reads the ignored `wrangler.jsonc` (copied from `wrangler.example.jsonc`) for the `AUTH_DB` binding, `PUBLIC_URL` and `ADMIN_EMAIL`; that file is the source of truth for the project's bindings and variables. `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are Pages secrets set with `wrangler pages secret put`. Apply new files in `server/auth/migrations/` with `npx wrangler@4.163.0 d1 migrations apply ai-model-picker-access --remote` before deploying.

Authenticate the CLI through its existing login or an operator-managed environment. Do not put account identifiers or credentials in source, build output or command arguments. `wrangler whoami` prints the account's email address and `wrangler pages deployment list` an address that contains the account identifier; keep both out of commits, documents and messages. Confirm that the authenticated account contains the existing project before uploading. Upload only `dist/`, never the repository or `.local/` directory.

`build:pages` selects the published reader and exports a consistent SQLite snapshot after the frontend build. The exporter reads the current classifier and saved six-month window. `hn-snapshot.json` carries summary results, coverage counters and the number of comment files. The comment files, `hn-comments-1.json` onwards, carry the ID and valid assessments of every comment that has at least one, newest first, and load only when a view needs the comments. For a run made by the thread pipeline they also carry each comment's story ID, task, one-sentence claim, themes and preferences, and the first file carries the scrubbed titles of those stories. Matching revision identifiers prevent mixing releases. These files exclude comment bodies, account fields, local paths, classifier prompts, model weights and credentials. Generated snapshots remain in ignored build output.

Cloudflare Pages accepts at most 25 MiB for one file, so the export starts a new comment file at 12 MiB and the app reads the files together. It refuses to write more than 16. The run reviewed on 19 November 2026 exported 86,745 comments in four files, 38.5 MB in all, and was published that day. Extended the same evening, it exports 88,309 comments in four files, 39.1 MB in all, and was published again.

`build:pages` then exports `.local/arxiv/` to `arxiv-snapshot.json`, which carries titles, identifiers, dates, categories, matched targets and labels but no abstracts. The build fails without an arXiv checkpoint, as it does without an HN checkpoint. See [arXiv pipeline instructions](arxiv-pipeline.md).

The local scan can continue during export. Hosted results remain at the displayed publication time until the next build and upload. They must not be presented as a live view of the computer's progress or as a complete six-month collection while processing remains incomplete. Local start/pause controls are absent from the hosted app.

Comment text, parents and replies load directly from the public HN Firebase API when requested, inside the reader. Text is validated, stripped of author fields and rendered as escaped text. Pages Functions run only for `/auth/*` and `/api/*`; static assets are served directly. Anonymous visitors make no Function requests, because the app checks the session only when the session's readable CSRF cookie is present. The hosted app needs no inference service. Cloudflare currently charges no usage fees for static asset requests; HN requests go from the browser to its public API. See [Pages pricing](https://developers.cloudflare.com/pages/functions/pricing/), checked 16 November 2026.

## CLI compatibility

The Cloudflare connector manages and verifies the project. The available `cf` v0.15.0 has no Pages upload command (and rejects the documented `cf cli search` command). The release therefore uses the documented [Wrangler Pages Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/) command for local assets. No Wrangler project configuration or migration is needed. Recheck `cf` support before changing this exception.

## Licences

The Data page's **Licences and attribution** section credits every source with its licence, required wording and changes made (`src/lib/attribution.ts`). The Papers page carries arXiv's acknowledgement. The build writes `third-party-licenses.txt` with the licence text of each bundled npm package; font licences are in `public/fonts/`. The JSON download excludes restricted results and includes the attribution list. Recheck the terms before adding a source or changing what is published.

## Crawler exclusion

`public/robots.txt` disallows every path. `public/_headers` applies `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet` to every static response, including the JSON snapshots and deployment aliases. The HTML also includes the robots meta tag. All snapshot files, including every comment file, use `Cache-Control: no-store`.

These directives discourage compliant crawlers and indexing. They are not access control and cannot prevent determined scraping. A crawler blocked by robots.txt cannot read the noindex header; external links can still cause URL-only search listings. The app's selected access policy is public link access. See [Google's noindex guidance](https://developers.google.com/search/docs/crawling-indexing/block-indexing).

## Release verification

`npm run check:pages` covers the build before upload. After upload, read back the project's latest successful production deployment and verify the canonical URL. Check the guide, HN snapshot timestamp/counts, comment pagination, sentiment filters, parent context and nested replies without exposing source bodies in test output. Confirm the hosted app makes no localhost requests and offers no scan controls. Check a versioned asset, `robots.txt`, HTML and snapshot response headers, and browser console errors. Confirm that `/api/restricted` and `/api/expert-articles` return 401 without a session and that a granted account can view the restricted benchmarks and browse Expert articles after signing in.

NFS Home links to this canonical URL. Publish launcher changes through its existing GitHub Pages `main`/`docs` process and verify its live links page. Keep the launcher's root blank.

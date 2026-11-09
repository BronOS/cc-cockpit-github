# cc-cockpit-github

cc-cockpit plugin `bronos.github`: GitHub review requests, own PRs, issues and failed CI runs in a panel and overlay,
and an `inbox-feed` v2 provider for the Inbox plugin. Plain JavaScript, no build. `ccc guide api` / `ccc guide style`
are the plugin API and the page style rules.

## Layout

- `dist/host.js`: the plugin host entry (poll order, panel messages, stored list); `dist/lib/*`: one concern per file
  (auth via `gh auth token`, REST/GraphQL client, search, model, runs, seen marks, notifications, feed, poll, details,
  logs, overlay).
- `panels/`: the main panel (`main.*`, lane logic in `rowlogic.js`) and the item overlay (`item.*`, `itemview.js`,
  `sanitize.js`); the shared logic files are UMD so `node:test` can load them.
- `docs/item-convention.md`: ids, labels and actions every code-host source uses, **shared with the Forgejo plugin**; a
  change there is a change to both. `test/convention.test.js` keeps it in step with the code.
- `docs/plans/completed/`: the implementation plan.

## Commands

- `npm install` (dev only: linkedom), `npm test` (`node --test test/`).
- `ccc plugin link .` to try it in the app.

## Rules

- The token comes from `gh` each start and lives in memory only: never store, post, emit or log it (tests check).
- Requests go to `https://api.github.com` only; job log blobs are fetched by hand from the redirect, https, no token.
- Exec is argv only (`ctx.exec`); `ghPath` is a bare name or an absolute path.
- Writes on GitHub are only re-run failed jobs and notification read/done, each on the person's click.
- Overlay links open only if the host found them in the details (`linksOf`); HTML from GitHub goes through `sanitize.js`.
- Test data is made up (`acme/widgets`, `me`, `bob`); no work data in this public repo.

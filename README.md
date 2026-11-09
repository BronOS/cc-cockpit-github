# GitHub for cc-cockpit

A [cc-cockpit](https://github.com/BronOS/cc-cockpit) plugin (`bronos.github`) that keeps your GitHub work next to your
Claude Code sessions:

- **Review requested**: pull requests waiting for your review (yours or your team's).
- **My pull requests**: your open PRs, with what happened last (a review, a comment, CI failing, a conflict).
- **Issues**: issues assigned to you or mentioning you.
- **Failed runs**: your CI runs that failed in the last 7 days, one per workflow and branch, until a later run passes.

Each lane has unread marks. A click opens the item in an overlay:
- **PR:** the description and conversation, the checks with the end of each failed job's log, and the changed files.
- **Issue:** its body and comments.
- **Failed run:** its jobs and their log tails.

**Discuss with Claude** sends the item, its URL and what failed to a Claude session, where Claude can take it further
with `gh`.

It also feeds the [Inbox](https://github.com/BronOS/cc-cockpit-inbox) plugin: every item shows there under GitHub, with
labels your Inbox rules can use.

## Requirements

- cc-cockpit 0.16.2 or newer (on Linux, older versions keep `gh` from reaching the system keyring, and the plugin stays signed out).
- The [GitHub CLI](https://cli.github.com/), signed in: `gh auth login`. The plugin asks `gh auth token --hostname
  github.com` for your token and keeps it in memory only. Nothing is stored, no token setting exists, and signing
  out of `gh` signs the plugin out at the next refresh. github.com only (no Enterprise hosts).

## What it changes on GitHub

Only two things, and only when you ask:

- **Re-run failed jobs** of a failed run (or of the failing run of your PR's head): once per run attempt, never while
  the run is going.
- **Mark read** and **Done on GitHub** also mark the matching GitHub notification read or done, so the bell on
  github.com agrees.

It never comments, reviews, merges, closes or pushes. Do those yourself, or ask Claude.

## Settings

Per project, with a global default (Settings > Plugins > GitHub):

| Setting | Default | |
|---|---|---|
| Lanes | all on | a lane that is off is not fetched and never reaches Inbox |
| Items per lane | 10 | the rest are behind Show all |
| Mark an item read when I open it | on | |
| Leave out | none | owners (`acme`) or repositories (`acme/widgets`) |
| Check every (minutes) | 2 | 2 to 15; failed runs at most every 5 minutes |
| gh program | `gh` | a name on your login shell's PATH, or an absolute path |

## Inbox rules

Items carry these labels:
- **Kind:** `pr`, `issue`, `run`.
- **Your role:** `review-requested`, `team-review-requested`, `my-pr`, `assigned`, `mentioned`.
- **PR state:** `changes-requested`, `approved`, `ci:failed`, `ci:pending`, `conflict`, `draft`.
- **Where:** `repo:<owner>/<repo>`, `owner:<owner>`.

A good start:
- **Now:** `review-requested`; `my-pr` with `ci:failed`; `my-pr` with `changes-requested`.
- **Later:** `team-review-requested` and `mentioned`.

The full convention, shared with other code-host sources such as Forgejo, is in
[docs/item-convention.md](docs/item-convention.md).

## Privacy

- Requests go to `https://api.github.com` only, with your token.
- Job logs are fetched from GitHub's log storage through the signed address GitHub hands out, without your token.
- The last list and your read marks are kept in the app's plugin storage, never your token.

## Development

```sh
npm install   # dev only: linkedom for the sanitiser tests
npm test
ccc plugin link .
```

The plugin is plain JavaScript with no build: `dist/host.js` and `dist/lib/*` run in the plugin host, `panels/*` in
the panel and overlay pages.

## Licence

MIT

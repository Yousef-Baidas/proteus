### Security

- CI's `owned paths` step no longer trusts the PR body on a run branch (#86). A worker's PR from
  `proteus-work/<run>/<id>` is checked against `.proteus/owned/<id>` as committed on the base `proteus/<run>`,
  which the lead writes and which changes only through a merged PR with `gates` green. The step reads the base's
  copy, never the PR's, runs the base's `proteus-owned-check.js` from a detached worktree of the base, refuses any
  PR that touches `.proteus/owned/` except the lead's docs PR, and fails when the ticket has no record. Editing the
  PR body's `Owned:` line no longer widens what CI lets through.
- The worker guard refuses a push to the lead's docs branch `proteus-work/<run>/lead-docs`, whose PR may change
  the records, and the pre-commit owned check refuses a staged record whatever the worktree's list covers.

### Added

- The lead may write `.proteus/owned/<id>`. The run branch's first commit records every ticket known then; a later
  ticket is recorded through the lead-docs PR, merged with `--match-head-commit` (`stack.md`).
- `proteus-worktree.js` warns when the paths it is given differ from the branch's record.

### Deprecated

- On a run branch whose base has no `.proteus/owned/` (a run cut before this release), the step still reads the
  PR body's `Owned:` line and prints a warning, until that run's close PR merges. This fallback is removed in the
  next minor release. PRs into `main` (Quick, Direct) keep the body's line, since the human merges them.

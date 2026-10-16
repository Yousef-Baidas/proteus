### Changed

- Changelog entries now go in `changelog.d/<slug>.md`, one fragment per PR, instead of under `## [Unreleased]`
  in `CHANGELOG.md`, so open PRs no longer conflict there. `node scripts/changelog.js` prints the pending
  notes; `node scripts/changelog.js --release X.Y.Z` folds them into a new version section and deletes the
  fragments. Release-time behaviour is unchanged: the update notes still read `CHANGELOG.md`.

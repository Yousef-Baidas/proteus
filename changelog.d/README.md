One file per PR, `changelog.d/<slug>.md`, named after the branch or topic. It holds `### Added`, `### Changed`,
`### Deprecated`, `### Removed`, `### Fixed` or `### Security` sections of bullets, formatted like the entries in
`CHANGELOG.md`; never edit `CHANGELOG.md` in a PR. At release, `node scripts/changelog.js --release X.Y.Z`
folds the fragments into a new version section and deletes them; with no arguments it prints the pending notes.

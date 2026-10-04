# Changelog

Notable changes per release. A release is a signed `vX.Y.Z` tag (README, "Releases"); when tagging, move the
`Unreleased` notes under a new `## [X.Y.Z] - YYYY-MM-DD` heading. Updates print the sections between the
installed version and the new one.

## [Unreleased]

### Changed

- Updates move the Proteus checkout only to a signed release tag that `git verify-tag` accepts, by
  fast-forward, and show this changelog for the versions in between. `--update` and auto-update no longer
  follow the tip of `main`; an unsigned or untrusted tag is skipped with the reason.
- The cost report pins `ccusage@20.0.26` and `@ccusage/codex@19.0.0` instead of `@latest`.

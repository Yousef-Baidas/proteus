### Added

- The core of a `gh` stand-in for a future local mode (#310): `templates/hooks/proteus-local.js` keeps issues,
  comments, labels and milestones in `<git-common-dir>/proteus-local/`, answers `auth status`, `repo view` and
  `api user`, and evaluates `--jq` filters with no dependency. Nothing turns it on yet; outside a local-mode repo
  every `gh` call behaves as before.

### Added

- Local mode, PRs (#310): `--init` adds a bare origin whose pre-receive refuses updates to the default and run branches; the stand-in serves `gh pr create|view|list|diff|merge|checks|comment|review|edit` and commit statuses, and runs the gate commands on each new PR head.

### Changed

- `proteus-cli.js close` decides step 8's close passes: they are skipped when every milestone has a
  `milestone-passes` run-log line and origin's tip differs from the newest line's commit only by added owned records,
  lessons and ADRs. Any doubt or failure runs them. The lead logs the line once both milestone passes are green.

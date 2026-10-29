### Added

- A close retro at step 8 (#193): a helper runs `proteus-retro.js`, which groups what recurred in the run (the
  same `BACK-TO-WORKER` reason, escalations, guard-violation records of the same rule, classifier denials of the
  same command shape, gates that stayed red) and prints one JSON line per group of 2 or more. It reads files
  only: the tracker data `proteus-close-report.js --save <file>` writes, and the guard records. Each group gets
  exactly one proposal (a check or hook ticket first, then a script ticket, a `CONVENTIONS.md` line, or an
  upstream Proteus proposal), posted as one checklist comment on the close PR; the lead files or applies only
  what the human ticks. With nothing recurring, nothing is posted and the run log gets `retro: none`.

### Added

- `isolation: container` in `AGENTS.md` (#80): the lead runs each worker through `proteus-container.js run` as a
  background shell instead of the Agent tool. The autostart runs the runner's `doctor` and shows
  `isolation=container`, or `isolation=container-unready` with the failed row, in `proteus-state`. The lead guard
  refuses a run whose `--model` is missing or is not the `build` tier's (or the `judge` tier's, an escalation).
  `install.js --sandbox` adds the bin copy of `proteus-container.js` to `excludedCommands`.

### Added

- `proteus-delegate.js` hands one small job to a cheaper rung of the model ladder as a single bounded headless call:
  `--budget` is required and becomes the CLI's spend cap, tools default to read-only and never include the Agent tool,
  the call is killed after 10 minutes, nesting stops at depth 3, and `--run` ledgers each call's cost in the run's
  scratch dir. The harness adapter builds the command (`delegate`); Codex reports it unsupported.

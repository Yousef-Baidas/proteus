### Added

- Optional sub-leads (#344): a slice ticket too large for one worker can go to a lead of its own instead of being
  split by hand. `next`'s `DECIDE #<n> slice` line now offers both, `split it, or sub-lead: <command>`, and prints
  `BLOCKED #<n> sub-lead <branch> running` while one is out. `proteus-sublead.js start <n> [run] --budget <usd>`
  opens a nested run `<run>.<n>` on its own branch cut from the run branch, records its depth, and starts a headless
  Claude Code session there with the proteus skill's loop, `--max-budget-usd` and a runtime bound (`--minutes`,
  default 240). The prompt goes on stdin and nothing credential-bearing goes on the command line. It writes the
  beat the watchdog reads while the session runs. `proteus-sublead.js pr` returns the sub-run's result as one PR
  from `proteus-work/<run>/<n>` into the parent run branch, verified, owned-checked and merged like a worker's.
  Runs nest at most three deep: a run at depth 3 is refused a sub-lead, and its `DECIDE` line offers only the
  split. A sub-lead never runs in a more permissive mode than the lead: the lead guard records the lead's
  permission mode where agents cannot write, and `start` runs the sub-lead in `auto` only when the lead runs
  `auto`. Any other or unknown mode, `bypassPermissions` included, is refused (exit 1) with a pointer to split
  the slice instead.

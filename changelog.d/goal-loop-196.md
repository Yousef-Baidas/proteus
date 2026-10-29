### Added

- A goal-loop run mode (#196). A work order may carry `goal: <name> <min|max> <target>` and
  `budget: <n> rounds` (default 10, at most 50). Ticket 1 is then the scorecard, a `scripts/` program whose last
  stdout line is `SCORE <number>`; once merged it is frozen as `scorecard: <path>` in AGENTS.md, and the
  verifier rejects any diff that touches it. A schedule (`/schedule` under Claude Code, by hand elsewhere) runs
  one round at a time: `proteus-goal.js round` runs the scorecard in `.worktrees/_run` (a container check under
  `isolation: container`), reads the past rounds from the run log's `goal-round:` lines, and prints
  `NEXT <k> score <v>` or `STOP target|budget|falling|error`. It refuses unless the sandbox is on. Each `NEXT`
  opens one improvement ticket; a `STOP`, `CHANGES` or `ACCEPT` ends the loop and the schedule.

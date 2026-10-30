### Added

- `proteus-cli.js brief worker <n> [run]` and `brief verifier <pr> [run]` (#79): render the `## Worker` or
  `## Verifier` block of `references/roles.md`, read at run time, into `<scratch>/brief-<n>.md` or
  `verify-<pr>.md` (`proteus-scratch.js --path <run>`), and print `PROMPT <the spawn prompt>` carrying the
  `worker #<n>` or `PR#<pr> head=<sha12>` tokens the spawn records parse. Every slot comes from the tracker, the
  owned record, the worker branch's contract commit, the issue's `Check:` line, `## Learned` and the team's
  `Safety:` lines; the Codex, needs-research and container lines appear only when they apply. A slot with no
  source prints `DECIDE #<n> brief: no source for <slot>` and exits 1. `next`'s SPAWN lines end with
  ` brief: <that command>`, which the lead runs in its sandboxed shell; `next` never runs it.

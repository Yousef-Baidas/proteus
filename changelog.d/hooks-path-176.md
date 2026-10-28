### Fixed

- Agent files no longer hard-code `.claude/hooks/` for the helper scripts (#176). Each defines `<hooks>` once
  near the top: the dir the brief names, else the first of `.claude/hooks/`, `.codex/hooks/` and
  `teams/templates/hooks/` that holds `proteus-lib.js`. Every brief template in `roles.md` now opens with a
  `Hooks:` line naming the dir the lead resolved.

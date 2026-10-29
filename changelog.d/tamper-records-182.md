### Fixed

- Tamper records of agents that have ended no longer block `proteus-signoff.js` MERGE forever (#182).
  `proteus-shell-check.js` no longer flags `branch.<b>.remote` or `branch.<b>.merge` when `<b>` is a
  `proteus-work/` branch or one checked out in a prepared worktree, whoever's `git push -u` set them. It also
  counts a path under `.git/worktrees/<name>/` as explained once that worktree is removed or pruned. The signoff
  re-checks each record's paths under both rules rather than trusting its open flag, so a record whose paths are
  back or explained stops refusing, even with no later call by its agent. Records are now filed under the branch
  of the agent's own worktree, never the main checkout's.

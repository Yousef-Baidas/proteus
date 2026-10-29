### Security

- The hooks' git now also runs with `-c gc.auto=0` beside `maintenance.auto=false` (#235), so no git a hook
  starts runs auto gc, whose worktree prune empties what a link planted at `<git-common-dir>/worktrees/<x>`
  leads to. `proteus-scratch.js --sweep` runs `git worktree prune` only when every entry there is a real dir
  with a regular `gitdir` file; otherwise it skips the prune and prints the entry to inspect. The human's own
  git keeps its auto maintenance: `docs/install.md` Known gaps says how to turn it off per repo.

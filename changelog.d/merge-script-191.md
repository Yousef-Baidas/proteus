### Added

- `proteus-merge.js <run> --suite "<suite>"` does the mechanical part of a merge batch (#191): it merges the PRs
  whose checks and statuses are all green, `proteus/verdict` among them, in dependency order, stopping on a
  conflict; moves `.worktrees/_run` to the merged tip and prints the suite command for the lead to run there,
  sandboxed, through the gates cache; and with `--result pass|fail` ends the batch or bisects a red one, one
  printed step per call, to the first bad merge. It never runs the suite itself, and removes no worktree or
  branch: it names the merged branches for the lead. `flow.md` step 7 uses it. Its git runs pinned to the
  project's common dir, as every hook's (#215). It refuses a linked `.worktrees` or `.worktrees/_run`, or a
  `_run` git does not register at that path, and never writes or reads its state through a link (#226).

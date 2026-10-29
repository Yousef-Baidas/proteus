### Added

- `proteus-merge.js <run> --suite "<suite>"` does the mechanical part of a merge batch (#191): it merges the PRs
  whose checks and statuses are all green, `proteus/verdict` among them, in dependency order, stopping on a
  conflict, and prints the commit to test with two commands for the lead to run sandboxed:
  `proteus-run-tree.js <sha>`, which fills the plain directory `.worktrees/_run` with that tree, and the suite
  there. With `--result pass|fail` it ends the batch or bisects a red one, one printed step per call, to the
  first bad merge. It never runs the suite itself, runs no git with a working tree, and removes no worktree or
  branch: on pass it names the merged branches gh reports merged, for the lead. `flow.md` step 7 uses it. Its
  git runs pinned to the project's common dir, as every hook's (#215). It checks its state file on every read,
  never writes or reads it through a link, and strips control characters from its output (#226).
  `proteus-run-tree.js` is in no prefix rule or sandbox exclusion, and refuses a linked `.worktrees` or `_run`.

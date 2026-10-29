### Added

- `proteus-merge.js <run> --suite "<suite>"` does the mechanical part of a merge batch (#191): it merges the PRs
  whose checks and statuses are all green, `proteus/verdict` among them, in dependency order, stopping on a
  conflict and naming the merged branches whose worktrees the lead removes; runs the suite once in
  `.worktrees/_run` through the gates cache; bisects a red one; and prints one line with the merged PRs, the suite result and the first bad merge.
  `flow.md` step 7 uses it. Its git runs pinned to the project's common dir, as every hook's (#215). It refuses
  a linked `.worktrees` or `.worktrees/_run`, or a `_run` git does not register at that path, and makes its
  suite log new without following a link (#226).

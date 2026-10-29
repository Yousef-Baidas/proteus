### Added

- `proteus-merge.js <run> --suite "<suite>"` does the mechanical part of a merge batch (#191): it merges the PRs
  whose checks and statuses are all green, `proteus/verdict` among them, in dependency order, removing each
  worktree first and stopping on a conflict; runs the suite once in `.worktrees/_run` through the gates cache;
  bisects a red one; and prints one line with the merged PRs, the suite result and the first bad merge.
  `flow.md` step 7 uses it.

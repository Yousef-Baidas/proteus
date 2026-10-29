### Added

- `proteus-merge.js <run> --suite "<suite>"` does the mechanical part of a merge batch (#191): it merges the PRs
  whose checks and statuses are all green, `proteus/verdict` among them, in dependency order, stopping on a
  conflict, and prints the commit to test with two commands for the lead to run sandboxed:
  `proteus-run-tree.js <sha>`, which checks that commit out in `.worktrees/_run`, a repo of its own reading the
  project's objects, and the suite there, bare. With `--result pass|fail` it ends the batch or bisects a red
  one, one printed step per call, to the first bad merge. It never runs the suite itself, runs no git with a
  working tree, and removes no worktree or branch: on pass it names the merged branches gh reports merged, for
  the lead. `flow.md` step 7 uses it. Its
  git runs pinned to the project's common dir, as every hook's (#215). It checks its state file on every read,
  never writes or reads it through a link, and strips control characters from its output (#226).
  It reads the run branch's tip with `git ls-remote` and fetches with no auto maintenance and no ref, reflog or
  `FETCH_HEAD` written. `proteus-run-tree.js` is in no prefix rule or sandbox exclusion, writes nothing under the
  common dir, and refuses a linked `.worktrees` or `_run`, or a `_run` an older Proteus registered as a worktree.

### Changed

- `proteus-gates-cache.js` refuses (exit 2) to run below the top of a checkout, where its key would name that
  checkout's tree, not the files the command tests (#226). The lead's suite after a merge runs bare in
  `.worktrees/_run`, never through it.

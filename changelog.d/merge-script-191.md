### Added

- `proteus-merge.js <run> --suite "<suite>"` does the mechanical part of a merge batch (#191): it merges the PRs
  whose checks and statuses are all green, `proteus/verdict` among them, in dependency order, stopping on a
  conflict, and prints the commit to test with two commands for the lead to run sandboxed:
  `proteus-run-tree.js <sha>`, which checks that commit out in `.worktrees/_run`, a repo of its own reading the
  project's objects, and the suite there, bare. With `--result pass|fail --at <sha>` it ends the batch or
  bisects a red one, one printed step per call, to the first bad merge; a result whose `--at` is not the commit
  its state awaits, or with no `--at`, is refused and prints no sha, so a state an agent rewrites between calls
  cannot collapse a bisect back to the tip. It never runs the suite itself, runs no git with a
  working tree, and removes no worktree or branch: on pass it names the merged branches gh reports merged, for
  the lead. `flow.md` step 7 uses it. Its
  git runs pinned to the project's common dir, as every hook's (#215). It checks its state file on every read,
  never writes or reads it through a link, and strips control characters from its output (#226).
  It reads the run branch's tip with `git ls-remote` and fetches with no auto maintenance, no submodule and no
  ref, reflog or `FETCH_HEAD` written, origin's URL read from the project's own config only. On pass it reads
  origin's tip again and prints it only when it is the commit the state names, else refuses and prints no sha;
  the lead fast-forwards to that sha, never to a short ref name. `proteus-run-tree.js` is in no prefix rule or sandbox exclusion, makes `_run`
  anew for each commit and checks its tree against the project's, writes nothing under the common dir, and
  refuses a linked `.worktrees` or `_run`, or a `_run` an older Proteus registered as a worktree.

### Changed

- Every hook's git runs with submodule recursion off (`fetch.recurseSubmodules`, `submodule.recurse`), so an
  agent's `<common>/.gitmodules` and `<common>/modules/<path>/config` never reach git outside the sandbox, and
  hooks run no git on a common dir that holds a `commondir` file (#226).

- `proteus-gates-cache.js` refuses (exit 2) to run below the top of a checkout, where its key would name that
  checkout's tree, not the files the command tests (#226). The lead's suite after a merge runs bare in
  `.worktrees/_run`, never through it.

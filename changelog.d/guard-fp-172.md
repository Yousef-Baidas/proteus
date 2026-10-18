### Fixed

- `proteus-shell-check.js` no longer opens a tamper record when a worker runs `git push -u` (or
  `git branch --set-upstream-to`) in a linked worktree the lead never prepared (#172): such a worktree, the one the
  agent's cwd is in, now counts as its own, so `branch.<b>.remote` and `branch.<b>.merge` for the branch checked out
  there pass. The same keys for any other branch, and every other key, are still caught.

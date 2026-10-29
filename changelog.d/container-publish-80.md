### Added

- `proteus-container.js run` takes `--model`, `--agent` (the agent file's body and `disallowedTools` reach
  `claude -p`) and `--ticket` with `--base` (#80). The clone runs the worktree's pre-commit and commit-msg checks
  from a read-only hooks dir. With `--ticket`, the worker writes its report to `/out/report.md`; after the import
  the host checks it (regular file, 64 KiB, UTF-8, a `<STATUS> #<n>` first line, else RED), pushes the branch with
  one refspec, opens the PR on `DONE` with `Owned:` and `Tier:` lines from the host's owned list, posts the report
  and prints `<STATUS> #<n> sent`. `doctor`'s credential row names `claude setup-token`.

### Added

- `proteus-container.js check --worktree <wt> --ref <sha> -- <command...>` (#80) runs a gate or test command on a
  commit reachable from the worktree's branch, checked out detached, in the same hardened container as `run`, with
  no credential env and `--network none` unless `--network` is given. Only `check.log` (stdout and stderr, 1 MiB
  each) and `status.json` come back, each refused unless a regular file under its cap. The last line is
  `CHECK <sha12> exit <n>` or `CHECK <sha12> timed out`; nothing is imported and no ref is made.

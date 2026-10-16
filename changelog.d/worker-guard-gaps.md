### Security

- Both guards refuse more from a subagent's shell (#48). A force-push to any branch, the worker's own included
  (`--force`, `-f`, `--force-with-lease`, a `+refspec`). `git -C`, `--git-dir`, `--work-tree` or `GIT_DIR`
  aimed anywhere but the agent's own worktree. A write to `.claude/`, `.codex/`, `.agents/`, `.git/` (scratch
  excepted), lefthook config, `.github/workflows/`, `.github/actions/`, `teams/templates/hooks/` or the user's
  `~/.claude`, `~/.codex` and `~/.agents` by `sed -i`, `perl -i`, `ruby -i`, a redirect, `tee`, `cp`, `mv`,
  `ln`, `install`, `dd of=`, `truncate`, `touch` or `rm`. Paths resolve after a leading `cd` chain, through
  wrappers, `sh -c` and `eval`, and match case-insensitively with either path separator. Writes to owned
  paths, a plain push of the worker's branch, and git in its own worktree still pass.

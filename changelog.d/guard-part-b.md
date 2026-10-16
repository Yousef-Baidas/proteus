### Security

- A subagent's shell is judged more deeply before it runs (#48). `lib.agentShellDenial` now also judges the
  command `xargs` and `find -exec`/`-execdir`/`-ok` run. It refuses `git checkout`/`restore` of a guarded path
  from another commit, and `git apply`, `git am`, `patch` and `git stash pop`/`apply` that would write one.
  It refuses `rm -r`, `mv`, `cp -r` and `rsync` of a dir that holds one, and a force-push set up through git
  config, `push.default`, an alias or a `gh api` ref update. Git Bash drive paths (`/c/...`) and Codex's shell
  `workdir` are read. `git checkout -- <file>` in the agent's own worktree, `find -print` and `xargs grep`
  still pass.
- New `proteus-shell-check.js` (`PostToolUse` on `Bash`) catches what the command line hides: an interpreter
  write (`python -c`, `node -e`, a build script), a path in a variable or a glob. The guards fingerprint the
  guarded paths before each subagent shell call, with the other workers' idle worktrees' `git status`, and
  compare after it. A change git does not explain blocks the agent with the paths named until it puts them
  back, and is recorded in `<git-common-dir>/proteus/tamper/`. Meanwhile `proteus-signoff.js` refuses MERGE
  on that branch. The hash cache in `<git-common-dir>/proteus/guard-hash.json` holds only the current
  fingerprint's paths, at most 8000. Pre and Post together add about 70 ms to a subagent shell call.
- The git config files are compared by key, not by hash: `user.*`, `color.*`, line endings, the file mode
  bit and the agent's own branch's upstream pass, and any other key an agent sets (`core.hooksPath`,
  `alias.*`, `remote.*`, `include*`, ...) is named in the block.
- What changes while one of the lead's own shell calls overlaps an agent's is not pinned on the agent: the
  lead is shown a notice with the paths (`proteus-shell-check.js --list`, `--clear <n>`), and its call
  re-baselines the agents' snapshots and open records.

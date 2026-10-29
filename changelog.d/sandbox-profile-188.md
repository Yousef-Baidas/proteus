### Added

- `install.js --sandbox` writes a settings file of its own, `~/.claude/proteus-sandbox/<repo>-<hash>.json`, for
  `claude --settings <file> --permission-mode bypassPermissions` (#188). It turns on Claude Code's sandbox in
  strict mode (`failIfUnavailable`, no unsandboxed retry) on macOS, Linux and WSL2. Shell writes go to the repo,
  its git dir and a private scratch dir only. Your gh config dir, `~/.ssh`, cloud and other credential files and
  keyrings cannot be read, and token env vars are removed. The network is limited to GitHub and the registries `AGENTS.md ## Learned`
  names. `permissions.deny` rules hold Read, Edit, WebFetch and command-running MCP servers, which the
  sandbox does not cover. They also hold the git config files and hooks git would run outside the sandbox
  (`.git/config`, each `config.worktree`, hooks, submodules'). Each rule is an exact path or ends in `/**`,
  the only kinds Linux honours. `proteus-worktree.js` adds each new worktree's rules. `proteus-worktree.js` runs outside it from a copy agents cannot write, which prepares only
  the repo's own worktrees. Your own settings files are never edited.
  docs/install.md has a "Sandboxed bypass" section with the residuals.

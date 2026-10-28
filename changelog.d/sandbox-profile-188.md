### Added

- `install.js --sandbox` writes a settings file of its own, `~/.claude/proteus-sandbox/<repo>-<hash>.json`, for
  `claude --settings <file> --permission-mode bypassPermissions` (#188). It turns on Claude Code's sandbox in
  strict mode (`failIfUnavailable`, no unsandboxed retry) on macOS, Linux and WSL2. Shell writes go to the repo,
  its git dir and the temp dir only. `~/.ssh`, cloud credentials and, with `agentGh`, your gh config dir cannot be
  read, and token env vars are removed. The network is limited to GitHub and the registries `AGENTS.md ## Learned`
  names. `permissions.deny` rules hold Read, Edit and WebFetch, which the sandbox does not cover, and
  `proteus-worktree.js` and `install.js --project` run outside it. Your own settings files are never edited.
  docs/install.md has a "Sandboxed bypass" section with the residuals.

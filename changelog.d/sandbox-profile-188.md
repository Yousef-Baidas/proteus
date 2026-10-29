### Added

- `install.js --sandbox` writes a settings file of its own, `~/.claude/proteus-sandbox/<repo>-<hash>.json`, for
  `claude --settings <file> --permission-mode bypassPermissions` (#188). It turns on Claude Code's sandbox in
  strict mode (`failIfUnavailable`, no unsandboxed retry) on macOS, Linux and WSL2. Shell writes go to the repo,
  its git dir and a private scratch dir only. Your gh config dir, `~/.ssh`, cloud and other credential files and
  keyrings cannot be read, and token env vars are removed. The network is limited to GitHub and the registries `AGENTS.md ## Learned`
  names. `permissions.deny` rules hold Read, Edit, WebFetch and command-running MCP servers, which the
  sandbox does not cover. They also hold the git config files and hooks git would run outside the sandbox
  (`.git/config`, each `config.worktree`, hooks, submodules'). Each rule is an exact path or ends in `/**`,
  the only kinds Linux honours. Preparing a worktree takes two steps: `proteus-worktree.js` writes the
  worktree's `.claude` files inside the sandbox, then a copy agents cannot write runs outside it and writes only
  the git half under the repo's git dir (hooks, `config.worktree`, `info/exclude`, the new worktree's deny rules),
  never a path in the worktree and never through a link. It prepares only the repo's own worktrees. That copy takes the repo's main root and state dir from the `sandbox-root.json`
  `--sandbox` writes beside it, never from a `.git` file, `commondir` or the cwd, and refuses without it.
  The only guest dir the profile makes writable is `~/.proteus/guest/<repo>-<hash>`; a `guest.json` naming
  another dir is warned about and left out. Your own settings files are never edited.
  docs/install.md has a "Sandboxed bypass" section with the residuals.

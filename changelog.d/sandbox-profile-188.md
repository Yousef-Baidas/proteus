### Added

- `install.js --sandbox` writes a settings file of its own, `~/.claude/proteus-sandbox/<repo>-<hash>.json`, for
  `claude --settings <file> --permission-mode bypassPermissions` (#188). It turns on Claude Code's sandbox in
  strict mode (`failIfUnavailable`, no unsandboxed retry) on macOS, Linux and WSL2. Shell writes go to the repo,
  its git dir and a private scratch dir only. Your gh config dir, `~/.ssh`, cloud and other credential files and
  keyrings cannot be read, and token env vars are removed. The network is limited to GitHub and the registries `AGENTS.md ## Learned`
  names. `permissions.deny` rules hold Read, Edit, WebFetch and command-running MCP servers, which the
  sandbox does not cover. They also hold the git config files and hooks git would run outside the sandbox
  (`.git/config`, `.git/config.worktree`, `.git/hooks`, submodules'); `--sandbox` sets
  `extensions.worktreeConfig` before the session. Each rule is an exact path or ends in `/**`,
  the only kinds Linux honours. Preparing a worktree takes two steps: `proteus-worktree.js` prepares the
  whole worktree inside the sandbox (its `.claude` files, hooks, `config.worktree`, `info/exclude`, `--allow`),
  then a copy agents cannot write runs outside it. While a session runs, that copy writes nothing in any dir a
  sandboxed command can write; it adds a new submodule's deny rules to the profile and refuses when
  `extensions.worktreeConfig` is missing. A worker's own hooks and config are not a boundary; CI's owned-path
  check of the PR is. It takes only the repo's own worktrees. That copy takes the repo's main root and state dir from the `sandbox-root.json`
  `--sandbox` writes beside it, never from a `.git` file, `commondir` or the cwd, and refuses without it.
  The only guest dir the profile makes writable is `~/.proteus/guest/<repo>-<hash>`; a `guest.json` naming
  another dir is warned about and left out. Your own settings files are never edited.
  The profile also denies the repo root's `.claude/hooks/` and `.claude/settings*.json` (the two settings files
  by exact path too) and `.git/proteus-lead/`, the lead's state the hooks write. `--sandbox` makes that dir
  first, mode 0700, and refuses a link or a file there. Hooks run `git diff` on a private copy of a worktree's
  index, so swapping its dir under `.git/worktrees/` for a link cannot aim git's index rewrite elsewhere; an
  index that is a link or not a regular file reports no changes known. A 1.x release checkout that is the repo
  itself is no longer fetched or updated at session start, with one line saying so.
  docs/install.md has a "Sandboxed bypass" section with the residuals.

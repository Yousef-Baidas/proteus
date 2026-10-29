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
  another dir is warned about and left out. Your own settings files under `~/.claude` are never edited.
  The profile also denies the repo root's `.claude/hooks/` and `.claude/settings*.json` (the two settings files
  by exact path too) and `.git/proteus-lead/`, the lead's state the hooks write. `--sandbox` makes that dir
  first, mode 0700, and refuses a link or a file there. Hooks run `git diff` on a private copy of a worktree's
  index, made under `.git/proteus-lead/`, so swapping its dir under `.git/worktrees/` for a link cannot aim
  git's index rewrite elsewhere. An index that is a link, is not a regular file or is over 64 MB reports no
  changes known. A 1.x release checkout that agents can write is never updated, moved to the
  plugin, synced or loaded from at session start, in any project. That covers the repo itself, another place in
  the sandbox's write set, and any path a profile in `~/.claude/proteus-sandbox/` makes writable, so a home
  self-hosted in one sandboxed repo is skipped from every other project too. The session-start hook runs outside
  the sandbox, so any of those would carry an agent's edits out of it. The home is judged by its named path and
  its real location, and read only through the real location. One line says so and names
  `node <home>/install.js --update`, which you run from your own terminal. `--sandbox` refuses such a home and
  writes nothing: under the profile, install Proteus as a plugin, or move the home outside every sandboxed repo.
  The profile denies everything under the `.claude/` of the repo root and the guest dir, by a rule Linux honours.
  A deeper `.claude/skills/` is held by a `PreToolUse` hook on `Skill`, run from the copy outside the write set: it
  refuses a skill while a `SKILL.md` for its name sits in any `.claude/skills/` the profile makes writable, other
  than those two, and refuses every skill when its scan errs or passes 8 levels or 50,000 entries. `--sandbox`
  points a Proteus `statusLine` whose script sandboxed commands can write at its own copy outside the write set,
  in `.claude/settings.local.json` only, and warns about a plugin installed inside it. It checks both settings
  files before writing anything. Once a profile exists, `--project`, `--plugin-setup` and `--migrate-here` do the
  same for a status line they write. `--sandbox` refuses when Claude Code's config dir or the Proteus checkout is
  in any profile's write set, or a profile cannot be read; the 1.x install refuses such a checkout too. The
  session-start line for a skipped 1.x home names the skill link `~/.claude/skills/proteus` and how to remove it.
  docs/install.md has a "Sandboxed bypass" section with the residuals.

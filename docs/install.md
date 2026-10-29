# Installing Proteus

## Plugin (Claude Code)

On Claude Code, install Proteus as a plugin pinned to a release tag, then set up each repo from inside it:

```bash
claude plugin marketplace add Yousef-Baidas/proteus#v2.3.1
claude plugin install proteus@proteus
```

Then, in a Claude Code session in your repo, run `/proteus:setup`. It enables the plugin for that repo in the committed `.claude/settings.json` (the plugin's hooks stay silent in every other repo), lists the `proteus` marketplace there so teammates are offered the plugin, copies `teams/`, and prints the GitHub steps left to you (`--protect`, `--verifier-app`). It then moves every other repo still on a 1.x install ([Moving from 1.x](migrating.md#moving-from-1x)); `--only-here` stops after this repo. `/proteus:setup --dry-run` shows what it would change. In a repo you cannot push to it goes [guest mode](#guest-mode-repos-you-do-not-own) like `--project`, and the checkout gets nothing to commit. Otherwise commit `.claude/settings.json` and `teams/`, start a new session, and the lead starts itself; `/proteus:proteus` invokes it by hand. The prerequisites below apply either way; on a 1.x install, `install.js --update` installs the plugin and moves your repos for you ([Moving from 1.x](migrating.md#moving-from-1x)). The pin and how to move it to a newer release are in [Updating](updating.md).

Codex CLI has no plugin: it uses the installer path ([Install with the installer](#install-with-the-installer), then [Codex CLI](#codex-cli)), which still works for Claude Code too.

## Prerequisites (all platforms)

1. [Claude Code](https://code.claude.com/docs/en/overview) installed and logged in.
2. Node.js 22.5 or newer (the context-mode plugin needs it; `node --version`) and the [GitHub CLI](https://cli.github.com/) logged in (`gh auth login`); the repo needs a GitHub remote.
3. The mattpocock-skills plugin. Inside Claude Code:
   ```
   /plugin install mattpocock-skills@claude-plugins-official
   ```
   Cherry-picking instead? You need: `setup-matt-pocock-skills`, `grilling`, `grill-with-docs`, `domain-modeling`, `codebase-design`, `wayfinder`, `to-spec`, `to-tickets`, `implement`, `tdd`, `code-review`, `resolving-merge-conflicts`, `handoff`.
4. The [context-mode](https://github.com/mksglu/context-mode) plugin, optional. Without it, agents write large output to a file in the scratch dir (`proteus-scratch.js --path <key>`) and read it with `grep`, `head` and `tail`; Proteus works the same, it just spends more context. `install.js` installs it through the claude CLI and only warns if that fails; if the CLI is not on PATH, run `claude plugin marketplace add mksglu/context-mode` and `claude plugin install context-mode@context-mode` yourself. Research, logs, test output, and web pages go through its sandbox so only the findings enter an agent's context. It is third-party code: its hooks see every tool call in every Claude Code session on the machine, and it keeps session events and indexed content in local SQLite under your home directory (`~/.context-mode/`). Read it before you install it.
5. Recommended companions (each is its own install; the skill works without them but saves less):
   - [caveman](https://github.com/JuliusBrussee/caveman) — terse agent output
   - [ponytail](https://github.com/DietrichGebert/ponytail) — minimal code, on Quick and mechanical tickets
   - [rtk](https://github.com/rtk-ai/rtk) — compressed shell output
   - [Chisle](https://github.com/JayPokale/Chisle) is not a companion: it restates caveman and ponytail in one ruleset and the prose styles fight when stacked. Optional, compress hook only (`CHISLE_DEFAULT_MODE=off`); see `references/stack.md`
   - Claude Code LSP plugin: `/plugin install <language>-lsp@claude-plugins-official`
   - [graphify](https://github.com/safishamsi/graphify) — planning-stage orientation only
   - code-review-graph — verifier blast radius; Serena — alternative to the LSP plugin
   - Gates: `npx fallow` (JS/TS, no install), `vulture-rs` (Python), `cargo machete` (Rust)

## Install with the installer

For Codex CLI, or Claude Code without the plugin. All logic is in `install.js` (Node 22.5+). `install.sh` and `install.ps1` are thin wrappers that only find `node` and pass the flags through, so every command below also works as `node install.js …`.

```bash
git clone https://github.com/Yousef-Baidas/proteus.git ~/proteus
node ~/proteus/install.js              # skills + agents for every repo, and the optional context-mode plugin
cd /path/to/your/repo
node ~/proteus/install.js --project    # teams/, ROUTING.md, the lead's hooks and status line
```

Run from a subfolder, `--project` sets up the repo's root. `--project --install --confine` also fetches skills this machine lacks and hides them from the lead. After `proteus-scout` rewrites a list, run `node teams/link-skills.js --install --confine` from the repo root. In a repo you do not own, `--project --guest` keeps all of it outside the tree ([Guest mode](#guest-mode-repos-you-do-not-own)); there the script is `<guest dir>/teams/link-skills.js`.

The global install links `~/.claude/skills/proteus` and `proteus-review` to this checkout (a symlink on Linux and macOS, a junction on Windows, no admin rights needed), so there is exactly one copy of each skill and `git pull` updates every repo at once. `--project` removes old per-repo copies of the two skills and of unmodified agents; that is why `/proteus` used to show up twice. An agent you changed is kept and reported as a local override, with the fields it changes, and no later release reaches it. To change a shipped agent and keep its updates, patch it instead ([Agent patches](#agent-patches)). Nothing is written or removed through a link the repo commits: a linked `.claude`, `.codex`, `teams/` or dir in it, hook file, generated agent, `teams/skills-lock.json`, `teams/.proteus-base.json`, `.upstream` or `.base` file, or `.codex/config.toml` is refused by name and left alone. A link you made on purpose has to become a real directory or file.

If you set `CLAUDE_CONFIG_DIR`, the installer and the hooks use it wherever these docs say `~/.claude` (`proteus.json`, `settings.json`, skills, agents, plugins).

## Agent patches

A project changes a shipped agent by writing only the change in `.claude/proteus-agents.json`, committed with the repo (in guest mode it stays in `.claude/` but is excluded from git):

```json
{
  "proteus-guide": { "tools": { "add": ["Skill"] } },
  "proteus-scout": { "model": "opus", "effort": "high", "append": "Also check X before approving." }
}
```

`tools` takes `add` and `remove` lists, `model` and `effort` replace those frontmatter lines, and `append` adds text to the end of the prompt. `--project`, `--update` and the session-start sync (so auto-update too) write `.claude/agents/<agent>.md` from the shipped agent plus its patch, with a `# generated by proteus from proteus-agents.json` line in the frontmatter, and exclude it from git. A later release's changes to that agent come through on the next run. Remove an entry and its generated file goes. Claude Code loads agent types at session start, so a regenerated agent applies from the next session. Workers ship without a `tools` list (they get every tool but the few in their `disallowedTools`), so `tools` is refused for them. An invalid file, an unknown agent or key, or a wrong type is an error naming the entry; nothing is written until it is fixed. A hand-made copy at the same path is never overwritten, and nothing is written or removed through a linked `.claude`, `.claude/agents` or agent file: each is refused by name. Move its edits into the patch, then `git rm` it; `--doctor` lists each copy with the fields it changes. Granting `Agent` lets that agent spawn its own sub-agents outside the model ladder, so the shipped agents leave it out.

On Codex the file is `.codex/proteus-agents.json`, and the result is a TOML role in `.codex/agents/`. Codex roles carry no model, effort or tool list, so only `append` applies there.

## Windows

On Windows, PowerShell blocks unsigned scripts by default. Run the wrapper as:

```powershell
powershell -ExecutionPolicy Bypass -File C:\path\to\proteus\install.ps1 -Project
```

or skip PowerShell: `node C:\path\to\proteus\install.js --project`. The switches are `-Project -Install -Confine -Guest -NoGuest -Update -AutoUpdate -NoAutoUpdate -Doctor -Fix -Harness codex`.

## Agent teams

Agent teams must be on. `--doctor` prints the exact line for your shell; for reference:

```bash
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1      # bash / zsh rc
set -Ux CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS 1      # fish, once
```

```powershell
[Environment]::SetEnvironmentVariable("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS", "1", "User")
```

Or set it under `env` in `~/.claude/settings.json`. Restart the terminal afterwards.

## Guest mode: repos you do not own

In a repo you contribute to but do not own, even those docs and `teams/` are not yours to add. `install.js --project --guest` keeps them out of the tree: `teams/`, `CONTEXT.md`, `CONVENTIONS.md`, `AGENTS.md`, `docs/adr/` and `docs/lessons/` go to a guest dir, by default `~/.proteus/guest/<repo>-<hash>/` (`--guest <dir>` picks another), named in `.git/proteus/guest.json`. Bootstrap writes no CI workflow, no lefthook and no root doc, and the repo's own copies of those files stay untouched. The only files in the tree are the CLI's own hook files under `.claude/` or `.codex/`, untracked and excluded from git as in every install. The session gets access to the guest dir through `permissions.additionalDirectories` (Claude Code) or `writable_roots` (Codex). A tracked `.codex/config.toml` is never edited; the installer says what to add instead. The lead guard, the session-start state line, lessons, the skills lock and the baseline ratchet all read the guest dir.

`--project` and `--plugin-setup` (`/proteus:setup`) pick guest mode without the flag when `gh repo view` reports READ or TRIAGE access and the repo has no `teams/` of its own; `--guest [dir]` and `--no-guest` work with both, and `--no-guest` turns it off (the guest dir keeps its files). In guest mode `--plugin-setup` puts the plugin's gate, the status line and the guest dir in the untracked `.claude/settings.local.json` and leaves `.claude/settings.json` alone, so the plugin is on for you only and teammates are offered nothing; `--doctor` counts that as a healthy setup. Gates still run, but locally and through tickets, not through CI you add. Tickets, PRs and the run log still need a GitHub repo you can write to: in a clone of your fork, `gh` reports your own rights, so pass `--guest` yourself.

## Codex CLI

The same installer sets Proteus up for [Codex CLI](https://developers.openai.com/codex) with `--harness codex` (or `PROTEUS_HARNESS=codex`; `-Harness codex` in PowerShell). Every flag above takes it.

```bash
node ~/proteus/install.js --harness codex             # skills + agents for every repo
cd /path/to/your/repo
node ~/proteus/install.js --harness codex --project   # teams/, ROUTING.md, the lead's hooks in .codex/
```

Codex reads skills from `~/.agents/skills`, so the two skills are linked there. The agents become TOML roles in `$CODEX_HOME/agents` (default `~/.codex/agents`); a role file without the `# generated by proteus` first line is yours and is never overwritten, by the installer or by the session-start sync. `--project` registers the lead's hooks in `.codex/hooks.json` and lets git and `gh` run outside the sandbox through `.codex/rules/proteus.rules`; both, and the copied hooks, are excluded from git. Worker worktrees live in `.worktrees/` inside the project, which the workspace-write sandbox already lets workers write, so a new repo gets no `writable_roots` entry. Only while a run started under Proteus 1.1 or earlier still has worktrees in `../<repo>-proteus/` does `--project` keep that folder in `writable_roots` in `.codex/config.toml` (adding it back if lost), and it drops it once they are gone. It edits an existing file in place and excludes the file from git only if it created it. The Claude-only hook files (status line, worker settings, commit-msg check) are not copied into `.codex/hooks`. Team skills are also linked into `teams/<team>/.agents/skills/`, and a Codex worker reads them from there itself, since Codex only loads skills between the repo root and the session's cwd. `--confine` does not apply: Codex loads `~/.agents/skills` for every session, so it cannot hide a team skill from the lead.

Three steps the installer cannot do for you, once per repo:

1. Open `codex` in the repo and trust it. Codex loads a project's `.codex/` hooks only in a trusted project.
2. Approve the Proteus hooks in `/hooks`. Codex asks again when a hook entry changes, not when a script updates.
3. Optional: add context-mode: `codex mcp add context-mode --env CONTEXT_MODE_PLATFORM=codex -- npx -y context-mode`.

The rules name the lead's scripts by the main checkout's absolute path (`node /abs/repo/.codex/hooks/proteus-status.js`), rewritten each time `--project`, `--update` or the session-start sync registers the hooks (`--doctor` flags rules a moved checkout left stale); the scripts refuse to run from a copy anywhere else, such as a worker's nested `.codex/hooks`.

Codex has no status line hook and no attribution setting; the commit-msg check still rejects an AI trailer. `~/.claude/proteus.json` records which CLIs you installed for, and `--update` refreshes each. `--doctor --harness codex` checks the Codex side: skill links, agents, the hooks and rules, leftover Claude-only hooks, the worktree folder's writable root, project trust, and context-mode (as an MCP server or an installed, enabled Codex plugin).

## Check the install

```bash
node ~/proteus/install.js --doctor         # from a repo root: global and project checks
node ~/proteus/install.js --doctor --fix   # repair links, duplicates, the optional context-mode plugin, hook registration, team skills
```

In a project with a lefthook config, `--doctor` also times `lefthook run pre-commit` with nothing staged (30 s limit) and warns above 3 s, since a slow pre-commit gets bypassed: move slow checks to pre-push or CI.

Each line is `ok`, `WARN`, or `FIX`; the exit code is 1 while a `FIX` remains. In a repo `/proteus:setup` set up, it checks the plugin setup instead of the 1.x links, agents and lead hooks ([Moving from 1.x](migrating.md#moving-from-1x)). It checks Node 22.5+, the context-mode plugin (a `WARN` when missing or disabled, since it is optional; `--fix` installs it), the skill links and duplicates, agents, attribution, agent teams, `gh` auth, the project hooks, `ROUTING.md`, that every listed team skill resolves (`--fix` fetches and links a missing one, as `link-skills.js --install` does), that the commit-msg gate in `lefthook.yml` and `proteus-gates.yml` runs a file git tracks, that `proteus-gates.yml` has no unfilled `EDIT-*` placeholder, whose login the agents post under, on Claude Code whether `autoMode.environment` names Proteus (a `WARN` with the snippet below), and in a project whether a ruleset binds `proteus/*` and the agents' account can push.

## Auto mode (Claude Code)

Auto mode's classifier judges every tool call and every subagent's task description before it runs. It does not know Proteus, so a worker spawn whose brief talks about hooks and guards can look like an attempt to get around a denial, and it gets blocked. Proteus keeps its briefs short (the standing rules live in the agent files) and never retries a denied call, but only you can tell the classifier that Proteus is your own tooling: it reads `autoMode` from `~/.claude/settings.json` or managed settings only, never from a repo or a plugin.

`install.js` and `--doctor` print this snippet when no `autoMode.environment` entry names Proteus. Add the entry with `/auto-mode-setup` or `/permissions` → Auto mode, or by hand, keeping `"$defaults"` and any entries you already have:

```json
{
  "autoMode": {
    "environment": [
      "$defaults",
      "Proteus is my own multi-agent tooling: the /proteus lead spawns proteus-* worker, verifier, QA, guide and scout subagents, their task descriptions are ticket briefs I asked for, and the .claude/hooks/proteus-*.js hooks are my own guardrails"
    ]
  }
}
```

The installer never writes it: an agent editing your settings is self-modification to auto mode, and the call is yours. When a call is denied anyway, the lead tells you in one line what was denied, the reason tag and why the run needs it, then waits or carries on with other work; reply naming the action to clear it. A worker that hits a denial stops with `BLOCKED #<n> classifier <tag>: <action>` and is not re-spawned.

## Sandboxed bypass

Auto mode can still deny ordinary Proteus work, and prompts stall an unattended run. `bypassPermissions` turns prompts off, which is only safe behind an isolation layer. On macOS (Seatbelt), Linux and WSL2 (bubblewrap and socat), Claude Code's own sandbox is extra protection there: it blocks many attacks, but it is not a boundary against a determined agent (see [Known gaps](#known-gaps)). The container runner ([container.md](container.md), #80) is the isolation layer for workers. A plugin cannot ship sandbox or permission settings, so the installer writes them to a file of their own, which you pass at launch. Run it in the repo:

```sh
node install.js --sandbox
node install.js --project    # outside the sandbox, when the repo needs it: it writes .claude/hooks/
claude --settings ~/.claude/proteus-sandbox/<repo>-<hash>.json --permission-mode bypassPermissions
```

It prints the exact commands. Set up `--agent-login` first: the profile hides your own gh config from shell commands, so without an agent identity `gh` has no login inside the sandbox. Your own `settings.json` and `settings.local.json` under `~/.claude` are never touched. In the repo, `--sandbox` changes only a Proteus `statusLine` (see below). Run `--sandbox` again after you move the repo, update Proteus, or change `AGENTS.md ## Learned`, rather than editing the file. Native Windows has no sandbox, so the flag refuses there; use WSL2.

The file sets:

- `sandbox.enabled`, `failIfUnavailable` (no sandbox means no session) and `allowUnsandboxedCommands: false`, so a failed command is never retried outside the sandbox. Because these come from `--settings`, a repo's own settings cannot loosen the sandbox.
- Writes from shell commands go only to the repo (`.worktrees/` included), its git dir, a private scratch dir `<temp dir>/proteus-<uid>` (made mode 0700), and the guest dir in guest mode. The guest dir is always `~/.proteus/guest/<repo>-<hash>`: `.git/proteus/guest.json` is writable from the sandbox, so when it names any other dir, `--sandbox` warns, naming both, and leaves that dir out.
- Shell commands cannot read your gh config dir, `~/.ssh`, `~/.aws`, `~/.azure`, `~/.config/gcloud`, `~/.claude/.credentials.json`, `~/.git-credentials`, `~/.netrc`, `~/.npmrc`, `~/.docker/config.json`, `~/.kube`, `~/.gnupg`, or the keyrings (`~/.local/share/keyrings`, `~/Library/Keychains`). `GH_TOKEN`, `GITHUB_TOKEN`, the enterprise variants, `NPM_TOKEN` and `ANTHROPIC_API_KEY` are removed from their environment, so `gh` uses the agents' config dir.
- `network.strictAllowlist` with GitHub (`github.com`, `*.github.com`, `*.githubusercontent.com`) and the registries of the package managers `## Learned` names (npm, yarn, pip, cargo, Go, gem, Maven/Gradle, NuGet, Composer). Any other host is refused, with no prompt.
- `permissions.deny`, because the sandbox covers only Bash and its children. It removes `WebFetch` and the tools of MCP servers that run commands or fetch pages (context-mode, Playwright, Claude in Chrome). It blocks `Read` of the same secrets. It blocks `Edit` (which covers Write) outside the repo, the scratch dir and the guest dir, and on the repo's `.claude` dirs and on what git runs outside the sandbox: `.git/config`, `.git/config.worktree` (made empty if missing), `.git/hooks`, and each submodule's config and hooks. It also blocks everything under the `.claude/` of the repo root and of the guest dir, by a `/**` rule Linux honours, with `settings.json` and `settings.local.json` also named exactly. A hook or a setting planted there would make the plugin's next SessionStart run `install.js` outside the sandbox, a `SKILL.md` can carry `hooks:`, which run outside the sandbox once the skill loads, and a workflow script runs in Claude Code's own process. The `.claude` dirs deeper in the repo are blocked only by a rule with `**` in the middle, which Linux ignores for shell commands (see "Wildcards on Linux and WSL2" below). It also blocks `.git/proteus-lead/`, where Proteus's hooks keep the lead's state. `--sandbox` creates that dir first, owned by you and mode 0700, and refuses when a link or a file is in its place. Claude Code also applies these `Edit` rules to shell writes. A worktree's own `config.worktree` and `proteus-hooks/` are not denied: renaming its dir under `.git/worktrees/` gets round such a rule, and Proteus's hooks never let git read either (see "The worker's own hooks and config" below). For the same reason, the hooks never let git write a worktree's index: they run `git diff` on a private copy of it under `.git/proteus-lead/` and delete the copy afterwards. `--sandbox` sets `extensions.worktreeConfig` in `.git/config` before the session, so a sandboxed `proteus-worktree.js` can give each worktree its own hooks path. A deny rule cannot carve out an exception, so the installer lists everything next to each directory on the path down to the repo. A file or dir created there later is not covered, except a dotfile.
- `excludedCommands` for the copies of `proteus-worktree.js` and `proteus-container.js`. The lead prepares each worktree with `proteus-worktree.js <worktree> ...` as usual, inside the sandbox: it writes the worktree's `.claude` files, its `config.worktree` and pre-commit hooks under `.git/worktrees/<id>/`, `.git/info/exclude`, and the `--allow` state in `.git/proteus`, all paths a sandboxed command may write. Then it runs the copy it names, `node ~/.claude/proteus-sandbox/bin/<hash>/proteus-worktree.js <worktree>` (also printed by `--sandbox`), which runs with your full access. `--sandbox` puts that copy and the hooks beside it outside every path a sandboxed command may write and behind an `Edit` deny, and the entry names its absolute path only. While the session runs, the copy creates, renames, writes and deletes nothing in a dir a sandboxed command may write, so no lock or parent dir an agent swaps can steer it. It only reads `.git/config` and adds the deny rules of a submodule made since to the profile. It refuses when `extensions.worktreeConfig` is missing, telling you to run `--sandbox` again, and refuses `--allow`, which the in-repo script writes. The copy serves one repo: `sandbox-root.json` beside it names the repo's main root and git dir, and the copy takes every git call from there, never from the worktree's `.git` file, a `commondir` or the cwd. Without a readable `sandbox-root.json` it refuses. It refuses a worktree that is not under the repo's `.worktrees/`, or that the repo's git dir does not register. Run `--sandbox` in the repo's main checkout or one of its worktrees. `--sandbox` refuses when Claude Code's config dir is inside the repo, the scratch dir, or any path a profile makes writable, and when the Proteus checkout it copies from is in such a path, as with a Proteus repo working on itself. When a profile in `~/.claude/proteus-sandbox/` cannot be read, it refuses and writes nothing. The container runner needs docker or podman, which cannot run inside the sandbox; with `isolation: container` the lead runs `node ~/.claude/proteus-sandbox/bin/<hash>/proteus-container.js run ...` (`docs/container.md`). `install.js --project` is not excluded: run it yourself before launching.
- The status line. Claude Code runs a `statusLine` command itself, outside the sandbox, every time it draws the status line. The one `--project` writes runs `teams/templates/hooks/proteus-statusline.js` from the repo (or the guest dir), which sandboxed commands can write. So when the repo's `.claude/settings.json` or `.claude/settings.local.json` holds a Proteus `statusLine` whose script is inside the profile's writable paths, `--sandbox` points it at the copy in `~/.claude/proteus-sandbox/bin/<hash>/`, writing only to `.claude/settings.local.json`: a Proteus `statusLine` in the tracked `.claude/settings.json` is left as it is and overridden there. It leaves any other `statusLine` as it is and warns, naming it. It checks both settings files before it writes anything, and refuses, writing nothing, when one is a link or not a JSON object. Once the repo has a profile, `--project`, `--plugin-setup` (`/proteus:setup`) and `--migrate-here` do the same: a `statusLine` they add, or one already in `.claude/settings.json`, runs the copy, set in `.claude/settings.local.json` only.
- The plugin's own files. `--sandbox` warns when the installed Proteus plugin (or `CLAUDE_PLUGIN_ROOT`) is inside a path a profile makes writable, as with `claude --plugin-dir <repo>`, because Claude Code runs the plugin's hooks outside the sandbox. Install it from the marketplace instead.

The review session (`/proteus-review`) runs without the profile. Under `bypassPermissions`, `proteus-verdict.js --post` gets no permission dialog, so the guard prints the command for you to run instead.

What it does not cover:

- **Prompt injection.** Bypass approves whatever the model decides. The sandbox limits what a shell command can reach. It does not limit what the agent tries.
- **Read, Edit and Write** run outside the sandbox. They are held only by the deny rules above and by Proteus's hooks. Reads are open everywhere except the named secrets, because skills and plugins live outside the repo.
- **The gh token.** Agents need a token that reaches github.com, so a command can use it there, including against other repos it has access to. Use `identity=separate` (`--agent-login`): agents then hold a machine user's token, never yours. Never log in to anything from inside the sandboxed session.
- **Local MCP servers** run outside the sandbox, with your full access. The profile denies the ones known to run commands or fetch pages; any other server you have configured stays available to the agents.
- **The worker's own hooks and config.** A worker's `.claude` files, its `config.worktree`, its `proteus-hooks/`, `.git/info/exclude` and the `--allow` state are all writable from the sandbox, so none of them is a boundary. The pre-commit owned-path check runs in the worker's own git, which it can turn off; the boundary is CI's check of the PR against `.proteus/owned/<id>` on the run branch. A git command you run in a worker's worktree outside the sandbox runs what the worker wrote there.
- **Wildcards on Linux and WSL2.** There the sandbox honours a write deny only for an exact path or one ending in `/**`. A `*` or `**` in the middle matches nothing for shell commands. So the git rules name each submodule as it is when `--sandbox` runs. A submodule made later by a sandboxed git command (`git submodule add`) stays writable to shell commands until the copy of `proteus-worktree.js` runs, or until you run `--sandbox` again.
- **A 1.x Proteus checkout inside a sandboxed repo.** The `home` in `~/.claude/proteus.json` may be this repo itself, or any other place sandboxed commands can write: a dir inside the repo or its git dir, a worktree, the guest dir, or any path that a profile in `~/.claude/proteus-sandbox/` makes writable, including another repo's and its scratch dir. `--sandbox` refuses such a home, writing nothing, because the skill link `~/.claude/skills/proteus` points into it and no hook can gate that. Under the profile the plugin is the supported install: install Proteus as a plugin, or move the home outside every sandboxed repo, then run `--sandbox` again. If such a home is still configured, the session start in any project never updates it, never moves it to the plugin, never copies its hooks or agents, and never loads code from it. It says so in one line. The session-start hook runs outside the sandbox, so taking anything from a checkout the agents can edit would carry their edits out of it. It judges the home both by the path `proteus.json` names and by that path's real location, with every link resolved, and then reads only from the real location, so a link an agent retargets afterwards changes nothing. On macOS and Windows the comparison ignores case. When a profile cannot be read, the session start treats the home as writable. Update such a home yourself by running `node <home>/install.js --update` from your own terminal. The skill link `~/.claude/skills/proteus` still loads that home's `SKILL.md`, which agents can edit, so the line also names the link: delete the link itself (not the folder it points to) from your own terminal, unless you check that file. `install.js` with no flag (the 1.x install) refuses a checkout in such a place too.
- **Caches.** A package manager that writes its cache under your home (for example `~/.npm`) fails inside the sandbox. Point its cache at the scratch dir for the session (e.g. `npm_config_cache`).

### Known gaps

Claude Code loads and runs project files, such as a nested `.claude/skills/` whose `hooks:` run outside the sandbox, from folders the sandbox lets agents write. On Linux the sandbox cannot deny "any `.claude` at any depth", so the profile cannot close this. The container runner ([container.md](container.md), #80) is the isolation layer for workers.

- **Nested skills.** An agent can write a skill under a deeper `.claude/skills/`, such as `src/.claude/skills/<name>/`, a worktree's, or one under `node_modules`. When the skill is invoked, its `hooks:` run outside the sandbox.
- **A planted skill you type.** Typing `/<name>` for such a skill runs it the same way.
- **Local agent memory.** The `.claude/` deny makes `.claude/agent-memory-local/` read-only, so the agents with `memory: local` (proteus-verifier, the qa, security, frontend and backend verifiers, and proteus-guide) keep no new memory under the profile.
- **Your own git and auto maintenance.** A `git fetch`, `pull`, `merge` or `worktree prune` you run in a Proteus repo can start git's auto maintenance, whose worktree prune follows a link an agent planted under `.git/worktrees/` and empties its target (#235). Proteus's own git turns it off; `git config maintenance.auto false` in the repo closes it for yours. Proteus does not change your config.
- **Other config dirs.** Proteus reads profiles only from the current Claude Code config dir, so a repo sandboxed under another `CLAUDE_CONFIG_DIR` is invisible to the session-start check for a writable 1.x home.

## Manual install (any platform)

1. Link or copy `skills/proteus/` and `skills/proteus-review/` to `~/.claude/skills/`. Not also to `<repo>/.claude/skills/`: two copies show up as two commands.
2. Copy `agents/*.md` to `~/.claude/agents/`.
3. Copy `templates/teams/` into your repo as `teams/` and run `node teams/link-skills.js --install`. Copy `templates/` except `templates/teams/` to `teams/templates/` and run `node teams/templates/hooks/install-lead-hooks.js` from the repo root.
4. Merge into `~/.claude/settings.json`:
   ```json
   { "attribution": { "commit": "", "pr": "", "sessionUrl": false } }
   ```
5. Set `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`.

## Uninstall

Plugin: `claude plugin uninstall proteus@proteus` and `claude plugin marketplace remove proteus`, then in each repo drop `proteus@proteus` from `enabledPlugins` and `proteus` from `extraKnownMarketplaces` in `.claude/settings.json`, plus the `statusLine` in `.claude/settings.local.json`. `teams/` and the rest below are as for the installer.

Installer: Delete the links `~/.claude/skills/proteus` and `~/.claude/skills/proteus-review` (the checkout stays), `~/.claude/agents/proteus-*.md`, `~/.claude/proteus.json`, `teams/` in any repo, and the `proteus-` entries and Proteus `statusLine` in its `.claude/settings.local.json`. `.github/workflows/proteus-gates.yml`, `lefthook.yml`, and `.claude/hooks/` are yours to keep or drop; local run state is in `.git/proteus/` and `.git/proteus-lead/`. Once `git worktree list` shows none left in `.worktrees/`, delete that folder and its `/.worktrees/` line in `.git/info/exclude`. Open `proteus` and `proteus-*` issues and labels stay on GitHub for you to close. Skills you confined are still in `~/.agents/skills/`; re-link them into `~/.claude/skills/` if you want them global again. Remove the `attribution` key from `~/.claude/settings.json` if you want the default trailer back.

For Codex, also delete the links `~/.agents/skills/proteus` and `proteus-review`, `$CODEX_HOME/agents/proteus-*.toml`, and in each repo the `proteus-` entries in `.codex/hooks.json`, `.codex/hooks/`, `.codex/rules/proteus.rules`, and any `<repo>-proteus` entry an older run left in `.codex/config.toml`'s `writable_roots`. `codex mcp remove context-mode` drops context-mode.

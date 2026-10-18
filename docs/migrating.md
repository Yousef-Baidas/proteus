# Migrating

## Moving from 1.x

A 1.x install put copies in each repo and in `~/.claude`; the plugin brings its own, so those copies have to go or they run twice. You do not have to move each repo yourself. Any of these does it for every repo it finds:

- `node <1.x checkout>/install.js --update`, or 1.x `autoUpdate`. It moves the checkout to the newest signed release, installs the plugin pinned to that tag at user scope through the `claude` CLI, then runs `install.js --migrate`. Without the `claude` CLI it prints the `/plugin` commands to type instead. `autoUpdate` runs it in the background at most once a day and writes its output to `proteus-update.log` beside `proteus.json`.
- `/proteus:setup` in any repo. It sets up that repo, then moves every other 1.x repo it finds. `--only-here` stops after this repo.
- Opening a repo. The plugin's SessionStart hook moves a repo that still has 1.x copies the first time you open it there and prints one line. A repo the search below missed is moved this way.

`--dry-run` (on `--migrate` and `/proteus:setup`) lists everything first and writes nothing.

### Which repos

Repos come only from these places, in this order. No folder is assumed:

1. the `repos` list in `~/.claude/proteus.json`; every repo set up from now on is added to it
2. the projects in `.claude.json` (in `CLAUDE_CONFIG_DIR` when set, else your home)
3. the `[projects."..."]` entries in `$CODEX_HOME/config.toml` (`~/.codex` by default)
4. each `--scan <dir>` you pass, three levels deep; there is no default

A path is kept only if it answers within a short timeout, is a repo's main checkout (not a worktree), is inside your home but not your home itself, is writable, and still has 1.x copies. The same repo reached twice (a link, a case difference on macOS and Windows) counts once. With more than one Claude Code profile (`CLAUDE_CONFIG_DIR`), each profile is moved by its own run, and the output names the other profiles with the command for each. Under WSL only the Linux side's config is read, and the output says to run `/proteus:setup` on the Windows side too.

### What a move does in each repo

It removes the repo's 1.x pieces that are unedited, meaning byte-identical to a file some release shipped:

- the `.claude/hooks/` scripts, with their entries (and the 1.x status line) in `.claude/settings.json` and `.claude/settings.local.json`; other keys stay
- the `.claude/agents/proteus-*.md` copies
- their lines in `.git/info/exclude`

It then enables the plugin there. The plugin's scope follows how you installed it: with a user-scope install the repo is gated in through its committed `.claude/settings.json`. With a project or local install, the repo gets its own install at that scope (and the scope's gate), so other repos stay as they were.

An edited copy stays and is named, along with the reason. So does a copy git tracks: the summary prints the `git rm` and commit command for it. The move never commits, never pushes and never touches a remote. A hook `lefthook.yml` or `proteus-gates.yml` runs also stays (point the gate at `teams/templates/hooks/commit-msg.js` first). An edited hook still runs beside the plugin's until you delete it.

A repo is shared when its GitHub owner is not your `gh` login, when it has no GitHub origin, or when someone else last changed one of its tracked Proteus files. There the move touches only untracked files and names who last changed the tracked ones. A repo with a Proteus run in flight (a `proteus/<run>` branch checked out, a worker worktree, or a lead journal written within the hour) is skipped and moved by its first session after the run ends.

The move needs `gh` logged in, because it checks who owns each repo. Offline or logged out, it stops before changing anything and says so.

### The summary

At the end, one summary lists each repo moved or skipped, and the GitHub steps left to you: `--protect` and `--verifier-app` per repo you own, and the owner's name for a shared one. The user-level 1.x install (the `~/.claude/skills/proteus*` links, `~/.claude/agents/proteus-*.md`, `autoUpdate` in `~/.claude/proteus.json`) is removed in the same run once every repo found is on the plugin. Until then it stays, since it still serves the rest, and the summary prints the command that removes it:

```bash
node <plugin dir>/install.js --remove-user-install --dry-run   # see what goes
node <plugin dir>/install.js --remove-user-install
```

It removes the skill links and the unedited agents, and drops `autoUpdate`. It keeps edited agents and a real directory where a link was, and names them. It refuses while `proteus@proteus` is not installed. Your 1.x checkout stays on disk; delete it once nothing points at it. `--doctor` then checks the plugin setup instead: the gate, the marketplace entry, 1.x copies left beside the plugin (`--doctor --fix` removes the unedited ones), and the release check's last result. A user already on the plugin with nothing to move sees no output.

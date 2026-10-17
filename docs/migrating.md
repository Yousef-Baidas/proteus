# Migrating

## Moving from 1.x

A 1.x install put copies in each repo and in `~/.claude`; the plugin brings its own, so those copies have to go or they run twice. Install the plugin ([install.md](install.md)), then run `/proteus:setup` in each repo. It removes the repo's 1.x pieces that are unedited, meaning byte-identical to a file some release shipped:

- the `.claude/hooks/` scripts, with their entries (and the 1.x status line) in `.claude/settings.json` and `.claude/settings.local.json`; other keys stay
- the `.claude/agents/proteus-*.md` copies
- their lines in `.git/info/exclude`

An edited copy stays and is named, along with the reason. So does a copy git tracks (delete it in a commit) and a hook `lefthook.yml` or `proteus-gates.yml` runs (point the gate at `teams/templates/hooks/commit-msg.js` first). An edited hook still runs beside the plugin's until you delete it. `/proteus:setup --dry-run` lists all of it first and writes nothing.

The user-level install (the `~/.claude/skills/proteus*` links, `~/.claude/agents/proteus-*.md`, `autoUpdate` in `~/.claude/proteus.json`) may still serve repos you have not moved, so setup only lists it and prints the command that removes it, with the plugin's path:

```bash
node <plugin dir>/install.js --remove-user-install --dry-run   # see what goes
node <plugin dir>/install.js --remove-user-install
```

It removes the skill links and the unedited agents, and drops `autoUpdate`. It keeps edited agents and a real directory where a link was, and names them. It refuses while `proteus@proteus` is not installed. Your 1.x checkout stays on disk; delete it once nothing points at it. `--doctor` then checks the plugin setup instead: the gate, the marketplace entry, 1.x copies left beside the plugin (`--doctor --fix` removes the unedited ones), and the release check's last result.

## Coming from hivemind

Proteus was called hivemind. Install Proteus ([install.md](install.md)), or run `install.js --update` in your hivemind checkout (it pulls Proteus and runs the new installer); either way the install takes over:

- It removes hivemind's skill links (`~/.claude/skills/hivemind*`, `~/.agents/skills/hivemind*`), its generated agents (`~/.claude/agents/hive-*.md`, `$CODEX_HOME/agents/hive-*.toml`), and merges `~/.claude/hivemind.json` into `proteus.json`. An agent you edited, or a real directory where a link was, stays and is named in the output.
- With `--project` it moves the current repo: removes the `hive-*.js` hooks and their entries in `.claude/settings.local.json` and `.codex/hooks.json`, hivemind's status line, `.codex/rules/hivemind.rules`, and the unedited `teams/templates/hooks/hive-*.js` copies (commit that), renames the lines in `.git/info/exclude`, then installs Proteus for every CLI hivemind was set up for there.
- It lists the other repos under `~/Projects` (`--scan <dir>` for elsewhere, three levels deep) still on hivemind, with the command for each; `--migrate-all` moves them all.

- It moves hivemind's state, `.git/hive/`, into `.git/proteus/` (the inbox, scratch, the lead journal, the lead model). The session start does the same on its own, so a repo you never re-run the installer in still moves. Nothing already in `.git/proteus/` is overwritten. The append-only logs (`journal.jsonl`, `scratch-ledger.jsonl`) on both sides merge: the old lines first, then the new ones, each line once; a merged log keeps its newest 8 MB, and a first line saying older lines were dropped marks one that was cut. A FIFO, socket or device is never moved and is named as such. Any other file on both sides stays in `.git/hive/` (the `.git/proteus/` copy is the one in use), and so does a worktree git still has registered there; the output names each, and `--doctor` keeps showing them until they are gone. In a Codex repo the session start also keeps `../<repo>-proteus` in `writable_roots` while an older run still has worktrees there (adding it back if lost) and drops it once none is left, or names `install.js --update` when it cannot; a repo with no such worktrees gets no entry.

A run opened under hivemind finishes under its old names: the lead, `--status`, scratch and the lead guard read both `hive/<run>` and `proteus/<run>`, so an open `hive/<run>` still counts as the run and its PRs, labels and log issue are still found. New runs use the Proteus names. With Codex, `--project` keeps `../<repo>-hive/` (like an older run's `../<repo>-proteus/`) in `writable_roots` while git still has a worktree registered there, says why, and drops it on the first `--project` after the last one is gone. The tracker's label step creates the `proteus*` labels in a repo that only has the `hive*` ones and records `labels: proteus`.

Kept as they were: the `hive/<run>` and `hive-evidence/<run>` branches, the `hive*` GitHub labels, and `hive-gates.yml`. A worker worktree already in flight keeps hivemind's hooks until it merges, and the old lines in `.git/info/exclude` stay beside the new ones until then; `--doctor --fix` drops them after. There is no `/hivemind` alias and no `HIVEMIND=0`: use `/proteus` and `PROTEUS=0`.

---
name: setup
description: Set up the current repo for the Proteus plugin, then move every other repo still on a 1.x install. Enables the plugin for this project in .claude/settings.json, copies teams/, and prints the GitHub steps left to run.
disable-model-invocation: true
---

First ask once, in plain words at the human's level (the proteus skill's `references/audience.md`): should this project live on a code host, or stay only on this machine? Where a remote exists, recommend the host. Use `--local` only if they choose this machine: run the command below with `--local --dry-run`, which changes nothing, show the warning it prints as it is, confirm, then run it with `--local`. After that skip every host step below. If it says it cannot write here, the human runs it in their own terminal.

Run this one command from the repo (later, only `--doctor` beside it):

```
node "${CLAUDE_PLUGIN_ROOT}/install.js" --plugin-setup
```

Show its output as it is. If it refused (a settings file that is not valid JSON, or no git repo), say what it named and stop; do not edit the file yourself. If it printed next steps, the GitHub ones (`--agent-login`, `--protect`, `--verifier-app`) are the human's to run, never yours. Ask once whether they have used GitHub before. Yes → list the steps. No or unsure → walk `${CLAUDE_PLUGIN_ROOT}/docs/setup-walkthrough.md` one step at a time: suggest they type `! <command>` so its output lands here, then run `node "${CLAUDE_PLUGIN_ROOT}/install.js" --doctor` and confirm the step's row before the next. Then tell them to commit `.claude/settings.json` and `teams/` and start a new session, where `/proteus:proteus` bootstraps the rest. If it went guest mode (a `guest ->` line), there is nothing to commit, as its output says; just start a new session.

After this repo, the command moves every other repo still on a 1.x install that it finds (docs/migrating.md) and prints one summary. Show that too; a repo it skipped or a file it left is the human's to handle. If it stopped because gh is not logged in or offline, say so: nothing changed.

`--local` covers this repo only: no other repo is moved, so there is no summary.

If the human passed `--local`, `--dry-run`, `--only-here` (this repo only), `--scan <dir>` (also look under dir), `--guest [dir]` (keep Proteus's files outside the repo) or `--no-guest` (install into the repo even where gh reports read-only access), append them to the same command as given.

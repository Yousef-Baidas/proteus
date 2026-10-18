---
name: setup
description: Set up the current repo for the Proteus plugin, then move every other repo still on a 1.x install. Enables the plugin for this project in .claude/settings.json, copies teams/, and prints the GitHub steps left to run.
disable-model-invocation: true
---

Run this one command from the repo, and nothing else:

```
node "${CLAUDE_PLUGIN_ROOT}/install.js" --plugin-setup
```

Show its output as it is. If it refused (a settings file that is not valid JSON, or no git repo), say what it named and stop; do not edit the file yourself. If it printed next steps, list them for the human: the GitHub ones (`--protect`, `--verifier-app`) are theirs to run, never yours. Then tell them to commit `.claude/settings.json` and `teams/` and start a new session, where `/proteus:proteus` bootstraps the rest. If it went guest mode (a `guest ->` line: gh reports read-only access, or `--guest`), there is nothing to commit: `teams/` is in the guest dir it named and the plugin is on through `.claude/settings.local.json`; just start a new session.

After this repo, the command moves every other repo still on a 1.x install that it finds (docs/migrating.md) and prints one summary. Show that too; a repo it skipped or a file it left is the human's to handle. If it stopped because gh is not logged in or offline, say so: nothing changed.

If the human passed `--dry-run`, `--only-here` (this repo only), `--scan <dir>` (also look under dir), `--guest [dir]` (keep Proteus's files outside the repo) or `--no-guest` (install into the repo even where gh reports read-only access), append them to the same command as given: `--dry-run` writes nothing and prints what it would change.

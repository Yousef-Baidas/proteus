---
name: setup
description: Set up the current repo for the Proteus plugin. Enables the plugin for this project in .claude/settings.json, copies teams/, and prints the GitHub steps left to run.
disable-model-invocation: true
---

Run this one command from the repo, and nothing else:

```
node "${CLAUDE_PLUGIN_ROOT}/install.js" --plugin-setup
```

Show its output as it is. If it refused (a settings file that is not valid JSON, or no git repo), say what it named and stop; do not edit the file yourself. If it printed next steps, list them for the human: the GitHub ones (`--protect`, `--verifier-app`) are theirs to run, never yours. Then tell them to commit `.claude/settings.json` and `teams/` and start a new session, where `/proteus:proteus` bootstraps the rest.

If the human passed `--dry-run`, run the same command with `--dry-run` appended: it writes nothing and prints what it would change.

### Changed

- Under the Claude Code plugin the hooks name the command `/proteus:proteus` (and `/proteus:proteus-review`), and
  the autostart adds `agent-prefix=proteus:` to `proteus-state`; on Codex they name `$proteus`. New
  `lib.skillCommand()` and `lib.agentPrefix()` compute both (#136).
- Under the plugin the autostart applies no agent patches: `.claude/proteus-agents.json` would write bare-named
  copies beside the plugin's `proteus:` agents, so a note says it is not applied (#136).

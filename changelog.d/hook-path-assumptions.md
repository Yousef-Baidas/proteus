### Changed

- The hooks no longer assume they sit in `<repo>/.claude/hooks`, as prep for shipping Proteus as a plugin
  (#136). The inbox, the status line and `proteus-worktree.js` find the session's repo from the cwd or
  `CLAUDE_PROJECT_DIR` (its git root), and only then from their own folder; the Codex adapter falls back to
  the cwd's git root outside `<root>/.codex/hooks`. Harness detection reads Claude Code's
  `CLAUDE_PROJECT_DIR` (and `CLAUDE_PLUGIN_ROOT` alone as Codex) when the hooks' folder names no CLI.
  The Claude adapter also looks for the skill in `$CLAUDE_PLUGIN_ROOT/skills/proteus`.

### Fixed

- `CLAUDE_CONFIG_DIR` is honoured: `proteus.json`, the user's `settings.json`, skills, agents and the
  context-mode check are read and written there, by the hooks and by `install.js`, instead of always
  `~/.claude`. The guards protect it like `~/.claude`, and a custom `CODEX_HOME` too.

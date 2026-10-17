### Added

- The repo is a Claude Code plugin and its own marketplace (#136): `.claude-plugin/plugin.json` (`proteus`) points at
  `skills/`, every `agents/*.md` and `hooks/hooks.json`, and `.claude-plugin/marketplace.json` (`proteus`) lists it
  from the repo root. `hooks/hooks.json` holds the same events, matchers and timeouts `install.js` registers,
  generated from the Claude adapter's `LEAD_HOOKS` by `node scripts/plugin-hooks.js`; each hook runs through
  `templates/hooks/proteus-plugin.js`.

### Security

- The guards protect the plugin's own folder (`CLAUDE_PLUGIN_ROOT`) like `.claude/hooks`: a subagent's write or
  `rm -r` into it is refused, and `proteus-shell-check.js` reports a change to it. A plugin read from a checkout of
  the session's own repo is left editable.

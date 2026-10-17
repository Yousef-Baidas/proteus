### Added

- Moving from 1.x (#136): `install.js --plugin-setup` removes a repo's 1.x install when its copies are unedited
  (byte-identical to a file a release shipped, the rule the hivemind takeover uses): the `.claude/hooks` scripts and
  their entries in `.claude/settings.json` and `settings.local.json`, the `.claude/agents/proteus-*.md` copies, and the
  hook lines in `.git/info/exclude`. An edited, git-tracked or gate-run copy stays and is named. Other settings keys
  stay; `--dry-run` writes nothing.
- `install.js --remove-user-install [--dry-run]`: once the plugin is installed, removes the 1.x user install (the skill
  links, the unedited `proteus-*.md` agents in the config dir, `autoUpdate` in `proteus.json`); edited agents stay and
  are named. `--plugin-setup` never touches it; it lists what it found and prints this command.
- `--doctor` reads a plugin setup: the gate and marketplace entries, 1.x copies left beside the plugin (`--fix`
  removes the unedited ones), a user install still present, and the release check's last result for the installed
  commit. The 1.x rows (skill links, global agents, lead hooks, agent patches) are skipped there.

### Changed

- The hivemind stub skill moved from `skills/hivemind/` to `legacy/hivemind/`, so the plugin no longer ships it.

### Fixed

- Under the plugin, the session start no longer syncs hooks and agents from the 1.x checkout `proteus.json` names;
  those copies would have run beside the plugin's.

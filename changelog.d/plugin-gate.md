### Added

- The plugin's per-repo gate (#136): a plugin is enabled in every repo, so `proteus-plugin.js` runs a hook only
  where the project's git root (of `CLAUDE_PROJECT_DIR`, else the cwd) has `.claude/settings.json` with
  `enabledPlugins["proteus@proteus"]` set to `true`. Anywhere else, and on a missing or malformed settings file,
  the hook exits 0 without reading its input, printing or writing state. `install.js` installs are not gated.

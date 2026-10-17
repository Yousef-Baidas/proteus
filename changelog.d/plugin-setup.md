### Added

- `/proteus:setup` (#136): the plugin's setup skill runs `install.js --plugin-setup`, the project steps of `--project`
  only. It enables `proteus@proteus` in the committed `.claude/settings.json` (the plugin's per-repo gate) and lists
  the `proteus` marketplace there, so teammates who trust the repo are offered the plugin; other keys stay. It turns
  attribution off as `--project` does, adds the statusLine to `.claude/settings.local.json` when none is set, and
  copies `teams/`; no hooks or agents go into the repo. The GitHub steps (`--protect`, `--verifier-app`) are printed,
  never run. Re-running changes nothing, a malformed settings file is refused before anything is written, and
  `--dry-run` says what it would do and writes nothing.

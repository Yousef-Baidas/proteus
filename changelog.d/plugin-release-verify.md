### Added

- The plugin's release check (#136): under the plugin, the session start no longer auto-updates a Proteus checkout
  (the plugin manager owns updates). Instead it checks that the installed commit (`gitCommitSha` of
  `proteus@proteus` in `installed_plugins.json`) is a `vX.Y.Z` tag signed by a key you trust, using the same
  `git verify-tag` checks as `--update`, against a bare clone in `CLAUDE_PLUGIN_DATA/releases.git` that fetches
  tags at most once a day and trusts `~/.config/proteus/allowed_signers`. A verified commit prints nothing; any
  other gets one warning line with the newest verified tag and how to pin to it; a failed fetch gets one quiet
  line and the last result. It never blocks.

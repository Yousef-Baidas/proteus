### Added

- One action moves a 1.x user to the plugin, in every repo (#155). `install.js --update` and 1.x `autoUpdate` install `proteus@proteus` at user scope through the `claude` CLI, pinned to the verified release, then run the new `install.js --migrate`. `/proteus:setup` sets up the current repo, then moves every other 1.x repo (`--only-here` stops after it). The plugin's SessionStart moves a 1.x repo the first time it is opened and prints one line.
- Repos are found only from the `repos` list in `proteus.json`, the `.claude.json` projects (`CLAUDE_CONFIG_DIR` aware), Codex `config.toml` projects and repeatable `--scan <dir>` (three levels deep, no default). A path is kept only if it answers within a timeout, is a main checkout inside the home (never the home itself), is writable and still has 1.x copies; the same repo reached twice counts once.
- A move never commits, pushes or touches a remote, and keeps every edited file. Shared repos (another GitHub owner, no GitHub origin, or a tracked Proteus file someone else changed) get only untracked files touched, with the authors named. A repo with a run in flight is skipped. Offline or with `gh` logged out nothing changes. One summary lists the GitHub steps left (`--protect`, `--verifier-app`, or the owner's name), and the 1.x user install is removed once every repo found is on the plugin.

### Changed

- The release check keeps one result per installed commit, so repos pinned at user and project scope to different releases each show their own.
- `--scan` is repeatable and has no default folder; `--migrate-all` (hivemind) uses the same repo sources.

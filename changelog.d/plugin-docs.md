### Upgrading to 2.0.0

- Proteus 2.0.0 is a Claude Code plugin. Install it pinned to the release tag, then set up each repo from a session
  in it:

  ```bash
  claude plugin marketplace add Yousef-Baidas/proteus#v2.0.0
  claude plugin install proteus@proteus
  ```

  then `/proteus:setup` (`--dry-run` first shows what it changes). The command is `/proteus:proteus`.
- On a 1.x install, `/proteus:setup` removes the repo's unedited 1.x hook and agent copies, their settings entries and
  exclude lines, and names any edited copy it keeps. The user-level install is listed, never touched: once no repo
  still runs 1.x, remove it with the `install.js --remove-user-install` command setup prints. README "Moving from 1.x".
- To move the pin to a newer release, re-add the marketplace at its tag. Remove the user settings' entry first, or
  the re-add fails: `claude plugin marketplace remove proteus --scope user && claude plugin marketplace add
  Yousef-Baidas/proteus#vX.Y.Z && claude plugin install proteus@proteus && claude plugin update proteus@proteus`.
- Codex CLI keeps the installer path (`install.js --harness codex`), unchanged.

### Changed

- README leads with the plugin install, pinned to a tag; the installer path stays documented for Codex, and a new
  "Moving from 1.x" section covers the migration.

### Fixed

- The release check's pin command works: `claude plugin marketplace add <repo>#<tag>` alone fails while the user
  settings name the marketplace, so the printed line now removes that entry first (when present), then adds,
  installs and updates. `--doctor` prints the same line.

### Added

- `install.js --export <owner/repo>` (`-Export` in `install.ps1`) moves a local-mode repo to an existing, empty repo on
  a code host (#310): branches and tags, labels, issues and pull requests, then `origin` and the local-mode marker.
  Without `--yes` it only prints the plan. A map in lead state lets a rerun resume with no duplicates, every exported
  body opens with a header so no verdict crosses, and mentions and closing keywords are neutralised. See
  `docs/local-mode.md`.

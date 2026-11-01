### Fixed

- Local mode: on a default branch with no gate line, a PR that changes only root `AGENTS.md` and adds one passes its check with nothing run, so a fresh project can set its first gate without touching the origin by hand.

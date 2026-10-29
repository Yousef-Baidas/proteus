### Added

- `proteus-container.js` runs one worker session in a container that never sees the host's `.git` (#80).
  `run` bundles the worktree's branch in and starts the image (`build`: node:22-slim, git, Claude Code) with
  every capability dropped, a read-only root, the `node` user, caps on pids, memory and cpu, and the credential
  passed by name. The worker runs `claude -p` with `bypassPermissions`. Only a bundle comes back, read with the
  pinned git: it is fetched into one fixed ref, refused unless it descends from the old tip and every changed path
  is owned, and the branch moves by `update-ref`. `doctor` checks the runtime, rootless mode, the image and the
  credential. Sandcastle is not used: it mounts the host `.git` read-write. See `docs/container.md`.

### Security

- A worker's shell is confined to its owned paths and scratch dir on both routes, the lead guard for in-process workers and the worktree's worker guard (#48). Redirects, `tee`, in-place editors and `cp`/`mv`/`install`/`ln`/`rsync`/`dd`/`truncate`/`touch`/`rm` outside them are refused, as are targets built at runtime (`$VAR`, `$(...)`); heredocs and scripts piped to a shell are judged. Inline `python -c`, `node -e`, `perl -e` and `ruby -e` code naming a guarded path or a path outside the worktree is refused. A command the guard cannot judge within 50 ms is refused with "command too complex to judge; split it". `$CLAUDE_CONFIG_DIR` and `$CODEX_HOME` are guarded paths in every agent's shell.

### Added

- `proteus-worktree.js <wt> --allow force-push`: the lead allows one force-push by that worktree's worker; the first one the guard lets through consumes it.

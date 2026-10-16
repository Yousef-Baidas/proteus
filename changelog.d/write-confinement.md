### Changed

- `install.js`, `teams/link-skills.js` and `install-lead-hooks.js` share one write and delete guard,
  `proteus-confine.js` (in `templates/hooks/`; `--project` copies it beside `teams/link-skills.js`). A path is
  removed or written only under a root its caller owns with no link between the root and the path, and only
  when it is the kind expected: a link, a regular file, or (for `install.js`) a directory.
  `install.js` now also refuses a link below one of its roots (it followed one that stayed inside), a FIFO,
  socket or device, and a file `--project` cannot copy stops the run with the path to move.
- `install-lead-hooks.js`, refusing a linked `.claude` or `.claude/hooks`, names the link and says to replace
  it with a real directory and re-run.

### Removed

- `PROTEUS_KEEP_SKIPPED`: `install-lead-hooks.js` always removes the hook files its CLI skips, through the
  shared guard, and `install.js` no longer removes them first.

### Fixed

- A state migration that leaves a FIFO, socket or device behind no longer says the next `--project`
  retries it; its reason already says to delete or move it by hand.

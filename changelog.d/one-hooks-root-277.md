### Fixed

- One hooks dir per session (#277): the autostart records the realpath of the dir it runs from in
  `<git-common-dir>/proteus-lead/hooks-root` and names it as `hooks=<dir>` on the `proteus-state` line.
  `proteus-signoff.js`, `proteus-verdict.js`, `proteus-merge.js` and `proteus-gh.js` refuse to run from any
  other copy (the project's `teams/templates/hooks`, a stale plugin cache) and name the session's. With no
  record (CI, no session) nothing is checked. Briefs pass that path literally; agents never pick a copy.

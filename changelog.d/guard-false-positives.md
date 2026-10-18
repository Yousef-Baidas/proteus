### Fixed

- The shell check no longer reports Claude Code's own `.in_use` markers in the plugin cache as changes an agent
  made; a change to a plugin file in the same cache is still reported.
- The verdict guard and the `--post` gate judge what a command runs, with the shell parser, instead of the text it
  carries: a heredoc that edits a doc, a commit message or a grep that names a verdict post now passes, while every
  real post (including a body on stdin, `gh api` body fields and a nested `sh -c`) and anything the parser cannot
  judge (eval, `sh -c` with a non-literal script, xargs into gh, a substituted program) is still refused.
- `tests/knownblobs.test.js` fails only for versions this branch superseded and warns about versions other merged
  PRs superseded; `changelog.js --release` now regenerates `scripts/known-blobs.json`.

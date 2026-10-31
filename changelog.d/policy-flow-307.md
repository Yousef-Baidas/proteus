### Added

- The policy reaches the loop (#307): `proteus-cli.js next` and `proteus-merge.js` hold a green PR for the human
  under `merge: human` (`ASK human merge PR#<n> <url>`), `ask: every` (`ASK human PR#<n> <url>`) and `ask: risky`
  for a PR whose changed paths an `ask` rule covers (`... policy:<id>`), until the human's newest verdict comment
  on the PR is `ACCEPT <sha12>` for its current head (the ASK line ends `reply: ACCEPT <sha12>`); a bare `ACCEPT`
  or another head's sha holds. `ask: never` changes nothing. `proteus-verdict.js <n> --post` takes a pull request
  too, refusing an `ACCEPT` for any head but the current one. The merge batch pins each merge to the head it checked
  (`--match-head-commit`); a head pushed since waits a round, held as "head moved". Bootstrap gains a short policy step (presets, what
  cannot be undone, drafted rules, the rendered policy, `proteus-policy.js write`). `install.js --doctor` has a
  policy row with the preset, merge and ask and where each comes from, warning on an ignored file, and the status
  line names the preset.

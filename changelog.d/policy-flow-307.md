### Added

- The policy reaches the loop (#307): `proteus-cli.js next` and `proteus-merge.js` hold a green PR for the human
  under `merge: human` (`ASK human merge PR#<n> <url>`), `ask: every` (`ASK human PR#<n> <url>`) and `ask: risky`
  for a PR whose changed paths an `ask` rule covers (`... policy:<id>`), until the human's newest verdict comment
  on the PR opens with `ACCEPT`; `ask: never` changes nothing. Bootstrap gains a short policy step (presets, what
  cannot be undone, drafted rules, the rendered policy, `proteus-policy.js write`). `install.js --doctor` has a
  policy row with the preset, merge and ask and where each comes from, warning on an ignored file, and the status
  line names the preset.

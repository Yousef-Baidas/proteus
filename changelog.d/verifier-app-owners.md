### Fixed

- The verifier App now keeps one installation per repo owner (`verifierApp.installations` in
  `~/.claude/proteus.json`). An installation belongs to one account or org, so before, repos under a second
  owner (your account and an org) got a token request against the first owner's installation, which GitHub
  refuses with HTTP 422 and every signoff there failed with no hint. `--verifier-app` run in a repo of another
  owner adds that owner and keeps the rest; a signoff picks the repo owner's installation and, when there is
  none, fails naming `--verifier-app`; `--doctor` checks the current repo's owner and `--protect` warns when it
  has none. An older config's lone `installationId` keeps working and moves into the map on the next
  `--verifier-app`.

### Changed

- README: the Verifier App steps follow GitHub's current settings layout (the private key under Credentials >
  Key pairs, the App ID on the General tab, Install App with "Only select repositories"), and the Codex
  `writable_roots` text says a new repo gets no entry: `../<repo>-proteus/` stays only while an older run
  still has worktrees there.

### Security

- The verifiers can sign off as a GitHub App of their own (#81). `install.js --verifier-app <appId> <keyPath>`
  records an App that has only "Commit statuses: write" and its private key; `proteus-signoff.js` then posts
  `proteus/verdict` and `proteus/security` with a short-lived installation token of the App (in the `gh`
  call's environment only, never on disk or a command line), and `--protect` pins those two statuses to the
  App's id, so a status posted with the agents' shared login no longer counts. A signoff whose token does not
  mint fails with the reason; it never falls back to the agents' login. With the App, a verifier's `MERGE`
  also carries CI's no-security-path `proteus/security` over as the App's, after checking the PR's files
  against the base's security block itself. `--doctor` checks the key, a token and the pinned ruleset.
- The guards refuse every agent, the lead included, reading, editing or naming the App's key, and any agent
  shell that sets `GH_TOKEN` or `GITHUB_TOKEN`; `proteus-shell-check.js` fingerprints the key. A worker's
  session refuses `proteus-signoff.js` whatever the agent is called, and the lead guard refuses it from an
  unnamed subagent whose brief names a worktree. The worker guard now also sees `Read` and edit tools.

### Fixed

- A session with no `proteus-state` line no longer leads to a hand-run `proteus-autostart.js` (#267). The plugin's
  hooks stay silent in a repo that is not set up, and a hand run has no `CLAUDE_ENV_FILE`, so agents would post to
  GitHub as the human. The skill now tells the lead to send the human to `/proteus:setup` and a new session, then
  stop.

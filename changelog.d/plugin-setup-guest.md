### Fixed

- `/proteus:setup` (`install.js --plugin-setup`) now makes the same guest-mode decision as `--project` (#173): on
  a repo where gh reports READ or TRIAGE access and there is no `teams/`, or with `--guest [dir]`, `teams/` goes to
  the guest dir and the plugin's gate, status line and the guest dir go in the untracked
  `.claude/settings.local.json`. The checkout gets no `teams/` and no `.claude/settings.json`; `--no-guest` installs
  into the repo. `--doctor` reports such a setup as healthy, and `--dry-run` says which way it would go.

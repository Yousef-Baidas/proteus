### Fixed

- Moving the user's other 1.x repos to the plugin (`--plugin-setup`, `--migrate`, the SessionStart move) now keeps a
  repo's guest mode (#184). The move runs the same guest-aware setup as `--plugin-setup` in that repo: the gate and
  status line stay in `.claude/settings.local.json`, the status line points at the guest dir's copy, teams/ stays in
  the guest dir and nothing is written into the checkout.

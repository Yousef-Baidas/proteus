### Added

- A security pass per milestone and an audit at close (#200), `enforcement.md` §10b: the QA milestone pass also
  spawns `proteus-security-verifier` in `milestone` mode on the milestone diff (authorization on every new route,
  input reaching I/O, the threat model's abuse cases), and close runs it in `close` mode over the whole repo with
  the scout-picked audit skill. Blockers become `WAVE-RED` tickets as in §10; the lead's instructions hold the
  gate, as for §10, and no hook enforces it yet. A run with no security-routed path skips both and logs
  `security-pass: skipped (no security path)`.

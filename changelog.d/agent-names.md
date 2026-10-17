### Changed

- The guards match agent names through one helper, `lib.agentName`, which also accepts the
  `proteus:` namespace a Claude Code plugin gives its agents (#136): `proteus:proteus-verifier`
  signs off, `proteus:proteus-worker` spawns are lock-checked and beat, `proteus:proteus-scout`
  writes `teams/*/skills.txt`. Any other namespace (`evil:proteus-verifier`) counts as no
  Proteus agent. Bare names behave as before.

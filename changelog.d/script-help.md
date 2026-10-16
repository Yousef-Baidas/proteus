### Fixed

- `proteus-gates-cache.js --help` no longer runs `--help` as a shell command, `proteus-skillpath.js --help` no
  longer looks for a skill named `--help`, and `proteus-inbox.js --help` no longer lists the inbox. Each prints
  its usage and exits 0 without side effects, and the usage errors of the first two point to `--help`.

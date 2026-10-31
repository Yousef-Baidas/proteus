### Added

- A static skill scanner, `proteus-skill-scan.js <skill dir>` (#10): it reads a third-party skill as data, runs
  and follows nothing (a symlink is itself a finding), and prints one `FINDING` line per non-markdown file,
  runnable code block, hook or settings file, URL off the host allowlist (github only under `--owner`, docs
  hosts, `teams/skill-hosts.txt`), injection phrase or invisible character, missing OSI license and shipped
  dependency manifest, then `CLEAN` (exit 0) or `FINDINGS <n>` (exit 1). Its first line carries the skills
  lock's hash; `--json` prints one object for the scout; `--osv` runs osv-scanner on the skill's lockfiles with
  the same args CI's scan job uses, now shared in `proteus-lib.js`.

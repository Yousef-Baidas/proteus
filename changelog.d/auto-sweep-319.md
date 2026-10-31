### Changed

- Scratch no longer waits for the lead to sweep it (#319): `proteus-cli.js next` runs
  `proteus-scratch.js --sweep --all-done` and `--stale` at most once an hour, printing `SWEPT <count> <MB> MB`
  when something went and one `NOTE` line when the sweep failed. `--stale` also clears top-level entries of the
  sandbox temp root idle 72 hours, and `--size` and the `--doctor` row count that root.

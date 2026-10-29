### Added

- `--doctor` times `lefthook run pre-commit` with nothing staged and warns above 3 s, suggesting the slow
  checks move to pre-push or CI (#207). It says skipped when there is no lefthook or lefthook config.

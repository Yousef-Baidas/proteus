### Fixed

- `proteus-trust.yml` now runs (#276). GitHub reads a `pull_request_target` workflow from the default branch only,
  so the copy the scaffold put on the run branch never ran and no PR into `proteus/*` got CI's `proteus/security`.
  `install.js --protect` now puts the template on the default branch through a PR from `proteus-setup/trust` for
  the admin to merge (an open one is reused, a matching copy is left alone), and `--doctor` warns while that copy
  is missing or differs. Both jobs run only for PRs whose base is `proteus/*`, so PRs into the default branch are
  untouched. The scaffold no longer copies the file. Run `--protect` again in each repo and merge its PR.

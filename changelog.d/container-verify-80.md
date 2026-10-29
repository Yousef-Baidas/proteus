### Added

- A cap on containers (#80): `proteus-container.js run` and `check` each hold a slot under
  `<git-common-dir>/proteus-lead/containers/` while their container runs. AGENTS.md `containers: <n>` sets how
  many (default 2, clamped to 1..8); a slot whose pid is dead is reclaimed, and with none free the runner waits up to
  `--queue-timeout <min>` (default 30).
- Under `isolation: container` the verifier runs none of the branch's code on the host (#80): it replies `CHECKS:`
  with its gate and test commands, the lead runs each as a container check and sends back the `CHECK` lines and log
  paths. The lead guard refuses a verifier's shell call that runs a gate or test; reads such as `git diff` pass.

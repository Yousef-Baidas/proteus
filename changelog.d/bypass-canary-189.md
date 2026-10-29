### Added

- `proteus-state` shows `sandbox=on|off|unavailable` (#189), from the settings the session was launched with
  (`claude --settings`, then the repo's and the user's) and the platform (native Windows, or Linux without `bwrap`
  or `socat`, has none). The autostart stores it per session under `proteus-lead`, where agents cannot write.
- Under `bypassPermissions`, the lead guard refuses worker and verifier spawns and `proteus-container.js run`
  unless the session's sandbox is on, and names the sandbox profile's launch command.
- `--doctor` checks for `bwrap` and `socat` on Linux, and warns when one is missing only once the repo has a
  sandbox profile (`--sandbox`).
- `tests/canary.test.js`: with `PROTEUS_CANARY=1` and `claude` on PATH, a throwaway project under
  `claude -p --permission-mode bypassPermissions` proves the guards still refuse the lead and a subagent;
  skipped otherwise, so CI never spends tokens on it.

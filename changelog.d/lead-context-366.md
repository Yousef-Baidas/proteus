### Changed

- The lead's context stays smaller (#366). Worker and verifier agent files now end with `Report once`,
  which caps the hand-back at 10 lines: the status line first, then the tracker link or file path that holds
  the full report. `proteus-stall.js` sends back a longer hand-back once, both on `SubagentStop` and on
  `PreToolUse` of the `SubagentHandback` tool. When `drive` has more than three `DID` lines, it writes them to
  `<scratch>/drive.txt` and prints one count line that names the file. The `MERGED` and failed `DID` lines are
  still printed.
- Compaction is expected now; the lead no longer hands off to a new session (#356). Setup (`--plugin-setup`
  and `install-lead-hooks.js`) sets `autoCompactWindow` to 200000 in `.claude/settings.local.json` unless a
  window is already set in the env or in any settings file. The meter and the lead guard's context refusal now
  tell the lead to log its position and let the session compact, and no longer say `/handoff`.
- `SKILL.md` no longer has the lead read references up front. Each flow step names the one reference to read
  when that step starts.

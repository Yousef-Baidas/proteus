### Added

- An optional run panel for Claude Code, the `proteus-panel` mod (#311): `/plugin install proteus-panel@proteus`,
  then `/proteus-panel` opens a pane with the run, the current milestone and its progress, the open PRs, and a card
  for each question or milestone review waiting on the human, plus a status line entry with the run and that count.
  Display only: no approve, merge or post control, no hook on tool calls or permissions, no file writes or network;
  its one process is `proteus-status.js --json`. Docs: `docs/run-panel.md`.
- `proteus-status.js --json` (#311): one JSON object with the text line's facts plus the open questions and pending
  milestone reviews (number, title, url); no run and an unreachable tracker are states of their own.

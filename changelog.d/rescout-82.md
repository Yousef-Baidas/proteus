### Added

- The close report suggests re-scouting the teams (#82): one `SUGGEST re-scout:` line per routing miss group
  (tickets with no `profile:` label), per team holding over half of a run of 6+ tickets, and per team of 3+
  tickets bouncing over 40% `BACK-TO-WORKER` per ticket. The lead then offers "redesign teams" in the close PR.

### Changed

- The scout may pick zero skills for a team (#82). An empty or comment-only `skills.txt` links nothing, still
  writes `teams/skills-lock.json`, and no longer shows the team under `skills-unlinked`.

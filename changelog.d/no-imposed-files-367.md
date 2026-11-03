### Changed

- Proteus no longer puts its process files in the product tree by default (#367). `install.js --project` writes
  `teams/ROUTING.md`, the link scripts and `teams/templates/`, but no team folder: hooks, agents and the installer
  read a team's `PROFILE.md`, `CRAFT.md` and lists from Proteus unless the repo has its own
  `teams/<team>/PROFILE.md` (an opt-in eject), through one helper in `proteus-lib.js`. Agents find the folder with
  `proteus-cli.js team <team>`. Skill links stay machine-local under `teams/<team>/`, git-ignored.
- anti-slop is opt-in: bootstrap no longer installs it, and planning offers it once, naming the dev dependencies
  and config files it adds.
- Bootstrap asks once, at planning, which files Proteus may add to the repo and records the answer as
  `repo-files:` under `## Learned`; scaffolding, CI and lefthook follow it.

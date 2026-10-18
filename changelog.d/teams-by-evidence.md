### Changed

- Setup picks the shipped software teams from evidence (#156): `install.js --project` and `--plugin-setup` copy `security` and `qa` always, `devops` in a repo with a git remote, CI, containers or infrastructure code, and `frontend` and `backend` only when the repo's manifests or tracked files show a UI or a server. A repo with no code yet gets `security`, `qa` and `devops`, and the scaffold ticket adds the teams the chosen stack needs. `ROUTING.md` is written without the rows of the teams left out, and setup prints one line per team it left out with the reason. The signals are one table in `references/teams.md`; the scan uses `git ls-files` and manifests only, and past its 5 s cap keeps every team and says so.
- `install.js --doctor` warns about a shipped team that fits nothing in the repo (no evidence and no `ROUTING.md` row matching a tracked file) and prints the command that removes it.

### Fixed

- A refresh (`--project` or `--plugin-setup` on a repo that already has a roster) no longer copies back a shipped team the roster left out; it only refreshes the team dirs the repo has (#156).

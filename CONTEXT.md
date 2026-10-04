# Context

Proteus is a multi-agent build pipeline that installs into a coding-agent CLI (the harness) as a skill, agent definitions, and hooks. This repo is its source.

## Terms

- **lead**: the one session that plans, writes contracts, dispatches, and merges; it never edits deliverables itself, and `proteus-lead-guard` enforces that.
- **worker**: a subagent given one ticket, its own worktree, owned paths, and a contract; it implements, retries at most twice, and reports once.
- **verifier**: a fresh-context subagent that never edits; it checks a diff against the ticket's contract and the team checklist and answers `MERGE`, `BACK-TO-WORKER`, or `CONTRACT-WRONG`.
- **team**: a set of real-world roles with owned paths, checks, and routing (`teams/<team>/`); workers and verifiers are spawned per team.
- **ticket**: one tracker issue for one team, tagged with difficulty and profile, carrying owned paths and a contract; it ships as one PR into the run branch.
- **contract**: the interface (exported signatures or deliverable shape) plus a one-sentence check, committed as stubs and shown red twice before dispatch.
- **wave**: tickets that run in parallel; after a wave merges, `proteus-qa-verifier` answers `WAVE-GREEN` or `WAVE-RED`.
- **milestone**: waves that add up to one user-visible result; it ends at a QA gate and a human review.
- **run**: one pipeline execution on a run branch, ending in a PR to `main` that the human merges.
- **harness**: the coding-agent CLI Proteus runs inside (Claude Code, Codex; pi, Gemini, local researched in `docs/harnesses/`), picked by `PROTEUS_HARNESS` or by the folder the hooks live in.
- **adapter**: one `templates/hooks/proteus-harness-<harness>.js` that turns the harness's hook payload into a Proteus event and answers back (`deny`, `context`, `keepGoing`), plus its install-side hooks (skill dirs, agent format, `registerLead`, `prepareWorker`); the shared hooks never read harness JSON.
- **ladder**: the ordered model list per harness with a floor (Claude: haiku < sonnet < opus < fable, floor sonnet); the role tiers `judge`, `build` and `helper` are picked from it relative to the lead.
- **self-host**: Proteus running its own pipeline on this repo, where the project and the Proteus checkout are the same directory.

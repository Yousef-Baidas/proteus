# Teams

A team is a folder `teams/<team>/` holding `PROFILE.md` (role, owns, rules, green additions, verifier checklist), optionally `CRAFT.md` (the team's research-backed playbook), `skills.txt`, `required.txt`, and `.claude/skills/` plus `.agents/skills/` (that team's skills, linked into both by `teams/link-skills.js`). Claude Code loads a nested `.claude/skills/` only when an agent first reads a file in that folder. Codex never loads them (a spawned worker keeps the lead's cwd), so a Codex worker lists `teams/<team>/.agents/skills/` after `PROFILE.md` and reads each fitting `<name>/SKILL.md` itself, resolving its relative references from that skill's folder. Workers and verifiers read `teams/<team>/PROFILE.md` as their first action; the lead reads nothing under `teams/` except `ROUTING.md`, so team skills and playbooks cost it nothing, not even their descriptions. In guest mode `teams/` sits in the guest dir outside the repo (`bootstrap.md`), so on both CLIs a worker reads its skills the way a Codex worker does, from absolute paths.

## Agents

Two generic agents serve every team: `proteus-worker` and `proteus-verifier`. The lead names the team in the prompt; the agent reads that team's `PROFILE.md`, then `CRAFT.md` if it exists, then `CONVENTIONS.md`. The software defaults also ship as named agents (`proteus-frontend-worker`, `proteus-backend-verifier`, …) with the team preset. A project that wants a team-specific agent (different tools, a pinned model) adds `.claude/agents/proteus-<team>-worker.md` to its own repo (Codex: a TOML role, no model, no tool limits, `harnesses.md`); the lead prefers it over the generic one. No supervisor sits between the lead and a team. Adding one adds a hop and a context window and removes nothing.

Cross-cutting agents, every domain: `proteus-security-verifier` (second verifier on auth, input parsing, secrets, file or network I/O, money, personal data, anything published), `proteus-qa-verifier` (once per wave on `proteus/<run>`, deep per milestone and at close), `proteus-guide` (human-review brief), `proteus-scout` (designs the roster and picks skills at bootstrap).

## The roster

Software repos start from the shipped teams `frontend`, `backend`, `devops`, `security`, `qa` (`templates/teams/` in the Proteus checkout, copied to the repo's `teams/` by `install.js --project`). After the first copy, `ROUTING.md`, `PROFILE.md` and `skills.txt` belong to the repo and are never overwritten. A release that changes one the repo edited leaves its text beside it as `<file>.upstream` to merge (README, Updating). `--doctor` lists the files still pending. The lead does not merge them itself: they are the human's call, like any roster change. Any other project, or a software project the shipped teams do not fit, gets a roster designed for it: `proteus-scout` (`judge`) reads the repo, `CONTEXT.md`, and the work order, and proposes teams as the real-world roles a studio or firm would staff (`domains.md`). The human approves the roster before anything is written. A worker then writes each `PROFILE.md` and, where the craft needs one, `CRAFT.md`.

`PROFILE.md` shape, 40 lines at most:

```markdown
# <team>
Real-world role: <what this person does in a studio or firm>
Owns: <paths, file types, or named parts of a shared artifact>
Never touches: <paths or parts owned by other teams>
Needs frozen from earlier passes: <what must be merged before this team starts>
Rules: <numbered, each one observable>
Green adds: <checks beyond the repo gates this team's worker runs before DONE>
Verifier adds: <what this team's verifier checks beyond the generic list>
Safety: <optional, `domains.md`: how agents run deliverables that change a live system without touching it>
```

`teams/ROUTING.md` maps each deliverable type or path pattern to one owning team, one row each. The lead routes every ticket by it, not by guess; a ticket with no matching row is a question for the human, and the answer becomes a row through a ticket.

## Skills

Per team, `teams/<team>/skills.txt`, one `<owner/repo> <skill-name>` per line, resolved from [skills.sh](https://skills.sh) and installed plugins. The scout picks them for this project's specifics (stack, domain, tools the deliverables need), ranked by installs and fit, eight at most; everything else stays global and on-demand. The human approves before `node teams/link-skills.js --install --confine` pulls them in (`bash teams/link-skills.sh …` and `teams\link-skills.ps1 …` are wrappers around it).

`teams/<team>/required.txt`, same format, is the pipeline's: `install-anti-slop` for devops on code, `thermo-nuclear-code-quality-review` for qa on code. The scout does not rewrite it, it does not count against the eight, and `install.js --project` refreshes it. A missing required skill stops the run.

Models per role follow the ladder in `SKILL.md` rule 2. On a Sonnet lead all three tiers are Sonnet; with no ladder (`models=unknown`, Codex by default) every role runs on the lead's model.

## Routing

- Tag at `/to-tickets`: `profile:<team>` from `ROUTING.md`. A ticket needing two teams is two tickets with a contract between them.
- `security` is not tagged; the lead attaches it as a second verifier by the rule above. Both verdicts must be `MERGE`.
- `qa` runs once per wave, not per ticket. Per-ticket checks already are the QA.

## Confinement

`~/.claude/skills/` loads in every session, lead included. To keep a domain skill out of the lead entirely, it must live only under the team's folder. `--confine` removes the global link for every skill it linked into a team (links only; real directories are left alone). On Codex `~/.agents/skills/` loads for the lead too and `--confine` cannot hide team skills from it. The lead keeps: Proteus, the mattpocock skills, caveman, ponytail, rtk, context-mode, graphify.

Bootstrap is the one exception: the scaffold worker may read several teams' `PROFILE.md` to set up checks for each.

## What this does not buy

Verifiers catch contract violations, ownership slips, and known anti-patterns. Correctness comes from the red check written at step 3; a ticket without a check that can go red has no verifier that can save it. "Nothing left unreviewed" is a property of file ownership plus a red check per ticket, not of how many reviewers exist.

## Changing the roster mid-run

The roster is the human's. A missing team (a ticket fits no row, or one team's tickets keep needing a skill it lacks) → propose the change in one line; on approval a worker adds the folder, the `ROUTING.md` rows, and the skills, and `link-skills.js --install` links them.

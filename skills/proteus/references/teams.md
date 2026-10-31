# Teams

A team is a folder `teams/<team>/` holding `PROFILE.md` (role, owns, rules, green additions, verifier checklist), optionally `CRAFT.md` (the team's research-backed playbook), `skills.txt`, `required.txt`, and `.claude/skills/` plus `.agents/skills/` (that team's skills, linked into both by `teams/link-skills.js`). Claude Code loads a nested `.claude/skills/` only when an agent first reads a file in that folder. Codex never loads them (a spawned worker keeps the lead's cwd), so a Codex worker lists `teams/<team>/.agents/skills/` after `PROFILE.md` and reads each fitting `<name>/SKILL.md` itself, resolving its relative references from that skill's folder. Workers and verifiers read `teams/<team>/PROFILE.md` as their first action; the lead reads nothing under `teams/` except `ROUTING.md`, so team skills and playbooks cost it nothing, not even their descriptions. In guest mode `teams/` sits in the guest dir outside the repo (`bootstrap.md`), so on both CLIs a worker reads its skills the way a Codex worker does, from absolute paths.

## Agents

Two generic agents serve every team: `proteus-worker` and `proteus-verifier`. The lead names the team in the prompt; the agent reads that team's `PROFILE.md`, then `CRAFT.md` if it exists, then `CONVENTIONS.md`. The software defaults also ship as named agents (`proteus-frontend-worker`, `proteus-backend-verifier`, …) with the team preset. A project that wants a team-specific agent (different tools, a pinned model) adds `.claude/agents/proteus-<team>-worker.md` to its own repo, with the standing rules from `roles.md` (Codex: a TOML role, no model, no tool limits, `harnesses.md`); the lead prefers it over the generic one. To change a shipped agent, the project patches it in `.claude/proteus-agents.json` (`tools` add/remove, `model`, `effort`, `append`; Codex: `.codex/proteus-agents.json`, `append` only) rather than copying it: the installer and the session-start sync regenerate the agent from each release plus the patch, while a copy gets no shipped updates (README, Agent patches). No supervisor sits between the lead and a team. Adding one adds a hop and a context window and removes nothing.

Cross-cutting agents, every domain: `proteus-security-verifier` (second verifier, `SKILL.md` principle 4), `proteus-qa-verifier` (once per wave on `proteus/<run>`, deep per milestone and at close), `proteus-guide` (human-review brief), `proteus-scout` (designs the roster and picks skills at bootstrap).

## The roster

Software repos start from the shipped teams `frontend`, `backend`, `devops`, `security`, `qa` (`templates/teams/` in the Proteus checkout or plugin root, two dirs above this skill's `SKILL.md`). `install.js --project` and `--plugin-setup` copy only the ones the repo has evidence for (Fit signals, below), write `ROUTING.md` without the rows of the rest, and print one line per team left out with the reason. A refresh only updates the team dirs `teams/` already has and never adds one. After the first copy, `ROUTING.md`, `PROFILE.md` and `skills.txt` belong to the repo and are never overwritten. A release that changes one the repo edited leaves its text beside it as `<file>.upstream` to merge (README, Updating). `--doctor` lists the files still pending. The lead does not merge them itself: they are the human's call, like any roster change. Any other project, or a software project the shipped teams do not fit, gets a roster designed for it: `proteus-scout` (`judge`) proposes teams as the real-world roles a studio or firm would staff (`domains.md`).

## Fit signals

One function per shipped team in `templates/hooks/proteus-teamfit.js`, used by `--project`, `--plugin-setup` (first install only: no `ROUTING.md` and no team under `teams/` yet) and `--doctor`. Evidence is `git ls-files` with pathspecs plus the manifests it lists, workspace members included (every tracked manifest is read): no directory walk, no network. Never evidence: `node_modules/`, `vendor/`, `third_party/`, `dist/`, `build/`, `out/`, `coverage/`, `target/`, `Pods/`, `.next/`, `.nuxt/`, `.svelte-kit/`, `docs/`, `doc/`, `test/`, `tests/`, `__tests__/`, `spec/`, `fixtures/`, `__fixtures__/`, `testdata/`, `example/`, `examples/` at any depth, the repo's `teams/`, `*.min.*`, lockfiles. Past `CAP_MS` = 5000 ms (`PROTEUS_TEAMFIT_CAP_MS` overrides) every team is kept and the output says so.

| Team | Copied when |
|---|---|
| `security`, `qa` | always: they verify and are never routed to |
| `devops` | the repo has a git remote, CI config (`.github/workflows/*`, `.gitlab-ci.yml`, `.circleci/`, `Jenkinsfile`, …), containers (`Dockerfile`, `Containerfile`, compose files) or infrastructure (`*.tf`, `infra/`, `k8s/`, `helm/`, `Chart.yaml`, `fly.toml`, `vercel.json`, `Procfile`, …); or the repo has no code yet |
| `frontend` | a UI dependency in a manifest (`react`, `vue`, `svelte`, `solid-js`, `@angular/core`, `next`, `nuxt`, `astro`, Remix, Qwik, `preact`, `lit`, `react-native`, `expo`, `electron`, Tauri; Rust `leptos`, `yew`, `dioxus`, `tauri`, `egui`, `iced`; Flutter `sdk: flutter` in `pubspec.yaml`; Compose or an Android app in `build.gradle*`; an iOS, tvOS, watchOS or visionOS target or SwiftUI previews in `project.pbxproj`; Blazor, MAUI, WPF or WinForms in a `*.csproj`), native UI files (`*.storyboard`, `*.xib`, `*.xcassets`), any `*.tsx`, `*.jsx`, `*.vue`, `*.svelte`, `*.astro`, `*.razor`, `*.css`, `*.scss`, `*.sass`, `*.less`, or more than `UI_TEMPLATE_LIMIT` = 5 server-rendered templates (`*.html`, `*.htm`, `*.html.*`, `*.haml`, `*.slim`, `*.blade.php`, `*.gohtml`, `*.hbs`, `*.ejs`, `*.pug`, `*.njk`, `*.twig`, `*.heex`, `*.cshtml`, `*.jinja*`) |
| `backend` | a server framework, ORM, database driver or job queue in `package.json`, `composer.json`, `pyproject.toml`/`requirements*.txt`/`Pipfile`, `go.mod`, `Cargo.toml`, `Gemfile`, `pom.xml`/`build.gradle*`, `*.csproj`, `mix.exs` (Express, Fastify, NestJS, Hono, Prisma, Django, Flask, FastAPI, SQLAlchemy, Gin, GORM, Axum, Diesel, Rails, Spring Boot, Ktor, Laravel, ASP.NET Core, Phoenix, Ecto, …), or a server layout (`migrations/`, `migrate/`, `handlers/`, `controllers/`, `server/`, a root `api/`, `pages/api/`, `app/api/`, `*.proto`, `openapi.*`, `schema.prisma`, `alembic.ini`, `manage.py`) |

- A docs site is not a UI: a `package.json` depending on Docusaurus, VitePress, VuePress, Nextra, Starlight or docsify adds nothing, nor do the UI files under it or under an mkdocs project's `overrides/`. If the site is the product, the human says so and the team is added as a roster change.
- No code yet (no manifest and no source file): `security`, `qa` and `devops`. The scaffold ticket adds the teams the chosen stack needs (`bootstrap.md`).
- `--doctor` warns about a shipped `frontend`, `backend` or `devops` in `teams/` that has no signal and no `ROUTING.md` row matching a tracked file, and prints the command that removes it. It removes nothing.
- A later ticket with no routing row whose work matches a shipped team's signal (the repo just gained a UI): the lead proposes adding that shipped team, copied from `templates/teams/<team>/` with its `ROUTING.md` row, as a roster change the human approves (Changing the roster mid-run).

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
Retries: <optional, default 0> · Timeout: <optional, minutes per check> · Rebuild: <optional, per-merge | per-wave | per-milestone> (`domains.md`, prompt-only)
```

`teams/ROUTING.md` maps each deliverable type or path pattern to one owning team, one row each. The lead routes every ticket by it, not by guess; a ticket with no matching row is a question for the human, and the answer becomes a row through a ticket.

## Skills

Per team, `teams/<team>/skills.txt`, one `<owner/repo> <skill-name>` per line, resolved from [skills.sh](https://skills.sh) and installed plugins. The scout picks them for this project's specifics (stack, domain, tools the deliverables need), ranked by installs and fit, at most 4 and 40960 bytes of combined `SKILL.md` text (`CAP` in `link-skills.js`, which refuses a team over either: it prints `cap: <team> ...`, links and installs nothing for it, and exits 3); everything else stays global and on-demand. The human approves before `node teams/link-skills.js --install --confine` pulls them in (`bash teams/link-skills.sh …` and `teams\link-skills.ps1 …` are wrappers around it).

`teams/<team>/required.txt`, same format, is the pipeline's: `install-anti-slop` for devops on code, `thermo-nuclear-code-quality-review` for qa on code. The scout does not rewrite it, it does not count against the cap, and `install.js --project` refreshes it. A missing required skill stops the run.

A `skills.txt` line may end with `@<40-hex commit sha>`: `--install` runs `npx skills add <owner/repo>#<sha>`, which fetches that commit, and the lock keeps the sha beside the hash.

Authored skills live in `teams/<team>/skills/<name>/SKILL.md`, committed and never published. When nothing found qualifies and research turns up craft knowledge beyond the model's defaults, the scout drafts one (markdown only, citing its sources) and a worker writes it on approval. `link-skills.js` links and locks them like found ones (`"source": "authored"`), counts them toward the cap, and refuses the team when one shares a name with a listed skill (`dup: <team> <name>`). It runs `proteus-skill-scan.js` on each first: a finding prints `scan: <team>/<name> FINDINGS <n>` and links nothing for the team until the human runs `--relock`, which records `"scan": "<sha256>"` for that content, so any later edit is blocked again.

Models per role follow the ladder in `SKILL.md` rule 2. On a Sonnet lead all three tiers are Sonnet; with no ladder (`models=unknown`, Codex by default) every role runs on the lead's model.

## Routing

- Tag at `/to-tickets`: `profile:<team>` from `ROUTING.md`. A ticket needing two teams is two tickets with a contract between them.
- Slice ticket, the one exception: when that contract would be larger than the change. Tier Quick or Standard only; labels `profile:<owning team>` plus `slice:<team>[,<team>]` naming the others; its owned paths may fall in any named team's `Owns`, nowhere else. One worker and one verifier, both from the owning team; the verifier checks every named team's checklist. The security trigger is unchanged. `next` refuses `slice:` on a hard or full ticket (`DECIDE #<n> slice`).
- Cross-cutting change (a rename across the codebase, a dependency bump, a license header): one ticket, owned by the team that owns the mechanism (dependencies: devops), `difficulty:mechanical`. Owned is the exact file list, no globs. Its check proves the change mechanical: the same transformation in every file and nothing else.
- `security` is not tagged; the lead attaches it as a second verifier by the rule above. Both verdicts must be `MERGE`.
- `qa` runs once per wave, not per ticket. Per-ticket checks already are the QA.

## Confinement

`~/.claude/skills/` loads in every session, lead included. To keep a domain skill out of the lead entirely, it must live only under the team's folder. `--confine` removes the global link for every skill it linked into a team (links only; real directories are left alone). On Codex `~/.agents/skills/` loads for the lead too and `--confine` cannot hide team skills from it. The lead keeps: Proteus, the mattpocock skills, caveman, ponytail, rtk, context-mode, graphify.

Bootstrap is the one exception: the scaffold worker may read several teams' `PROFILE.md` to set up checks for each.

## What this does not buy

Verifiers catch contract violations, ownership slips, and known anti-patterns. Correctness comes from the red check written at step 3; a ticket without a check that can go red has no verifier that can save it. "Nothing left unreviewed" is a property of file ownership plus a red check per ticket, not of how many reviewers exist.

## Changing the roster mid-run

The roster is the human's. A missing team (a ticket fits no row, or one team's tickets keep needing a skill it lacks) → propose the change in one line; on approval a worker adds the folder, the `ROUTING.md` rows, and the skills, and `link-skills.js --install` links them.

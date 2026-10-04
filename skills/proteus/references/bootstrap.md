# Bootstrap

Run before step 1 of the flow whenever "Session start" in the skill finds a piece missing. Detect the repo state, then take the matching path, doing only what is missing. Don't skip the checks: a missing gate is how a wave passes locally and fails on merge. The lead writes nothing here but `CONTEXT.md`, `CONVENTIONS.md`, and `AGENTS.md`; every other file below is a worker's.

## Detect

| Signal | State |
|---|---|
| no `.git`, or `git log` empty, or no deliverable files | **blank** |
| deliverables exist, no `CONTEXT.md` or no `AGENTS.md ## Learned` | **mid-project, unset** |
| `CONTEXT.md` + `AGENTS.md ## Learned` + checks green | **ready**: go to flow step 1 |

Deliverables are whatever the project ships: source code, a manuscript, pass scripts for a scene, an edit list, a financial model (`domains.md`).

## Blank

1. `git init`, initial commit of an empty `README.md`, branch `main`.
2. `/grilling` on the idea until the domain, the deliverable format, the tools, and (on code) stack, runtime, and package manager are decided. Nothing is scaffolded before this.
3. `/setup-matt-pocock-skills` with GitHub as the issue tracker. Write `CONTEXT.md` via `/domain-modeling` with the first ten terms.
4. Roster (below), then the first ticket, always alone, always `hard`: **scaffold**, owned by `devops` on code or by the team that owns the build otherwise.
   - Code: the grilled stack is TypeScript and every choice is one `create-better-t-stack` offers (frontend, backend, runtime, database, ORM, API, auth) → the worker generates it with `npx create-better-t-stack@latest <name> --frontend … --backend … --runtime … --database … --orm … --api … --auth … --package-manager … --directory-conflict merge --no-install --no-git --disable-analytics`, every stack flag explicit (`--yes` cannot be combined with them; a missing `--directory-conflict` prompts and hangs). The stack decides the tool, not the reverse; anything it does not cover is scaffolded by hand. The ticket ends with package manifest, typecheck, lint, test runner, one passing smoke test, the gate commands from `stack.md`, and the mechanical gates from `enforcement.md`: `.github/workflows/proteus-gates.yml`, `lefthook.yml`, `teams/templates/` committed (both run its `hooks/commit-msg.js`), `EDIT` lines filled from the gate commands, and on JS/TS the anti-slop oxlint rules (`enforcement.md` §9).
   - Not code: the build is scripts that produce the deliverable from the repo alone (render, export, compile the document, recompute the model), one check per team from `domains.md` that runs headless and prints its inputs, the commit-msg hook and CI workflow from `enforcement.md` §3–4 with the gate lines set to those checks, and Git LFS or a manifest for large binaries.
   Nothing else. Merge it before any feature wave.
5. Add `## Learned` to `AGENTS.md`. Record the gate commands, `labels: created`, and the domain.
6. Now the flow from step 1. Hotspot files (routes, registries, config, shared scene or project files) get their own ticket in wave one.

## Mid-project, unset

1. `/setup-matt-pocock-skills` with GitHub as the tracker if not run. `/domain-modeling` for `CONTEXT.md` if missing; `/wayfinder` first if the project is large enough that one session cannot hold it (its map goes to the tracker as a `wayfinder:map` issue).
2. Run every gate on `main` (`stack.md` on code; the domain checks otherwise). Red gates go into a **stabilise** ticket that runs alone before any feature wave: it records each red gate's findings in `teams/baseline.json` with `proteus-baseline.js` and runs that gate through it in CI and lefthook (`enforcement.md` §12), so a ticket fails only on findings it adds; the same ticket installs the CI workflow, lefthook, commit-msg check, and on JS/TS the anti-slop oxlint rules from `enforcement.md` if the repo lacks them. Fixing the recorded failures is follow-up work, not a precondition. A red gate with no baseline still blocks features; workers cannot tell their red from yours.
3. Code: `fallow health` / `vulture`, run by a `helper` subagent that reports counts and the ten worst files, not the listing. Dead code and duplicates go into the stabilise ticket or a follow-up, not into a feature ticket.
4. Root docs over budget (`doc-bloat` in `proteus-state`) → a docs-diet ticket (`docs-diet.md`) in wave one. Plans, maps, or logs committed as files → the same ticket moves them to the tracker.
5. Add `## Learned` to `AGENTS.md`. Record: `labels: created`, gate commands, package manager, test layout, hotspot files, the domain.
6. Existing branches or worktrees: list them, ask the human which are live, leave the rest alone. Don't delete a branch you did not create: it may be someone's live work.
7. Now the flow from step 1.

## Conventions (both paths)

`CONVENTIONS.md` missing → read `conventions.md`, run the interview, commit the file. Creative and business work: the interview covers the house defaults too (`conventions.md` § Taste beyond code).

## Roster (both paths)

`teams/` missing → tell the human to run `node <Proteus checkout>/install.js --project` from this repo's root and stop. Its hooks (`.claude/settings.local.json`, or `.codex/hooks.json` with `--harness codex`, naming `proteus-autostart.js` and `proteus-lead-guard.js`) come from the same command; `node <checkout>/install.js --doctor` (plus `--harness codex` on Codex) diagnoses a broken install. `hive-autostart.js` in `.claude/hooks/` or `.codex/hooks/` means the repo is still on hivemind, the old name: the same `--project` command moves it; tell the human and stop.

Then, if `skills-unscouted` is not `none` or the human says "refresh skills" or "redesign teams": spawn `proteus-scout` with the domain, the work order, and `domains.md`. On software that fits the shipped teams it only rewrites the skill lists; otherwise it proposes the roster (`teams.md`): teams, `Owns`, checks, research sources, `ROUTING.md` rows, skills per team. Print its report, ask the human to approve or edit. On approval, one worker writes the folders, `PROFILE.md`, `CRAFT.md` where needed, `ROUTING.md`, and `skills.txt`; then the human runs `node teams/link-skills.js --install --confine`. Third-party skill text runs inside every worker; the human decides what gets in. The script writes `teams/skills-lock.json`; commit it. `drift: <skill>` in its output, or `skills-lock=drift:<skills>` in `proteus-state`, means this machine's copy differs from the lock; the guard refuses worker and verifier spawns until the human runs `npx skills update <skill>` or `--relock` (`enforcement.md` §6).

`teams/<team>/required.txt` is the pipeline's own list; the scout does not edit it and the human does not trim it.

## Tracker (both paths)

Read `tracker.md`. Run its preflight; no remote or no auth → stop, tell the human. Create the labels once; `labels: created` under `## Learned` means done. Blank repo: `gh repo create` is the human's call; ask, do not assume public or private. On a public repo the autostart adds a note once per repo (recorded in `<git-common-dir>/proteus/visibility.json`): the run log, issues, contracts, review briefs, evidence branches and questions are readable by anyone. Pass it on to the human in your first reply. Nothing Proteus produces during a run is written to the repo except deliverables, checks, contracts, lessons, and the three docs.

## Guest mode

`guest=<dir>` in `proteus-state` means the human does not own this repo (`install.js --project --guest`, or `gh` reported READ or TRIAGE access). Proteus's files live in `<dir>`, laid out like a repo root, and the repo gets none of them:

- Read every `CONTEXT.md`, `CONVENTIONS.md`, `AGENTS.md`, `docs/adr/`, `docs/lessons/` and `teams/` path in this file and the references as `<dir>/<path>`. The lead writes the docs there; the guard refuses the repo's own copies. Brief workers and verifiers with the absolute `<dir>/teams/<team>/` paths. On both CLIs they list `<dir>/teams/<team>/.agents/skills/` after `PROFILE.md` and read each fitting `SKILL.md` themselves, as Codex workers always do.
- No scaffold of CI, lefthook, lint config or root docs. `ci-gates=guest` and `lefthook=guest` are not missing pieces. Workers and verifiers run the repo's own gate commands locally. For a red gate, the lead records the baseline from the main checkout with `node <dir>/teams/templates/hooks/proteus-baseline.js <gate> --record -- <command>`, which writes `<dir>/teams/baseline.json`; nothing is committed. Once a ticket that fixes old failures merges, the lead re-runs the same line with `--record`, which only tightens.
- No docs-diet: the repo's `CLAUDE.md` and `AGENTS.md` are the owner's.
- The tracker still needs issues, labels, milestones and branches. If the preflight in `tracker.md` shows the human cannot create them here, stop. Ask them to work from a fork (`gh repo set-default <fork>`) or name another tracker repo. Ticket PRs into `proteus/<run>` are the contribution; what goes upstream, and how, is the human's call.

## Ready

Confirm in one line: gates green on `main` (a ratcheted gate: no finding beyond `teams/baseline.json`), `CONTEXT.md`, `CONVENTIONS.md`, `## Learned`, `teams/` with `ROUTING.md` and links, tracker reachable. Go.

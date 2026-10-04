# Proteus

A Claude Code skill that ships a large project as a team of agents: software, video or audio editing, 3D and rendering, writing, research, or business planning. A **lead that only decides** designs teams that mirror the real-world roles a studio or firm would staff, **parallel workers in git worktrees** deliver, **a verifier per ticket** gates every merge (two when the ticket touches auth, input, secrets, I/O, money, or personal data), and **you gate every milestone**. Agents never talk to each other; they share tickets, contracts, and reports on GitHub.

Built on top of the [mattpocock-skills](https://github.com/mattpocock/skills) workflow (`/grilling` → `/to-spec` → `/to-tickets` → `/tdd` → `/code-review`) and Claude Code's Agent Teams.

## Why

The usual multi-agent loop bleeds tokens in three places: the lead sits inside the fix loop, verification happens after handoff instead of inside the worker, and agents chat. Proteus fixes all three:

- The lead decides, writes prompts, and dispatches. It produces no deliverable, not even the contract stubs, and never reads diffs. A hook refuses its edits.
- Workers run their team's checks themselves (typecheck, lint, tests on code; render probes, loudness, link checks, model recompute elsewhere), loop to green, and cap at 2 retries. Every check is shown failing on deliberately broken input before any worker starts, so a green check means something.
- Escalation sends only the diff plus failing output to a fresh-context verifier. One pass.
- Independent tickets run in parallel, one git worktree each, merged sequentially.
- The lead is whatever model you start the session on, and nothing runs above it (see [Models](#models)). Hard tickets and every verdict run on the lead's tier, standard tickets one rung down. A hook refuses any other spawn.
- The pipeline is fixed. A step is skipped or added only when you say so or a `/research` finding does.

Context cost: the description is ~60 tokens per session. The body loads only on `/proteus` (~1,000 tokens). `references/roles.md` loads at spawn time, `references/stack.md` on first run in a repo, `references/commits.md` when an agent commits. Every other reference loads only at the step that names it, so the lead pays for what the run actually uses.

## Any kind of project

The pipeline is the same everywhere; the teams, deliverables, and checks change with the domain (`references/domains.md`). On a software repo the shipped teams (frontend, backend, devops, security, qa) apply. On anything else, `proteus-scout` (the lead's tier) reads the project and proposes a roster of real-world roles: for a Blender scene, art direction, modelling, materials, lighting, camera, render/post; for a business plan, market research, financial modelling, strategy, legal/risk, editing. Each team gets an `Owns` line, its own checks (mechanical first, a rubric for taste), research sources a senior in that role trusts, a `CRAFT.md` playbook with cited numbers, and skills from [skills.sh](https://skills.sh) picked for this project's specifics. You approve the roster before anything is written.

Three rules hold in every domain: everything reproducible lives in git (scripts, sources, manifests; nothing only in `out/` or a GUI session); every check can go red; every probe prints what it measured. Tickets that rest on outside facts start with `/research` and cite primary sources.

## Starts itself

`install.js --project` registers the lead's hooks in the repo's `.claude/settings.local.json` (machine-local, untracked):

- **Autostart.** Every session opened in the repo begins as the lead, skill loaded, no `/proteus` typed. It prints a `proteus-state` line from local files (docs present, skills scouted and linked, gates installed, open `proteus/*` branches, root docs over budget, lessons, Proteus updates), so the lead skips what is already set up.
- **Lead guard.** On the main thread, edits inside the repo are refused except `CONTEXT.md`, `CONVENTIONS.md` (written at bootstrap; later only with your approval), `AGENTS.md`, ADRs, and lessons (never `CLAUDE.md`: that is yours, and a docs-diet worker edits it); an Agent call with no model, above the lead's, on a once-per-project model, or under the floor is refused; `gh … --edit-last` is refused (every agent posts as you, so an edit can overwrite a ruling), and so is an agent's comment opening with `ACCEPT`, `CHANGES` or `ANSWER`: those are your words. In the lead and every subagent it refuses `gh pr merge --admin`, a push to `main` or to an existing run branch (creating `proteus/<run>` passes), deleting either, and any change to branch protection or a ruleset other than the per-run protection PUT. The lead does not open images itself (each render costs it ~1.5k tokens; a subagent or you judge it) unless you name the file. Inside subagents it refuses `run_in_background` and `Monitor` (a worker that waits on a background notification never wakes up) and any edit outside the worker's owned paths or in another worker's worktree.
- **Journal and meter.** Every message you type is kept verbatim in `.git/proteus/`, except that secrets (GitHub, Anthropic, OpenAI, AWS and Slack tokens, JWTs, private key blocks, `Authorization:` headers, `password=`/`token=`-style assignments) are stored as `[redacted]`, so a pasted key is not re-injected after a compaction; context is metered from the transcript, with a warning at 150k and a hard stop on new dispatch at 180k.
- **Lessons.** Solved problems are recalled only when their trigger fires (below).
- **Stall check.** A worker that ends its turn "waiting" instead of reporting is sent back to finish.
- **Scratch.** Agents keep temp files, renders and worktrees in a per-ticket dir under `.git/proteus/scratch/`, and anything they leave directly in `/tmp` is ledgered. Both are deleted when the ticket merges or the run closes, with a background sweep for what is left behind; nothing Proteus did not create is touched.
- **Status line.** `proteus: 2 questions · 1 review` at the bottom of the terminal while anything waits on you, and `proteus: update ready` when a newer release is out, appended to your own status line.

`PROTEUS=0 claude` opens a plain session with none of them, for the review session or for working by hand.

## Models

The session you start is the lead, on whatever model you started it with, and it staffs down from there on a ladder, cheapest first: `haiku < sonnet < opus < fable`. The autostart prints `models=lead:…,top:…,mid:…`; the guard enforces it on every spawn.

| You start on | Lead | Hard tickets, verdicts, scout (`top`) | Standard tickets, helpers (`mid`) |
|---|---|---|---|
| Fable | Fable | Opus | Sonnet |
| Opus | Opus | Opus | Sonnet |
| Sonnet | Sonnet | Sonnet | Sonnet |

- Nothing runs above the lead. A worker may run on the lead's own model.
- Fable is once per project: the lead is its one instance, so a Fable lead staffs Opus and below. Lift it with a line in `AGENTS.md` under `## Learned`: `models: solo=none`.
- The floor is Sonnet, so Haiku is under it: it does not produce or review work until it earns it. `models: floor=haiku` in `AGENTS.md` lowers the floor for a project; a Haiku lead lowers it on its own, so everything runs on Haiku.
- Machine-wide defaults live in `~/.claude/proteus.json`: `"models": { "ladder": ["haiku", "sonnet", "opus", "fable"], "floor": "sonnet", "solo": ["fable"] }`. Claude Code passes a subagent's model as one of these aliases, so a rung is a family, not a version.

## Asks before it guesses

Before any spec the lead must be able to state six things without guessing: the outcome you will see, how you will check it is done, what is out of scope, the areas and teams touched, the constraints, and that no question is open. Any blank and it grills you (`/grill-with-docs`, or `/grilling` on a blank repo), one question at a time. Work bigger than a milestone or a session goes through `/wayfinder` first. Unattended, a work order with a blank is parked, never assumed.

## Survives compaction

Tickets, verdicts, and reviews live in the tracker, and the lead logs every decision that lives nowhere else (grilled answers, an `UNATTENDED` grant, allowed deviations, your hand edits to an artifact, pause positions) as one-line comments on a `Run: <run>` issue labelled `proteus-log`. After an auto-compact or `/compact` the autostart re-injects the skill, the run-log tail, and your last ten messages verbatim, which the compaction summary would have paraphrased away. The meter tells the lead to `/handoff` to a fresh session before compaction starts churning.

## Learns without bloating

A problem solved after a failed attempt, or anything you correct ("remember this", "never again"), becomes a lesson: a short file in `docs/lessons/` with a trigger regex on a command, an output, a path, or a message. Lessons are never loaded at startup; `proteus-lessons.js` injects one only when its trigger fires, in the lead or in any worker, so a hundred lessons cost nothing until one is needed. At close the lead reviews hit counts: lessons that did not stop a recurrence become gates.

When the lead finds a better workflow, it does not edit itself mid-run: it files a `proposal` issue on this repo (your checkout's origin) and tells you in one line. You decide what changes.

## Questions you cannot lose

When worker traffic scrolls, a question asked in chat is gone. So the lead asks in two ways only:

- A question the whole run waits on (grilling, approving the roster) is a picker pinned at the input, recommended option first; one keypress answers it.
- Anything else (a worker needs a file it does not own, a new dependency, a routing gap) becomes a `Q:` issue with options and a recommendation. The lead parks only the tickets that depend on it and keeps the rest moving.

The status line at the bottom of the terminal shows `proteus: 2 questions · 1 review` until they are answered. Answer when you are free: `/proteus-review` in a second terminal walks every open question as a picker and then every review; typing `questions` in the lead window does the same; or answer from the GitHub app with a comment `ANSWER …`. An answer that states a rule ("always use metric") goes into `CONVENTIONS.md` with your OK, so it is never asked again.

## Commands mid-run

- `questions` / `inbox` — every open question as a picker, in order.
- `status` — one line: milestone, tickets closed/total, open PRs and verdicts, running workers, ETA from this run's median ticket time.
- `pause` (or your own alias, e.g. `gaming`) — stops every worker and heavy job (renders, encodes, test farms), logs the position; `resume` picks up on the same worktrees.
- `revision` — fast review rounds for small taste tweaks: one standing worker commits each tweak as a script in the repo, you approve each by eye, one verifier checks the whole round and that a clean rebuild reproduces it. Nothing lives outside git.

## Works from any project state

Step 0 of every run reads `references/bootstrap.md` and detects where the repo is:

- **Blank** — grills the idea, runs `/setup-matt-pocock-skills` with GitHub as the tracker, writes `CONTEXT.md`, designs the roster, and ships a single scaffold ticket (on code: manifest, typecheck, lint, test runner, smoke test; otherwise: build scripts and one headless check per team) before any feature wave.
- **Mid-project** — runs every gate on `main`; red gates and dead code become a stabilise ticket that runs alone first. That ticket records the existing failures in `teams/baseline.json` and runs those gates through a ratchet (`proteus-baseline.js`) that fails only on new findings, so features can start before the old failures are fixed; a red gate with no baseline still blocks them. Root docs over budget (a 1,000-line `CLAUDE.md`, a `CLAUDE_1.md`) get a docs-diet ticket: each line moves to where it is cheapest (nested `CLAUDE.md`, a lesson, an ADR, the tracker) or is deleted; landmarks stay as one-line links (`references/docs-diet.md`).
- **Ready** — confirms gates, `CONTEXT.md`, `AGENTS.md ## Learned` in one line and goes.

On a public GitHub repo the session start also says so, once per repo: the run log, issues, contracts, review briefs, evidence branches and questions Proteus posts are readable by anyone, so keep anything private out of work orders and answers. The visibility comes from `gh repo view` (3 s timeout, asked at most once a day until the note has shown) and is recorded in `.git/proteus/visibility.json`.

## Teams

A team is a folder, not an extra agent. `teams/<team>/` holds `PROFILE.md` (real-world role, what it owns and never touches, rules, what green adds, what the verifier checks), an optional `CRAFT.md` playbook, and `.claude/skills/` with that team's skills. Claude Code loads a nested `.claude/skills/` only when an agent first reads a file in that folder, so a worker's first action, "read `teams/lighting/PROFILE.md`", pulls in the lighting skills, and the lead, which never reads under `teams/`, pays nothing for them. Not even the descriptions.

`teams/ROUTING.md` maps each deliverable type or path to one team; the lead routes every ticket by it and verifiers refuse a diff outside the team's `Owns`. Two generic agents, `proteus-worker` and `proteus-verifier`, serve any team by name; the software teams also ship named agents, and a repo can add its own `.claude/agents/proteus-<team>-worker.md`. Security and QA are verifiers only: security runs as a second verifier on sensitive tickets; QA runs once per wave on the integration branch and checks that every deliverable rebuilds from the repo alone. Verifiers carry `memory: local`, so recurring findings persist on your machine (git-ignored).

`teams/<team>/skills.txt` lists the skills as `<owner/repo> <skill-name>`; `node teams/link-skills.js` links them from `~/.agents/skills` (where `npx skills add` puts them) into the team's `.claude/skills/` and, for Codex, `.agents/skills/`, `--install` fetches what is missing, `--confine` drops their global links so they exist only inside their team folder. See `references/teams.md`.

### Skills are picked for your project, not mine

The shipped `skills.txt` files are only a starting set for software. At bootstrap the lead spawns `proteus-scout`, which reads your project, queries skills.sh for each domain and tool term, ranks by fit and installs, caps at eight per team, and reports what it picked and why, then stops. You approve and run the link script. Nothing third-party enters a worker without that yes.

### Required skills

Two skills are the pipeline's, not the scout's; they live in `teams/<profile>/required.txt` and never count against the cap.

- [anti-slop](https://github.com/dmmulroy/anti-slop) — on JS/TS the scaffold or stabilise ticket vendors its oxlint rules into the lint gate. After that slop fails lint in the worker, in lefthook, and in CI, at zero agent tokens.
- [thermo-nuclear-code-quality-review](https://github.com/cursor/plugins/tree/main/cursor-team-kit/skills/thermo-nuclear-code-quality-review) — the QA pass applies it on the lead's tier to every milestone diff; its blockers are tickets and the human gate stays shut until they merge. Per milestone, not per ticket: on a forty-line diff it demands rewrites nobody asked for.

At close the same pass runs the scan phase of mattpocock `improve-codebase-architecture` and files up to five deepening candidates on the milestone's debt issue for you to pick from. On a blank TypeScript repo the scaffold worker uses [create-better-t-stack](https://github.com/AmanVarshney01/create-better-t-stack) when the grilled stack is one it offers; the stack picks the tool, never the reverse.

## Your conventions, not the model's

Bootstrap refuses to start a ticket without `CONVENTIONS.md` at the repo root. For creative and business work the interview also covers your house defaults (camera height, brand voice, loudness target, margin floor), and the first milestone of any taste-driven run is a small test piece you always review yourself, so taste notes arrive before the rebuild, not after. Mid-project, a worker drafts it from evidence (linter config, sample files, commit log) and marks each rule `observed` or `guess`; then the lead asks you, in batches of four, only what is still open: naming, layout, formatting, errors, comments, tests, types, dependencies, commit scopes, forbidden things. One rule per line, examples inline, you own the file. Workers read it right after their profile; verifiers fail a ticket on any deviation. Same code on every file, in your taste. See `references/conventions.md`.

## Human in the loop

Agents verify tickets; you verify milestones. At `/to-tickets` the lead groups tickets into milestones, one user-visible feature each; a single-task run is one milestone. When a milestone merges and QA is green, the lead spawns `proteus-guide`, which opens a `Review: <run>/<milestone>` issue with a brief under 60 lines: what changed, exact steps to verify it in under ten minutes, the three to five places an AI most plausibly got wrong, convention deviations, and what verifiers deferred to the milestone's debt issue, and what evidence it captured (gate output, renders or stills, Playwright screenshots or recordings, CLI transcripts). Then the lead sends a notification and polls the issue for a verdict comment. It does not talk you through the review; it has no diff and every relayed line costs it twice.

You review through whichever channel fits:

- **Review session** — second terminal, `PROTEUS=0 claude`, `/proteus-review`. A fresh session with the issue, the diff, and the evidence. Ask anything, have it run steps, then say accept or name the problems; it posts the verdict. Zero lead tokens.
- **Phone** — `/remote-control` on that review session, or the GitHub app: read the issue, comment `ACCEPT`.
- **Issue only** — read the brief on GitHub, comment `ACCEPT` or `CHANGES` plus one line per problem. No AI involved.
- **Evidence only** — flip through the linked screenshots, then comment.

Only comments from your GitHub login count: on a public repo a stranger's `ACCEPT` is ignored, and so is `ACCEPTED`; the keyword stands alone on the first line. If the agents post under an account of their own, name yours as `"human": "<login>"` in `~/.claude/proteus.json`.

`ACCEPT` moves on; `CHANGES` turns each line into a ticket and runs the loop again, or runs revision mode when the changes are small tweaks. Verifier follow-ups never become a pile of tickets: they go on one debt issue per milestone, and at close you fix, re-scope, or drop every line. Merging `proteus/<run>` into `main` is always yours; the lead opens the PR.

### Overnight

Say you are going to sleep, away, or not to wait. The lead prints one warning, what you lose and what stays protected, and continues only on the literal reply `UNATTENDED` (optionally `until 09:00` or `for 3 milestones`). Then at each gate the guide runs its own verify steps, captures evidence, and writes `AUTO-ACCEPT` or, on any mismatch or step it could not execute, `AUTO-HOLD`, which stops the run and pings you. Every auto-accepted milestone keeps its `needs-human` label; when you are back, `/proteus-review` walks you through them with the evidence and your retroactive `CHANGES` become tickets. Unattended never merges into `main`, approves a dependency, installs a skill, or edits `CONVENTIONS.md`, and it stops on its own at five unreviewed milestones. See `references/review.md`.

## No state in the repo

Proteus writes nothing to your repo but deliverables, checks, contract stubs, lessons, ADRs, and three docs a human wants anyway: `CONTEXT.md`, `CONVENTIONS.md`, `AGENTS.md`. Tickets are issues, the wayfinder map is an issue, the run log is an issue, milestones are milestones, worker reports and `NEEDS` questions are issue comments, verifier verdicts are PR reviews on a per-ticket PR into `proteus/<run>`, review briefs are issues labelled `proteus-review`, the human's verdict is a comment, the unattended queue is the `needs-human` label. Screenshots go to an orphan `proteus-evidence/<run>` branch that is deleted when the run merges. The Agent Teams task list is only a runtime mirror; if the session dies, nothing is lost.

The tracker is GitHub via `gh` today. `references/tracker.md` is an operations table with one column per tracker; Jira or anything else slots in by filling the column.

## Enforcement, not promises

Rules in prompts drift; these are mechanical.

- **Run-branch rules + CI.** The scaffold ticket adds `.github/workflows/proteus-gates.yml`. `install.js --protect` (once per repo, by its admin) adds a ruleset so nothing reaches a `proteus/<run>` branch except a PR with the `gates` check green, nothing force-pushes it, and nobody bypasses it, you included; without it the lead protects each run branch itself when its login can. The verifier's `MERGE` is a review comment on the PR (one login cannot approve its own PR; #69). The template's `EDIT-*` steps fail until you fill them in, and `--doctor` warns while one is left. On a PR from `proteus-work/<run>/<id>` the same job also checks the changed paths against the `Owned:` line in the PR body, and each worker worktree gets a pre-commit hook that checks staged paths against its owned list, which catches shell writes the edit hooks cannot see.
- **Agents under their own login.** `install.js --agent-login` signs a second GitHub account, one you create for the agents, into a gh config of its own (`~/.config/gh-proteus`, the token in a file there). From the next session every agent shell command runs `gh` as that account, so only your login's `ACCEPT` counts and the agents cannot lift the ruleset; `proteus-state` says `identity=separate`. Without it they post as you (`identity=shared`), and only the guards tell their words from yours.
- **Path ownership.** A `PreToolUse` hook in each worker's worktree refuses any edit outside the ticket's owned paths and tells the worker to file `NEEDS` instead; the lead's guard also binds each subagent to the worktree of its first edit, so a path another ticket owns is refused in that ticket's worktree; the verifier also refuses a diff outside the team's `Owns`.
- **No silent waiting.** Workers cannot background a job and wait for a notification; a stop that says "waiting" is sent back; the lead arms a stall timer per wave.
- **Baseline ratchet.** On a repo whose gates were already red, `teams/templates/hooks/proteus-baseline.js` records each red gate's findings in `teams/baseline.json` and fails a later run only on findings that are not there, so the old failures do not block every ticket and new ones still do. Findings are output lines matching a per-gate regex (digits and the checkout path normalised away) or a count; `--record` only ever tightens the file.
- **Commit messages.** lefthook runs a commit-msg check: Conventional Commits, 72 chars, no AI trailer. CI re-checks every commit in the PR, so `--no-verify` does not help.
- **Security.** The security verifier runs semgrep on the diff first and queries OSV for every `NEEDS dependency` before the human sees the request.
- **Mutation testing.** Once per milestone, the QA pass mutates the changed files; a surviving mutant is a `WAVE-RED` ticket.
- **Skill pinning.** `teams/skills-lock.json` pins every linked skill's content hash; the link script warns `drift:` when a machine differs, and the lead guard refuses to spawn workers and verifiers until the copy matches again or you re-lock with `node teams/link-skills.js --relock`.
- **Cost.** Close reports cost per merged ticket from `ccusage`; OpenTelemetry export is one env var away for trends.

Details and the exact commands: `skills/proteus/references/enforcement.md`.

## Commit rules

Every agent commits with terse, professional [Conventional Commits](https://www.conventionalcommits.org/). **No AI attribution, no `Co-Authored-By`, ever.** See [`skills/proteus/references/commits.md`](skills/proteus/references/commits.md). The installer sets `attribution` in `~/.claude/settings.json` so Claude Code stops offering the trailer.

## Install

### Prerequisites (all platforms)

1. [Claude Code](https://code.claude.com/docs/en/overview) installed and logged in.
2. Node.js 22.5 or newer (context-mode needs it; `node --version`) and the [GitHub CLI](https://cli.github.com/) logged in (`gh auth login`); the repo needs a GitHub remote.
3. The mattpocock-skills plugin. Inside Claude Code:
   ```
   /plugin install mattpocock-skills@claude-plugins-official
   ```
   Cherry-picking instead? You need: `setup-matt-pocock-skills`, `grilling`, `grill-with-docs`, `domain-modeling`, `codebase-design`, `wayfinder`, `to-spec`, `to-tickets`, `implement`, `tdd`, `code-review`, `resolving-merge-conflicts`, `handoff`.
4. The [context-mode](https://github.com/mksglu/context-mode) plugin, required. `install.js` installs it through the claude CLI; if that is not on PATH, run `claude plugin marketplace add mksglu/context-mode` and `claude plugin install context-mode@context-mode` yourself. Research, logs, test output, and web pages go through its sandbox so only the findings enter an agent's context. It is third-party code: its hooks see every tool call in every Claude Code session on the machine, and it keeps session events and indexed content in local SQLite under your home directory (`~/.context-mode/`). Read it before you install it.
5. Recommended companions (each is its own install; the skill works without them but saves less):
   - [caveman](https://github.com/JuliusBrussee/caveman) — terse agent output
   - [ponytail](https://github.com/DietrichGebert/ponytail) — minimal code
   - [rtk](https://github.com/rtk-ai/rtk) — compressed shell output
   - [Chisle](https://github.com/JayPokale/Chisle) is not a companion: it restates caveman and ponytail in one ruleset and the prose styles fight when stacked. Optional, compress hook only (`CHISLE_DEFAULT_MODE=off`); see `references/stack.md`
   - Claude Code LSP plugin: `/plugin install <language>-lsp@claude-plugins-official`
   - [graphify](https://github.com/safishamsi/graphify) — planning-stage orientation only
   - code-review-graph — verifier blast radius; Serena — alternative to the LSP plugin
   - Gates: `npx fallow` (JS/TS, no install), `vulture-rs` (Python), `cargo machete` (Rust)

### Install (every OS)

All logic is in `install.js` (Node 22.5+). `install.sh` and `install.ps1` are thin wrappers that only find `node` and pass the flags through, so every command below also works as `node install.js …`.

```bash
git clone https://github.com/Yousef-Baidas/proteus.git ~/proteus
node ~/proteus/install.js              # skills + agents for every repo, and the context-mode plugin
cd /path/to/your/repo
node ~/proteus/install.js --project    # teams/, ROUTING.md, the lead's hooks and status line
```

`--project --install --confine` also fetches skills this machine lacks and hides them from the lead. After `proteus-scout` rewrites a list, run `node teams/link-skills.js --install --confine` from the repo root.

The global install links `~/.claude/skills/proteus` and `proteus-review` to this checkout (a symlink on Linux and macOS, a junction on Windows, no admin rights needed), so there is exactly one copy of each skill and `git pull` updates every repo at once. `--project` removes old per-repo copies of the two skills and of unmodified agents; that is why `/proteus` used to show up twice. An agent you changed is kept and reported as a local override: delete it to take the shipped one.

On Windows, PowerShell blocks unsigned scripts by default. Run the wrapper as:

```powershell
powershell -ExecutionPolicy Bypass -File C:\path\to\proteus\install.ps1 -Project
```

or skip PowerShell: `node C:\path\to\proteus\install.js --project`. The switches are `-Project -Install -Confine -Update -AutoUpdate -NoAutoUpdate -Doctor -Fix -Harness codex`.

Agent teams must be on. `--doctor` prints the exact line for your shell; for reference:

```bash
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1      # bash / zsh rc
set -Ux CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS 1      # fish, once
```

```powershell
[Environment]::SetEnvironmentVariable("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS", "1", "User")
```

Or set it under `env` in `~/.claude/settings.json`. Restart the terminal afterwards.

### Codex CLI

The same installer sets Proteus up for [Codex CLI](https://developers.openai.com/codex) with `--harness codex` (or `PROTEUS_HARNESS=codex`; `-Harness codex` in PowerShell). Every flag above takes it.

```bash
node ~/proteus/install.js --harness codex             # skills + agents for every repo
cd /path/to/your/repo
node ~/proteus/install.js --harness codex --project   # teams/, ROUTING.md, the lead's hooks in .codex/
```

Codex reads skills from `~/.agents/skills`, so the two skills are linked there. The agents become TOML roles in `$CODEX_HOME/agents` (default `~/.codex/agents`); a role file without the `# generated by proteus` first line is yours and is never overwritten, by the installer or by the session-start sync. `--project` registers the lead's hooks in `.codex/hooks.json` and lets git and `gh` run outside the sandbox through `.codex/rules/proteus.rules`; both, and the copied hooks, are excluded from git. It also adds `../<repo>-proteus/`, where worker worktrees live, to `writable_roots` in `.codex/config.toml`, so the sandbox lets workers write there. It edits an existing file in place and excludes the file from git only if it created it. The Claude-only hook files (status line, worker settings, commit-msg check) are not copied into `.codex/hooks`. Team skills are also linked into `teams/<team>/.agents/skills/`, and a Codex worker reads them from there itself, since Codex only loads skills between the repo root and the session's cwd. `--confine` does not apply: Codex loads `~/.agents/skills` for every session, so it cannot hide a team skill from the lead.

Three steps the installer cannot do for you, once per repo:

1. Open `codex` in the repo and trust it. Codex loads a project's `.codex/` hooks only in a trusted project.
2. Approve the Proteus hooks in `/hooks`. Codex asks again when a hook entry changes, not when a script updates.
3. Add context-mode, required: `codex mcp add context-mode --env CONTEXT_MODE_PLATFORM=codex -- npx -y context-mode`.

Codex has no status line hook and no attribution setting; the commit-msg check still rejects an AI trailer. `~/.claude/proteus.json` records which CLIs you installed for, and `--update` refreshes each. `--doctor --harness codex` checks the Codex side: skill links, agents, the hooks and rules, leftover Claude-only hooks, the worktree folder's writable root, project trust, and context-mode (as an MCP server or an installed, enabled Codex plugin).

### Updating

```bash
node ~/proteus/install.js --update     # from inside a Proteus repo also refreshes that repo
```

`--update` fetches the checkout's tags and moves it to the newest release tag (`vX.Y.Z`) past it, only by fast-forward and only once `git verify-tag` accepts the tag's signature (see [Releases](#releases)); it refuses an unsigned or untrusted tag, a dirty checkout, and a tag that does not contain your checkout's HEAD. It never moves to the tip of a branch. It prints the `CHANGELOG.md` sections between the two versions (or, without any, the new `feat` and `fix` commits), then re-runs the updated installer, adding `--project` when the current repo has Proteus hooks; with no newer release it only re-runs the installer. `--project` never overwrites your `PROFILE.md`, `ROUTING.md`, or `skills.txt`; it refreshes the link scripts, templates, `required.txt`, and the hooks. Commit the `teams/` changes.

Prefer not to think about it: `node ~/proteus/install.js --auto-update`. The session-start hook then fetches the checkout and its tags at most once a day, and when a newer release tag passes the same checks it fast-forwards a clean checkout to it, re-syncs the hooks and agents, and shows the changelog for the versions in between in a few lines. A tag that fails a check is not applied: one line in the session says why and how to update by hand. `--no-auto-update` turns it off. With it off, the status line shows `proteus: update ready` once the daily fetch finds a newer release, and the lead mentions it once. Following `main` instead is a manual choice: `git -C ~/proteus pull --ff-only`, then `node ~/proteus/install.js --update`.

### Releases

A release is a signed annotated tag `vX.Y.Z` on `main`, with its notes under `## [X.Y.Z]` in `CHANGELOG.md`. The maintainer moves the `## [Unreleased]` notes under the new version, commits, and tags that commit:

```bash
git tag -s v1.2.0 -m "v1.2.0"          # GPG: signs with user.signingkey from your keyring
git -c gpg.format=ssh -c user.signingkey=$HOME/.ssh/id_ed25519.pub tag -s v1.2.0 -m "v1.2.0"   # SSH key instead
git push origin main v1.2.0
```

To sign every tag with SSH, set it once: `git config --global gpg.format ssh` and `git config --global user.signingkey "$HOME/.ssh/id_ed25519.pub"`. Lightweight tags (`git tag v1.2.0`) carry no signature, so no install takes them.

Updates use your own git's trust, so nothing updates until you opt in to the maintainer's key. Fetch the key from a source you trust (not from the checkout it will verify), then, scoped to the Proteus checkout:

- SSH signatures: put one line `<email> <key type> <key>` (for example `maintainer@example.com ssh-ed25519 AAAA…`) in a file outside the checkout, then `git -C ~/proteus config gpg.ssh.allowedSignersFile ~/.config/proteus/allowed_signers`.
- GPG signatures: `gpg --import maintainer.asc`. git accepts a good signature from any key in your keyring; `git -C ~/proteus config gpg.minTrustLevel fully` limits it to keys you have certified (`gpg --lsign-key <fingerprint>`).

Check it by hand: `git -C ~/proteus fetch --tags && git -C ~/proteus verify-tag v1.2.0`.

### Coming from hivemind

Proteus was called hivemind. Install Proteus as above, or run `install.js --update` in your hivemind checkout (it pulls Proteus and runs the new installer); either way the install takes over:

- It removes hivemind's skill links (`~/.claude/skills/hivemind*`, `~/.agents/skills/hivemind*`), its generated agents (`~/.claude/agents/hive-*.md`, `$CODEX_HOME/agents/hive-*.toml`), and merges `~/.claude/hivemind.json` into `proteus.json`. An agent you edited, or a real directory where a link was, stays and is named in the output.
- With `--project` it moves the current repo: removes the `hive-*.js` hooks and their entries in `.claude/settings.local.json` and `.codex/hooks.json`, hivemind's status line, `.codex/rules/hivemind.rules`, and the unedited `teams/templates/hooks/hive-*.js` copies (commit that), renames the lines in `.git/info/exclude`, then installs Proteus for every CLI hivemind was set up for there.
- It lists the other repos under `~/Projects` (`--scan <dir>` for elsewhere, three levels deep) still on hivemind, with the command for each; `--migrate-all` moves them all.

- It moves hivemind's state, `.git/hive/`, into `.git/proteus/` (the inbox, scratch, the lead journal, the lead model). The session start does the same on its own, so a repo you never re-run the installer in still moves. Nothing already in `.git/proteus/` is overwritten. The append-only logs (`journal.jsonl`, `scratch-ledger.jsonl`) on both sides merge: the old lines first, then the new ones, each line once. Any other file on both sides stays in `.git/hive/` (the `.git/proteus/` copy is the one in use), and so does a worktree git still has registered there; the output names each, and `--doctor` keeps showing them until they are gone. In a Codex repo the session start also adds `../<repo>-proteus` to `writable_roots`, or names `install.js --update` when it cannot.

A run opened under hivemind finishes under its old names: the lead, `--status`, scratch and the lead guard read both `hive/<run>` and `proteus/<run>`, so an open `hive/<run>` still counts as the run and its PRs, labels and log issue are still found. New runs use the Proteus names. With Codex, `--project` keeps `../<repo>-hive/` in `writable_roots` beside `../<repo>-proteus/` while git still has a worktree registered there, says why, and drops it on the first `--project` after the last one is gone. The tracker's label step creates the `proteus*` labels in a repo that only has the `hive*` ones and records `labels: proteus`.

Kept as they were: the `hive/<run>` and `hive-evidence/<run>` branches, the `hive*` GitHub labels, and `hive-gates.yml`. A worker worktree already in flight keeps hivemind's hooks until it merges, and the old lines in `.git/info/exclude` stay beside the new ones until then; `--doctor --fix` drops them after. There is no `/hivemind` alias and no `HIVEMIND=0`: use `/proteus` and `PROTEUS=0`.

### Check the install

```bash
node ~/proteus/install.js --doctor         # from a repo root: global and project checks
node ~/proteus/install.js --doctor --fix   # repair links, duplicates, context-mode, hook registration, team skills
```

Each line is `ok`, `WARN`, or `FIX`; the exit code is 1 while a `FIX` remains. It checks Node 22.5+, the context-mode plugin (installed and enabled), the skill links and duplicates, agents, attribution, agent teams, `gh` auth, leftovers from hivemind (and repos still on it), the project hooks, `ROUTING.md`, that every listed team skill resolves, that the commit-msg gate in `lefthook.yml` and `proteus-gates.yml` runs a file git tracks, that `proteus-gates.yml` has no unfilled `EDIT-*` placeholder, whose login the agents post under, and in a project whether a ruleset binds `proteus/*` and the agents' account can push.

### Agents under their own login (recommended)

```bash
node ~/proteus/install.js --agent-login   # once per machine: sign in the agents' GitHub account
cd /path/to/your/repo
node ~/proteus/install.js --protect       # once per repo, as its admin: invite that account, add the ruleset
```

Create the agents' account first, a second GitHub account you control (GitHub allows one machine account per person beside your own), and sign in to it in a private browser window when `gh` shows the device code. `--agent-login` keeps its token in a file in `~/.config/gh-proteus` (only you can read the folder; `gh`'s keyring slot is shared by every config, so a second keyring login would replace yours) and records both logins in `~/.claude/proteus.json`. `--protect` gives the account write access, never admin, and adds the ruleset "proteus runs" (`enforcement.md` §1). Rulesets need a public repo, or a paid plan for a private one.

Git pushes from agent shells go through whatever credential git uses: answer yes when `gh auth login` offers to set up git and HTTPS remotes push as the agents' account too; with SSH they push with your key, and the ruleset still binds them.

### Manual install (any platform)

1. Link or copy `skills/proteus/` and `skills/proteus-review/` to `~/.claude/skills/`. Not also to `<repo>/.claude/skills/`: two copies show up as two commands.
2. Copy `agents/*.md` to `~/.claude/agents/`.
3. Copy `templates/teams/` into your repo as `teams/` and run `node teams/link-skills.js --install`. Copy `templates/` except `templates/teams/` to `teams/templates/` and run `node teams/templates/hooks/install-lead-hooks.js` from the repo root.
4. Merge into `~/.claude/settings.json`:
   ```json
   { "attribution": { "commit": "", "pr": "", "sessionUrl": false } }
   ```
5. Set `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`.

## First run

Open `claude` in a repo where you ran `install.js --project` and hand it the ticket or the idea; the session is already the lead. Anywhere else, type `/proteus`. Bootstrap handles `/setup-matt-pocock-skills`, `CONTEXT.md`, the conventions interview, the skills scout, and `AGENTS.md ## Learned`, then it walks you through grill → spec → tickets → contracts → dispatch → human review. New to it, or just updated? Type `tour` (or `/proteus tour`): a short interactive walkthrough, one stop at a time, questions welcome. The lead offers it on your first sessions and again after an update adds features; once you finish or type `tour off`, it costs no context until the next feature lands. Start with a small, real ticket with 2–3 independent pieces. Note tokens per merged ticket; that is your baseline for tuning the `standard|hard` routing.

## Layout

```
skills/proteus/
  SKILL.md                   entry point, loaded on /proteus
  references/bootstrap.md    blank / mid-project / ready detection and setup
  references/domains.md      the invariants and the domain map: software, video, 3D, writing, research, business
  references/teams.md        roster, PROFILE.md shape, routing, confinement
  references/conventions.md  CONVENTIONS.md interview, taste beyond code
  references/roles.md        worker / contracts / verifier / guide / QA / scout prompts, pre-dispatch check
  references/review.md       milestones, debt, the human review gate
  references/operations.md   status, questions, pause/resume, stall check, revision mode
  references/lessons.md      trigger-based lessons and upstream proposals
  references/docs-diet.md    root-doc budget and where everything else goes
  references/tracker.md      where state lives: GitHub operations table, Jira slot
  references/stack.md        who loads which tool, context meter, worktree lifecycle
  references/enforcement.md  CI, branch protection, hooks, lefthook, semgrep, mutation, OSV, skill lock, baseline ratchet
  references/commits.md      commit message rules
skills/proteus-review/
  SKILL.md                   the human's inbox: questions as pickers, then milestone reviews
agents/
  proteus-worker.md  proteus-verifier.md       generic; read the named team's PROFILE.md first
  proteus-{frontend,backend,devops}-worker.md  proteus-{frontend,backend}-verifier.md   software presets
  proteus-security-verifier.md  second verifier on sensitive tickets
  proteus-qa-verifier.md        per wave, deep per milestone and at close
  proteus-guide.md              review brief + evidence per milestone
  proteus-scout.md              designs the roster and picks skills (lead's tier)
templates/teams/             the shipped roster, copied into your repo's teams/ by install.js --project
  ROUTING.md                 deliverable type or path -> owning team
  link-skills.js (.sh .ps1)  links (or installs) each team's skills
  <team>/PROFILE.md          role, owns, rules, green additions, verifier checklist
  <team>/skills.txt          <owner/repo> <skill> lines; links land in .claude/skills/ and .agents/skills/ (git-ignored)
  <team>/required.txt        pipeline-required skills; the scout never edits it
  skills-lock.json           content hash per linked skill
  baseline.json              per-gate findings recorded by proteus-baseline.js (only when a gate started red)
templates/
  ci/proteus-gates.yml  lefthook.yml   the gates run teams/templates/hooks/commit-msg.js
  hooks/                     copied to .claude/hooks/ by install-lead-hooks.js:
    proteus-autostart.js    SessionStart: makes the session the lead, prints proteus-state
    proteus-lead-guard.js   the lead never edits deliverables
    proteus-journal.js      logs human decisions and hand edits to the run log
    proteus-lessons.js      trigger-based lesson recall
    proteus-stall.js  proteus-worker-guard.js  no waiting on background jobs, one report per agent
    proteus-status.js  proteus-inbox.js  proteus-statusline.js   status, open questions, status line
    proteus-gh.js           gh writes with backoff on GitHub's secondary rate limits
    proteus-verdict.js      reads a verdict or answer only from the human's login
    proteus-worktree.js     prepares a worker worktree and its hooks
    proteus-scratch.js      ledgers and sweeps agents' temp files
    proteus-baseline.js     baseline ratchet: a gate fails only on findings not in teams/baseline.json
    proteus-owned-paths.js  proteus-owned-check.js  commit-msg.js  proteus-lib.js   shared core
    proteus-harness.js  proteus-harness-claude.js   CLI adapter (PROTEUS_HARNESS picks it)
install.js                   installer, updater, doctor (install.sh / install.ps1 wrap it)
tests/hooks.test.js          node tests/hooks.test.js: hooks and installer against temp repos and a fake gh
```

## Uninstall

Delete the links `~/.claude/skills/proteus` and `~/.claude/skills/proteus-review` (the checkout stays), `~/.claude/agents/proteus-*.md`, `~/.claude/proteus.json`, `teams/` in any repo, and the `proteus-` entries and Proteus `statusLine` in its `.claude/settings.local.json`. `.github/workflows/proteus-gates.yml`, `lefthook.yml`, and `.claude/hooks/` are yours to keep or drop; local run state is in `.git/proteus/`. Open `proteus` and `proteus-*` issues and labels stay on GitHub for you to close. Skills you confined are still in `~/.agents/skills/`; re-link them into `~/.claude/skills/` if you want them global again. Remove the `attribution` key from `~/.claude/settings.json` if you want the default trailer back.

For Codex, also delete the links `~/.agents/skills/proteus` and `proteus-review`, `$CODEX_HOME/agents/proteus-*.toml`, and in each repo the `proteus-` entries in `.codex/hooks.json`, `.codex/hooks/`, `.codex/rules/proteus.rules`, and the `<repo>-proteus` entry in `.codex/config.toml`'s `writable_roots`. `codex mcp remove context-mode` drops context-mode.

## License

MIT

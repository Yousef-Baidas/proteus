# How Proteus works

A Claude Code skill that ships a large project as a team of agents: software, video or audio editing, 3D and rendering, writing, research, or business planning. A **lead that only decides** designs teams that mirror the real-world roles a studio or firm would staff, **parallel workers in git worktrees** deliver, **a verifier per ticket** gates every merge (two when the ticket touches auth, input, secrets, I/O, money, or personal data), and **you gate every milestone**. Agents never talk to each other; they share tickets, contracts, and reports on GitHub.

Built on top of the [mattpocock-skills](https://github.com/mattpocock/skills) workflow (`/grilling` → `/to-spec` → `/to-tickets` → `/tdd` → `/code-review`) and Claude Code's Agent Teams.

## Why

The usual multi-agent loop bleeds tokens in three places: the lead sits inside the fix loop, verification happens after handoff instead of inside the worker, and agents chat. Proteus fixes all three:

- The lead decides, writes prompts, and dispatches. It produces no deliverable, not even the contract stubs, and never reads diffs. A hook refuses its edits.
- Workers run their team's checks themselves (typecheck, lint, tests on code; render probes, loudness, link checks, model recompute elsewhere), loop to green, and cap at 2 retries. Every check is shown failing on deliberately broken input before any worker starts, so a green check means something.
- Escalation sends only the diff plus failing output to a fresh-context verifier. One pass.
- Tickets dispatch as soon as their dependencies merge, in parallel, one git worktree each, merged in batches with one suite run per batch and a bisect when it goes red.
- The lead is whatever model you start the session on, and nothing runs above it (see [Models](#models)). Hard tickets and every verdict run on the lead's tier, standard tickets one rung down. A hook refuses any other spawn.
- The change's tier decides the pipeline. A docs typo (Direct) is one cheap helper, mechanical docs gates and a batched PR you merge; a small one-team change (Quick) is one worker; Standard and Full run the whole loop. Paths decide the tier, by the `tiers` block in `teams/ROUTING.md`; the pre-commit hook and CI refuse a change that outgrew it. `quick:` or `full:` in front of a work order overrides. Within a tier no step is skipped or added unless you say so or a `/research` finding does.

What the skill costs in context: [costs.md](costs.md).

## Any kind of project

The pipeline is the same everywhere; the teams, deliverables, and checks change with the domain (`references/domains.md`). On a software repo the shipped teams (frontend, backend, devops, security, qa) apply, each only where the repo shows evidence for it: setup leaves out a frontend in a repo with no UI and says why (`references/teams.md`, Fit signals). On anything else, `proteus-scout` (the lead's tier) reads the project and proposes a roster of real-world roles: for a Blender scene, art direction, modelling, materials, lighting, camera, render/post; for a business plan, market research, financial modelling, strategy, legal/risk, editing. Each team gets an `Owns` line, its own checks (mechanical first, a rubric for taste), research sources a senior in that role trusts, a `CRAFT.md` playbook with cited numbers, and skills from [skills.sh](https://skills.sh) picked for this project's specifics. You approve the roster before anything is written.

Three rules hold in every domain: everything reproducible lives in git (scripts, sources, manifests; nothing only in `out/` or a GUI session); every check can go red; every probe prints what it measured. Tickets that rest on outside facts start with `/research` and cite primary sources.

## Starts itself

`install.js --project` registers the lead's hooks in the repo's `.claude/settings.local.json` (machine-local, untracked):

- **Autostart.** Every session opened in the repo begins as the lead, skill loaded, no `/proteus` typed. It prints a `proteus-state` line from local files (docs present, skills scouted and linked, gates installed, open `proteus/*` branches, root docs over budget, lessons, Proteus updates), so the lead skips what is already set up.
- **Lead guard.** On the main thread, edits inside the repo are refused except `CONTEXT.md`, `CONVENTIONS.md` (written at bootstrap; later only with your approval), `AGENTS.md`, ADRs, and lessons (never `CLAUDE.md`: that is yours, and a docs-diet worker edits it); an Agent call with no model, above the lead's, on a once-per-project model, or under the floor is refused; `gh … --edit-last` is refused (every agent posts as you, so an edit can overwrite a ruling), and so is an agent's comment opening with `ACCEPT`, `CHANGES` or `ANSWER`: those are your words. In the lead and every subagent it refuses `gh pr merge --admin`, a push to `main` or to an existing run branch (creating `proteus/<run>` passes), deleting either, and any change to branch protection or a ruleset other than the per-run protection PUT. The lead does not open images itself (each render costs it ~1.5k tokens; a subagent or you judge it) unless you name the file. Inside subagents it refuses `run_in_background` and `Monitor` (a worker that waits on a background notification never wakes up), any edit outside the worker's owned paths or in another worker's worktree, a force-push to any branch, `git -C` aimed outside the worker's own worktree, and a shell write (`sed -i`, a redirect, `tee`, `cp`, `mv` and the like) to `.claude/`, `.codex/`, `.agents/`, `.git/`, lefthook config, CI workflows and actions, or the gate scripts. That covers the command `xargs` or `find -exec` runs, `git checkout`/`restore` of those paths from another commit, `git apply`, `git am`, `patch` and `git stash pop` that would write them, `rm -r`/`mv`/`rsync` of a dir that holds them, and a force-push set up through git config or the API. What the shell parser cannot read (a `python -c` or `node -e` write, a path in a variable) is caught after the call: the guard compares those paths, and the other workers' idle worktrees, with a snapshot taken before it, blocks the agent until it puts them back, and the verifier cannot sign off MERGE on that branch meanwhile.
- **Journal and meter.** Every message you type is kept verbatim in `.git/proteus/`, except that secrets (GitHub, Anthropic, OpenAI, AWS and Slack tokens, JWTs, private key blocks, `Authorization:` headers, `password=`/`token=`-style assignments) are stored as `[redacted]`, so a pasted key is not re-injected after a compaction; context is metered from the transcript, with a warning at 75% of the lead's context window and a hard stop on new dispatch at 90% (150k and 180k on a 200k window). The window is the smallest of the model's own (1M for Fable, Opus 5.5 and Sonnet 5.5 or a `[1m]` id, 200k for Haiku), the cap you set (`autoCompactWindow` or `CLAUDE_CODE_AUTO_COMPACT_WINDOW` in Claude Code, `model_auto_compact_token_limit` in Codex) and `"contextWindow"` in `~/.claude/proteus.json`; `PROTEUS_HANDOFF_AT` and `PROTEUS_HANDOFF_HARD` set the lines in tokens.
- **Lessons.** Solved problems are recalled only when their trigger fires (below).
- **Stall check.** A worker that ends its turn "waiting" instead of reporting is sent back to finish.
- **Scratch.** Agents keep temp files, renders and worktrees in a per-ticket dir under `.git/proteus/scratch/`, which the guards let every agent write to during a run, and anything they leave directly in `/tmp` is ledgered. Both are deleted when the ticket merges or the run closes, with a background sweep for what is left behind; nothing Proteus did not create is touched.
- **Status line.** `proteus: 2 questions · 1 review` at the bottom of the terminal while anything waits on you, and `proteus: update ready` when a newer release is out, appended to your own status line.

`PROTEUS=0 claude` opens a plain session with none of them, for the review session or for working by hand.

The hooks are CommonJS. A `package.json` of `{"type": "commonjs"}` goes beside them (`.claude/hooks/`, `teams/templates/hooks/`, a worker's worktree) and beside `teams/link-skills.js`, so they still run in a repo whose own `package.json` sets `"type": "module"`. The one in `teams/templates/hooks/` is committed with the rest, for CI's commit-msg gate.

## Models

The session you start is the lead, on whatever model you started it with, and it staffs down from there on a ladder, cheapest first: `haiku < sonnet < opus < fable`. Roles map to three tiers. `judge` takes the work that needs sustained judgment: verifiers, the scout, contracts, escalations, merge conflicts, and QA at milestone and close. `build` implements every ticket. `helper` runs QA per wave, the guide, research and small reads. The autostart prints `models=lead:…,judge:…,build:…,helper:…`; the guard enforces the ladder on every spawn.

| You start on | Lead | `judge` | `build` and `helper` |
|---|---|---|---|
| Fable | Fable | Opus | Sonnet |
| Opus | Opus | Opus | Sonnet |
| Sonnet | Sonnet | Sonnet | Sonnet |

- Nothing runs above the lead. A worker may run on the lead's own model.
- Fable is once per project: the lead is its one instance, so a Fable lead staffs Opus and below. Claude Mythos is Fable offered under another name (Project Glasswing), so a `claude-mythos-*` id sits on Fable's rung. Lift it with a line in `AGENTS.md` under `## Learned`: `models: solo=none`.
- The floor is Sonnet, so Haiku is under it: it does not produce or review work until it earns it. `models: floor=haiku` in `AGENTS.md` lowers the floor for a project; a Haiku lead lowers it on its own, so everything runs on Haiku.
- Machine-wide defaults live in `~/.claude/proteus.json`: `"models": { "ladder": ["haiku", "sonnet", "opus", "fable"], "floor": "sonnet", "solo": ["fable"], "aliases": { "mythos": "fable" }, "tiers": { "judge": "top", "build": "mid", "helper": "mid" } }` (aliases are other names of a rung's model, merged over the defaults). Claude Code passes a subagent's model as one of these aliases, so a rung is a family, not a version.
- A tier is `top` (the highest rung the lead may staff), `mid` (one under it), a rung or a full model id, optionally with `@effort`; it is kept between the floor and `top`. `models: build=opus judge=opus` in `AGENTS.md` sets them for a project. Tiers are independent, so a verifier can run on a different family from the worker, including a different vendor's when the ladder names both.
- Effort: Claude Code's Agent tool takes no effort per spawn, so the verifiers and the scout carry `effort: high` in their agent files and the rest run at the session's effort. Codex passes it per spawn (`reasoning_effort`): with no ladder every tier runs on the lead's model, `judge` at high, `build` at medium, `helper` at low.

## Asks before it guesses

Before any spec the lead must be able to state six things without guessing: the outcome you will see, how you will check it is done, what is out of scope, the areas and teams touched, the constraints, and that no question is open. Any blank and it grills you (`/grill-with-docs`, or `/grilling` on a blank repo), one question at a time. Work bigger than a milestone or a session goes through `/wayfinder` first. Unattended, a work order with a blank is parked, never assumed.

Until you approve the spec the lead is free to explore: it can add spikes, prototypes, research, competing designs sketched by helpers or a devil's-advocate pass, and it can propose a bolder direction or a different scope. That work is thrown away. Once the spec is approved the tier's steps run in order, and skipping one needs your word, a research finding or a settled default, logged on the run log. Workers on `standard` and `hard` tickets choose the design inside their contract and owned paths and favour clear, well-made code over the fewest lines; the minimal-code style is kept for Quick and mechanical tickets.

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

Say you are going to sleep, away, or not to wait. The lead prints one warning, what you lose and what stays protected, and continues only on the literal reply `UNATTENDED` (optionally `until 09:00` or `for 3 milestones`). Then at each gate the guide runs the acceptance checks fixed from your answers before work started, plus its own steps, and captures evidence; a fresh grader on a different model judges it and writes `AUTO-ACCEPT` or, on any failed check or step it could not execute, `AUTO-HOLD`, which stops the run and pings you. Every auto-accepted milestone keeps its `needs-human` label; when you are back, `/proteus-review` walks you through them with the evidence and your retroactive `CHANGES` become tickets. Unattended never merges into `main`, approves a dependency, installs a skill, or edits `CONVENTIONS.md`, and it stops on its own at five unreviewed milestones. See `references/review.md`.

## No state in the repo

Proteus writes nothing to your repo but deliverables, checks, contract stubs, lessons, ADRs, and three docs a human wants anyway: `CONTEXT.md`, `CONVENTIONS.md`, `AGENTS.md`. Tickets are issues, the wayfinder map is an issue, the run log is an issue, milestones are milestones, worker reports and `NEEDS` questions are issue comments, verifier verdicts are PR reviews on a per-ticket PR into `proteus/<run>`, review briefs are issues labelled `proteus-review`, the human's verdict is a comment, the unattended queue is the `needs-human` label. Screenshots go to an orphan `proteus-evidence/<run>` branch that is deleted when the run merges. The Agent Teams task list is only a runtime mirror; if the session dies, nothing is lost.

The lead itself edits only those docs; anything else goes to a worker. For small housekeeping you can widen that with a line in `AGENTS.md`, beside `models:`: `lead-edits: .vscode/* .editorconfig .gitattributes .gitignore`. The globs are relative to the repo root (`*` within a folder, `**` at any depth), and the lead edits matching files directly, on Claude Code and Codex alike. Whatever the line says, the guard still refuses `.claude/`, `.codex/`, `.agents/`, `.git/`, `teams/` (the commit-msg gate and the gate scripts), lefthook's config, `.github/workflows/` and `.github/actions/`, a path that is a link, and one whose real location is outside the repo or on that list. Case, trailing dots and Windows short names do not get around it. In guest mode the line sits in the guest dir's `AGENTS.md` and still names the repo's own files.

The tracker is GitHub via `gh` today. `references/tracker.md` is an operations table with one column per tracker; Jira or anything else slots in by filling the column.

### Worker worktrees

Each worker works in its own git worktree under `.worktrees/<id>/` in your checkout (`.worktrees/direct-<batch>` and `.worktrees/quick-<n>` for the Direct and Quick tiers). `proteus-worktree.js` adds `/.worktrees/` to `.git/info/exclude`, never to `.gitignore`, so `git status` and `git add -A` in the main checkout skip it. A run started under Proteus 1.1 or earlier keeps its worktrees in `../<repo>-proteus/` until they merge; on Codex that folder stays in `writable_roots` until then. `git clean -ffdx` in the main checkout deletes the nested worktrees with everything else.

Some tools walk into `.worktrees/` from the main checkout and run or lint the workers' copies too. Proteus runs the full suite and the bisect from `.worktrees/_run`, a detached checkout with nothing nested in it, and `proteus-gates-cache.js` warns when it runs a command in a folder that holds worktrees. For your own runs from the main checkout, add `.worktrees/` to the ignores of each tool marked yes:

| Tool | Walks into `.worktrees/` | Why (default config) | Ignore it with |
|---|---|---|---|
| vitest 4 | yes | exclude is `**/node_modules/**`, `**/.git/**` | `test.exclude`, keeping `configDefaults.exclude` |
| vite watcher, vitest watch | yes | ignores `.git`, `node_modules` and build output only | `server.watch.ignored` |
| jest 30 | yes, plus a haste naming collision on the copied `package.json` | `testPathIgnorePatterns` is `/node_modules/`; haste skips only VCS folders | `testPathIgnorePatterns`, `modulePathIgnorePatterns` |
| eslint 9, flat config | yes | ignores `**/node_modules/`, `.git/`; never reads git's ignores | `globalIgnores([".worktrees/"])` |
| webpack, chokidar watch | yes | no default ignore | `watchOptions.ignored` |
| cargo | only with `members = ["*"]`, which then fails to load `.worktrees` | the glob matches dot folders | `exclude = [".worktrees"]` |
| oxlint 1.x | no | walks hidden folders but honors git's ignores, `info/exclude` included | |
| ripgrep | no | skips hidden folders and honors `info/exclude` | |
| tsc 5 | no | `**` never matches a folder whose name starts with a dot | |
| pytest | no | `norecursedirs` has `.*` | |
| go | no | `./...` skips `.` and `_` folders; a nested `go.mod` is its own module | |

Run from a main checkout holding a worktree at `.worktrees/x`, on vitest 4.1, jest 30.5, eslint 9.39, oxlint 1.88, vite 8.3, tsc 5.9, pytest 9.1, go 1.27, cargo 1.99 and ripgrep 15.2. Sources: vitest `defaultExclude`; jest-config `testPathIgnorePatterns` and jest-haste-map `VCS_DIRECTORIES`; eslint `lib/config/default-config.js`; oxlint `apps/oxlint/src/walk.rs`; vite `resolveChokidarOptions`; the TypeScript `**` matcher; pytest `norecursedirs`; `go help packages`; the Cargo workspace docs; `rg --help`.

Not under `.git/`, which every tool above skips: Claude Code treats `.git` as a protected path, so each edit there asks outside bypass mode, and Codex's workspace-write sandbox keeps `<root>/.git` read-only, so a Codex session opened at the repo could not edit a worktree there.

## Commit rules

Every agent commits with terse, professional [Conventional Commits](https://www.conventionalcommits.org/). **No AI attribution and no `Co-Authored-By` by default.** See [`skills/proteus/references/commits.md`](../skills/proteus/references/commits.md). The installer sets `attribution` in `~/.claude/settings.json` so Claude Code stops offering the trailer. A repo whose own rules require the trailer opts in with the line `attribution: allow` in its `CONVENTIONS.md`: the hook then lets AI trailers through, in local commits and in CI. Its agents still need Claude Code to add the trailer there, so set `attribution` in that repo's `.claude/settings.json` (project settings override `~/.claude/settings.json`). To keep your own machine-wide attribution setting, put `"attribution": "keep"` in `~/.claude/proteus.json`; install, update and `--doctor` then leave it alone.

## First run

Open `claude` in a repo where you ran `/proteus:setup` (or `install.js --project`) and hand it the ticket or the idea; the session is already the lead. Anywhere else, type `/proteus:proteus` (`/proteus` on the installer path). Bootstrap handles `/setup-matt-pocock-skills`, `CONTEXT.md`, the conventions interview, the skills scout, and `AGENTS.md ## Learned`, then it walks you through grill → spec → tickets → contracts → dispatch → human review. New to it, or just updated? Type `tour` (or `/proteus tour`): a short interactive walkthrough, one stop at a time, questions welcome. The lead offers it on your first sessions and again after an update adds features; once you finish or type `tour off`, it costs no context until the next feature lands. Start with a small, real ticket with 2–3 independent pieces. Note tokens per merged ticket; that is your baseline for tuning the `standard|hard` routing.

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
  ROUTING.md                 deliverable type or path -> owning team; path -> tier ceiling
  link-skills.js (.sh .ps1)  links (or installs) each team's skills
  proteus-confine.js         its write and delete guard, copied from templates/hooks/
  package.json               {"type": "commonjs"}: the link script runs in a "type": "module" repo
  <team>/PROFILE.md          role, owns, rules, green additions, verifier checklist
  <team>/skills.txt          <owner/repo> <skill> lines; links land in .claude/skills/ and .agents/skills/ (git-ignored)
  <team>/required.txt        pipeline-required skills; the scout never edits it
  skills-lock.json           content hash per linked skill
  .proteus-base.json         hash of the shipped ROUTING.md, PROFILE.md, skills.txt each copy came from
  baseline.json              per-gate findings recorded by proteus-baseline.js (only when a gate started red)
templates/
  ci/proteus-gates.yml  lefthook.yml   the gates run teams/templates/hooks/commit-msg.js
  ci/proteus-trust.yml                 the security trigger, run from the base branch
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
    proteus-tier.js         classifies a change's tier; fails one that outgrew it
    proteus-scratch.js      ledgers and sweeps agents' temp files
    proteus-skillpath.js    finds a plugin skill's SKILL.md (plugin cache, skills folders, $PROTEUS_SKILL_DIRS)
    proteus-gates-cache.js  runs a gate once per clean tree and command; a pass is replayed, a failure never
    proteus-watchdog.js     wakes the lead only for a worker silent too long or stopped without a report
    proteus-close-report.js bounce and escalation rates, wall-clock and cost per ticket at close
    proteus-baseline.js     baseline ratchet: a gate fails only on findings not in teams/baseline.json
    proteus-agent-patch.js  writes a project's .claude/proteus-agents.json patches over the shipped agents
    proteus-owned-paths.js  proteus-owned-check.js  commit-msg.js  proteus-lib.js   shared core
    proteus-confine.js      the installers' write and delete guard: no link between an owned root and the path
    proteus-harness.js  proteus-harness-claude.js   CLI adapter (PROTEUS_HARNESS picks it)
    package.json            {"type": "commonjs"}: the hooks run in a "type": "module" repo
install.js                   installer, updater, doctor (install.sh / install.ps1 wrap it)
tests/hooks.test.js          node tests/hooks.test.js: hooks and installer against temp repos and a fake gh
```

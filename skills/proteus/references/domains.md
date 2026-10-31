# Domains

The pipeline is the same for every project: grill → spec → tickets → contract and check → worker → verifier → merge → human gate. What changes per domain is the teams, the deliverable, and what a check is. Software is one domain among several; do not force code vocabulary onto an edit, a render, or a business plan, and do not drop a gate because the work is not code. The Principles block in `roles.md` (the simplest thing that meets the contract, no option or file without a caller, one source of truth, delete before you add, leave it no worse) binds non-code teams too.

## The three invariants

1. **Everything reproducible lives in git.** Text, scripts, project files, specs, data manifests. A deliverable that only exists in a GUI session, a `/tmp` dir, or an `out/` folder does not exist. Large binaries: Git LFS, or reproduced from committed scripts plus a manifest of inputs with hashes. A human hand edit to a binary is logged on the run log at once and ported to a script by a ticket before the milestone closes.
2. **Every check can go red.** Where a check can be executed, it is: a script, a linter, a probe, a schema, a render comparison. Where taste decides, the check is a rubric: numbered pass lines, each observable ("title under 60 characters", "key light from the window side", "every figure has a cited source"), scored by the verifier with evidence. The contracts worker shows each check failing on a deliberately broken input before any worker starts.
3. **Probes print what they measured.** Any script that inspects an artifact prints, first line, the absolute path, size or hash, and item count of what it actually opened. A probe whose output cannot prove its input is void. Isolation must be real: worktrees share nothing only if the artifact is in the worktree. A symlinked or absolute-path binary is shared; either one writer per such file per wave, or each worktree builds its own copy from the scripts.

## Domain map

| Domain | Typical teams (real-world roles) | Deliverable in git | Mechanical checks | Rubric covers | Evidence for the human |
|---|---|---|---|---|---|
| software | frontend, backend, devops, data, mobile | code, tests, config | typecheck, lint, tests, dead code, CI (`enforcement.md`) | naming, UX copy | gate output, screenshots, recordings |
| video / audio editing | story editor, assistant editor, colourist, sound mixer, motion graphics, delivery | edit decision list or project file, scripts (ffmpeg, MLT, OTIO), cue sheets | duration, loudness (LUFS), codec and resolution, frame-accurate cuts vs EDL, missing media | pacing, story beats, grade intent, nothing the brief did not ask for | rendered proxies, stills per beat, waveform |
| 3D / render | art direction, scene, modelling, materials, lighting, camera, render/post, QA | pass scripts per team (e.g. bpy), scene manifest, specs | headless build exits clean, object ownership tags, polycount, texture resolution, probe values in bands from references | composition, taste, realism, nothing the brief did not ask for | renders per camera, A/B stills |
| writing / editorial | editor-in-chief, developmental editor, copy editor, fact checker, designer | markdown or docx source, style sheet | spelling, style linter (vale), link check, word counts, reading level, citation present per claim | voice, structure, argument, nothing the brief did not ask for | rendered pages, diff of changes |
| research / analysis | researcher, methodologist, data analyst, reviewer | notebooks or scripts, data manifests, report source | notebook runs clean, numbers recompute, every claim cites a primary source | question answered, limits stated, nothing the brief did not ask for | figures, tables, source list |
| business planning | market researcher, financial modeller, strategist, operations, legal/risk, editor | plan source, model as formulas (spreadsheet or code), assumptions register | model recomputes, formulas have no hard-coded outputs, totals tie out, every assumption sourced and dated | coherence, risks named, decision-ready, nothing the brief did not ask for | model summary, sensitivity table |
| infrastructure-as-code | platform, network, security, SRE | Terraform, Ansible, Helm or Kubernetes manifests | validate, lint (tflint, ansible-lint), policy (checkov), dry run: `terraform plan`, `ansible --check`, `kubectl diff` | blast radius, naming, rollback named, nothing the brief did not ask for | plan or diff output, apply log |
| data / ML notebooks | data engineer, ML engineer, analyst, reviewer | notebooks stripped of outputs, pipeline scripts, data and model manifests with hashes | notebook runs top to bottom on a fixed seed, metrics within the contract's band, schema checks | leakage, baselines compared, limits stated, nothing the brief did not ask for | metric table, plots, run log |
| docs site | technical writer, docs engineer, editor | markdown or MDX source, site config | site builds, link check, style linter, every code sample runs | accuracy, task order, nothing the brief did not ask for | built pages, diff of changes |
| mobile app | iOS, Android, shared UI, release | code, store metadata, signing config without secrets | build per platform, unit and UI tests on a simulator, store metadata lint | platform conventions, accessibility, nothing the brief did not ask for | simulator screenshots, recordings |
| firmware / hardware | firmware, electrical, mechanical, test | firmware source, schematics and layout source (KiCad), BOM | builds for the target, unit tests on host, simulator or hardware-in-the-loop run, ERC/DRC | power, timing and safety margins stated, nothing the brief did not ask for | test logs, scope captures, board renders |
| game development | design, gameplay, art, level, audio, QA | code, scenes and assets (LFS or linked per team), design docs | headless build, unit tests, scripted playthrough on a fixed seed, frame-time budget | feel, readability, difficulty curve, nothing the brief did not ask for | capture video, build for the human to play |

The rows are examples, not a closed list. A project can mix rows (a product launch is software plus writing plus business), and teams come from the rows it needs, nothing more. For a domain not here, the scout fills the same six columns in its roster report; once the human approves, the answer lives where every roster does, in `teams/<team>/PROFILE.md` and `teams/ROUTING.md`.

## Binary and GUI work

One owner per binary file stays the rule, so split the work into linked per-team files: one `.blend` per team linked into a master scene, Photoshop smart objects, spreadsheets that link to each other. The master file belongs to one team, which only re-links. Two teams never edit one binary. A step only a human can operate (a GUI tool with no headless mode, a signature) is a `step:human` ticket (`tracker.md`).

## Nondeterministic and slow checks

Fix the seed first. If no seed can fix it, write a tolerance band into the contract: value, ± band, unit. If neither works, N-of-M with M at most 5, the N and M written into the contract. The check script does the repeating itself, so a gate run stays one command and the gate cache keeps working. A team's `PROFILE.md` may also set `Retries:` (re-runs of a red check, default 0), `Timeout:` (minutes per check) and `Rebuild:` (`per-merge`, the default, `per-wave` or `per-milestone`: how often CI QA rebuilds the full deliverable). All three are prompt-only: the lead and verifiers read them, and no script does.

## Checks that cannot run in a worktree

Live infrastructure, a paid API, hardware. The ticket's check is the dry run in the worktree (a recorded fixture or a simulator too). The live apply is a `step:human` ticket after the merge, and its evidence is the apply log.

## Designing the roster (bootstrap, `proteus-scout`)

The scout reads the repo, `CONTEXT.md`, and the work order, then proposes:

- **Teams**, each a real-world role a studio or firm would hire for this work, one line of what it owns. Four to eight teams for most projects; a team that would own one ticket is merged into another.
- **Per team**: `Owns` (paths, file types, or named parts of a shared artifact), `Never touches`, deliverable format, its checks (mechanical first, rubric second), what its verifier adds, required research sources (standards bodies, official docs, trade references), and skills from skills.sh and installed plugins, at most 4 and 40 KB of combined `SKILL.md` text (`CAP` in `teams/link-skills.js`).
- **`Safety`** for a team whose deliverables change a live system: how agents run them without touching the host, for example privileged steps only inside `unshare -rm` with mocks bound over the real tool paths, no `sudo`. The role prompts paste it into every brief (`roles.md`); a lesson fires only after the first failure.
- **`teams/ROUTING.md`**: deliverable type or path pattern → owning team (`teams.md`).
- **Qa and security** stay cross-cutting. Security's scope in non-code work: personal data, credentials, money movement, legal exposure, anything published.

The human approves the roster before anything links. Then a worker writes each `teams/<team>/PROFILE.md` (rules, 40 lines max) and, where the craft needs it, `CRAFT.md` (the playbook: what a senior in that role does and checks, numbers with their sources, worked examples). `CRAFT.md` is read on demand by that team only, not by the lead. Every number in it cites where it came from; a playbook built from the model's defaults is the thing Proteus exists to avoid.

## Research-backed, not model-backed

Tickets tagged `needs-research` start with `/research`: primary sources first (official docs, standards, datasets, filings, published papers), secondary only to find primaries. The worker's report cites each source it relied on. A finding that should outlive the ticket goes into `CRAFT.md` or an ADR through a ticket; the tracker keeps the rest.

## Taste

Software taste is `CONVENTIONS.md`. Creative and business work has more: the human's house defaults (`conventions.md`). They live in `CONVENTIONS.md` or in a doc it links, are loaded at step 1 into every brief, and are what the test-piece milestone exists to catch early. Every review note that turns out to be a standing preference is added there by the human, or by a ticket the human approves, so no review round teaches the same default twice.

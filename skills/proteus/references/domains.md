# Domains

The pipeline is the same for every project: grill → spec → tickets → contract and check → worker → verifier → merge → human gate. What changes per domain is the teams, the deliverable, and what a check is. Software is one domain among several; do not force code vocabulary onto an edit, a render, or a business plan, and do not drop a gate because the work is not code.

## The three invariants

1. **Everything reproducible lives in git.** Text, scripts, project files, specs, data manifests. A deliverable that only exists in a GUI session, a `/tmp` dir, or an `out/` folder does not exist. Large binaries: Git LFS, or reproduced from committed scripts plus a manifest of inputs with hashes. A human hand edit to a binary is logged on the run log at once and ported to a script by a ticket before the milestone closes.
2. **Every check can go red.** Where a check can be executed, it is: a script, a linter, a probe, a schema, a render comparison. Where taste decides, the check is a rubric: numbered pass lines, each observable ("title under 60 characters", "key light from the window side", "every figure has a cited source"), scored by the verifier with evidence. The contracts worker shows each check failing on a deliberately broken input before any worker starts.
3. **Probes print what they measured.** Any script that inspects an artifact prints, first line, the absolute path, size or hash, and item count of what it actually opened. A probe whose output cannot prove its input is void. Isolation must be real: worktrees share nothing only if the artifact is in the worktree. A symlinked or absolute-path binary is shared; either one writer per such file per wave, or each worktree builds its own copy from the scripts.

## Domain map

| Domain | Typical teams (real-world roles) | Deliverable in git | Mechanical checks | Rubric covers | Evidence for the human |
|---|---|---|---|---|---|
| software | frontend, backend, devops, data, mobile | code, tests, config | typecheck, lint, tests, dead code, CI (`enforcement.md`) | naming, UX copy | gate output, screenshots, recordings |
| video / audio editing | story editor, assistant editor, colourist, sound mixer, motion graphics, delivery | edit decision list or project file, scripts (ffmpeg, MLT, OTIO), cue sheets | duration, loudness (LUFS), codec and resolution, frame-accurate cuts vs EDL, missing media | pacing, story beats, grade intent | rendered proxies, stills per beat, waveform |
| 3D / render | art direction, scene, modelling, materials, lighting, camera, render/post, QA | pass scripts per team (e.g. bpy), scene manifest, specs | headless build exits clean, object ownership tags, polycount, texture resolution, probe values in bands from references | composition, taste, realism | renders per camera, A/B stills |
| writing / editorial | editor-in-chief, developmental editor, copy editor, fact checker, designer | markdown or docx source, style sheet | spelling, style linter (vale), link check, word counts, reading level, citation present per claim | voice, structure, argument | rendered pages, diff of changes |
| research / analysis | researcher, methodologist, data analyst, reviewer | notebooks or scripts, data manifests, report source | notebook runs clean, numbers recompute, every claim cites a primary source | question answered, limits stated | figures, tables, source list |
| business planning | market researcher, financial modeller, strategist, operations, legal/risk, editor | plan source, model as formulas (spreadsheet or code), assumptions register | model recomputes, formulas have no hard-coded outputs, totals tie out, every assumption sourced and dated | coherence, risks named, decision-ready | model summary, sensitivity table |

A project can mix rows (a product launch is software plus writing plus business). Teams come from the rows the project needs, nothing more.

## Designing the roster (bootstrap, `proteus-scout`)

The scout reads the repo, `CONTEXT.md`, and the work order, then proposes:

- **Teams**, each a real-world role a studio or firm would hire for this work, one line of what it owns. Four to eight teams for most projects; a team that would own one ticket is merged into another.
- **Per team**: `Owns` (paths, file types, or named parts of a shared artifact), `Never touches`, deliverable format, its checks (mechanical first, rubric second), what its verifier adds, required research sources (standards bodies, official docs, trade references), and skills from skills.sh and installed plugins, at most eight.
- **`teams/ROUTING.md`**: one row per deliverable type or path pattern → owning team. The lead routes by this table only; a ticket with no matching row is a question for the human, then a new row.
- **Qa and security** stay cross-cutting. Security's scope in non-code work: personal data, credentials, money movement, legal exposure, anything published.

The human approves the roster before anything links. Then a worker writes each `teams/<team>/PROFILE.md` (rules, 40 lines max) and, where the craft needs it, `CRAFT.md` (the playbook: what a senior in that role does and checks, numbers with their sources, worked examples). `CRAFT.md` is read on demand by that team only, not by the lead. Every number in it cites where it came from; a playbook built from the model's defaults is the thing Proteus exists to avoid.

## Research-backed, not model-backed

Tickets tagged `needs-research` start with `/research`: primary sources first (official docs, standards, datasets, filings, published papers), secondary only to find primaries. The worker's report cites each source it relied on. A finding that should outlive the ticket goes into `CRAFT.md` or an ADR through a ticket; the tracker keeps the rest.

## Taste

Software taste is `CONVENTIONS.md`. Creative and business work has more: the human's house defaults (a camera height, a brand voice, a margin floor, a reading level). They live in `CONVENTIONS.md` or in a doc it links, are loaded at step 1 into every brief, and are what the test-piece milestone exists to catch early. Every review note that turns out to be a standing preference is added there by the human, or by a ticket the human approves, so no review round teaches the same default twice.

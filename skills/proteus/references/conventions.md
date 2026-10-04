# Conventions

Every worker works to `CONVENTIONS.md` at the repo root; every verifier checks the diff against it. Never assume taste. Missing file → interview before any ticket. The file is the human's; agents edit it only when the human says so.

## Interview (bootstrap, once)

1. Mid-project: spawn `proteus-backend-worker` on `helper` with: "Draft `CONVENTIONS.md` from evidence only: linter and formatter configs, three representative source files per language, test file names, commit log style. Mark every rule `observed` or `guess`. No opinions." Blank repo: skip, all rules are open.
2. Ask the human, `AskUserQuestion` (Codex: plain numbered questions), in batches of at most four, only what the draft left as `guess` or open. Checklist:
   - naming: files, directories, variables, functions, types, constants, DB tables/columns, env vars, branch names
   - layout: feature folders vs layers, where tests live, barrel files yes/no, max file length
   - style: formatter and its config, semicolons/quotes/trailing commas or the language equivalent, import order, line width
   - errors: exceptions vs result types, logging library and levels, what is fatal
   - comments: when allowed, docstring style, TODO format
   - tests: runner, file naming, unit vs integration split, mocking policy, coverage floor
   - types: strictness flags, `any`-style escapes allowed or not, validation at boundaries
   - dependencies: who approves new ones, pinned or ranged, forbidden libraries
   - commits: scope names for Conventional Commits, PR size ceiling
   - anything the human wants forbidden outright
3. Write `CONVENTIONS.md`: one rule per line, grouped by the headings above, examples inline (`user_id` not `userId`). No prose, no rationale; the human owns the why. Commit `chore: add CONVENTIONS.md`.
4. Add to `AGENTS.md ## Learned`: "Work to CONVENTIONS.md. Verifier fails the ticket on a deviation."

## Taste beyond code

Creative, editorial, and business work carries more taste than naming and layout, and it arrives late unless asked for early. For those domains the checklist above is replaced or extended by the house defaults, asked the same way (batches of four, only what evidence leaves open):

- references: three to five examples the human loves and one they hate, with what makes each so
- 3D and render: camera height and lens, framing, lighting direction and mood, materials realism, props always present, scale, handles and details on the hero object, output resolution and format
- video and audio: pacing, cut style, colour look, loudness target, music policy, captions, delivery specs
- writing: voice, reading level, person and tense, formatting, citation style, banned words, length
- business: audience, decision the document must enable, currency and units, rounding, optimism policy for assumptions, risk appetite
- anything the human wants forbidden outright

Longer material (reference images, a brand book) lives in a doc `CONVENTIONS.md` links, for example `docs/taste/`. Every brief names these docs; the test-piece milestone (`review.md`) is where they get checked first.

## Enforcement

- Worker prompt (roles.md) reads `CONVENTIONS.md` and its taste docs after `PROFILE.md` and `CRAFT.md`. A rule in the file beats a rule in a skill.
- Verifier: any deviation is `BACK-TO-WORKER` with the rule quoted. Not a nit; a red.
- Lint config drifts from the file → stabilise ticket, not a silent edit.
- Human changes taste mid-run → they edit the file; the lead re-dispatches nothing already merged and logs the change on the run log.

# Human review gate

Agents verify tickets; the human verifies milestones. The loop halts at every gate until a verdict exists. One ticket is one milestone; no run is too small.

The lead never talks the human through a review. It has no diff, and every relayed line costs it twice. The human talks to the **review session** or to the review issue.

## Milestones

At step 2, after `/to-tickets`, one tracker milestone per user-visible feature or stated task, `<run>/<name>`, each with its debt issue (`tracker.md`). Tickets belong to exactly one. Dependency order.

Each milestone's acceptance checks are frozen when it is created: gate (b) from step 1 as numbered steps with expected results, posted once on the run log as `ACCEPTANCE <run>/<name>` and never edited (a `CHANGES` round's milestone gets its own). The guide puts them first under **Verify it**, and the unattended grader judges by them. Checks written after the work tend to describe what was built, not what was asked.

Taste-driven runs (anything the human judges by eye or ear: a scene, an edit, a brand, a document's voice) start with a **test piece**: the smallest deliverable that exercises every house default at once (for a scene: the hero object with its handles, the camera, the props, the lighting direction; for an edit: one finished minute; for a plan: one section with its numbers). It is always a human gate, even unattended; nothing after it starts until it is `ACCEPT`ed. Taste notes caught there cost one ticket; caught at milestone four they cost a rebuild.

## Gate

Fires after the last ticket of a milestone merges into `proteus/<run>` and QA says `WAVE-GREEN`.

1. Spawn `proteus-guide` with run, milestone, ticket numbers, diff range, QA verdict, gate commands, mode, debt issue, the `ACCEPTANCE` comment. It opens the review issue `Review: <run>/<milestone>` (label `proteus-review`, `needs-human`) with the brief, evidence links, and the open debt lines, so the human sees what was deferred, exits.
2. `PushNotification`: `review ready: <milestone> — <issue url>`. Print the url and `PROTEUS=0 claude → /proteus-review` in a second terminal (or `/remote-control` from the phone); on Codex `PROTEUS=0 codex → $proteus-review`.
3. Wait: a background shell with the poll from `tracker.md` (Codex: `harnesses.md`), until a verdict comment exists. Idle context costs nothing. Dispatch only **speculative** tickets: next-milestone tickets whose owned paths miss every file this milestone changed (`git diff --name-only <merge-base>..proteus/<run>`), labelled `speculative` and logged on the run log. They run steps 3 to 6 now; their PRs merge only after `ACCEPT`, so a `CHANGES` costs their work, never a wrong merge. `CHANGES` → close the PR of each one whose paths or `depends-on` the changes touch and dispatch it again after the round. Never after a test piece, which nothing follows until `ACCEPT`.
4. Verdict comment, first line:
   - `ACCEPT` → remove `needs-human`, close review issue and milestone, next milestone. Last one → step 8.
   - `CHANGES` → every following line is a ticket via step 2 (contract, check, team, difficulty), one wave, milestone `<name>-r2`. Back to step 3; the gate fires again. When every line is a small tweak inside one team's paths, or the human asks to go faster, use revision mode instead (`operations.md`): same gate at the end, no improvised scripts outside git.
   - anything else is not a verdict; keep waiting.

## Channels

Any of these produce the verdict comment; the lead does not care which.

| Channel | How |
|---|---|
| review session | second terminal, `PROTEUS=0 claude --model sonnet`, `/proteus-review` (Codex: `PROTEUS=0 codex`, `$proteus-review`; `PROTEUS=0` keeps the lead autostart and guard out of it). Fresh session with the issue, the diff, and the evidence; chats, runs steps on request, posts the verdict when told. Zero lead tokens. |
| phone | `/remote-control` on the review session, or the GitHub app: read the issue, comment `ACCEPT`. |
| issue only | read the brief on GitHub, comment `ACCEPT` or `CHANGES` + lines. No AI involved. |
| evidence only | open the linked screenshots, then comment. |

## Unattended

The human may say so in words: "going to sleep", "away until 9", "don't wait for me", "unattended". Before honouring it, print this, plain, once:

> **Unattended mode.** Human review gates will be auto-accepted. What you lose: nobody checks that the feature is the feature you meant, only that it is green and consistent. Wrong assumptions compound across milestones; a bad contract in milestone 1 ships into milestone 4. Every auto-accepted milestone stays labelled `needs-human` with evidence, nothing merges into `main`, and any worker `NEEDS` question parks its ticket instead of guessing. Reply `UNATTENDED` (optionally `until <time>` or `for <n> milestones`) to confirm, or anything else to stay attended.

Only the literal word confirms. Then, per gate:

1. Guide runs as usual **plus** executes every verify step, the frozen checks unchanged: Playwright MCP or `playwright-cli` screenshots per step where a UI exists, CLI transcripts otherwise. A step it cannot execute goes under `## Not verified`. It judges nothing.
2. Then the grader: `proteus-guide` in mode `grade` on `top` (the guide runs on `mid`), fresh context. It compares the evidence with each frozen check, re-runs any whose evidence is unclear, and comments `AUTO-ACCEPT` only if every frozen check passed and `## Not verified` is empty; else `AUTO-HOLD` with reasons. An agent that writes the steps and judges them grades itself. Where `top` and `mid` are one model (Sonnet lead, `models=unknown`) the grader still runs fresh, and the run log notes `same-model grade`. Lead: `AUTO-ACCEPT` → close the milestone, keep `needs-human`, continue. `AUTO-HOLD` → open review; stop; `PushNotification`; wait.
3. When unattended ends (time, count, or the human speaks): list `gh issue list --label needs-human` and stop; nothing dispatches until each has a human `ACCEPT` or `CHANGES` via `/proteus-review`. Retroactive `CHANGES` become tickets like any other.
4. Never in unattended mode: auto-accept a test piece, merge into `main`, approve a new dependency, install a skill, rewrite `CONVENTIONS.md`, escalate past two `top` fails (park as `CONTRACT-WRONG`, continue with independent tickets).
5. Hard stop: token budget or milestone count if given; otherwise at 5 open `needs-human` issues. `PushNotification` on stop.

## What the human owns

Merging `proteus/<run>` into `main`; `CONVENTIONS.md` and its taste docs; the team roster and skills lists; every `NEEDS <dependency>`; every debt line at close; every review verdict, eventually, even the auto-accepted ones.

A review note that states a standing preference ("always", "never", "I like it when") is a house default: ask the human to add it to `CONVENTIONS.md` (or approve a ticket that does), so no later round teaches it again.

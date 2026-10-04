# Docs diet

Root docs (`CLAUDE.md` on Claude Code, `AGENTS.md` on both) are loaded into every session of every agent. Each line there is paid for on every turn, and the model's attention thins as they grow. A 1,000-line `CLAUDE.md` plus a `CLAUDE_1.md` is a project that stopped deciding what matters.

## Budget

- Root `CLAUDE.md` and `AGENTS.md`: about 150 lines each, together under 250. The autostart reports `doc-bloat=<file:lines>` over that.
- No variants: `CLAUDE_1.md`, `CLAUDE-old.md`, `AGENTS2.md` and the like are not created; split content goes where the table below says.
- `CONTEXT.md` (domain glossary) and `CONVENTIONS.md` (taste) have no fixed budget but the same rule: every line must change what an agent does.

## The diet ticket

When `doc-bloat` is not `none`, the lead files one ticket (profile: the team that owns docs, or `proteus-worker` with team `docs`) that runs in the next wave and blocks nothing. The worker classifies every line of every flagged file, then moves it:

| The line is… | It goes to |
|---|---|
| a rule every agent needs on every task | stays in the root doc, shortened |
| true only for one directory or subsystem | a nested `CLAUDE.md` in that directory (loaded only when an agent works there; Codex reads `AGENTS.md` only from the repo root down to the session's cwd, and a subagent's cwd is the lead's, so there a lesson with a `path` trigger) |
| a fix for a problem that shows up under a recognisable command, error, or path | a lesson in `docs/lessons/` with a trigger (`lessons.md`) |
| a decision with its reasons | an ADR in `docs/adr/` |
| a domain term | `CONTEXT.md` |
| a taste default | `CONVENTIONS.md` (human approves the diff) |
| history, a plan, a status, a to-do, a roadmap, a journey map, a changelog | the tracker: an issue, a milestone, or the wayfinder map issue |
| stale, duplicated, or derivable from the code or `git log` | deleted |

The worker's PR description is the classification table with a line count per destination, so the verifier can check nothing was lost: every removed line maps to a destination or to `deleted` with a reason. The human reviews the diff because `CLAUDE.md` is theirs.

## Landmarks without bloat

A long project still needs to know how it got here. Landmarks are kept, as pointers, not prose:

- The root doc may end with a `## Landmarks` list of at most ten lines, each one line: `<date> <what changed> — <issue, ADR, or PR link>`. Older entries drop off; the link keeps the detail.
- The wayfinder map is an issue labelled `wayfinder:map`, not a file. Its closed destinations are the journey.
- Milestones and their review issues are the record of what shipped and what the human said.

Nothing is lost by moving it to the tracker; it stops costing every session.

# Lessons

A lesson is a solved problem, kept so it is not solved twice. It is recalled only when its trigger fires, so a hundred lessons cost nothing until one is needed; pasted into `AGENTS.md`, `CLAUDE.md`, or a brief, it would cost every session, so it stays out of them.

## When to write one

- A problem was solved after at least one failed attempt (an escalation rung, a `RED` that took a second worker, a gate that stayed red).
- The human corrected you or a worker, or said "remember this", "never again", "I told you before".
- A verifier or QA found the same class of failure a second time.

Not a lesson: a one-off typo, a taste preference (that goes to `CONVENTIONS.md` via the human), an architectural decision (ADR), anything already enforced by a gate or hook.

The lead writes lessons itself; `docs/lessons/` is inside its allowed paths. One file per problem, `docs/lessons/<kebab-slug>.md`, committed on the run branch with `docs(lessons): <slug>`:

```markdown
---
trigger: blender.*--background.*\.blend|bpy\.ops\.render
on: command, output
scope: worker
---
Symptom: headless render exits 0 but writes a black frame when the scene camera is unset.
Fix: set `scene.camera` in the pass script before `bpy.ops.render.render`; the probe prints the camera name first.
Why: the GUI falls back to the active view; background mode does not.
```

- `trigger`: a JavaScript regex, case-insensitive. Specific enough to fire on the problem and not on every command; test it against the text that showed the failure. Avoid nested repetition such as `(a+)+`, `(a*)*` or `(a|ab)*`: the hook skips such a trigger with a note on stderr because it can backtrack without end, and it matches only the first 20 KB of any input.
- `on`: which text is tested: `command` (a shell command about to run), `output` (shell output after it ran), `prompt` (a human message), `path` (a file about to be read or edited).
- `scope`: `lead`, `worker`, or `all`.
- Body: symptom, fix, why. Five lines at most. Name the command or file, not the story.

## How recall works

`proteus-lessons.js` runs on shell calls, file access, and human messages, in the lead and in every worker worktree. On a trigger match it injects the lesson once per session, two at most per event, and appends the hit (`{file, at}`, one line each) to `.git/proteus/lesson-hits.jsonl`. Workers get lessons without the lead passing them.

## At step 8 (close)

One subagent reads `lesson-hits.jsonl` (count lines per file; last `at` is the last hit) and `docs/lessons/` and reports one line per lesson: hits this run, last hit. Then:

- A lesson that fired and the problem did not recur: keep.
- A lesson that fired and the problem recurred anyway: rewrite its fix, or turn it into a gate (a check, a hook, a guard rule) through a ticket; a gate beats a lesson.
- A lesson with a trigger so broad it fired on unrelated work: narrow the trigger.
- No hits for three runs: leave it; it costs nothing until it fires.

## Improving Proteus itself

When a problem is not about this project but about the workflow (a step that always wastes time, a missing guard, a better order), the fix belongs upstream, not in a lesson:

1. Write the proposal: problem seen (with the run and issue numbers), proposed change to which Proteus file, and why.
2. `proteus-src` in the `proteus-state` line is the Proteus checkout. File the proposal there: `gh issue create -R <owner/repo of that checkout's origin> --label proposal --title "<one line>" --body-file -`.
3. Tell the human in one line. The human decides and edits Proteus; the lead does not edit the skill, its hooks, or the agents, or change the workflow mid-run on its own proposal.

The human saying "improve proteus: …" means the same: write the proposal from their words, file it, report the link.

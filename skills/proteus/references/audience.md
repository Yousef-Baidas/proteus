# Audience

People who are not technical cannot judge a decision written in technical terms, so they accept blindly. Every decision that reaches the human is worded at their level, the technical detail kept underneath. Prompt-only, except the profile store.

The profile: `node <hooks>/proteus-profile.js show|set|know|forget|terms` (`--help`), one per project and machine; `audience=` on `proteus-state` is `<familiarity>/<learning>` or `unset`.

| Field | Values |
|---|---|
| `familiarity` | `new`, `some`, `fluent`: with the kind of work this project does, not with computers |
| `learning` | `along` (teach a new term in one line as it comes up), `asked` (plain words; teach when asked), `off` (plain words; never teach) |
| `known` | terms the human has shown they know |

## Gauging

At bootstrap, or the first session with `audience=unset`: two or three relaxed questions in plain words, how familiar they are with this kind of work and whether they want to learn along the way, only when they ask, or not at all. Then `set familiarity=<f> learning=<l>`. No quizzing. The human may skip it: `set familiarity=some learning=asked`.

## Updating

- The human uses a term correctly or says they understand one → `know <term>`.
- They ask for more or less detail, or to start or stop teaching → `set`. They can change it at any time by asking.
- Never move it toward less explanation on one message alone.

## Decision cards

Any decision (a question, a change summary, a merge ask, a milestone review) is a card, in order:

1. What is being decided, as its effect on the human and their users.
2. The options as outcomes and trade-offs, your recommendation first, with its reason.
3. The technical detail, folded: a `<details>` block on the tracker, a trailing "Details" part in chat. Left out only at `new` when the human has not asked for it.
4. How to answer.

## Wording by level

`fluent`: technical terms as they are. `some`: the terms in `terms` as they are, plain words for the rest. `new`: plain words throughout.

`learning=along`: a term not in `terms` gets a one-line explanation the first time it appears in a session. `asked`: the card offers "explain"; asked, explain it at their level in this project's terms. `off`: nothing is offered.

## High-risk or irreversible decisions

Only these: a plain summary of what the human is agreeing to comes first, and below `fluent` one check question before accepting, so they confirm they understood the consequence. Never on a routine decision.

## Precision

Plain words never change what is decided. A plain phrasing that could be read two ways gets the exact term beside it, with a short gloss.

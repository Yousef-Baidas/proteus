# Run panel

The run panel is an optional Claude Code mod that ships with Proteus, `proteus-panel`.
It shows the run beside the chat, so you can see what waits on you without asking the lead.

## What it shows

Type `/proteus-panel` to open the pane. It shows:

- the run's name;
- the current stage (a milestone) and how many of its tasks are done;
- the time left in the stage, once there is enough history to estimate it;
- the changes being checked (open pull requests), and how many have a reviewer's decision;
- a card for each item waiting on you: a question, or a stage review.

Each card says what the item is, its title, and how to answer it: in the review session (`/proteus-review`).
Its Explain button asks Claude, in this session, to explain the item in plain words.
The prompt it sends holds fixed words and the item's number only, never the title.

The status line also gets an entry: the run's name and how many items wait on you.

The pane refreshes when the session starts, after each turn, every two minutes while it is open, and when you press
Refresh. If the status check fails, or the tracker cannot be reached, the pane says so and keeps working.

## Display only

The panel shows; it never acts.
It has no approve, accept, merge or post control.
It does not hook tool calls, permission checks, configuration or settings.
It writes no files and makes no network calls.
The only process it starts is Proteus's own status script, `proteus-status.js --json`, with a fixed argument list.

Approvals work as before: a tool call still asks in the permission dialog, and a question or stage review is
still answered in the review session.

Titles come from the tracker, so the panel treats them as untrusted text.
It draws them as plain text, never as Markdown, links or keys, and cuts long ones short.

## Install and remove

It installs from the same marketplace as Proteus. Inside Claude Code:

```
/plugin install proteus-panel@proteus
```

To remove it:

```
/plugin uninstall proteus-panel@proteus
```

Removing it changes nothing else: Proteus and its text status line keep working.

## Where it runs

Claude Code only. Other harnesses keep the text status line (`docs/harnesses.md`).

## Trust

The panel is code, and it runs with your permissions inside Claude Code.
It ships with Proteus, in `mods/proteus-panel/`, and is reviewed and tested like the rest of the repo.

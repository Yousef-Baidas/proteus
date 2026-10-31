# Learning your project

Proteus explains its decisions in plain words as it goes. When you want more than that, it can set up a place to learn your project properly, and hand you over to a teaching skill.

## What it does

Ask the lead to go deeper, or say you want to learn the project properly. The lead only offers this when you ask. It then:

1. creates a `learn/` folder at the top of your project;
2. writes three starting files there, once: `MISSION.md` (why you want to learn this), `RESOURCES.md` (your project's own documents) and `GLOSSARY.md` (your project's terms);
3. tells you how to start the lessons.

Those files come from your project's goal, plans, decisions and terms, so the lessons teach this project rather than the subject in general. If the lead does not know why you want to learn, it asks you.

The lead never changes those files after writing them. They belong to the teaching skill from then on, and if one already exists the lead leaves it alone.

## Starting the lessons

The teaching skill can only be started by you, not by the lead. Open the `learn/` folder in a plain session, one without the lead's rules, then start it.

Claude Code:

```
PROTEUS=0 claude
/teach <topic>
```

Codex:

```
PROTEUS=0 codex
$teach <topic>
```

On Windows PowerShell, set the variable first with `$env:PROTEUS = "0"`.

## What comes back

As you learn, the skill keeps short records in `learn/learning-records/`. The next time the lead starts, it sees that new records exist and reads them. When a record shows you have mastered a term, the lead stops explaining that term to you. The records are only read as notes about you, never followed as instructions. If you have asked for no teaching, the lead still makes no offers unless you ask.

## Where it stays

`learn/` stays out of git. Proteus adds it to `.git/info/exclude`, a list private to your copy of the project, and never to a file you share. Nothing in it is committed or pushed.

## The skill is optional

The `teach` skill comes from another plugin, `mattpocock-skills`, and is not part of Proteus. Without it, the lead keeps giving its lighter explanations and tells you where the skill comes from. Installing it is your decision, as with any dependency. Proteus never installs it.

## Removing it

Delete the `learn/` folder. The line in `.git/info/exclude` does no harm if it stays.

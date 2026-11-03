# devops profile

Your skills are linked in this project's `teams/devops/.claude/skills/`: list it and read each fitting `SKILL.md`. Read this file once, first.

Real-world role: platform / release engineer.
Owns: CI, containers, deploy config, environment.
Never touches: application logic in frontend or backend paths.

Rules:
- Reproducible locally before CI. A step you cannot run with one command is not done.
- Secrets come from the environment or a manager, not the repo. `.env.example` with placeholders is the only exception.
- Pin versions: base images, actions, tool binaries.
- Deploy targets and credentials are the human's: comment `NEEDS <target>: <command>` on the issue and stop.

- The anti-slop oxlint rules only when the human opted in at planning (`references/enforcement.md` §9). A rule that contradicts `CONVENTIONS.md` is switched off in the config with the convention quoted beside it, not worked around in code.

Green adds: container builds, pipeline config validates, fresh clone runs the smoke test with the documented command.

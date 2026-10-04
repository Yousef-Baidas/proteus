# Conventions

One rule per line. The verifier fails a diff that breaks one. Edited only by the human.

## Naming
- Hook files `proteus-<name>.js`; harness adapters `proteus-harness-<harness>.js`; `commit-msg.js` keeps its git-hook name.
- Directories lowercase, one word (`teams/backend`, `templates/hooks`); references `skills/proteus/references/<topic>.md`.
- Functions and variables camelCase (`readJSON`, `projectRoot`); module constants UPPER_SNAKE (`HARNESS`, `ROOT`).
- Env vars `PROTEUS_*` (`PROTEUS_HARNESS`, `PROTEUS_DEBUG`); test fakes `FAKE_*` (`FAKE_GH`).
- CLI flags kebab-case (`--auto-update`); PowerShell switches PascalCase (`-AutoUpdate`).
- Run branches `proteus/<run>`, worker branches `proteus-work/<run>/<n>`, evidence `proteus-evidence/<run>`; `hive/` branches are hivemind's, and `install.js --update` migrates open ones.

## Layout
- Hooks live in `templates/hooks/`; shared logic in `proteus-lib.js`; harness specifics only in `proteus-harness-<harness>.js`, picked by `proteus-harness.js`.
- One harness = one adapter file + `docs/harnesses/<harness>.md` + its `install.js --harness <name>` branch + its test file.
- `install.js` holds all installer logic; `install.sh` and `install.ps1` only map flags and call it.
- Tests in `tests/`, one file per area (`tests/harness-<name>.test.js`), all run by one entry point; `tests/fakegh.js` is the shared fake.
- No barrel files. No file length cap.

## Style
- CommonJS, `"use strict";` after the header comment; hooks start `#!/usr/bin/env node`.
- `require("fs")` without the `node:` prefix; local modules via `require(path.join(__dirname, "x.js"))`. No ESM.
- Double quotes, semicolons, trailing commas in multiline literals, 2-space indent.
- No formatter and no line-width cap: match the density of the file you are in; one-line guards and `try { … } catch {}` are fine.
- Shell scripts `#!/usr/bin/env bash` with `set -euo pipefail`.

## Errors
- Hooks fail open: an internal error exits 0 and never blocks the session; only a deliberate deny blocks, with the reason on stderr.
- Helpers return a default instead of throwing (`readJSON(file, dflt)`, `git()` returns `""`).
- `install.js` uses `die(msg)` for fatal, `warn`, `log`; `--doctor` exits 1 if any row fails.

## Comments
- Every file opens with a header comment: what it is and its exit-code contract.
- Inline comments short, lowercase, say why. No JSDoc. TODO as `TODO(#<issue>)`.

## Tests
- Plain Node, no framework: `ok(name, cond, extra)`, names are sentences, file prints `N passed, M failed` and sets `process.exitCode`.
- Isolation: temp HOME and temp repos under `os.tmpdir()`; never the real network, `~/.claude`, `~/.codex`, or `~/.pi`.
- Run the real scripts with `spawnSync`; fake external CLIs (`gh`, `claude`, `pi`) with a fake binary, not a mock library.
- A Windows-specific path gets a test that fakes `win32`.

## Types
- None: no TypeScript, no JSDoc types. Parse JSON defensively with defaults.

## Dependencies
- Zero runtime dependencies, hard rule: shipped code (`install.js`, `templates/`, `teams/`, `skills/`) uses Node built-ins only, and `package.json` has no `dependencies`. A new dependency is a `NEEDS` to the human; the verifier fails a diff that adds one.
- One dev-only exception (#8, #11): `oxlint` and `@oxlint/plugins`, both pinned exact to the same version in `devDependencies`, for the lint gate; config in `.oxlintrc.json`, never `oxlint.config.ts`. Nothing the installer runs may require it.
- Vendored anti-slop plugin under `tools/oxlint/anti-slop/` keeps its upstream TypeScript and style; Style and Types rules apply everywhere else.
- External CLIs via `execFileSync` with an args array, `windowsHide: true`, and a timeout.
- Node 22.5+.

## Commits
- Conventional Commits, lowercase imperative, no trailing period, subject at most 72 chars; scope optional (`feat(pi): …`).
- No AI attribution and no Co-Authored-By trailers.

## Platform
- Every install path works from bash, PowerShell, and Node; a new flag lands in all three plus the `--help` header.
- Paths via `path.join`; hooks run on Windows with no shell.
- `.gitattributes`: `*.js`, `*.sh`, `*.md` LF; `*.ps1` CRLF.

## Markdown
- Skills and references: terse, one rule per bullet, `##` headings, backticked identifiers, tables for lookups, no hard wrapping.
- `SKILL.md` has YAML frontmatter `name`, `description`; `docs/harnesses/*.md` open with the research date.

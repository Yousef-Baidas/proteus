# Vendored anti-slop Oxlint plugin

Source: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), directory `skills/install-anti-slop/assets/anti-slop/`, commit `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` (2026-09-10, upstream `main`).

Licence: MIT, Copyright (c) 2026 Dillon Mulroy. `LICENSE` here is the upstream root `LICENSE` at that commit, kept verbatim; keep it with every copy. This repo's root LICENSE does not cover this directory.

How the revision was established: commit `7ea4553` ("build: add oxlint lint gate with vendored anti-slop plugin") copied the plugin in from the local `install-anti-slop` skill and is the only commit that changed it. The tree it committed, `git rev-parse 7ea4553:tools/oxlint/anti-slop` = `a7831feb0c097943ac813ddcb1367e26eef52da5`, equals the upstream tree at that path in `e6676e8` (the commit that last changed it), `f87211b` and `c44ef22`, so the copy is unmodified upstream code. This file and `LICENSE` were added beside it afterwards.

Local deviations: none. `.oxlintrc.json` loads `index.ts` as a JS plugin and excludes this directory from linting; `npm run lint` runs it.

Nested record: `vendor/eslint-stylistic/` is a copy of the ESLint Stylistic `padding-line-between-statements` rule, MIT, with its own `LICENSE` and `UPSTREAM.md`.

Updating: copy a newer upstream revision of the same directory over this one, then update the commit and tree above (`git rev-parse <commit>:skills/install-anti-slop/assets/anti-slop`) and recheck the licence.

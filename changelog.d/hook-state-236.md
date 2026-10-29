### Security

- The hooks no longer write through a link an agent planted (#236). Everything a hook or an unsandboxed lead
  script writes now lives in `<git-common-dir>/proteus-lead/`: the journal, bindings, spawn records, beats,
  tamper records, lead windows and notices, caches, lesson hits, the scratch ledger and the used `--allow`
  entries. `proteus-lib.js` refuses to write there when that dir or `<git-common-dir>` is a link or not owned
  by the current user. Rewrites go through a `wx` temp file and a rename, and appends open with `O_NOFOLLOW`.
  The lead's files are copied from `<git-common-dir>/proteus/` on first use, regular files only. What agents
  write under `<git-common-dir>/proteus/` (allow files, scratch, `guest.json`) is read as untrusted and
  never written back. A used `--allow` entry is recorded under `proteus-lead/` instead. The session-start hook no longer appends to `.git/info/exclude`; `install.js
  --project` adds those lines. `tests/hookstate.test.js` plants links at every lead file, its temp names and
  its parent dirs, runs the #212 review's notice and journal probes, and scans the hooks for raw writes.
- No hook runs the stale scratch sweep any more (#237): it deleted under `<git-common-dir>/proteus/scratch`
  and `<git-common-dir>/worktrees`, which agents can write, so a swapped or planted link could aim it at the
  user's files. The session start now prints one line telling the lead to run `proteus-scratch.js --sweep
  --stale` from its own sandboxed shell. The hooks' git runs with `-c maintenance.auto=false -c
  gc.worktreePruneExpire=never`, so a hook's commit never starts git's automatic gc.
- Notices left in `<git-common-dir>/proteus/unattributed/` are imported once into `proteus-lead/` and that
  dir is never read for notices again. Every notice is checked before it is shown; one with a bad `seq`, a
  control character or an over-long string is dropped and its name logged.
- `leadCreate` refuses when anything, a dangling link included, already has its name, as Windows' `wx`
  creates through a dangling link.
- The hooks' static write scan now also catches destructured, aliased and computed `fs` methods, the
  callback and promise forms, copies, mkdir, links and `open` with write flags.

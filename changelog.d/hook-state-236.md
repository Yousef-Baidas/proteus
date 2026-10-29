### Security

- The hooks no longer write through a link an agent planted (#236). Everything a hook or an unsandboxed lead
  script writes now lives in `<git-common-dir>/proteus-lead/`: the journal, bindings, spawn records, beats,
  tamper records, lead windows and notices, caches, lesson hits, the scratch ledger and the used `--allow`
  entries. `proteus-lib.js` refuses to write there when that dir or `<git-common-dir>` is a link or not owned
  by the current user. Rewrites go through a `wx` temp file and a rename, and appends open with `O_NOFOLLOW`.
  The lead's files are copied from `<git-common-dir>/proteus/` on first use, regular files only. What agents
  write under `<git-common-dir>/proteus/` (allow files, old notices, scratch, `guest.json`) is read as
  untrusted and never written back. A shown or cleared notice and a used `--allow` entry are recorded under
  `proteus-lead/` instead. The session-start hook no longer appends to `.git/info/exclude`; `install.js
  --project` adds those lines. `tests/hookstate.test.js` plants links at every lead file, its temp names and
  its parent dirs, runs the #212 review's notice and journal probes, and scans the hooks for raw writes.

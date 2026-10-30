### Fixed

- The lead guard no longer trips the lead on routine commands (#271). A `gh` or `proteus-gh.js` call it
  cannot read (through a `$VAR`, `$( )`, `eval`, `xargs` or inline code) is refused for that reason, with
  the fix to make, instead of as a verdict post. The lead may `Write` and `Edit` under its scratch dir,
  `<git-common-dir>/proteus/scratch/<key>/`, judged on the real path, and nowhere else under `.git`. The
  guard and `proteus-verdict.js` share one verdict definition (`lib.isVerdict`), so the guard refuses
  exactly what the reader would count.

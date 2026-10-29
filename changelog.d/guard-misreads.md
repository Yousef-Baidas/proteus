### Fixed

- The guards no longer resolve a git dir the shell builds at run time as a literal path (#220). A `GIT_DIR`,
  `GIT_WORK_TREE`, `-C`, `--git-dir` or `--work-tree` value holding `$`, `$( )` or backticks (`$HOME`, `$PWD`
  and `~` still resolve) is unknown: a subagent's git call, and anyone's `git -C <it> push`, is refused with
  "spell the path out; the guard can't expand shell variables".
- A bare `git push` (or `git push origin` with no refspec) is judged as the branch checked out where it runs
  (#221), following a `cd` on the way and read from that checkout's own HEAD, not as the upstream a worker
  branch cut from `origin/main` points at: it passes unless that branch is main or a run branch. From a detached
  HEAD, or after a `cd` the guard cannot follow, it is refused, naming `git push origin <branch>`.
- A subagent's Monitor is no longer refused outright (#219): its command gets the checks a Bash call from that
  subagent gets and runs when they pass, so a worker can wait on a suite the harness moved to the background.

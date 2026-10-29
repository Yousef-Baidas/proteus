### Fixed

- The guards no longer resolve a git dir the shell builds at run time as a literal path (#220). A `GIT_DIR`,
  `GIT_WORK_TREE`, `-C`, `--git-dir` or `--work-tree` value holding `$`, `$( )` or backticks (`$HOME`, `$PWD`
  and `~` still resolve) is unknown: a subagent's git call, and anyone's `git -C <it> push`, is refused with
  "spell the path out; the guard can't expand shell variables".

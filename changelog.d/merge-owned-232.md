### Fixed

- The owned-path check judges a merge of the base by what it changes beyond the base, not by what it brings in
  (#232). The worktree pre-commit hook, while `MERGE_HEAD` names a commit `origin/main`, `origin/master` or the run
  branch `origin/proteus/<run>` holds, checks only the paths where the index differs from `MERGE_HEAD`: conflict
  resolutions and edits made during the merge. CI judges each commit on its own once the PR holds a merge whose
  second parent the base holds, that merge against that parent. A merge of any other branch is checked in full.

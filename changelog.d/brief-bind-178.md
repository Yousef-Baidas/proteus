### Fixed

- The shell check binds a subagent with no cwd worktree and no binding to the one prepared worktree its brief
  names, as a first edit does (#178). A build worker whose first call is `npm install` in its own worktree was
  refused, its worktree taken for an idle sibling's, since a subagent's shell cwd resets to the main checkout. A
  change to another worktree is still refused, and a brief naming several binds none.

### Fixed

- A guard-violation record whose only cause is a missing snapshot no longer blocks `proteus-signoff.js` MERGE forever
  once its agent has ended (#229). The signoff snapshots the agent's worktree again and clears the record when its
  guarded paths match the branch's commit; otherwise it names the paths that differ. When that worktree is gone, it
  keeps refusing and says how the human clears the record.

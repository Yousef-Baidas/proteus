### Fixed

- In guest mode the policy engine reads and writes `teams/policy.json` and `teams/POLICY.md` in the guest dir, not the
  repo root, takes its fallback presets from there, and refuses edits of those files as it does in a checkout (#315).
- A non-plugin install keeps the policy presets beside its hooks copy, a worker's worktree too, git-excluded, and the
  lookup reads that copy first. An update replaces an unedited copy and keeps an edited one; the move to the plugin
  removes an unedited copy and names an edited one (#315).

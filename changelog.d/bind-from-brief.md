### Security

- On Claude Code the lead guard binds a subagent to the prepared worktree its brief names (#85), read from the
  first message of the subagent's transcript (`agent_transcript_path`, else
  `<session>/subagents/agent-<id>.jsonl`), through a new adapter method, `briefText`. Before, a subagent
  outside a prepared cwd was bound by its first edit, so one whose first edit landed in a sibling's worktree was
  bound there and not refused. Now that edit is refused, and so is an edit in any other linked worktree of the
  repo, with a message naming the brief's worktree. A brief that names no worktree (helpers, the scout, the
  guide) or several (a contracts worker) keeps the first-edit binding.
- Codex keeps the cwd and first-edit binding: multi-agent v2 stores the spawn message encrypted in the
  subagent's rollout, so its `briefText` is empty.

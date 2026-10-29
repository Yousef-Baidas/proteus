### Changed

- Worker agents withhold the tools a ticket run never calls (#206): their `disallowedTools` drop
  `AskUserQuestion`, the plan-mode, cron, `ScheduleWakeup`, `RemoteTrigger`, `PushNotification`, `Monitor` and
  worktree-switch tools. MCP servers stay: `disallowedTools` cannot withhold them all and keep context-mode.
  A worker run as the session (`--agent`) loads nine fewer tools, 1,658 fewer input tokens per spawn.

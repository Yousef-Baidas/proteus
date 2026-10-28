### Fixed

- The stall watchdog no longer wakes the lead for agents that reported or that it never spawned (#179). A
  subagent stop that hands a final message back to the lead counts as a report; only a stop with no final
  message is "stopped without a report". Only agents with a lead spawn record are tracked (the lead guard now
  records unnamed spawns under their `subagent_type`, with the spawn time), so nested agents that workers or
  verifiers start, and foreign ones, are ignored. `--forget <agent>` and `--forget all` are remembered in
  `<git-common-dir>/proteus/forgotten.json`, so a late stop of a forgotten agent does not track it again.

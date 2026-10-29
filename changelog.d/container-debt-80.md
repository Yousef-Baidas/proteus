### Fixed

- `proteus-container.js` (#80): the PR body starts with the host's `Closes #<n>` and the report's own closing
  keywords are escaped; gh runs as the agents' login (`agentGh`) when one is set; a failed `pr create` still
  posts the report on the ticket, then ends RED; with `--ticket` any failure ends in the `RED #<n> container:`
  line; `--agent` finds the installed plugin's agents from the `--sandbox` bin copy; the main checkout is
  refused. The lead guard refuses the runner to teammates as well as subagents.

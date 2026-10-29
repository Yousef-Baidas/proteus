### Security

- Codex: `.codex/rules/proteus.rules` names the lead's scripts by the main checkout's absolute hooks path, not
  `.codex/hooks/...`, so a worker's nested `.codex/hooks` copy run from its own workdir no longer matches a rule
  and runs sandboxed (#234). The rules are rewritten whenever the hooks are registered, and `--doctor` flags rules
  a moved checkout left stale. The lead's scripts (all those the rules name but `proteus-tier.js` and
  `proteus-scratch.js`, which a worker runs from its own hooks dir) also exit 2 when run from a copy outside the
  main checkout's hooks dir or the plugin's.

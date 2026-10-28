### Fixed

- `proteus-worktree.js --tier` can no longer prepare a worktree below the tier its owned paths need (#177): it
  classifies them by the tiers block in `teams/ROUTING.md` (the rules `proteus-tier.js` uses, guest dir included)
  and raises a lower `--tier` to that, printing one line saying so; a higher `--tier` is kept. A pre-commit
  refusal of work that needs the full tier now names the lead's exact re-run,
  `node <hooks>/proteus-worktree.js <worktree> --tier full <owned paths>`, with the real values filled in.

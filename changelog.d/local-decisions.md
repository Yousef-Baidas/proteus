### Added

- An optional local model (#344): `"local": { "endpoint", "model", "keyEnv" }` in `~/.claude/proteus.json`, the key
  read only from the environment variable `keyEnv` names. `proteus-delegate.js --tier local` makes one call to the
  endpoint's `/v1/chat/completions` with Node's own fetch, the same on every harness: no tools, no budget, cost 0 in
  the delegate ledger. Not configured, unreachable or failed is `ok: false`, exit 1, so the caller falls back.
- Its answers are one-way: they may add work or pick a listed option, never skip a review, verifier, gate or check,
  and never give a verdict. A caller that doubts one reruns the job on `helper`.
- `next` asks it once per PR head whether a diff CI did not mark for security is security-relevant; a yes adds
  `security=local` to the verifier's `SPAWN` line. No config, or a failed call, changes nothing.

### Changed

- The suggested `autoMode.environment` entry now says that `node <hooks>/proteus-cli.js next` and `result`
  are your own orchestration script, and that `next` merges only into `proteus/<run>` run branches, after the
  verifier's signed `proteus/verdict` status. `--doctor` warns when your Proteus entry predates
  `proteus-cli.js`, and both `--doctor` and install print the new entry (#79).

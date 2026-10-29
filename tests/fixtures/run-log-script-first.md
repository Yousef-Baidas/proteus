## step 4, wave 1

- dispatched #12 #13 #14
- #13 brief: release checklist by hand (bump the version, build, tag, upload)
- merged #12 #13 #14

## step 4, wave 2

- dispatched #15 #16
- #16 brief: release checklist by hand again
- script-ticket: release checklist #17
- #17 owned: scripts/release.js (`--help`, exit 0 on a published release)

## step 4, wave 3

- dispatched #18
- #18 brief: run `node scripts/release.js`; the model writes only the release notes, to `notes.md`, which the script reads

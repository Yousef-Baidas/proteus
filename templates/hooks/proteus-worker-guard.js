#!/usr/bin/env node
// PreToolUse hook inside a worker's worktree (registered by the harness adapter's worktree settings).
// Refuses background Bash, Monitor, `gh … --edit-last`, a comment opening with ACCEPT, CHANGES or ANSWER, and what
// lib.branchDenial refuses (--admin merges, pushes to main or a run branch, protection changes): a worker whose
// turn ends waiting on a notification never wakes, --edit-last can overwrite another agent's comment, and those words are the human's.
// Only active when the owned-path list exists (a dispatched worker's worktree).
// Exit 2 = block; the message on stderr reaches the worker as the tool's error.
"use strict";
const fs = require("fs");
const path = require("path");
const lib = require(path.join(__dirname, "proteus-lib.js"));

if (process.env.PROTEUS === "0") process.exit(0);

lib.run((ev, ad) => {
  if (!fs.existsSync(lib.ownedFile(lib.projectRoot(ev)))) return;
  const why = lib.workerDenial(ev);
  if (why) ad.deny(why);
});

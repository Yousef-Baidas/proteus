#!/usr/bin/env node
// PreToolUse hook: block edits outside the ticket's owned paths.
// proteus-worktree.js writes one path or glob per line to the worktree's owned-path list before dispatch.
// No file → hook allows everything (the lead's own session, verifiers, bootstrap).
// The rule itself lives in proteus-lib (ownedDenial), shared with the lead guard's subagent check: the list file
// itself is never owned, and outside the worktree only the repo's scratch (proteus-scratch.js --path) passes.
// Exit 2 = block; the message on stderr reaches the agent as the tool's error.
"use strict";
const fs = require("fs");
const path = require("path");
const lib = require(path.join(__dirname, "proteus-lib.js"));

const root = path.resolve(lib.projectRoot());
if (!fs.existsSync(lib.ownedFile(root))) process.exit(0);

lib.run((ev, ad) => {
  if (ev.tool !== "edit") return;
  const why = ev.paths.map((p) => lib.ownedDenial(root, p)).find(Boolean);
  if (why) ad.deny(why);
});

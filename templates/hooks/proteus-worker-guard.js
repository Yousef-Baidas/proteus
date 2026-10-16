#!/usr/bin/env node
// PreToolUse hook inside a worker's worktree (registered by the harness adapter's worktree settings).
// Refuses background Bash, Monitor, `gh … --edit-last`, a comment opening with ACCEPT, CHANGES or ANSWER, and what
// lib.branchDenial refuses (--admin merges, pushes to main or a run branch, protection changes), and what
// lib.agentShellDenial refuses (force-push, git -C elsewhere, shell writes to .claude/, .git/, the gates): a worker whose
// turn ends waiting on a notification never wakes, --edit-last can overwrite another agent's comment, and those words are the human's.
// Also proteus-signoff.js whatever the harness names the agent (this session is a worker's), and what
// lib.secretDenial refuses: Read, Edit or a shell command naming the verifier App's key, a shell setting GH_TOKEN.
// A shell call it lets through gets the fingerprint proteus-shell-check.js compares after the call.
// Only active when the owned-path list exists (a dispatched worker's worktree).
// Exit 2 = block; the message on stderr reaches the worker as the tool's error.
"use strict";
const fs = require("fs");
const path = require("path");
const lib = require(path.join(__dirname, "proteus-lib.js"));

if (process.env.PROTEUS === "0") process.exit(0);

lib.run(async (ev, ad) => {
  if (!fs.existsSync(lib.ownedFile(lib.projectRoot(ev)))) return;
  const why = lib.workerDenial(ev) || (ev.tool === "shell" && lib.signoffDenial(ev, lib.SIGNOFF_MSG.role("a worker's session")));
  if (why) ad.deny(why);
  if (ev.tool !== "shell") return;
  let check;
  try { check = require(path.join(__dirname, "proteus-shell-check.js")); } catch { return; }
  try { await check.snapshot(ev); } catch {}
});

#!/usr/bin/env node
// Run from a repo root by the installer: node <checkout>/templates/hooks/install-lead-hooks.js
// Copies every file beside it (except itself and the adapter's skipHooks, which it removes if an
// older install left them) into the harness's hooks dir (.claude/hooks/), so the lead can run
// proteus-worktree.js and proteus-status.js from there, and registers the lead's hooks
// (Claude Code: .claude/settings.local.json, machine-local and untracked, so worktrees never inherit it).
// Idempotent: an entry whose command already names the script is kept, its command rewritten to the
// absolute path if an older install wrote it another way; other hooks are never touched, an old
// narrower proteus-lead-guard matcher is widened. Invalid JSON → exit 1.
// The hooks dir is the real cwd plus fixed segments (.claude/hooks, or .codex/hooks for Codex), each
// lstat'd a real directory: a link on the way (a repo may commit one) refuses everything, exit 1 (#13).
// Every delete goes through proteus-confine.js: a regular file under that dir with no link on the way.
"use strict";
const fs = require("fs");
const path = require("path");
const lib = require(path.join(__dirname, "proteus-lib.js"));
const ad = require(path.join(__dirname, "proteus-harness.js"));
const C = require(path.join(__dirname, "proteus-confine.js"));

const hooksDir = ad.hooksDir(".");
const self = path.basename(__filename);
const skip = new Set(ad.skipHooks || []);
const segs = hooksDir.split(path.sep).filter((x) => x && x !== ".");

const own = C.ownDir(".", segs, true);
if (!own) {
  const at = C.blocker(".", segs) || hooksDir;
  console.error(`refused  ${hooksDir} (${at} is a link or not a directory; nothing copied, removed or registered). Replace ${at} with a real directory, then re-run node "${__filename}" from the repo root.`);
  process.exitCode = 1;
  return;
}
let copied = 0, removed = 0;
for (const f of fs.readdirSync(__dirname)) {
  if (f === self || !fs.statSync(path.join(__dirname, f)).isFile()) continue;
  const dest = path.join(hooksDir, f);
  if (!skip.has(f)) { if (lib.syncFile(path.join(__dirname, f), dest)) copied++; continue; }
  // hooksDir is machine-local and git-excluded: a copy there is an older install's, not the user's
  if (C.lstat(dest) && C.remove(dest, [own], "file")) removed++;
}

const r = ad.registerLead(".");
const file = r.file.split(path.sep).join("/");
if (r.error) {
  console.error(`warning: ${r.error}; hooks not registered. Fix the file and re-run.`);
  process.exitCode = 1;
  return;
}
console.log(`lead     -> ${file} (${r.changed ? "hooks registered" : "hooks already registered"}, ${copied} files updated${removed ? `, ${removed} unused removed` : ""}; ${ad.bypass} skips them)`);

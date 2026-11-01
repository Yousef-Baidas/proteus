#!/usr/bin/env node
// Claude Code statusLine command: the user's own status line (from <harness home>/settings.json,
// run with the same stdin), then " · proteus: N questions · M reviews" when either is above 0, and
// " · proteus: update ready" when the autostart found a newer Proteus release.
// Reads only the inbox cache; a cache older than 60 s triggers one detached
// `proteus-inbox.js --refresh` per 60 s (lock: <common>/proteus-lead/inbox.refresh). Never throws.
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");

const STALE_MS = 60 * 1000;
let out = "";
let input = "";
try { input = fs.readFileSync(0, "utf8"); } catch {}

let lib = null, ad = null;
try { lib = require(path.join(__dirname, "proteus-lib.js")); ad = require(path.join(__dirname, "proteus-harness.js")); } catch {}

try {
  const user = JSON.parse(fs.readFileSync(path.join(ad ? ad.home : process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "settings.json"), "utf8")).statusLine;
  const cmd = user && user.type === "command" && typeof user.command === "string" ? user.command : "";
  if (cmd && !cmd.includes("proteus-statusline.js")) {
    // a statusLine command is a shell string by definition, so it runs through the shell
    // a command that exits without reading its stdin leaves EPIPE here, and its output still counts
    const r = require("child_process").spawnSync(cmd, { shell: true, input, encoding: "utf8", timeout: 5000, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    if (r.status === 0 && (!r.error || r.error.code === "EPIPE")) out = r.stdout.replace(/\s+$/, "");
  }
} catch {}

try {
  let ev = {};
  try { ev = JSON.parse(input) || {}; } catch {}
  const root = lib.repoRoot((ev.workspace && ev.workspace.project_dir) || ev.cwd);
  const common = root && lib.gitCommonDir(root);
  if (common) {
    const cache = lib.inboxFile(common);
    let age = Infinity;
    try { age = Date.now() - fs.statSync(cache).mtimeMs; } catch {}
    if (age > STALE_MS) refresh(common, root);
    const inbox = lib.readInbox(common);
    const q = inbox ? inbox.questions.length : 0;
    const r = inbox ? inbox.reviews.length : 0;
    if (q || r) out += `${out ? " · " : ""}proteus: ${q} question${q === 1 ? "" : "s"} · ${r} review${r === 1 ? "" : "s"}`;
  }
} catch {}

// a release tag newer than the Proteus checkout (counted by the autostart); shown until --update
try {
  const b = (JSON.parse(fs.readFileSync(lib.configFile(), "utf8")) || {}).behind;
  if (b > 0) out += `${out ? " · " : ""}proteus: update ready (install.js --update)`;
} catch {}

process.stdout.write(out + "\n");

function refresh(common, root) {
  const lock = lib.leadPath(common, "inbox.refresh");
  try { if (Date.now() - fs.statSync(lock).mtimeMs < STALE_MS) return; } catch {}
  try {
    lib.leadWrite(common, lock, String(Date.now()));
    const c = require("child_process").spawn(process.execPath, [path.join(__dirname, "proteus-inbox.js"), "--refresh"], { detached: true, stdio: "ignore", windowsHide: true, cwd: root });
    c.on("error", () => {});
    c.unref();
  } catch {}
}

#!/usr/bin/env node
// Gate results cached by tree: node <hooks>/proteus-gates-cache.js "<gate command>"
// The worker, lefthook's pre-push, the verifier, the lead after a merge, QA and the guide all run the same
// suite on the same tree; only the first run pays. The command runs through the shell (several arguments are
// joined with spaces) unless it already passed on this exact tree: key = sha256 of HEAD^{tree}, the cwd's
// path inside the repo, and the command text.
// A pass is stored in <git-common-dir>/proteus/gates/<key>.json with the output's last lines; a hit prints
// those lines and a `gates-cache: hit` line, runs nothing, and exits 0. A failure is never stored.
// Only a clean checkout is looked up or stored (git status --porcelain prints nothing, untracked files
// included), and a run that leaves the tree changed is not stored: what the key names is what was tested.
// Ignored files (node_modules, .env, build output) are outside the key, so a gate that depends on them
// is cached by the tracked files only. Outside a git repo, or with PROTEUS_GATES_CACHE=0, it just runs.
// Exit code: the command's; 0 on a hit. A store that cannot be written (Codex's sandbox keeps .git
// read-only) is skipped silently. Run from a checkout with worker worktrees in its .worktrees/, it warns on stderr:
// a runner that does not skip that folder tests their files too.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");
const lib = require(path.join(__dirname, "proteus-lib.js"));

const TAIL = 40; // output lines kept with a pass
const KEEP = 500; // records kept; the oldest go first

const USAGE = "usage: node proteus-gates-cache.js \"<gate command>\"";
const HELP = `${USAGE}
Runs a gate command through the shell unless it already passed on this exact tree:
  <gate command>   the suite or check to run; several arguments are joined with spaces
A pass is cached by the tree, the cwd's path in the repo and the command text, in
<git-common-dir>/proteus/gates/. A hit prints the stored output tail and a \`gates-cache: hit\` line, runs
nothing, and exits 0. A failure is never stored; a dirty checkout runs uncached.
PROTEUS_GATES_CACHE=0 always runs. Exit code: the command's; 0 on a hit; 2 on usage.`;
if (process.argv[2] === "--help" || process.argv[2] === "-h") { console.log(HELP); process.exit(0); }
const cmd = process.argv.slice(2).join(" ").trim();
if (!cmd) {
  console.error(USAGE + "\n(--help explains the arguments)");
  process.exit(2);
}

const cwd = process.cwd();
// git's stdout, or null when git fails (lib.git's "" cannot tell a clean status from a failed one)
function git(args) {
  try { return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 60000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; }
}
// the tree the command would test: "" when there is none to name (no repo, no commit, a dirty checkout)
function cleanTree() {
  const status = git(["status", "--porcelain", "--untracked-files=all"]);
  return status === "" ? String(git(["rev-parse", "--verify", "--quiet", "HEAD^{tree}"]) || "").trim() : "";
}

const here = String(git(["rev-parse", "--show-toplevel"]) || "").trim();
const top = process.env.PROTEUS_GATES_CACHE === "0" ? "" : here;
const common = top ? lib.gitCommonDir(top) : null;
const tree = common ? cleanTree() : "";
const prefix = tree ? String(git(["rev-parse", "--show-prefix"]) || "").trim() : "";
const dir = common && path.join(lib.stateDir(common), "gates");
const key = tree && crypto.createHash("sha256").update(`${tree}\0${prefix}\0${cmd}`).digest("hex");
const file = key && path.join(dir, `${key}.json`);

const hit = file && lib.readJSON(file, null);
if (hit && hit.tree === tree && hit.cmd === cmd) {
  for (const l of hit.tail || []) console.log(l);
  console.log(`gates-cache: hit, passed on tree ${tree.slice(0, 12)} at ${hit.at} in ${Math.round((hit.ms || 0) / 1000)}s; not run again: ${cmd}`);
  return;
}
if (common && !tree) console.error("gates-cache: uncommitted or untracked changes, running uncached");

// worker worktrees live in <repo>/.worktrees/; a runner or linter that does not skip that folder would run their files
// too (vitest, jest and eslint do not skip it by default)
const nested = here ? lib.worktreesUnder(here, cwd) : [];
if (nested.length) console.error(`gates-cache: ${nested.length} worktree(s) inside this folder (${nested.map((w) => path.relative(cwd, w)).slice(0, 3).join(", ")}); a tool that does not skip them checks their files too. Run the suite from .worktrees/_run, or exclude .worktrees/ in the tool's config.`);

const t0 = Date.now();
let tail = "";
const keep = (chunk) => { tail = (tail + chunk).slice(-64 * 1024); };
const child = spawn(cmd, { cwd, shell: true, stdio: ["inherit", "pipe", "pipe"], windowsHide: true });
child.stdout.on("data", (c) => { process.stdout.write(c); keep(String(c)); });
child.stderr.on("data", (c) => { process.stderr.write(c); keep(String(c)); });
child.on("error", (e) => { console.error(`gates-cache: cannot run: ${e.message}`); process.exitCode = 127; });
child.on("close", (code, signal) => {
  const status = signal ? 1 : code === null ? 1 : code;
  if (status === 0 && file && cleanTree() === tree) store();
  process.exitCode = process.exitCode || status;
});

function store() {
  try {
    const lines = tail.replace(/\r/g, "").split("\n").filter((l) => l.trim()).slice(-TAIL);
    lib.writeJSON(file, { tree, dir: prefix, cmd, at: new Date().toISOString(), ms: Date.now() - t0, tail: lines });
    const all = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    if (all.length <= KEEP) return;
    const age = (f) => { try { return fs.statSync(path.join(dir, f)).mtimeMs; } catch { return 0; } };
    for (const f of all.sort((a, b) => age(a) - age(b)).slice(0, all.length - KEEP)) fs.rmSync(path.join(dir, f), { force: true });
  } catch {}
}

#!/usr/bin/env node
// Container entrypoint (#80): runs inside the image proteus-container.js builds, never on the host. Clones
// /in/in.bundle into /work/repo on its one branch, runs `claude -p --permission-mode bypassPermissions --output-format
// json` there with /in/prompt.md on stdin and writes its stdout to /out/result.json, commits anything left
// uncommitted as "wip: uncommitted worker changes", and bundles the branch's new commits to /out/out.bundle.
// The host reads only that bundle, through its pinned git; the clone's config and hooks never leave the container.
// PROTEUS_CONTAINER_TEST_ROOT maps /in, /out and /work to <root>/in, <root>/out and <root>/work, for tests only: the
// runner passes no env into the container but the credential's name.
// Always exits 0 once /out/status.json ({ exit, error, unchanged }) is written.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = process.env.PROTEUS_CONTAINER_TEST_ROOT;
const at = (d) => (ROOT ? path.join(ROOT, d) : `/${d}`);
const IN = at("in"), OUT = at("out"), WORK = at("work"), REPO = path.join(WORK, "repo");
// the worker owns the clone's config and hooks; this script's own git calls run neither
const SAFE = ["-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`, "-c", "core.fsmonitor=false"];

function git(args, cwd = REPO) {
  const r = spawnSync("git", [...SAFE, ...args], { cwd, encoding: "utf8", windowsHide: true, timeout: 600000, maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0) throw new Error(`git ${args[0]}: ${String(r.stderr || (r.error && r.error.message) || "").trim().split("\n").pop()}`);
  return r.stdout.trim();
}

function main() {
  const status = { exit: null, error: null, unchanged: false };
  try {
    const bundle = path.join(IN, "in.bundle");
    const heads = git(["bundle", "list-heads", bundle], WORK).split("\n").map((l) => /^([0-9a-f]{40,64}) refs\/heads\/(\S+)$/.exec(l.trim())).filter(Boolean);
    if (heads.length !== 1) throw new Error(`in.bundle holds ${heads.length} branches, not one`);
    const [, base, branch] = heads[0];
    git(["clone", "-q", "--branch", branch, bundle, REPO], WORK);
    try { git(["config", "user.email"]); } catch { git(["config", "user.name", "Proteus worker"]); git(["config", "user.email", "proteus-worker@localhost"]); }

    const c = spawnSync("claude", ["-p", "--permission-mode", "bypassPermissions", "--output-format", "json"],
      { cwd: REPO, input: fs.readFileSync(path.join(IN, "prompt.md")), windowsHide: true, maxBuffer: 256 << 20, stdio: ["pipe", "pipe", "inherit"] });
    status.exit = c.status;
    if (c.error) status.error = `claude: ${c.error.message}`;
    fs.writeFileSync(path.join(OUT, "result.json"), c.stdout || "");

    git(["add", "-A"]);
    if (spawnSync("git", [...SAFE, "diff", "--cached", "--quiet"], { cwd: REPO, windowsHide: true, timeout: 600000 }).status === 1) git(["commit", "-q", "-m", "wip: uncommitted worker changes"]);
    const tip = git(["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
    if (tip === base) status.unchanged = true;
    else git(["bundle", "create", "-q", path.join(OUT, "out.bundle"), `refs/heads/${branch}`, `^${base}`]);
  } catch (e) {
    status.error = [status.error, e.message].filter(Boolean).join("; ");
  }
  try { fs.writeFileSync(path.join(OUT, "status.json"), JSON.stringify(status) + "\n"); } catch {}
  return 0;
}

if (require.main === module) process.exitCode = main();

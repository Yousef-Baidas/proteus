// Runs every tests/*.test.js in turn and totals their "N passed, M failed" lines.
// Exits 1 if any file exits non-zero, crashes, prints no summary line, or none are found; else 0.
// A file that fails to finish cleanly is named and counted in the last line, whose "failed" total includes it.
// Exits 1 too if the run changed the checkout (#218): its git status or a tracked file's blob hash, listed by path;
// outside a git repo that check is skipped.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const git = (args, cwd) => { const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: 60000, maxBuffer: 256 * 1024 * 1024 }); return r.status === 0 ? r.stdout : null; };
const TOP = (git(["rev-parse", "--show-toplevel"], __dirname) || "").trim();

// path -> status code plus blob hash, for every tracked file and every path git status names
function snapshot() {
  const snap = new Map();
  for (const e of (git(["status", "--porcelain", "-z", "--untracked-files=all"], TOP) || "").split("\0")) if (e.length > 3) snap.set(e.slice(3), e.slice(0, 2));
  for (const p of (git(["ls-files", "-z"], TOP) || "").split("\0").filter(Boolean)) {
    let h = "missing";
    try { const b = fs.readFileSync(path.join(TOP, p)); h = crypto.createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex"); } catch {}
    snap.set(p, `${snap.get(p) || ""} ${h}`);
  }
  return snap;
}
const before = TOP ? snapshot() : null;

const files = fs.readdirSync(__dirname).filter((f) => f.endsWith(".test.js")).sort();
console.log(`${__dirname}: ${files.length} test files`);
let pass = 0, fail = 0, bad = 0;
for (const f of files) {
  // maxBuffer: the 1 MiB default kills a chatty file and loses its summary line
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  // one block per file on one stream, so a crash's stderr trace stays next to its stdout and its FAIL line
  const m = /^(\d+) passed, (\d+) failed$/m.exec(r.stdout || "");
  let out = (r.stdout || "") + (r.stderr ? (r.stdout && !r.stdout.endsWith("\n") ? "\n" : "") + r.stderr : "");
  if (out && !out.endsWith("\n")) out += "\n";
  if (m) { pass += +m[1]; fail += +m[2]; }
  if (r.status !== 0 || !m) {
    bad++;
    if (r.error || r.signal) out += `FAIL ${f}: ${r.error ? r.error.message : `killed by ${r.signal}`}\n`;
    else if (!m) out += `FAIL ${f}: no summary line (exit ${r.status})\n`;
    else out += `FAIL ${f}: exit ${r.status} after its summary line\n`;
    // a file that crashed after printing a clean summary, or exited non-zero with 0 failed, still counts once
    if (!m || !+m[2]) fail++;
  }
  process.stdout.write(out);
}
let dirty = false;
if (before) {
  const after = snapshot();
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter((p) => before.get(p) !== after.get(p)).sort();
  if (changed.length) { dirty = true; fail++; console.log(`FAIL the run changed the checkout ${TOP}:\n${changed.map((p) => `  ${p}`).join("\n")}`); }
}
console.log(`\n${pass} passed, ${fail} failed across ${files.length} files${bad ? ` (${bad} did not finish cleanly)` : ""}`);
process.exitCode = bad || dirty || !files.length ? 1 : 0;

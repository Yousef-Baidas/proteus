// Runs every tests/*.test.js, several at once, and totals their "N passed, M failed" lines. Output stays in file order.
// PROTEUS_TEST_JOBS sets how many run at once; the default is the CPU count, at most 8.
// Exits 1 if any file exits non-zero, crashes, prints no summary line, or none are found; else 0.
// A file that fails to finish cleanly is named and counted in the last line, whose "failed" total includes it.
// Exits 1 too if the run changed the checkout (#218): its git status or a tracked file's blob hash, listed by path;
// outside a git repo that check is skipped.
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");

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
const JOBS = Math.max(1, Math.floor(+process.env.PROTEUS_TEST_JOBS) || Math.min(os.availableParallelism(), 8));

function runFile(f) {
  return new Promise((resolve) => {
    const r = { stdout: "", stderr: "", status: null, signal: null, error: null };
    const child = spawn(process.execPath, [path.join(__dirname, f)], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    child.stdout.setEncoding("utf8").on("data", (d) => { r.stdout += d; });
    child.stderr.setEncoding("utf8").on("data", (d) => { r.stderr += d; });
    child.on("error", (e) => { r.error = e; resolve(r); });
    child.on("close", (status, signal) => { r.status = status; r.signal = signal; resolve(r); });
  });
}

function report(f, r) {
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

// runs names, jobs at a time, reporting each as soon as every file before it has finished
async function runAll(names, jobs) {
  const done = [];
  let next = 0, shown = 0;
  const flush = () => { while (shown < names.length && done[shown]) { report(names[shown], done[shown]); shown++; } };
  const worker = async () => {
    while (next < names.length) {
      const i = next++;
      done[i] = await runFile(names[i]);
      flush();
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, names.length) }, worker));
}

async function main() {
  await runAll(files, JOBS);
  let dirty = false;
  if (before) {
    const after = snapshot();
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter((p) => before.get(p) !== after.get(p)).sort();
    if (changed.length) { dirty = true; fail++; console.log(`FAIL the run changed the checkout ${TOP}:\n${changed.map((p) => `  ${p}`).join("\n")}`); }
  }
  console.log(`\n${pass} passed, ${fail} failed across ${files.length} files${bad ? ` (${bad} did not finish cleanly)` : ""}`);
  process.exitCode = bad || dirty || !files.length ? 1 : 0;
}
main();

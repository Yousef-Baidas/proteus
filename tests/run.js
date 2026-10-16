// Runs every tests/*.test.js in turn and totals their "N passed, M failed" lines.
// Exits 1 if any file exits non-zero, crashes, prints no summary line, or none are found; else 0.
// A file that fails to finish cleanly is named and counted in the last line, whose "failed" total includes it.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const files = fs.readdirSync(__dirname).filter((f) => f.endsWith(".test.js")).sort();
console.log(`${__dirname}: ${files.length} test files`);
let pass = 0, fail = 0, bad = 0;
for (const f of files) {
  // maxBuffer: the 1 MiB default kills a chatty file and loses its summary line
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  process.stdout.write(r.stdout || "");
  process.stderr.write(r.stderr || "");
  const m = /^(\d+) passed, (\d+) failed$/m.exec(r.stdout || "");
  if (m) { pass += +m[1]; fail += +m[2]; }
  if (r.status !== 0 || !m) {
    bad++;
    if (r.error || r.signal) console.log(`FAIL ${f}: ${r.error ? r.error.message : `killed by ${r.signal}`}`);
    else if (!m) console.log(`FAIL ${f}: no summary line (exit ${r.status})`);
    // a file that crashed after printing a clean summary, or exited non-zero with 0 failed, still counts once
    if (!m || !+m[2]) fail++;
  }
}
console.log(`\n${pass} passed, ${fail} failed across ${files.length} files${bad ? ` (${bad} did not finish cleanly)` : ""}`);
process.exitCode = bad || !files.length ? 1 : 0;

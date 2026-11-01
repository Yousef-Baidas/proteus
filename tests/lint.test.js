// Lint gate contract (#9): the repo lints clean, and a fixture with a known anti-slop violation does not.
// Spawns node_modules/.bin/oxlint (oxlint.cmd on win32); PROTEUS_OXLINT overrides that binary path, for tests only.
// tests/fixtures/ is ignored by .oxlintrc.json so case (a) never sees the deliberate violation.
// Exit 0 if every assertion passed, 1 otherwise; a missing binary prints "SKIP lint: run npm ci" and fails only when CI is set.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { ok, summary, tempdir } = require(path.join(__dirname, "lib.js"));

const ROOT = path.join(__dirname, "..");
const BIN = process.env.PROTEUS_OXLINT || path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "oxlint.cmd" : "oxlint");

if (!fs.existsSync(BIN)) {
  console.log("SKIP lint: run npm ci");
  ok("oxlint is installed (npm ci)", !process.env.CI, BIN);
} else {
  const lint = (args, cwd) => spawnSync(BIN, args, { cwd, encoding: "utf8", shell: process.platform === "win32", env: { ...process.env, NO_COLOR: "1" } });

  // --deny-warnings: oxlint exits 0 on warnings, and the anti-slop rules must not slide as warnings
  const repo = lint(["--deny-warnings"], ROOT);
  ok("linting the repo exits 0", repo.status === 0, `${repo.status} ${repo.stdout}${repo.stderr}`);

  // lint a copy in tmp so the ignore of tests/fixtures/ cannot hide it; the repo config still applies
  const tmp = tempdir("lint");
  try {
    fs.copyFileSync(path.join(__dirname, "fixtures", "slop.js"), path.join(tmp, "slop.js"));
    const bad = lint(["--deny-warnings", "-c", path.join(ROOT, ".oxlintrc.json"), "slop.js"], tmp);
    const text = `${bad.stdout}${bad.stderr}`;
    ok("linting a fixture with a known violation exits non-zero", bad.status !== null && bad.status !== 0, `${bad.status} ${text}`);
    ok("the lint output names the anti-slop rule", /no-array-filter-map/.test(text), text);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

summary();

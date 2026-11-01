// The suite's temp dir check (#317): node tests/testtemp.test.js. Runs a copy of tests/run.js over small test files in a
// temp dir, so the check is exercised without touching the real suite: a clean run passes, a leak fails and is named,
// and the run's own temp dir is gone afterwards in every case, a signal included.
// Exit 0 if every assertion passed, 1 otherwise.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { ok, summary, tempdir } = require(path.join(__dirname, "lib.js"));

const HEAD = `const lib = require("./lib.js");\n`;
const CLEAN = `${HEAD}lib.workdir("x"); lib.ok("a", true); lib.summary();\n`;
// made by hand, so nothing removes it, and the file exits as if all was well
const STRAY = `${HEAD}const fs = require("fs"), os = require("os"), path = require("path");
fs.mkdtempSync(path.join(os.tmpdir(), "proteus-test-"));
lib.ok("a", true); lib.summary();\n`;
// the helper's root, with the file dead before its exit handler can run
const KILLED = `${HEAD}lib.workdir("x"); process.kill(process.pid, "SIGKILL");\n`;
const HANGS = `${HEAD}lib.workdir("x"); setInterval(() => {}, 1000);\n`;

// a checkout-shaped dir outside any git repo, holding these test files; base is the temp dir its run starts from
function fixture(tests) {
  const d = tempdir("suite"), t = path.join(d, "tests"), base = path.join(d, "tmp");
  fs.mkdirSync(t);
  fs.mkdirSync(base);
  for (const f of ["run.js", "lib.js", "fakegh.js"]) fs.copyFileSync(path.join(__dirname, f), path.join(t, f));
  for (const [f, text] of Object.entries(tests)) fs.writeFileSync(path.join(t, f), text);
  const env = { ...process.env, TMPDIR: base, TEMP: base, TMP: base, PROTEUS_TEST_JOBS: "2" };
  return { script: path.join(t, "run.js"), base, env };
}
function suite(tests) {
  const fx = fixture(tests);
  const r = spawnSync(process.execPath, [fx.script], { env: fx.env, encoding: "utf8", windowsHide: true, timeout: 60000 });
  return { ...r, said: `${r.stdout}${r.stderr}`, rest: fs.readdirSync(fx.base) };
}

let r = suite({ "a.test.js": CLEAN, "b.test.js": CLEAN });
ok("a clean run passes", r.status === 0 && /^2 passed, 0 failed across 2 files$/m.test(r.stdout), r.said);
ok("a clean run names no leftover", !/left temp dirs/.test(r.said), r.said);
ok("a clean run removes its temp dir", r.rest.length === 0, r.rest.join(" "));

r = suite({ "a.test.js": CLEAN, "b.test.js": STRAY });
ok("a leak fails the run", r.status === 1 && /^FAIL the run left temp dirs behind/m.test(r.stdout), r.said);
ok("the failure names the entry", /^ {2}proteus-test-\S+$/m.test(r.stdout), r.said);
ok("the leak counts in the failed total", /^2 passed, 1 failed across 2 files$/m.test(r.stdout), r.said);
ok("a run with a leak still removes its temp dir", r.rest.length === 0, r.rest.join(" "));

r = suite({ "a.test.js": CLEAN, "b.test.js": KILLED });
ok("a leak from the helper names its test file", r.status === 1 && /^ {2}proteus-test-\S+ \(b\.test\.js\)$/m.test(r.stdout), r.said);
ok("a run with a killed file still removes its temp dir", r.rest.length === 0, r.rest.join(" "));

// win32 has no catchable SIGTERM from another process: kill() there ends the runner outright
async function signalled() {
  if (process.platform === "win32") return;
  const fx = fixture({ "a.test.js": HANGS, "b.test.js": HANGS });
  const c = spawn(process.execPath, [fx.script], { env: fx.env, stdio: "ignore" });
  const roots = () => fs.readdirSync(fx.base).flatMap((p) => fs.readdirSync(path.join(fx.base, p))).filter((n) => n.startsWith("proteus-test-"));
  const end = Date.now() + 30000;
  while (roots().length < 2 && Date.now() < end) await new Promise((res) => setTimeout(res, 50));
  ok("the hung files have started", roots().length === 2, roots().join(" "));
  const code = await new Promise((res) => { c.on("close", res); c.kill("SIGTERM"); });
  ok("a signalled run exits non-zero", code === 143, String(code));
  ok("a signalled run removes its temp dir", fs.readdirSync(fx.base).length === 0, fs.readdirSync(fx.base).join(" "));

  // one file run alone: nothing above it to clean up
  const one = fixture({ "a.test.js": HANGS });
  const alone = spawn(process.execPath, [path.join(path.dirname(one.script), "a.test.js")], { env: one.env, stdio: "ignore" });
  const end2 = Date.now() + 30000;
  while (!fs.readdirSync(one.base).length && Date.now() < end2) await new Promise((res) => setTimeout(res, 50));
  await new Promise((res) => setTimeout(res, 200));
  const gone = await new Promise((res) => { alone.on("close", res); alone.kill("SIGTERM"); });
  ok("a file run alone removes its root on a signal", gone === 143 && fs.readdirSync(one.base).length === 0, `${gone} ${fs.readdirSync(one.base).join(" ")}`);
}

signalled().then(summary);

// Baseline ratchet tests: node tests/baseline.test.js (needs git). proteus-baseline.js runs a gate's command,
// records its findings in teams/baseline.json, and fails later runs only on findings the baseline lacks.
// Temp repo; the gate commands are node one-liners, so nothing depends on a shell's echo.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const BL = path.join(ROOT, "templates", "hooks", "proteus-baseline.js");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("baseline");

const REPO = path.join(W, "repo");
g(W, "init", "-q", "-b", "main", REPO);
const FILE = path.join(REPO, "teams", "baseline.json");
// a gate command printing lines and exiting with code, as argv after --
const gate = (lines, code = 1) => ["--", process.execPath, "-e", `console.log(${JSON.stringify(lines.join("\n"))}); process.exit(${code})`];
const bl = (name, opts, cmd, cwd = REPO) => lib.run(BL, "", { cwd, args: [name, ...opts, ...cmd] });
const base = () => JSON.parse(fs.readFileSync(FILE, "utf8"));

const red = ["FAIL src/a.test.js > adds (12 ms)", "ok b", `Error: boom at ${REPO}/src/a.js:10:3`];

// no baseline: the gate's own exit code
ok("no baseline: a red gate fails and says nothing is recorded", ((r) => r.code === 1 && /no baseline recorded/.test(r.err))(bl("test", [], gate(red))));
ok("no baseline: a green gate passes", bl("test", [], gate(["all good"], 0)).code === 0);
ok("no baseline: the command's output is passed through", /FAIL src\/a\.test\.js/.test(bl("test", [], gate(red)).out));

// record, then compare
let r = bl("test", ["--record"], gate(red));
ok("record: writes teams/baseline.json with the normalised findings", r.code === 0 && fs.existsSync(FILE) && base().gates.test.findings.length === 2, r.err);
ok("record: digits and the checkout path are normalised away", base().gates.test.findings.includes("Error: boom at ./src/a.js:#:#") && base().gates.test.findings.includes("FAIL src/a.test.js > adds (# ms)"), JSON.stringify(base()));
ok("record: stores the mode, the match, and a red exit", base().gates.test.mode === "lines" && base().gates.test.exit === 1 && typeof base().gates.test.match === "string");
ok("compare: the same failures with other timings and line numbers pass", ((x) => x.code === 0 && /no new findings \(2 known\)/.test(x.err))(bl("test", [], gate(["FAIL src/a.test.js > adds (99 ms)", `Error: boom at ${REPO}/src/a.js:11:3`]))));
r = bl("test", [], gate([...red, "FAIL src/c.test.js > new"]));
ok("compare: a new failing line fails and is named", r.code === 1 && /1 new finding/.test(r.err) && /FAIL src\/c\.test\.js > new/.test(r.err), r.err);
ok("compare: the same line twice more than recorded is new", bl("test", [], gate([...red, red[0]])).code === 1);
r = bl("test", [], gate([red[0]]));
ok("compare: a fixed failure passes and suggests tightening", r.code === 0 && /1 fixed: tighten with --record/.test(r.err), r.err);
r = bl("test", [], gate(["Segmentation fault"], 139));
ok("compare: a red exit with no recognised finding fails", r.code === 1 && /finds nothing in its output/.test(r.err), r.err);
ok("compare: a green exit passes and suggests dropping the baseline", ((x) => x.code === 0 && /green; drop its baseline/.test(x.err))(bl("test", [], gate(["done"], 0))));

// the ratchet only tightens
r = bl("test", ["--record"], gate([...red, "FAIL src/c.test.js > new"]));
ok("record: refuses to add a finding to an existing baseline", r.code === 1 && /only tightens/.test(r.err) && base().gates.test.findings.length === 2, r.err);
r = bl("test", ["--record"], gate([red[0]]));
ok("record: tightens to the remaining findings", r.code === 0 && base().gates.test.findings.length === 1, r.err);
r = bl("test", ["--reset"], gate([...red, "FAIL src/c.test.js > new"]));
ok("reset: re-records from scratch, new findings included", r.code === 0 && base().gates.test.findings.length === 3, r.err);
r = bl("test", ["--record"], gate(["done"], 0));
ok("record: a green run records exit 0 and no findings", r.code === 0 && base().gates.test.exit === 0 && !base().gates.test.findings.length, r.err);
ok("compare: once recorded green, any red exit fails", ((x) => x.code === 1 && /was green when its baseline was recorded/.test(x.err))(bl("test", [], gate(red))));

// custom match, ignore, count mode
r = bl("pytest", ["--record", "--match", "^FAILED ", "--ignore", " - .*$"], gate(["FAILED t.py::a - assert 1 == 2", "2 failed"]));
ok("match/ignore: only matching lines, the ignored tail dropped", r.code === 0 && JSON.stringify(base().gates.pytest.findings) === JSON.stringify(["FAILED t.py::a"]), JSON.stringify(base().gates.pytest));
ok("match/ignore: kept for later runs, a different message tail still known", bl("pytest", [], gate(["FAILED t.py::a - assert 3 == 4"])).code === 0);
r = bl("lint", ["--record", "--mode", "count", "--match", "(\\d+) (?:errors?|warnings?)"], gate(["src/a.js: 2 errors, 1 warning"]));
ok("count: records the sum of every captured number", r.code === 0 && base().gates.lint.count === 3 && base().gates.lint.mode === "count", r.err);
ok("count: a higher count fails", bl("lint", [], gate(["4 errors"])).code === 1);
ok("count: an equal or lower count passes", bl("lint", [], gate(["3 errors"])).code === 0 && /tighten/.test(bl("lint", [], gate(["1 error"])).err));
ok("count: needs --match", bl("x", ["--mode", "count"], gate(["1 error"])).code === 2);
ok("other gates in the file are untouched", base().gates.test && base().gates.pytest && base().gates.lint);

// one shell line, --file, usage
const alt = path.join(W, "alt.json");
r = bl("sh", ["--record", "--file", alt], ["--", "node -e \"console.log('FAIL x'); process.exit(1)\""]);
ok("a single argument runs as a shell line; --file picks the baseline", r.code === 0 && JSON.parse(fs.readFileSync(alt, "utf8")).gates.sh.findings[0] === "FAIL x", r.err);
ok("a subdirectory finds the checkout's teams/baseline.json", (() => { fs.mkdirSync(path.join(REPO, "src"), { recursive: true }); return /was green/.test(bl("test", [], gate(red), path.join(REPO, "src")).err); })());
ok("usage: no gate name or no command exits 2", bl("--record", [], gate(red)).code === 2 && lib.run(BL, "", { cwd: REPO, args: ["test"] }).code === 2);

// argv reaches the command unchanged, quotes and cmd metacharacters included; on win32 also through a .cmd shim,
// by path and by bare name on PATH, which is how npx runs there
const plib = require(path.join(ROOT, "templates", "hooks", "proteus-lib.js"));
const ARGS = ['a "b" > c', "x & y | z", "plain", "(p) ^ !q", "trail\\", ""];
const echo = path.join(W, "argv.js");
fs.writeFileSync(echo, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
const same = (x) => x.status === 0 && x.stdout === JSON.stringify(ARGS);
r = plib.spawnArgv(process.execPath, [echo, ...ARGS]);
ok("spawnArgv: an executable gets each argument as given", same(r), JSON.stringify(r.stdout) + r.stderr);
if (process.platform === "win32") {
  const SHIM = path.join(W, "shim");
  fs.mkdirSync(SHIM, { recursive: true });
  fs.writeFileSync(path.join(SHIM, "argv.cmd"), `@"${process.execPath}" "${echo}" %*\r\n`);
  r = plib.spawnArgv(path.join(SHIM, "argv.cmd"), ARGS);
  ok("spawnArgv: a .cmd shim by path gets each argument as given", same(r), JSON.stringify(r.stdout) + r.stderr);
  r = plib.spawnArgv("argv", ARGS, { env: { ...process.env, PATH: SHIM + path.delimiter + process.env.PATH } });
  ok("spawnArgv: a .cmd shim found on PATH gets each argument as given", same(r), JSON.stringify(r.stdout) + r.stderr);
}

lib.summary();

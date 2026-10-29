// CI security job tests: node tests/scan.test.js. proteus-scan.js runs the scanners proteus-trust.yml installs on a PR
// head checked out as data, skipping with one logged line each tool whose ecosystem the PR does not touch; their
// SARIF goes to proteus-security.js --findings, where a finding turns proteus/security red unless teams/baseline.json
// records it. The scanners are fakes on PATH that log their arguments, so this runs offline and on win32; when a real
// gitleaks is installed, a planted secret is also caught end to end, a .gitleaksignore in the PR notwithstanding, else
// that check logs a skip line.
// Exit 0 if every assertion passed, 1 otherwise.
"use strict";
const fs = require("fs");
const path = require("path");
const url = require("url");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const HOOKS = path.join(ROOT, "templates", "hooks");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("scan");
const BIN = path.join(W, "bin");

const SCAN = path.join(HOOKS, "proteus-scan.js");
const SEC = path.join(HOOKS, "proteus-security.js");
const BASELINE = path.join(HOOKS, "proteus-baseline.js");
const LOG = path.join(W, "scan.log");
const OUT = path.join(W, "out");

// a fake scanner: logs { tool, args, cwd }, reports FAKE_SCAN_<TOOL> ([[rule, uri]]) as SARIF where the real one
// writes it (actionlint: its JSON on stdout) and exits FAKE_SCAN_EXIT_<TOOL>
const fake = (tool) => `const fs = require("fs");
const TOOL = ${JSON.stringify(tool)}, args = process.argv.slice(2), key = TOOL.replace(/-/g, "_").toUpperCase();
fs.appendFileSync(process.env.FAKE_SCAN_LOG, JSON.stringify({ tool: TOOL, args, cwd: process.cwd() }) + "\\n");
const found = JSON.parse(process.env["FAKE_SCAN_" + key] || "[]"), exit = +(process.env["FAKE_SCAN_EXIT_" + key] || 0);
if (TOOL === "actionlint") { process.stdout.write(JSON.stringify(found.map(([kind, filepath]) => ({ kind, filepath, message: "m", line: 1, column: 1 })))); process.exit(exit); }
const sarif = { version: "2.1.0", runs: [{ tool: { driver: { name: TOOL } }, results: found.map(([ruleId, uri]) => ({ ruleId, message: { text: "m" }, locations: [{ physicalLocation: { artifactLocation: { uri } } }] })) }] };
const at = args.findIndex((a) => ["--report-path", "--sarif-output", "--output-file"].includes(a));
if (at >= 0) fs.writeFileSync(args[at + 1], JSON.stringify(sarif)); else process.stdout.write(JSON.stringify(sarif));
process.exit(exit);
`;
// on win32 a .cmd shim: lib.fakeCli's copy of node.exe would read zizmor's and actionlint's leading flags as its own
const install = (...tools) => {
  for (const t of tools) {
    if (process.platform !== "win32") { lib.fakeCli(BIN, t, fake(t)); continue; }
    fs.writeFileSync(path.join(BIN, `${t}.fake`), fake(t));
    fs.writeFileSync(path.join(BIN, `${t}.cmd`), `@"${process.execPath}" "${path.join(BIN, `${t}.fake`)}" %*\r\n`);
  }
};
const uninstall = (...tools) => { for (const t of tools) for (const f of fs.readdirSync(BIN)) if (f === t || f.startsWith(`${t}.`)) fs.rmSync(path.join(BIN, f)); };
install("semgrep", "gitleaks", "osv-scanner", "zizmor");

const calls = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const call = (tool) => calls().find((c) => c.tool === tool);
const scan = (args, env = {}) => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.writeFileSync(LOG, "");
  return lib.run(SCAN, "", { cwd: W, args, env: { FAKE_SCAN_LOG: LOG, ...env } });
};
const sarif = (tool) => JSON.parse(fs.readFileSync(path.join(OUT, `${tool}.sarif`), "utf8"));

// a token shaped like a GitHub PAT, made at run time so no secret sits in this file
const token = () => "ghp_" + [...crypto.randomBytes(36)].map((b) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[b % 62]).join("");

// the PR: a base commit, then a head that plants a secret marked gitleaks:allow, so only --ignore-gitleaks-allow sees it
const REPO = path.join(W, "repo");
g(W, "init", "-q", "-b", "main", REPO);
fs.writeFileSync(path.join(REPO, "README.md"), "# app\n");
g(REPO, "add", "-A"); g(REPO, "commit", "-qm", "init");
const BASE_SHA = g(REPO, "rev-parse", "HEAD");
fs.mkdirSync(path.join(REPO, "src"));
fs.writeFileSync(path.join(REPO, "src", "cfg.js"), `const key = "${token()}"; // gitleaks:allow\n`);
fs.writeFileSync(path.join(REPO, ".gitleaks.toml"), "[allowlist]\npaths = ['''.*''']\n");
g(REPO, "add", "-A"); g(REPO, "commit", "-qm", "config");
const HEAD_SHA = g(REPO, "rev-parse", "HEAD");
const pr = (base = BASE_SHA, head = HEAD_SHA, extra = []) => ["--dir", REPO, "--out", OUT, "--base", base, "--head", head, ...extra];

// ---- usage
ok("scan: bad usage exits 2", [[], ["--dir", REPO], ["--dir", REPO, "--out", OUT, "--base", BASE_SHA], ["--dir", REPO, "--out", OUT, "--all", "--base", BASE_SHA],
  ["--dir", REPO, "--out", OUT, "--base", "main", "--head", HEAD_SHA], [...pr(), "--bogus"]].every((a) => scan(a).code === 2));

// ---- the planted secret, through to a red proteus/security
const found = JSON.stringify([["github-pat", "src/cfg.js"]]);
let r = scan(pr(undefined, undefined, ["--require"]), { FAKE_SCAN_GITLEAKS: found });
const gl = call("gitleaks") || { args: [] };
ok("scan: gitleaks reads the PR's commits base..head from a mirror in --out, run there, with its config and ignore file from --out and inline allows ignored",
  r.code === 0 && gl.cwd === OUT && gl.args.slice(0, 2).join() === `git,${path.join(OUT, "gitleaks-head.git")}` && !fs.existsSync(path.join(OUT, "gitleaks-head.git")) && gl.args.includes(`--log-opts=${BASE_SHA}..${HEAD_SHA}`) && gl.args.includes("--ignore-gitleaks-allow")
  && gl.args[gl.args.indexOf("--config") + 1] === path.join(OUT, "gitleaks.toml") && gl.args[gl.args.indexOf("--gitleaks-ignore-path") + 1] === path.join(OUT, "gitleaks.ignore")
  && /useDefault = true/.test(fs.readFileSync(path.join(OUT, "gitleaks.toml"), "utf8")) && gl.args.includes("--redact"), r.out + r.err + JSON.stringify(gl));
const sg = call("semgrep") || { args: [] };
ok("scan: semgrep scans the changed files as ./paths with OWASP and secrets rules, inline nosemgrep and .semgrepignore off",
  sg.args.slice(-2).join() === "./.gitleaks.toml,./src/cfg.js" && sg.args.includes("p/owasp-top-ten") && sg.args.includes("p/secrets")
  && sg.args.includes("--disable-nosem") && sg.args.includes("--x-ignore-semgrepignore-files") && sg.args.join(" ").includes("--metrics off"), JSON.stringify(sg));
ok("scan: no lockfile and no workflow changed: osv-scanner and zizmor each log one skip line and are not run",
  r.out.split("\n").filter((l) => l.endsWith("osv-scanner skipped: no lockfile changed")).length === 1 && /zizmor skipped: no workflow changed$/m.test(r.out)
  && !call("osv-scanner") && !call("zizmor") && !fs.existsSync(path.join(OUT, "osv-scanner.sarif")), r.out);
ok("scan: the gitleaks finding lands in gitleaks.sarif", sarif("gitleaks").runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri === "src/cfg.js"
  && /gitleaks: 1 finding in [0-9a-f]{12}\.\.[0-9a-f]{12}/.test(r.out), r.out);

const BASEDIR = path.join(W, "base");
fs.mkdirSync(path.join(BASEDIR, "teams"), { recursive: true });
fs.copyFileSync(path.join(ROOT, "templates", "teams", "ROUTING.md"), path.join(BASEDIR, "teams", "ROUTING.md"));
const PRF = path.join(W, "pr.json");
const SHA = "a".repeat(40);
const ghEnv = { FAKE_GH_PR: PRF, FAKE_GH_LOG: path.join(W, "gh.log") };
const sec = (files, ...args) => {
  fs.writeFileSync(PRF, JSON.stringify({ head: SHA, files, statuses: {} }));
  const res = lib.run(SEC, "", { cwd: BASEDIR, args: ["--ci", "5", SHA, ...args], env: ghEnv });
  return { ...res, status: ((JSON.parse(fs.readFileSync(PRF, "utf8")).statuses || {})[SHA] || [])[0] || {} };
};
r = sec(["src/cfg.js", ".gitleaks.toml"]);
ok("security: without the findings the PR touches no security path", r.status.state === "success", r.out + r.err);
r = sec(["src/cfg.js", ".gitleaks.toml"], "--findings", OUT);
ok("security: the planted secret turns proteus/security red, naming the file and rule",
  r.code === 0 && r.status.state === "failure" && r.status.description === "needs the security verifier: src/cfg.js (gitleaks github-pat)", r.out + r.err);

// a secret deleted again before the PR's head is not in the PR's files, and still counts
r = sec(["README.md"], "--findings", OUT);
ok("security: a scanner's finding outside the PR's net files still counts (a secret a later commit removed)", r.status.state === "failure", r.out);

// the baseline: record today's findings through the ratchet, then only a new one is red
const BL = path.join(BASEDIR, "teams", "baseline.json");
const record = lib.run(BASELINE, "", { cwd: BASEDIR, args: ["security", "--record", "--match", "^finding ", "--file", BL, "--", process.execPath, SEC, "--list", OUT] });
ok("baseline: --list feeds the ratchet; the finding is recorded under gates.security",
  record.code === 0 && JSON.stringify(JSON.parse(fs.readFileSync(BL, "utf8")).gates.security.findings) === JSON.stringify(["finding gitleaks github-pat src/cfg.js"]), record.out + record.err);
r = sec(["src/cfg.js"], "--findings", OUT);
ok("security: a finding the baseline records does not block", r.status.state === "success" && r.status.description === "no security path touched" && /1 of them in the baseline/.test(r.out), r.out + r.err);
fs.writeFileSync(path.join(OUT, "extra.sarif"), JSON.stringify({ runs: [{ tool: { driver: { name: "semgrep" } }, results: [{ ruleId: "js.eval", locations: [{ physicalLocation: { artifactLocation: { uri: "./src/x.js" } } }] }] }] }));
r = sec(["src/cfg.js", "src/x.js"], "--findings", OUT);
ok("security: a new finding beside a recorded one is red", r.status.state === "failure" && /src\/x\.js \(semgrep js\.eval\)/.test(r.status.description), r.out + r.err);
fs.rmSync(path.join(OUT, "extra.sarif"));
fs.writeFileSync(path.join(OUT, "evil.sarif"), JSON.stringify({ runs: [{ tool: { driver: { name: "gitleaks" } }, results: [{ ruleId: "r\n::stop-commands::x", locations: [{ physicalLocation: { artifactLocation: { uri: "a\n::error::spoof.js" } } }] }] }] }));
r = sec(["src/cfg.js"], "--findings", OUT);
ok("security: a path or rule from the head prints and posts as one inert line, never a workflow command",
  r.status.state === "failure" && !/^\s*::/m.test(r.out) && /a\?::error::spoof\.js \(gitleaks r\?::stop-commands::x\)/.test(r.out), r.out + r.err);
fs.rmSync(path.join(OUT, "evil.sarif"));
r = sec(["::warning::x/auth/y.js"]);
ok("security: a changed path that itself starts with :: prints as an inert line",
  r.status.state === "failure" && !/^\s*::/m.test(r.out) && /^ {2}\?:warning::x\/auth\/y\.js \(\*\*\/auth\/\*\*\)$/m.test(r.out), r.out + r.err);
fs.writeFileSync(path.join(OUT, "semgrep.json"), JSON.stringify({ results: [{ check_id: "js.eval", path: "::x.js" }] }));
r = sec(["::x.js"], "--findings", OUT);
ok("security: a semgrep finding in a changed file named ::x.js still counts", r.status.state === "failure" && /\?:x\.js \(semgrep js\.eval\)/.test(r.out), r.out + r.err);
fs.rmSync(path.join(OUT, "semgrep.json"));
fs.rmSync(BL);

// the gate security matches exactly: a new CVE in a lockfile whose old CVE the baseline records is a new finding
const CVES = path.join(W, "cves");
const cve = (id) => {
  fs.rmSync(CVES, { recursive: true, force: true });
  fs.mkdirSync(CVES);
  fs.writeFileSync(path.join(CVES, "osv-scanner.sarif"), JSON.stringify({ runs: [{ tool: { driver: { name: "osv-scanner" } }, results: [{ ruleId: id, locations: [{ physicalLocation: { artifactLocation: { uri: "go.mod" } } }] }] }] }));
};
cve("CVE-2020-14040");
const recCve = lib.run(BASELINE, "", { cwd: BASEDIR, args: ["security", "--record", "--match", "^finding ", "--file", BL, "--", process.execPath, SEC, "--list", CVES] });
ok("baseline: the gate security records a finding with its digits", recCve.code === 0
  && JSON.stringify(JSON.parse(fs.readFileSync(BL, "utf8")).gates.security.findings) === JSON.stringify(["finding osv-scanner CVE-2020-14040 go.mod"]), recCve.out + recCve.err);
r = sec(["go.mod"], "--findings", CVES);
ok("security: the recorded CVE does not block", r.status.state === "success", r.out + r.err);
cve("CVE-2026-99999");
r = sec(["go.mod"], "--findings", CVES);
ok("security: CVE-2026-99999 in place of the recorded CVE-2020-14040 in the same lockfile is a new finding",
  r.status.state === "failure" && /go\.mod \(osv-scanner CVE-2026-99999\)/.test(r.status.description), r.out + r.err);
const cmpCve = lib.run(BASELINE, "", { cwd: BASEDIR, args: ["security", "--file", BL, "--", process.execPath, SEC, "--list", CVES] });
ok("baseline: and the ratchet sees it as new too", cmpCve.code === 1, cmpCve.out + cmpCve.err);
fs.rmSync(BL);
const list = lib.run(SEC, "", { cwd: BASEDIR, args: ["--list", OUT] });
ok("security: --list prints one line per finding and exits 1; an empty directory exits 0",
  list.code === 1 && list.out.trim() === "finding gitleaks github-pat src/cfg.js" && lib.run(SEC, "", { cwd: BASEDIR, args: ["--list", BIN] }).code === 0, list.out + list.err);
fs.writeFileSync(path.join(W, "bad.json"), JSON.stringify({ nope: 1 }));
r = sec(["src/cfg.js"], "--findings", path.join(W, "bad.json"));
ok("security: a report that is neither SARIF nor semgrep JSON exits 1 with nothing posted", r.code === 1 && /neither SARIF nor a semgrep JSON report/.test(r.err) && !r.status.state, r.err);

// no security block: CI used to check nothing; the scanners' findings still count
fs.writeFileSync(path.join(BASEDIR, "teams", "ROUTING.md"), "# Routing\n");
r = sec(["src/cfg.js"], "--findings", OUT);
ok("security: with no security block a finding is still red", r.status.state === "failure", r.out + r.err);
r = sec(["src/cfg.js"]);
ok("security: no block and no findings: success that says nothing was checked", r.status.state === "success" && /no security block/.test(r.status.description), r.out);

// ---- a lockfile and a workflow change
fs.mkdirSync(path.join(REPO, "app"));
fs.writeFileSync(path.join(REPO, "app", "package-lock.json"), "{}\n");
fs.mkdirSync(path.join(REPO, ".github", "workflows"), { recursive: true });
fs.writeFileSync(path.join(REPO, ".github", "workflows", "ci.yml"), "on: push\n");
fs.writeFileSync(path.join(REPO, "app", "osv-scanner.toml"), "[[IgnoredVulns]]\nid = 'X'\n");
g(REPO, "add", "-A"); g(REPO, "commit", "-qm", "deps");
const DEPS = g(REPO, "rev-parse", "HEAD");
const lockUri = url.pathToFileURL(path.join(REPO, "app", "package-lock.json")).href;
r = scan(pr(HEAD_SHA, DEPS, ["--require"]), { FAKE_SCAN_OSV_SCANNER: JSON.stringify([["GHSA-1", lockUri]]), FAKE_SCAN_EXIT_OSV_SCANNER: "1", FAKE_SCAN_ZIZMOR: JSON.stringify([["template-injection", ".github/workflows/ci.yml"]]) });
const osv = call("osv-scanner") || { args: [] }, zz = call("zizmor") || { args: [] };
ok("scan: a changed lockfile runs osv-scanner on it with the config from --out; its exit 1 (vulns) is a result, not a failure",
  r.code === 0 && osv.args.slice(0, 2).join() === "scan,source" && osv.args[osv.args.indexOf("-L") + 1] === "./app/package-lock.json" && osv.args.filter((a) => a === "-L").length === 1
  && osv.args[osv.args.indexOf("--config") + 1] === path.join(OUT, "osv-scanner.toml"), r.out + r.err + JSON.stringify(osv));
ok("scan: osv-scanner runs with call analysis off, so no go or cargo build runs on the head", osv.args.includes("--no-call-analysis=all"), JSON.stringify(osv));
ok("scan: osv-scanner's file:// location becomes the path in the checkout",
  sarif("osv-scanner").runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri === "app/package-lock.json", JSON.stringify(sarif("osv-scanner")));
ok("scan: a changed workflow runs zizmor offline with config and ignores off, its SARIF from stdout",
  ["--offline", "--no-config", "--no-ignores"].every((f) => zz.args.includes(f)) && zz.args[zz.args.length - 1] === "./.github/workflows/ci.yml"
  && sarif("zizmor").runs[0].results[0].ruleId === "template-injection", JSON.stringify(zz));
r = scan(pr(HEAD_SHA, DEPS), { FAKE_SCAN_EXIT_OSV_SCANNER: "128" });
ok("scan: osv-scanner finding no packages is clean, not a failure", r.code === 0 && /osv-scanner: nothing to check/.test(r.out), r.out + r.err);

uninstall("zizmor");
install("actionlint");
r = scan(pr(HEAD_SHA, DEPS), { FAKE_SCAN_ACTIONLINT: JSON.stringify([["expression", "./.github/workflows/ci.yml"]]), FAKE_SCAN_EXIT_ACTIONLINT: "1" });
const al = call("actionlint") || { args: [] };
ok("scan: without zizmor, actionlint lints the workflows and its JSON becomes actionlint.sarif",
  r.code === 0 && al.args.includes("-config-file") && al.args[al.args.length - 1] === "./.github/workflows/ci.yml"
  && sarif("actionlint").runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri === ".github/workflows/ci.yml", r.out + r.err);
uninstall("actionlint");
install("zizmor");
// a scanner missing from PATH; the stripped PATH keeps the system dirs, so one installed there cannot be tested missing
if (lib.SYS_PATH.some((d) => ["semgrep", "semgrep.exe"].some((n) => fs.existsSync(path.join(d, n))))) console.log("skip: semgrep is installed system-wide; the not-installed checks did not run");
else {
  uninstall("semgrep");
  r = scan(pr(HEAD_SHA, DEPS));
  ok("scan: a scanner not installed: one skip line and a pass", r.code === 0 && /semgrep skipped: not installed$/m.test(r.out) && call("gitleaks"), r.out + r.err);
  r = scan(pr(HEAD_SHA, DEPS, ["--require"]));
  ok("scan: --require turns a missing scanner into a failure", r.code === 1 && /semgrep is not installed, and --require needs it/.test(r.err), r.out + r.err);
  install("semgrep");
}

r = scan(pr(), { FAKE_SCAN_EXIT_SEMGREP: "2" });
ok("scan: a scanner that errors fails the scan", r.code === 1 && /semgrep exited 2; its findings are unknown/.test(r.err), r.out + r.err);
r = scan(pr("b".repeat(40), HEAD_SHA));
ok("scan: a base the checkout lacks fails before any scanner runs", r.code === 1 && /git cannot list the changed files/.test(r.err) && !calls().length, r.err);

r = scan(["--dir", REPO, "--out", OUT, "--all"]);
const all = call("semgrep") || { args: [] };
ok("scan: --all scans every tracked file and lockfile, gitleaks skipped",
  r.code === 0 && all.args.includes("./README.md") && all.args.includes("./src/cfg.js") && /gitleaks skipped: it reads a PR's commits/.test(r.out) && !call("gitleaks")
  && (call("osv-scanner") || { args: [] }).args.includes("./app/package-lock.json"), r.out + r.err);

if (process.platform !== "win32") {
  fs.symlinkSync("/etc/hostname", path.join(REPO, "src", "link.js"));
  g(REPO, "add", "-A"); g(REPO, "commit", "-qm", "link");
  r = scan(pr(DEPS, g(REPO, "rev-parse", "HEAD")));
  ok("scan: a symlink in the PR is not handed to a scanner", r.code === 0 && /semgrep skipped: no changed file/.test(r.out) && !call("semgrep"), r.out + r.err);
}

// ---- the real gitleaks, when installed: a secret planted then deleted inside the PR is still caught
const real = (process.env.PATH || "").split(path.delimiter).find((d) => d && ["gitleaks", "gitleaks.exe"].some((n) => fs.existsSync(path.join(d, n))));
if (!real) console.log("skip: gitleaks is not installed; the real-scanner check did not run");
else {
  const R2 = path.join(W, "real");
  g(W, "init", "-q", "-b", "main", R2);
  fs.writeFileSync(path.join(R2, "README.md"), "# app\n");
  g(R2, "add", "-A"); g(R2, "commit", "-qm", "init");
  const b = g(R2, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(R2, "cfg.js"), `const key = "${token()}"; // gitleaks:allow\n`);
  g(R2, "add", "-A"); g(R2, "commit", "-qm", "leak");
  fs.rmSync(path.join(R2, "cfg.js"));
  g(R2, "add", "-A"); g(R2, "commit", "-qm", "unleak");
  r = scan(["--dir", R2, "--out", OUT, "--base", b, "--head", g(R2, "rev-parse", "HEAD")], { PATH: [real, path.dirname(process.execPath), ...lib.SYS_PATH].join(path.delimiter) });
  const hits = fs.existsSync(path.join(OUT, "gitleaks.sarif")) ? sarif("gitleaks").runs[0].results : [];
  ok("real gitleaks: the planted secret, deleted again, is found in the PR's commits", r.code === 0 && hits.some((h) => h.locations[0].physicalLocation.artifactLocation.uri === "cfg.js"), r.out + r.err);
  fs.writeFileSync(path.join(BASEDIR, "teams", "ROUTING.md"), fs.readFileSync(path.join(ROOT, "templates", "teams", "ROUTING.md"), "utf8"));
  r = sec(["README.md"], "--findings", OUT);
  ok("real gitleaks: and turns proteus/security red", r.status.state === "failure" && /cfg\.js \(gitleaks /.test(r.status.description), r.out + r.err);

  // a .gitleaksignore the PR commits, listing the planted secret's fingerprint, quiets nothing
  const R3 = path.join(W, "ignored");
  g(W, "init", "-q", "-b", "main", R3);
  fs.writeFileSync(path.join(R3, "README.md"), "# app\n");
  g(R3, "add", "-A"); g(R3, "commit", "-qm", "init");
  const b3 = g(R3, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(R3, "cfg.js"), `const key = "${token()}";\n`);
  g(R3, "add", "-A"); g(R3, "commit", "-qm", "leak");
  fs.writeFileSync(path.join(R3, ".gitleaksignore"), `${g(R3, "rev-parse", "HEAD")}:cfg.js:github-pat:1\n`);
  g(R3, "add", "-A"); g(R3, "commit", "-qm", "ignore it");
  r = scan(["--dir", R3, "--out", OUT, "--base", b3, "--head", g(R3, "rev-parse", "HEAD")], { PATH: [real, path.dirname(process.execPath), ...lib.SYS_PATH].join(path.delimiter) });
  const kept = fs.existsSync(path.join(OUT, "gitleaks.sarif")) ? sarif("gitleaks").runs[0].results : [];
  ok("real gitleaks: a .gitleaksignore in the PR listing the secret's fingerprint does not hide it",
    r.code === 0 && kept.some((h) => h.ruleId === "github-pat" && h.locations[0].physicalLocation.artifactLocation.uri === "cfg.js"), r.out + r.err + JSON.stringify(kept));
}

lib.summary();

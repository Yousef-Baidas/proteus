// Choosing local mode (#310): node tests/localsetup.test.js. install.js --local on a fresh repo, with and without
// commits, the first push, a foreign origin, a second run, the warning before anything; the host flags refusing; the
// stand-in reached with a failing gh on PATH; --doctor, the state line and proteus-status.js in both modes; the session
// refreshing the launchers and the origin's hooks and putting them on PATH; the sandbox rules in both orders; and the
// runner's refusal outside the sandbox, with --rerun inside it. Fake HOME and gh; never the network or the real ~/.claude.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("localsetup");
const INSTALL = path.join(ROOT, "install.js");
const SRC = path.join(ROOT, "templates", "hooks");
const LOCAL = path.join(SRC, "proteus-local.js");
const { LOCAL_WARNING } = require(INSTALL);
const WIN = process.platform === "win32";
const ROOTUSER = typeof process.getuid === "function" && process.getuid() === 0;

const read = (...p) => { try { return fs.readFileSync(path.join(...p), "utf8"); } catch { return null; } };
const both = (r) => `${r.out}${r.err}`;
const install = (cwd, args, env = {}) => lib.run(INSTALL, "", { cwd, args, env });
const standIn = (cwd, args) => lib.run(LOCAL, "", { cwd, args, env: { CLAUDE_PROJECT_DIR: cwd } });
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function repo(name, { commit = true, agents = "# Agents\n\n## Learned\n- gate: `node gate.js`\n", gate = "process.exitCode = 0;\n" } = {}) {
  const d = path.join(W, name);
  g(W, "init", "-q", "-b", "main", d);
  if (!commit) return d;
  fs.writeFileSync(path.join(d, "AGENTS.md"), agents);
  fs.writeFileSync(path.join(d, "gate.js"), gate);
  g(d, "add", ".");
  g(d, "commit", "-q", "-m", "init");
  return d;
}
const store = (d, ...p) => path.join(d, ".git", "proteus-local", ...p);
const marker = (d) => path.join(d, ".git", "proteus-lead", "local-mode");
const session = (d, env = {}) => lib.run(path.join(d, ".claude", "hooks", "proteus-autostart.js"),
  { hook_event_name: "SessionStart", session_id: "s1", cwd: d, model: "claude-x", source: "startup", transcript_path: null }, { cwd: d, env });
// every file under d, git folder included, with its bytes: a run that changes nothing leaves it equal
const snap = (d) => {
  const out = [];
  const walk = (at) => {
    for (const e of fs.readdirSync(at, { withFileTypes: true })) {
      const p = path.join(at, e.name);
      if (e.isDirectory()) walk(p); else if (e.isFile() && e.name !== "index") out.push(`${path.relative(d, p)} ${fs.readFileSync(p, "base64")}`);
    }
  };
  walk(d);
  return out.sort().join("\n");
};

// ---- a fresh repo, with commits
const A = repo("fresh");
let r = install(A, ["--plugin-setup", "--local"]);
ok("--plugin-setup --local: exit 0", r.code === 0, both(r));
ok("--local: marker, store, origin and launchers made", fs.existsSync(marker(A)) && fs.existsSync(store(A, "bin", "gh")) && fs.existsSync(store(A, "origin.git", "HEAD")));
ok("--local: origin is the local one", /proteus-local.origin\.git$/.test(g(A, "remote", "get-url", "origin")), g(A, "remote", "get-url", "origin"));
ok("--local: first push put main on the origin", g(store(A, "origin.git"), "rev-parse", "refs/heads/main") === g(A, "rev-parse", "HEAD"));
ok("--local: warning first, every point, before the first change", r.out.startsWith(LOCAL_WARNING), r.out.slice(0, 200));
ok("--local: says which case applies to this repo", /no sandbox profile: approvals are not protected/.test(r.out), r.out);
ok("--local: no GitHub step in the next steps", !/--protect|--verifier-app|--agent-login/.test(r.out), r.out);
ok("--local: names the docs", /docs\/local-mode\.md/.test(r.out), r.out);
const again = install(A, ["--plugin-setup", "--local"]);
ok("--local again: exit 0, the store and main kept", again.code === 0 && g(store(A, "origin.git"), "rev-parse", "refs/heads/main") === g(A, "rev-parse", "HEAD"), both(again));
ok("--project --local in a local repo: exit 0", install(A, ["--project", "--local"]).code === 0);

// ---- no commits: the step printed, doctor names it
const NC = repo("nocommits", { commit: false });
r = install(NC, ["--plugin-setup", "--local"]);
ok("no commits: exit 0, the first push printed for later", r.code === 0 && /no commits yet; after the first: git push origin main/.test(r.out), both(r));
r = install(NC, ["--doctor"]);
ok("no commits: --doctor names the first push", /main is not on the local origin yet/.test(both(r)) && /make the first commit/.test(both(r)), both(r));

// ---- dry run, and what refuses
const D = repo("dry");
const dryBefore = snap(D);
r = install(D, ["--plugin-setup", "--local", "--dry-run"]);
ok("--dry-run: prints the warning, says it would, writes nothing", r.code === 0 && r.out.startsWith(LOCAL_WARNING) && /would turn on/.test(r.out) && snap(D) === dryBefore, both(r));
const O = repo("foreign");
g(O, "remote", "add", "origin", "https://example.com/o/r.git");
const foreignBefore = snap(O);
r = install(O, ["--plugin-setup", "--local"]);
ok("an origin elsewhere: refused, nothing written", r.code !== 0 && snap(O) === foreignBefore, both(r));
ok("the refusal keeps the warning first", r.out.startsWith(LOCAL_WARNING), r.out.slice(0, 100));
r = install(D, ["--local"]);
ok("--local alone: refused, names what it needs", r.code !== 0 && /--local needs --project or --plugin-setup/.test(both(r)), both(r));
r = install(D, ["--plugin-setup", "--local", "--guest"]);
ok("--local with --guest: refused", r.code !== 0 && /--local and --guest conflict/.test(both(r)), both(r));

// ---- host flags
for (const [flag, ...rest] of [["--agent-login"], ["--protect"], ["--verifier-app", "1", path.join(W, "key.pem")]]) {
  const before = snap(A);
  r = install(A, [flag, ...rest]);
  ok(`${flag} in local mode: refused, names local mode, touches nothing`, r.code !== 0 && /this repo is in local mode, so there is no host to set up; nothing changed/.test(both(r)) && snap(A) === before, both(r));
}

// ---- the stand-in reached, never the real gh
{
  const bin = path.join(W, "badgh"), log = path.join(W, "badgh.log");
  fs.mkdirSync(bin);
  lib.fakeCli(bin, "gh", `require("fs").appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ") + "\\n"); process.exit(9);\n`);
  const env = { PATH: [bin, path.dirname(process.execPath), ...lib.SYS_PATH].join(path.delimiter) };
  const R = repo("standin");
  r = install(R, ["--plugin-setup", "--local"], env);
  ok("a failing real gh: setup still works", r.code === 0, both(r));
  r = install(R, ["--doctor"], env);
  ok("doctor: the gh row is the stand-in's", /stand-in|local mode/.test(both(r)) && !/gh .*not logged in/i.test(both(r)), both(r));
  ok("no command reached the real gh", !fs.existsSync(log), read(log));
}

// ---- doctor, state line, status: local
{
  const R = repo("seen");
  ok("seen: --project --local works", install(R, ["--project", "--local"]).code === 0);
  r = install(R, ["--doctor"]);
  const out = both(r);
  for (const want of ["local mode: the code, the tracker and the checks stay on this machine", "the local origin and its hooks", "the gh launchers point at this hooks dir", "first push done", "1 gate command(s) in ## Learned", "approvals=unprotected", "agents' shells find gh"]) ok(`doctor: ${want}`, out.includes(want), out);
  ok("doctor: no host row left in local mode", !/ruleset|proteus-gates\.yml/i.test(out), out);
  const envFile = path.join(W, "seen.env");
  r = session(R, { CLAUDE_ENV_FILE: envFile });
  ok("session: exit 0, state line says mode=local and approvals=unprotected", r.code === 0 && /proteus-state[^\n]* mode=local approvals=unprotected/.test(r.out), both(r));
  const envText = read(envFile) || "";
  ok("session: the launchers go first on PATH", /export PATH=/.test(envText) && envText.includes("proteus-local") && /"\$PATH"/.test(envText), envText);
  const status = lib.run(path.join(R, ".claude", "hooks", "proteus-status.js"), "", { cwd: R });
  ok("status: the line ends mode local", status.code === 0 && /· mode local\s*$/.test(status.out), both(status));
  const js = lib.run(path.join(R, ".claude", "hooks", "proteus-status.js"), "", { cwd: R, args: ["--json"] });
  ok("status --json: mode local", JSON.parse(js.out).mode === "local", js.out);
}

// ---- hosted: unchanged
{
  const R = repo("hosted");
  ok("hosted: --project works", install(R, ["--project"]).code === 0);
  const out = both(install(R, ["--doctor"]));
  ok("hosted doctor: no local row", !/local mode|local origin|launchers/.test(out), out);
  const envFile = path.join(W, "hosted.env");
  r = session(R, { CLAUDE_ENV_FILE: envFile });
  ok("hosted state: no mode, no approvals field", r.code === 0 && !/mode=local|approvals=/.test(r.out), both(r));
  ok("hosted session: PATH left alone", !/proteus-local/.test(read(envFile) || ""), read(envFile));
  const status = lib.run(path.join(R, ".claude", "hooks", "proteus-status.js"), "", { cwd: R });
  const js = lib.run(path.join(R, ".claude", "hooks", "proteus-status.js"), "", { cwd: R, args: ["--json"] });
  ok("hosted status: no mode shown", !/mode local/.test(status.out) && !("mode" in JSON.parse(js.out)), status.out + js.out);
}

// ---- the session keeps the wiring on the hooks dir in use
{
  const R = repo("wiring");
  ok("wiring: plugin setup, launchers on the plugin's hooks", install(R, ["--plugin-setup", "--local"]).code === 0 && read(store(R, "bin", "gh")).includes("templates"));
  ok("wiring: --project copies the hooks here", install(R, ["--project"]).code === 0);
  const health = () => require(LOCAL).health(path.join(R, ".git"), path.join(R, ".claude", "hooks", "proteus-local.js"));
  ok("wiring: health sees launchers and hooks stale for the new hooks dir", health().staleLaunchers.length > 0 && health().staleHooks.length > 0, JSON.stringify(health()));
  r = session(R);
  ok("session: rewrites them", r.code === 0 && !health().staleLaunchers.length && !health().staleHooks.length, both(r) + JSON.stringify(health()));
  ok("session: the store's records untouched", fs.existsSync(store(R, "tracker", "meta.json")));
  const made = standIn(R, ["label", "create", "kept"]);
  const bin = store(R, "bin");
  fs.rmSync(bin, { recursive: true });
  fs.writeFileSync(bin, "not a dir\n");
  r = session(R);
  ok("a failed refresh: a notice, the session goes on", made.code === 0 && r.code === 0 && /were not refreshed/.test(both(r)), both(r));
  fs.rmSync(bin);
  if (!WIN) {
    ok("wiring: setup again", standIn(R, ["--init"]).code === 0);
    const outside = path.join(W, "outside.txt"), launcher = store(R, "bin", "gh");
    fs.writeFileSync(outside, "mine\n");
    fs.rmSync(launcher);
    fs.symlinkSync(outside, launcher);
    r = session(R);
    ok("a linked launcher: not written through, a notice", r.code === 0 && read(outside) === "mine\n" && /were not refreshed/.test(both(r)), both(r));
  }
}

// ---- a place that cannot write Proteus's state: the human's terminal, said plainly
if (!WIN && !ROOTUSER) {
  const R = repo("readonly"), lead = path.join(R, ".git", "proteus-lead");
  fs.mkdirSync(lead, { mode: 0o500 });
  r = install(R, ["--plugin-setup", "--local"]);
  ok("no write to the lead's state: refused, tells the human to run it themselves", r.code !== 0 && /Run it yourself in your own terminal/.test(both(r)) && !fs.existsSync(marker(R)), both(r));
  fs.chmodSync(lead, 0o700);
}

// ---- sandbox rules, both orders
if (!WIN) {
  const profileOf = (d) => {
    const dir = path.join(lib.HOME, ".claude", "proteus-sandbox"), name = fs.readdirSync(dir).filter((f) => f.startsWith(`${path.basename(d)}-`) && f.endsWith(".json"))[0];
    return { file: path.join(dir, name), json: JSON.parse(read(dir, name)) };
  };
  const rulesOn = (name, d) => {
    const real = fs.realpathSync(d), origin = path.join(real, ".git", "proteus-local", "origin.git");
    const { json } = profileOf(d), fsx = json.sandbox.filesystem, deny = json.permissions.deny;
    const linuxOk = (x) => /^Edit\(.*\)$/.test(x) && !x.slice(5, -1).replace(/\/\*\*$/, "").includes("*");
    const denied = (p) => deny.filter(linuxOk).some((x) => { const at = x.slice(6, -1); return at.endsWith("/**") ? p.startsWith(at.slice(0, -2)) : at === p; });
    const inList = (p) => fsx.denyWrite.some((x) => p === x || p.startsWith(`${x}${path.sep}`));
    ok(`${name}: the store is writable`, fsx.allowWrite.includes(path.join(real, ".git", "proteus-local")), JSON.stringify(fsx.allowWrite));
    for (const p of [path.join(origin, "config"), path.join(origin, "hooks", "pre-receive"), path.join(real, ".git", "proteus-local", "bin", "gh")]) ok(`${name}: agents cannot write ${path.basename(p)}`, denied(p) && inList(p), p);
    ok(`${name}: the origin's refs stay writable`, !denied(path.join(origin, "refs", "heads", "main")) && !inList(path.join(origin, "refs", "heads", "main")));
  };
  const first = repo("sbfirst");
  ok("sandbox first: --sandbox", install(first, ["--sandbox"]).code === 0);
  const held = profileOf(first);
  held.json.permissions.deny.push("Edit(//added/by/a/worktree)");
  fs.writeFileSync(held.file, JSON.stringify(held.json));
  r = install(first, ["--plugin-setup", "--local"]);
  ok("sandbox first: the warning says the profile is there", r.code === 0 && /has a sandbox profile: approvals are protected/.test(r.out), both(r));
  rulesOn("sandbox first", first);
  ok("wired: --project", install(first, ["--project"]).code === 0);
  r = session(first);
  ok("with a profile: the state line has mode=local and no approvals field", /proteus-state[^\n]* mode=local/.test(r.out) && !/approvals=/.test(r.out), both(r));
  ok("sandbox first: a worktree's deny rule kept", profileOf(first).json.permissions.deny.includes("Edit(//added/by/a/worktree)"));
  const second = repo("sbsecond");
  ok("local first: --local", install(second, ["--plugin-setup", "--local"]).code === 0);
  ok("local first: --sandbox", install(second, ["--sandbox"]).code === 0);
  rulesOn("local first", second);
  const out = both(install(second, ["--doctor"]));
  ok("doctor: the profile has local mode's rules", /sandbox profile with local mode's rules/.test(out), out);
  const hosted = repo("sbhosted");
  ok("hosted: --sandbox", install(hosted, ["--sandbox"]).code === 0);
  const hp = profileOf(hosted).json;
  ok("hosted profile: no denyWrite, no store rule", !("denyWrite" in hp.sandbox.filesystem) && !JSON.stringify(hp).includes("proteus-local"), JSON.stringify(hp.sandbox.filesystem));
}

// ---- the runner: a profile means gates run only inside the sandbox
function pullRequest(d, branch) {
  g(d, "checkout", "-q", "-b", branch, "main");
  fs.writeFileSync(path.join(d, `${branch}.txt`), "x\n");
  g(d, "add", ".");
  g(d, "commit", "-q", "-m", `feat: ${branch}`);
  g(d, "push", "-q", "origin", branch);
  g(d, "checkout", "-q", "main");
  const made = standIn(d, ["pr", "create", "--base", "main", "--head", branch, "--title", branch, "--body", "b"]);
  return Number(/\/pull\/(\d+)$/.exec(made.out.trim())?.[1]);
}
function settled(d, n) {
  for (let i = 0; i < 300; i++) {
    const c = standIn(d, ["pr", "checks", String(n), "--json", "name,state,description"]);
    let rows = [];
    try { rows = JSON.parse(c.out); } catch { /* not yet */ }
    if (rows.length && rows.every((x) => !/pending|in_progress|queued/i.test(x.state))) return rows;
    sleepMs(100);
  }
  return [];
}
{
  const R = repo("noprofile");
  install(R, ["--plugin-setup", "--local"]);
  const n = pullRequest(R, "plain");
  ok("no profile: the gates run where it started", /success|pass/i.test((settled(R, n)[0] || {}).state || ""), JSON.stringify(settled(R, n)));
}
if (!WIN && !ROOTUSER) {
  const ran = path.join(W, "runner-ran.txt");
  const R = repo("runner", { gate: `require("fs").appendFileSync(${JSON.stringify(ran)}, "x");\n` });
  install(R, ["--sandbox"]);
  install(R, ["--plugin-setup", "--local"]);
  const n = pullRequest(R, "held");
  const first = settled(R, n)[0] || {};
  ok("a profile, outside the sandbox: nothing ran", !fs.existsSync(ran));
  ok("a profile, outside the sandbox: a failure naming the rerun", /fail/i.test(first.state || "") && first.description.includes(`gh pr checks ${n} --rerun`), JSON.stringify(first));
  const lead = path.join(R, ".git", "proteus-lead");
  fs.chmodSync(lead, 0o500); // the sandbox's view: the lead's state is read-only
  try {
    r = standIn(R, ["pr", "checks", String(n), "--rerun"]);
    ok("--rerun: starts one", r.code === 0 && /started a check/.test(r.out), both(r));
    ok("--rerun: the gates ran", /success|pass/i.test((settled(R, n)[0] || {}).state || "") && fs.existsSync(ran), JSON.stringify(settled(R, n)));
    ok("--rerun with --watch: refused", standIn(R, ["pr", "checks", String(n), "--rerun", "--watch"]).code !== 0);
    ok("--rerun with --json: refused", standIn(R, ["pr", "checks", String(n), "--rerun", "--json", "name"]).code !== 0);
    ok("the probe left nothing in the lead's state", !fs.readdirSync(lead).some((f) => f.startsWith(".probe")));
    const pull = store(R, "tracker", "pulls", `${n}.json`), oid = g(R, "rev-parse", "main");
    fs.writeFileSync(pull, JSON.stringify({ ...JSON.parse(read(pull)), state: "CLOSED", headRefOid: oid, baseRefOid: oid, closedAt: "2026-01-02T00:00:00Z" }));
    r = standIn(R, ["pr", "checks", String(n), "--rerun"]);
    ok("a closed PR cannot rerun", r.code !== 0 && /is not open/.test(r.err), both(r));
  } finally { fs.chmodSync(lead, 0o700); }
}

// ---- the docs
{
  const docs = read(ROOT, "docs", "local-mode.md");
  ok("docs/local-mode.md carries the warning's points word for word", LOCAL_WARNING.split("\n").slice(1).every((l) => docs.includes(`> ${l}`)));
  const skill = read(ROOT, "skills", "proteus-setup", "SKILL.md");
  ok("the setup skill asks, names --local and the dry run", /--local --dry-run/.test(skill) && /code host/.test(skill) && /only on this machine/.test(skill));
  for (const f of [["install.sh"], ["install.ps1"], ["install.js"]]) ok(`${f[0]} documents --local`, /-?-[Ll]ocal/.test(read(ROOT, ...f)));
}

lib.summary();

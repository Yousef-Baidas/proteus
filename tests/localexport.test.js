// Moving a local repo to a code host, proteus-local-export.js (#310): node tests/localexport.test.js. The plan writing
// nothing, each refusal with nothing written, the full flow in order, the switch and a failure on each side of it, a
// resume after a failure at each stage, the verdict rule through the real readers, mentions and closing keywords, the
// launchers afterwards, a launcher that leads back to itself, and a malformed record. Real git and temp repos: a stub gh
// records every call and answers, and a local bare repo stands for the target. Never the network.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "templates", "hooks");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("localexport");
const INSTALL = path.join(ROOT, "install.js");
const LOCAL = path.join(SRC, "proteus-local.js");
const VERDICT = path.join(SRC, "proteus-verdict.js");
const hooksLib = require(path.join(SRC, "proteus-lib.js"));
const { EXPORT_WARNING, neutral } = require(path.join(SRC, "proteus-local-export.js"));
const WIN = process.platform === "win32";
const ROOTUSER = typeof process.getuid === "function" && process.getuid() === 0;
const TARGET = "owner/target";
const HEAD = "Exported ";

// keeps a small host in state.json: enough for the export's calls and for proteus-verdict.js after it
const STUB = `#!/usr/bin/env node
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const D = process.env.STUB_DIR, file = path.join(D, "state.json");
const S = JSON.parse(fs.readFileSync(file, "utf8"));
const a = process.argv.slice(2), line = a.join(" ");
const input = a.includes("--body-file") ? fs.readFileSync(0, "utf8") : "";
fs.appendFileSync(path.join(D, "calls.jsonl"), JSON.stringify({ a, input }) + "\\n");
const save = () => fs.writeFileSync(file, JSON.stringify(S));
const flag = (n) => a[a.indexOf(n) + 1];
const die = (m) => { process.stderr.write(m + "\\n"); process.exit(1); };
if (S.fail && line.includes(S.fail)) {
  if (S.skip > 0) { S.skip--; save(); } else die(S.failMsg || "HTTP 500: stub failure");
}
const url = (kind, n) => "https://host.invalid/" + flag("--repo") + "/" + kind + "/" + n;
const add = (kind, o) => { const n = S.next++; S.items[n] = { kind, comments: [], state: "OPEN", ...o }; save(); console.log(url(kind === "pr" ? "pull" : "issues", n)); };
const numbers = (kind) => Object.keys(S.items).filter((n) => S.items[n].kind === kind);
const said = (n) => [S.items[n].body, ...S.items[n].comments].map((body) => ({ body, author: { login: "human" } }));
if (a[0] === "auth") { if (!S.auth) die("not logged in"); }
else if (a[0] === "config") console.log(S.protocol || "https");
else if (a[0] === "repo") { if (!S.repo) die("not found"); console.log(JSON.stringify(S.repo)); }
else if (a[0] === "api" && a[1] === "user") console.log("human");
else if (a[0] === "api") {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  const out = execFileSync("git", ["--git-dir", S.bare, "for-each-ref", "--format=%(refname:lstrip=2) %(objectname)", "refs/heads"], { encoding: "utf8", env });
  process.stdout.write(out + (S.branch ? S.branch + " 0000\\n" : ""));
}
else if (a[0] === "issue" && a[1] === "list") console.log([...numbers("issue"), ...S.foreignIssues].join("\\n"));
else if (a[0] === "pr" && a[1] === "list") console.log([...numbers("pr"), ...S.foreignPulls].join("\\n"));
else if (a[0] === "label") { S.labels.push(a[a.length - 1]); save(); }
else if (a[0] === "issue" && a[1] === "create") add("issue", { title: flag("--title"), body: input, labels: a.filter((x, i) => a[i - 1] === "--label") });
else if (a[0] === "pr" && a[1] === "create") add("pr", { title: flag("--title"), body: input, base: flag("--base"), head: flag("--head"), draft: a.includes("--draft") });
else if (a[1] === "comment") { S.items[a[2]].comments.push(input); save(); }
else if (a[1] === "close") { S.items[a[2]].state = "CLOSED"; save(); }
else if (a[1] === "view") console.log(JSON.stringify({ comments: said(a[2]), labels: [], milestone: null }));
else die("stub gh: unknown call: " + line);
`;
const CAUGHT = `#!/usr/bin/env node
require("fs").appendFileSync(process.env.STUB_DIR + "/intercepted", process.argv.slice(2).join(" ") + "\\n");
process.exit(1);
`;

const stateOf = (w) => JSON.parse(fs.readFileSync(path.join(w.stub, "state.json"), "utf8"));
const set = (w, o) => fs.writeFileSync(path.join(w.stub, "state.json"), JSON.stringify({ ...stateOf(w), ...o }));
const calls = (w) => { try { return fs.readFileSync(path.join(w.stub, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const WRITE_CALL = /^(label create|issue (create|comment|close|edit)|pr (create|comment|edit|merge)|repo (edit|create))/;
const writes = (w) => calls(w).map((c) => c.a.join(" ")).filter((l) => WRITE_CALL.test(l));
const refsOf = (w) => g(w.target, "for-each-ref", "--format=%(refname) %(objectname)");
const read = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };
const both = (r) => `${r.out}${r.err}`;
const mapFile = (w) => path.join(w.common, "proteus-lead", "local-export.json");
const marker = (w) => path.join(w.common, "proteus-lead", "local-mode");
const pull = (w, n) => path.join(w.common, "proteus-local", "tracker", "pulls", `${n}.json`);
const patchJSON = (f, o) => fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, "utf8")), ...o }));
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
const items = (w) => stateOf(w).items;
const hostText = (w) => Object.values(items(w)).flatMap((i) => [i.body, ...i.comments]);

let serial = 0;
// a repo with a commit and, unless plain, local mode on; a stub gh signed in, a private empty target
function world(name, { init = true } = {}) {
  const base = path.join(W, `${name}-${++serial}`);
  const dir = path.join(base, "repo"), stub = path.join(base, "stub"), home = path.join(base, "home"), target = path.join(base, "target.git");
  fs.mkdirSync(stub, { recursive: true });
  fs.mkdirSync(home);
  g(W, "init", "-q", "-b", "main", dir);
  g(W, "init", "-q", "--bare", "-b", "main", target);
  g(dir, "config", "user.name", "Repo Person");
  g(dir, "config", "user.email", "repo@example.com");
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "# Agents\n\n## Learned\n- gate: `node gate.js`\n");
  fs.writeFileSync(path.join(dir, "gate.js"), "process.exitCode = 0;\n");
  g(dir, "add", ".");
  g(dir, "commit", "-q", "-m", "init");
  lib.fakeCli(stub, "gh", STUB);
  const w = { dir, stub, home, target, common: path.join(dir, ".git"), bare: path.join(dir, ".git", "proteus-local", "origin.git") };
  w.bin = path.join(w.common, "proteus-local", "bin");
  w.env = { ...lib.homeEnv(home), STUB_DIR: stub, PATH: [stub, path.dirname(process.execPath), ...lib.SYS_PATH].join(path.delimiter), CLAUDE_PROJECT_DIR: dir };
  w.gh = (args, input = "") => lib.run(LOCAL, input, { cwd: dir, args, env: { CLAUDE_PROJECT_DIR: dir, ...lib.homeEnv(home) } });
  w.run = (args, env = {}) => lib.run(INSTALL, "", { cwd: dir, args: ["--export", TARGET, ...args], env: { ...w.env, ...env } });
  w.state = () => [snap(dir), refsOf(w), JSON.stringify(items(w))].join("\n");
  fs.writeFileSync(path.join(stub, "state.json"), JSON.stringify({ auth: true, bare: target, next: 1, items: {}, labels: [], foreignIssues: [], foreignPulls: [], branch: "",
    repo: { visibility: "PRIVATE", viewerPermission: "ADMIN", url: target, sshUrl: "" } }));
  if (init) {
    const made = w.gh(["--init"]);
    if (made.code !== 0) throw new Error(made.err);
    g(dir, "push", "-q", "origin", "main");
  }
  return w;
}
// a commit on a pushed branch whose check is already over, so no runner starts and the export is not held up
function branch(w, name, { from = "main" } = {}) {
  g(w.dir, "checkout", "-q", "-b", name, from);
  fs.writeFileSync(path.join(w.dir, `${name}.txt`), "x\n");
  g(w.dir, "add", ".");
  g(w.dir, "commit", "-q", "-m", `feat: ${name}`);
  const sha = g(w.dir, "rev-parse", "HEAD");
  g(w.dir, "push", "-q", "origin", `${sha}:refs/heads/hold-${sha}`);
  w.gh(["api", "-X", "POST", `repos/{owner}/{repo}/statuses/${sha}`, "-f", "state=pending", "-f", "context=gates", "-f", "description=d"]);
  w.gh(["api", "-X", "POST", `repos/{owner}/{repo}/statuses/${sha}`, "-f", "state=success", "-f", "context=gates", "-f", "description=d"]);
  g(w.dir, "push", "-q", "origin", `${name}:${name}`);
  g(w.dir, "checkout", "-q", "main");
  g(w.bare, "update-ref", "-d", `refs/heads/hold-${sha}`);
  return sha;
}
function openPull(w, name, body = "the pr body") {
  const sha = branch(w, name);
  const made = w.gh(["pr", "create", "--base", "main", "--head", name, "--title", `pr ${name}`, "--body", body]);
  return { sha, n: Number(/\/pull\/(\d+)$/.exec(made.out.trim())?.[1]) };
}
const issue = (w, title, body = "the issue body", ...rest) => Number(/\/issues\/(\d+)$/.exec(w.gh(["issue", "create", "--title", title, "--body", body, ...rest]).out.trim())?.[1]);
// issues 1 and 2, then PRs: open, gone head, merged, closed
function records(w) {
  w.gh(["label", "create", "kind", "--color", "00ff00", "--description", "a kind"]);
  w.gh(["label", "create", "unused", "--color", "0000ff"]);
  const open = issue(w, "open issue", "the open body", "--label", "kind");
  w.gh(["issue", "comment", String(open), "--body", "first comment"]);
  w.gh(["issue", "comment", String(open), "--body", "second comment"]);
  const closed = issue(w, "closed issue");
  w.gh(["issue", "comment", String(closed), "--body", "last word"]);
  w.gh(["issue", "close", String(closed)]);
  const real = openPull(w, "live");
  w.gh(["pr", "comment", String(real.n), "--body", "pr comment"]);
  const gone = openPull(w, "gone");
  g(w.bare, "update-ref", "-d", "refs/heads/gone");
  const merged = openPull(w, "merged");
  patchJSON(pull(w, merged.n), { state: "MERGED", headRefOid: merged.sha, baseRefOid: g(w.dir, "rev-parse", "main"), closedAt: "2026-01-02T03:04:05Z" });
  const closedPr = openPull(w, "dropped");
  patchJSON(pull(w, closedPr.n), { state: "CLOSED", headRefOid: closedPr.sha, baseRefOid: g(w.dir, "rev-parse", "main"), closedAt: "2026-01-02T03:04:05Z" });
  g(w.dir, "tag", "v-one");
  g(w.dir, "push", "-q", "origin", "v-one");
  return { open, closed, real, gone, merged, closedPr };
}

function plan() {
  const w = world("plan");
  records(w);
  const before = w.state();
  const r = w.run([]);
  ok("plan: exit 0", r.code === 0, both(r));
  ok("plan: target and visibility", r.out.includes(TARGET) && /private/.test(r.out), r.out);
  ok("plan: branches and tags counted", /4 branches, 1 tags/.test(r.out), r.out);
  ok("plan: issues and comments counted", /2 issues, 4 comments/.test(r.out), r.out);
  ok("plan: open and closed PRs counted", /2 open pull requests, 2 closed pull requests/.test(r.out), r.out);
  ok("plan: the warning", r.out.includes(EXPORT_WARNING), r.out);
  ok("plan: no writing call", writes(w).length === 0, writes(w));
  ok("plan: nothing changed anywhere", w.state() === before);
  ok("the warning is the one in the docs", read(path.join(ROOT, "docs", "local-mode.md")).includes(EXPORT_WARNING));
}

// each refusal: exit 1, its reason, no writing call, nothing changed
function refused(name, w, args, env, why) {
  const before = w.state();
  const r = w.run(args, env);
  ok(`refusal, ${name}: exit 1`, r.code === 1, both(r));
  ok(`refusal, ${name}: says why`, why.test(both(r)), both(r));
  ok(`refusal, ${name}: no writing call`, writes(w).length === 0, writes(w));
  ok(`refusal, ${name}: nothing changed`, w.state() === before);
  ok(`refusal, ${name}: no map`, read(mapFile(w)) === null);
}

function refusals() {
  const hosted = world("hosted", { init: false });
  refused("not local mode", hosted, ["--yes"], {}, /not in local mode|local mode/);
  ok("refusal, not local mode: no lead state made", !fs.existsSync(path.join(hosted.common, "proteus-lead")));
  ok("refusal, not local mode: no gh call", calls(hosted).length === 0, calls(hosted));

  if (!WIN && !ROOTUSER) {
    const w = world("sandbox");
    const lead = path.join(w.common, "proteus-lead");
    fs.chmodSync(lead, 0o500);
    refused("the sandbox", w, ["--yes"], {}, /you run it yourself/);
    ok("refusal, the sandbox: one line", both(w.run(["--yes"])).trim().split("\n").length === 1, both(w.run(["--yes"])));
    ok("refusal, the sandbox: no gh call", calls(w).length === 0, calls(w));
    fs.chmodSync(lead, 0o700);
  }

  let w = world("run");
  g(w.dir, "branch", "proteus/somerun");
  refused("open run", w, ["--yes"], {}, /run proteus\/somerun is open/);

  w = world("pending");
  const sha = g(w.dir, "rev-parse", "HEAD");
  w.gh(["api", "-X", "POST", `repos/{owner}/{repo}/statuses/${sha}`, "-f", "state=pending", "-f", "context=gates", "-f", "description=d"]);
  fs.writeFileSync(path.join(w.common, "proteus-local", "checks", `${sha}.claim`), JSON.stringify({ pid: process.pid, at: Date.now() }));
  refused("pending check", w, ["--yes"], {}, /pending/);

  // a git that hands on to the real one, alone on PATH: a gh anywhere on this machine stays out of reach
  w = world("nogh");
  const only = path.join(path.dirname(w.stub), "only");
  fs.mkdirSync(only);
  lib.fakeCli(only, "git", `const r = require("child_process").spawnSync(${JSON.stringify(hooksLib.which("git", { PATH: lib.ENV.PATH, PATHEXT: process.env.PATHEXT }))}, process.argv.slice(2), { stdio: "inherit" }); process.exit(r.status === null ? 1 : r.status);`);
  refused("no real gh", w, ["--yes"], { PATH: [only, path.dirname(process.execPath)].join(path.delimiter) }, /real gh/);

  w = world("signedout");
  set(w, { auth: false });
  refused("not signed in", w, ["--yes"], {}, /not signed in/);

  w = world("missing");
  set(w, { repo: null });
  refused("target missing", w, ["--yes"], {}, /never creates/);
  ok("refusal, target missing: no create call", !calls(w).some((c) => c.a[0] === "repo" && c.a[1] === "create"));

  for (const [name, patch, why] of [["a branch", { branch: "other" }, /branch other/], ["an issue", { foreignIssues: [9] }, /issue 9/], ["a pull request", { foreignPulls: [9] }, /pull request 9/]]) {
    w = world("full");
    set(w, patch);
    refused(`target holds ${name}`, w, ["--yes"], {}, why);
  }

  w = world("public");
  set(w, { repo: { ...stateOf(w).repo, visibility: "PUBLIC" } });
  refused("public target", w, ["--yes"], {}, /readable by anyone/);
  const pub = w.run([]);
  ok("refusal, public target: the plan refuses too", pub.code === 1 && /--public/.test(both(pub)), both(pub));
  ok("--public lets a public target through", w.run(["--yes", "--public"]).code === 0);

  w = world("weird");
  set(w, { repo: { ...stateOf(w).repo, visibility: "" } });
  refused("a visibility gh did not give", w, ["--yes"], {}, /readable by anyone/);

  w = world("reader");
  set(w, { repo: { ...stateOf(w).repo, viewerPermission: "READ" } });
  refused("no write permission", w, ["--yes"], {}, /no write permission/);

  w = world("badname");
  const bad = lib.run(INSTALL, "", { cwd: w.dir, args: ["--export", "-x/y", "--yes"], env: w.env });
  ok("refusal, a bad target name", bad.code === 1 && calls(w).length === 0, both(bad));
  const noTarget = lib.run(INSTALL, "", { cwd: w.dir, args: ["--export"], env: w.env });
  ok("--export needs a target", noTarget.code === 2, both(noTarget));
  const stray = lib.run(INSTALL, "", { cwd: w.dir, args: ["--yes"], env: w.env });
  ok("--yes alone is refused", stray.code === 2, both(stray));
  const mixed = lib.run(INSTALL, "", { cwd: w.dir, args: ["--export", TARGET, "--local"], env: w.env });
  ok("--export takes no other flag", mixed.code === 2, both(mixed));
}

function fullFlow() {
  const w = world("full-flow");
  const r0 = records(w);
  const verdicts = path.join(w.common, "proteus-local", "verdicts.jsonl");
  fs.appendFileSync(verdicts, "");
  const store = snap(path.join(w.common, "proteus-local"));
  const r = w.run(["--yes"]);
  ok("flow: exit 0", r.code === 0, both(r));
  ok("flow: every branch and tag pushed", ["main", "live", "merged", "dropped"].every((b) => g(w.target, "rev-parse", `refs/heads/${b}`) === g(w.bare, "rev-parse", `refs/heads/${b}`)) && g(w.target, "rev-parse", "refs/tags/v-one") === g(w.bare, "rev-parse", "refs/tags/v-one"));
  const order = writes(w);
  ok("flow: only the labels the records use", stateOf(w).labels.join() === "kind", stateOf(w).labels);
  const at = (needle) => order.findIndex((l) => l.includes(needle));
  ok("flow: labels first", at("label create") === 0, order);
  ok("flow: issues in number order, then PRs", at("issue create") < at("--title closed issue") && at("--title closed issue") < at("pr create"), order);
  const list = items(w), byTitle = (t) => Object.keys(list).find((k) => list[k].title === t);
  const oi = list[byTitle("open issue")], ci = list[byTitle("closed issue")];
  ok("flow: an open issue stays open, with its label and comments in order", oi.state === "OPEN" && oi.labels.join() === "kind" && oi.comments.length === 2 && oi.comments[0].includes("first comment") && oi.comments[1].includes("second comment"), oi);
  ok("flow: a closed issue closes, after its comment", ci.state === "CLOSED" && order.findIndex((l) => l.startsWith("issue comment") && l.includes(byTitle("closed issue"))) < order.findIndex((l) => l.startsWith("issue close")), order);
  const live = Object.values(list).filter((i) => i.kind === "pr");
  ok("flow: one open PR is a real PR, base and head kept", live.length === 1 && live[0].base === "main" && live[0].head === "live" && live[0].comments.length === 1, live);
  for (const [name, n, state, sha] of [["merged", r0.merged.n, "MERGED", r0.merged.sha], ["closed", r0.closedPr.n, "CLOSED", r0.closedPr.sha], ["gone-head", r0.gone.n, "OPEN", null]]) {
    const rec = Object.values(list).find((i) => i.kind === "issue" && i.body.includes(`local number ${n},`));
    ok(`flow: ${name} PR is a closed issue holding the record`, rec && rec.state === "CLOSED" && rec.body.includes(`State: ${state}`) && rec.body.includes("Base: main") && rec.body.includes("Head: ") && rec.body.includes(`Final commit: ${sha || "none"}`) && /Title: pr /.test(rec.body), rec);
  }
  ok("flow: every body and comment begins with the header", hostText(w).every((b) => b.startsWith(HEAD)), hostText(w));
  ok("flow: the header names number, author and time", /^Exported issue local number 1, by local, at \d{4}-/.test(list[byTitle("open issue")].body), oi.body);
  ok("flow: origin is the target", fs.realpathSync(g(w.dir, "remote", "get-url", "origin")) === fs.realpathSync(w.target));
  ok("flow: marker gone", !fs.existsSync(marker(w)));
  const map = JSON.parse(read(mapFile(w)));
  ok("flow: the map records target and each item", map.target === TARGET && Object.keys(map.items).length === 6, map);
  ok("flow: the map's path is printed", r.out.includes("local-export.json"), r.out);
  ok("flow: host steps printed", r.out.includes("--protect") && r.out.includes("--verifier-app"), r.out);
  ok("flow: open PRs need a fresh verdict", /fresh verdict/.test(r.out), r.out);
  ok("flow: nothing of the verdict record crosses", !calls(w).some((c) => c.input.includes("verdicts.jsonl")));
  ok("flow: store unchanged, bare origin there", snap(path.join(w.common, "proteus-local")) === store);
  ok("flow: no call touches a status or verdict", !calls(w).some((c) => /status|review/.test(c.a[0])));
}

function launchers() {
  const w = world("after");
  const before = w.gh(["issue", "list"]);
  ok("before: the stand-in answers", before.code === 0, before.err);
  ok("export ran", w.run(["--yes"]).code === 0);
  const count = calls(w).length;
  const r = lib.run(LOCAL, "", { cwd: w.dir, args: ["issue", "list", "--repo", TARGET], env: w.env });
  ok("after: the launcher's script reaches the real gh", r.code === 0 && calls(w).length === count + 1, both(r));
  if (!WIN) {
    const sh = require("child_process").spawnSync(path.join(w.bin, "gh"), ["issue", "list", "--repo", TARGET], { cwd: w.dir, env: { ...lib.ENV, ...w.env, PATH: [w.bin, w.env.PATH].join(path.delimiter) }, encoding: "utf8" });
    ok("after: the launcher itself reaches the real gh, not itself", sh.status === 0 && calls(w).length === count + 2, `${sh.stdout}${sh.stderr}`);
  }
  set(w, { auth: false });
  const code = lib.run(LOCAL, "", { cwd: w.dir, args: ["auth", "status"], env: w.env });
  ok("after: gh's own exit code comes back", code.code === 1 && /not logged in/.test(code.err), both(code));
  ok("after: store and bare origin exist", fs.existsSync(path.join(w.common, "proteus-local", "tracker")) && g(w.bare, "rev-parse", "--is-bare-repository") === "true");
  const none = lib.run(LOCAL, "", { cwd: w.dir, args: ["issue", "list"], env: { ...w.env, PATH: path.dirname(process.execPath) } });
  ok("after: no real gh says so", none.code !== 0 && /no real gh/.test(none.err), both(none));
  const n = calls(w).length;
  const again = w.run(["--yes"]);
  ok("after: export again refuses, out of local mode", again.code === 1 && /not in local mode|local mode/.test(both(again)) && calls(w).length === n, both(again));

  // never exported: the stand-in still refuses to fall through
  const hosted = world("still-hosted", { init: false });
  const h = lib.run(LOCAL, "", { cwd: hosted.dir, args: ["issue", "list"], env: hosted.env });
  ok("outside local mode, never exported: no fall through", h.code !== 0 && calls(hosted).length === 0, both(h));
  fs.mkdirSync(path.join(hosted.common, "proteus-lead"));
  fs.writeFileSync(mapFile(hosted), "{}");
  const midway = world("midway");
  fs.writeFileSync(mapFile(midway), JSON.stringify({ target: TARGET, url: midway.target, refs: {}, labels: [], items: {} }));
  const lm = lib.run(LOCAL, "", { cwd: midway.dir, args: ["issue", "list"], env: midway.env });
  ok("mid-export, still local: the stand-in answers", lm.code === 0 && calls(midway).length === 0, both(lm));
}

function intercepted() {
  // the launcher on PATH first, replaced by one that records: host work must never reach it
  const w = world("intercept");
  records(w);
  fs.rmSync(path.join(w.bin, "gh"), { force: true });
  fs.rmSync(path.join(w.bin, "gh.cmd"), { force: true });
  lib.fakeCli(w.bin, "gh", CAUGHT);
  const r = w.run(["--yes"], { PATH: [w.bin, w.env.PATH].join(path.delimiter) });
  ok("stand-in on PATH: the export still runs", r.code === 0, both(r));
  ok("stand-in on PATH: never called", read(path.join(w.stub, "intercepted")) === null, read(path.join(w.stub, "intercepted")));
  ok("stand-in on PATH: the stub had the work", writes(w).length > 0);
  if (WIN) return;
  // a push's credential helper or transport runs gh from PATH too
  const p = world("transport");
  lib.fakeCli(p.bin, "gh", CAUGHT);
  const seen = path.join(p.stub, "transport.js");
  fs.writeFileSync(seen, `#!${process.execPath}\ntry { require("child_process").execFileSync("gh", ["auth", "status"], { stdio: "ignore" }); } catch {}\nprocess.exit(1);\n`, { mode: 0o755 });
  set(p, { repo: { ...stateOf(p).repo, url: "ssh://host.invalid/o/r.git" } });
  const t = p.run(["--yes"], { PATH: [p.bin, p.env.PATH].join(path.delimiter), GIT_SSH_COMMAND: seen });
  ok("the push's own gh is not the launcher", t.code === 1 && read(path.join(p.stub, "intercepted")) === null, `${both(t)} ${read(path.join(p.stub, "intercepted"))}`);
}

// a launcher that is not this repo's. The loop stub ends itself so a broken guard fails the test and spawns no more
function loops() {
  const w = world("second-repo"), other = world("other-repo");
  fs.rmSync(path.join(other.bin, "gh.cmd"), { force: true });
  const launcher = read(path.join(other.bin, "gh"));
  fs.rmSync(path.join(other.bin, "gh"), { force: true });
  lib.fakeCli(other.bin, "gh", CAUGHT);
  const first = { PATH: [other.bin, w.env.PATH].join(path.delimiter) };
  records(w);
  ok("a second repo's launcher on PATH: the export runs", w.run(["--yes"], first).code === 0);
  ok("a second repo's launcher on PATH: host work never reaches it", read(path.join(w.stub, "intercepted")) === null, read(path.join(w.stub, "intercepted")));
  let n = calls(w).length;
  let r = lib.run(LOCAL, "", { cwd: w.dir, args: ["issue", "list", "--repo", TARGET], env: { ...w.env, ...first } });
  ok("a second repo's launcher on PATH: the pass-through reaches the real gh", r.code === 0 && calls(w).length === n + 1 && read(path.join(w.stub, "intercepted")) === null, both(r));
  if (!WIN) {
    fs.writeFileSync(path.join(other.bin, "gh"), launcher, { mode: 0o755 });
    n = calls(w).length;
    const sh = require("child_process").spawnSync(path.join(other.bin, "gh"), ["issue", "list", "--repo", TARGET], { cwd: w.dir, env: { ...lib.ENV, ...w.env, ...first }, encoding: "utf8", timeout: 30000 });
    ok("a second repo's real launcher, run first: reaches the real gh", sh.status === 0 && calls(w).length === n + 1, `${sh.stdout}${sh.stderr}`);
    const link = path.join(path.dirname(w.stub), "linked");
    fs.symlinkSync(other.bin, link);
    n = calls(w).length;
    r = lib.run(LOCAL, "", { cwd: w.dir, args: ["issue", "list", "--repo", TARGET], env: { ...w.env, PATH: [link, w.env.PATH].join(path.delimiter) } });
    ok("a launcher dir behind a link: reaches the real gh", r.code === 0 && calls(w).length === n + 1, both(r));
  }

  const loop = path.join(path.dirname(w.stub), "loop"), count = path.join(loop, "entered");
  fs.mkdirSync(loop);
  lib.fakeCli(loop, "gh", `const fs = require("fs"), { spawnSync } = require("child_process");
fs.appendFileSync(${JSON.stringify(count)}, "x");
if (fs.readFileSync(${JSON.stringify(count)}, "utf8").length > 3) process.exit(99);
const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(LOCAL)}, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status === null ? 1 : r.status);
`);
  r = lib.run(LOCAL, "", { cwd: w.dir, args: ["issue", "list"], env: { ...w.env, PATH: [loop, w.env.PATH].join(path.delimiter) } });
  ok("a gh that leads back to a launcher: stops at one level", read(count) === "x", read(count));
  ok("a gh that leads back to a launcher: non-zero, one plain line", r.code !== 0 && /leads back to a proteus launcher/.test(r.err) && r.err.trim().split("\n").length === 1, both(r));
}

function switchFailures() {
  // before the switch: the last item fails
  let w = world("before-switch");
  records(w);
  set(w, { fail: "issue close", skip: 2 });
  let r = w.run(["--yes"]);
  ok("switch: a failure before it stops, naming the item", r.code === 1 && /export stopped at closing pull request/.test(both(r)), both(r));
  ok("switch: the failure says rerun", /run the same command/.test(both(r)), both(r));
  ok("switch: not reached", fs.existsSync(marker(w)) && fs.realpathSync(g(w.dir, "remote", "get-url", "origin")) === fs.realpathSync(w.bare));

  // between: origin set, the marker's removal fails
  w = world("between");
  records(w);
  const driver = path.join(path.dirname(w.stub), "driver.js");
  fs.writeFileSync(driver, `const lib = require(${JSON.stringify(path.join(SRC, "proteus-lib.js"))});
const remove = lib.leadRemove;
lib.leadRemove = (c, f) => { if (f.endsWith("local-mode")) throw new Error("removal refused"); return remove(c, f); };
require(${JSON.stringify(path.join(SRC, "proteus-local-export.js"))}).run({ cwd: process.cwd(), target: ${JSON.stringify(TARGET)}, yes: true, allowPublic: false }, console.log);
`);
  r = lib.run(driver, "", { cwd: w.dir, env: w.env });
  ok("switch: a failure between its steps fails", r.code !== 0, both(r));
  ok("switch, between: local mode on, the remote recorded", fs.existsSync(marker(w)) && fs.realpathSync(g(w.dir, "remote", "get-url", "origin")) === fs.realpathSync(w.target));
  const n = writes(w).length;
  r = w.run(["--yes"]);
  ok("switch, between: a rerun finishes", r.code === 0 && !fs.existsSync(marker(w)), both(r));
  ok("switch, between: the rerun posts nothing", writes(w).length === n, writes(w).slice(n));
}

function resumes() {
  const titles = (w) => Object.values(items(w)).map((i) => i.title);
  const stages = [["the push", { repo: "nowhere" }], ["a label", { fail: "label create" }], ["an issue", { fail: "--title closed issue" }], ["a comment", { fail: "issue comment", skip: 1 }],
    ["closing", { fail: "issue close" }], ["a PR", { fail: "pr create" }], ["a PR comment", { fail: "pr comment" }], ["a rate limit", { fail: "issue create", skip: 1, failMsg: "API rate limit exceeded" }]];
  for (const [name, o] of stages) {
    const w = world("resume");
    records(w);
    const good = stateOf(w).repo;
    if (o.repo) set(w, { repo: { ...good, url: path.join(w.home, "nowhere.git") } });
    else set(w, o);
    let r = w.run(["--yes"]);
    ok(`resume, ${name}: stops, says rerun`, r.code === 1 && /export stopped at/.test(both(r)) && /run the same command/.test(both(r)), both(r));
    ok(`resume, ${name}: one try`, calls(w).filter((c) => o.fail && c.a.join(" ").includes(o.fail)).length <= (o.skip || 0) + 1);
    ok(`resume, ${name}: local mode stays on`, fs.existsSync(marker(w)));
    set(w, { fail: "", skip: 0, repo: good });
    r = w.run(["--yes"]);
    ok(`resume, ${name}: the rerun finishes`, r.code === 0, both(r));
    ok(`resume, ${name}: no duplicates`, new Set(titles(w)).size === 6 && titles(w).length === 6, titles(w));
    const list = Object.values(items(w));
    ok(`resume, ${name}: comments once each`, list.reduce((s, i) => s + i.comments.length, 0) === 4 && new Set(list.flatMap((i) => i.comments)).size === 4, list.map((i) => i.comments.length));
    ok(`resume, ${name}: finished`, !fs.existsSync(marker(w)));
  }

  const w = world("other-target");
  records(w);
  set(w, { fail: "issue comment" });
  ok("partial export stopped", w.run(["--yes"]).code === 1);
  set(w, { fail: "" });
  const map = read(mapFile(w));
  const other = lib.run(INSTALL, "", { cwd: w.dir, args: ["--export", "owner/other", "--yes"], env: w.env });
  ok("a different target refuses while the map exists", other.code === 1 && /different target/.test(both(other)) && read(mapFile(w)) === map, both(other));
  set(w, { foreignIssues: [99] });
  const n = writes(w).length;
  const stranger = w.run(["--yes"]);
  ok("a resume refuses what the map does not list", stranger.code === 1 && /issue 99/.test(both(stranger)) && writes(w).length === n, both(stranger));
  set(w, { foreignIssues: [] });
  const plan = w.run([]);
  ok("a plan on a resume says so and writes nothing", plan.code === 0 && /resumes/.test(plan.out) && writes(w).length === n, both(plan));
  fs.writeFileSync(mapFile(w), "{}");
  const bad = w.run(["--yes"]);
  ok("a malformed map refuses", bad.code === 1 && /malformed/.test(both(bad)) && writes(w).length === n, both(bad));
}

function verdictsStay() {
  const forms = ["ACCEPT", "CHANGES", "ANSWER", "AUTO-ACCEPT", "AUTO-HOLD", "ACCEPT abcdef012345", "**MERGE**", "BACK-TO-WORKER", "CONTRACT-WRONG", "RED", "  ACCEPT"];
  const w = world("verdicts");
  // each form as a whole body, first line, and last line, in every place a body goes
  const bodies = forms.flatMap((f) => [f, `${f}\nmore`, `more\n${f}`]);
  bodies.forEach((b, i) => {
    const n = issue(w, `issue ${i}`, b);
    w.gh(["issue", "comment", String(n), "--body", b]);
  });
  const live = openPull(w, "live", forms[0]);
  for (const b of bodies) {
    w.gh(["pr", "comment", String(live.n), "--body", b]);
    w.gh(["pr", "review", String(live.n), "--comment", "--body", b]);
  }
  const dead = openPull(w, "dead", forms[3]);
  patchJSON(pull(w, dead.n), { state: "CLOSED", headRefOid: dead.sha, baseRefOid: g(w.dir, "rev-parse", "main"), closedAt: "2026-01-02T03:04:05Z" });
  const r = w.run(["--yes"]);
  ok("verdicts: export ran", r.code === 0, both(r));
  const text = hostText(w);
  ok("verdicts: every body went out", text.length >= bodies.length * 4 + 2, text.length);
  const statusWord = /^\s*(\*\*)?(MERGE|BACK-TO-WORKER|CONTRACT-WRONG)\b/;
  ok("verdicts: isVerdict counts none", !text.some(hooksLib.isVerdict), text.filter(hooksLib.isVerdict));
  ok("verdicts: the status reader counts none", !text.some((t) => statusWord.test(t)));
  ok("verdicts: bounce and escalation count none", !text.some((t) => hooksLib.verdictIs("bounce")({ body: t }) || hooksLib.verdictIs("escalation")({ body: t })));
  const comments = text.map((body) => ({ body, author: { login: "human" }, createdAt: "2026-01-01T00:00:00Z" }));
  const said = hooksLib.humanVerdicts(w.dir, 1, comments, "human");
  ok("verdicts: humanVerdicts counts none", said.length === 0, said);
  const sample = Object.keys(items(w)).filter((n) => items(w)[n].kind === "issue");
  const counted = sample.filter((n) => lib.run(VERDICT, "", { cwd: w.dir, args: [n], env: w.env }).code === 0);
  ok("verdicts: proteus-verdict.js counts none on any host item", counted.length === 0 && sample.length > 0, counted);
  // the control: the same reader on the same host does count one that lands bare
  const first = sample[0], state = stateOf(w);
  for (const f of ["ACCEPT", "AUTO-ACCEPT", "AUTO-HOLD"]) {
    state.items[first].comments = [f];
    set(w, { items: state.items });
    ok(`verdicts: the control, ${f} bare counts`, lib.run(VERDICT, "", { cwd: w.dir, args: [first], env: w.env }).code === 0);
  }
}

function neutralising() {
  const w = world("neutral");
  const n = issue(w, "ping @someone and fixes #2", "hello @someone, fixes #1 and Closes #2, resolved owner/repo#3\n<a>&#64;someone</a> FIX: #4 keep src/fix.js and Owned: a/b\nmail me@example.com");
  w.gh(["issue", "comment", String(n), "--body", "cc @team/group closes https://host.invalid/o/r/issues/1"]);
  const r = w.run(["--yes"]);
  ok("neutral: export ran", r.code === 0, both(r));
  const i = Object.values(items(w))[0], all = [i.title, i.body, ...i.comments].join("\n");
  ok("neutral: no live mention", !/(^|[^a-z0-9])@[a-z0-9]/i.test(all), all);
  ok("neutral: no live closing keyword", !/\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\b[\s:]*(#|[\w.-]+\/[\w.-]+#|https?:)/i.test(all), all);
  ok("neutral: no live entity", !all.includes("&#64;"), all);
  ok("neutral: the text is otherwise as written", all.replace(/​/g, "").includes("hello @someone, fixes #1 and Closes #2") && all.includes("src/fix.js") && all.includes("Owned: a/b") && all.includes("me@example.com"), all);
  ok("neutral: a mention in a code span too", neutral("`@x`").includes("@​"));
}

function malformed() {
  const w = world("malformed");
  const good = issue(w, "good"), broken = issue(w, "broken");
  patchJSON(path.join(w.common, "proteus-local", "tracker", "issues", `${broken}.json`), { title: 7 });
  const r = w.run(["--yes"]);
  ok("malformed: stops with its name", r.code === 1 && both(r).includes(`${broken}.json`), both(r));
  ok("malformed: nothing posted, not even the good one", writes(w).length === 0 && good > 0, writes(w));
  ok("malformed: nothing pushed", refsOf(w) === "");
  const plan = w.run([]);
  ok("malformed: the plan stops too", plan.code === 1 && both(plan).includes(`${broken}.json`), both(plan));

  const long = world("toolong");
  // written straight to the record: a body this size does not fit on a Windows command line
  patchJSON(path.join(long.common, "proteus-local", "tracker", "issues", `${issue(long, "t")}.json`), { body: "x".repeat(65536 - 2) });
  const l = long.run(["--yes"]);
  ok("a body over the host's size with its header stops, naming it", l.code === 1 && /issue 1 is over/.test(both(l)) && writes(long).length === 0, both(l));

  const comma = world("comma");
  patchJSON(path.join(comma.common, "proteus-local", "tracker", "issues", `${issue(comma, "t")}.json`), { labels: ["a,b"] });
  const c = comma.run(["--yes"]);
  ok("a label gh cannot carry stops, naming the issue", c.code === 1 && /issue 1: a bad label/.test(both(c)) && writes(comma).length === 0, both(c));
}

function wired() {
  ok("install.ps1 names -Export", /-Export <owner\/repo>/.test(read(path.join(ROOT, "install.ps1"))) && /"--export", \$Export/.test(read(path.join(ROOT, "install.ps1"))));
  ok("install.sh names --export", /--export <owner\/repo>/.test(read(path.join(ROOT, "install.sh"))));
  ok("docs/install.md names the flag", /--export/.test(read(path.join(ROOT, "docs", "install.md"))));
  for (const f of ["proteus-autostart.js", "proteus-local.js", "proteus-local-pr.js"]) {
    ok(`no hook loads the export: ${f}`, !/require\([^)]*proteus-local-export/.test(read(path.join(SRC, f))));
  }
}

plan();
refusals();
fullFlow();
launchers();
intercepted();
loops();
switchFailures();
resumes();
verdictsStay();
neutralising();
malformed();
wired();
lib.summary();

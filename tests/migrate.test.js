// Migration contract (#6): a repo already on Proteus keeps its hive-era state after the rename (#5).
// Legacy fixtures in one mkdtemp dir under os.tmpdir(): repos with an open hive/<run> run (packed refs, as git gc leaves
// them), .git/hive/ state and journal, hive labels in a stateful fake gh, a Codex config.toml naming ../<repo>-hive, and a
// fake HOME installed from main at 7d3d544 then fast-forwarded by its own autostart. One case per contract item: the
// Check, the auto-update path, and Addendum 2 items 1-4; then the PR #16 review items: the journal split an auto-update
// leaves (merged, legacy lines first), the Codex -proteus root at session start, a `#` inside a writable root, an
// unreadable .git/hive entry under --project, and a worktree registered in legacy scratch; then the #18 pins, with
// faults from a `node -r` preload written into the fixture dir: EXDEV from linkSync, a rerun after a partial merge, an
// append mid-merge, recall of an unmerged legacy journal, the Codex -hive root rules, hive-owned, legacy inbox labels,
// and the hook refresh for every CLI after a state move. PROTEUS_MIGRATE_SRC
// overrides the checkout under test (tests only). Never the network, the real ~/.claude, ~/.codex or ~/.pi, or a
// write to the checkout.
// Exit 0 if every assertion passed, 1 otherwise.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync, execFileSync } = require("child_process");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g, summary } = lib;

const ROOT = path.join(__dirname, "..");
const SRC = path.resolve(process.env.PROTEUS_MIGRATE_SRC || ROOT);
const OLD_MAIN = "7d3d544"; // main before the rename: proteus-*.js hooks on .git/hive state and hive/* branches
const RUN = "demo";
const PROMPT = "keep the demo run on sqlite, not postgres";
const JOURNAL = [
  { ts: "2026-09-28T10:00:00.000Z", session_id: "s0", prompt: "start the demo run" },
  { ts: "2026-09-28T10:05:00.000Z", session_id: "s0", prompt: PROMPT },
].map((l) => JSON.stringify(l) + "\n").join("");

lib.workdir("migrate");
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "proteus-migrate-")));
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: SRC, encoding: "utf8", windowsHide: true, timeout: 30000 }).split("\0").filter(Boolean);
console.log(`${T}: legacy fixtures; checkout under test ${SRC} (${tracked.length} tracked files)`);

// ---- fakes: claude (the context-mode plugin, in the fake HOME) and a stateful gh (issues, labels, PRs in DB)
const CTX = "context-mode@context-mode";
lib.fakeCli(lib.BIN, "claude", `const fs = require("fs"), path = require("path"), os = require("os");
const a = process.argv.slice(2).join(" ");
const d = path.join(os.homedir(), ".claude"), rd = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {}; } };
fs.mkdirSync(path.join(d, "plugins"), { recursive: true });
if (a === "plugin marketplace add mksglu/context-mode") fs.writeFileSync(path.join(d, "plugins", "known_marketplaces.json"), JSON.stringify({ "context-mode": {} }));
if (a === "plugin install ${CTX} --scope user") fs.writeFileSync(path.join(d, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "${CTX}": [{ scope: "user" }] } }));
if (a === "plugin install ${CTX} --scope user" || a === "plugin enable ${CTX} --scope user") {
  const s = rd(path.join(d, "settings.json")); s.enabledPlugins = { ...s.enabledPlugins, "${CTX}": true }; fs.writeFileSync(path.join(d, "settings.json"), JSON.stringify(s));
}
`);
const GBIN = path.join(T, "gbin");
fs.mkdirSync(GBIN);
lib.fakeCli(GBIN, "gh", `// stateful fake gh: issues, labels and PRs in $FAKE_GH_DB; every other call goes to tests/fakegh.js
const fs = require("fs"), { spawnSync } = require("child_process");
const argv = process.argv.slice(2), DB = process.env.FAKE_GH_DB;
fs.appendFileSync(DB + ".log", argv.join(" ") + "\\n");
const db = JSON.parse(fs.readFileSync(DB, "utf8"));
const save = () => fs.writeFileSync(DB, JSON.stringify(db));
const all = (k) => argv.flatMap((a, i) => (a === k && argv[i + 1] ? argv[i + 1].split(",") : []));
const out = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };
const [c1, c2, c3] = argv;
if (c1 === "issue" && c2 === "list") {
  const st = (all("--state")[0] || "open").toUpperCase();
  out(db.issues.filter((i) => (st === "ALL" || i.state === st) && all("--label").every((l) => i.labels.some((x) => x.name === l))).map(({ comments, ...i }) => i));
}
const issue = db.issues.find((i) => String(i.number) === String(c3));
if (c1 === "issue" && c2 === "view" && issue) out({ comments: issue.comments.map((body) => ({ body })) });
if (c1 === "issue" && c2 === "edit" && issue) {
  for (const l of all("--add-label")) if (!issue.labels.some((x) => x.name === l)) issue.labels.push({ name: l });
  issue.labels = issue.labels.filter((x) => !all("--remove-label").includes(x.name));
  save(); process.exit(0);
}
if (c1 === "label" && c2 === "create") { if (!db.labels.includes(c3)) db.labels.push(c3); save(); process.exit(0); }
if (c1 === "label" && c2 === "list") out(db.labels.map((name) => ({ name })));
if (c1 === "pr" && c2 === "list") out(db.prs.filter((p) => !all("--base").length || all("--base").includes(p.baseRefName)));
const r = spawnSync(process.execPath, [process.env.FAKE_GH_FALLBACK, ...argv], { stdio: "inherit" });
process.exit(r.status === null ? 1 : r.status);
`);
const DB = path.join(T, "gh.json");
const iso = (h) => new Date(Date.UTC(2026, 8, 28) + h * 3600e3).toISOString();
const ms = { number: 1, title: `${RUN}/m1` };
fs.writeFileSync(DB, JSON.stringify({
  labels: ["hive", "hive-log", "hive-review", "hive-debt", "hive-question", "needs-human", "profile:backend", "difficulty:standard"],
  issues: [
    { number: 17, title: `Run: ${RUN}`, state: "OPEN", createdAt: iso(0), closedAt: null, milestone: null, labels: [{ name: "hive-log" }], comments: [`decision ${RUN}-1: keep sqlite`, `decision ${RUN}-2: wave 2 dispatched`] },
    { number: 11, title: "t1: api", state: "CLOSED", createdAt: iso(0), closedAt: iso(1), milestone: ms, labels: [{ name: "hive" }, { name: "profile:backend" }], comments: [] },
    { number: 12, title: "t2: store", state: "OPEN", createdAt: iso(1), closedAt: null, milestone: ms, labels: [{ name: "hive" }, { name: "profile:backend" }], comments: [] },
    { number: 13, title: "t3: cli", state: "OPEN", createdAt: iso(1), closedAt: null, milestone: ms, labels: [{ name: "hive" }, { name: "profile:backend" }], comments: [] },
  ],
  prs: [{ number: 40, baseRefName: `hive/${RUN}`, headRefName: `hive/${RUN}-3`, reviews: [], comments: [] }],
}));

// ---- helpers
const envFor = (home, extra = {}) => ({ ...lib.homeEnv(home), PATH: [GBIN, lib.BIN, path.dirname(process.execPath), ...lib.SYS_PATH].join(path.delimiter), FAKE_GH_DB: DB, FAKE_GH_FALLBACK: lib.fakeScript(lib.BIN, "gh"), ...extra });
const fakeHome = (n) => { const h = path.join(T, `home-${n}`); fs.mkdirSync(path.join(h, ".claude"), { recursive: true }); return h; };
const run = (script, cwd, home, args = [], input = "", extra = {}) => lib.run(script, input, { cwd, env: envFor(home, extra), args });
const read = (...p) => { try { return fs.readFileSync(path.join(...p), "utf8"); } catch { return null; } };
const exists = (...p) => fs.existsSync(path.join(...p));
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex").slice(0, 12);
const branches = (repo) => g(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/").split("\n").filter(Boolean);
// the run survives under either name, its evidence branch too
const runKept = (repo) => { const b = branches(repo); return (b.includes(`hive/${RUN}`) || b.includes(`proteus/${RUN}`)) && (b.includes(`hive-evidence/${RUN}`) || b.includes(`proteus-evidence/${RUN}`)); };
const journalAt = (repo) => [".git/proteus/journal.jsonl", ".git/hive/journal.jsonl"].find((f) => read(repo, f) === JOURNAL) || "";
// the autostart's state line lists the run as open, whatever prefix it shows it under
const listsRun = (out) => new RegExp(`(^|\\s)[\\w-]*(branches|runs)=(\\S*[,/])?${RUN}(?=[,\\s]|$)`, "m").test(out);
const stateLine = (out) => (out.split("\n").find((l) => l.startsWith("proteus-state")) || "").slice(0, 400);
const sessionStart = (repo, home, source) => run(path.join(repo, ".claude", "hooks", "proteus-autostart.js"), repo, home, [], { hook_event_name: "SessionStart", source, session_id: `s-${source}`, cwd: repo });
// no background fetch of the checkout, no fast-forward: the autostart only reads it
const quiet = (home) => { const f = path.join(home, ".claude", "proteus.json"); const c = JSON.parse(read(f) || "{}"); fs.writeFileSync(f, JSON.stringify({ ...c, autoUpdate: false, lastFetch: Date.now() })); };
const doctorNames = (out) => /^(FIX|WARN|FAIL)\b.*\.git[\\/]hive\b/m.test(out);
const lines = (text) => String(text || "").split(/\r?\n/).filter(Boolean);
// the new hooks as an auto-update leaves them: this checkout's hooks copied into the repo, a skill to autostart from
const newHooks = (repo, hooksDir = [".claude", "hooks"], skillDir = [".claude", "skills", "proteus"]) => {
  fs.cpSync(path.join(SRC, "templates", "hooks"), path.join(repo, ...hooksDir), { recursive: true });
  fs.mkdirSync(path.join(repo, ...skillDir), { recursive: true });
  fs.writeFileSync(path.join(repo, ...skillDir, "SKILL.md"), "---\nname: proteus\n---\nSKILL BODY\n");
};
// writable_roots under [sandbox_workspace_write], read strictly: the array's values, or null unless it is
// comma-separated TOML strings (comments and one trailing comma allowed) with nothing but a comment after the ]
function tomlRoots(text) {
  const m = /^[ \t]*\[sandbox_workspace_write\][ \t]*(#[^\n]*)?\r?\n(?:(?![ \t]*\[)[^\n]*\n)*?[ \t]*writable_roots[ \t]*=[ \t]*\[/m.exec(text);
  if (!m) return null;
  const vals = [];
  let want = "value";
  for (let i = m.index + m[0].length; i < text.length;) {
    const c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "#") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c === "]") return /^[ \t]*(#[^\n]*)?(\r?\n|$)/.test(text.slice(i + 1)) ? vals : null;
    if (c === ",") { if (want !== "comma") return null; want = "value"; i++; continue; }
    if (want !== "value") return null; // two values with no comma between them
    const s = c === '"' ? /^"((?:[^"\\\n]|\\.)*)"/.exec(text.slice(i)) : c === "'" ? /^'([^'\n]*)'/.exec(text.slice(i)) : null;
    if (!s) return null;
    let v = s[1];
    if (c === '"') { try { v = JSON.parse(`"${v}"`); } catch { return null; } }
    vals.push(v);
    want = "comma";
    i += s[0].length;
  }
  return null;
}

// a repo on the pre-rename names: hive/<run> run with a ticket branch and evidence, .git/hive/ state and journal
function legacyRepo(name, { open = true } = {}) {
  const d = path.join(T, name);
  g(T, "init", "-q", "-b", "main", d);
  fs.writeFileSync(path.join(d, "README.md"), "legacy\n");
  g(d, "add", "-A"); g(d, "commit", "-qm", "init");
  if (open) for (const b of [`hive/${RUN}`, `hive/${RUN}-3`, `hive-evidence/${RUN}`]) g(d, "branch", b);
  const s = path.join(d, ".git", "hive");
  fs.mkdirSync(s, { recursive: true });
  fs.writeFileSync(path.join(s, "journal.jsonl"), JOURNAL);
  fs.writeFileSync(path.join(s, "inbox.json"), JSON.stringify({ at: iso(2), questions: [], reviews: [] }) + "\n");
  g(d, "pack-refs", "--all"); // as git gc leaves them
  return d;
}

// every file in the repo but the index, with its hash: a second --project must leave this unchanged
function snapshot(repo) {
  const rows = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d).sort()) {
      const p = path.join(d, e), r = rel ? `${rel}/${e}` : e;
      if (r === ".git/index") continue;
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) rows.push(`${r} -> ${fs.readlinkSync(p)}`);
      else if (st.isDirectory()) walk(p, r);
      else rows.push(`${r} ${sha(p)}`);
    }
  };
  walk(repo, "");
  return rows;
}

// ---- the Check: install.js --project moves .git/hive into .git/proteus; the autostart lists the open run; twice is a no-op
{
  const A = legacyRepo("check");
  const HA = fakeHome("check");
  let r = run(path.join(SRC, "install.js"), A, HA, ["--project"]);
  ok("check: install.js --project in a repo with .git/hive exits 0", r.code === 0, r.out + r.err);
  ok("check: .git/proteus/journal.jsonl holds the same bytes as the old .git/hive/journal.jsonl", read(A, ".git", "proteus", "journal.jsonl") === JOURNAL, read(A, ".git", "proteus", "journal.jsonl"));
  ok("check: .git/hive is gone", !exists(A, ".git", "hive"), (fs.existsSync(path.join(A, ".git", "hive")) && fs.readdirSync(path.join(A, ".git", "hive")).join(",")) || "");
  quiet(HA);
  const s = sessionStart(A, HA, "startup");
  ok("check: the autostart lists demo as an open run", listsRun(stateLine(s.out)), stateLine(s.out) || s.err);
  const before = snapshot(A);
  r = run(path.join(SRC, "install.js"), A, HA, ["--project"]);
  const after = snapshot(A);
  const diff = [...after.filter((x) => !before.includes(x)).map((x) => `+${x}`), ...before.filter((x) => !after.includes(x)).map((x) => `-${x}`)];
  ok("check: a second --project exits 0 and changes nothing", r.code === 0 && !diff.length, `${r.code} ${diff.slice(0, 6).join(" | ")}`);
  ok("check: the open run and its evidence branch are still there", runKept(A), branches(A).join(","));
}

// ---- auto-update (addendum): an install from main (7d3d544), fast-forwarded by its own autostart, --project never re-run
let LR = "", HB = "", PH = "";
{
  const UB = path.join(T, "upstream.git"), UA = path.join(T, "upstream-work");
  PH = path.join(T, "proteus-checkout");
  g(T, "init", "-q", "--bare", "-b", "main", UB);
  g(T, "clone", "-q", UB, UA);
  const tar = spawnSync("git", ["archive", "--format=tar", OLD_MAIN], { cwd: ROOT, maxBuffer: 1 << 28, windowsHide: true });
  const untar = tar.status === 0 ? spawnSync("tar", ["-x", "-C", UA], { input: tar.stdout, windowsHide: true }) : { status: 1 };
  ok(`auto-update fixture: main at ${OLD_MAIN} is in this checkout's history (CI clones with fetch-depth 0)`, tar.status === 0 && untar.status === 0, String(tar.stderr || ""));
  g(UA, "add", "-A"); g(UA, "commit", "-qm", `chore: main at ${OLD_MAIN}`); g(UA, "push", "-q", "-u", "origin", "HEAD:main");
  g(T, "clone", "-q", UB, PH);
  // this branch, one commit ahead: what the fast-forward lands on
  g(UA, "rm", "-rq", "--", ".");
  for (const f of tracked) {
    const s = path.join(SRC, f);
    if (!fs.existsSync(s)) continue;
    fs.mkdirSync(path.dirname(path.join(UA, f)), { recursive: true });
    fs.copyFileSync(s, path.join(UA, f));
  }
  g(UA, "add", "-A"); g(UA, "commit", "-qm", "feat: this branch"); g(UA, "push", "-q");
  g(PH, "fetch", "-q");

  LR = legacyRepo("autoupdate");
  HB = fakeHome("autoupdate");
  let r = run(path.join(PH, "install.js"), LR, HB, ["--project"]);
  ok(`auto-update fixture: the ${OLD_MAIN} installer sets up the repo`, r.code === 0 && exists(LR, ".claude", "hooks", "proteus-autostart.js"), r.out + r.err);
  const cf = path.join(HB, ".claude", "proteus.json");
  fs.writeFileSync(cf, JSON.stringify({ ...JSON.parse(read(cf) || "{}"), autoUpdate: true, lastFetch: Date.now() }));
  const s1 = sessionStart(LR, HB, "startup");
  ok(`auto-update fixture: the ${OLD_MAIN} autostart saw hive/demo, fast-forwarded the checkout to this branch and synced the hooks`,
    /hive-branches=hive\/demo( |$)/m.test(s1.out) && /proteus: updated to/.test(s1.out) && g(PH, "rev-parse", "HEAD") === g(UA, "rev-parse", "HEAD") &&
    read(LR, ".claude", "hooks", "proteus-lib.js") === read(PH, "templates", "hooks", "proteus-lib.js"), stateLine(s1.out) + s1.err);

  const s2 = sessionStart(LR, HB, "compact");
  const body = (read(PH, "skills", "proteus", "SKILL.md") || "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  const said = s2.out.replace(body, "");
  ok("auto-update: the next session start keeps the journal byte for byte (in .git/proteus or .git/hive)", !!journalAt(LR), [read(LR, ".git", "proteus", "journal.jsonl"), read(LR, ".git", "hive", "journal.jsonl")].join(" | "));
  ok("auto-update: the next session start keeps hive/demo open (or renamed to proteus/demo)", runKept(LR), branches(LR).join(","));
  ok("auto-update: the next session start lists demo as an open run, or prints the one command that finishes the move",
    listsRun(stateLine(said)) || /install\.js"? --update\b|install\.ps1"? -Update\b/.test(said), stateLine(said) || said.slice(0, 400));
  ok("auto-update: after a compaction the lead still gets the human's words from the journal", /human said/.test(said) && said.includes(PROMPT), said.slice(0, 600));
}

// ---- 4. orphaned state dir, part 1: after the fast-forward, .git/hive is migrated or --doctor names it
{
  const r = run(path.join(PH, "install.js"), LR, HB, ["--doctor"]);
  ok("orphan (4): after the auto-update, .git/hive is migrated or --doctor reports it (FIX/WARN row naming .git/hive)", !exists(LR, ".git", "hive") || doctorNames(r.out), r.out.split("\n").filter((l) => /hive/.test(l)).join(" | ") || r.out.slice(0, 400));
}

// ---- auto-update, finish: the printed command moves the state
{
  const r = run(path.join(PH, "install.js"), LR, HB, ["--update"]);
  ok("auto-update: install.js --update then moves the journal into .git/proteus, removes .git/hive and keeps the run",
    r.code === 0 && read(LR, ".git", "proteus", "journal.jsonl") === JOURNAL && !exists(LR, ".git", "hive") && runKept(LR), `${r.code} ${r.err.slice(0, 300)}`);
}

// ---- 1. open legacy run: new hooks over legacy state (no --project); autostart, status and the guard serve it
{
  const LC = legacyRepo("legacy-run");
  const HC = fakeHome("legacy-run");
  fs.cpSync(path.join(SRC, "templates", "hooks"), path.join(LC, ".claude", "hooks"), { recursive: true });
  fs.mkdirSync(path.join(LC, ".claude", "skills", "proteus"), { recursive: true });
  fs.writeFileSync(path.join(LC, ".claude", "skills", "proteus", "SKILL.md"), "---\nname: proteus\n---\nSKILL BODY\n");
  const s = sessionStart(LC, HC, "startup");
  ok("legacy run (1): the autostart lists demo as an open run", listsRun(stateLine(s.out)), stateLine(s.out) || s.err);
  ok("legacy run (1): the autostart prints the tail of demo's run log (labelled hive-log)", s.out.includes(`decision ${RUN}-2`), s.out.slice(0, 600));
  const st = run(path.join(LC, ".claude", "hooks", "proteus-status.js"), LC, HC);
  ok("legacy run (1): status reports run demo, not \"no open run\"", new RegExp(`^run ${RUN}\\b`).test(st.out), st.out + st.err);
  ok("legacy run (1): status counts demo's hive-labelled tickets", st.out.includes(`milestone ${RUN}/m1 1/3 closed`), st.out + st.err);
  const edit = { hook_event_name: "PreToolUse", session_id: "s1", cwd: LC, tool_name: "Edit", tool_input: { file_path: path.join(LC, "src", "a.ts") }, agent_id: "a1", agent_type: "proteus-worker" };
  const gd = run(path.join(LC, ".claude", "hooks", "proteus-lead-guard.js"), LC, HC, [], edit);
  ok("legacy run (1): the guard refuses a worker edit in the main checkout while demo is open", gd.code === 2 && /workers edit only inside their worktree/.test(gd.err), `${gd.code} ${gd.err}`);
  const tk = read(SRC, "skills", "proteus", "references", "tracker.md") || "";
  ok("legacy run (1): tracker.md's labels step creates the proteus labels on `labels: created` without `labels: proteus`, then records `labels: proteus`",
    /labels: created/.test(tk) && /labels: proteus/.test(tk), tk.split("\n").find((l) => l.startsWith("| labels")) || "");
  ok("legacy run (1): after the session start the run, its evidence branch and the journal are all still there", runKept(LC) && !!journalAt(LC), branches(LC).join(","));
}

// ---- 2. scratch sweep: scratch of an open run, legacy or new, is never swept; a done run's still is
{
  const LD = legacyRepo("scratch");
  g(LD, "branch", "proteus/new");
  const sd = (k) => path.join(LD, ".git", "proteus", "scratch", k);
  const old = new Date(Date.now() - 4 * 864e5); // done-and-idle-72h territory, under the 7-day cap
  const make = () => {
    for (const k of [RUN, `${RUN}-3`, "new", "gone"]) {
      if (fs.existsSync(sd(k))) continue;
      fs.mkdirSync(sd(k), { recursive: true });
      fs.writeFileSync(path.join(sd(k), "render.bin"), "x".repeat(1024));
      fs.utimesSync(sd(k), old, old);
    }
  };
  const sweep = (arg) => run(path.join(SRC, "templates", "hooks", "proteus-scratch.js"), LD, lib.HOME, ["--sweep", arg]);
  make();
  let r = sweep("--stale");
  ok("scratch (2): --stale keeps demo and demo-3, the open legacy run's and its ticket's", fs.existsSync(sd(RUN)) && fs.existsSync(sd(`${RUN}-3`)), r.out + r.err);
  ok("scratch (2): --stale keeps new, the open proteus run's, and sweeps gone, a done run's", fs.existsSync(sd("new")) && !fs.existsSync(sd("gone")), r.out + r.err);
  make();
  r = sweep("--all-done");
  ok("scratch (2): --all-done keeps demo and demo-3 while hive/demo is open", fs.existsSync(sd(RUN)) && fs.existsSync(sd(`${RUN}-3`)), r.out + r.err);
}

// ---- 3. Codex writable_roots: ../<repo>-hive goes only once no legacy run needs it, and both never stay without a reason
{
  const HE = fakeHome("codex");
  const codexEnv = { CODEX_HOME: path.join(HE, ".codex") };
  const cfg = (repo) => read(repo, ".codex", "config.toml") || "";
  const withHive = (repo) => {
    fs.mkdirSync(path.join(repo, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".codex", "config.toml"), `[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(repo + "-hive")}]\n`);
  };
  // a legacy ticket still in flight: its worktree lives in ../<repo>-hive/
  const L1 = legacyRepo("codex-live");
  g(L1, "worktree", "add", "-q", path.join(`${L1}-hive`, `${RUN}-3`), `hive/${RUN}-3`);
  withHive(L1);
  let r = run(path.join(SRC, "install.js"), L1, HE, ["--project", "--harness", "codex"], "", codexEnv);
  const d1 = run(path.join(SRC, "install.js"), L1, HE, ["--doctor", "--harness", "codex"], "", codexEnv);
  ok("codex (3): with a legacy worktree in <repo>-hive, config.toml keeps that root beside <repo>-proteus",
    r.code === 0 && cfg(L1).includes(JSON.stringify(`${L1}-hive`)) && cfg(L1).includes(JSON.stringify(`${L1}-proteus`)), `${r.code} ${cfg(L1)} ${r.err.slice(0, 200)}`);
  ok("codex (3): the kept <repo>-hive root has its reason in the --project or --doctor output", (r.out + d1.out).includes(`${L1}-hive`), (r.out + d1.out).split("\n").filter((l) => /sandbox|writable|hive/.test(l)).join(" | "));
  // no legacy run left: the stale entry goes
  const L2 = legacyRepo("codex-done", { open: false });
  withHive(L2);
  r = run(path.join(SRC, "install.js"), L2, HE, ["--project", "--harness", "codex"], "", codexEnv);
  ok("codex (3): with no legacy run, --project drops the stale <repo>-hive root and lists <repo>-proteus",
    r.code === 0 && !cfg(L2).includes(`${L2}-hive`) && cfg(L2).includes(JSON.stringify(`${L2}-proteus`)), `${r.code} ${cfg(L2)}`);
}

// ---- 4. orphaned state dir, part 2: a file already in .git/proteus is never overwritten, and what stays is reported
{
  const LF = legacyRepo("orphan-conflict");
  const HF = fakeHome("orphan");
  fs.mkdirSync(path.join(LF, ".git", "proteus"), { recursive: true });
  fs.writeFileSync(path.join(LF, ".git", "proteus", "lead-model.json"), "{\"model\":\"mine\"}\n");
  fs.writeFileSync(path.join(LF, ".git", "hive", "lead-model.json"), "{\"model\":\"old\"}\n");
  const r = run(path.join(SRC, "install.js"), LF, HF, ["--project"]);
  const d = run(path.join(SRC, "install.js"), LF, HF, ["--doctor"]);
  ok("orphan (4): --project never overwrites a file already in .git/proteus", r.code === 0 && read(LF, ".git", "proteus", "lead-model.json") === "{\"model\":\"mine\"}\n", read(LF, ".git", "proteus", "lead-model.json"));
  ok("orphan (4): the journal moves beside it, byte for byte", read(LF, ".git", "proteus", "journal.jsonl") === JOURNAL, read(LF, ".git", "proteus", "journal.jsonl"));
  ok("orphan (4): a .git/hive left behind by the conflict is reported by --doctor, never silently kept", !exists(LF, ".git", "hive") || doctorNames(d.out), d.out.split("\n").filter((l) => /hive/.test(l)).join(" | ") || d.out.slice(0, 300));
}

// ---- journal split (PR #16 review): after an auto-update the new hooks write .git/proteus/journal.jsonl while the old
// one waits in .git/hive. Order pinned here: the legacy lines first, then the new ones, each file in its own order (the
// legacy file is the older one; in this fixture that is also timestamp order). Each line once; a second run is a no-op.
const NEWER = [
  { ts: "2026-09-29T09:00:00.000Z", session_id: "s1", prompt: "after the update: ship the cli before the store" },
  { ts: "2026-09-29T09:10:00.000Z", session_id: "s1", prompt: "no new dependencies in the cli" },
].map((l) => JSON.stringify(l) + "\n").join("");
const MERGED = [...lines(JOURNAL), ...lines(NEWER)];
const NEW_PROMPT = JSON.parse(lines(NEWER)[1]).prompt;
const splitRepo = (name) => {
  const d = legacyRepo(name);
  fs.mkdirSync(path.join(d, ".git", "proteus"), { recursive: true });
  fs.writeFileSync(path.join(d, ".git", "proteus", "journal.jsonl"), NEWER);
  return d;
};
const keepOne = (...outs) => outs.flatMap(lines).filter((l) => /keep one\b.*then delete/.test(l));
const prompts = (ls) => ls.map((l) => { try { return JSON.parse(l).prompt; } catch { return l; } }).join(" | ");
function mergedJournal(repo, how) {
  const got = lines(read(repo, ".git", "proteus", "journal.jsonl"));
  ok(`journal split (${how}): .git/hive/journal.jsonl is gone`, !exists(repo, ".git", "hive", "journal.jsonl"), prompts(lines(read(repo, ".git", "hive", "journal.jsonl"))));
  ok(`journal split (${how}): .git/proteus/journal.jsonl holds every line of both files, each exactly once`,
    got.length === MERGED.length && MERGED.every((l) => got.filter((x) => x === l).length === 1), prompts(got));
  ok(`journal split (${how}): the legacy lines come first, then the new ones, each file in its own order`, JSON.stringify(got) === JSON.stringify(MERGED), prompts(got));
}
function recallsBoth(repo, home, how) {
  const s = sessionStart(repo, home, "compact");
  const said = s.out.slice(Math.max(0, s.out.indexOf("human said")));
  ok(`journal split (${how}): compaction recall surfaces a prompt from each file`, /human said/.test(s.out) && said.includes(PROMPT) && said.includes(NEW_PROMPT), said.slice(0, 600) || s.err);
}
{
  // through the session start, with the new hooks an auto-update synced and no installer run
  const JA = splitRepo("journal-autostart");
  const HJ = fakeHome("journal-autostart");
  newHooks(JA);
  quiet(HJ);
  const s1 = sessionStart(JA, HJ, "startup");
  mergedJournal(JA, "autostart");
  recallsBoth(JA, HJ, "autostart");
  const both = () => [read(JA, ".git", "proteus", "journal.jsonl"), read(JA, ".git", "hive", "journal.jsonl")];
  const once = both();
  const s2 = sessionStart(JA, HJ, "startup");
  ok("journal split (autostart): a second session start changes neither journal", JSON.stringify(both()) === JSON.stringify(once), both().map((t) => prompts(lines(t))).join(" || "));
  const d = run(path.join(SRC, "install.js"), JA, HJ, ["--doctor"]);
  ok("journal split (autostart): neither the session start nor --doctor says to keep one journal and delete the other", !keepOne(s1.out, s2.out, d.out).length, keepOne(s1.out, s2.out, d.out).join(" | "));
}
{
  // through install.js --project
  const JP = splitRepo("journal-project");
  const HP = fakeHome("journal-project");
  const r1 = run(path.join(SRC, "install.js"), JP, HP, ["--project"]);
  ok("journal split (--project): install.js --project exits 0", r1.code === 0, r1.out + r1.err);
  mergedJournal(JP, "--project");
  quiet(HP);
  recallsBoth(JP, HP, "--project");
  const before = snapshot(JP);
  const r2 = run(path.join(SRC, "install.js"), JP, HP, ["--project"]);
  const after = snapshot(JP);
  const diff = [...after.filter((x) => !before.includes(x)).map((x) => `+${x}`), ...before.filter((x) => !after.includes(x)).map((x) => `-${x}`)];
  ok("journal split (--project): a second --project exits 0 and changes nothing", r2.code === 0 && !diff.length, `${r2.code} ${diff.slice(0, 6).join(" | ")}`);
  const d = run(path.join(SRC, "install.js"), JP, HP, ["--doctor"]);
  ok("journal split (--project): neither --project nor --doctor says to keep one journal and delete the other", !keepOne(r1.out, r1.err, r2.out, r2.err, d.out).length, keepOne(r1.out, r1.err, r2.out, r2.err, d.out).join(" | "));
}

// ---- Codex root at session start (PR #16 review): an auto-update leaves writable_roots without ../<repo>-proteus. The
// next session start adds that root and nothing else, or prints the one command that finishes the move.
{
  const LX = legacyRepo("codex-autostart");
  const HX = fakeHome("codex-autostart");
  const cxEnv = { CODEX_HOME: path.join(HX, ".codex") };
  fs.mkdirSync(cxEnv.CODEX_HOME);
  newHooks(LX, [".codex", "hooks"], [".agents", "skills", "proteus"]);
  quiet(HX);
  const before = [`${LX}-hive`, "/opt/tools"];
  fs.writeFileSync(path.join(LX, ".codex", "config.toml"), `[sandbox_workspace_write]\nwritable_roots = [${before.map((x) => JSON.stringify(x)).join(", ")}]\n`);
  const s = run(path.join(LX, ".codex", "hooks", "proteus-autostart.js"), LX, HX, [], { hook_event_name: "SessionStart", source: "startup", session_id: "cx-startup", cwd: LX }, cxEnv);
  const text = read(LX, ".codex", "config.toml") || "";
  const roots = tomlRoots(text);
  const added = Array.isArray(roots) && roots.includes(`${LX}-proteus`);
  const hint = lines(s.out).some((l) => /install\.js"? --update\b|install\.ps1"? -Update\b/.test(l));
  ok("codex root at session start: ../<repo>-proteus is added to writable_roots, or the output names install.js --update / install.ps1 -Update",
    added || hint, `${text.trim()} :: ${lines(s.out).filter((l) => /proteus:|writable|codex|update/i.test(l)).join(" | ").slice(0, 400) || s.err}`);
  ok("codex root at session start: config.toml stays valid TOML, keeps the user's root and gains no root but ../<repo>-proteus",
    Array.isArray(roots) && roots.includes("/opt/tools") && roots.every((x) => x === `${LX}-proteus` || before.includes(x)), text);
}

// ---- Codex TOML (PR #16 review, debt 1): an existing root whose string holds `#` still gets the -proteus root beside it,
// comma-separated; a regression check, base (hive/pi) writes it correctly
{
  const LH = legacyRepo("codex-hash", { open: false });
  const HH = fakeHome("codex-hash");
  fs.mkdirSync(path.join(LH, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(LH, ".codex", "config.toml"), "[sandbox_workspace_write]\nwritable_roots = [\"/opt/a,#\"]\n");
  const r = run(path.join(SRC, "install.js"), LH, HH, ["--project", "--harness", "codex"], "", { CODEX_HOME: path.join(HH, ".codex") });
  const text = read(LH, ".codex", "config.toml") || "";
  const roots = tomlRoots(text);
  ok("codex toml: with a root \"/opt/a,#\", writable_roots stays an array of comma-separated strings", r.code === 0 && Array.isArray(roots), `${r.code} ${text}`);
  ok("codex toml: it keeps \"/opt/a,#\" and adds ../<repo>-proteus", Array.isArray(roots) && roots.includes("/opt/a,#") && roots.includes(`${LH}-proteus`), JSON.stringify(roots));
}

// ---- robust --project (PR #16 review, debt 5): an entry the listing saw but lstat cannot reach (as when a concurrent
// migration moved it) must not abort --project. Simulated with a legacy dir that can be listed but not searched (r--).
if (process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0)) {
  console.log("skipped robust --project: needs POSIX permissions and a non-root user");
} else {
  const LU = legacyRepo("unreadable");
  const HU = fakeHome("unreadable");
  const hs = path.join(LU, ".git", "hive", "scratch"), key = `${RUN}-3`;
  fs.mkdirSync(path.join(hs, key), { recursive: true });
  fs.writeFileSync(path.join(hs, key, "render.bin"), "legacy scratch\n");
  fs.mkdirSync(path.join(LU, ".git", "proteus", "scratch", key), { recursive: true }); // on both sides: the walk descends
  let r;
  fs.chmodSync(hs, 0o444);
  try { r = run(path.join(SRC, "install.js"), LU, HU, ["--project"]); } finally { fs.chmodSync(hs, 0o755); }
  ok("robust --project: a .git/hive entry that vanishes between the listing and the lstat does not abort install.js --project", r.code === 0, `${r.code} ${r.err.slice(-400)}`);
  ok("robust --project: the rest still runs: hooks installed, the journal moved byte for byte",
    exists(LU, ".claude", "hooks", "proteus-autostart.js") && read(LU, ".git", "proteus", "journal.jsonl") === JOURNAL, `${r.out.slice(-300)} ${r.err.slice(-300)}`);
  const d = run(path.join(SRC, "install.js"), LU, HU, ["--doctor"]);
  ok("robust --project: the unreached entry is kept, not lost, and --doctor names what stays in .git/hive",
    [hs, path.join(LU, ".git", "proteus", "scratch")].some((s) => read(s, key, "render.bin") === "legacy scratch\n") && (!exists(LU, ".git", "hive") || doctorNames(d.out)),
    d.out.split("\n").filter((l) => /hive/.test(l)).join(" | "));
}

// ---- scratch worktree (PR #16 review, debt 4): a worktree registered under .git/hive/scratch/<key>/wt stays a live,
// registered worktree after the migration (left in place, or moved and repaired), and a sweep that prunes keeps it
{
  const LW = legacyRepo("scratch-wt");
  const HW = fakeHome("scratch-wt");
  const tail = path.join("scratch", `${RUN}-3`, "wt");
  const live = path.join(LW, ".git", "hive", tail);
  fs.mkdirSync(path.dirname(live), { recursive: true });
  g(LW, "worktree", "add", "-q", "--detach", live);
  const r = run(path.join(SRC, "install.js"), LW, HW, ["--project"]);
  const list = () => g(LW, "worktree", "list", "--porcelain");
  // the live worktree's registered path, when git still has it and its .git file is there
  const liveAt = () => {
    const p = lines(list()).filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9)).find((x) => path.resolve(x).endsWith(tail));
    return p && fs.existsSync(path.join(p, ".git")) ? p : "";
  };
  ok("scratch worktree (5): after --project, git worktree list shows the scratch worktree registered and not prunable", r.code === 0 && !!liveAt() && !/^prunable\b/m.test(list()), `${r.code} ${list().replace(/\n/g, " | ")}`);
  // a done key's worktree in the new scratch: sweeping it runs `git worktree prune`
  const gone = path.join(LW, ".git", "proteus", "scratch", "gone", "wt");
  fs.mkdirSync(path.dirname(gone), { recursive: true });
  g(LW, "worktree", "add", "-q", "--detach", gone);
  const sw = run(path.join(SRC, "templates", "hooks", "proteus-scratch.js"), LW, HW, ["--sweep", "gone"]);
  ok("scratch worktree (5) fixture: the sweep removed the done key's worktree, so it ran git worktree prune", !fs.existsSync(gone), sw.out + sw.err);
  const at = liveAt();
  let inside = "";
  try { inside = at ? g(at, "rev-parse", "--is-inside-work-tree") : ""; } catch {}
  ok("scratch worktree (5): after the sweep the live worktree is still registered, not prunable, and usable", !!at && inside === "true" && !/^prunable\b/m.test(list()), list().replace(/\n/g, " | "));
}

// ---- migration pins (#18): paths the QA mutation pass found unpinned. Faults come from a `node -r <preload>` written
// into T, never from a hook in shipped code.
const preload = (name, body) => { const f = path.join(T, `${name}.preload.js`); fs.writeFileSync(f, `"use strict";\nconst fs = require("fs");\n${body}\n`); return f; };
const runPre = (pre, script, cwd, home, args = [], input = "", extra = {}) => {
  const r = spawnSync(process.execPath, ["-r", pre, script, ...args], { cwd, input: typeof input === "string" ? input : JSON.stringify(input), env: { ...lib.ENV, CLAUDE_PROJECT_DIR: cwd, ...envFor(home, extra) }, encoding: "utf8", windowsHide: true, timeout: 120000 });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
};
const INSTALL = path.join(SRC, "install.js");
const tmpLeft = (repo) => { try { return fs.readdirSync(path.join(repo, ".git", "proteus")).filter((f) => f.endsWith(".merge.tmp")); } catch { return []; } };

// a filesystem with no hard links: linkSync throws EXDEV and every file still moves, by copy
{
  const LK = legacyRepo("exdev");
  const HK = fakeHome("exdev");
  const pre = preload("exdev", "fs.linkSync = () => { throw Object.assign(new Error(\"EXDEV: cross-device link not permitted\"), { code: \"EXDEV\" }); };");
  const r = runPre(pre, INSTALL, LK, HK, ["--project"]);
  ok("pin exdev: with linkSync throwing EXDEV, --project exits 0 and reports no failed entry", r.code === 0 && !/EXDEV/.test(r.out + r.err), `${r.code} ${(r.out + r.err).split("\n").filter((l) => /state|failed|EXDEV/.test(l)).join(" | ")}`);
  ok("pin exdev: the journal and the inbox cache are copied into .git/proteus byte for byte and .git/hive is gone",
    read(LK, ".git", "proteus", "journal.jsonl") === JOURNAL && /"questions"/.test(read(LK, ".git", "proteus", "inbox.json") || "") && !exists(LK, ".git", "hive"),
    `${read(LK, ".git", "proteus", "journal.jsonl")} :: ${exists(LK, ".git", "hive") ? fs.readdirSync(path.join(LK, ".git", "hive")).join(",") : "hive gone"}`);
}

// a merge that renamed its result into place but could not delete the legacy journal: the rerun keeps each line once
{
  const JR = splitRepo("journal-rerun");
  const HR = fakeHome("journal-rerun");
  const pre = preload("unlink-busy", "const path = require(\"path\"), unlink = fs.unlinkSync;\nfs.unlinkSync = function (p, ...a) { if (String(p).endsWith(path.join(\"hive\", \"journal.jsonl\"))) throw Object.assign(new Error(\"EBUSY\"), { code: \"EBUSY\" }); return unlink.call(this, p, ...a); };");
  const r1 = runPre(pre, INSTALL, JR, HR, ["--project"]);
  ok("pin partial merge fixture: the first pass merges, then fails to delete .git/hive/journal.jsonl (EBUSY)",
    /journal\.jsonl \(EBUSY\)/.test(r1.out + r1.err) && JSON.stringify(lines(read(JR, ".git", "proteus", "journal.jsonl"))) === JSON.stringify(MERGED) && read(JR, ".git", "hive", "journal.jsonl") === JOURNAL,
    `${(r1.out + r1.err).split("\n").filter((l) => /hive/.test(l)).join(" | ")} :: ${prompts(lines(read(JR, ".git", "proteus", "journal.jsonl")))}`);
  const r2 = run(INSTALL, JR, HR, ["--project"]);
  mergedJournal(JR, "rerun after a partial merge");
  ok("pin partial merge: the rerun exits 0", r2.code === 0, r2.out + r2.err);
}

// a line appended to .git/proteus/journal.jsonl while the merge runs aborts that pass: failed (EAGAIN), no line lost
const APPENDED = JSON.stringify({ ts: "2026-09-29T09:20:00.000Z", session_id: "s2", prompt: "appended while the merge ran" });
const appendPre = () => preload("append-mid-merge", `const write = fs.writeFileSync;\nlet done = false;\nfs.writeFileSync = function (f, ...a) {\n  const r = write.call(this, f, ...a);\n  if (!done && /\\.merge\\.tmp$/.test(String(f))) { done = true; fs.appendFileSync(String(f).replace(/\\.\\d+\\.\\d+\\.merge\\.tmp$/, ""), ${JSON.stringify(APPENDED + "\n")}); }\n  return r;\n};`);
{
  const JM = splitRepo("journal-append");
  const HM = fakeHome("journal-append");
  const r1 = runPre(appendPre(), INSTALL, JM, HM, ["--project"]);
  ok("pin append mid-merge: --project reports .git/hive journal.jsonl as failed (EAGAIN)", /journal\.jsonl \(EAGAIN\)/.test(r1.out + r1.err), (r1.out + r1.err).split("\n").filter((l) => /hive|state/.test(l)).join(" | "));
  ok("pin append mid-merge: no line is lost: the legacy journal is untouched, the current one holds its lines plus the appended one, no temp file is left",
    read(JM, ".git", "hive", "journal.jsonl") === JOURNAL && read(JM, ".git", "proteus", "journal.jsonl") === NEWER + APPENDED + "\n" && !tmpLeft(JM).length,
    `${prompts(lines(read(JM, ".git", "hive", "journal.jsonl")))} || ${prompts(lines(read(JM, ".git", "proteus", "journal.jsonl")))} || ${tmpLeft(JM).join(",")}`);
  const r2 = run(INSTALL, JM, HM, ["--project"]);
  const got = lines(read(JM, ".git", "proteus", "journal.jsonl"));
  ok("pin append mid-merge: a rerun merges every line once, the appended one included, and removes .git/hive/journal.jsonl",
    r2.code === 0 && JSON.stringify(got) === JSON.stringify([...MERGED, APPENDED]) && !exists(JM, ".git", "hive", "journal.jsonl"), `${r2.code} ${prompts(got)}`);
}

// the compaction recall still reads a legacy journal whose merge was aborted at this session start
{
  const JH = splitRepo("journal-held");
  const HH2 = fakeHome("journal-held");
  newHooks(JH);
  quiet(HH2);
  const s = runPre(appendPre(), path.join(JH, ".claude", "hooks", "proteus-autostart.js"), JH, HH2, [], { hook_event_name: "SessionStart", source: "compact", session_id: "s-held", cwd: JH });
  ok("pin held journal fixture: the session start's merge was aborted, the legacy journal is still in .git/hive", read(JH, ".git", "hive", "journal.jsonl") === JOURNAL, `${s.out.split("\n").filter((l) => /still holds/.test(l)).join(" | ")} ${s.err.slice(0, 200)}`);
  const said = s.out.slice(Math.max(0, s.out.indexOf("human said")));
  ok("pin held journal: after a compaction the recall surfaces the unmerged legacy journal's prompt and the current one's",
    /human said/.test(s.out) && said.includes(PROMPT) && said.includes(NEW_PROMPT), said.slice(0, 600) || s.err.slice(0, 300));
}

// Codex writable_roots: only a worktree inside ../<repo>-hive keeps that root listed
{
  const HC2 = fakeHome("codex-pins");
  const cx = { CODEX_HOME: path.join(HC2, ".codex") };
  const toml = (repo, roots) => { fs.mkdirSync(path.join(repo, ".codex"), { recursive: true }); fs.writeFileSync(path.join(repo, ".codex", "config.toml"), `[sandbox_workspace_write]\nwritable_roots = [${roots.map((x) => JSON.stringify(x)).join(", ")}]\n`); };
  const rootsOf = (repo) => tomlRoots(read(repo, ".codex", "config.toml") || "");

  const LO = legacyRepo("codex-unrelated", { open: false });
  const other = path.join(T, "codex-unrelated-elsewhere");
  g(LO, "worktree", "add", "-q", "--detach", other);
  toml(LO, [`${LO}-hive`]);
  let r = run(INSTALL, LO, HC2, ["--project", "--harness", "codex"], "", cx);
  let roots = rootsOf(LO);
  ok("pin codex: a registered worktree outside ../<repo>-hive does not keep that root; --project drops it and lists ../<repo>-proteus",
    r.code === 0 && fs.existsSync(path.join(other, ".git")) && Array.isArray(roots) && !roots.includes(`${LO}-hive`) && roots.includes(`${LO}-proteus`), `${r.code} ${JSON.stringify(roots)}`);

  const LS = legacyRepo("codex-both", { open: false });
  toml(LS, [`${LS}-hive`, `${LS}-proteus`]);
  r = run(INSTALL, LS, HC2, ["--project", "--harness", "codex"], "", cx);
  roots = rootsOf(LS);
  ok("pin codex: with ../<repo>-proteus already listed and no legacy worktree, --project still drops the stale ../<repo>-hive root",
    r.code === 0 && Array.isArray(roots) && !roots.includes(`${LS}-hive`) && roots.includes(`${LS}-proteus`), `${r.code} ${JSON.stringify(roots)}`);
}

// a worker worktree dispatched before the rename carries .claude/hive-owned: the owned-path hook enforces it
{
  const LP = legacyRepo("legacy-owned");
  const WT = path.join(`${LP}-hive`, `${RUN}-3`);
  g(LP, "worktree", "add", "-q", WT, `hive/${RUN}-3`);
  fs.cpSync(path.join(SRC, "templates", "hooks"), path.join(WT, ".claude", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(WT, ".claude", "hive-owned"), "src/api/\n");
  const HO = fakeHome("legacy-owned");
  const edit = (f) => run(path.join(WT, ".claude", "hooks", "proteus-owned-paths.js"), WT, HO, [], { hook_event_name: "PreToolUse", session_id: "w-legacy", cwd: WT, tool_name: "Edit", tool_input: { file_path: path.join(WT, f) } });
  const out = edit(path.join("src", "store", "db.ts"));
  ok("pin legacy owned: an edit outside the paths in .claude/hive-owned is denied", out.code === 2 && /NEEDS src\/store\/db\.ts/.test(out.err) && /hive-owned/.test(out.err), `${out.code} ${out.err}`);
  const inside = edit(path.join("src", "api", "a.ts"));
  ok("pin legacy owned: an edit inside them is allowed", inside.code === 0, `${inside.code} ${inside.err}`);
}

// the inbox counts a legacy run's needs-human questions and reviews
{
  const LI = legacyRepo("legacy-inbox");
  const HI = fakeHome("legacy-inbox");
  newHooks(LI);
  const saved = read(DB);
  const db = JSON.parse(saved);
  db.issues.push({ number: 21, title: "which store for the demo cache?", state: "OPEN", createdAt: iso(3), closedAt: null, milestone: null, labels: [{ name: "needs-human" }, { name: "hive-question" }], comments: [] });
  db.issues.push({ number: 22, title: "review: demo m1", state: "OPEN", createdAt: iso(3), closedAt: null, milestone: null, labels: [{ name: "needs-human" }, { name: "hive-review" }], comments: [] });
  fs.writeFileSync(DB, JSON.stringify(db));
  let r;
  try { r = run(path.join(LI, ".claude", "hooks", "proteus-inbox.js"), LI, HI, ["--refresh"]); } finally { fs.writeFileSync(DB, saved); }
  const inbox = JSON.parse(read(LI, ".git", "proteus", "inbox.json") || "{}");
  const ns = (k) => (Array.isArray(inbox[k]) ? inbox[k].map((i) => i.n) : []);
  ok("pin legacy inbox: a hive-question issue is listed under questions in inbox.json, a hive-review one under reviews",
    ns("questions").includes(21) && ns("reviews").includes(22) && /question #21\b/.test(r.out), `${JSON.stringify(inbox)} :: ${r.out}`);
}

// after a state move, --project refreshes the hooks of every CLI set up in the repo, not only the one named
{
  const LB = legacyRepo("refresh-both", { open: false });
  const HB2 = fakeHome("refresh-both");
  const cx = { CODEX_HOME: path.join(HB2, ".codex") };
  const r0 = run(INSTALL, LB, HB2, ["--project"], "", cx);
  const r1 = run(INSTALL, LB, HB2, ["--project", "--harness", "codex"], "", cx);
  const lib0 = path.join(LB, ".codex", "hooks", "proteus-lib.js");
  ok("pin refresh fixture: the repo is set up for Claude and Codex", r0.code === 0 && r1.code === 0 && exists(LB, ".claude", "hooks", "proteus-autostart.js") && exists(LB, ".codex", "hooks", "proteus-autostart.js") && fs.existsSync(lib0), `${r0.code} ${r1.code} ${r1.err.slice(0, 300)}`);
  // a pre-rename state dir again, and a Codex hook from before the move
  fs.mkdirSync(path.join(LB, ".git", "hive"), { recursive: true });
  fs.writeFileSync(path.join(LB, ".git", "hive", "lessons.md"), "legacy lesson\n");
  fs.writeFileSync(lib0, "// proteus-lib.js from before the state move\n");
  const r = run(INSTALL, LB, HB2, ["--project"], "", cx);
  ok("pin refresh: --project (Claude) after a state move also refreshes .codex/hooks to this checkout's hooks",
    r.code === 0 && !exists(LB, ".git", "hive") && read(lib0) === read(SRC, "templates", "hooks", "proteus-lib.js"), `${r.code} ${(read(lib0) || "").slice(0, 80)}`);
}

summary();
if (!process.exitCode) fs.rmSync(T, { recursive: true, force: true });
else console.log(`fixtures kept in ${T}`);

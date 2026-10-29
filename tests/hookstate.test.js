// #236: node tests/hookstate.test.js (needs git). The hooks run outside any sandbox, while agents can write
// <common>/proteus, so no hook may write, append, rename or delete through a link planted there. The lead's own
// state lives in <common>/proteus-lead behind lib.leadDir; what agents write is read untrusted and never written
// back. Links are planted at the old and the new paths (the file, its temp name, a parent dir swapped for a link)
// and every outside target must come out unchanged. Also: the noticelink and journal probes from the #212 review,
// a static scan for raw writes in the hooks, and a mutation check of the helper. Temp repo; never the network.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "templates", "hooks");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("hookstate");
const L = require(path.join(SRC, "proteus-lib.js"));

// a link that may not be creatable (Windows without developer mode): false then, and the case is skipped
const link = (target, at, type) => { try { fs.symlinkSync(target, at, type); return true; } catch { return false; } };
const has = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const readOr = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
const throwsCode = (fn, code) => { try { fn(); return false; } catch (e) { return !code || e.code === code; } };

// outside targets: a file and a dir whose content is checked after every scenario
const OUT = path.join(W, "outside");
fs.mkdirSync(OUT);
const VICTIM = path.join(OUT, "victim.txt"), VDIR = path.join(OUT, "vdir");
const VTEXT = "original\n";
const resetVictims = () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(VDIR, { recursive: true });
  fs.writeFileSync(VICTIM, VTEXT);
  fs.writeFileSync(path.join(VDIR, "keep.txt"), VTEXT);
};
const untouched = () => {
  const bad = [];
  if (fs.readFileSync(VICTIM, "utf8") !== VTEXT) bad.push(`${VICTIM}: ${fs.readFileSync(VICTIM, "utf8").slice(0, 200)}`);
  const names = fs.readdirSync(VDIR);
  if (names.join() !== "keep.txt" || fs.readFileSync(path.join(VDIR, "keep.txt"), "utf8") !== VTEXT) bad.push(`${VDIR}: ${names.join(" ")}`);
  for (const f of fs.readdirSync(OUT)) if (!["victim.txt", "vdir"].includes(f)) bad.push(`new ${f} in ${OUT}`);
  return bad.join("; ");
};

// ---- the helper, in process
function helperCases(H, base) {
  const fails = [];
  const check = (name, cond) => { if (!cond) fails.push(name); };
  let n = 0;
  const repo = () => { const d = path.join(base, `c${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };
  resetVictims();

  // happy path: a write, an append, a create, a remove
  let c = repo();
  H.leadWrite(c, H.leadPath(c, "a", "b.json"), "x");
  check("write: lands under proteus-lead", fs.readFileSync(path.join(c, "proteus-lead", "a", "b.json"), "utf8") === "x");
  H.leadAppend(c, H.leadPath(c, "j.jsonl"), "1\n"); H.leadAppend(c, H.leadPath(c, "j.jsonl"), "2\n");
  check("append: appends", fs.readFileSync(H.leadPath(c, "j.jsonl"), "utf8") === "1\n2\n");
  check("create: once, then false", H.leadCreate(c, H.leadPath(c, "k"), "1") && !H.leadCreate(c, H.leadPath(c, "k"), "2"));
  H.leadRemove(c, H.leadPath(c, "k")); H.leadRemove(c, H.leadPath(c, "k"));
  check("remove: gone, and twice is fine", !has(H.leadPath(c, "k")));
  check("no temp file left", !fs.readdirSync(H.leadPath(c, "a")).some((f) => f.endsWith(".tmp")));
  check("outside the lead dir refused", throwsCode(() => H.leadWrite(c, path.join(c, "proteus", "x"), "y"), "ELEADSTATE") && !has(path.join(c, "proteus", "x")));
  check("a .. path refused", throwsCode(() => H.leadWrite(c, H.leadPath(c, "..", "x"), "y"), "ELEADSTATE"));

  // the final name a link: a rewrite replaces the link, an append and a create refuse it
  c = repo();
  H.leadDir(c);
  if (link(VICTIM, H.leadPath(c, "f.json"))) {
    H.leadWrite(c, H.leadPath(c, "f.json"), "new");
    check("write over a link replaces the link", !isLink(H.leadPath(c, "f.json")) && fs.readFileSync(H.leadPath(c, "f.json"), "utf8") === "new");
    fs.unlinkSync(H.leadPath(c, "f.json"));
    link(VICTIM, H.leadPath(c, "f.json"));
    check("append through a link refused", throwsCode(() => H.leadAppend(c, H.leadPath(c, "f.json"), "pwned\n")));
    check("create at a link is false", H.leadCreate(c, H.leadPath(c, "f.json"), "pwned") === false);
    H.leadRemove(c, H.leadPath(c, "f.json"));
    check("remove of a link removes the link", !has(H.leadPath(c, "f.json")));
    link(path.join(OUT, "nothing-here"), H.leadPath(c, "d.json"));
    check("append through a dangling link refused", throwsCode(() => H.leadAppend(c, H.leadPath(c, "d.json"), "x")) && !has(path.join(OUT, "nothing-here")));
    check("create at a dangling link is false", H.leadCreate(c, H.leadPath(c, "d.json"), "x") === false && !has(path.join(OUT, "nothing-here")));
    // the temp name: the old <file>.<pid>.tmp and a spray around it never get written
    for (let i = 0; i < 50; i++) link(VICTIM, `${H.leadPath(c, "t.json")}.${process.pid + i}.tmp`);
    H.leadWrite(c, H.leadPath(c, "t.json"), "t");
    check("temp-name links are not written through", fs.readFileSync(H.leadPath(c, "t.json"), "utf8") === "t");
  }

  // a dir on the way a link: proteus-lead/<sub>, proteus-lead itself, <common> itself
  c = repo();
  H.leadDir(c);
  if (link(VDIR, H.leadPath(c, "agents"), "dir")) {
    check("subdir link: write refused", throwsCode(() => H.leadWrite(c, H.leadPath(c, "agents", "agent-x"), "pwned"), "ELEADSTATE"));
    check("subdir link: append refused", throwsCode(() => H.leadAppend(c, H.leadPath(c, "agents", "agent-x"), "pwned"), "ELEADSTATE"));
    check("subdir link: create refused", throwsCode(() => H.leadCreate(c, H.leadPath(c, "agents", "agent-x"), "pwned"), "ELEADSTATE"));
    check("subdir link: remove refused", throwsCode(() => H.leadRemove(c, H.leadPath(c, "agents", "keep.txt")), "ELEADSTATE"));
  }
  c = repo();
  if (link(VDIR, path.join(c, "proteus-lead"), "dir")) {
    check("proteus-lead a link: write refused", throwsCode(() => H.leadWrite(c, H.leadPath(c, "x.json"), "pwned"), "ELEADSTATE"));
    check("proteus-lead a link: remove refused", throwsCode(() => H.leadRemove(c, H.leadPath(c, "keep.txt")), "ELEADSTATE"));
    check("proteus-lead a link: trash refused", throwsCode(() => H.leadTrash(c, path.join(VDIR, "keep.txt")), "ELEADSTATE"));
  }
  c = repo();
  const lc = path.join(base, `lc${n}`);
  if (link(c, lc, "dir")) check("<common> a link: refused", throwsCode(() => H.leadWrite(lc, H.leadPath(lc, "x.json"), "pwned"), "ELEADSTATE") && !has(path.join(c, "proteus-lead")));
  check("no common dir: refused", throwsCode(() => H.leadDir(null), "ELEADSTATE"));

  // not this user's: process.getuid answers another uid
  if (typeof process.getuid === "function") {
    const real = process.getuid;
    c = repo();
    process.getuid = () => real() + 1;
    try { check("another owner: refused", throwsCode(() => H.leadWrite(c, H.leadPath(c, "x.json"), "x"), "ELEADSTATE") && !has(path.join(c, "proteus-lead", "x.json"))); }
    finally { process.getuid = real; }
  }

  // untrusted reads: no link, no FIFO, a size cap
  c = repo();
  const u = path.join(c, "u.json");
  fs.writeFileSync(u, '{"a":1}');
  check("untrusted: a regular file reads", H.readUntrustedJSON(u, null).a === 1);
  check("untrusted: over the cap refused", throwsCode(() => H.readUntrusted(u, 3), "EFBIG"));
  if (link(VICTIM, path.join(c, "l.json"))) check("untrusted: a link is not read", throwsCode(() => H.readUntrusted(path.join(c, "l.json"))) && H.readUntrustedJSON(path.join(c, "l.json"), "d") === "d");

  // migration from <common>/proteus on first use: regular files only, a linked state dir not at all
  c = repo();
  const old = path.join(c, "proteus");
  fs.mkdirSync(path.join(old, "agents"), { recursive: true });
  fs.writeFileSync(path.join(old, "journal.jsonl"), '{"prompt":"kept"}\n');
  fs.writeFileSync(path.join(old, "agents", "agent-a"), "/wt\n");
  const linked = link(VICTIM, path.join(old, "visibility.json")) && link(VICTIM, path.join(old, "agents", "agent-b"));
  H.leadDir(c);
  check("migrate: a regular file is copied", fs.readFileSync(H.leadPath(c, "journal.jsonl"), "utf8") === '{"prompt":"kept"}\n' && fs.readFileSync(H.leadPath(c, "agents", "agent-a"), "utf8") === "/wt\n");
  check("migrate: the old file stays", has(path.join(old, "journal.jsonl")));
  if (linked) check("migrate: a link is skipped", !has(H.leadPath(c, "visibility.json")) && !has(H.leadPath(c, "agents", "agent-b")));
  c = repo();
  const ext = path.join(base, `ext${n}`);
  fs.mkdirSync(ext);
  fs.writeFileSync(path.join(ext, "journal.jsonl"), "from the link\n");
  if (link(ext, path.join(c, "proteus"), "dir")) { H.leadDir(c); check("migrate: a linked state dir is not read", !has(H.leadPath(c, "journal.jsonl"))); }

  const bad = untouched();
  if (bad) fails.push(`outside changed: ${bad}`);
  return fails;
}

const BASE = path.join(W, "helper");
const fails = helperCases(L, BASE);
ok("helper: every case holds", !fails.length, fails.join(" | "));

// mutation check: each mutant of the helper's guards must fail at least one case above
const MUT = path.join(W, "mutants");
fs.mkdirSync(MUT);
const libSrc = fs.readFileSync(path.join(SRC, "proteus-lib.js"), "utf8");
const mutants = [
  ["ownDir ignores a link", "if (st.isSymbolicLink() || !st.isDirectory())", "if (!st.isDirectory() && !st.isSymbolicLink())"],
  ["leadDir skips <common>", "  ownDir(common);\n  const d = path.join(path.resolve(common), LEAD);", "  const d = path.join(path.resolve(common), LEAD);"],
  ["leadTarget skips the dirs on the way", "{ d = path.join(d, s); makeDir(d); ownDir(d); }", "{ d = path.join(d, s); makeDir(d); }"],
  ["leadTarget lets a path out", "if (!rel || path.isAbsolute(rel) || segs.some((s) => !s || s === \".\" || s === \"..\"))", "if (!rel)"],
  ["append follows a link", "  try { if (fs.lstatSync(f).isSymbolicLink()) throw leadErr(`${f} is a link`); } catch (e) { if (e.code !== \"ENOENT\") throw e; }\n  const fd = fs.openSync(f, c.O_WRONLY | c.O_APPEND | c.O_CREAT | (c.O_NOFOLLOW || 0), 0o600);", "  const fd = fs.openSync(f, c.O_WRONLY | c.O_APPEND | c.O_CREAT, 0o600);"],
  ["create follows a link", "  try { fs.writeFileSync(f, text, { flag: \"wx\", mode: 0o600 }); return true; }", "  try { fs.writeFileSync(f, text, { mode: 0o600 }); return true; }"],
  ["uid not checked", "const uidOk = (st) => typeof process.getuid !== \"function\" || st.uid === process.getuid();", "const uidOk = () => true;"],
  ["migration reads a linked state dir", "  try { ownDir(src); } catch { return; }\n", ""],
];
for (const [name, from, to] of mutants) {
  if (!libSrc.includes(from)) { ok(`mutant "${name}": its code is still in the helper`, false, from); continue; }
  const dir = path.join(MUT, name.replace(/\W+/g, "-"));
  fs.mkdirSync(dir);
  for (const f of fs.readdirSync(SRC).filter((x) => x.endsWith(".js"))) fs.copyFileSync(path.join(SRC, f), path.join(dir, f));
  const file = path.join(dir, "proteus-lib.js");
  fs.writeFileSync(file, libSrc.replace(from, to));
  const M = require(file);
  const posixOnly = /uid/.test(name) && typeof process.getuid !== "function";
  const caught = helperCases(M, path.join(dir, "cases"));
  if (!posixOnly) ok(`mutant "${name}" is caught`, caught.length > 0, "every case passed with the guard removed");
}
resetVictims();

// ---- the hooks, run as Claude Code runs them
const REPO = path.join(W, "repo");
g(W, "init", "-q", "-b", "main", REPO);
fs.mkdirSync(path.join(REPO, "src"), { recursive: true });
fs.writeFileSync(path.join(REPO, "src", "a.js"), "a\n");
fs.mkdirSync(path.join(REPO, ".claude", "skills", "proteus"), { recursive: true });
fs.writeFileSync(path.join(REPO, ".claude", "skills", "proteus", "SKILL.md"), "---\nname: proteus\n---\nSKILL BODY\n");
fs.mkdirSync(path.join(REPO, "docs", "lessons"), { recursive: true });
fs.writeFileSync(path.join(REPO, "docs", "lessons", "npm-build.md"), "---\ntrigger: npm (run )?build\non: command\nscope: all\n---\nFix: more memory.\n");
g(REPO, "add", "-A"); g(REPO, "commit", "-qm", "init");
const WT = path.join(REPO, ".worktrees", "r1-1");
g(REPO, "worktree", "add", "-q", "-b", "proteus-work/r1/1", WT, "main");
lib.run(path.join(SRC, "proteus-worktree.js"), "", { cwd: REPO, args: [WT, "src/**"] });
const COMMON = path.join(REPO, ".git"), OLD = path.join(COMMON, "proteus"), NEW = path.join(COMMON, "proteus-lead");
const H = (f) => path.join(SRC, f);
const TMPD = path.join(W, "tmp");
fs.mkdirSync(TMPD);
const TENV = { TMPDIR: TMPD, TEMP: TMPD, TMP: TMPD };
const TP = path.join(W, "lead.jsonl");
fs.writeFileSync(TP, JSON.stringify({ type: "assistant", message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "x" }], usage: { input_tokens: 1000 } } }) + "\n");

let tu = 0;
const sub = { agent_id: "a1", agent_type: "proteus-worker" };
const ev = (event, extra) => ({ hook_event_name: event, session_id: "s1", cwd: REPO, transcript_path: TP, ...extra });
const bash = (command, who = {}) => {
  const e = { tool_name: "Bash", tool_input: { command }, tool_use_id: `toolu_${++tu}`, ...who };
  lib.run(H("proteus-lead-guard.js"), ev("PreToolUse", e), { cwd: REPO, env: TENV });
  lib.run(H("proteus-scratch.js"), ev("PreToolUse", e), { cwd: REPO, env: TENV });
  lib.run(H("proteus-lessons.js"), ev("PreToolUse", e), { cwd: REPO, env: TENV });
  const post = ev("PostToolUse", { ...e, tool_response: { stdout: "", stderr: "" } });
  lib.run(H("proteus-scratch.js"), post, { cwd: REPO, env: TENV });
  return lib.run(H("proteus-shell-check.js"), post, { cwd: REPO, env: TENV });
};
// one pass over every hook and lead script that writes lead state
function drive() {
  const r = [];
  r.push(lib.run(H("proteus-autostart.js"), ev("SessionStart", { source: "startup" }), { cwd: REPO, env: { ...TENV, FAKE_GH: "fail" } }));
  r.push(lib.run(H("proteus-journal.js"), ev("UserPromptSubmit", { prompt: `merge it $(touch ${path.join(OUT, "PWNED-journal")})` }), { cwd: REPO }));
  r.push(lib.run(H("proteus-lead-guard.js"), ev("PreToolUse", { tool_name: "Agent", tool_input: { model: "sonnet", subagent_type: "proteus-worker", prompt: "x" } }), { cwd: REPO }));
  r.push(lib.run(H("proteus-lead-guard.js"), ev("PreToolUse", { tool_name: "Write", tool_input: { file_path: path.join(WT, "src", "a.js"), content: "b\n" }, ...sub }), { cwd: REPO }));
  r.push(bash("npm run build", sub));
  r.push(bash("ls"));
  r.push(lib.run(H("proteus-stall.js"), ev("SubagentStop", { ...sub, stop_hook_active: false, last_assistant_message: "Rendering. Waiting on the background render to finish." }), { cwd: REPO }));
  r.push(lib.run(H("proteus-inbox.js"), "", { cwd: REPO, args: ["--refresh"] }));
  r.push(lib.run(H("proteus-statusline.js"), { session_id: "s1", cwd: REPO, workspace: { current_dir: REPO, project_dir: REPO } }, { cwd: REPO, env: { FAKE_GH: "fail" } }));
  r.push(lib.run(H("proteus-watchdog.js"), "", { cwd: REPO }));
  r.push(lib.run(H("proteus-scratch.js"), "", { cwd: REPO, args: ["--sweep", "--stale"], env: TENV }));
  return r;
}

// a clean first pass makes every lead file and dir, so the next passes find links at real names
resetVictims();
drive();
ok("setup: the hooks wrote their state under proteus-lead", ["journal.jsonl", "visibility.json", "agents", "spawns", "beats", "inbox.json"].every((f) => has(path.join(NEW, f))),
  fs.readdirSync(NEW).join(" "));
ok("setup: and nothing of theirs under proteus", !["journal.jsonl", "visibility.json", "agents", "spawns", "beats", "inbox.json", "lead-flight.json"].some((f) => has(path.join(OLD, f))),
  has(OLD) ? fs.readdirSync(OLD).join(" ") : "");

const walk = (d) => { const out = []; for (const f of fs.readdirSync(d)) { const p = path.join(d, f); const st = fs.lstatSync(p); if (st.isDirectory()) out.push(p, ...walk(p)); else out.push(p); } return out; };
const leadFiles = () => walk(NEW).filter((p) => !fs.lstatSync(p).isDirectory() && !p.includes(`${path.sep}trash${path.sep}`));
const leadDirs = () => walk(NEW).filter((p) => fs.lstatSync(p).isDirectory() && !p.endsWith(`${path.sep}trash`));
const replaceWithLink = (p, target, type) => { fs.rmSync(p, { recursive: true, force: true }); return link(target, p, type); };

if (link(VICTIM, path.join(W, "probe-link"))) {
  // 1. every lead file, and the same name under the old dir, a link to the victim; temp names around each sprayed
  const files = leadFiles();
  const names = new Set([...L.LEAD_FILES, "lead-flight.json", "inbox.refresh", "questions-nudged", ...files.map((p) => path.relative(NEW, p))]);
  fs.mkdirSync(OLD, { recursive: true });
  for (const rel of names) {
    for (const base of [NEW, OLD]) {
      const p = path.join(base, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      replaceWithLink(p, VICTIM);
      for (let i = 1; i <= 40; i++) link(VICTIM, `${p}.${process.pid + i}.tmp`);
    }
  }
  fs.mkdirSync(path.join(COMMON, "info"), { recursive: true });
  replaceWithLink(path.join(COMMON, "info", "exclude"), VICTIM);
  let r = drive();
  ok("file links: no hook writes through a link at a lead file, its temp name or the old path", !untouched(), untouched());
  ok("file links: the hooks still exit 0 (or 2 for a refusal), never crash", r.every((x) => x.code === 0 || x.code === 1 || x.code === 2), r.map((x) => `${x.code} ${x.err.slice(0, 120)}`).join(" | "));
  fs.unlinkSync(path.join(COMMON, "info", "exclude"));

  // 2. every lead subdir swapped for a link to the victim dir (the old dir's too)
  fs.rmSync(NEW, { recursive: true, force: true });
  resetVictims();
  drive();
  for (const d of leadDirs()) replaceWithLink(d, VDIR, "dir");
  for (const d of L.LEAD_DIRS.concat("unattributed", "allow", "scratch")) replaceWithLink(path.join(OLD, d), VDIR, "dir");
  r = drive();
  ok("dir links: a lead subdir or an old state dir swapped for a link is never written through", !untouched(), untouched());

  // 3. proteus-lead itself, then proteus too, a link to the victim dir
  fs.rmSync(NEW, { recursive: true, force: true });
  fs.rmSync(OLD, { recursive: true, force: true });
  resetVictims();
  replaceWithLink(NEW, VDIR, "dir");
  drive();
  ok("parent swap: proteus-lead a link, every write refused", !untouched(), untouched());
  replaceWithLink(OLD, VDIR, "dir");
  drive();
  ok("parent swap: proteus a link as well", !untouched(), untouched());
  fs.unlinkSync(NEW); fs.unlinkSync(OLD);
  resetVictims();

  // ---- the #212 review's probes
  // noticelink: an agent-written notice in proteus/unattributed plus links at its temp names for the next pids
  drive();
  const N = path.join(OLD, "unattributed");
  fs.mkdirSync(N, { recursive: true });
  const notice = JSON.stringify({ agents: [], seq: -1, lead: {}, hooks: { SessionStart: [{ hooks: [{ type: "command", command: `touch ${path.join(OUT, "PWNED-settings")}` }] }] } }) + "\n";
  fs.writeFileSync(path.join(N, "1.json"), notice);
  const p0 = process.pid;
  for (let i = 1; i <= 3000; i++) link(VICTIM, path.join(N, `1.json.${p0 + i}.tmp`));
  const lg = lib.run(H("proteus-lead-guard.js"), ev("PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "toolu_n1" }), { cwd: REPO });
  const sc = lib.run(H("proteus-shell-check.js"), ev("PostToolUse", { tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "toolu_n1", tool_response: { stdout: "" } }), { cwd: REPO });
  ok("noticelink: the target is unchanged", !untouched(), untouched() + lg.err + sc.err);
  ok("noticelink: the agent's notice is not written back", readOr(path.join(N, "1.json")) === notice && !isLink(path.join(N, "1.json")));
  ok("noticelink: its being shown is recorded under proteus-lead", has(path.join(NEW, "unattributed-shown")) && fs.readdirSync(path.join(NEW, "unattributed-shown")).length === 1,
    has(NEW) ? fs.readdirSync(NEW).join(" ") : "");
  const list = () => lib.run(H("proteus-shell-check.js"), "", { cwd: REPO, args: ["--list"] }).out;
  const cl = lib.run(H("proteus-shell-check.js"), "", { cwd: REPO, args: ["--clear", "all"] });
  ok("noticelink: --clear hides it without touching the file", cl.code === 0 && readOr(path.join(N, "1.json")) === notice && /no notices/.test(list()), cl.out + cl.err + list());
  fs.writeFileSync(path.join(N, "1.json"), notice.replace("-1", "-2"));
  ok("noticelink: a notice rewritten under the same name is new again", !/no notices/.test(list()), list());
  fs.rmSync(N, { recursive: true, force: true });

  // journal: proteus-lead/journal.jsonl (and the old proteus/journal.jsonl) a link to a shell rc file
  for (const p of [path.join(NEW, "journal.jsonl"), path.join(OLD, "journal.jsonl")]) replaceWithLink(p, VICTIM);
  const jr = lib.run(H("proteus-journal.js"), ev("UserPromptSubmit", { prompt: `merge it $(touch ${path.join(OUT, "PWNED-journal")})` }), { cwd: REPO });
  ok("journal: a prompt is not appended through a link", jr.code === 0 && !untouched(), untouched() + jr.err);
  // the trim: a full journal is rewritten through a temp file, never through a link at its temp name
  fs.unlinkSync(path.join(NEW, "journal.jsonl"));
  fs.writeFileSync(path.join(NEW, "journal.jsonl"), Array.from({ length: 700 }, (_, i) => JSON.stringify({ ts: new Date().toISOString(), prompt: `old prompt ${i}`.padEnd(60, ".") })).join("\n") + "\n");
  for (let i = 1; i <= 200; i++) link(VICTIM, path.join(NEW, `journal.jsonl.${process.pid + i}.tmp`));
  lib.run(H("proteus-journal.js"), ev("UserPromptSubmit", { prompt: "newest" }), { cwd: REPO });
  ok("journal: the trim writes no link target", !untouched() && fs.readFileSync(path.join(NEW, "journal.jsonl"), "utf8").trim().split("\n").length === 500, untouched());
} else {
  ok("links: skipped (this system cannot create a symlink here)", true);
}

// ---- --allow: consumed entries are recorded under proteus-lead, the agent-writable allow file is never written
{
  const af = L.allowFile(WT);
  L.addAllow(WT, ["git push --force"]);
  L.addAllow(WT, ["git push --force"]);
  const text = fs.readFileSync(af, "utf8");
  const t1 = L.takeAllow(WT, "git push --force"), t2 = L.takeAllow(WT, "git push --force"), t3 = L.takeAllow(WT, "git push --force");
  ok("allow: each entry is taken once", t1 && t2 && !t3, `${t1} ${t2} ${t3}`);
  ok("allow: the allow file is never written by the guard", fs.readFileSync(af, "utf8") === text);
  ok("allow: what was taken is recorded under proteus-lead", walk(NEW).some((p) => p.includes("allow-taken")));
  if (link(VICTIM, path.join(W, "probe-link2"))) {
    fs.rmSync(af);
    link(VICTIM, af);
    fs.writeFileSync(VICTIM, text);
    ok("allow: an allow file that is a link is not read", !L.takeAllow(WT, "git push --force") && fs.readFileSync(VICTIM, "utf8") === text);
    resetVictims();
  }
}

// ---- autostart no longer appends to info/exclude; install.js --project does
{
  const ex = path.join(COMMON, "info", "exclude");
  fs.mkdirSync(path.dirname(ex), { recursive: true });
  fs.writeFileSync(ex, "# mine\n");
  lib.run(H("proteus-autostart.js"), ev("SessionStart", { source: "startup" }), { cwd: REPO, env: { ...TENV, FAKE_GH: "fail" } });
  ok("autostart: info/exclude is left alone", fs.readFileSync(ex, "utf8") === "# mine\n");
}

// ---- static: no hook writes outside the helper. A raw write call is allowed only in a function named here.
const ALLOW = {
  "proteus-lib.js:writeJSON": "the generic writer; every caller is named below",
  "proteus-lib.js:leadWrite": "the helper",
  "proteus-lib.js:leadCreate": "the helper",
  "proteus-lib.js:leadRemove": "the helper",
  "proteus-lib.js:leadTrash": "the helper",
  "proteus-lib.js:migrateLead": "the helper's one-time copy: 'wx' into a checked lead dir",
  "proteus-lib.js:addAllow": "--allow, a lead CLI run from the lead's own (sandboxed) shell, writes <common>/proteus/allow",
  "proteus-lib.js:forget": "watchdog --forget, a lead CLI run from the lead's own (sandboxed) shell, writes <common>/proteus/forgotten.json",
  "proteus-lib.js:syncText": "the session-start sync writes the checkout's .claude, not <common>",
  "proteus-lib.js:releaseCheck": "the release check's cache lives in the plugin data dir under the user's home, not <common>",
  "proteus-autostart.js:patchConfig": "~/.claude/proteus.json, the user's own config, not <common>",
  "proteus-baseline.js:verdict": "teams/baseline.json in the checkout, run by a gate command, not a hook",
  "proteus-gates-cache.js:store": "the gate cache in <common>/proteus/gates, run by a gate command in the caller's (sandboxed) shell",
  "proteus-scratch.js:removeStray": "a stray under the temp dir: inode, owner and direct-child checks before the rm",
  "proteus-scratch.js:removeScratch": "a scratch dir proteus-lead/trash cannot take (the lead's sandboxed shell): deleted in place by that shell",
  "proteus-agent-patch.js:exclude": "install.js --project only; the hook passes noExclude",
  "proteus-agent-patch.js:apply": "the generated agents in the checkout's .claude/agents, not <common>",
  "proteus-confine.js:remove": "a worker worktree's own files, sandboxed worker side",
  "proteus-confine.js:writeFile": "a worker worktree's own files, sandboxed worker side",
  "proteus-harness-claude.js:registerLead": "the checkout's .claude/settings.local.json, written by install.js",
  "proteus-harness-claude.js:allowDir": "the checkout's .claude/settings.local.json, written by install.js",
  "proteus-harness-claude.js:prepareWorker": "a worker worktree's .claude, before the worker runs",
  "proteus-harness-claude.js:exportEnv": "$CLAUDE_ENV_FILE, the harness's own env file",
  "proteus-harness-codex.js:registerLead": "the checkout's .codex/hooks.json, written by install.js",
  "proteus-harness-codex.js:sandboxRoots": "the checkout's .codex/config.toml, written by install.js",
  "proteus-harness-codex.js:exportEnv": "the checkout's .codex/config.toml, written by install.js",
  "proteus-scan.js:main": "the scan's own output dir and its temp HEAD copy, run by a gate command",
  "proteus-worktree.js:head": "a worker worktree's files, run by the lead before the worker starts",
  "proteus-worktree.js:installPreCommit": "a worker worktree's hook, run by the lead before the worker starts",
};
{
  const RAW = /\b(writeFileSync|appendFileSync|renameSync|unlinkSync|rmSync|writeJSON)\s*\(/;
  const DECL = /^(?:async\s+)?function\s+([\w$]+)|^(?:const|let)\s+([\w$]+)\s*=/;
  const seen = new Set(), bad = [];
  for (const f of fs.readdirSync(SRC).filter((x) => x.endsWith(".js"))) {
    let fn = "<top>";
    fs.readFileSync(path.join(SRC, f), "utf8").split(/\r?\n/).forEach((line, i) => {
      const m = DECL.exec(line);
      if (m) fn = m[1] || m[2];
      if (/^\s*\/\//.test(line) || /^function writeJSON\b/.test(line) || !RAW.test(line)) return;
      const key = `${f}:${fn}`;
      if (ALLOW[key]) seen.add(key); else bad.push(`${f}:${i + 1} (${fn})`);
    });
  }
  ok("static: no hook writes outside the helper unless allowlisted with a reason", !bad.length, bad.join(", "));
  const stale = Object.keys(ALLOW).filter((k) => !seen.has(k));
  ok("static: every allowlist entry is still used", !stale.length, stale.join(", "));
}

lib.summary();

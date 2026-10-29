#!/usr/bin/env node
// Scratch hygiene: every temp file a Proteus agent makes is deleted once its ticket or run is done,
// and nothing Proteus did not make is ever touched.
//   node .claude/hooks/proteus-scratch.js --path <key>       mkdir <git-common-dir>/proteus/scratch/<key>/, bump its mtime, print it
//   node .claude/hooks/proteus-scratch.js --sweep <key>      delete scratch/<key>[-*] and the strays keyed <key>[-*]
//   node .claude/hooks/proteus-scratch.js --sweep --all-done the same for every key whose branch is gone
//   node .claude/hooks/proteus-scratch.js --sweep --stale    done and idle 72h, or idle 7 days regardless (the autostart says when)
//   node .claude/hooks/proteus-scratch.js --size             MB held in scratch dirs and ledgered strays
// <key> is a ticket's <run>-<id> (its branch proteus-work/<run>/<id>) or a run's <run>.
// As a hook (lead's session, before and after every shell call, failed or not): the first snapshots the
// top-level names of os.tmpdir(); after the call a new name owned by this user and named in the command or its
// output is a stray, appended to <common>/proteus-lead/scratch-ledger.jsonl with its key (the agent's own --path,
// the proteus/* branch of its cwd, or the one open run). Deletion happens only in --sweep, only for ledgered
// paths and scratch dirs, each re-checked first: same inode, this user, directly in os.tmpdir(), a symlink
// removed as a link and never followed. A git worktree goes through `git worktree remove --force` and `prune`.
// What this script writes for itself (ledger, snapshots, size) is lead state, in proteus-lead through lib's
// lead-state writers (#236). --sweep deletes under <common>/proteus/scratch and <common>/worktrees, which agents can
// write, so it runs only from the lead's own shell, sandboxed like theirs, never from a hook (#237): a delete or
// rename by path there outside the sandbox can be pointed at any dir the user owns by a parent swapped for a link.
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const lib = require(path.join(__dirname, "proteus-lib.js"));

const DONE_IDLE = 72 * 3600e3;
const ANY_IDLE = 7 * 864e5;
const KEY = /^\w[\w.-]*$/;
const PATH_CMD = /proteus-scratch\.js["']?\s+--path\s+["']?([\w.-]+)/;
const USAGE = "usage: node proteus-scratch.js --path <key> | --sweep <key>|--all-done|--stale | --size";

const HELP = `${USAGE}
Per-ticket and per-run temp space, under <git-common-dir>/proteus/scratch/, deleted when the work is done:
  --path <key>        create (or touch) the dir for <key> and print it; use it instead of /tmp or mktemp
  --sweep <key>       delete scratch/<key> and scratch/<key>-*, plus the /tmp strays recorded under them
                      (the lead: <run>-<id> after a ticket merges, <run> at close)
  --sweep --all-done  the same for every key whose branch is gone (session start, on a scratch= note)
  --sweep --stale     done and idle 72h, or idle 7 days regardless (the session start says when there is any)
  --size              MB held in scratch dirs and recorded strays
<key> is a ticket's <run>-<id> (branch proteus-work/<run>/<id>) or a run's <run>. Only paths Proteus made are deleted.`;
const argv = process.argv.slice(2);
if (argv[0] === "--help" || argv[0] === "-h") { console.log(HELP); process.exit(0); }
if (argv.length) cli(argv);
else if (process.env.PROTEUS !== "0") lib.run(hook);

function hook(ev) {
  if (ev.tool !== "shell") return;
  const common = lib.gitCommonDir(lib.projectRoot(ev));
  if (!common) return;
  const id = String(ev.toolUseId || `${ev.session}-${ev.agent || "lead"}`).replace(/[^\w.-]/g, "_");
  const snap = lib.leadPath(common, "scratch-snap", id);
  const tmp = os.tmpdir();
  if (ev.kind === "pre-tool") {
    const names = fs.readdirSync(tmp);
    lib.leadWrite(common, snap, JSON.stringify({ tmp, names }));
    return;
  }
  if (ev.kind !== "post-tool" && ev.kind !== "tool-failed") return;
  const before = lib.readJSON(snap, null);
  try { lib.leadRemove(common, snap); } catch {}
  const cmd = ev.command;
  const who = ev.agent ? `${ev.agentType || "agent"}:${ev.agent}` : "lead";
  const file = ledgerFile(common);
  const rows = [];
  const m = PATH_CMD.exec(cmd);
  if (m && KEY.test(m[1])) rows.push({ bind: who, key: m[1], at: Date.now() });
  if (before && before.tmp === tmp && Array.isArray(before.names)) {
    const had = new Set(before.names);
    const text = `${cmd}\n${ev.error ? `${ev.output}\n${ev.error}` : ev.output}`;
    const fresh = fs.readdirSync(tmp).filter((n) => !had.has(n) && named(text, n));
    if (fresh.length) {
      const old = readLedger(file).rows;
      const uid = typeof process.getuid === "function" ? process.getuid() : null; // Windows: the temp dir is per user
      const key = (m && KEY.test(m[1]) && m[1]) || keyOf(ev, who, old, common);
      for (const name of fresh) {
        const p = path.join(tmp, name);
        let st;
        try { st = fs.lstatSync(p); } catch { continue; }
        if (uid !== null && st.uid !== uid) continue;
        if (old.some((r) => r.path === p && r.ino === st.ino)) continue;
        rows.push({ path: p, key, agent: who, at: Date.now(), ino: st.ino, worktree: !!gitdirOf(p) });
      }
    }
  }
  if (!rows.length) return;
  lib.leadAppend(common, file, rows.map((r) => JSON.stringify(r) + "\n").join(""));
}

function cli([cmd, arg]) {
  try {
    const common = lib.gitCommonDir(process.cwd());
    if (!common) throw new Error("not inside a git repo");
    if (cmd === "--path" && KEY.test(arg || "")) {
      const dir = path.join(lib.stateDir(common), "scratch", arg);
      fs.mkdirSync(dir, { recursive: true });
      const now = new Date();
      fs.utimesSync(dir, now, now);
      console.log(dir);
    } else if (cmd === "--sweep" && (arg === "--all-done" || arg === "--stale" || KEY.test(arg || ""))) {
      const r = sweep(common, arg);
      console.log(`proteus-scratch: freed ${mb(r.bytes)} MB (${r.dirs} scratch dirs, ${r.strays} strays, ${r.worktrees} worktrees); ${mb(r.left)} MB left`);
      for (const k of r.kept) console.log(`kept ${k}`);
    } else if (cmd === "--size") console.log(`${mb(size(common))} MB`);
    else { console.error(USAGE + "\n(--help explains each mode)"); process.exitCode = 1; }
  } catch (e) {
    console.error(`proteus-scratch: ${e.message}`);
    process.exitCode = 1;
  }
}

function sweep(common, what) {
  const file = ledgerFile(common);
  const { text, rows } = readLedger(file);
  const now = Date.now();
  const done = doneFn(common);
  const pick = (key, idle) => (what === "--all-done" ? done(key)
    : what === "--stale" ? idle > ANY_IDLE || (idle > DONE_IDLE && done(key))
    : key === what || key.startsWith(what + "-"));
  const out = { bytes: 0, dirs: 0, strays: 0, worktrees: 0, kept: [] };
  const prune = new Set();
  const tmpReal = real(os.tmpdir());
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const keep = [];
  for (const r of rows) {
    const key = typeof r.key === "string" ? r.key : "";
    if (r.bind !== undefined) { if (!pick(key, now - (+r.at || 0))) keep.push(r); continue; }
    if (typeof r.path !== "string") continue;
    let mt = 0;
    try { mt = fs.lstatSync(r.path).mtimeMs; } catch {}
    if (!pick(key, now - Math.max(+r.at || 0, mt))) { keep.push(r); continue; }
    const res = removeStray(r, tmpReal, uid, prune);
    if (res.keep) { keep.push(r); out.kept.push(`${r.path}: ${res.keep}`); continue; }
    if (res.bytes === undefined) continue; // gone, replaced, or not ours: dropped from the ledger untouched
    out.bytes += res.bytes;
    out.strays++;
    if (res.worktree) out.worktrees++;
  }
  const root = lib.scratchDir(common);
  for (const name of realDir(root) ? ls(root) : []) {
    const d = path.join(root, name);
    let st;
    try { st = fs.lstatSync(d); } catch { continue; }
    if (!pick(name, now - st.mtimeMs)) continue;
    const res = removeScratch(d, st, prune);
    if (res.keep) { out.kept.push(`${d}: ${res.keep}`); continue; }
    out.bytes += res.bytes;
    out.dirs++;
  }
  for (const common of prune) git(["worktree", "prune"], common);
  // from the lead's sandboxed shell the ledger stays: the next sweep drops the rows whose paths are gone
  if (keep.length !== rows.length) { try { writeLedger(common, file, text, keep); } catch {} }
  // a PreToolUse whose call never ran (denied, interrupted) leaves its snapshot behind
  const snaps = lib.leadPath(common, "scratch-snap");
  for (const f of ls(snaps)) { try { const p = path.join(snaps, f); if (now - fs.statSync(p).mtimeMs > 3600e3) lib.leadRemove(common, p); } catch {} }
  out.left = size(common, keep);
  return out;
}

// a ledgered stray: {bytes, worktree} when deleted, {keep: why} when it must stay, {} when it is dropped untouched
function removeStray(r, tmpReal, uid, prune) {
  const p = path.resolve(r.path);
  let st;
  try { st = fs.lstatSync(p); } catch { return {}; }
  if (!tmpReal || !lib.samePath(real(path.dirname(p)), tmpReal)) return { keep: "not directly in os.tmpdir()" };
  if (r.ino && st.ino !== r.ino) return {}; // replaced since: not the entry Proteus made
  if (uid !== null && st.uid !== uid) return {};
  try {
    if (st.isSymbolicLink()) { fs.unlinkSync(p); return { bytes: 0 }; } // the link, never its target
    const bytes = du(p);
    const gd = gitdirOf(p);
    if (gd && fs.existsSync(gd)) {
      if (!removeWorktree(p, prune)) return { keep: "git worktree remove failed (locked?)" };
      fs.rmSync(p, { recursive: true, force: true });
      return { bytes, worktree: true };
    }
    fs.rmSync(p, { recursive: true, force: true }); // rm never follows a symlink inside the tree
    return { bytes };
  } catch (e) { return { keep: e.code || e.message }; }
}

// a scratch dir: its worktrees (top level) go through git first, then the dir, in place (the lead's sandboxed shell)
function removeScratch(d, st, prune) {
  try {
    const link = st.isSymbolicLink();
    if (!link && !st.isDirectory()) return { keep: "not a directory" };
    const bytes = link ? 0 : du(d);
    for (const f of link ? [] : ls(d)) {
      const c = path.join(d, f);
      const gd = gitdirOf(c);
      if (gd && fs.existsSync(gd) && !removeWorktree(c, prune)) return { keep: `git worktree remove ${f} failed (locked?)` };
    }
    if (link) fs.unlinkSync(d); else fs.rmSync(d, { recursive: true, force: true }); // rm never follows a symlink inside the tree
    return { bytes };
  } catch (e) { return { keep: e.code || e.message }; }
}

// p's repo from <common>/worktrees/<id>/gitdir, never from p's own .git file, which the call that made p could
// write (#215); --force skips the status check git would otherwise run in p
function removeWorktree(p, prune) {
  const co = lib.checkoutOf(p);
  if (!co || co.gitDir === co.common || !lib.samePath(co.root, real(p))) return false;
  if (!git(["worktree", "remove", "--force", p], co.common)) return false;
  prune.add(co.common);
  return true;
}

// a key is done once its branch (proteus/<run>, proteus-work/<run>/<id>) is gone: `gh pr merge --delete-branch` drops a ticket's,
// close drops the run's. Unkeyed strays are done when no proteus/* branch is left.
function doneFn(common) {
  const branches = runBranches(common);
  return (key) => (key ? !branches.has(key) : branches.size === 0);
}

// run and worker branch names without their prefix: loose refs and packed-refs, no git call
function runBranches(common) {
  return new Set(lib.runRefs(common).map(lib.runName));
}

// the stray's key: the agent's own --path, else its cwd's proteus/* branch, else the one open run, else ""
function keyOf(ev, who, rows, common) {
  const bound = rows.filter((r) => r.bind === who).pop();
  if (bound && KEY.test(bound.key)) return bound.key;
  const b = branchOf(ev.cwd || lib.projectRoot(ev));
  if (lib.schemeOf(b) && KEY.test(lib.runName(b))) return lib.runName(b);
  const names = [...runBranches(common)];
  const runs = names.filter((b2) => !names.some((a) => a !== b2 && b2.startsWith(a + "-")));
  return runs.length === 1 ? runs[0] : "";
}

// the branch dir's checkout has out, from <common>/worktrees/<id>/HEAD (lib.branchOf, #215)
const branchOf = (dir) => lib.branchOf(dir);

// the gitdir a linked worktree's .git file points at; null for anything else
function gitdirOf(p) {
  try {
    const f = path.join(p, ".git");
    if (!fs.lstatSync(f).isFile()) return null;
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(f, "utf8"));
    return m ? path.resolve(p, m[1]) : null;
  } catch { return null; }
}

// the name as a whole path component of the command or output, not a substring of a longer name
function named(text, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w.-])${esc}($|[^\\w.-])`).test(text);
}

// bytes in scratch dirs and in the ledgered strays still present; cached for the autostart's state line
function size(common, rows) {
  const root = lib.scratchDir(common);
  let n = realDir(root) ? du(root) : 0;
  for (const r of rows || readLedger(ledgerFile(common)).rows) if (typeof r.path === "string") n += du(r.path);
  try { lib.leadJSON(common, lib.leadPath(common, "scratch-size.json"), { at: new Date().toISOString(), bytes: n }); } catch {}
  return n;
}

function du(p) {
  let st;
  try { st = fs.lstatSync(p); } catch { return 0; }
  if (!st.isDirectory()) return st.size;
  let n = 0;
  for (const f of ls(p)) n += du(path.join(p, f));
  return n;
}

function ledgerFile(common) { return lib.leadPath(common, "scratch-ledger.jsonl"); }

function readLedger(file) {
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch {}
  const rows = text.split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && typeof r === "object");
  return { text, rows };
}

// rewrite with the kept rows plus whatever a hook appended while the sweep ran
function writeLedger(common, file, old, rows) {
  let now = "";
  try { now = fs.readFileSync(file, "utf8"); } catch {}
  lib.leadWrite(common, file, rows.map((r) => JSON.stringify(r) + "\n").join("") + (now.startsWith(old) ? now.slice(old.length) : ""));
}

// git on a common dir through lib's wrapper (#215), in its main checkout when it has one; true when it worked
function git(args, common) {
  const main = lib.mainRoot(common);
  const tree = main && fs.existsSync(main) ? { cwd: main, workTree: main } : {};
  try { lib.gitRun(common, args, { ...tree, stdio: "ignore", timeout: 60000 }); return true; } catch { return false; }
}

function ls(d) { try { return fs.readdirSync(d); } catch { return []; } }
function real(p) { try { return fs.realpathSync(p); } catch { return null; } }
function realDir(p) { try { const st = fs.lstatSync(p); return st.isDirectory() && !st.isSymbolicLink(); } catch { return false; } }
function mb(n) { return (n / 1048576).toFixed(1); }

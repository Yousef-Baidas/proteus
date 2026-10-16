#!/usr/bin/env node
// #48 part B, layer 2: what a subagent's shell call changed, judged after the call. lib.agentShellDenial reads the
// command line before it runs, so it cannot see `$VAR`, `$(...)`, globs, or a write by an interpreter
// (`python -c`, `node -e`, a build script). This one compares the files themselves.
// Before each subagent shell call (snapshot(ev), from the lead guard and the worker guard, after their checks pass)
// it records a fingerprint of the paths the guards protect, in every checkout of the repo: .claude (minus agent
// memory and nested checkouts), .codex, .agents, .github/workflows and actions, teams/templates/hooks, lefthook
// config, a linked worktree's .git file; the shared .git/hooks, .git/info, .git/config ([branch] sections aside)
// and the guard's records; and the CLIs' own settings, hooks, agents, skills and rules in the home. Each file is
// its mode and a content hash (cached by size, mtime and inode in <state>/guard-hash.json, so a call hashes only
// what changed); settings JSON is compared without its `permissions`. It also keeps `git status --porcelain` of
// every other prepared worktree whose agent is idle.
// After the call (PostToolUse, this script as a hook) it compares. A guarded path that changed counts unless git
// explains it: in a checkout, the path is clean now, was tracked before if it existed, and any commit HEAD moved
// over that touches it is already on a protected remote branch (main, master, proteus/*, hive/*). A change in
// another checkout whose own agent is running, or ran a call meanwhile, is left to that agent. A new or further
// change in an idle sibling worktree counts too. Anything that counts is recorded in <state>/tamper/<agent>.json
// with each path's state before, and the call is answered with a block naming the paths: the agent must put them
// back. Every later shell call of that agent re-checks them and blocks again while any differs from its state
// before, and proteus-signoff.js refuses MERGE on the agent's branch while one does. Records are never deleted;
// deleting one is itself a change this check catches.
// Accepted residuals: see enforcement.md (layer 2).
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const lib = require(path.join(__dirname, "proteus-lib.js"));

const MAX_ENTRIES = 8000;
const MAX_HASH = 4 << 20;
const FLIGHT_MAX = 3600e3; // a call older than this left its marker behind (denied after the snapshot, or killed)
const PROTECTED = ["main", "master", "proteus/*", "hive/*"].map((b) => `--remotes=*/${b}`);

const flightDir = (common) => path.join(lib.stateDir(common), "guard-flight");
const tamperDir = (common) => path.join(lib.stateDir(common), "tamper");
const snapFile = (common, id) => path.join(lib.stateDir(common), "scratch-snap", `${id}.guard`);
const callId = (ev) => String(ev.toolUseId || `${ev.session}-${ev.agent || "worker"}`).replace(/[^\w.-]/g, "_");
const whoKey = (ev) => (ev.agent ? `agent-${ev.agent}` : `session-${ev.session || "unknown"}`).replace(/[^\w.-]/g, "_");
const slash = (p) => p.split(path.sep).join("/");

// ---- the fingerprint

// the dirs and files to walk: [abs, kind] where kind is "checkout" (relative to a checkout root), "common", "home"
function targets(common) {
  const roots = [...new Set([lib.mainRoot(common), ...lib.registeredWorktrees(common)].flatMap((r) => (r ? [lib.realOr(r)] : [])))];
  const out = [];
  for (const r of roots) {
    for (const d of [".claude", ".codex", ".agents", ".github/workflows", ".github/actions", "teams/templates/hooks"]) out.push([path.join(r, d), r]);
    if (lib.isLinked(r)) out.push([path.join(r, ".git"), r]); // a linked worktree's pointer file; the main .git is the common dir
    for (const dir of [r, path.join(r, ".config")]) {
      try { for (const n of fs.readdirSync(dir)) if (/^\.?lefthook/i.test(n)) out.push([path.join(dir, n), r]); } catch {}
    }
  }
  const c = lib.realOr(common);
  for (const d of ["hooks", "info", "config", path.join("proteus", "tamper")]) out.push([path.join(c, d), "common"]);
  const home = os.homedir();
  const codex = process.env.CODEX_HOME || path.join(home, ".codex");
  for (const d of [".claude/settings.json", ".claude/hooks", ".claude/agents", ".claude/skills", ".agents"]) out.push([path.join(home, d), "home"]);
  for (const d of ["config.toml", "hooks.json", "hooks", "agents", "rules"]) out.push([path.join(codex, d), "home"]);
  return { roots, out };
}

const statKey = (st) => `${st.size}:${Math.round(st.mtimeMs)}:${st.ino}`;
function hashOf(abs, st, cache, dirty) {
  const k = statKey(st), hit = cache[abs];
  if (hit && hit[0] === k) return hit[1];
  let h = "s" + k;
  if (st.size <= MAX_HASH) {
    try {
      let buf = fs.readFileSync(abs);
      const base = path.basename(abs);
      if (/^settings(?:\.local)?\.json$/.test(base)) {
        try { const j = JSON.parse(buf.toString("utf8")); if (j && typeof j === "object") delete j.permissions; buf = Buffer.from(JSON.stringify(j)); } catch {}
      } else if (base === "config" && path.basename(path.dirname(abs)) !== "hooks") {
        // git config: git push -u and branch moves rewrite [branch "..."] sections
        buf = Buffer.from(buf.toString("utf8").replace(/^\s*\[branch\s+"[^"]*"\][^[]*/gim, ""));
      }
      h = crypto.createHash("sha1").update(buf).digest("hex");
    } catch {}
  }
  cache[abs] = [k, h];
  dirty.n++;
  return h;
}

// abs -> "f:<mode>:<hash>" | "l:<target>"; directories are walked, not recorded
function walk(abs, out, cache, dirty, top = true) {
  if (out.size >= MAX_ENTRIES) return;
  let st;
  try { st = fs.lstatSync(abs); } catch { return; }
  if (st.isSymbolicLink()) { let t = ""; try { t = fs.readlinkSync(abs); } catch {} out.set(abs, "l:" + t); return; }
  if (st.isFile()) { out.set(abs, `f:${(st.mode & 0o7777).toString(8)}:${hashOf(abs, st, cache, dirty)}`); return; }
  if (!st.isDirectory()) return;
  const name = path.basename(abs);
  // agent memory is the agents' to write; a nested checkout (Claude Code's own worktrees, a cloned skill) has its own git
  if (name.startsWith("agent-memory") || (!top && fs.existsSync(path.join(abs, ".git")))) return;
  let names;
  try { names = fs.readdirSync(abs).sort(); } catch { return; }
  for (const n of names) walk(path.join(abs, n), out, cache, dirty, false);
}

function fingerprint(common) {
  const cacheFile = path.join(lib.stateDir(common), "guard-hash.json");
  const cache = lib.readJSON(cacheFile, {}) || {};
  const dirty = { n: 0 };
  const { roots, out } = targets(common);
  const entries = new Map(), where = {};
  for (const [abs, kind] of out) {
    const before = entries.size;
    walk(abs, entries, cache, dirty);
    if (entries.size > before) where[abs] = kind;
  }
  if (dirty.n) {
    // drop paths no longer present, so the cache stays the size of the fingerprint
    for (const k of Object.keys(cache)) if (!entries.has(k)) delete cache[k];
    try { lib.writeJSON(cacheFile, cache); } catch {}
  }
  return { roots, entries: Object.fromEntries(entries) };
}

// the checkout root abs lies in, from roots; "" for the shared .git and the home
function rootOf(abs, roots) {
  let best = "";
  for (const r of roots) if ((abs === r || abs.startsWith(r + path.sep)) && r.length > best.length) best = r;
  return best;
}

// HEAD's commit for a checkout, read from files (no git call): .git (dir or gitdir file), HEAD, a loose ref or packed-refs
function headOf(root, common) {
  try {
    let gd = path.join(root, ".git");
    if (fs.statSync(gd).isFile()) gd = path.resolve(root, /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(gd, "utf8"))[1]);
    const head = fs.readFileSync(path.join(gd, "HEAD"), "utf8").trim();
    const m = /^ref:\s*(.+)$/.exec(head);
    if (!m) return head;
    for (const d of [gd, common]) { try { return fs.readFileSync(path.join(d, m[1]), "utf8").trim(); } catch {} }
    const packed = fs.readFileSync(path.join(common, "packed-refs"), "utf8");
    const p = new RegExp(`^([0-9a-f]{40}) ${m[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").exec(packed);
    return p ? p[1] : "";
  } catch { return ""; }
}

// ---- who is working where

function flights(common, except) {
  const dir = flightDir(common), now = Date.now(), out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const n of names) {
    const f = path.join(dir, n);
    const m = lib.readJSON(f, null);
    if (!m || now - m.at > FLIGHT_MAX) { try { if (now - fs.statSync(f).mtimeMs > FLIGHT_MAX) fs.unlinkSync(f); } catch {} continue; }
    if (n !== `${except}.json`) out.push(m);
  }
  return out;
}

// prepared worktree (real path) -> the agents bound to it
function boundAgents(common) {
  const dir = path.join(lib.stateDir(common), "agents"), out = new Map();
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const n of names) {
    let wt = "";
    try { wt = lib.realOr(fs.readFileSync(path.join(dir, n), "utf8").trim()); } catch { continue; }
    if (!out.has(wt)) out.set(wt, []);
    out.get(wt).push(n.replace(/^agent-/, ""));
  }
  return out;
}

// a worktree whose agent is running a call, or ran one at or after `since` (its beat), is that agent's to judge
function busy(wt, since, fl, agents, common) {
  if (fl.some((m) => m.own && lib.realOr(m.own) === wt)) return true;
  for (const a of agents.get(wt) || []) {
    const b = lib.readJSON(path.join(lib.beatsDir(common), `${a.replace(/[^\w.-]/g, "_")}.json`), null);
    if (b && Date.parse(b.last) >= since) return true;
  }
  return false;
}

const gitAsync = (args, cwd) => new Promise((resolve) => {
  execFile("git", args, { cwd, encoding: "utf8", timeout: 5000, maxBuffer: 16 << 20, windowsHide: true }, (err, out) => resolve(err ? null : out));
});
// a worktree's porcelain lines, each with the size and mtime of the file now, so a further edit to a dirty file shows
async function porcelain(wt) {
  const out = await gitAsync(["--no-optional-locks", "status", "--porcelain=v1", "-z", "-unormal"], wt);
  if (out === null) return null;
  const lines = [];
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const l = parts[i];
    if (!l) continue;
    if (/^[RC]/.test(l)) i++; // a rename's source follows
    let s = "-";
    try { const st = fs.lstatSync(path.join(wt, l.slice(3))); s = `${st.size}:${Math.round(st.mtimeMs)}`; } catch {}
    lines.push(`${l} ${s}`);
  }
  return lines.sort();
}

// ---- before the call

// own: the agent's worktree (its cwd's prepared worktree, else its binding; a worker session's own checkout)
function ownOf(ev, common) {
  const cwd = lib.shellCwd(ev);
  if (!ev.agent) return lib.gitRoot(cwd) || lib.projectRoot(ev);
  return lib.cwdWorktree(cwd, common) || lib.bound(common, ev.agent) || "";
}

async function snapshot(ev) {
  const common = lib.gitCommonDir(lib.projectRoot(ev));
  if (!common || ev.tool !== "shell") return;
  const id = callId(ev), at = Date.now();
  const own = lib.realOr(ownOf(ev, common) || lib.projectRoot(ev));
  const marker = { id, key: whoKey(ev), agent: ev.agent || "", own, at };
  lib.writeJSON(path.join(flightDir(common), `${id}.json`), marker);
  const fl = flights(common, id), agents = boundAgents(common);
  const fp = fingerprint(common);
  const heads = Object.fromEntries(fp.roots.map((r) => [r, headOf(r, common)]));
  const sibs = fp.roots.filter((r) => r !== own && lib.isLinked(r) && fs.existsSync(lib.ownedFile(r)) && !busy(r, at, fl, agents, common));
  const st = await Promise.all(sibs.map(porcelain));
  const siblings = Object.fromEntries(sibs.flatMap((r, i) => (st[i] ? [[r, st[i]]] : [])));
  lib.writeJSON(snapFile(common, id), { ...marker, roots: fp.roots, entries: fp.entries, heads, siblings });
}

// ---- after the call

// which of the changed paths of checkout root git explains (see the header)
function explained(root, rels, before, oldHead, newHead) {
  const ok = new Set();
  if (!rels.length) return ok;
  const specs = rels.map((r) => `:(literal)${r}`);
  const st = lib.git(["--no-optional-locks", "status", "--porcelain=v1", "-z", "--ignored=matching", "-uall", "--", ...specs], root, 10000);
  const dirtyNow = new Set();
  const parts = st.split("\0");
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    dirtyNow.add(parts[i].slice(3).replace(/\/$/, ""));
    if (/^[RC]/.test(parts[i])) dirtyNow.add(parts[++i]);
  }
  const isDirty = (r) => [...dirtyNow].some((d) => r === d || r.startsWith(d + "/"));
  const inOld = oldHead ? new Set(lib.git(["ls-tree", "-r", "--name-only", "-z", oldHead, "--", ...specs], root, 10000).split("\0").filter(Boolean)) : new Set();
  for (const r of rels) {
    if (isDirty(r)) continue;
    if (before(r) && !inOld.has(r)) continue; // an untracked or ignored file went away or changed
    if (oldHead !== newHead) {
      if (!oldHead || !newHead) continue;
      const own = lib.git(["rev-list", "-1", newHead, "--not", oldHead, ...PROTECTED, "--", `:(literal)${r}`], root, 10000);
      if (own) continue; // a commit not on a protected branch changed it
    }
    ok.add(r);
  }
  return ok;
}

// the paths, from before (abs -> entry) to now, that changed; [abs, before entry or null]
function changes(before, now) {
  const out = [];
  for (const [abs, e] of Object.entries(before)) if (now[abs] !== e) out.push([abs, e]);
  for (const abs of Object.keys(now)) if (!(abs in before)) out.push([abs, null]);
  return out;
}

const entryNow = (abs) => {
  const m = new Map();
  walk(abs, m, {}, { n: 0 }, false);
  return m.get(abs) || null;
};

// a record's items that still differ from their state before
async function unrestored(rec) {
  const left = [];
  for (const it of rec.items || []) {
    if (it.kind === "sibling") {
      const now = await porcelain(it.worktree);
      if (now && it.lines.some((l) => now.includes(l))) left.push(it);
    } else if (it.kind === "snapshot") {
      if (!it.reported) left.push(it);
    } else if (it.record || entryNow(it.path) !== (it.before ?? null)) left.push(it); // a deleted record stays: what it held is gone
  }
  return left;
}

const shown = (it) => (it.kind === "sibling" ? `${slash(it.worktree)} (${it.lines.map((l) => l.replace(/ \S+$/, "").slice(3)).slice(0, 5).join(", ")})` : it.kind === "snapshot" ? "the guard's snapshot of the call" : it.record ? `${slash(it.path)} (deleted; only the lead clears it)` : slash(it.path));
const MSG = (items, again) => `proteus: ${again ? "paths the guard protects still differ from their state before your earlier shell call" : "this shell call changed paths the guard protects"}: ${items.map(shown).slice(0, 12).join("; ")}${items.length > 12 ? `; and ${items.length - 12} more` : ""}. They hold Proteus's hooks, gates, git internals, CLI settings or another worker's worktree, and are never a worker's. Put each back as it was now (\`git checkout -- <path>\` for a tracked file; recreate or delete what the call added or removed), then go on with the ticket. Until they match, a verifier cannot sign off MERGE on your branch. If you need one changed, comment "NEEDS <path>: <why>" on the issue and stop.`;

function branchOf(wt) {
  return lib.git(["rev-parse", "--abbrev-ref", "HEAD"], wt) || "";
}

async function check(ev, ad) {
  if (ev.tool !== "shell") return;
  const common = lib.gitCommonDir(lib.projectRoot(ev));
  if (!common) return;
  let id = callId(ev);
  const key = whoKey(ev);
  // the CLI names the call in both events; if it did not, this agent's newest snapshot is the one
  if (!fs.existsSync(snapFile(common, id))) {
    const mine = flights(common, "").filter((m) => m.key === key && fs.existsSync(snapFile(common, m.id))).sort((a, b) => b.at - a.at)[0];
    if (mine) id = mine.id;
  }
  const snap = lib.readJSON(snapFile(common, id), null);
  try { fs.unlinkSync(snapFile(common, id)); } catch {}
  try { fs.unlinkSync(path.join(flightDir(common), `${id}.json`)); } catch {}
  const recFile = path.join(tamperDir(common), `${key}.json`);
  const rec = lib.readJSON(recFile, null);
  const items = [];
  if (!snap) {
    // the guards snapshot every subagent shell call they let through; a missing one was removed during the call
    if (ev.agent && fs.existsSync(path.join(lib.stateDir(common), "guard-flight"))) items.push({ kind: "snapshot" });
  } else {
    const fl = flights(common, id), agents = boundAgents(common);
    const fp = fingerprint(common);
    const roots = new Set(fp.roots);
    const registered = new Set(lib.registeredWorktrees(common));
    const byRoot = new Map();
    const putBack = new Map(((rec && rec.items) || []).filter((i) => i.kind === "path").map((i) => [i.path, i.before ?? null]));
    for (const [abs, before] of changes(snap.entries, fp.entries)) {
      const top = rootOf(abs, [...snap.roots, ...fp.roots]); // the innermost: worktrees sit inside the main checkout
      // a worktree the lead added during the call, or removed with git worktree remove, is the lead's
      if (top && (!snap.roots.includes(top) || (!roots.has(top) && !registered.has(top)))) continue;
      // git never tracks .git (the main checkout's common dir, a linked one's pointer file), so it explains nothing there
      const root = top && path.relative(top, abs).split(path.sep)[0] === ".git" ? "" : top;
      const tamper = path.join(lib.realOr(common), "proteus", "tamper") + path.sep;
      if (abs.startsWith(tamper)) {
        // the hooks write records; only a deleted one counts, and it stays on the record until the lead clears it
        if (!fp.entries[abs]) items.push({ kind: "path", path: abs, before, record: true });
        continue;
      }
      if (putBack.get(abs) === (fp.entries[abs] ?? null)) continue; // an earlier change being undone
      if (root && root !== snap.own && busy(root, snap.at, fl, agents, common)) continue;
      if (!root) { items.push({ kind: "path", path: abs, before }); continue; }
      if (!byRoot.has(root)) byRoot.set(root, []);
      byRoot.get(root).push([abs, before]);
    }
    for (const [root, list] of byRoot) {
      const rel = (abs) => slash(path.relative(root, abs));
      const old = new Map(list.map(([abs, b]) => [rel(abs), b]));
      const ok = explained(root, [...old.keys()], (r) => old.get(r), snap.heads[root] || "", headOf(root, common));
      for (const [abs, before] of list) if (!ok.has(rel(abs))) items.push({ kind: "path", path: abs, before });
    }
    const sibs = Object.keys(snap.siblings || {}).filter((r) => fs.existsSync(r) && !busy(r, snap.at, fl, agents, common));
    const now = await Promise.all(sibs.map(porcelain));
    sibs.forEach((r, i) => {
      if (!now[i]) return;
      const had = new Set(snap.siblings[r]);
      const lines = now[i].filter((l) => !had.has(l));
      if (lines.length) items.push({ kind: "sibling", worktree: r, lines });
    });
  }
  // earlier items still not put back, then this call's (a path already on the record keeps its first state before)
  const left = rec ? await unrestored(rec) : [];
  const seen = new Set(left.filter((i) => i.path).map((i) => i.path));
  const fresh = items.filter((i) => !(i.path && seen.has(i.path)));
  if (!fresh.length && !left.length) {
    if (rec && rec.open) lib.writeJSON(recFile, { ...rec, open: false, items: [], closed: new Date().toISOString(), history: [...(rec.history || []), ...(rec.items || [])].slice(-200) });
    return;
  }
  const own = (snap && snap.own) || (rec && rec.worktree) || ownOf(ev, common);
  const all = [...left.map((i) => (i.kind === "snapshot" ? { ...i, reported: true } : i)), ...fresh.map((i) => (i.kind === "snapshot" ? { ...i, reported: true } : i))];
  lib.writeJSON(recFile, {
    key, agent: ev.agent || "", session: ev.session || "", worktree: own, branch: (rec && rec.branch) || (own ? branchOf(own) : ""),
    open: true, at: (rec && rec.open && rec.at) || new Date().toISOString(), items: all, history: (rec && rec.history) || [],
  });
  const msg = MSG(fresh.length ? fresh : left, !fresh.length);
  if (ev.kind === "tool-failed") ad.context(ev, msg);
  else ad.postBlock(ev, msg);
}

// open records for a branch: each re-checked, so a record edited to open:false with its paths still changed counts
async function openFor(common, branch) {
  const dir = tamperDir(common), out = [];
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".json")); } catch { return out; }
  for (const n of names) {
    const rec = lib.readJSON(path.join(dir, n), null);
    if (!rec || rec.branch !== branch) continue;
    const left = await unrestored({ items: (rec.items || []).filter((i) => i.kind !== "snapshot") });
    if (left.length || (rec.open && (rec.items || []).some((i) => i.kind === "snapshot"))) out.push({ ...rec, left: left.length ? left : rec.items });
  }
  return out;
}

module.exports = { snapshot, check, openFor, fingerprint, tamperDir, MSG };

if (require.main === module && process.env.PROTEUS !== "0") lib.run(check);

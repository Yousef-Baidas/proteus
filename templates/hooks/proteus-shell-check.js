#!/usr/bin/env node
// #48 part B, layer 2: what a subagent's shell call changed, judged after the call. lib.agentShellDenial reads the
// command line before it runs, so it cannot see `$VAR`, `$(...)`, globs, or a write by an interpreter
// (`python -c`, `node -e`, a build script). This one compares the files themselves.
// Before each subagent shell call (snapshot(ev), from the lead guard and the worker guard, after their checks pass)
// it records a fingerprint of the paths the guards protect, in every checkout of the repo: .claude (minus agent
// memory and nested checkouts), .codex, .agents, .github/workflows and actions, teams/templates/hooks, lefthook
// config, a linked worktree's .git file; the shared .git/hooks, .git/info, the git config files and the guard's
// records and notices; and the CLIs' own settings, hooks, agents, skills and rules in the home, the plugin's own folder (CLAUDE_PLUGIN_ROOT), and the verifier App's key. Each file is its
// mode and a content hash (cached by size, mtime and inode in <state>/guard-hash.json, so a call hashes only what
// changed); settings JSON is compared without its `permissions`. A git config file (.git/config, config.worktree)
// is compared by key and value, without the keys an agent may set (ALLOWED_KEY, and its own branch's upstream).
// It also keeps `git status --porcelain` of every other prepared worktree whose agent is idle.
// After the call (PostToolUse, this script as a hook) it compares. A guarded path that changed counts unless git
// explains it: in a checkout, the path is clean now, was tracked before if it existed, and any commit HEAD moved
// over that touches it is already on a protected remote branch (main, master, a run branch). A change in
// another checkout whose own agent is running, or ran a call meanwhile, is left to that agent. A new or further
// change in an idle sibling worktree counts too. Anything that counts is recorded in <state>/tamper/<agent>.json
// with each path's state before, and the call is answered with a block naming the paths: the agent must put them
// back. Every later shell call of that agent re-checks them and blocks again while any differs from its state
// before, and proteus-signoff.js refuses MERGE on the agent's branch while one does. Records are never deleted;
// deleting one is itself a change this check catches.
// The lead's own shell calls are windows in <state>/lead-flight.json (leadStart from the lead guard, closed here on
// the lead's PostToolUse). What changed while a lead call overlapped an agent's call cannot be pinned on either:
// it becomes a notice in <state>/unattributed/<seq>.json, shown to the lead after its call, instead of a block and
// a record. The lead's PostToolUse also re-baselines: the agents' calls in flight compare against the state after
// the lead's call, and an open record's path the lead's call changed takes that state as its state before.
// The session-start sync is a lead window too (leadRun, from proteus-autostart.js). An agent's calls end with it:
// its SubagentStop (closeAgent, from proteus-stall.js) drops their markers and snapshots, and a call silent for
// the watchdog's idle window counts as no longer in flight.
//   node <hooks>/proteus-shell-check.js --list | --clear <seq>|all   (the lead reads and clears the notices)
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
const LEAD_MAX = 15 * 60e3; // a lead window never closed (its call denied by a later hook) ends after this
const STALE = 40 * 60e3; // proteus-watchdog.js's default --idle: a call this old is not in flight (its agent died)
const NOTICE_CAP = 4000; // characters of paths in one notice
// lead commands that rewrite guarded paths themselves: named in a notice as the likely cause
const CAUSES = [[/\binstall\.js\b/, "install.js"], [/\bproteus-shell-check\.js\b/, "proteus-shell-check.js"]];
const SYNC = "the session-start sync";
// the remote branches whose commits are reviewed: main, master and every run branch, current or legacy (lib.SCHEMES)
const PROTECTED = ["main", "master", ...lib.SCHEMES.map((s) => `${s.branch}*`)].map((b) => `--remotes=*/${b}`);
// git config keys an agent may set anywhere: its identity, colours, line endings, the file mode bit, per-worktree config
const ALLOWED_KEY = /^(?:user\.|color\.|core\.autocrlf$|core\.filemode$|extensions\.worktreeconfig$)/;
// and its own branch's upstream (git push -u, branch --set-upstream-to)
const BRANCH_KEY = /^branch\.(.+)\.(remote|merge|description|pushremote)$/;

const flightDir = (common) => path.join(lib.stateDir(common), "guard-flight");
const tamperDir = (common) => path.join(lib.stateDir(common), "tamper");
const noticeDir = (common) => path.join(lib.stateDir(common), "unattributed");
const leadFile = (common) => path.join(lib.stateDir(common), "lead-flight.json");
const snapDir = (common) => path.join(lib.stateDir(common), "scratch-snap");
const snapFile = (common, id) => path.join(snapDir(common), `${id}.guard`);
const callId = (ev) => String(ev.toolUseId || `${ev.session}-${ev.agent || "worker"}`).replace(/[^\w.-]/g, "_");
const whoKey = (ev) => (ev.agent ? `agent-${ev.agent}` : `session-${ev.session || "unknown"}`).replace(/[^\w.-]/g, "_");
const slash = (p) => p.split(path.sep).join("/");
const under = (abs, dir) => abs.startsWith(dir + path.sep);

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
  for (const d of ["hooks", "info", "config", "config.worktree", path.join("proteus", "tamper"), path.join("proteus", "unattributed"), path.join("proteus", "allow")]) out.push([path.join(c, d), "common"]);
  try { for (const n of fs.readdirSync(path.join(c, "worktrees"))) out.push([path.join(c, "worktrees", n, "config.worktree"), "common"]); } catch {}
  const home = os.homedir();
  const codex = process.env.CODEX_HOME || path.join(home, ".codex");
  for (const d of ["settings.json", "hooks", "agents", "skills"]) out.push([path.join(lib.claudeDir(), d), "home"]);
  out.push([path.join(home, ".agents"), "home"]);
  for (const d of ["config.toml", "hooks.json", "hooks", "agents", "rules"]) out.push([path.join(codex, d), "home"]);
  // the plugin's own folder (CLAUDE_PLUGIN_ROOT), less a git clone's .git
  const plug = lib.pluginAnchor(common);
  if (plug) { try { for (const n of fs.readdirSync(plug)) if (n !== ".git") out.push([path.join(lib.realOr(plug), n), "home"]); } catch {} }
  const app = lib.verifierApp();
  if (app) out.push([app.keyPath, "home"]); // the verifier App's key, wherever the human keeps it
  return { roots, out };
}

// a git config file: a git dir's config (it has HEAD and objects beside it) or a config.worktree
function isConfig(abs) {
  const base = path.basename(abs), dir = path.dirname(abs);
  if (base === "config.worktree") return true;
  return base === "config" && fs.existsSync(path.join(dir, "HEAD")) && fs.existsSync(path.join(dir, "objects"));
}

// "c:" + the file's [key, values] pairs without the keys anyone may set, in order; "f:" + a hash if git cannot read it
function configEntry(abs) {
  const out = lib.git(["config", "--file", abs, "--no-includes", "--list", "-z"], path.dirname(abs), 5000);
  let size = 0;
  try { size = fs.statSync(abs).size; } catch { return null; } // gone since the walk: deleted
  if (!out && size > 0) {
    let h = "";
    try { h = crypto.createHash("sha1").update(fs.readFileSync(abs)).digest("hex"); } catch {}
    return "f:config:" + h;
  }
  const keys = new Map();
  for (const rec of out.split("\0")) {
    if (!rec) continue;
    const nl = rec.indexOf("\n");
    const k = nl < 0 ? rec : rec.slice(0, nl), v = nl < 0 ? "" : rec.slice(nl + 1);
    if (ALLOWED_KEY.test(k)) continue;
    keys.set(k, keys.has(k) ? `${keys.get(k)}\n${v}` : v);
  }
  return "c:" + JSON.stringify([...keys].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
}
const configMap = (e) => {
  try { return e && e.startsWith("c:") ? new Map(JSON.parse(e.slice(2))) : new Map(); } catch { return new Map(); }
};

const statKey = (st) => `${st.size}:${Math.round(st.mtimeMs)}:${st.ino}`;
function hashOf(abs, st, cache, dirty) {
  const k = statKey(st), hit = cache[abs];
  if (hit && hit[0] === k) return hit[1];
  let h = "s" + k;
  if (st.size <= MAX_HASH) {
    try {
      let buf = fs.readFileSync(abs);
      if (/^settings(?:\.local)?\.json$/.test(path.basename(abs))) {
        try { const j = JSON.parse(buf.toString("utf8")); if (j && typeof j === "object") delete j.permissions; buf = Buffer.from(JSON.stringify(j)); } catch {}
      }
      h = crypto.createHash("sha1").update(buf).digest("hex");
    } catch {}
  }
  cache[abs] = [k, h];
  dirty.n++;
  return h;
}

// abs -> "f:<mode>:<hash>" | "l:<target>" | "c:<config keys>"; directories are walked, not recorded
function walk(abs, out, cache, dirty, top = true) {
  if (out.size >= MAX_ENTRIES) return;
  let st;
  try { st = fs.lstatSync(abs); } catch { return; }
  if (st.isSymbolicLink()) { let t = ""; try { t = fs.readlinkSync(abs); } catch {} out.set(abs, "l:" + t); return; }
  if (st.isFile() && isConfig(abs)) {
    const k = "cfg:" + statKey(st), hit = cache[abs];
    if (hit && hit[0] === k) { out.set(abs, hit[1]); return; }
    const e = configEntry(abs);
    if (e === null) return;
    cache[abs] = [k, e];
    dirty.n++;
    out.set(abs, e);
    return;
  }
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
  const entries = new Map();
  for (const [abs] of out) walk(abs, entries, cache, dirty);
  if (dirty.n) {
    // drop paths no longer present, so the cache stays the size of the fingerprint
    for (const k of Object.keys(cache)) if (!entries.has(k)) delete cache[k];
    try { lib.writeJSON(cacheFile, cache); } catch {}
  }
  return { roots, entries: Object.fromEntries(entries) };
}

const entryNow = (abs) => {
  const m = new Map();
  walk(abs, m, {}, { n: 0 }, false);
  return m.get(abs) || null;
};

// the checkout root abs lies in, from roots; "" for the shared .git and the home
function rootOf(abs, roots) {
  let best = "";
  for (const r of roots) if ((abs === r || abs.startsWith(r + path.sep)) && r.length > best.length) best = r;
  return best;
}

// a checkout's git dir: .git, or where a linked worktree's .git file points
function gitDirOf(root) {
  const gd = path.join(root, ".git");
  if (fs.statSync(gd).isFile()) return path.resolve(root, /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(gd, "utf8"))[1]);
  return gd;
}

// HEAD's commit for a checkout, read from files (no git call): HEAD, a loose ref or packed-refs
function headOf(root, common) {
  try {
    const gd = gitDirOf(root);
    const head = fs.readFileSync(path.join(gd, "HEAD"), "utf8").trim();
    const m = /^ref:\s*(.+)$/.exec(head);
    if (!m) return head;
    for (const d of [gd, common]) { try { return fs.readFileSync(path.join(d, m[1]), "utf8").trim(); } catch {} }
    const packed = fs.readFileSync(path.join(common, "packed-refs"), "utf8");
    const p = new RegExp(`^([0-9a-f]{40}) ${m[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").exec(packed);
    return p ? p[1] : "";
  } catch { return ""; }
}

// the branch a checkout has checked out, "" when detached or unknown
function branchName(root) {
  try {
    const m = /^ref:\s*refs\/heads\/(.+?)\s*$/.exec(fs.readFileSync(path.join(gitDirOf(root), "HEAD"), "utf8"));
    return m ? m[1] : "";
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
    if (!m || now - m.at > STALE) { try { if (now - fs.statSync(f).mtimeMs > FLIGHT_MAX) fs.unlinkSync(f); } catch {} continue; }
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

// ---- the lead's own calls

// {seq, windows: [{seq, id, start, end}]}: the lead's shell calls of the last FLIGHT_MAX, end null while one runs
function readLead(common) {
  const f = lib.readJSON(leadFile(common), null);
  return f && Array.isArray(f.windows) ? f : { seq: (f && +f.seq) || 0, windows: [] };
}

function openWindow(common, id, cause) {
  const now = Date.now(), lf = readLead(common);
  lf.seq = (+lf.seq || 0) + 1;
  const w = { seq: lf.seq, id, start: now, end: null };
  if (cause) w.cause = cause;
  lf.windows = [...lf.windows.filter((x) => (x.end ?? x.start + LEAD_MAX) > now - FLIGHT_MAX), w];
  lib.writeJSON(leadFile(common), lf);
  return w;
}

// the lead guard, before a lead shell call it lets through
function leadStart(ev) {
  const common = lib.gitCommonDir(lib.projectRoot(ev));
  if (!common || ev.tool !== "shell") return;
  openWindow(common, callId(ev), (CAUSES.find(([re]) => re.test(ev.command || "")) || [])[1]);
}

// proteus-autostart.js: the session-start sync as a lead window; returns the notices to show the lead
async function leadRun(ev, fn) {
  let common = "", w = null;
  try {
    common = lib.gitCommonDir(lib.projectRoot(ev));
    if (common) w = openWindow(common, `start-${ev.session || "unknown"}-${Date.now()}`.replace(/[^\w.-]/g, "_"), SYNC);
  } catch {}
  try { fn(); } catch {}
  return w ? leadEnd(common, w) : "";
}

// an agent's SubagentStop (proteus-stall.js, once the stop passes): its calls are over, so no later lead call
// overlaps them; their markers and snapshots go
function closeAgent(ev) {
  const common = lib.gitCommonDir(lib.projectRoot(ev));
  if (!common || !ev.agent) return;
  const key = whoKey(ev);
  for (const [dir, ext] of [[flightDir(common), ".json"], [snapDir(common), ".guard"]]) {
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith(ext)); } catch {}
    for (const n of names) {
      const f = path.join(dir, n), m = lib.readJSON(f, null);
      if (m && m.key === key) try { fs.unlinkSync(f); } catch {}
    }
  }
}

// the lead's windows that overlap [from, to]; one that ended at from (the re-baseline's own time) does not
const overlapping = (lf, from, to) => lf.windows.filter((w) => w.start <= to && (w.end ?? Math.min(to, w.start + LEAD_MAX)) > from);

// a notice: what changed while lead call `w` overlapped an agent's call; one file per lead call, one entry per agent
function addNotice(common, w, entry) {
  const f = path.join(noticeDir(common), `${w.seq}.json`);
  const n = lib.readJSON(f, null) || { seq: w.seq, lead: { start: w.start, end: w.end }, agents: [] };
  n.lead = { start: w.start, end: w.end ?? n.lead.end ?? null };
  if (w.cause) n.cause = w.cause;
  const had = n.agents.find((a) => a.key === entry.key);
  if (had) Object.assign(had, { start: Math.min(had.start, entry.start), end: entry.end ?? had.end, paths: [...new Set([...had.paths, ...entry.paths])] });
  else n.agents.push(entry);
  n.shown = false;
  lib.writeJSON(f, n);
}

function notices(common) {
  let names = [];
  try { names = fs.readdirSync(noticeDir(common)).filter((n) => /^\d+\.json$/.test(n)); } catch {}
  return names.map((n) => [path.join(noticeDir(common), n), lib.readJSON(path.join(noticeDir(common), n), null)]).filter(([, n]) => n && Array.isArray(n.agents));
}

const iso = (t) => (t ? new Date(t).toISOString() : "still running");
// each path once, with the agents whose calls overlapped, up to NOTICE_CAP characters
function byPath(n) {
  const m = new Map();
  for (const a of n.agents) for (const p of a.paths || []) {
    if (!m.has(p)) m.set(p, new Set());
    m.get(p).add(`${a.agent || a.key}${a.branch ? ` on ${a.branch}` : ""}`);
  }
  const out = [];
  let len = 0;
  for (const [p, who] of m) {
    const s = `${p} (${[...who].join(", ")})`;
    if (out.length && len + s.length > NOTICE_CAP) break;
    out.push(s.slice(0, NOTICE_CAP));
    len += s.length + 2;
  }
  return out.join("; ") + (m.size > out.length ? `; and ${m.size - out.length} more` : "");
}
const NOTICE_MSG = (n) => `proteus: guarded paths changed while ${n.cause === SYNC ? `${SYNC} (#${n.seq}, ` : `your shell call #${n.seq} (`}${iso(n.lead.start)} to ${iso(n.lead.end)}) overlapped a subagent's: ${byPath(n)}. ${n.cause === SYNC ? "The sync rewrites hook copies, agents and settings, so those are most likely its own. " : n.cause ? `Your call ran ${n.cause}, so the paths it writes are most likely its own. ` : ""}The guard cannot tell whose change it was, so it did not block the agent or open a record. Check each path: what your call did not write, have the agent put back (or restore it yourself). Then clear the notice: node ${slash(path.join(__dirname, "proteus-shell-check.js"))} --clear ${n.seq}`;

// the lead's PostToolUse: close its window, re-baseline the agents' calls in flight and their open records,
// and return any notice the lead has not seen
async function leadEnd(common, w) {
  const now = Date.now();
  const lf = readLead(common);
  for (const x of lf.windows) if (x.id === w.id) x.end = now;
  lib.writeJSON(leadFile(common), lf);
  w = { ...w, end: now };
  for (const [f, n] of notices(common)) if (n.seq === w.seq) { n.lead.end = now; lib.writeJSON(f, n); }
  let snaps = [];
  try { snaps = fs.readdirSync(snapDir(common)).filter((n) => n.endsWith(".guard")).map((n) => path.join(snapDir(common), n)); } catch {}
  // a call that never got its PostToolUse or its agent's stop (killed, crashed) is no longer in flight
  snaps = snaps.flatMap((f) => {
    const snap = lib.readJSON(f, null);
    if (snap && snap.entries && now - snap.at <= STALE) return [[f, snap]];
    try { if (now - fs.statSync(f).mtimeMs > FLIGHT_MAX) fs.unlinkSync(f); } catch {}
    return [];
  });
  if (snaps.length) {
    const fp = fingerprint(common), fl = flights(common, ""), agents = boundAgents(common);
    const heads = Object.fromEntries(fp.roots.map((r) => [r, headOf(r, common)]));
    const st = new Map();
    for (const [f, snap] of snaps) {
      const items = (await diffSnap(snap, fp, common, fl, agents)).filter((i) => !(i.path && under(i.path, lib.realOr(noticeDir(common)))));
      if (items.length) addNotice(common, w, { key: snap.key, agent: snap.agent, branch: snap.branch || "", start: snap.base || snap.at, end: null, paths: items.map(shown) });
      const siblings = {};
      for (const r of Object.keys(snap.siblings || {})) {
        if (!st.has(r)) st.set(r, fs.existsSync(r) ? await porcelain(r) : null);
        if (st.get(r)) siblings[r] = st.get(r);
      }
      // the agent's call may have ended meanwhile; its snapshot is not brought back
      if (fs.existsSync(f)) lib.writeJSON(f, { ...snap, roots: fp.roots, entries: fp.entries, heads, siblings, base: now });
    }
  }
  rebaseRecords(common, w);
  const fresh = notices(common).filter(([, n]) => !n.shown);
  for (const [f, n] of fresh) lib.writeJSON(f, { ...n, shown: true });
  return fresh.map(([, n]) => NOTICE_MSG(n)).join("\n");
}

// an open record's path that changed since the agent last left it (so the lead's call changed it) takes its state
// now as the state before: the agent cannot put back what the lead replaced
function rebaseRecords(common, w) {
  let names = [];
  try { names = fs.readdirSync(tamperDir(common)).filter((n) => n.endsWith(".json")); } catch { return; }
  for (const n of names) {
    const f = path.join(tamperDir(common), n), rec = lib.readJSON(f, null);
    if (!rec || !rec.open) continue;
    let changed = false;
    for (const it of rec.items || []) {
      if (it.kind !== "path" || it.record) continue;
      if (it.keys) {
        const now = configMap(entryNow(it.path));
        for (const k of Object.keys(it.keys)) {
          const v = now.get(k) ?? null;
          if (v !== it.keys[k] && it.after && k in it.after && v !== it.after[k]) { it.keys[k] = v; it.after[k] = v; changed = true; }
        }
        continue;
      }
      const cur = entryNow(it.path);
      if (cur !== (it.before ?? null) && "after" in it && cur !== it.after) { it.before = cur; it.after = cur; it.rebased = w.seq; changed = true; }
    }
    if (changed) lib.writeJSON(f, rec);
  }
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
  lib.writeJSON(snapFile(common, id), { ...marker, branch: branchName(own), roots: fp.roots, entries: fp.entries, heads, siblings });
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

// the config keys that changed from entry a to entry b and count: key -> value before (null: unset); null when
// either side is not a parsed config (the whole file counts). okBranches: whose upstream keys may change
function configDiff(a, b, okBranches) {
  if ((a && !a.startsWith("c:")) || (b && !b.startsWith("c:"))) return null;
  const x = configMap(a), y = configMap(b), out = {};
  for (const k of new Set([...x.keys(), ...y.keys()])) {
    const was = x.get(k) ?? null, is = y.get(k) ?? null;
    if (was === is) continue;
    const m = BRANCH_KEY.exec(k);
    if (m && okBranches.has(m[1]) && upstreamOk(y, m[1])) continue;
    out[k] = was;
  }
  return out;
}
// a branch's upstream that pushes where it pulls from: a configured remote (or "."), pushRemote unset or the same
function upstreamOk(cfg, br) {
  const r = cfg.get(`branch.${br}.remote`) ?? null, pr = cfg.get(`branch.${br}.pushremote`) ?? null;
  if (pr !== null && pr !== r) return false;
  return r === null || r === "." || cfg.has(`remote.${r}.url`);
}

// what changed from snap to fp that counts, as record items
async function diffSnap(snap, fp, common, fl, agents, putBack = new Map(), putKeys = new Map()) {
  const base = snap.base || snap.at;
  const items = [];
  const roots = new Set(fp.roots);
  const registered = new Set(lib.registeredWorktrees(common));
  const c = lib.realOr(common);
  const keep = [path.join(c, "proteus", "tamper"), path.join(c, "proteus", "unattributed")];
  const okBranches = new Set([snap.branch, snap.own && branchName(snap.own)].filter(Boolean));
  for (const r of fp.roots) if (r !== snap.own && busy(r, base, fl, agents, common)) { const b = branchName(r); if (b) okBranches.add(b); }
  const byRoot = new Map();
  for (const [abs, before] of changes(snap.entries, fp.entries)) {
    const top = rootOf(abs, [...snap.roots, ...fp.roots]); // the innermost: worktrees sit inside the main checkout
    // a worktree the lead added during the call, or removed with git worktree remove, is the lead's
    if (top && (!snap.roots.includes(top) || (!roots.has(top) && !registered.has(top)))) continue;
    if (keep.some((d) => under(abs, d))) {
      // the hooks write records and notices; only a deleted one counts, and it stays on the record until the lead clears it
      if (!fp.entries[abs]) items.push({ kind: "path", path: abs, before, record: true });
      continue;
    }
    if (putBack.get(abs) === (fp.entries[abs] ?? null)) continue; // an earlier change being undone
    const now = fp.entries[abs] ?? null;
    if ((before && before.startsWith("c:")) || (now && now.startsWith("c:"))) {
      const keys = configDiff(before, now, okBranches);
      // a key on the record set back to its state before is an earlier change being undone
      const back = putKeys.get(abs), cur = configMap(now);
      if (keys && back) for (const k of Object.keys(keys)) if (k in back && (cur.get(k) ?? null) === back[k]) delete keys[k];
      if (!keys) items.push({ kind: "path", path: abs, before });
      else if (Object.keys(keys).length) items.push({ kind: "path", path: abs, before, keys });
      continue;
    }
    // git never tracks .git (the main checkout's common dir, a linked one's pointer file), so it explains nothing there
    const root = top && path.relative(top, abs).split(path.sep)[0] === ".git" ? "" : top;
    if (root && root !== snap.own && busy(root, base, fl, agents, common)) continue;
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
  const sibs = Object.keys(snap.siblings || {}).filter((r) => fs.existsSync(r) && !busy(r, base, fl, agents, common));
  const now = await Promise.all(sibs.map(porcelain));
  sibs.forEach((r, i) => {
    if (!now[i]) return;
    const had = new Set(snap.siblings[r]);
    const lines = now[i].filter((l) => !had.has(l));
    if (lines.length) items.push({ kind: "sibling", worktree: r, lines });
  });
  return items;
}

// a record's items that still differ from their state before
async function unrestored(rec) {
  const left = [];
  for (const it of rec.items || []) {
    if (it.kind === "sibling") {
      const now = await porcelain(it.worktree);
      if (now && it.lines.some((l) => now.includes(l))) left.push(it);
    } else if (it.kind === "snapshot") {
      if (!it.reported) left.push(it);
    } else if (it.record) left.push(it); // a deleted record stays: what it held is gone
    else if (it.keys) {
      const now = configMap(entryNow(it.path));
      if (Object.entries(it.keys).some(([k, v]) => (now.get(k) ?? null) !== v)) left.push(it);
    } else if (entryNow(it.path) !== (it.before ?? null)) left.push(it);
  }
  return left;
}

// what the agent left: the state the lead's re-baseline compares with
function withAfter(it) {
  if (it.kind !== "path" || it.record) return it;
  if (it.keys) { const now = configMap(entryNow(it.path)); return { ...it, after: Object.fromEntries(Object.keys(it.keys).map((k) => [k, now.get(k) ?? null])) }; }
  return { ...it, after: entryNow(it.path) };
}

const shown = (it) => (it.kind === "sibling" ? `${slash(it.worktree)} (${it.lines.map((l) => l.replace(/ \S+$/, "").slice(3)).slice(0, 5).join(", ")})`
  : it.kind === "snapshot" ? "the guard's snapshot of the call"
    : it.record ? `${slash(it.path)} (deleted; only the lead clears it)`
      : it.keys ? `${slash(it.path)} (${Object.keys(it.keys).join(", ")})` : slash(it.path));
const MSG = (items, again) => `proteus: ${again ? "paths the guard protects still differ from their state before your earlier shell call" : "this shell call changed paths the guard protects"}: ${items.map(shown).slice(0, 12).join("; ")}${items.length > 12 ? `; and ${items.length - 12} more` : ""}. They hold Proteus's hooks, gates, git internals, CLI settings or another worker's worktree, and are never a worker's. Put each back as it was now (\`git checkout -- <path>\` for a tracked file; recreate or delete what the call added or removed; \`git config --unset <key>\` for a config key), then go on with the ticket. Until they match, a verifier cannot sign off MERGE on your branch. If you need one changed, comment "NEEDS <path>: <why>" on the issue and stop.`;

function branchOf(wt) {
  return lib.git(["rev-parse", "--abbrev-ref", "HEAD"], wt) || "";
}

async function check(ev, ad) {
  if (ev.tool !== "shell") return;
  const common = lib.gitCommonDir(lib.projectRoot(ev));
  if (!common) return;
  let id = callId(ev);
  if (!ev.agent) {
    const w = readLead(common).windows.find((x) => x.id === id && x.end == null);
    if (w) { const msg = await leadEnd(common, w); if (msg) ad.context(ev, msg); return; }
  }
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
  let items = [];
  if (!snap) {
    // the guards snapshot every subagent shell call they let through; a missing one was removed during the call
    if (ev.agent && fs.existsSync(path.join(lib.stateDir(common), "guard-flight"))) items.push({ kind: "snapshot" });
  } else {
    const recItems = ((rec && rec.items) || []).filter((i) => i.kind === "path");
    const putBack = new Map(recItems.filter((i) => !i.keys).map((i) => [i.path, i.before ?? null]));
    const putKeys = new Map(recItems.filter((i) => i.keys).map((i) => [i.path, i.keys]));
    items = await diffSnap(snap, fingerprint(common), common, flights(common, id), boundAgents(common), putBack, putKeys);
    // a lead call overlapped this one: the change may be the lead's, so the lead gets a notice instead of a block
    const from = snap.base || snap.at, to = Date.now();
    const over = items.length ? overlapping(readLead(common), from, to) : [];
    if (over.length) {
      const paths = items.filter((i) => !(i.path && under(i.path, lib.realOr(noticeDir(common))))).map(shown);
      if (paths.length) addNotice(common, over[over.length - 1], { key, agent: ev.agent || "", branch: snap.branch || "", start: from, end: to, paths });
      items = [];
    }
  }
  // earlier items still not put back, then this call's (a path already on the record keeps its first state before;
  // a config key joins the record's item for that file)
  const left = rec ? await unrestored(rec) : [];
  const byPath = new Map(left.filter((i) => i.path).map((i) => [i.path, i]));
  const fresh = [];
  for (const i of items) {
    const had = i.path && byPath.get(i.path);
    if (!had) { fresh.push(i); continue; }
    if (had.keys && i.keys) {
      const add = Object.keys(i.keys).filter((k) => !(k in had.keys));
      if (add.length) { for (const k of add) had.keys[k] = i.keys[k]; fresh.push({ ...i, keys: Object.fromEntries(add.map((k) => [k, i.keys[k]])) }); }
    }
  }
  if (!fresh.length && !left.length) {
    if (rec && rec.open) lib.writeJSON(recFile, { ...rec, open: false, items: [], closed: new Date().toISOString(), history: [...(rec.history || []), ...(rec.items || [])].slice(-200) });
    return;
  }
  const own = (snap && snap.own) || (rec && rec.worktree) || ownOf(ev, common);
  const add = fresh.filter((i) => !(i.path && byPath.has(i.path)));
  const all = [...left, ...add].map((i) => withAfter(i.kind === "snapshot" ? { ...i, reported: true } : i));
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

// the lead's notices: --list prints them, --clear <seq>|all removes them
function cli(argv) {
  const USAGE = "usage: proteus-shell-check.js --list | --clear <seq>|all\n  the lead's notices of guarded paths that changed while one of its shell calls overlapped a subagent's";
  const [cmd, arg, ...rest] = argv;
  if (cmd === "--help" || cmd === "-h") { console.log(USAGE); return 0; }
  const common = lib.gitCommonDir(lib.gitRoot(process.cwd()) || process.cwd());
  if (!common || rest.length || (cmd === "--list" && arg) || (cmd === "--clear" && !/^(?:\d+|all)$/.test(arg || ""))) { console.error(USAGE); return 2; }
  const all = notices(common);
  if (cmd === "--list") {
    if (!all.length) console.log("proteus-shell-check: no notices");
    for (const [, n] of all) console.log(NOTICE_MSG(n).replace(/^proteus: /, ""));
    return 0;
  }
  const gone = all.filter(([, n]) => arg === "all" || String(n.seq) === arg);
  for (const [f] of gone) fs.unlinkSync(f);
  console.log(`proteus-shell-check: cleared ${gone.length} notice${gone.length === 1 ? "" : "s"}`);
  return gone.length || arg === "all" ? 0 : 1;
}

module.exports = { snapshot, check, leadStart, leadRun, closeAgent, openFor, fingerprint, tamperDir, noticeDir, MSG };

// run by node, or by proteus-plugin.js (which sets argv[1] to this file)
if (require.main === module || process.argv[1] === __filename) {
  const argv = process.argv.slice(2);
  if (argv.length) process.exitCode = cli(argv);
  else if (process.env.PROTEUS !== "0") lib.run(check);
}

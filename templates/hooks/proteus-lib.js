// Shared core of the proteus-*.js hooks: git, ownership, the ladder, the inbox. Plain Node, no
// dependencies, no shell, nothing specific to one coding-agent CLI (that is proteus-harness.js).
// Every hook fails open: an internal error exits 0 and never blocks the session.
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile, execFileSync, spawnSync } = require("child_process");
const { claudeDir, pluginRoot, samePath } = require(path.join(__dirname, "proteus-confine.js"));

// the harness adapter. The adapter requires this file too: it is loaded at the end, once this
// file's exports are complete, and taken again on use if a load that began at the adapter left it partial.
const HARNESS = path.join(__dirname, "proteus-harness.js");
let adapter = null;
const harness = () => (adapter && adapter.event ? adapter : (adapter = require(HARNESS)));
// install.js --sandbox's copy of the hooks runs outside the sandbox (#188): pinProject fixes its project's main root
// and common dir from sandbox-root.json, so the anchor, every state dir and the main root come from there, never
// from a .git file, a commondir, the cwd or an event
let pinned = null;

// read the hook's stdin JSON, run main(Proteus event, adapter); any throw or rejection exits 0
function run(main) {
  process.on("uncaughtException", () => process.exit(0));
  process.on("unhandledRejection", () => process.exit(0));
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (input += c));
  process.stdin.on("end", async () => {
    let raw = {};
    try { raw = JSON.parse(input) || {}; } catch {}
    try { const ad = harness(); await main(ad.event(raw), ad); } catch (e) { if (process.env.PROTEUS_DEBUG) process.stderr.write(`proteus hook: ${e.stack}\n`); }
    // pipes are async on macOS: exit only once stdout has drained
    process.stdout.write("", () => process.exit(0));
  });
}

// the project dir: the event's, else the one the harness reports outside a hook
const projectRoot = (ev) => (pinned && pinned.root) || (ev && ev.root) || harness().projectRoot({});

// the checkout a script serves, wherever it is installed (a plugin cache too): the git root of dir (a hook's
// cwd or root), else of the harness's project dir, else of the process cwd; else, last, the repo these
// scripts sit in as <root>/.claude/hooks. null outside any repo.
function repoRoot(dir) {
  for (const d of [dir, harness().projectRoot({}), process.cwd()]) {
    const r = d && gitRoot(path.resolve(d));
    if (r) return r;
  }
  const here = path.resolve(__dirname, "..", "..");
  return fs.existsSync(path.join(here, ".git")) ? here : null;
}

// linked worktree: .git is a file pointing at the main checkout
function isLinked(root) {
  try { return fs.statSync(path.join(root, ".git")).isFile(); } catch { return false; }
}

// lead = main thread of the main checkout; everything else (subagents, worker worktrees) is a worker
const isLead = (ev, root) => !ev.agent && !isLinked(root);

// <git-common-dir>, absolute, from files only (never a git call, #215): a dir below a checkout root resolves
// through that root. It follows a .git file and commondir, so it locates Proteus's state; repoCommon is what git runs on.
function gitCommonDir(root) {
  if (pinned) return checkoutAt(pinned.common, root) ? pinned.common : null;
  const dotgit = path.join(root, ".git");
  try {
    const st = fs.statSync(dotgit);
    if (st.isDirectory()) return dotgit;
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotgit, "utf8"));
    if (m) {
      const gd = path.resolve(root, m[1]);
      let cd = "";
      try { cd = fs.readFileSync(path.join(gd, "commondir"), "utf8").trim(); } catch {}
      return cd ? path.resolve(gd, cd) : gd;
    }
    return null;
  } catch {}
  const up = gitRoot(root);
  return up && up !== path.resolve(root) ? gitCommonDir(up) : null;
}

// main checkout root: the common dir's parent when it is a .git dir (null for bare repos)
const mainRoot = (common) => (pinned && common === pinned.common ? pinned.root : common && path.basename(common) === ".git" ? path.dirname(common) : null);

const stateDir = (common) => path.join(common, "proteus");
// the scratch root proteus-scratch.js --path hands out; the edit guards let an agent write under it
const scratchDir = (common) => path.join(stateDir(common), "scratch");
// abs lies under common's scratch root (relPath: null outside it or on another drive, case-insensitive on win32)
const inScratch = (common, abs) => !!common && !!relPath(scratchDir(common), abs);

// a run's names: its branch prefix, its worker branches' prefix, evidence prefix, labels, and the folder inside the
// checkout its worker worktrees use (<checkout>/.worktrees/<id>). Worker branches are <work><run>/<id>, outside <branch>,
// so a ruleset on proteus/* binds runs only; a run opened before that keeps <branch><run>-<id> until it closes.
const CURRENT = { branch: "proteus/", work: "proteus-work/", evidence: "proteus-evidence/", label: "proteus", log: "proteus-log", review: "proteus-review", debt: "proteus-debt", question: "proteus-question", worktrees: ".worktrees" };
// the line proteus-worktree.js keeps in <git-common-dir>/info/exclude, so `git add -A` in the checkout skips them
const WORKTREES_EXCLUDE = `/${CURRENT.worktrees}/`;
const worktreesDir = (root) => path.join(path.resolve(root), CURRENT.worktrees);
// Proteus 1.1 and earlier put worker worktrees in a folder beside the checkout, ../<repo>-proteus/; a run opened
// then keeps its worktrees there until they merge
const OLD_WORKTREES = "-proteus";
const besideDir = (root, suffix) => { const abs = path.resolve(root); return path.join(path.dirname(abs), path.basename(abs) + suffix); };

// worktrees git still has registered under dir: <common>/worktrees/*/gitdir, no git call
function worktreesUnder(root, dir) {
  const common = gitCommonDir(root);
  const out = [];
  let ids = [];
  try { ids = fs.readdirSync(path.join(common, "worktrees")); } catch { return out; }
  for (const id of ids) {
    let wt;
    try { wt = path.dirname(path.resolve(fs.readFileSync(path.join(common, "worktrees", id, "gitdir"), "utf8").trim())); } catch { continue; }
    // real paths on both sides: /tmp is /private/tmp on macOS, and git may have stored either
    const r = path.relative(realOr(dir), realOr(wt));
    if (r && r !== ".." && !r.startsWith(".." + path.sep) && !path.isAbsolute(r)) out.push(wt);
  }
  return out;
}

// the folder beside the checkout that older runs kept worker worktrees in: ../<repo>-proteus
const oldWorktreeDirs = (root) => [besideDir(root, OLD_WORKTREES)];

const realOr = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

// every worktree git has registered, as real paths: <common>/worktrees/*/gitdir, no git call
function registeredWorktrees(common) {
  let ids = [];
  try { ids = fs.readdirSync(path.join(common, "worktrees")); } catch { return []; }
  const out = [];
  for (const id of ids) {
    try { out.push(realOr(path.dirname(path.resolve(fs.readFileSync(path.join(common, "worktrees", id, "gitdir"), "utf8").trim())))); } catch {}
  }
  return out;
}

// a FIFO, socket or device: never opened, named in the error
function notRegular(st) {
  const kind = st.isFIFO() ? "a FIFO" : st.isSocket() ? "a socket" : st.isCharacterDevice() || st.isBlockDevice() ? "a device" : "not a regular file";
  return Object.assign(new Error(`${kind}, never read`), { code: "ENOTREG" });
}
// open f for reading only if it is a regular file: a link is not followed (O_NOFOLLOW; Windows has none, so
// callers lstat first) and a FIFO swapped in does not block the open (O_NONBLOCK) and is refused by fstat
function openRegular(f) {
  const c = fs.constants, fd = fs.openSync(f, c.O_RDONLY | (c.O_NOFOLLOW || 0) | (c.O_NONBLOCK || 0));
  const st = fs.fstatSync(fd);
  if (st.isFile()) return { fd, st };
  fs.closeSync(fd);
  throw notRegular(st);
}

const SCHEMES = [CURRENT];
const isWork = (branch) => String(branch).startsWith(CURRENT.work);
// the naming scheme a run or worker branch is on, null for any other branch
const schemeOf = (branch) => (isWork(branch) ? CURRENT : SCHEMES.find((s) => String(branch).startsWith(s.branch)) || null);
// the run (or <run>-<id>) a branch names, without its prefix: proteus-work/<run>/<id> names <run>-<id>
function runName(branch) {
  const b = String(branch);
  if (isWork(b)) return b.slice(CURRENT.work.length).replace("/", "-");
  const s = schemeOf(b);
  return s ? b.slice(s.branch.length) : b;
}

// every run and worker branch, and proteus-work/<run>/<id>: loose refs and packed-refs, no git call
function runRefs(common) {
  const out = new Set();
  if (!common) return [];
  let packed = "";
  try { packed = fs.readFileSync(path.join(common, "packed-refs"), "utf8"); } catch {}
  for (const s of SCHEMES) {
    const dir = path.join(common, "refs", "heads", s.branch.slice(0, -1));
    try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isFile()) out.add(s.branch + e.name); } catch {}
    const esc = s.branch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    for (const m of packed.matchAll(new RegExp(`^[0-9a-f]+ refs/heads/(${esc}[^/\\s]+)$`, "gm"))) out.add(m[1]);
  }
  const work = path.join(common, "refs", "heads", CURRENT.work.slice(0, -1));
  try {
    for (const r of fs.readdirSync(work, { withFileTypes: true })) {
      if (!r.isDirectory()) continue;
      for (const e of fs.readdirSync(path.join(work, r.name), { withFileTypes: true })) if (e.isFile()) out.add(`${CURRENT.work}${r.name}/${e.name}`);
    }
  } catch {}
  for (const m of packed.matchAll(/^[0-9a-f]+ refs\/heads\/(proteus-work\/[^/\s]+\/[^/\s]+)$/gm)) out.add(m[1]);
  return [...out].sort();
}

// run branches only: proteus-work/<run>/<id>, and <prefix><run>-<id> beside <prefix><run>, are worker branches
function runBranches(common) {
  const refs = runRefs(common);
  return refs.filter((b) => !isWork(b) && !refs.some((a) => a !== b && b.startsWith(a + "-")));
}

function readJSON(file, dflt) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return dflt; }
}

function writeJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  try { fs.renameSync(tmp, file); } catch { fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n"); try { fs.unlinkSync(tmp); } catch {} }
}

// ---- the lead's state (#236): <git-common-dir>/proteus-lead. A hook runs outside any sandbox, while agents (and,
// sandboxed, the lead's own shell) can write <common>/proteus, so a hook that wrote there could be pointed through a
// planted link at any file the user owns. Every file a hook creates, rewrites, appends, renames or deletes is under
// proteus-lead and goes through leadWrite/leadAppend/leadCreate/leadRemove: each refuses, writing nothing, when
// <common> or proteus-lead (or a dir under it) is a link or not this user's; a rewrite is a fresh 'wx' temp file
// renamed over the name, an append opens with O_NOFOLLOW. What agents write under <common>/proteus is read with
// readUntrusted and never written back.
const LEAD = "proteus-lead";
const leadPath = (common, ...segs) => path.join(common, LEAD, ...segs);
const leadErr = (msg) => Object.assign(new Error(`proteus: lead state refused: ${msg}`), { code: "ELEADSTATE" });
const uidOk = (st) => typeof process.getuid !== "function" || st.uid === process.getuid();
// d is a real dir (not a link, junction included) this user owns
function ownDir(d) {
  const st = fs.lstatSync(d);
  if (st.isSymbolicLink() || !st.isDirectory()) throw leadErr(`${d} is not a directory`);
  if (!uidOk(st)) throw leadErr(`${d} is not owned by this user`);
}
function makeDir(d) {
  try { fs.mkdirSync(d, { mode: 0o700 }); return true; } catch (e) { if (e.code !== "EEXIST") throw e; return false; }
}
// <common>/proteus-lead, made (and the old <common>/proteus state copied in) on first use
function leadDir(common) {
  if (!common) throw leadErr("no git common dir");
  ownDir(common);
  const d = path.join(path.resolve(common), LEAD);
  const made = makeDir(d);
  ownDir(d);
  if (made) migrateLead(common, d);
  return d;
}
// file's path under the lead dir, each dir on the way made and checked; refused for any path outside it
function leadTarget(common, file) {
  const root = leadDir(common);
  const rel = path.relative(root, path.resolve(file));
  const segs = rel.split(path.sep);
  if (!rel || path.isAbsolute(rel) || segs.some((s) => !s || s === "." || s === "..")) throw leadErr(`${file} is outside ${root}`);
  let d = root;
  for (const s of segs.slice(0, -1)) { d = path.join(d, s); makeDir(d); ownDir(d); }
  return path.join(d, segs[segs.length - 1]);
}
const tmpName = (f) => `${f}.${process.pid}.${require("crypto").randomBytes(6).toString("hex")}.tmp`;
// replace file's content: a new temp file ('wx': never an existing name, so never a planted link), renamed over it
function leadWrite(common, file, text) {
  const f = leadTarget(common, file), tmp = tmpName(f);
  fs.writeFileSync(tmp, text, { flag: "wx", mode: 0o600 });
  try { fs.renameSync(tmp, f); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
}
const leadJSON = (common, file, obj) => leadWrite(common, file, JSON.stringify(obj, null, 2) + "\n");
// append to file, made if missing; a link at its name is refused (O_NOFOLLOW; Windows has none, so lstat first)
function leadAppend(common, file, text) {
  const f = leadTarget(common, file), c = fs.constants;
  try { if (fs.lstatSync(f).isSymbolicLink()) throw leadErr(`${f} is a link`); } catch (e) { if (e.code !== "ENOENT") throw e; }
  const fd = fs.openSync(f, c.O_WRONLY | c.O_APPEND | c.O_CREAT | (c.O_NOFOLLOW || 0), 0o600);
  try {
    if (!fs.fstatSync(fd).isFile()) throw leadErr(`${f} is not a regular file`);
    fs.writeSync(fd, text);
  } finally { fs.closeSync(fd); }
}
// create file only if no entry has its name; false when one has. The lstat first: on Windows 'wx' creates through
// a dangling link. What is left there is the race between the lstat and the open, Windows only, and outside any
// boundary: Windows has no Proteus sandbox, so an agent there can write proteus-lead directly anyway.
function leadCreate(common, file, text) {
  const f = leadTarget(common, file);
  try { fs.lstatSync(f); return false; } catch (e) { if (e.code !== "ENOENT") throw e; }
  try { fs.writeFileSync(f, text, { flag: "wx", mode: 0o600 }); return true; } catch (e) { if (e.code === "EEXIST") return false; throw e; }
}
// unlink file (a link is removed as a link), or with tree a whole dir; no error when it is gone
function leadRemove(common, file, tree = false) {
  const f = leadTarget(common, file);
  if (tree) return fs.rmSync(f, { recursive: true, force: true }); // rm never follows a link inside the tree
  try { fs.unlinkSync(f); } catch (e) { if (e.code !== "ENOENT") throw e; }
}
// an agent-writable file's text: a regular file only (never via a link, never a FIFO), at most cap bytes
function readUntrusted(file, cap = 1 << 20) {
  if (process.platform === "win32" && fs.lstatSync(file).isSymbolicLink()) throw notRegular(fs.lstatSync(file));
  const { fd, st } = openRegular(file);
  try {
    if (st.size > cap) throw Object.assign(new Error(`${file} is over ${cap} bytes`), { code: "EFBIG" });
    const buf = Buffer.alloc(st.size);
    const n = st.size ? fs.readSync(fd, buf, 0, st.size, 0) : 0;
    return buf.toString("utf8", 0, n);
  } finally { fs.closeSync(fd); }
}
function readUntrustedJSON(file, dflt, cap) {
  try { const v = JSON.parse(readUntrusted(file, cap)); return v && typeof v === "object" ? v : dflt; } catch { return dflt; }
}
// what moves from <common>/proteus on first use: the lead's own files and the shell check's notices (read once
// here, never there again; checked again when shown); the rest there (scratch, allow, guest.json, gates,
// forgotten.json) is agents' or the lead shell's and stays
const LEAD_FILES = ["journal.jsonl", "questions-nudged", "visibility.json", "skills-drift.json", "lead-model.json", "inbox.json",
  "lesson-hits.jsonl", "lessons-cache.json", "scratch-ledger.jsonl", "scratch-size.json", "stall-blocked.json", "guard-hash.json"];
const LEAD_DIRS = ["agents", "spawns", "beats", "tamper", "lessons-seen", "unattributed"];
// regular files only, each lstat'd first and opened without following a link; nothing already there is overwritten
function migrateLead(common, dst) {
  const src = stateDir(common);
  try { ownDir(src); } catch { return; }
  const copy = (from, to) => {
    try {
      if (!fs.lstatSync(from).isFile()) return;
      const f = leadTarget(common, to);
      fs.writeFileSync(f, readUntrusted(from, 8 << 20), { flag: "wx", mode: 0o600 });
    } catch {}
  };
  for (const n of LEAD_FILES) copy(path.join(src, n), path.join(dst, n));
  for (const d of LEAD_DIRS) {
    let st;
    try { st = fs.lstatSync(path.join(src, d)); } catch { continue; }
    if (!st.isDirectory()) continue;
    let names = [];
    try { names = fs.readdirSync(path.join(src, d)); } catch {}
    for (const n of names) copy(path.join(src, d, n), path.join(dst, d, n));
  }
}

const configFile = () => path.join(claudeDir(), "proteus.json");
const proteusConfig = () => readJSON(configFile(), {}) || {};
// the gh config dir the agents post from ("agentGh" in proteus.json, a leading ~ allowed): a GitHub login of
// their own, set up by install.js --agent-login. "" while they post under the human's.
function agentGhDir() {
  const d = proteusConfig().agentGh;
  if (typeof d !== "string" || !d.trim()) return "";
  return path.resolve(d.trim().replace(/^~(?=$|[\\/])/, () => os.homedir()));
}

// ---- the verifier App (#81): "verifierApp": { appId, installations: { <owner>: <id> }, keyPath } in proteus.json,
// recorded by install.js --verifier-app. An installation belongs to one account or org, so each owner of a Proteus
// repo has its own; a lone installationId (before per-owner ids) still serves an owner the map does not name.
// proteus-signoff.js posts proteus/verdict and proteus/security under it, and the ruleset pins those two to its app
// id, so a status posted with the agents' token no longer counts. null when unset.
function verifierApp() {
  const a = proteusConfig().verifierApp;
  if (!a || typeof a !== "object" || !/^\d+$/.test(String(a.appId || "")) || typeof a.keyPath !== "string" || !a.keyPath.trim()) return null;
  const installations = {};
  for (const [o, id] of Object.entries(a.installations && typeof a.installations === "object" ? a.installations : {})) if (/^\d+$/.test(String(id))) installations[o.toLowerCase()] = Number(id);
  return { appId: Number(a.appId), installations, installationId: /^\d+$/.test(String(a.installationId || "")) ? Number(a.installationId) : 0, keyPath: path.resolve(a.keyPath.trim().replace(/^~(?=$|[\\/])/, () => os.homedir())) };
}
// the App's installation for repo ("owner/name"): the owner's own, else the lone pre-map id; 0 when none
const appInstallation = (app, repo) => (app && ((app.installations || {})[String(repo).split("/")[0].toLowerCase()] || app.installationId)) || 0;
const apiBase = () => (process.env.PROTEUS_GH_API || "https://api.github.com").replace(/\/+$/, "");
// the App's own JWT (RS256, node:crypto): iat a minute back for clock drift, 9 minutes of life (GitHub allows 10)
function appJwt(appId, pem, now = Math.floor(Date.now() / 1000)) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const body = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iat: now - 60, exp: now + 540, iss: String(appId) })}`;
  return `${body}.${require("crypto").sign("RSA-SHA256", Buffer.from(body), pem).toString("base64url")}`;
}
// one REST call with a bearer (the JWT or a token); the parsed body, else throws a one-line reason that never holds
// the bearer. e.network: GitHub was not reached.
async function appApi(method, route, bearer, body) {
  let r;
  try {
    r = await fetch(apiBase() + route, {
      method, signal: AbortSignal.timeout(20000),
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${bearer}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "proteus", ...(body && { "Content-Type": "application/json" }) },
      ...(body && { body: JSON.stringify(body) }),
    });
  } catch (e) {
    throw Object.assign(new Error(`${method} ${route}: GitHub not reached (${(e.cause && e.cause.code) || e.name || e.message})`), { network: true });
  }
  let j = null;
  try { j = await r.json(); } catch {}
  if (!r.ok) throw Object.assign(new Error(`${method} ${route}: HTTP ${r.status}${j && j.message ? ` ${String(j.message).split("\n")[0]}` : ""}`), { status: r.status });
  return j;
}
// an installation token of the verifier App for repo ("owner/name"): commit statuses, that one repo, an hour.
// Kept in memory by the caller and handed to gh as GH_TOKEN; never written or printed. Throws a one-line reason.
async function appToken(repo, app = verifierApp()) {
  if (!app) throw new Error("no verifierApp in proteus.json");
  const inst = appInstallation(app, repo), who = String(repo).split("/")[0];
  if (!inst) throw new Error(`the App has no installation recorded for ${who}: install it there, then run install.js --verifier-app in a repo of ${who}`);
  let pem;
  try { pem = fs.readFileSync(app.keyPath, "utf8"); } catch (e) { throw new Error(`cannot read the App key ${app.keyPath} (${e.code || e.message})`); }
  let jwt;
  try { jwt = appJwt(app.appId, pem); } catch (e) { throw new Error(`the App key ${app.keyPath} cannot sign (${String(e.message).split("\n")[0]})`); }
  const lone = !(app.installations || {})[who.toLowerCase()];
  let r;
  try { r = await appApi("POST", `/app/installations/${inst}/access_tokens`, jwt, { repositories: [String(repo).split("/").pop()], permissions: { statuses: "write" } }); } catch (e) {
    // the lone pre-map id may be another owner's installation, which does not reach this repo
    if (lone && !e.network) e.message += `; if the App is not installed for ${who}, install it there, then run install.js --verifier-app in a repo of ${who}`;
    throw e;
  }
  if (!r || typeof r.token !== "string" || !r.token) throw new Error("GitHub answered without a token");
  return r.token;
}

// repo-relative path with forward slashes; null when outside root (incl. another drive on Windows)
function relPath(root, target) {
  const rel = path.relative(root, path.resolve(root, String(target)));
  if (!rel || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) return rel ? null : "";
  return rel.split(path.sep).join("/");
}

// nearest ancestor of dir holding a .git file or dir (a checkout or linked worktree root); null outside git
function gitRoot(dir) {
  let d = path.resolve(String(dir));
  for (;;) {
    if (fs.existsSync(path.join(d, ".git"))) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

// run file with args and no shell. On win32 a .cmd shim (npx, npm) cannot start without one, so that case falls
// back to cmd.exe with each argument quoted and its metacharacters ^-escaped twice, since the shim re-parses %*
// (cross-spawn's rules); a single cmd-quoted line would let a quote inside an argument expose > or & to cmd.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
function spawnArgv(file, args, opts = {}) {
  const o = { encoding: "utf8", windowsHide: true, ...opts, shell: false };
  const r = spawnSync(file, args, o);
  if (process.platform !== "win32" || !r.error || !["ENOENT", "EINVAL"].includes(r.error.code)) return r;
  const q = (a) => `"${String(a).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`.replace(CMD_META, "^$1").replace(CMD_META, "^$1");
  const line = [String(file).replace(CMD_META, "^$1"), ...args.map(q)].join(" ");
  return spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], { ...o, windowsVerbatimArguments: true });
}

// ---- guest mode: a repo the human does not own keeps Proteus's files out of its tree. <common>/proteus/guest.json
// {dir} names an absolute folder laid out like the checkout root (CONTEXT.md, CONVENTIONS.md, AGENTS.md, docs/adr,
// docs/lessons, teams/); install.js --guest writes it. docRoot is where those files live: that folder, else root.
const guestFile = (common) => path.join(stateDir(common), "guest.json");
// ~/.proteus/guest/<repo>-<hash of the common dir>: per user, per clone, outside every checkout
function defaultGuestDir(common) {
  const name = path.basename(mainRoot(common) || common).replace(/[^\w.-]/g, "_");
  return path.join(os.homedir(), ".proteus", "guest", `${name}-${require("crypto").createHash("sha256").update(realOr(common)).digest("hex").slice(0, 8)}`);
}
function guestDir(root) {
  const common = root ? gitCommonDir(path.resolve(String(root))) : null;
  const g = common ? readJSON(guestFile(common), null) : null;
  return g && typeof g.dir === "string" && path.isAbsolute(g.dir) ? path.resolve(g.dir) : "";
}
const docRoot = (root) => guestDir(root) || root;

// a run is open: a run or worker branch exists under either scheme
const runOpen = (common) => runRefs(common).length > 0;

// owned-path glob: ** any depth, * within a segment, trailing / means the whole directory. A glob owns a path
// when it matches the path or any folder above it, wherever its wildcards sit: src/auth and src/* own
// src/auth/x.js, packages/*/src owns packages/a/src/b.js. Case folds on Windows.
function ownedMatch(glob, rel) {
  const g = glob.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "/**");
  const re = new RegExp("^" + g.split("**").map((p) => p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join(".*") + "$", process.platform === "win32" ? "i" : "");
  const segs = String(rel).split("/");
  for (let i = segs.length; i > 0; i--) if (re.test(segs.slice(0, i).join("/"))) return true;
  return false;
}

// a worktree the lead dispatched a worker into: it lists the ticket's owned paths
const ownedFile = (wt) => harness().ownedFile(wt);

// one key per file NTFS resolves alike: each segment loses a :stream suffix and trailing dots and spaces, and
// case goes (macOS and Windows ignore it). Applied on every OS, so Linux also refuses the look-alike names.
const fileKey = (rel) => rel.split("/").map((s) => s.replace(/:.*$/, "").replace(/[. ]+$/, "")).join("/").toLowerCase();
// rel (worktree-relative, forward slashes) names the owned-path list itself
function isOwnedList(wt, rel) {
  return fileKey(path.relative(wt, harness().ownedFile(wt)).split(path.sep).join("/")) === fileKey(rel);
}

// rel names a ticket's owned-path record, .proteus/owned/<id> on the run branch (or the folder): the lead writes
// those, and CI checks a worker's PR against the base's copy (proteus-owned-check.js --ci)
const OWNED_RECORDS = ".proteus/owned";
const isOwnedRecord = (rel) => (fileKey(String(rel).replace(/\\/g, "/")) + "/").startsWith(OWNED_RECORDS + "/");

// why an edit of target breaks the worktree's owned-path list, or "" when allowed or there is no list
function ownedDenial(wt, target) {
  const no = ownedWhy(wt, path.resolve(wt, String(target)));
  return no ? `${no[0]} is ${no[1]}. Comment "NEEDS ${no[0]}: <why>" on the issue and stop.` : "";
}
// [rel, why] when abs is none of wt's owned paths, else null (also when wt has no list). asDir: a dir whose
// whole contents a glob owns counts too (src for src/**), as a shell's rm -r or cp into it names it
function ownedWhy(wt, abs, asDir = false) {
  let list;
  try { list = fs.readFileSync(ownedFile(wt), "utf8"); } catch { return null; }
  // path.relative across Windows drives returns an absolute path, not "../"
  const r = path.relative(wt, abs), rel = r.split(path.sep).join("/");
  if (path.isAbsolute(r) || rel === ".." || rel.startsWith("../")) return inScratch(gitCommonDir(wt), abs) ? null : [rel, "outside the worktree"];
  // no glob covers the list itself (`*/*` and `**` match .claude/), or a worker could widen its own ownership
  if (isOwnedList(wt, rel)) return [rel, "the owned-path list itself, which only the lead writes"];
  if (isOwnedRecord(rel)) return [rel, "a ticket's owned-path record, which only the lead writes"];
  const owned = list.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  return owned.some((g) => ownedMatch(g, rel) || (asDir && rel && ownedMatch(g, rel + "/"))) ? null : [rel, `not in ${path.relative(wt, ownedFile(wt)).split(path.sep).join("/")}`];
}

// a project's `<key>:` line in AGENTS.md (the guest dir's in guest mode): the text after the colon, else null.
// The human's settings live there: `models:` (below) and `lead-edits:`.
function agentsLine(root, key) {
  let agents = "";
  try { agents = fs.readFileSync(path.join(docRoot(root), "AGENTS.md"), "utf8"); } catch {}
  const m = new RegExp(`^${key}:(.*)$`, "m").exec(agents);
  return m ? m[1] : null;
}

// ---- lead-edits: the human widens what the lead may edit with `lead-edits: .vscode/* .editorconfig` in AGENTS.md,
// globs relative to the repo root (ownedMatch syntax). In guest mode the line is read from the guest dir's AGENTS.md
// and its globs still name the repo's own files.
const leadEdits = (root) => (agentsLine(root, "lead-edits") || "").split(/\s+/).filter(Boolean);
// Never the lead's, whatever the line says: the CLIs' hooks, settings and owned lists (.claude, .codex), Codex's
// linked skills (.agents), git's own hooks, config and Proteus state (.git), teams/ (the commit-msg gate and the
// gate scripts under teams/templates/hooks, the lock, the team files), lefthook's config and scripts in every
// name it reads, and the CI that runs the gates (.github/workflows, plus .github/actions that workflows call).
// Matched on fileKey, so case, trailing dots and :streams do not get around it on any OS.
// GUARDED is the part a subagent's shell may never write either (agentShellDenial): there teams/ is a worker's to
// edit, all but the gate scripts under teams/templates/hooks.
const GUARDED = [/^\.(?:claude|codex|agents|git)(?:\/|$)/, /^(?:\.config\/)?\.?lefthook[^/]*(?:\/|$)/, /^\.github\/(?:workflows|actions)(?:\/|$)/];
const LEAD_NEVER = [...GUARDED, /^teams(?:\/|$)/];
const AGENT_NEVER = [...GUARDED, /^teams\/templates\/hooks(?:\/|$)/];
const keyIn = (list, rel) => { const k = fileKey(rel); return list.some((re) => re.test(k)) || /~\d/.test(k); }; // ~1: a Windows 8.3 alias (CLAUDE~1)
const neverLeads = (rel) => keyIn(LEAD_NEVER, rel);
// abs with its nearest existing ancestor's links resolved; null when a link on the way does not resolve
function realTarget(abs) {
  let d = abs, st = null;
  const rest = [];
  try { st = fs.lstatSync(d); } catch {}
  while (!st && path.dirname(d) !== d) {
    rest.unshift(path.basename(d));
    d = path.dirname(d);
    try { st = fs.lstatSync(d); } catch {}
  }
  try { return path.join(fs.realpathSync(d), ...rest); } catch { return null; }
}
// why the lead may not edit target under a lead-edits glob, or "" when it may. rel must be relPath(root, target).
// A link at target is never written through (syncText, #22), and the real path of its nearest existing ancestor
// must stay inside the repo and off the never list, so a committed link to .claude/ or out of the repo does not count.
function leadEditDenial(root, target, rel) {
  const abs = path.resolve(root, String(target));
  if (neverLeads(rel)) return `${rel} holds Proteus's hooks, gates or CLI settings; no lead-edits line covers it.`;
  let st = null;
  try { st = fs.lstatSync(abs); } catch {}
  if (st && st.isSymbolicLink()) return `${rel} is a link; the lead does not write through one.`;
  const real = realTarget(abs); // a dangling link on the way fails realpath
  if (!real) return `${rel} sits under a link that does not resolve.`;
  const realRel = relPath(realOr(root), real);
  if (realRel === null) return `${rel} resolves outside the repo (${real.split(path.sep).join("/")}).`;
  if (realRel !== rel && neverLeads(realRel)) return `${rel} resolves to ${realRel}, which holds Proteus's hooks, gates or CLI settings.`;
  return "";
}

// ---- change tiers (SKILL.md rule 3): the tier decides the pipeline's steps, cheapest first
const TIERS = ["direct", "quick", "standard", "full"];
// the tiers block of teams/ROUTING.md, a ```tiers fence with one rule per line: <glob> <tier> [lines=<n>] [files=<n>].
// null when there is none; a bad line is an error, never a silent default.
function parseTiers(text) {
  const m = /^```tiers[ \t]*\r?\n([\s\S]*?)^```/m.exec(String(text || ""));
  if (!m) return null;
  const rules = [], errors = [];
  for (const line of m[1].split(/\r?\n/)) {
    const words = line.replace(/(^|\s)#.*$/, "").trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const [glob, tier, ...opts] = words;
    const rule = { glob, tier, lines: Infinity, files: Infinity };
    const bad = !TIERS.includes(tier) || opts.some((o) => {
      const kv = /^(lines|files)=(\d+)$/.exec(o);
      if (kv) rule[kv[1]] = Number(kv[2]);
      return !kv;
    });
    if (bad) errors.push(`bad tiers line "${line.trim()}" (want <glob> ${TIERS.join("|")} [lines=<n>] [files=<n>])`);
    else rules.push(rule);
  }
  return { rules, errors };
}

// the security block of teams/ROUTING.md, a ```security fence with one glob per line (tierMatch rules): a PR
// changing a path one matches needs the security verifier's proteus/security status (proteus-security.js).
// null when there is none.
function parseSecurity(text) {
  const m = /^```security[ \t]*\r?\n([\s\S]*?)^```/m.exec(String(text || ""));
  if (!m) return null;
  return m[1].split(/\r?\n/).map((l) => l.replace(/(^|\s)#.*$/, "").trim()).filter(Boolean);
}

// a finding as the baseline ratchet stores it (proteus-baseline.js lines mode): ignore removed,
// backslashes as /, every number as # (line numbers and timings move; the finding does not), spaces collapsed
const normFinding = (line, ignore) => (ignore ? String(line).replace(ignore, "") : String(line)).replace(/\\/g, "/").replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
// the same for the gate `security`, digits kept: its lines carry no line number, and CVE-2020-14040 is not CVE-2026-99999
const exactFinding = (line, ignore) => (ignore ? String(line).replace(ignore, "") : String(line)).replace(/\\/g, "/").replace(/\s+/g, " ").trim();

// print lines that hold PR-head text (a path, a rule id, a scanner's stderr) between ::stop-commands::<token> and
// ::<token>::, so the Actions runner runs none of them as a workflow command, whatever the syntax (::cmd::, ##[cmd]
// anywhere in a line, a bare \r starting a new one). The token is random each call and never one the lines contain.
// write prints one line on the stream the lines belong to (the markers must not interleave with another stream).
function fenced(lines, write = console.log, token = () => require("crypto").randomBytes(16).toString("hex")) {
  const text = lines.join("\n").toLowerCase();
  let t;
  do t = token(); while (text.includes(t.toLowerCase()));
  write(`::stop-commands::${t}`);
  for (const l of lines) write(l);
  write(`::${t}::`);
}

// ownedMatch, where a leading **/ also matches at the root (**/auth/** covers auth/x and src/auth/x)
const tierMatch = (glob, rel) => ownedMatch(glob, rel) || (glob.startsWith("**/") && ownedMatch(glob.slice(3), rel));
// The cheapest tier a change may run at. changes: [{ path, lines }] (lines 0 for a planned path or a binary).
// Each path takes the first rule whose glob matches (tierMatch), else standard. A rule whose paths together
// pass its lines= or files= limit costs one tier more. By path only: an extension says nothing about what a
// file is (a skill repo's markdown is its product). No block → standard for everything, today's pipeline.
function classifyTier(block, changes) {
  if (!block) return { tier: "standard", why: ["no tiers block in teams/ROUTING.md"] };
  const groups = new Map();
  for (const c of changes) {
    const rule = block.rules.find((r) => tierMatch(r.glob, c.path)) || null;
    const g = groups.get(rule) || { rule, paths: [], lines: 0 };
    g.paths.push(c.path);
    g.lines += c.lines || 0;
    groups.set(rule, g);
  }
  let rank = 0, why = [];
  for (const { rule, paths, lines } of groups.values()) {
    let r = TIERS.indexOf(rule ? rule.tier : "standard");
    let line = `${paths.join(", ")}: ${rule ? `${rule.tier} (${rule.glob})` : "standard (no tier rule)"}`;
    if (rule && (lines > rule.lines || paths.length > rule.files) && r < TIERS.length - 1) {
      line += `, over ${lines > rule.lines ? `lines=${rule.lines} (${lines})` : `files=${rule.files} (${paths.length})`} → ${TIERS[++r]}`;
    }
    if (r > rank) { rank = r; why = []; }
    if (r === rank) why.push(line);
  }
  return { tier: TIERS[rank], why };
}
// a planned change, paths only (owned paths or globs, as the lead writes them): line limits are checked later
const plannedTier = (block, paths) => classifyTier(block, paths.map((p) => ({ path: String(p).replace(/\\/g, "/").replace(/^\.\//, ""), lines: 0 })));
// teams/ROUTING.md for the tier checks: with a ref, as committed there (a change cannot loosen its own
// ceiling), else the working copy. Guest mode keeps teams/ outside git (docRoot), so it reads the guest dir's copy.
const ROUTING_FILE = "teams/ROUTING.md";
function routingText(root, ref) {
  const at = ref ? git(["show", `${ownRev(ref, root)}:${ROUTING_FILE}`], root, 10000) : "";
  if (at) return at;
  const dir = ref ? guestDir(root) : docRoot(root);
  try { return dir ? fs.readFileSync(path.join(dir, ROUTING_FILE), "utf8") : ""; } catch { return ""; }
}

// the tier proteus-worktree.js --tier records in a worktree's owned-path list, as a comment ownedDenial skips:
// "# tier <tier> [human] <base sha>"
const TIER_LINE = /^#[ \t]*tier[ \t]+(direct|quick|standard|full)([ \t]+human)?[ \t]+([0-9a-f]{4,64})[ \t]*$/m;
// a declared tier: "quick", or "quick (human)" when the human's quick: prefix lowered a Standard change
function parseDeclared(text) {
  const m = /^\s*(direct|quick|standard|full)\b(\s*\(?human\)?)?/i.exec(String(text || ""));
  return m ? { tier: m[1].toLowerCase(), human: Boolean(m[2]) } : null;
}
// "" when the change fits the declared tier, else why not and what to do. A human quick: covers Standard work,
// never Full; a ceiling is never widened by an agent.
function tierOverrun(declared, result) {
  const cap = declared.human && declared.tier === "quick" ? "standard" : declared.tier;
  if (TIERS.indexOf(result.tier) <= TIERS.indexOf(cap)) return "";
  return `this change needs the ${result.tier} tier, declared ${declared.tier}${declared.human ? " (human)" : ""}:\n  ${result.why.join("\n  ")}\n` +
    `The lead closes this branch and re-runs the work order at ${result.tier} from its first step; never widen the tier, and keep the work whole rather than trimming it to fit.`;
}

// last `bytes` of a file as complete lines (first partial line dropped); regular: only a regular file, never via a link
function tailLines(file, bytes = 256 * 1024, regular = false) {
  if (!file) return [];
  let fd;
  try {
    fd = regular ? openRegular(file).fd : fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return lines.filter((l) => l.trim());
  } catch { return []; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

// ---- secrets: text kept on disk or re-injected into context (the journal) has these replaced by
// [redacted]. Every pattern is linear: bounded or disjoint quantifiers, nothing nested.
const REDACTED = "[redacted]";
const SECRETS = [
  [/-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|$)/g, REDACTED], // to the end when unterminated
  [/\b(authorization["']?\s{0,5}[:=]\s{0,5}["']?)(?:(?:bearer|basic|token)\s{1,5})?[^\s"',;]+/gi, `$1${REDACTED}`],
  [/\b(bearer\s{1,5})[A-Za-z0-9._~+/=-]{16,}/gi, `$1${REDACTED}`],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, REDACTED], // GitHub tokens, classic and fine-grained
  [/\bsk-[A-Za-z0-9_-]{20,}/g, REDACTED], // Anthropic (sk-ant-…) and OpenAI style keys
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED], // AWS access key ids
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED], // Slack
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, REDACTED], // JWT
];
// key = value, key: value, "key": "value" where the key ends in a secret's name (DB_PASSWORD, client_secret, apiKey)
const ASSIGN = /\b([A-Za-z_][\w-]{0,63})(["']?\s{0,5}[:=]\s{0,5}["']?)([^\s"'`,;&]+)/g;
const SECRET_KEY = /(?:passw(?:or)?d|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)$/i;
function redact(text) {
  let s = String(text);
  for (const [re, to] of SECRETS) s = s.replace(re, to);
  return s.replace(ASSIGN, (m, key, sep) => (SECRET_KEY.test(key) ? key + sep + REDACTED : m));
}

const execOpts = (cwd, timeout, env) => ({ cwd, encoding: "utf8", timeout, windowsHide: true, stdio: ["ignore", "pipe", "ignore"], env });

// ---- git outside the sandbox (#215). The hooks run git with the human's rights, on repo state a sandboxed command
// can write: <common>/commondir, a worktree's .git file, its gitdir's commondir and config.worktree. Each can hand git
// a config that runs a program (core.fsmonitor, a clean filter). So every hook git call runs through gitRun: GIT_DIR
// and GIT_COMMON_DIR pinned to one common dir, no system or global config, fsmonitor, hooks and the untracked cache
// off. git then reads <common>/config and <common>/config.worktree only, which the sandbox profile denies. A linked
// worktree's HEAD is read as a file under <common>/worktrees/<id>; its working tree through its index (treeChanges).
const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";
// and never into a submodule, whose config under <common>/modules an agent can write (#226), and no automatic gc or
// maintenance, so no hook's git prunes <common>/worktrees, where an agent can plant a link git deletes through (#237).
// maintenance.auto=false and gc.auto=0 are what hold (#235): gc's prune drops a worktrees/<x> with no gitdir file
// whatever the expiry, so worktreePruneExpire=never covers only entries whose gitdir names a missing path.
const GIT_SAFE = ["-c", "core.fsmonitor=false", "-c", `core.hooksPath=${NULL_DEVICE}`, "-c", "core.untrackedCache=false",
  "-c", "fetch.recurseSubmodules=false", "-c", "submodule.recurse=false",
  "-c", "gc.worktreePruneExpire=never", "-c", "maintenance.auto=false", "-c", "gc.auto=0"];
const GIT_REPO_ENV = /^GIT_(?:DIR|COMMON_DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CONFIG|CONFIG_COUNT|CONFIG_PARAMETERS|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/i;
const GIT_USER_ENV = /^GIT_CONFIG_(?:GLOBAL|SYSTEM|NOSYSTEM)$/i;
// o.user keeps the human's global and system config (verify-tag's trust, fetch's credentials and proxy: #215 decision 1)
function gitEnv(gitDir, o = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (GIT_REPO_ENV.test(k) || (!o.user && GIT_USER_ENV.test(k))) delete env[k];
  Object.assign(env, { GIT_DIR: gitDir, GIT_COMMON_DIR: gitDir });
  if (!o.user) Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: NULL_DEVICE });
  if (o.workTree) env.GIT_WORK_TREE = o.workTree;
  if (o.index) env.GIT_INDEX_FILE = o.index;
  return env;
}
// the human's own core.excludesFile, the one key read from the global config, so untracked files it ignores stay ignored
let excludes;
function userExcludes(gitDir) {
  if (excludes !== undefined) return excludes;
  excludes = "";
  try { excludes = execFileSync("git", [...GIT_SAFE, "config", "--global", "--get", "core.excludesFile"], { ...execOpts(gitDir, 3000, gitEnv(gitDir, { user: true })) }).trim(); } catch {}
  return excludes;
}
// [argv, options] for git in gitDir. o: cwd (default gitDir), workTree, index, user, timeout, encoding, input, stdio
function gitCall(gitDir, args, o = {}) {
  const pre = [...GIT_SAFE];
  if (o.workTree && !o.user && userExcludes(gitDir)) pre.push("-c", `core.excludesFile=${userExcludes(gitDir)}`);
  return [[...pre, ...args], { cwd: o.cwd || gitDir, encoding: "encoding" in o ? o.encoding : "utf8", timeout: o.timeout || 3000, maxBuffer: 64 << 20,
    windowsHide: true, input: o.input, stdio: o.stdio || [o.input === undefined ? "ignore" : "pipe", "pipe", "ignore"], env: gitEnv(gitDir, o) }];
}
// git's stdout; throws as execFileSync does
const gitRun = (gitDir, args, o) => execFileSync("git", ...gitCall(gitDir, args, o));
// trimmed stdout, "" on any failure (no git dir, not installed, no remote, offline)
function gitIn(gitDir, args, timeout = 3000, o = {}) {
  if (!gitDir) return "";
  try { return String(gitRun(gitDir, args, { ...o, timeout })).trim(); } catch { return ""; }
}
// stdout, or null when git fails
const gitAsync = (gitDir, args, o = {}) => new Promise((resolve) => {
  if (!gitDir) return resolve(null);
  try { execFile("git", ...gitCall(gitDir, args, { timeout: 5000, ...o }), (err, out) => resolve(err ? null : out)); } catch { resolve(null); }
});
// fn's trimmed stdout as { ok, out, err }, for a caller that must tell a failure from empty output or read why it failed
function attempt(fn) {
  try { return { ok: true, out: String(fn()).trim(), err: "" }; }
  catch (e) { return { ok: false, out: String(e.stdout || "").trim(), err: String(e.stderr || e.message || "").trim() }; }
}
// gitRun as { ok, out, err }; gitDir a common dir from repoCommon or checkoutOf, never a shell's cwd
const gitTry = (gitDir, args, o = {}) => (gitDir ? attempt(() => gitRun(gitDir, args, { ...o, stdio: ["ignore", "pipe", "pipe"] }))
  : { ok: false, out: "", err: "not in this project's repo" });
// git on dir's repo (repoCommon); "" on any failure. Revisions and refs only: no working tree, and HEAD is the main checkout's
const git = (args, dir, timeout = 3000) => gitIn(repoCommon(dir), args, timeout);

// a checkout root's main checkout, by its path alone: <main>/.worktrees/<id>, <p>/<name>-proteus/<id> (Proteus 1.1),
// <main>/.claude/worktrees/<n> (Claude Code's), else the root itself
function mainCandidates(root) {
  const up = path.dirname(root), up2 = path.dirname(up), name = path.basename(up);
  const out = [];
  if (name === CURRENT.worktrees) out.push(up2);
  if (name.endsWith(OLD_WORKTREES) && name.length > OLD_WORKTREES.length) out.push(path.join(up2, name.slice(0, -OLD_WORKTREES.length)));
  if (name === "worktrees" && path.basename(up2) === ".claude") out.push(path.dirname(up2));
  return [...out, root];
}
const realGitDir = (r) => { try { const p = path.join(r, ".git"); return fs.lstatSync(p).isDirectory() ? fs.realpathSync(p) : null; } catch { return null; } };
// the common dir git runs on for the checkout holding dir: the realpath of <main>/.git, a real directory, never reached
// through a .git file or commondir. A layout none of mainCandidates matches falls back to gitCommonDir (a residual).
function trustedCommon(dir) {
  const root = dir && gitRoot(path.resolve(dir));
  if (!root) return null;
  for (const m of mainCandidates(root)) { const c = realGitDir(m); if (c) return c; }
  const c = gitCommonDir(root);
  return c ? realOr(c) : null;
}
// the project's common dir, from the harness's project dir (CLAUDE_PROJECT_DIR), never a shell's cwd
const anchors = new Map();
function anchorCommon() {
  if (pinned) return pinned.common;
  const p = path.resolve(String(harness().projectRoot({}) || "."));
  if (!anchors.has(p)) anchors.set(p, trustedCommon(p));
  return anchors.get(p);
}
// dir's checkout of the repo whose common dir is common: { common, root, gitDir, index, headFile }, the innermost
// registered worktree holding dir, else the main checkout; null when neither holds it
function checkoutAt(common, dir) {
  const at = realOr(path.resolve(dir));
  let best = null;
  let ids = [];
  try { ids = fs.readdirSync(path.join(common, "worktrees")); } catch {}
  for (const id of ids) {
    const gd = path.join(common, "worktrees", id);
    let wt;
    try { wt = realOr(path.dirname(path.resolve(gd, fs.readFileSync(path.join(gd, "gitdir"), "utf8").trim()))); } catch { continue; }
    if (relPath(wt, at) !== null && (!best || wt.length > best.root.length)) best = { root: wt, gitDir: gd };
  }
  const main = mainRoot(common);
  if (!best && main && relPath(realOr(main), at) !== null) best = { root: realOr(main), gitDir: common };
  return best && { common, ...best, index: path.join(best.gitDir, "index"), headFile: path.join(best.gitDir, "HEAD") };
}
// the common dir git runs on for dir: the project's when dir is in one of its checkouts, else null (no checkout).
// Never dir's own repo: a sandboxed command can build one anywhere it writes, config and filters included (#215).
// Null too when <common>/commondir exists: git's files ref backend follows it even with GIT_COMMON_DIR pinned (#226)
function repoCommon(dir) {
  const c = anchorCommon();
  if (!c) return null;
  try { fs.lstatSync(path.join(c, "commondir")); return null; } catch {}
  return !dir || checkoutAt(c, dir) ? c : null;
}
// pin the project to root and common (from sandbox-root.json); a path outside its checkouts then has no common dir
function pinProject(root, common) { pinned = { root: realOr(root), common: realOr(common) }; anchors.clear(); }
// dir's checkout. root: a project root a human or the lead names on a command line (install.js, proteus-worktree.js),
// whose repo git runs on in place of the harness's project dir; never a path from a hook event or a shell command.
// A pinned project ignores root
const checkoutOf = (dir, root) => { const c = dir && (root && !pinned ? trustedCommon(root) : repoCommon(dir)); return c ? checkoutAt(c, dir) : null; };

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
// a ref's commit from files (loose, then packed-refs), else git on the common dir (reftable)
function refSha(common, ref) {
  if (!/^refs\/[^\s\\]+$/.test(ref) || ref.split("/").some((s) => s === "." || s === "..")) return "";
  try { const s = fs.readFileSync(path.join(common, ...ref.split("/")), "utf8").trim(); if (SHA.test(s)) return s; } catch {}
  try {
    const esc = ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const p = new RegExp(`^([0-9a-f]{40,64}) ${esc}\\r?$`, "m").exec(fs.readFileSync(path.join(common, "packed-refs"), "utf8"));
    if (p) return p[1];
  } catch {}
  return gitIn(common, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
}
// a checkout's HEAD, read as a plain file: { ref, sha }; a link, a non-file or anything unparsed reads as {}
function headInfo(co) {
  try {
    const st = co && fs.lstatSync(co.headFile);
    if (!st || !st.isFile() || st.size > 4096) return {};
    const t = fs.readFileSync(co.headFile, "utf8").trim();
    const m = /^ref:\s*(refs\/\S+)$/.exec(t);
    if (m) return { ref: m[1], sha: refSha(co.common, m[1]) };
    return SHA.test(t) ? { sha: t } : {};
  } catch { return {}; }
}
// the commit checked out in dir's checkout, "" when unknown or unborn
const headOf = (dir, root) => headInfo(checkoutOf(dir, root)).sha || "";
// the branch checked out in dir's checkout, "" when detached or unknown
const branchOf = (dir, root) => { const m = /^refs\/heads\/(.+)$/.exec(headInfo(checkoutOf(dir, root)).ref || ""); return m ? m[1] : ""; };
// rev with a leading HEAD or @ read as dir's own HEAD: git runs on the common dir, whose HEAD is the main checkout's
function ownRev(rev, dir) {
  const m = /^(?:HEAD|@)(?=$|[~^:])/.exec(String(rev));
  if (!m) return rev;
  const sha = headOf(dir);
  return sha ? sha + String(rev).slice(m[0].length) : rev;
}

// what dir's checkout changed against its HEAD, as porcelain-like lines (" M path", "?? path"): tracked files by git
// diff, untracked by ls-files -o, git reading the common config and the checkout's own index only. specs: pathspecs
// relative to the checkout root; ignored: untracked ignored files too, one per file; else untracked dirs collapse.
// null when git fails or dir is in no checkout
function changeCalls(co, specs, ignored) {
  const sha = headInfo(co).sha;
  const o = { cwd: co.root, workTree: co.root, index: co.index, timeout: 10000 };
  return [[sha ? ["diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", sha, "--", ...specs] : ["ls-files", "-z", "--", ...specs], " M ", o],
    [["ls-files", "-o", "-z", ...(ignored ? [] : ["--exclude-standard", "--directory", "--no-empty-directory"]), "--", ...specs], "?? ", o]];
}
const changeLines = (outs, calls) => (outs.some((x) => x === null) ? null : outs.flatMap((out, i) => String(out).split("\0").filter(Boolean).map((p) => calls[i][1] + p)));
// co with its index swapped for a private copy, and done() to delete the copy; null when co is, or its index is a
// link, not a regular file or over INDEX_CAP. git diff rewrites a stat-dirty index (a lock, then a rename, both by
// path), and GIT_OPTIONAL_LOCKS=0 does not stop it, so run on <common>/worktrees/<id>/index it writes wherever an
// agent swaps that dir for a link (#212). The copy is a 'wx' file in a fresh mkdtemp dir under <common>/proteus-lead,
// which the sandbox profile denies (a temp dir agents can write would let them swap that dir too); its source is
// lstat'd and opened without following a link. A checkout with no index yet gets a name in that dir with nothing there
const INDEX_CAP = 64 << 20;
function privateIndex(co) {
  if (!co) return null;
  let st = null;
  try { st = fs.lstatSync(co.index); } catch (e) { if (e.code !== "ENOENT") return null; }
  if (st && (!st.isFile() || st.size > INDEX_CAP)) return null;
  let dir;
  try { dir = fs.mkdtempSync(path.join(leadDir(co.common), "index-")); } catch { return null; }
  const done = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
  const index = path.join(dir, "index");
  if (st) {
    try {
      const { fd, st: open } = openRegular(co.index);
      try {
        if (open.size > INDEX_CAP) throw new Error("index too large");
        // the size fstat saw, no more: an index that grows meanwhile is refused, not read past the cap
        const buf = Buffer.alloc(open.size);
        let n = 0, got;
        while (n < buf.length && (got = fs.readSync(fd, buf, n, buf.length - n, null)) > 0) n += got;
        if (fs.readSync(fd, Buffer.alloc(1), 0, 1, null)) throw new Error("index grew while read");
        fs.writeFileSync(index, buf.subarray(0, n), { flag: "wx", mode: 0o600 });
      } finally { fs.closeSync(fd); }
    } catch { done(); return null; }
  }
  return { co: { ...co, index }, done };
}
function treeChanges(dir, specs = [], ignored = false) {
  const p = privateIndex(checkoutOf(dir));
  if (!p) return null;
  try {
    const calls = changeCalls(p.co, specs, ignored);
    return changeLines(calls.map(([args, , o]) => { try { return String(gitRun(p.co.common, args, o)); } catch { return null; } }), calls);
  } finally { p.done(); }
}
async function treeChangesAsync(dir, specs = [], ignored = false) {
  const p = privateIndex(checkoutOf(dir));
  if (!p) return null;
  try {
    const calls = changeCalls(p.co, specs, ignored);
    return changeLines(await Promise.all(calls.map(([args, , o]) => gitAsync(p.co.common, args, o))), calls);
  } finally { p.done(); }
}
// a release home's git dir: a bare clone's own dir, else its checkout's (trustedCommon)
function homeGitDir(home) {
  try {
    if (!fs.existsSync(path.join(home, ".git")) && fs.lstatSync(home).isDirectory() && fs.existsSync(path.join(home, "HEAD")) && fs.existsSync(path.join(home, "objects"))) return fs.realpathSync(home);
  } catch {}
  return trustedCommon(home);
}
const homeGit = (home, args, timeout = 3000, o = {}) => gitIn(homeGitDir(home), args, timeout, o);
// the scratch root install.js --sandbox makes writable: <tmpdir>/proteus-<uid>
function sandboxScratch() {
  const who = typeof process.getuid === "function" ? String(process.getuid()) : os.userInfo().username.replace(/[^\w.-]/g, "_");
  return path.join(os.tmpdir(), `proteus-${who}`);
}
// the path the OS resolves p to (realpathSync.native: every link followed, and on macOS and Windows the case the disk
// stores), else p resolved
const realNative = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
// target is place or inside it; on macOS and Windows, whose file systems ignore case by default, compared case- and
// Unicode-folded (NFC, lower case), as samePath does. platform is for tests
function within(place, target, platform = process.platform) {
  const p = platform === "win32" ? path.win32 : path.posix, fold = platform === "win32" || platform === "darwin";
  const key = (x) => { const r = p.resolve(String(x)); return fold ? r.normalize("NFC").toLowerCase() : r; };
  const rel = p.relative(key(place), key(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + p.sep) && !p.isAbsolute(rel));
}
// #234: where a script a Codex prefix rule runs outside the sandbox may sit: the hooks dir of the main checkout of the
// repo holding it; the plugin's folder (CLAUDE_PLUGIN_ROOT) and a Proteus source tree's hooks (<tree>/templates/hooks
// beside <tree>/.claude-plugin); and the copies install.js --sandbox keeps under <claudeDir>/proteus-sandbox/bin,
// which every profile denies to agents. A copy anywhere else, a worker's nested .codex/hooks, is not the lead's script
function homeDirs(file) {
  const dir = path.dirname(file), tree = path.resolve(dir, "..", "..");
  const main = mainRoot(gitCommonDir(dir));
  return [
    ...(main ? [harness().hooksDir(main)] : []),
    ...(pluginRoot() ? [pluginRoot()] : []),
    ...(fs.existsSync(path.join(tree, ".claude-plugin", "plugin.json")) ? [path.join(tree, "templates", "hooks")] : []),
    path.join(claudeDir(), "proteus-sandbox", "bin"),
  ];
}
// here is under one of dirs (all real paths); platform is for tests
const homeAllows = (here, dirs, platform = process.platform) => dirs.some((d) => within(d, here, platform));
// called first by each such script: unless its real path is under homeDirs, one line on stderr and exit 2
function homeOnly(file) {
  const here = realNative(file);
  let dirs = [];
  try { dirs = homeDirs(here).map(realNative); } catch {}
  if (homeAllows(here, dirs)) return;
  process.stderr.write(`proteus: ${path.basename(file)} runs only from the main checkout's hooks dir or the plugin's, not ${here}\n`);
  process.exit(2);
}
// every path a Proteus sandbox profile lets sandboxed commands write: allowWrite of each
// <claudeDir>/proteus-sandbox/*.json, which install.js --sandbox writes and every profile denies to agents. A profile
// is read as a regular file, never through a link; one that cannot be read or parsed throws, so a caller fails closed
function profileWrites() {
  const dir = path.join(claudeDir(), "proteus-sandbox");
  let names;
  try {
    if (!fs.lstatSync(dir).isDirectory()) throw new Error(`${dir} is not a directory`);
    names = fs.readdirSync(dir);
  } catch (e) { if (e.code === "ENOENT") return []; throw e; }
  const out = [];
  for (const n of names.filter((x) => x.endsWith(".json")).sort()) {
    const j = JSON.parse(readUntrusted(path.join(dir, n)));
    const w = j && j.sandbox && j.sandbox.filesystem && j.sandbox.filesystem.allowWrite;
    if (!Array.isArray(w)) continue;
    for (const x of w) if (typeof x === "string" && x) out.push(x.startsWith("~/") ? path.join(os.homedir(), x.slice(2)) : x);
  }
  return out.filter((x) => path.isAbsolute(x));
}
// a release home agents can write (#212 B6, B7): the home as named or its realpath (o.real, else realNative of it) is
// inside the project root, <common>, a registered worktree, a guest dir, a path any Proteus sandbox profile makes
// writable (profileWrites: another sandboxed repo, the scratch root that profile names) or o.places, or its git dir is
// <common>. The autostart then fetches, merges, copies, spawns and requires nothing from it, and install.js --sandbox
// refuses. Throws when a profile cannot be read; callers treat that as writable
function homeWritable(home, root, common, o = {}) {
  if (!home) return false;
  const lex = path.resolve(String(home)), h = o.real || realNative(lex);
  if (common && samePath(homeGitDir(h), realNative(common))) return true;
  const places = [root, root && guestDir(root), ...profileWrites(), ...(o.places || [])];
  if (common) places.push(common, scratchDir(common), defaultGuestDir(common), ...registeredWorktrees(common));
  return places.some((p) => p && [path.resolve(p), realNative(path.resolve(p))].some((at) => within(at, lex) || within(at, h)));
}
// ---- the session's sandbox (#189): sandbox=on|off|unavailable on the autostart's state line, and the lead guard's
// gate on bypassPermissions dispatch. The autostart stores it per session in proteus-lead/sandbox.json (leadWrite),
// which no agent can write, so the guard reads a state the session cannot forge.
// name's executable on env's PATH (PATHEXT on win32), else null
function which(name, env = process.env, platform = process.platform) {
  const win = platform === "win32";
  const dirs = String(env.PATH || env.Path || "").split(win ? ";" : ":").filter(Boolean);
  const exts = win ? String(env.PATHEXT || ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
  for (const d of dirs) for (const x of exts) {
    const p = path.join(d, name + x);
    try { if (fs.statSync(p).isFile() && (win || (fs.accessSync(p, fs.constants.X_OK), true))) return p; } catch {}
  }
  return null;
}
// a process's argv, parent pid and cwd, {} when unknown: /proc on Linux, ps on macOS (no cwd, and argv split at
// spaces); other platforms have no Claude Code sandbox
function procInfo(pid, platform = process.platform) {
  try {
    if (platform === "linux") {
      const argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
      const ppid = +(/^PPid:\s*(\d+)/m.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8")) || [])[1] || 0;
      let cwd = "";
      try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch {}
      return { argv, ppid, cwd };
    }
    if (platform === "darwin") {
      const m = /^\s*(\d+)\s+(.*)$/.exec(execFileSync("ps", ["-o", "ppid=,args=", "-p", String(pid)], { encoding: "utf8", timeout: 3000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim());
      return m ? { argv: m[2].split(/\s+/), ppid: +m[1], cwd: "" } : {};
    }
  } catch {}
  return {};
}
// the settings `claude --settings <file or json>` was launched with, parsed: the nearest ancestor of this process
// that names --settings, up to 8 levels. The sandbox profile reaches Claude Code only this way (install.js --sandbox)
function launchSettings(platform = process.platform, start = process.ppid, root = process.cwd()) {
  for (let pid = start, i = 0; pid > 1 && i < 8; i++) {
    const p = procInfo(pid, platform);
    if (!p.argv) return [];
    const vals = p.argv.flatMap((a, j) => (a === "--settings" && j + 1 < p.argv.length ? [p.argv[j + 1]] : a.startsWith("--settings=") ? [a.slice(11)] : []));
    if (vals.length) return vals.map((v) => (/^\s*\{/.test(v) ? safeJSON(v) : readJSON(path.resolve(p.cwd || root, v), null)) || {});
    pid = p.ppid;
  }
  return [];
}
const safeJSON = (s) => { try { return JSON.parse(s); } catch { return null; } };
// on: the settings Claude Code merges (--settings, then the repo's local and project files, then the user's; the
// first to set sandbox.enabled wins) turn the sandbox on, on a platform that has one (macOS; Linux with bwrap and
// socat on PATH). unavailable: native Windows, or Linux without bwrap or socat. off: anything else.
// o.platform, o.env, o.which (name -> truthy when on PATH) and o.settings (the parsed files, in that order) are for tests
function sandboxState(root, o = {}) {
  const platform = o.platform || process.platform, env = o.env || process.env;
  const has = o.which || ((name) => which(name, env, platform));
  if (platform === "win32") return "unavailable";
  if (platform === "linux" && !(has("bwrap") && has("socat"))) return "unavailable";
  if (platform !== "linux" && platform !== "darwin") return "off";
  const files = o.settings || [...launchSettings(platform, process.ppid, root),
    ...[path.join(root, ".claude", "settings.local.json"), path.join(root, ".claude", "settings.json"), path.join(claudeDir(), "settings.json")].map((f) => readJSON(f, {}))];
  const on = files.map((s) => s && s.sandbox && typeof s.sandbox === "object" ? s.sandbox.enabled : undefined).find((v) => typeof v === "boolean");
  return on === true ? "on" : "off";
}
const SANDBOX_FILE = "sandbox.json";
// record session's state (the newest 20 sessions are kept); throws as leadWrite does
function saveSandbox(common, session, state) {
  const f = leadPath(common, SANDBOX_FILE);
  const all = Object.entries(readJSON(f, {}) || {}).filter(([k]) => k !== session).slice(-19);
  leadJSON(common, f, Object.fromEntries([...all, [session, { state, at: new Date().toISOString() }]]));
}
// session's recorded state, "" when none was recorded
function sandboxSeen(root, session) {
  const common = gitCommonDir(root);
  const e = common && session ? (readJSON(leadPath(common, SANDBOX_FILE), {}) || {})[session] : null;
  return e && typeof e.state === "string" ? e.state : "";
}
// the launch command a refusal names: the repo's profile when install.js --sandbox wrote one, else its pattern
function sandboxLaunch(root) {
  const common = gitCommonDir(root), dir = path.join(claudeDir(), "proteus-sandbox");
  const key = common ? require(path.join(__dirname, "proteus-confine.js")).sandboxKey(common) : "";
  let file = "";
  try { file = key ? fs.readdirSync(dir).find((n) => n.endsWith(`-${key}.json`)) || "" : ""; } catch {}
  const profile = file ? path.join(dir, file) : path.join(dir, "<repo>-<hash>.json");
  return `claude --settings ${/\s/.test(profile) ? `"${profile}"` : profile} --permission-mode bypassPermissions`;
}

// Releases: the Proteus checkout moves only forward, and only to a vX.Y.Z tag that `git verify-tag`
// accepts against the user's own trust (a gpg keyring, or gpg.ssh.allowedSignersFile for SSH signatures).
// The autostart (autoUpdate) and install.js --update share these.
const RELEASE = /^v(\d+)\.(\d+)\.(\d+)$/;
const semver = (v) => (String(v).match(/^v?(\d+)\.(\d+)\.(\d+)$/) || []).slice(1).map(Number);
// a > b; any version is newer than "" (no release yet)
function newerThan(a, b) {
  const x = semver(a), y = semver(b);
  if (x.length !== 3) return false;
  if (y.length !== 3) return true;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}
const releaseTags = (home, ...filter) => homeGit(home, ["tag", "-l", ...filter, "v*"]).split("\n").filter((t) => RELEASE.test(t));
const newest = (tags) => tags.reduce((m, t) => (newerThan(t, m) ? t : m), "");

// { current, tag, ahead }: current is the newest release in HEAD's history ("" when none), tag the
// newest release past it that HEAD lacks ("" when none), ahead the count of commits HEAD lacks from tag
function release(home) {
  const current = newest(releaseTags(home, "--merged", "HEAD"));
  const tag = newest(releaseTags(home, "--no-merged", "HEAD").filter((t) => newerThan(t, current)));
  const ahead = tag ? parseInt(homeGit(home, ["rev-list", "--count", `HEAD..refs/tags/${tag}`]), 10) || 0 : 0;
  return { current, tag, ahead };
}

// { commit, error }: commit is what home may fast-forward to; error says in one line why it may not
// (lightweight or unsigned tag, unknown signer, no fast-forward). ff false skips the fast-forward check: the
// plugin's release check (proteus-autostart.js) verifies tags in a bare clone, which has no checkout to move
function verifyRelease(home, tag, ff = true) {
  const no = (error) => ({ commit: "", error });
  const gd = homeGitDir(home);
  const obj = RELEASE.test(tag) ? gitIn(gd, ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`]) : "";
  if (!obj) return no(`${tag} is not a release tag here`);
  if (gitIn(gd, ["cat-file", "-t", obj]) !== "tag") return no(`${tag} is a lightweight tag, so it carries no signature`);
  // a signed tag published again under a newer name still names its own version inside
  const header = gitIn(gd, ["cat-file", "tag", obj]).split("\n\n")[0];
  if (!header.split("\n").includes(`tag ${tag}`)) return no(`${tag} points at a tag object made for another name`);
  if (ff && !releaseTags(home, "--contains", "HEAD").includes(tag)) return no(`${tag} does not contain this checkout's HEAD (local commits?), so it is no fast-forward`);
  try {
    // the trust is the human's own config (gpg.ssh.allowedSignersFile, gpg.program), so it keeps theirs
    gitRun(gd, ["verify-tag", obj], { user: true, timeout: 10000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const last = String(e.stderr || "").split("\n").map((l) => l.trim()).filter(Boolean).pop() || "git verify-tag failed";
    return no(`git verify-tag ${tag}: ${last.replace(/^error: /, "").replace(/\.$/, "").slice(0, 200)}`);
  }
  const commit = gitIn(gd, ["rev-parse", `${obj}^{commit}`]);
  return commit ? { commit, error: "" } : no(`${tag} does not resolve to a commit`);
}

// the CHANGELOG.md sections at commit for the versions after from, up to and including to; at most max lines
function changelog(home, commit, from, to, max = 8) {
  const out = [];
  let on = false;
  for (const l of homeGit(home, ["show", `${commit}:CHANGELOG.md`]).split(/\r?\n/)) {
    if (/^#{1,2}\s/.test(l)) {
      const h = l.match(/^##\s+\[?(v?\d+\.\d+\.\d+)\]?/);
      on = !!h && newerThan(h[1], from) && !newerThan(h[1], to);
    }
    if (on && l.trim()) out.push(l.trim());
  }
  return out.length > max ? [...out.slice(0, max - 1), `… ${out.length - max + 1} more lines in CHANGELOG.md`] : out;
}

// configDir: a GH_CONFIG_DIR to run under (agentGhDir() runs it as the agents), else this process's login;
// token: a GH_TOKEN for this one call (the verifier App's), in the env only, never on the command line
const ghEnv = () => ({ ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" });
function gh(args, cwd, timeout = 6000, configDir = "", token = "") {
  const env = ghEnv();
  if (configDir) env.GH_CONFIG_DIR = configDir;
  if (token) env.GH_TOKEN = token;
  try { return execFileSync("gh", args, execOpts(cwd, timeout, env)).trim(); } catch { return ""; }
}
// gh as { ok, out, err }; configDir as gh() takes it, else this process's login
function ghTry(args, cwd, timeout = 6000, configDir = "") {
  const env = ghEnv();
  if (configDir) env.GH_CONFIG_DIR = configDir;
  return attempt(() => execFileSync("gh", args, { ...execOpts(cwd, timeout, env), stdio: ["ignore", "pipe", "pipe"] }));
}

const envInt = (name, dflt) => { const n = parseInt(process.env[name], 10); return Number.isFinite(n) && n > 0 ? n : dflt; };

// rules for every non-lead agent: nothing that ends a turn waiting for a wake-up that never comes
const WAIT_MSG = "workers never wait on a background notification (it never arrives after your turn ends). Run it in the foreground with timeout up to 600000 ms, or start it detached (nohup … &) and poll its PID/log in this same turn.";
const EDIT_LAST_MSG = "--edit-last edits the newest comment of the shared GitHub account, which may be another agent's or the lead's ruling. Post a new comment instead.";
function workerDenial(ev) {
  const secret = secretDenial(ev) || humanGhDenial(ev);
  if (secret) return secret;
  if (ev.tool === "monitor") return WAIT_MSG;
  if (ev.tool !== "shell") return null;
  if (postsVerdict(ev.command, shellCwd(ev))) return ev.agent || ev.teammate ? POST_MSG.agent : POST_MSG.worker;
  if (ev.background) return WAIT_MSG;
  if (editsLast(ev.command)) return EDIT_LAST_MSG;
  const cwd = shellCwd(ev);
  return verdictPost(ev.command, cwd) || signoffDenial(ev) || branchDenial(ev.command, cwd, leadDocsPush) || shellDenial(ev, cwd);
}
// agentShellDenial, with a worker's rules (#48): its writes confined, its inline code judged, a judging deadline,
// and a force-push its worktree's allow file authorises consumed once the call is let through
function shellDenial(ev, cwd) {
  const ctx = { worker: isWorkerShell(ev), clock: null, force: null };
  if (!ctx.worker) return agentShellDenial(ev, ev.command, cwd, 0, ctx);
  ctx.clock = { left: JUDGE_MS };
  let why;
  try { why = agentShellDenial(ev, ev.command, cwd, 0, ctx); } catch { return TOO_COMPLEX; }
  if (!why && ctx.force && !takeAllow(ctx.force, "force-push")) return AGENT_MSG.force(ctx.forceFlag);
  return why;
}
// a gh call (or node <hooks>/proteus-gh.js) carrying --edit-last, past wrappers and NAME=value, and inside sh -c,
// eval, $( ) and backticks. The flag as data passes: a heredoc body, a comment, a quoted argument to another
// program. Two cases err toward refusing, since shellCommands keeps no quote kind and no pipe target: a $( ) or
// backtick inside single quotes, and any word or heredoc body on a line that also runs sh, bash, … or eval
// (`bash <<EOF`, `echo … | sh`, `bash <<< …` run that text).
const HEREDOC_BODY = /<<-?[ \t]*(["']?)([\w.-]+)\1[^\n]*\n([\s\S]*?)(?:\n[ \t]*\2[ \t]*(?:\n|$)|$)/g;
function editsLast(command, depth = 0) {
  const cmd = String(command || "");
  if (!cmd.includes("--edit-last") || depth > 3) return false;
  const deeper = (t) => editsLast(t, depth + 1);
  const cmds = shellCommands(cmd).map((all) => [all, unwrap(all)]);
  const runsText = cmds.some(([, words]) => NESTED_SHELLS.has(progName(words[0])) || progName(words[0]) === "eval");
  if (runsText && [...cmd.matchAll(HEREDOC_BODY)].some((m) => deeper(m[3]))) return true;
  for (const [all, words] of cmds) {
    const prog = progName(words[0]);
    const gh = prog === "gh" || (prog === "node" && /(^|[\\/])proteus-gh\.js$/.test(words[1] || ""));
    if (gh && words.some((w) => /^--edit-last(?:=|$)/.test(w))) return true;
    if (prog === "eval" && deeper(words.slice(1).join(" "))) return true;
    for (const w of all) {
      const at = w.search(/\$\(|`/);
      if (at >= 0 && deeper(w.slice(at).replace(/^\$\(|^`/, ""))) return true;
      if (runsText && /\s/.test(w) && deeper(w)) return true;
    }
  }
  return false;
}
// proteus-signoff.js posts the verifier's verdict as the commit status the ruleset requires: only a verifier runs
// it, and --security (proteus/security) only the security verifier. agentTypeOf(ev) names the agent; a harness that
// does not say leaves it "", which passes, so the guard never blocks a verifier it cannot name. The lead's main
// thread is refused by proteus-lead-guard.js (signsOff). A guard, not a boundary: the token is the agents' one.
const SIGNOFF = /(^|[\\/])proteus-signoff\.js$/;
const signsOff = (command) => shellCommands(command).map(unwrap).find((w) => progName(w[0]) === "node" && SIGNOFF.test(w[1] || "")) || null;
// An agent type without the Proteus plugin's namespace: as a Claude Code plugin (#136) the agents are named
// proteus:<agent>. Only that namespace is stripped; another plugin's evil:proteus-verifier keeps its prefix and
// matches no Proteus role, since any plugin can ship an agent under a Proteus name.
const agentName = (type) => (typeof type === "string" ? type.replace(/^proteus:/, "") : "");
// The names a hook prints: from a plugin root (this file under CLAUDE_PLUGIN_ROOT, both resolved) the agents are
// proteus:<agent> and a skill is /proteus:<skill>; Codex runs a skill as $<skill> and keeps the installer's bare agents.
function inPlugin() {
  const r = process.env.CLAUDE_PLUGIN_ROOT;
  const rel = r ? path.relative(realOr(r), realOr(__dirname)) : "..";
  return !path.isAbsolute(rel) && rel.split(path.sep)[0] !== "..";
}
const onCodex = () => require(path.join(__dirname, "proteus-harness.js")).name === "codex";
const skillCommand = (skill = "proteus") => (onCodex() ? `$${skill}` : inPlugin() ? `/proteus:${skill}` : `/${skill}`);
const agentPrefix = () => (!onCodex() && inPlugin() ? "proteus:" : "");
const VERIFIER = /^proteus-(?:[a-z0-9-]+-)?verifier$/;
const isVerifier = (type) => VERIFIER.test(agentName(type));
const SIGNOFF_MSG = {
  lead: "proteus: proteus-signoff.js records a verifier's verdict; the lead never posts one. Spawn the verifier for the PR (flow.md step 6).",
  role: (t) => `proteus: proteus-signoff.js records a verifier's verdict, and ${t} is not a verifier. Report DONE; the lead spawns the verifier.`,
  security: (t) => `proteus: --security posts proteus/security, the security verifier's signoff; ${t} posts its own verdict without it.`,
};
// unnamed: what an agent the harness does not name gets; the worker guard passes the role message, since only a
// worker's session runs it
function signoffDenial(ev, unnamed = null) {
  const w = signsOff(ev.command);
  if (!w) return null;
  const type = agentTypeOf(ev); // a named spawn's subagent_type, not its name (#180)
  if (!type) return unnamed;
  if (!isVerifier(type)) return SIGNOFF_MSG.role(type);
  return w.includes("--security") && agentName(type) !== "proteus-security-verifier" ? SIGNOFF_MSG.security(type) : null;
}
// The verifier App's private key (#81) is no agent's: Read and Edit of it are refused, and so is a shell command
// naming it (its file name, so any path to it counts). An agent's shell never sets GH_TOKEN or GITHUB_TOKEN either
// (a token of the command's choosing on its gh calls). Lead and subagents alike. A guard, not a boundary: the agents
// run as the same OS user, so an interpreter, a glob or a variable still reaches the key (enforcement.md §1).
const KEY_MSG = (p) => `proteus: ${String(p).replace(/\\/g, "/")} is the verifier App's private key; no agent reads, edits or names it. proteus-signoff.js signs with it for the verifiers. Anything else that needs it is the human's.`;
const TOKEN_MSG = "proteus: agents never set GH_TOKEN or GITHUB_TOKEN: gh would post with a token of the command's choosing. Run gh as it is; a verifier's status comes from proteus-signoff.js.";
const TOKEN_VAR = /^(?:\$env:)?(?:GH|GITHUB)(?:_ENTERPRISE)?_TOKEN$/i;
const DECLARES = new Set(["export", "declare", "typeset", "readonly", "local", "set", "setx"]);
function secretDenial(ev) {
  const app = verifierApp();
  if (app && (ev.tool === "read" || ev.tool === "edit")) {
    const base = path.resolve(ev.cwd || projectRoot(ev));
    const key = [app.keyPath, realOr(app.keyPath)];
    for (const p of ev.paths && ev.paths.length ? ev.paths : [ev.path].filter(Boolean)) {
      const abs = path.resolve(base, String(p));
      if ([abs, realTarget(abs)].some((a) => a && key.some((k) => samePath(a, k)))) return KEY_MSG(app.keyPath);
    }
  }
  if (ev.tool !== "shell") return null;
  if (app && namesKey(ev.command, app.keyPath)) return KEY_MSG(app.keyPath);
  return setsToken(ev.command) ? TOKEN_MSG : null;
}
function namesKey(command, keyPath) {
  const fold = (s) => (process.platform === "win32" ? String(s).toLowerCase() : String(s));
  const cmd = fold(command);
  return [...new Set([path.basename(keyPath), path.basename(realOr(keyPath))])].some((n) => n && cmd.includes(fold(n)));
}
// NAME=v before a command or alone (env NAME=v too), PowerShell's $env:NAME=v, export / declare / set / setx NAME
// (fish's set -e erases, which passes); inside sh -c and eval too
function setsToken(command, depth = 0) {
  const cmd = String(command || "");
  if (!/(?:GH|GITHUB)(?:_ENTERPRISE)?_TOKEN/i.test(cmd) || depth > 3) return false;
  const named = (w) => TOKEN_VAR.test(String(w).split("=")[0]);
  for (const all of shellCommands(cmd)) {
    const words = unwrap(all), prog = progName(words[0]);
    if (all.slice(0, all.length - words.length).some((w) => w.includes("=") && named(w))) return true;
    if (/^\$env:/i.test(words[0] || "") && named(words[0])) return true;
    if (DECLARES.has(prog) && !(prog === "set" && words.some((w) => /^(?:-[a-z]*e[a-z]*|--erase)$/i.test(w))) && words.slice(1).some((w) => !w.startsWith("-") && named(w))) return true;
    const c = words.findIndex((w) => /^-[a-z]*c$/.test(w));
    if (NESTED_SHELLS.has(prog) && c > 0 && words[c + 1] !== undefined && setsToken(words[c + 1], depth + 1)) return true;
    if (prog === "eval" && setsToken(words.slice(1).join(" "), depth + 1)) return true;
  }
  return false;
}
// the lead's docs branch, proteus-work/<run>/lead-docs: CI lets its PR change the owned-path records
// (proteus-owned-check.js), so a worker never pushes it. A guard, not a boundary: the lead merges that PR with
// --match-head-commit, so a commit it did not push fails the merge.
const LEAD_DOCS_MSG = (b) => `proteus: ${b} is the lead's docs branch, whose PR may change the owned-path records under .proteus/owned/; only the lead pushes it. Push your own branch (proteus-work/<run>/<id>), or comment "NEEDS <path>: <why>" on the issue and stop.`;
const leadDocsPush = (dst) => (/^proteus-work\/[^/]+\/lead-docs$/i.test(dst) ? LEAD_DOCS_MSG(dst) : null);

// ACCEPT, CHANGES and ANSWER are the human's words (proteus-verdict.js): an agent's gh comment, PR review or
// comments API write whose body opens with one is refused. It judges what the command runs (#164): a gh or
// proteus-gh.js call that posts, its body from --body/-b, --body-file/-F, a body= field, --input, or stdin (a
// heredoc, a here-string, or echo/printf/cat piped in). Text carried elsewhere (a heredoc written to a file, a
// commit message, a quoted argument) is no post. What it cannot judge is refused: eval, a $( ) or $VAR as the
// program, xargs into gh, nesting past 3; sh -c '<literal>' is parsed and judged. A guard, not a boundary: the
// verdict script's author check is.
const HUMAN_WORD = /^\s*(ACCEPT|CHANGES|ANSWER)(?=\s|$)/;
const VERDICT_MSG = "proteus: ACCEPT, CHANGES and ANSWER are the human's words; agents never post them. Report to the lead, word the comment differently, or record a pick the human made in this session as `Answered in session: <pick>`. The human's own verdict goes out as `node <hooks>/proteus-verdict.js <issue> --post --body-file <file> --sha <sha256>` from their review session, which asks them first.";
const EVALS = new Set(["eval", "iex", "invoke-expression"]);
const isGh = (w) => { const p = progName(w); return p === "gh" || p === "proteus-gh.js"; };
const humanWord = (b) => { const t = String(b).replace(/^\$(?=[A-Z])/, ""); return HUMAN_WORD.test(t) || HUMAN_WORD.test(t.replace(/\\n/g, "\n")); };
// a command's words with the words an unquoted $( ) or ` ` split off after it; its stdin texts likewise
const fullWords = (cmds, c) => [...c, ...cmds.filter((x) => x.resumes === c).flatMap((x) => fullWords(cmds, x))];
const fullDocs = (cmds, c) => [...(c.stdin || []), ...cmds.filter((x) => x.resumes === c).flatMap((x) => fullDocs(cmds, x))];
function readBody(f, cwd) {
  try { return [fs.readFileSync(path.resolve(cwd || ".", expandPath(f, cwd || ".")), "utf8").slice(0, 4096)]; } catch { return []; }
}
// what a command prints, for echo, printf and cat (its files, its stdin); null for any other program
function printed(c, cwd, depth = 0) {
  const words = unwrap(c), prog = progName(words[0]);
  if (prog === "echo") { let a = words.slice(1); while (/^-[neE]+$/.test(a[0] || "")) a = a.slice(1); return [a.join(" ")]; }
  if (prog === "printf") return [words.slice(1).join(" "), words.slice(2).join(" ")];
  if (prog === "cat" || prog === "type" || prog === "get-content") {
    const files = words.slice(1).filter((w) => !w.startsWith("-"));
    const piped = !files.length && c.piped && depth < 4 ? printed(c.piped, cwd, depth + 1) || [] : [];
    return [...(c.stdin || []).map((d) => d.text), ...files.flatMap((f) => readBody(f, cwd)), ...piped];
  }
  return null;
}
// the text a $( ) or ` ` argument prints
function substText(v, cwd) {
  const inner = v.startsWith("`") ? v.replace(/^`|`$/g, "") : v.replace(/^\$\(/, "").replace(/\)\s*$/, "");
  return shellCommands(inner).flatMap((c) => printed(c, cwd) || []);
}
// the bodies a gh call (args after the gh word) posts as a comment or review; null when it posts none
function ghBodies(args, all, cmds, i, cwd) {
  const stdin = () => [...fullDocs(cmds, all).map((d) => d.text), ...(all.piped ? printed(all.piped, cwd) || [] : [])];
  const next = () => (cmds[i + 1] ? printed(cmds[i + 1], cwd) || [] : []);
  const value = (v) => (v === undefined || v === "$" ? next() : /^(?:\$\(|`)/.test(v) ? substText(v, cwd) : [v]);
  const file = (f) => (f === "-" ? stdin() : readBody(f, cwd));
  const out = [];
  const flagAt = (j, long, short) => {
    const a = args[j], m = new RegExp(`^(${long}|${short})(?:=([\\s\\S]*))?$`).exec(a) || new RegExp(`^(${short})([\\s\\S]+)$`).exec(a);
    return m ? { flag: m[1], v: m[2], takes: m[2] === undefined } : null;
  };
  if (((args[0] === "issue" || args[0] === "pr") && args[1] === "comment") || (args[0] === "pr" && args[1] === "review")) {
    for (let j = 2; j < args.length; j++) {
      const m = flagAt(j, "--body|--body-file", "-b|-F");
      if (!m) continue;
      const v = m.takes ? args[++j] : m.v;
      if (m.flag === "--body" || m.flag === "-b") out.push(...value(v));
      else if (v !== undefined) out.push(...file(v));
    }
    return out;
  }
  if (args[0] !== "api") return null;
  let { method, endpoint, path_ } = ghApi(args);
  if (method === "GET" && !args.some((a) => /^(?:-X|--method)/.test(a)) && args.some((a) => /^(?:-[fF].|--(?:raw-)?field=|--input=)/.test(a))) method = "POST";
  if (method === "GET" || !(endpoint === "graphql" || /(?:^|\/)(?:comments|reviews)(?:\/|$)/.test(path_))) return null;
  for (let j = 1; j < args.length; j++) {
    const m = flagAt(j, "--raw-field|--field|--input", "-f|-F");
    if (!m) continue;
    const v = m.takes ? args[++j] : m.v;
    if (v === undefined) continue;
    if (m.flag === "--input") {
      for (const t of file(v)) { try { const b = JSON.parse(t).body; out.push(typeof b === "string" ? b : t); } catch { out.push(t); } }
      continue;
    }
    const eq = v.indexOf("="), key = eq < 0 ? v : v.slice(0, eq), val = eq < 0 ? "" : v.slice(eq + 1);
    const typed = m.flag === "-F" || m.flag === "--field";
    if (key === "body") out.push(...(typed && val.startsWith("@") ? file(val.slice(1)) : value(val)));
    else if (key === "query") { const q = /\bbody\s*:\s*\\?"{1,3}\s*(ACCEPT|CHANGES|ANSWER)(?=[\s"\\]|$)/.exec(val); if (q) out.push(q[1]); }
  }
  return out;
}
// true when the command (or one it nests) posts the human's words, or cannot be judged
function postsWords(cmd, cwd, depth) {
  if (depth > 3) return true;
  const cmds = shellCommands(cmd);
  if (cmds.dynamic) return true;
  for (let i = 0; i < cmds.length; i++) {
    const all = cmds[i];
    if (all.resumes) continue; // judged with the command it goes on
    const words = unwrap(fullWords(cmds, all)), prog = progName(words[0]);
    if (!words.length) continue;
    if (words[0].startsWith("$") || EVALS.has(prog)) return true;
    const pre = all.slice(0, all.length - unwrap(all).length);
    if (pre.some((w) => progName(w) === "xargs") && words.some(isGh)) return true;
    // inline code (node -e, python -c) cannot be parsed here: read as text, as before #164
    if ((inlineCode(words) || []).some((t) => /\b(?:gh|proteus-gh\.js)\b/.test(t) && /ACCEPT|CHANGES|ANSWER/.test(t))) return true;
    if (NESTED_SHELLS.has(prog)) {
      const c = words.findIndex((w, k) => k > 0 && /^-[a-z]*c$/.test(w));
      if (c > 0) { if (words[c + 1] !== undefined && postsWords(words[c + 1], cwd, depth + 1)) return true; }
      else {
        for (const d of fullDocs(cmds, all)) if (postsWords(d.text, cwd, depth + 1)) return true;
        if (all.piped) { const p = printed(all.piped, cwd); if (p === null || p.some((t) => postsWords(t, cwd, depth + 1))) return true; }
      }
    }
    for (let k = 0; k < words.length; k++) {
      if (!isGh(words[k])) continue;
      const bodies = ghBodies(words.slice(k + 1), all, cmds, i, cwd);
      if (bodies && bodies.some(humanWord)) return true;
    }
  }
  return false;
}
function verdictPost(command, cwd) {
  const cmd = String(command || "");
  if (!/\b(?:gh|proteus-gh\.js)\b/.test(cmd) || !/ACCEPT|CHANGES|ANSWER|--body-file|-F|--field|--input|@|\$\(|`/.test(cmd)) return null;
  return postsWords(cmd, cwd, 0) ? VERDICT_MSG : null;
}

// ---- the human's verdict post (#157): `node <hooks>/proteus-verdict.js <issue> --post --body-file <f> --sha <sha256>`
// runs gh under the human's own config. The main session's hook asks the human first (humanPost); agents never
// run it, and never reach the human's gh config any other way (humanGhDenial). Guards, not a boundary: the
// agents run as the same OS user (enforcement.md §1); the boundary is the human's click and proteus-verdict.js's
// author check.

// gh's config dir the way gh resolves it: GH_CONFIG_DIR, else $XDG_CONFIG_HOME/gh, else %AppData%\GitHub CLI on
// Windows, else ~/.config/gh. env and platform are parameters so a test can fake win32.
function ghConfigDir(env = process.env, platform = process.platform) {
  const win = platform === "win32", p = win ? path.win32 : path.posix;
  const get = (k) => { const n = Object.keys(env).find((x) => (win ? x.toUpperCase() === k.toUpperCase() : x === k)); return n ? String(env[n] || "") : ""; };
  if (get("GH_CONFIG_DIR")) return p.resolve(get("GH_CONFIG_DIR"));
  if (get("XDG_CONFIG_HOME")) return p.join(get("XDG_CONFIG_HOME"), "gh");
  if (win && get("AppData")) return p.join(get("AppData"), "GitHub CLI");
  return p.join(os.homedir(), ".config", "gh");
}
// this process's env without GH_CONFIG_DIR (any case: Windows env names are case-blind)
const envSansGhDir = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== "GH_CONFIG_DIR"));
// the human's gh config dir: "humanGh" in proteus.json (a leading ~ allowed), else gh's default with the agents'
// GH_CONFIG_DIR removed
function humanGhDir() {
  const d = proteusConfig().humanGh;
  if (typeof d === "string" && d.trim()) return path.resolve(d.trim().replace(/^~(?=$|[\\/])/, () => os.homedir()));
  return ghConfigDir(envSansGhDir());
}
// gh as the human: GH_CONFIG_DIR removed, or set to "humanGh". input: stdin for the call
function ghHuman(args, cwd, { input, timeout = 15000 } = {}) {
  const env = { ...envSansGhDir(), GH_PROMPT_DISABLED: "1", NO_COLOR: "1" };
  const own = proteusConfig().humanGh;
  if (typeof own === "string" && own.trim()) env.GH_CONFIG_DIR = humanGhDir();
  const r = spawnSync("gh", args, { cwd, input, encoding: "utf8", timeout, windowsHide: true, env });
  return { ok: r.status === 0, out: String(r.stdout || "").trim(), err: String(r.stderr || "").trim() || (r.error ? r.error.message : "") };
}
// who a --post would post as: { login, human, error }; error says how to fix it, "" when login is the human
function humanLogin(cwd) {
  const dir = humanGhDir(), human = String(proteusConfig().human || "").trim();
  const login = ghHuman(["api", "user", "--jq", ".login"], cwd).out;
  const fix = `in your own terminal run \`gh auth login\`${human ? ` (or \`gh auth switch --user ${human}\`)` : ""}, or set "humanGh" in ${configFile()} to the gh config dir you log in with`;
  if (!human && agentGhDir()) return { login, human, error: `no "human" in ${configFile()} beside agentGh; install.js --agent-login writes it` };
  if (!login) return { login, human, error: `gh in ${fwd(dir)} is not logged in: ${fix}` };
  if (human && login !== human) return { login, human, error: `gh in ${fwd(dir)} is logged in as ${login}, not ${human}: ${fix}` };
  return { login, human: human || login, error: "" };
}
// the human's gh dir as a guarded path, only while the agents have a login of their own (agentGh): { human, agent }, else null
function humanGhGuard() {
  const agent = agentGhDir();
  if (!agent) return null;
  const human = humanGhDir();
  return samePath(realOr(human), realOr(agent)) ? null : { human, agent };
}
const inDir = (dir, p) => (relPath(realOr(dir), p) ?? relPath(dir, p)) !== null;
// p (absolute) as a forward-slash path when it is in the human's gh dir and not in the agents' own, else ""
function inHumanGh(p, g = humanGhGuard()) {
  return g && p && inDir(g.human, p) && !inDir(g.agent, p) ? fwd(p) : "";
}
const HUMAN_GH_MSG = {
  path: (p) => `${p} is in the human's gh config (their GitHub login); no agent reads, writes or names it. Agents post as their own login; the human's verdicts go out through proteus-verdict.js --post, which the human approves.`,
  env: "agents never set or unset GH_CONFIG_DIR or GH_HOST, nor clear the environment with env -i: their gh runs under the agents' login, and only proteus-verdict.js --post, which the human approves, posts as the human.",
  auth: (w) => `\`gh ${w}\` can reach past the agents' own login (gh keeps one keyring entry per host for every config dir); agents never run it. \`gh auth status\` shows who they are.`,
};
const GH_VAR = /^(?:\$?env:)?GH_(?:CONFIG_DIR|HOST)$/i;
const UNSETS = new Set(["unset", "remove-item", "ri", "del", "rm", "rv", "remove-variable", "clear-item"]);
// sets, unsets or clears GH_CONFIG_DIR or GH_HOST: NAME=v before a command or alone, $env:NAME=v, export / declare /
// set / setx / unset NAME (fish's set -e too), env -u NAME or env -i, PowerShell's Remove-Item env:NAME; inside
// sh -c and eval too. Reading it ($GH_CONFIG_DIR, grep GH_CONFIG_DIR) passes.
function movesGhEnv(command, depth = 0) {
  const cmd = String(command || "");
  if (depth > 3 || !/GH_(?:CONFIG_DIR|HOST)|\benv\b/i.test(cmd)) return false;
  const named = (w) => GH_VAR.test(String(w).split("=")[0]);
  for (const all of shellCommands(cmd)) {
    const words = unwrap(all), prog = progName(words[0]), pre = all.slice(0, all.length - words.length);
    if (pre.some((w) => w.includes("=") && named(w))) return true;
    for (let i = 0; i < pre.length; i++) {
      if (progName(pre[i]) !== "env") continue;
      for (let j = i + 1; j < pre.length && pre[j].startsWith("-"); j++) {
        const a = pre[j];
        if (/^(?:-[a-zA-Z]*i[a-zA-Z]*|--ignore-environment|-)$/.test(a)) return true;
        if ((a === "-u" || a === "--unset") && named(pre[j + 1])) return true;
        if (/^(?:-u|--unset=)/.test(a) && named(a.replace(/^(?:-u|--unset=)/, ""))) return true;
      }
    }
    if (/^\$env:/i.test(words[0] || "") && named(words[0])) return true;
    if ((DECLARES.has(prog) || UNSETS.has(prog)) && words.slice(1).some((w) => !w.startsWith("-") && named(w))) return true;
    const c = words.findIndex((w) => /^-[a-z]*c$/.test(w));
    if (NESTED_SHELLS.has(prog) && c > 0 && words[c + 1] !== undefined && movesGhEnv(words[c + 1], depth + 1)) return true;
    if (prog === "eval" && movesGhEnv(words.slice(1).join(" "), depth + 1)) return true;
  }
  return false;
}
const GH_AUTH_REACH = new Set(["login", "logout", "switch", "token", "refresh"]);
// an agent reaching the human's gh identity: a Read or Edit in the human's gh dir; a shell command naming that
// dir, setting or unsetting GH_CONFIG_DIR or GH_HOST, passing gh --hostname, or running gh auth login/logout/switch/token/refresh.
// Only with agentGh set: under one shared login there is nothing to keep apart. Lead and subagents alike.
function humanGhDenial(ev) {
  const g = humanGhGuard();
  if (!g) return null;
  const base = path.resolve(ev.cwd || projectRoot(ev));
  if (ev.tool === "read" || ev.tool === "edit") {
    for (const p of ev.paths && ev.paths.length ? ev.paths : [ev.path].filter(Boolean)) {
      const abs = path.resolve(base, String(p)), hit = inHumanGh(abs, g) || inHumanGh(realTarget(abs), g);
      if (hit) return HUMAN_GH_MSG.path(hit);
    }
    return null;
  }
  if (ev.tool !== "shell") return null;
  const cmd = String(ev.command || "");
  if (movesGhEnv(cmd)) return HUMAN_GH_MSG.env;
  const dir = shellCwd(ev);
  for (const all of shellCommands(cmd)) {
    const words = unwrap(all), prog = progName(words[0]);
    const gh = prog === "gh" || (prog === "node" && /(^|[\\/])proteus-gh\.js$/.test(words[1] || ""));
    const args = gh ? words.slice(prog === "gh" ? 1 : 2) : [];
    if (args.some((w) => /^--hostname(?:=|$)/.test(w))) return HUMAN_GH_MSG.auth("--hostname");
    if (args[0] === "auth" && GH_AUTH_REACH.has(args[1])) return HUMAN_GH_MSG.auth(`auth ${args[1]}`);
    for (const w of [...all, ...(all.redirects || [])]) {
      for (const t of new Set([w, String(w).split("=").pop()])) {
        if (!/[\\/~]|^\$/.test(t)) continue;
        for (const p of spellings(t, dir)) {
          const hit = inHumanGh(p, g) || inHumanGh(realTarget(p), g);
          if (hit) return HUMAN_GH_MSG.path(hit);
        }
      }
    }
  }
  return null;
}

const POST_SCRIPT = path.join(__dirname, "proteus-verdict.js");
const POST_MAX = 65536; // GitHub's comment limit, in characters; bytes here, a little stricter
const VERDICT_LINE = /^(ACCEPT|CHANGES|ANSWER)(?=\s|$)/;
const POST_MSG = {
  agent: "proteus-verdict.js --post posts the human's verdict under the human's own login; only the human's main session runs it, after the human approves. Report the verdict text to the lead or the human instead.",
  worker: "proteus-verdict.js --post never runs from a worker's worktree: workers never post verdicts. The human's review session posts it.",
};
// node (or the script itself) running proteus-verdict.js with a --post argument, judged on what the command runs
// (#164): a commit message or a grep naming both is no post. What it cannot judge counts as one, so the gate
// refuses it: eval, a $( ) or $VAR as the program, xargs into the script, inline code naming it, nesting past 3.
const RUNNERS = new Set(["node", "nodejs", "bun", "deno"]);
const isVerdictScript = (w) => /proteus-verdict(?:\.js)?$/.test(progName(w));
function runsPost(cmd, cwd, depth) {
  if (depth > 3) return true;
  const cmds = shellCommands(cmd);
  if (cmds.dynamic) return true;
  for (const all of cmds) {
    if (all.resumes) continue; // judged with the command it goes on
    const words = unwrap(fullWords(cmds, all)), prog = progName(words[0]);
    if (!words.length) continue;
    if (words[0].startsWith("$") || EVALS.has(prog)) return true;
    const pre = all.slice(0, all.length - unwrap(all).length);
    if (pre.some((w) => progName(w) === "xargs") && (RUNNERS.has(prog) || isVerdictScript(words[0]))) return true;
    if ((inlineCode(words) || []).some((t) => /proteus-verdict/.test(t))) return true;
    if (NESTED_SHELLS.has(prog)) {
      const c = words.findIndex((w, k) => k > 0 && /^-[a-z]*c$/.test(w));
      if (c > 0) { if (words[c + 1] !== undefined && runsPost(words[c + 1], cwd, depth + 1)) return true; }
      else {
        for (const d of fullDocs(cmds, all)) if (runsPost(d.text, cwd, depth + 1)) return true;
        if (all.piped) { const p = printed(all.piped, cwd); if (p === null || p.some((t) => runsPost(t, cwd, depth + 1))) return true; }
      }
    }
    for (let k = 0; k < words.length; k++) {
      if (!isVerdictScript(words[k]) || !(k === 0 || words.slice(0, k).some((w) => RUNNERS.has(progName(w))))) continue;
      if (words.slice(k + 1).some((a) => /^--post(?:=|$)/.test(a))) return true;
    }
  }
  return false;
}
const postsVerdict = (command, cwd = ".") => { const cmd = String(command || ""); return /proteus-verdict/.test(cmd) && /--post\b/.test(cmd) && runsPost(cmd, cwd, 0); };
const quoteArg = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
const postCommand = (issue, file, sha) => `node ${quoteArg(fwd(POST_SCRIPT))} ${issue} --post --body-file ${quoteArg(fwd(file))} --sha ${sha}`;
// { issue, file, sha } from the one accepted usage, `node <this hooks dir>/proteus-verdict.js <issue> --post
// --body-file <f> [--sha <h>]` alone on the line; else { error }
function postArgs(command, dir) {
  const cmd = String(command || "");
  const usage = `run it alone, exactly as \`node <hooks>/proteus-verdict.js <issue> --post --body-file <file> --sha <sha256>\`, nothing before or after it`;
  const cmds = shellCommands(cmd);
  if (cmds.length !== 1 || /`|\$\(|<\(|>\(/.test(cmd) || (cmds[0].redirects || []).length) return { error: `proteus-verdict.js --post: ${usage}.` };
  const all = cmds[0];
  if (unwrap(all).length !== all.length || progName(all[0]) !== "node") return { error: `proteus-verdict.js --post: ${usage}.` };
  const script = path.resolve(dir, expandPath(all[1] || "", dir));
  if (!samePath(realOr(script), realOr(POST_SCRIPT))) return { error: `proteus-verdict.js --post runs only as this install's script, ${fwd(POST_SCRIPT)}: ${usage}.` };
  const out = { issue: "", file: "", sha: "" };
  let post = false;
  for (let i = 2; i < all.length; i++) {
    const a = all[i], m = /^(--body-file|--sha)=(.*)$/.exec(a);
    if (/^\d+$/.test(a) && !out.issue) out.issue = a;
    else if (a === "--post") post = true;
    else if (m) out[m[1] === "--sha" ? "sha" : "file"] = m[2];
    else if ((a === "--body-file" || a === "--sha") && i + 1 < all.length) out[a === "--sha" ? "sha" : "file"] = all[++i];
    else return { error: `proteus-verdict.js --post: unexpected ${a}; ${usage}.` };
  }
  if (!post || !out.issue || !out.file || out.file === "-") return { error: `proteus-verdict.js --post needs the issue and --body-file <file>; ${usage}.` };
  out.file = path.resolve(dir, expandPath(out.file, dir));
  out.sha = out.sha.toLowerCase();
  return out;
}
// the gate on the human's verdict post, for a shell call: null when the command is no --post; else { ask } with
// the dialog text for the human, or { deny } with why. Reads the body file once: the hash it checks and the
// lines it shows come from the same bytes, and --post refuses a file whose hash no longer matches.
// ad: the harness adapter, whose noAsk(ev) says why a PreToolUse "ask" would show the human no dialog here.
function humanPost(ev, ad) {
  if (ev.tool !== "shell" || !postsVerdict(ev.command, shellCwd(ev))) return null;
  if (ev.agent || ev.teammate) return { deny: POST_MSG.agent };
  const dir = shellCwd(ev);
  for (const r of new Set([projectRoot(ev), gitRoot(dir)].filter(Boolean))) if (isLinked(r) && fs.existsSync(ownedFile(r))) return { deny: POST_MSG.worker };
  const p = postArgs(ev.command, dir);
  if (p.error) return { deny: p.error };
  let body;
  try { body = fs.readFileSync(p.file); } catch { return { deny: `proteus-verdict.js --post: cannot read ${fwd(p.file)}; write the verdict to that file first.` }; }
  if (body.length > POST_MAX) return { deny: `proteus-verdict.js --post: ${fwd(p.file)} is over ${POST_MAX} bytes, more than one GitHub comment holds; shorten it.` };
  const text = body.toString("utf8"), lines = text.replace(/\s+$/, "").split(/\r?\n/);
  if (!VERDICT_LINE.test(lines[0].trim())) return { deny: "a verdict's first line is ACCEPT, CHANGES, CHANGES revision or ANSWER <pick>; fix the body file's first line." };
  const sha = require("crypto").createHash("sha256").update(body).digest("hex");
  const cmd = postCommand(p.issue, p.file, sha);
  if (p.sha !== sha) return { deny: `${fwd(p.file)} has sha256 ${sha}${p.sha ? `, not ${p.sha} (the file changed since?)` : ""}. Run: ${cmd}` };
  const why = ad && typeof ad.noAsk === "function" ? ad.noAsk(ev) : "this CLI's adapter cannot ask";
  if (why) return { deny: `the human approves each verdict post in a permission dialog, and none can appear here (${why}). The human runs it in their own terminal, where it posts as their own gh login: ${cmd}` };
  const who = humanLogin(dir);
  if (who.error) return { deny: `proteus-verdict.js --post would not post as the human: ${who.error}. Nothing was posted.` };
  const title = gh(["issue", "view", p.issue, "--json", "title", "-q", ".title"], dir, 6000, agentGhDir()) || "(title unavailable)";
  const SHOW = 12, shown = lines.slice(0, SHOW).map((l) => `  ${l.slice(0, 200)}`);
  if (lines.length > SHOW) shown.push(`  … ${lines.length - SHOW} more lines in ${fwd(p.file)}`);
  return { ask: `Proteus: post this verdict on #${p.issue} "${title.slice(0, 120)}" as ${who.login}? Approve only if it is what you said.\n${shown.join("\n")}\n(sha256 ${sha.slice(0, 12)}; --post refuses the file if it changes)` };
}

// a command line as simple commands, each a list of words: quotes removed, split at ; & | ( ) ` and newlines,
// comments and heredoc bodies skipped. Enough to find a git or gh call and its arguments; not a shell.
// An output redirect (>, >>, >|, &>, N>, >&file) is no word: its target goes on the command's .redirects list,
// and a >&N descriptor copy is dropped. A > inside $(( )), (( )) or [[ ]] compares, so it is no redirect, unless
// its operand names a literal path: dash, a common sh, has neither and runs `((x > f))` as subshells. With a clock ({left: ms}), the time spent comes off clock.left, and
// running past it throws tooComplex (a worker's judging deadline, #48).
// For the guards that judge what a command runs (verdictPost, postsVerdict), each command also carries: .stdin, its
// heredoc and here-string texts ({ text }); .piped, the command piping into it; .resumes, the command an unquoted
// $( ) or ` ` split, whose words go on after it. The list's .dynamic is true when a $( ) or ` ` is a program.
const tooComplex = () => Object.assign(new Error("too complex"), { tooComplex: true });
function shellCommands(command, clock = null) {
  const s = String(command || "");
  const t0 = clock ? performance.now() : 0;
  const late = () => clock && performance.now() - t0 > clock.left;
  try { return tokens(s, clock && late); } finally { if (clock) clock.left -= performance.now() - t0; }
}
function tokens(s, late) {
  const out = [];
  let words = [], word = null, heredocs = [], redirs = [], redir = "", arith = 0, cond = false;
  let docs = [], hereStr = false, pipeIn = null, pipeNext = false, resume = null, bt = null;
  const subs = [];
  const endWord = () => {
    if (hereStr && word !== null) { docs.push({ text: word }); hereStr = false; }
    if (word === "[[" && !words.length && !redir) cond = true;
    else if (word === "]]" && !redir) cond = false;
    if (word !== null && redir === "cmp") {
      if (/^(?:[.~]|\$(?:\{?(?:HOME|PWD)\b))|^[^$`]*[\\/]/.test(word) && !/[$`](?!\{?(?:HOME|PWD)\b)/.test(word)) redirs.push(word);
      else words.push(word);
      redir = "";
    } else if (word !== null && !redir) words.push(word);
    else if (word !== null) { if (redir === "file" || !/^(?:\d+|-)$/.test(word)) redirs.push(word); redir = ""; }
    word = null;
  };
  const endCmd = () => {
    endWord(); redir = "";
    if (words.length || redirs.length) {
      out.push(Object.assign(words, { redirects: redirs, stdin: docs, piped: pipeNext ? pipeIn : null, resumes: resume }));
      pipeNext = false; resume = null;
    }
    words = []; redirs = []; docs = [];
  };
  // a $( or ` opening where the program goes: the command runs whatever it prints
  const atProgram = () => { if (resume) return false; const u = unwrap(word === null ? words : [...words, word]); return word === null ? !u.length : u.length === 1 && u[0] === word; };
  for (let i = 0; i < s.length; i++) {
    if (late && !(i & 1023) && late()) throw tooComplex();
    const c = s[i];
    if (c === "\\") {
      if (s[i + 1] !== "\n") word = (word ?? "") + (s[i + 1] ?? "");
      i++;
    } else if (c === "'") {
      const j = s.indexOf("'", i + 1);
      const e = j < 0 ? s.length : j;
      word = (word ?? "") + s.slice(i + 1, e);
      i = e;
    } else if (c === '"') {
      let j = i + 1, v = "";
      for (; j < s.length && s[j] !== '"'; j++) {
        if (s[j] === "\\" && j + 1 < s.length && "\"\\$`\n".includes(s[j + 1])) j++;
        v += s[j];
      }
      word = (word ?? "") + v;
      i = j;
    } else if (s.startsWith("<<<", i)) {
      endWord();
      hereStr = true;
      i += 2;
    } else if (s.startsWith("<<", i)) {
      endWord();
      const m = /^<<-?[ \t]*(["']?)([\w.-]+)\1/.exec(s.slice(i));
      if (m) { const doc = { text: "" }; docs.push(doc); heredocs.push([m[2], doc]); }
      i += m ? m[0].length - 1 : 1;
    } else if (c === "\n") {
      endCmd();
      resume = null;
      for (const [d, doc] of heredocs) {
        let k = i + 1;
        const lines = [];
        for (;;) {
          if (late && late()) throw tooComplex();
          const nl = s.indexOf("\n", k);
          const line = s.slice(k, nl < 0 ? s.length : nl);
          k = nl < 0 ? s.length : nl + 1;
          if (line.trim() === d) break;
          lines.push(line);
          if (nl < 0) break;
        }
        doc.text = lines.join("\n");
        i = k - 1;
      }
      heredocs = [];
    } else if (c === "(" && s[i + 1] === "(" && !redir) {
      // $(( )) and (( )): arithmetic, where > and < compare
      arith++;
      i++;
      endCmd();
    } else if (c === ")" && s[i + 1] === ")" && arith) {
      arith--;
      i++;
      endCmd();
    } else if ((arith || cond) && c === ">") {
      // a comparison or shift (>, >=, >>), unless the operand is a literal path
      endWord();
      while (s[i + 1] === ">" || s[i + 1] === "=") i++;
      redir = "cmp";
    } else if (c === ">" || (c === "&" && s[i + 1] === ">")) {
      if (word !== null && /^\d+$/.test(word)) word = null; // 2>file: the descriptor, not a word
      endWord();
      if (c === "&") i++;
      if (s[i + 1] === ">" || s[i + 1] === "|") i++;
      redir = s[i + 1] === "&" ? "dup" : "file";
      if (redir === "dup") i++;
    } else if (";&|()`".includes(c)) {
      // `cmd` or $(cmd) as (part of) a redirect target: kept in it, so the target reads as built at runtime
      const sub = !redir && (c === "`" ? bt === null : c === "(" && word !== null && word.endsWith("$"));
      if (sub && atProgram()) out.dynamic = true;
      if (redir && (c === "`" || c === "(")) word = (word ?? "") + c;
      const had = out.length;
      endCmd();
      const last = out.length > had ? out[out.length - 1] : null;
      resume = null;
      if (c === "|") { pipeNext = s[i + 1] !== "|" && s[i - 1] !== "|"; pipeIn = last; }
      else if (c === "(") subs.push(sub ? last : null);
      else if (c === ")") resume = subs.pop() || null;
      else if (c === "`" && bt === null) bt = { outer: last };
      else if (c === "`") { resume = bt.outer; bt = null; }
    }
    else if (c === " " || c === "\t" || c === "\r") endWord();
    else if (c === "#" && word === null) {
      const nl = s.indexOf("\n", i);
      i = (nl < 0 ? s.length : nl) - 1;
    } else word = (word ?? "") + c;
  }
  endCmd();
  return out;
}

// The branches a run's work must reach only through a PR with `gates` green (enforcement.md §1): agents never merge
// with --admin, never push to main or update a run branch (creating proteus/<run> is the lead's one push), never
// delete either, and never lift or rewrite branch protection or a ruleset. The ruleset install.js --protect adds is
// the boundary; this stops a confused or injected agent before GitHub has to, and binds the shared-identity setup
// that has no ruleset.
const BRANCH_MSG = {
  admin: "proteus: `gh pr merge --admin` merges around the required `gates` check. Wait for it (`gh pr checks <pr> --watch`) or send the ticket back; a check that cannot pass is a NEEDS for the human.",
  protect: "proteus: agents never lift or rewrite branch protection or a ruleset (enforcement.md §1). The one write allowed is the per-run PUT on `branches/proteus%2F<run>/protection`; at close the human deletes it, with the command in the close PR.",
  status: "proteus: a commit status or check run on a PR is a verdict the run branch's ruleset requires (proteus/verdict, proteus/security); nobody posts one by hand. A verifier records its verdict with `node <hooks>/proteus-signoff.js <pr> <sha> <WORD>`; CI posts the rest.",
  bare: "proteus: a bare `git push` here has no branch the guard can read (a detached HEAD, or no checkout of this project); push by name: `git push origin <branch>`.",
  wide: (flag) => `proteus: \`git push ${flag}\` can reach main or a run branch; push one branch by name.`,
  main: (b) => `proteus: agents never push to ${b}; a run reaches it only as the close PR the human merges.`,
  del: (b) => `proteus: agents never delete ${b}; the human does at close.`,
  run: (b, remote) => `proteus: ${b} changes only by a PR with \`gates\` green: push your own branch (proteus-work/<run>/<id>) and open a PR into ${b}. The one push to a run branch creates it at the start of the run (no ${remote}/${b} yet; \`git fetch --prune\` if it was deleted).`,
};
// words that run the rest of the line as a command, each with its options that take the next word as a value;
// timeout also takes a DURATION before the command. xargs appends words from stdin, which no guard can see.
const WRAPPERS = new Map(Object.entries({
  rtk: [], proxy: [], command: [], builtin: [], nohup: [], busybox: [], exec: ["-a"], time: ["-f", "--format", "-o", "--output"],
  env: ["-u", "--unset", "-C", "--chdir", "-S", "--split-string", "-P"],
  sudo: ["-u", "--user", "-g", "--group", "-C", "--close-from", "-D", "--chdir", "-h", "--host", "-p", "--prompt", "-r", "--role", "-t", "--type", "-U", "--other-user", "-T", "--command-timeout", "-R", "--chroot"],
  timeout: ["-s", "--signal", "-k", "--kill-after"], nice: ["-n", "--adjustment"], stdbuf: ["-i", "--input", "-o", "--output", "-e", "--error"],
  xargs: ["-a", "--arg-file", "-d", "--delimiter", "-E", "-I", "-L", "--max-lines", "-n", "--max-args", "-P", "--max-procs", "-s", "--max-chars", "--process-slot-var"],
}));
const WRAPPER_POSITIONAL = new Map([["timeout", 1]]);
const progName = (w) => String(w || "").split(/[\\/]/).pop().replace(/\.exe$/i, "").toLowerCase();
// a simple command's words from the program it runs: past wrappers, their options and positionals, and NAME=value
// assignments. env -S STRING runs STRING split at whitespace, so it is spliced back in.
function unwrap(all) {
  const words = all.slice();
  let i = 0, opts = null, pos = 0;
  while (i < words.length) {
    const a = words[i], name = progName(a);
    if (WRAPPERS.has(name)) { opts = WRAPPERS.get(name); pos = WRAPPER_POSITIONAL.get(name) || 0; i++; }
    else if (!pos && /^[A-Za-z_]\w*=/.test(a)) i++;
    else if (opts && a === "--") { opts = null; i++; }
    else if (opts && a.startsWith("-")) {
      const eq = a.startsWith("--") ? a.indexOf("=") : -1;
      const flag = eq > 0 ? a.slice(0, eq) : a;
      const takes = opts.includes(flag), n = !takes || eq > 0 ? 1 : 2;
      if (takes && (flag === "-S" || flag === "--split-string")) words.splice(i, n, ...String(eq > 0 ? a.slice(eq + 1) : words[i + 1] || "").split(/\s+/).filter(Boolean));
      else i += n;
    } else if (pos) { pos--; i++; }
    else break;
  }
  return words.slice(i);
}
const GH_API_VALUE = new Set(["-X", "--method", "-H", "--header", "-f", "--raw-field", "-F", "--field", "--input", "-q", "--jq", "-t", "--template", "--hostname", "--cache", "-p", "--preview"]);
const GIT_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"]);
const PUSH_VALUE = new Set(["--repo", "-o", "--push-option", "--receive-pack", "--exec"]);

function branchDenial(command, cwd, extra) {
  const cmd = String(command || "");
  if (!/\b(gh|git)\b/.test(cmd)) return null;
  // the dir each command runs in, moved by a cd on the way (a subagent's calls start in the lead's checkout); lost
  // after a cd the guard cannot follow, so a bare push there has no branch to read (#221)
  let dir = path.resolve(cwd || "."), lost = false;
  for (const all of shellCommands(cmd)) {
    let words = unwrap(all);
    let prog = progName(words[0]);
    if (prog === "cd" || prog === "pushd") {
      const to = words.slice(1).find((w) => !w.startsWith("-") || w === "-") || "~";
      if (to === "-" || unexpanded(to, dir)) lost = true;
      else dir = path.resolve(dir, expandPath(to, dir));
      continue;
    }
    // node <hooks>/proteus-gh.js <args> is gh with retries: same rules
    if (prog === "node" && /(^|[\\/])proteus-gh\.js$/.test(words[1] || "")) { words = words.slice(1); prog = "gh"; }
    const why = prog === "gh" ? ghBranchDenial(words.slice(1)) : prog === "git" ? pushDenial(words.slice(1), dir, extra, lost) : null;
    if (why) return why;
  }
  return null;
}

function ghBranchDenial(args) {
  if (args[0] === "pr" && args[1] === "merge" && args.includes("--admin")) return BRANCH_MSG.admin;
  if (args[0] !== "api") return null;
  const { method, endpoint, path_ } = ghApi(args);
  if (endpoint === "graphql") return /\b(delete|update)(BranchProtectionRule|RepositoryRuleset)\b/.test(args.join(" ")) ? BRANCH_MSG.protect : null;
  if (method === "GET") return null;
  if (/(^|\/)rulesets(\/|$)/.test(path_)) return BRANCH_MSG.protect;
  if (/(?:^|\/)(?:statuses\/[^/]+|check-runs(?:\/.*)?)$/.test(path_)) return BRANCH_MSG.status;
  const p = /(?:^|\/)branches\/([^/]+)\/protection(\/.*)?$/.exec(path_);
  if (!p) return null;
  let branch = p[1];
  try { branch = decodeURIComponent(branch); } catch {}
  const runPut = method === "PUT" && !p[2] && SCHEMES.some((s) => branch.startsWith(s.branch));
  return runPut ? null : BRANCH_MSG.protect;
}

// gh api <args>: its method (GET unless -X or a body field says otherwise), endpoint, and the endpoint's path
function ghApi(args) {
  let method = "", endpoint = "", body = false;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    const eq = /^(--[\w-]+)=([\s\S]*)$/.exec(a);
    const [flag, val] = eq ? [eq[1], eq[2]] : /^-X./.test(a) ? ["-X", a.slice(2)] : [a, undefined];
    if (GH_API_VALUE.has(flag)) {
      const v = val === undefined ? args[++i] : val;
      if (flag === "-X" || flag === "--method") method = String(v || "").toUpperCase();
      else if (!/^(-H|--header|-q|--jq|-t|--template|--hostname|--cache|-p|--preview)$/.test(flag)) body = true;
    } else if (!a.startsWith("-") && !endpoint) endpoint = a;
  }
  return { method: method || (body ? "POST" : "GET"), endpoint, path_: endpoint.replace(/[?#].*$/, "").replace(/\/+$/, "") };
}

// git <global options> push …: each destination it would write, judged against main and the run branches
// extra(dst), when given, may refuse a destination neither main nor a run branch; lost: cwd is not where it runs
function pushDenial(words, cwd, extra, lost = false) {
  let i = 0, dir = cwd, built = "";
  for (; i < words.length && words[i].startsWith("-"); i++) {
    const v = words[i] === "-C" ? words[++i] : words[i].startsWith("-C") ? words[i].slice(2) : null;
    if (v === null) { if (GIT_VALUE.has(words[i])) i++; continue; }
    if (v === undefined || unexpanded(v, dir)) built ||= `git -C ${v || ""}`.trim(); // #220: not a path to resolve
    else dir = path.resolve(dir, expandPath(v, dir));
  }
  if (words[i] !== "push") return null;
  if (built) return UNEXPANDED_MSG(built);
  const args = words.slice(i + 1);
  let del = false;
  const pos = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === "--") { pos.push(...args.slice(k + 1)); break; }
    if (PUSH_VALUE.has(a)) k++;
    else if (a === "--delete" || /^-[a-zA-Z]*d[a-zA-Z]*$/.test(a)) del = true;
    else if (/^--(all|branches|mirror|prune)$/.test(a)) return BRANCH_MSG.wide(a);
    else if (!a.startsWith("-")) pos.push(a);
  }
  const g = (...a) => git(a, dir);
  const cur = lost ? "" : branchOf(dir);
  const remote = pos[0] || (cur && g("config", "--get", `branch.${cur}.remote`)) || "origin";
  let specs = pos.slice(1);
  // a bare push (or remote only) is judged as the branch checked out where it runs, read from that checkout's own
  // HEAD (branchOf, #215), not from an upstream a worker branch cut from origin/main points at (#221)
  if (!specs.length && !del) {
    if (!cur) return BRANCH_MSG.bare;
    specs = [cur];
  }
  for (const spec of specs) {
    const s = spec.replace(/^\+/, "");
    const at = s.indexOf(":");
    const src = del ? "" : at < 0 ? s : s.slice(0, at);
    let dst = del || at < 0 ? s : s.slice(at + 1) || src;
    if (dst === "HEAD" || dst === "@") dst = cur;
    dst = String(dst || "").replace(/^refs\/heads\//, "");
    if (!dst || dst.startsWith("refs/")) continue;
    const more = extra && extra(dst);
    if (more) return more;
    const kind = guardedBranch(dst, dir, remote, g);
    if (!kind) continue;
    if (!src) return BRANCH_MSG.del(dst);
    if (kind === "main") return BRANCH_MSG.main(dst);
    // creating a run branch is allowed: no remote-tracking ref for it, under a remote this repo names
    if (!g("config", "--get", `remote.${remote}.url`) || g("rev-parse", "--verify", "-q", `refs/remotes/${remote}/${dst}`)) return BRANCH_MSG.run(dst, remote);
  }
  return null;
}

// "main" for main, master or the remote's default branch; "run" for a run branch under either scheme (not a
// pre-rename worker branch <prefix><run>-<id>); "" for anything else
function guardedBranch(dst, dir, remote, g) {
  const head = g("symbolic-ref", "-q", "--short", `refs/remotes/${remote}/HEAD`).slice(remote.length + 1);
  if (dst === "main" || dst === "master" || dst === head) return "main";
  if (!SCHEMES.some((s) => dst.startsWith(s.branch))) return "";
  return runBranches(gitCommonDir(dir)).some((a) => a !== dst && dst.startsWith(a + "-")) ? "" : "run";
}

// ---- a subagent's shell (workerDenial, so both guards): no force-push, no git aimed at another checkout, and no
// write to what AGENT_NEVER guards. The Edit and Write hooks check owned paths; a shell write reaches none of
// them, so these name the writes that would let a worker rewrite its own rules. Paths resolve against the cwd
// after a leading `cd <dir> &&` chain (Claude Code starts every subagent call in the lead's checkout), from the
// shell's workdir when the harness reports one (Codex). The command xargs or find -exec runs is judged too, with {}
// as find's start points; so are git checkout/restore from another commit, git apply/am, git stash pop/apply and
// patch, from the paths the patch or stash names; a recursive rm/cp, mv or rsync of a dir holding a guarded path;
// and pushes set up to force some other way (git config, gh api on git/refs).
// A guard, not a sandbox: what a script or interpreter writes, or a path built from $VAR, $( ) or a glob, is not
// seen here. The PostToolUse check (proteus-shell-check.js) catches those after the call.
const AGENT_MSG = {
  force: (flag) => `proteus: agents never force-push (\`${flag}\`), their own branch included: a rewrite drops commits the verifier and the PR already read. Add a commit on top, or merge the base in (\`git merge origin/<base>\`), and push the branch by name; history that must be rewritten is a NEEDS for the lead, who can allow one force-push with \`proteus-worktree.js <worktree> --allow force-push\`.`,
  selfAllow: "proteus: `proteus-worktree.js --allow` records the lead's one-off authorisation; an agent never grants one. Comment NEEDS on the issue and stop.",
  confine: (what, shown, why) => `proteus: \`${what}\` writes ${shown}, ${why}. A worker's shell writes only its owned paths and its scratch dir (\`node <hooks>/proteus-scratch.js --path <key>\`); write there, or comment "NEEDS ${shown}: <why>" on the issue and stop.`,
  runtime: (what, t) => `proteus: \`${what}\` writes ${t}, a path the shell builds when it runs ($VAR, $( ) or backticks), which the guard cannot judge. Name the path literally, under your owned paths or scratch dir.`,
  inline: (what, shown, why) => `proteus: \`${what}\` code names ${shown}, ${why}. Inline code may name only your worktree and its scratch dir; work on paths there, or comment "NEEDS ${shown}: <why>" on the issue and stop.`,
  gitDir: (opt, p, own) => `proteus: \`${opt.endsWith("=") ? opt + p + " git" : "git " + opt + " " + p}\` runs git in ${p}, which is not your worktree${own ? ` (${own})` : ""}, while the gates, tests and hooks beside it run elsewhere. Start the call with \`cd <your worktree> && \` and run git there.`,
  write: (prog, rel) => `proteus: \`${prog}\` writes ${rel}, which holds Proteus's hooks, gates, git internals or CLI settings; a shell write there skips the owned-path check and is never a worker's. Make an owned change with Edit or Write, or comment "NEEDS ${rel}: <why>" on the issue and stop.`,
  tree: (prog, target, rel) => `proteus: \`${prog}\` on ${target} takes ${rel} with it, which holds Proteus's hooks, gates, git internals or CLI settings; that is never a worker's. Name the paths inside it that you own, or comment "NEEDS ${rel}: <why>" on the issue and stop.`,
  blind: (prog) => `proteus: \`${prog}\` reads its patch from stdin or from a file this same command writes, so the guard cannot see which paths it changes. Save the patch to a file first (Write it under \`node <hooks>/proteus-scratch.js --path <key>\`) and apply it by name in a later call.`,
  pushSetup: (what) => `proteus: \`${what}\` sets up a push the guard cannot read: a configured push refspec, a mirror, push.default or an alias can force-push or push every branch. Push your branch by name (\`git push origin <your branch>\`).`,
  gitConfig: (what) => `proteus: \`${what}\` sets git config that runs a program or reads config from elsewhere (hooks, fsmonitor, ssh, editor, pager, aliases, filters, textconv, credential helpers, includes); a worker never sets it. Comment "NEEDS git config: <why>" on the issue and stop.`,
  noTree: (what) => `proteus: \`${what}\` writes from a worker's shell, and there is no worktree known for this worker; the lead spawns workers into one. Comment NEEDS on the issue and stop.`,
  link: (what, link, target, why) => `proteus: \`${what}\` makes ${link} a link to ${target}, ${why}; a write through the link lands there. Link only to your owned paths or scratch dir, or comment "NEEDS ${target}: <why>" on the issue and stop.`,
  xargs: (prog) => `proteus: \`xargs ${prog}\` writes the paths xargs reads at run time, which the guard cannot judge. Name the paths literally, under your owned paths or scratch dir.`,
  refs: (what) => `proteus: agents never move a branch through the API (\`${what}\`): a ref update there can force it past the push checks. Push your branch by name with git.`,
};
// One worker, one worktree: the lead guard's bindingDenial records a subagent's first edit per agent id in
// <git-common-dir>/proteus-lead/agents/; its cwd's prepared worktree counts first.
const bindFile = (common, agent) => leadPath(common, "agents", "agent-" + String(agent).replace(/[^\w.-]/g, "_"));
function bound(common, agent) {
  try { return fs.readFileSync(bindFile(common, agent), "utf8").trim() || null; } catch { return null; }
}
// A spawn the lead names (#180): Claude Code then reports the spawn's name as the subagent's agent_type, not its
// subagent_type. The lead guard records each main-thread spawn's name -> subagent_type in
// <git-common-dir>/proteus-lead/spawns/ (recordSpawn), and agentTypeOf maps a reported type that matches a recorded
// name back to it; an unrecorded value is used as it is. Only the lead's own Agent call writes a record, and a
// subagent's edits and shell writes to .git/ are refused (agentShellDenial, AGENT_NEVER). A guard, not a boundary.
// An unnamed spawn is recorded under its subagent_type (Claude Code reports that as its agent_type), and each
// record carries the spawn's time: the watchdog tracks only agents with a lead spawn record (spawnRecord, #179).
const spawnFile = (common, name) => leadPath(common, "spawns", "spawn-" + String(name).replace(/[^\w.-]/g, "_") + ".json");
function recordSpawn(ev) {
  const name = ev.spawnName || ev.spawnType;
  if (ev.agent || !name || !ev.spawnType) return;
  const common = gitCommonDir(path.resolve(projectRoot(ev)));
  if (!common) return;
  const file = spawnFile(common, name);
  try { leadWrite(common, file, JSON.stringify({ name, type: ev.spawnType, at: new Date().toISOString() }) + "\n"); } catch {}
}
// the lead's record of this subagent's spawn, found by the agent_type its harness reports, else null
function spawnRecord(ev) {
  const t = ev && typeof ev.agentType === "string" ? ev.agentType : "";
  if (!t || !ev.agent) return null;
  const common = gitCommonDir(path.resolve(projectRoot(ev)));
  if (!common) return null;
  let rec = null;
  try { rec = JSON.parse(fs.readFileSync(spawnFile(common, t), "utf8")); } catch {}
  return rec && rec.name === t && typeof rec.type === "string" && rec.type ? rec : null;
}
function agentTypeOf(ev) {
  const t = ev && typeof ev.agentType === "string" ? ev.agentType : "";
  const rec = spawnRecord(ev);
  return rec ? rec.type : t;
}
// An agent's own memory (#181): Claude Code keeps a `memory: local` agent's notes in
// <spawning checkout>/.claude/agent-memory-local/<its agent type, [^\w-] as ->/, which is the lead's main
// checkout, where every other .claude/ path is refused. A subagent edit there passes when the dir is its own type
// (agentTypeOf; the bare name past proteus: counts too) and that Proteus agent declares `memory: local`
// (MEMORY_LOCAL, kept equal to agents/*.md by tests/agentmemory.test.js). The lead, another agent's dir, the
// memory root itself and any path a link on the way moves elsewhere stay refused.
const MEMORY_LOCAL = new Set(["proteus-verifier", "proteus-backend-verifier", "proteus-frontend-verifier", "proteus-qa-verifier", "proteus-security-verifier", "proteus-guide"]);
function ownMemory(ev, abs) {
  if (!ev || !ev.agent) return false;
  const type = agentTypeOf(ev), name = agentName(type);
  if (!MEMORY_LOCAL.has(name)) return false;
  const root = gitRoot(path.resolve(projectRoot(ev)));
  if (!root) return false;
  const dirs = new Set([type.replace(/[^a-zA-Z0-9\-_]/g, "-"), name].map((d) => d.toLowerCase()));
  const mine = (rel) => {
    const seg = rel === null ? [] : rel.split("/");
    return seg.length > 3 && seg[0] === ".claude" && seg[1] === "agent-memory-local" && dirs.has(seg[2]) && seg.every((s) => s && s !== "." && s !== "..");
  };
  const rel = relPath(root, abs);
  if (!mine(rel === null ? null : fileKey(rel)) || /~\d/.test(rel)) return false;
  let st = null;
  try { st = fs.lstatSync(abs); } catch {}
  if (st && st.isSymbolicLink()) return false;
  const real = realTarget(abs), realRel = real && relPath(realOr(root), real);
  return !!realRel && fileKey(realRel) === fileKey(rel);
}
// the prepared worktree of this repo a subagent's brief names (roles.md: "worktree <absolute path>"), else null.
// A path counts written absolute (either slash, or its real path) or relative to the main checkout, as a whole
// token. None named, or several (a contracts worker's brief lists one per ticket), is null: the cwd and
// first-edit binding then apply as before.
function briefWorktree(text, common) {
  const brief = String(text || "");
  if (!brief || !common) return null;
  const main = path.dirname(common);
  let ids = [];
  try { ids = fs.readdirSync(path.join(common, "worktrees")); } catch { return null; }
  const named = new Map(); // real path -> the path as git recorded it
  for (const id of ids) {
    let wt;
    try { wt = path.dirname(path.resolve(fs.readFileSync(path.join(common, "worktrees", id, "gitdir"), "utf8").trim())); } catch { continue; }
    if (!fs.existsSync(ownedFile(wt))) continue;
    const rel = path.relative(main, wt);
    const spellings = new Set([wt, realOr(wt), rel && !path.isAbsolute(rel) ? rel : ""].filter(Boolean).flatMap((p) => [p, p.split(path.sep).join("/")]));
    for (const p of spellings) {
      const re = new RegExp(`(?<![\\w.-])${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-]|\\.\\w)`, process.platform === "win32" ? "i" : "");
      if (re.test(brief)) { named.set(realOr(wt), wt); break; }
    }
  }
  return named.size === 1 ? [...named.values()][0] : null;
}
// the cwd's checkout when it is a prepared (owned-list) linked worktree of this repo
function cwdWorktree(cwd, common) {
  const own = gitRoot(cwd);
  return own && isLinked(own) && fs.existsSync(ownedFile(own)) && (!common || gitCommonDir(own) === common) ? own : null;
}

// a word as the shell would name a path: ~ and $HOME/${HOME}, $PWD expanded; any other $ left as written
// and on Windows a Git Bash or Cygwin drive path (/c/x, /cygdrive/c/x) as the drive path it names
const expandPath = (w, dir, win = process.platform === "win32") => drivePath(String(w).replace(/^~(?=$|[\\/])/, () => os.homedir()).replace(/^\$(?:\{HOME\}|HOME\b)/, () => os.homedir()).replace(/^\$(?:\{PWD\}|PWD\b)/, () => dir), win);
const drivePath = (p, win = process.platform === "win32") => (win ? p.replace(/^[\\/](?:cygdrive[\\/])?([a-zA-Z])(?=$|[\\/])/, (_, d) => `${d.toUpperCase()}:/`).replace(/^([A-Z]:\/)[\\/]/, "$1") : p);
// a path word the shell builds when it runs ($VAR, $( ) or backticks), left after expandPath reads ~, $HOME and $PWD
const unexpanded = (w, dir) => /[$`]/.test(expandPath(w, dir));
const UNEXPANDED_MSG = (what) => `proteus: \`${what}\` names a path the shell builds when it runs ($VAR, $( ) or backticks), so the guard cannot tell which checkout git works in: spell the path out; the guard can't expand shell variables.`;
// the dir a shell call runs in: the event's cwd, moved by the shell tool's own workdir when the harness has one
const shellCwd = (ev) => { const base = ev.cwd || projectRoot(ev); return ev.workdir ? path.resolve(base, expandPath(ev.workdir, base)) : base; };

// the paths a simple command (unwrapped words) writes, as written: [] for a program it does not judge
const WRITE_ALL = new Set(["tee", "truncate", "touch", "rm", "unlink", "rmdir", "shred", "mv"]); // every operand
const WRITE_LAST = new Set(["cp", "ln", "link", "install", "rsync"]); // the last operand, or -t DIR
const IN_PLACE = { sed: /^-(?:[a-zA-Z]*i|-in-place(?:=|$))/, perl: /^-[a-ln-zA-HJ-LN-Z0-9]*i/, ruby: /^-[a-ln-zA-HJ-LN-Z0-9]*i/ }; // -M, -m, -I take the rest
const OUTPUT_OPT = { sort: ["o", "--output"], curl: ["o", "--output"], wget: ["O", "--output-document"] };
const AWK = /^(?:awk|gawk|mawk|nawk|busybox-awk)$/;
const VALUE_OPT = { truncate: ["-s", "--size", "-r", "--reference"], touch: ["-r", "--reference", "-d", "--date", "-t"], tee: [], rm: [], unlink: [], rmdir: [], shred: ["-n", "--iterations", "-s", "--size"], mv: ["-S", "--suffix"] };
function writeTargets(words) {
  const prog = progName(words[0]), args = words.slice(1);
  const operands = (skip = []) => {
    const out = [];
    for (let k = 0; k < args.length; k++) {
      if (args[k] === "--") { out.push(...args.slice(k + 1)); break; }
      if (skip.includes(args[k])) k++;
      else if (!args[k].startsWith("-") || args[k] === "-") out.push(args[k]);
    }
    return out;
  };
  if (prog === "dd") return args.filter((a) => a.startsWith("of=")).map((a) => a.slice(3));
  if (OUTPUT_OPT[prog]) {
    // sort -o F, curl -o F / --output F, wget -O F / --output-document F: separate, attached or with =
    const [short, long] = OUTPUT_OPT[prog], out = [];
    const keep = (t) => { if (prog === "sort" || t !== "-") out.push(t); }; // - is curl's and wget's stdout
    let m;
    for (let k = 0; k < args.length && args[k] !== "--"; k++) {
      const a = args[k];
      if (a === long || new RegExp(`^-[a-zA-Z]*${short}$`).test(a)) keep(args[++k] || "");
      else if ((m = new RegExp(`^-[a-zA-Z]*${short}(.+)$`).exec(a)) && !a.startsWith("--")) keep(m[1]);
      else if (a.startsWith(long + "=")) keep(a.slice(long.length + 1));
    }
    return out;
  }
  if (prog === "tar" && (args.some((a) => a === "--extract" || a === "--get" || /^-[a-zA-Z]*x/.test(a)) || /^[a-zA-Z]*x/.test(args[0] || ""))) {
    // extracting writes under -C / --directory, else the cwd
    let to = ".";
    for (let k = 0; k < args.length; k++) {
      if (args[k] === "-C" || args[k] === "--directory") to = args[++k] || "";
      else if (args[k].startsWith("--directory=")) to = args[k].slice(12);
      else if (/^-C./.test(args[k])) to = args[k].slice(2);
    }
    return [to];
  }
  if (prog === "unzip") {
    if (args.some((a) => /^-[a-zA-Z]*[lptvzZ]/.test(a))) return [];
    const k = args.findIndex((a) => a.startsWith("-d"));
    return [k < 0 ? "." : args[k].length > 2 ? args[k].slice(2) : args[k + 1] || ""];
  }
  if (AWK.test(prog) && args.some((a, k) => a === "inplace" && /^(?:-i|--include)$/.test(args[k - 1] || ""))) {
    // gawk -i inplace: every file operand, after the program text
    const ops = operands(["-f", "--file", "-F", "--field-separator", "-v", "--assign", "-i", "--include", "-l", "--load", "-e", "--source"]);
    return args.some((a) => /^(?:-f|--file|-e|--source)(?:=|$)/.test(a)) ? ops : ops.slice(1);
  }
  if (WRITE_ALL.has(prog)) return operands(VALUE_OPT[prog]);
  if (IN_PLACE[prog]) {
    if (!args.some((a) => IN_PLACE[prog].test(a))) return [];
    // the script is the first operand unless an option gave it
    const script = prog === "sed" ? ["-e", "--expression", "-f", "--file", "-l", "--line-length"] : ["-e", "-E"];
    const ops = operands(script);
    return args.some((a) => script.includes(a) || /^--(?:expression|file)=/.test(a)) ? ops : ops.slice(1);
  }
  if (prog === "install" && args.some((a) => a === "-d" || a === "--directory")) return operands(["-m", "--mode", "-o", "--owner", "-g", "--group"]);
  if (WRITE_LAST.has(prog)) {
    for (let k = 0; k < args.length; k++) {
      const m = /^--target-directory=(.*)$/.exec(args[k]);
      if (m) return [m[1]];
      if ((prog === "rsync" ? args[k] === "-t" : /^-[a-zA-Z]*t$/.test(args[k])) || args[k] === "--target-directory") return [args[k + 1] || ""];
    }
    const ops = operands(["-S", "--suffix", "-m", "--mode", "-o", "--owner", "-g", "--group"]);
    return ops.length > 1 ? [ops[ops.length - 1]] : [];
  }
  return [];
}

// the plugin's folder (CLAUDE_PLUGIN_ROOT), guarded like .claude/hooks, for the repo whose git common dir is common;
// "" when there is none, or when it is a checkout of that repo itself (a plugin run from its source checkout)
function pluginAnchor(common) {
  const p = pluginRoot(), r = p && gitRoot(p);
  return !p || (r && common && realOr(gitCommonDir(r)) === realOr(common)) ? "" : p;
}

// the CLIs' config dirs as their env names them: claudeDir() ($CLAUDE_CONFIG_DIR, else ~/.claude) and $CODEX_HOME
const cliHomes = () => [claudeDir(), ...(process.env.CODEX_HOME ? [path.resolve(process.env.CODEX_HOME)] : [])];
// rel (forward slashes) under which root abs falls, judged against AGENT_NEVER; "" when allowed
function guardedWrite(abs, ev) {
  const wt = gitRoot(path.dirname(abs));
  if (wt && inScratch(gitCommonDir(wt), abs)) return ""; // proteus-scratch.js --path: the agents' sanctioned temp space under .git
  const roots = [wt, guestDir(projectRoot(ev))].filter(Boolean);
  const plug = pluginAnchor(gitCommonDir(path.resolve(projectRoot(ev))));
  for (const p of [abs, realTarget(abs)].filter(Boolean)) {
    for (const r of [...roots, gitRoot(path.dirname(p))].filter(Boolean)) {
      const rel = relPath(realOr(r), p) ?? relPath(r, p);
      if (rel && keyIn(AGENT_NEVER, rel)) return rel;
    }
    // the CLIs' own settings, hooks and skills in the user's home, outside any checkout
    const home = relPath(realOr(os.homedir()), p) ?? relPath(os.homedir(), p);
    if (home && /^\.(?:claude|codex|agents)(?:\/|$)/.test(fileKey(home))) return "~/" + home;
    // and wherever $CLAUDE_CONFIG_DIR or $CODEX_HOME move them (the anchors proteus-confine.js and guardedParent use)
    for (const a of cliHomes()) {
      const r = relPath(realOr(a), p) ?? relPath(a, p);
      if (r !== null) return fwd(path.join(a, r));
    }
    // the plugin's own folder: its hooks, skills and agents
    const inPlug = plug ? relPath(realOr(plug), p) ?? relPath(plug, p) : null;
    if (inPlug !== null) return inPlug ? `$CLAUDE_PLUGIN_ROOT/${inPlug}` : "$CLAUDE_PLUGIN_ROOT";
    // the human's gh config (their GitHub login), while the agents have one of their own
    const gh = inHumanGh(p);
    if (gh) return gh;
  }
  return "";
}

// the worker's own worktree for dir, else null: the prepared worktree of its cwd (as given or after cd), else
// the one its first edit bound it to
function ownWorktree(ev, dir, common) {
  return cwdWorktree(dir, common) || (ev.cwd && cwdWorktree(path.resolve(ev.cwd), common)) || (ev.agent && common ? bound(common, ev.agent) : null);
}
// git's own options that move it to another checkout, each with its path (-C <p>, -C<p>, --git-dir[=]<p>,
// --work-tree[=]<p>); GIT_DIR / GIT_WORK_TREE assignments too. Each is [option, path, value as written]; the path
// is null for a value the shell builds when it runs ($VAR, $( ), backticks, or a value a substitution split off), which
// the guard cannot resolve (#220), and the list ends there
function gitDirs(all, words, dir) {
  const out = [];
  const at = (opt, v, d) => (v === undefined || unexpanded(v, d) ? [opt, null, v || ""] : [opt, path.resolve(d, expandPath(v, d)), v]);
  // an unquoted $( ) or backticks splits the command it sits in; the part after it resumes the assignment it built
  for (const a of [...(all.resumes || []), ...all.slice(0, all.length - words.length)]) {
    const m = /^(GIT_DIR|GIT_WORK_TREE)=(.*)$/.exec(a);
    if (m) out.push(at(m[1] + "=", m[2], dir));
  }
  let d = dir;
  for (let i = 1; i < words.length && words[i].startsWith("-") && !out.some((e) => e[1] === null); i++) {
    const a = words[i], m = /^(--git-dir|--work-tree)=(.*)$/.exec(a);
    if (a === "-C") { const e = at("-C", words[++i], d); if (e[1]) d = e[1]; out.push(e); }
    else if (a.startsWith("-C")) { const e = at("-C", a.slice(2), d); if (e[1]) d = e[1]; out.push(e); }
    else if (m) out.push(at(m[1], m[2], d));
    else if (a === "--git-dir" || a === "--work-tree") out.push(at(a, words[++i], d));
    else if (GIT_VALUE.has(a)) i++;
  }
  return out;
}
// git <global options> push with a force flag or a +refspec: the flag, else ""
function forcePush(words) {
  let i = 1;
  for (; i < words.length && words[i].startsWith("-"); i++) if (GIT_VALUE.has(words[i])) i++;
  if (words[i] !== "push") return "";
  const args = words.slice(i + 1);
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === "--") return args.slice(k + 1).find((s) => s.startsWith("+")) || "";
    if (PUSH_VALUE.has(a)) k++;
    else if (/^--force(?:-with-lease(?:=.*)?|-if-includes)?$/.test(a) || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a)) return a;
    else if (a.startsWith("+")) return a;
  }
  return "";
}

// a word as the paths it may name: a backslash is a separator on Windows, judged as one everywhere, so a path
// written either way is caught
const spellings = (t, dir) => [...new Set([t, String(t).replace(/\\/g, "/")])].map((c) => path.resolve(dir, expandPath(c, dir)));
const writeRel = (t, dir, ev) => spellings(t, dir).map((p) => guardedWrite(p, ev)).find(Boolean) || "";
// the guarded path t is, or holds: ".github/workflows" for t = .github
function treeRel(t, dir, ev) {
  for (const p of spellings(t, dir)) {
    const rel = guardedWrite(p, ev);
    if (rel) return rel;
    const sub = guardedParent(p, ev);
    if (sub) return `${String(t).replace(/[\\/]+$/, "") || "/"}/${sub}`;
  }
  return "";
}
// the guarded path (relative to abs, forward slashes) that abs holds as a parent, else "": a guarded dir of any
// checkout of this repo or of the guest dir, a whole checkout (its .git), the CLIs' dirs in the home, or the human's gh config
const ANCHORS = [".git", ".claude", ".codex", ".agents", ".github/workflows", ".github/actions", "teams/templates/hooks"];
function guardedParent(abs, ev) {
  const roots = new Set(), commons = new Set([gitCommonDir(path.resolve(projectRoot(ev)))]);
  const near = gitRoot(abs);
  if (near) { roots.add(near); commons.add(gitCommonDir(near)); }
  for (const c of commons) {
    if (!c) continue;
    if (mainRoot(c)) roots.add(mainRoot(c));
    for (const w of registeredWorktrees(c)) roots.add(w);
  }
  const guest = guestDir(projectRoot(ev));
  if (guest) roots.add(guest);
  const plug = pluginAnchor(gitCommonDir(path.resolve(projectRoot(ev))));
  const hg = humanGhGuard();
  const anchors = [...[".claude", ".codex", ".agents"].map((d) => path.join(os.homedir(), d)), ...cliHomes(), ...(plug ? [plug] : []), ...(hg ? [hg.human] : [])];
  for (const r of roots) {
    anchors.push(...ANCHORS.map((a) => path.join(r, a)));
    try { anchors.push(...fs.readdirSync(path.join(r, ".config")).filter((n) => /^\.?lefthook/i.test(n)).map((n) => path.join(r, ".config", n))); } catch {}
  }
  for (const p of new Set([abs, realTarget(abs)].filter(Boolean))) {
    for (const a of anchors) {
      if (!fs.existsSync(a)) continue;
      for (const b of new Set([a, realOr(a)])) {
        const r = path.relative(p, b);
        if (r && r !== ".." && !r.startsWith(".." + path.sep) && !path.isAbsolute(r)) return r.split(path.sep).join("/");
      }
    }
  }
  return "";
}

// what rm -r, mv, cp -r and rsync write as a whole tree: [target, tree] pairs. tree true: the target and all
// under it (rm -r and mv sources, a destination that receives a source's contents or loses files to --delete);
// false: the one path a source lands at inside the destination dir
const COPY_VALUE = ["-S", "--suffix", "-t", "--target-directory", "-m", "--mode", "-o", "--owner", "-g", "--group", "-e", "--rsh", "--exclude", "--include", "--filter", "-f", "--files-from", "--exclude-from", "--include-from", "--rsync-path", "--log-file", "--partial-dir", "--temp-dir", "-T", "--compare-dest", "--copy-dest", "--link-dest", "--chmod", "--chown", "--backup-dir", "--max-size", "--min-size", "--timeout", "--port", "-B", "--block-size", "--bwlimit"];
function treeTargets(words) {
  const prog = progName(words[0]), args = words.slice(1);
  const has = (re) => args.some((a) => re.test(a));
  if (prog === "rm") return has(/^(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)$/) ? writeTargets(words).map((t) => [t, true]) : [];
  if (!["mv", "cp", "rsync"].includes(prog) || (prog === "cp" && !has(/^(?:-[a-zA-Z]*[rRa][a-zA-Z]*|--recursive|--archive)$/))) return [];
  const ops = [];
  let dest = null;
  for (let k = 0; k < args.length; k++) {
    const a = args[k], m = /^--target-directory=(.*)$/.exec(a);
    if (a === "--") { ops.push(...args.slice(k + 1)); break; }
    if (m) dest = m[1];
    else if (prog !== "rsync" && (a === "-t" || a === "--target-directory")) dest = args[++k] || "";
    else if (COPY_VALUE.includes(a)) k++;
    else if (!a.startsWith("-")) ops.push(a);
  }
  if (dest === null) dest = ops.length > 1 ? ops.pop() : null;
  if (dest === null) return [];
  const out = prog === "mv" ? ops.map((s) => [s, true]) : [];
  const contents = (s) => (prog === "rsync" ? /[\\/]\.?$/.test(s) : /[\\/]\.$/.test(s));
  if (ops.some(contents) || (prog === "rsync" && has(/^--(?:delete|del$|remove)/))) out.push([dest, true]);
  for (const s of ops) if (!contents(s)) out.push([path.join(dest, path.basename(s.replace(/[\\/]+$/, ""))), false]);
  return out;
}

// find's start points, the commands its -exec / -execdir / -ok / -okdir run, -delete, and the files -fprint & co write
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
function findParts(args) {
  let i = 0;
  for (; i < args.length && /^-(?:[HLP]|D|O\d*)$/.test(args[i]); i++) if (args[i] === "-D") i++;
  const starts = [];
  for (; i < args.length && !/^[-(!),]/.test(args[i]); i++) starts.push(args[i]);
  const execs = [], writes = [];
  let del = false;
  for (; i < args.length; i++) {
    const a = args[i];
    if (FIND_EXEC.has(a)) {
      const cmd = [];
      for (i++; i < args.length && args[i] !== ";" && args[i] !== "+"; i++) cmd.push(args[i]);
      execs.push(cmd);
    } else if (a === "-delete") del = true;
    else if (/^-f(?:print0?|printf|ls)$/.test(a)) writes.push(args[++i] || "");
  }
  return { starts: starts.length ? starts : ["."], execs, del, writes };
}

// git -c / --config-env / GIT_CONFIG_* settings and `git config` writes that set up a push the guard cannot read
const SAFE_PUSH_DEFAULT = /^(?:simple|current|upstream|tracking|nothing)$/i;
function riskyConfig(key, value) {
  const k = String(key || "").toLowerCase();
  if (/^remote\..+\.(?:push|mirror)$/.test(k)) return true;
  if (k === "push.default") return !SAFE_PUSH_DEFAULT.test(String(value ?? ""));
  if (k.startsWith("alias.")) return value === undefined || /^\s*!|(?:^|\s)push(?:\s|$)/.test(value);
  return false;
}
const CONFIG_VALUE = new Set(["-f", "--file", "--blob", "-t", "--type", "--default", "--comment", "--value"]);
const CONFIG_READ = /^(?:-l|--list|--get(?:-all|-regexp|-urlmatch|-color|colorbool)?|--unset(?:-all)?|--remove-section|--rename-section|-e|--edit|--show-origin|--show-scope|--name-only)$/;
// git config <args>: [key, value] it sets, else null
function configSet(args) {
  const pos = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (CONFIG_VALUE.has(a)) k++;
    else if (CONFIG_READ.test(a)) return null;
    else if (!a.startsWith("-")) pos.push(a);
  }
  if (pos[0] === "set") return pos[1] ? [pos[1], pos[2]] : null;
  if (/^(?:get|list|unset|rename-section|remove-section|edit)$/.test(pos[0] || "")) return null;
  return pos.length >= 2 ? [pos[0], pos[1]] : null;
}
// the config a git call carries: -c k[=v], --config-env k=ENV (value unknown), GIT_CONFIG_KEY_<n> and GIT_CONFIG_PARAMETERS
function gitCallConfig(all, words) {
  const out = [];
  for (const a of all.slice(0, all.length - words.length)) {
    let m;
    if ((m = /^GIT_CONFIG_KEY_\d+=(.*)$/s.exec(a))) out.push([m[1], undefined]);
    else if ((m = /^GIT_CONFIG_PARAMETERS=(.*)$/s.exec(a))) for (const p of m[1].matchAll(/'([^']*)'(?:='([^']*)')?/g)) out.push([p[1], p[2]]);
  }
  for (let i = 1; i < words.length && words[i].startsWith("-"); i++) {
    const a = words[i];
    const c = a === "-c" ? words[++i] || "" : a.startsWith("--config-env=") ? a.slice(13) : a === "--config-env" ? words[++i] || "" : null;
    if (c === null) { if (GIT_VALUE.has(a)) i++; continue; }
    const eq = c.indexOf("=");
    out.push(eq < 0 ? [c, "true"] : [c.slice(0, eq), a === "-c" ? c.slice(eq + 1) : undefined]);
  }
  return out;
}

// a pathspec as [path, the dir it is relative to]: :/x and :(top)x from the checkout root; null for an exclusion
function specPath(p, dir, root) {
  const m = /^:(?:\(([^)]*)\)|([/!^]*))(.*)$/s.exec(p);
  if (!m) return [p, dir];
  const magic = m[1] !== undefined ? m[1].split(",") : [...m[2]].map((c) => (c === "/" ? "top" : "exclude"));
  if (magic.includes("exclude")) return null;
  return [m[3], magic.includes("top") ? root : dir];
}
const readSmall = (abs, max = 8 << 20) => { try { const st = fs.statSync(abs); return st.isFile() && st.size <= max ? fs.readFileSync(abs, "utf8") : null; } catch { return null; } };
function specFile(f, dir, nul) {
  if (!f || f === "-") return [];
  const text = readSmall(path.resolve(dir, expandPath(f, dir)), 1 << 20);
  return text === null ? [] : text.split(nul ? "\0" : /\r?\n/).filter(Boolean);
}

// git checkout / restore with paths: a restore to HEAD or the index passes (the worker undoing its own change);
// from any other commit, the guarded paths it would change (git diff <source> against the worktree) are refused
const CHECKOUT_VALUE = new Set(["-b", "-B", "--orphan", "--conflict", "-U", "--unified", "--inter-hunk-context"]);
function restoreDenial(sub, args, dir, ev) {
  const root = gitRoot(dir);
  if (!root) return null;
  const dash = args.indexOf("--");
  const pre = dash < 0 ? args : args.slice(0, dash), post = dash < 0 ? [] : args.slice(dash + 1);
  let source = null, m;
  const pos = [], specs = [], nul = args.includes("--pathspec-file-nul");
  for (let k = 0; k < pre.length; k++) {
    const a = pre[k];
    if (sub === "restore" && (m = /^(?:--source=|-s(?=.))(.*)$/s.exec(a))) source = m[1];
    else if (sub === "restore" && (a === "-s" || a === "--source")) source = pre[++k] || "";
    else if ((m = /^--pathspec-from-file=(.*)$/s.exec(a))) specs.push(...specFile(m[1], dir, nul));
    else if (a === "--pathspec-from-file") specs.push(...specFile(pre[++k] || "", dir, nul));
    else if (CHECKOUT_VALUE.has(a)) k++;
    else if (!a.startsWith("-")) pos.push(a);
  }
  let paths = sub === "restore" ? [...pos, ...post] : dash >= 0 ? post : pos;
  if (sub === "checkout" && dash >= 0) source = pos[0] || null;
  const hits = (list) => list.map((p) => specPath(p, dir, root)).filter((x) => x && treeRel(x[0], x[1], ev)).map(([p, base]) => path.resolve(base, expandPath(p, base)));
  let hit = hits([...paths, ...specs]);
  if (!hit.length) return null;
  // without --, a first word naming a commit is the source and the rest are paths
  if (sub === "checkout" && dash < 0 && pos.length && git(["rev-parse", "-q", "--verify", `${ownRev(pos[0], dir)}^{tree}`], dir)) {
    source = pos[0];
    paths = pos.slice(1);
    hit = hits([...paths, ...specs]);
    if (!hit.length) return null;
  }
  if (source === null || /^(?:HEAD|@)$/.test(source)) return null;
  const rel = sourceDiffers(ownRev(source, dir), hit, dir).find((r) => keyIn(AGENT_NEVER, r));
  return rel ? AGENT_MSG.write(`git ${sub} ${source}`, rel) : null;
}

// the paths under hits (absolute) that checking out source would change in dir's checkout, relative to its root:
// each file source holds whose bytes on disk differ, and each one the index tracks that source lacks. No git diff
// or status (#215): source's blobs are compared with the files' bytes, so a file git would call clean through a
// line-ending or clean filter counts as changed (fail-closed). Every hit's path when git cannot read source.
function sourceDiffers(source, hits, dir) {
  const co = checkoutOf(dir);
  if (!co) return [];
  const rels = hits.map((h) => relPath(co.root, h) ?? relPath(co.root, realOr(h))).filter((r) => r !== null);
  if (!rels.length) return [];
  const specs = rels.map((r) => `:(literal)${r || "."}`);
  const o = { cwd: co.root, workTree: co.root, index: co.index, timeout: 10000 };
  let tree, tracked;
  try {
    tree = String(gitRun(co.common, ["ls-tree", "-r", "--full-tree", "-z", source, "--", ...specs], o));
    tracked = String(gitRun(co.common, ["ls-files", "-z", "--", ...specs], o));
  } catch { return rels; }
  const out = [], inTree = new Set();
  for (const rec of tree.split("\0")) {
    const m = /^(\d+) (\w+) ([0-9a-f]+)\t([\s\S]+)$/.exec(rec);
    if (!m) continue;
    inTree.add(m[4]);
    if (m[2] !== "blob") continue;
    const abs = path.join(co.root, ...m[4].split("/"));
    let bytes = null;
    try {
      const st = fs.lstatSync(abs);
      if (m[1] === "120000" ? st.isSymbolicLink() : st.isFile()) bytes = m[1] === "120000" ? Buffer.from(fs.readlinkSync(abs)) : fs.readFileSync(abs);
    } catch {}
    if (!bytes || blobId(bytes, m[3].length) !== m[3]) out.push(m[4]);
  }
  for (const p of tracked.split("\0")) if (p && !inTree.has(p)) out.push(p);
  return out;
}
// git's object id of a blob holding bytes: sha1, or sha256 for a 64-hex repo
const blobId = (bytes, len) => require("crypto").createHash(len === 64 ? "sha256" : "sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

// git stash pop / apply: the paths the stash holds (tracked changes and untracked files)
function stashDenial(how, args, dir) {
  const ref = args.find((a) => !a.startsWith("-")) || "stash@{0}";
  const sha = git(["rev-parse", "-q", "--verify", `${/^\d+$/.test(ref) ? `stash@{${ref}}` : ref}^{commit}`], dir);
  if (!sha) return null;
  const files = [...git(["diff", "--name-only", `${sha}^1`, sha], dir).split("\n"), ...git(["ls-tree", "-r", "--name-only", `${sha}^3`], dir).split("\n")];
  const rel = files.find((f) => f && keyIn(AGENT_NEVER, f));
  return rel ? AGENT_MSG.write(`git stash ${how}`, rel) : null;
}

// the paths a unified or git diff names: diff --git, ---/+++, rename/copy and Index: lines; /dev/null dropped
function patchPaths(text) {
  const out = new Set();
  const unq = (q) => q.replace(/^"([\s\S]*)"$/, "$1").replace(/\\(.)/g, "$1");
  for (const line of String(text).split(/\r?\n/)) {
    let m;
    if ((m = /^diff --git (.+)$/.exec(line))) for (const q of m[1].match(/"(?:[^"\\]|\\.)*"|\S+/g) || []) out.add(unq(q));
    else if ((m = /^(?:---|\+\+\+) (.+?)(?:\t.*)?$/.exec(line))) out.add(unq(m[1].trim()));
    else if ((m = /^(?:rename|copy) (?:from|to) (.+)$/.exec(line))) out.add(unq(m[1]));
    else if ((m = /^Index: (.+)$/.exec(line))) out.add(m[1].trim());
  }
  out.delete("/dev/null");
  return [...out];
}
// git apply, git am and patch: the paths their patch writes, read from the patch file before the call. A patch
// from stdin, or from a file an earlier part of this command line writes, cannot be read in time: refused inside a
// checkout. Each path is judged as written and with its leading dirs stripped, from the cwd and the checkout root.
const PATCH_OPTS = {
  "git apply": { value: ["-p", "-C", "--exclude", "--include", "--directory", "--whitespace", "--build-fake-ancestor"], dry: /^--(?:stat|numstat|summary|check)$/, apply: /^--apply$/ },
  "git am": { value: ["-p", "-C", "--exclude", "--include", "--directory", "--whitespace", "--patch-format", "--resolvemsg", "--quoted-cr", "--empty"], control: /^(?:--continue|--skip|--abort|--quit|--show-current-patch(?:=.*)?|--resolved|-r|--retry|--allow-empty)$/ },
  patch: { value: ["-i", "--input", "-d", "--directory", "-p", "--strip", "-o", "--output", "-r", "--reject-file", "-B", "--prefix", "-Y", "--basename-prefix", "-z", "--suffix", "-D", "--ifdef", "-F", "--fuzz", "-V", "--version-control", "-g", "--get", "--quoting-style"], dry: /^--dry-run$/ },
};
function patchDenial(prog, args, dir, written, ev) {
  const o = PATCH_OPTS[prog];
  const files = [], outs = [];
  let input = null, strip = null, base = dir, prefix = "", dry = false, apply = false, m;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    const eq = /^(--[\w-]+)=([\s\S]*)$/.exec(a);
    const [flag, attached] = eq ? [eq[1], eq[2]] : /^-[pCidoD]./.test(a) && prog !== "git am" ? [a.slice(0, 2), a.slice(2)] : /^-[pC]./.test(a) ? [a.slice(0, 2), a.slice(2)] : [a, undefined];
    if (o.control && o.control.test(a)) return null;
    if (o.dry && o.dry.test(a)) dry = true;
    if (o.apply && o.apply.test(a)) apply = true;
    if (a === "<") { input = args[++k] || ""; continue; }
    if ((m = /^<([^<].*)$/s.exec(a))) { input = m[1]; continue; }
    if (o.value.includes(flag)) {
      const v = attached !== undefined ? attached : args[++k] || "";
      if (flag === "-p" || flag === "--strip") strip = parseInt(v, 10);
      else if (prog === "patch" && (flag === "-i" || flag === "--input")) input = v;
      else if (prog === "patch" && (flag === "-d" || flag === "--directory")) base = path.resolve(dir, expandPath(v, dir));
      else if (prog !== "patch" && flag === "--directory") prefix = v;
      else if (prog === "patch" && (flag === "-o" || flag === "--output")) outs.push(v);
    } else if (a !== "-" && a.startsWith("-")) continue;
    else files.push(a);
  }
  if (dry && !apply) return null;
  if (prog === "patch") {
    if (files[0] && files[0] !== "-") outs.push(files[0]);
    if (input === null && files[1]) input = files[1];
  }
  for (const t of outs) { const rel = writeRel(t, base, ev); if (rel) return AGENT_MSG.write(prog, rel); }
  const sources = prog === "patch" ? [input] : files.length ? files : [input];
  const root = gitRoot(dir);
  let text = "";
  for (const f of sources) {
    const abs = f && f !== "-" ? path.resolve(dir, expandPath(f, dir)) : null;
    const body = abs && !written.has(abs) ? readSmall(abs) : null;
    if (body === null) return root ? AGENT_MSG.blind(prog) : null;
    text += body + "\n";
  }
  // as written, with one dir stripped, with -p's count stripped, and (patch only) the bare file name
  const strips = (p) => {
    const parts = p.split("/");
    const n = [0, 1, ...(strip ? [strip] : [])].flatMap((x) => (x < parts.length ? [parts.slice(x).join("/")] : []));
    return prog === "patch" ? [...n, parts[parts.length - 1]] : n;
  };
  for (const p of patchPaths(text)) {
    for (const v of new Set(strips(p))) {
      for (const b of new Set([base, root].filter(Boolean))) {
        const rel = writeRel(prefix ? path.posix.join(prefix, v) : v, b, ev);
        if (rel) return AGENT_MSG.write(prog, rel);
      }
    }
  }
  return null;
}

// a subagent's gh: no API ref update (a PATCH on git/refs takes force: true) and no gh repo sync --force
function ghAgentDenial(args) {
  if (args[0] === "repo" && args[1] === "sync" && args.includes("--force")) return AGENT_MSG.refs("gh repo sync --force");
  if (args[0] !== "api") return null;
  const { method, endpoint, path_ } = ghApi(args);
  if (endpoint === "graphql") return /\b(?:updateRefs?|deleteRef)\b/.test(args.join(" ")) ? AGENT_MSG.refs("gh api graphql updateRef") : null;
  return method !== "GET" && /(?:^|\/)git\/refs(?:\/|$)/.test(path_) ? AGENT_MSG.refs(`gh api -X ${method} ${endpoint}`) : null;
}

// config a worker never sets (#48): keys that run a program, or read config from another file
const RUNS_CONFIG = /^(?:core\.(?:hookspath|fsmonitor|sshcommand|editor|pager)|alias\..+|filter\..+|diff\..+\.textconv|credential(?:\..+)?|include\..+|includeif\..+)$/i;
// a worker's git checkout / restore / reset: each pathspec (after --, or a bare word) judged like a shell write
// to it, whatever the source commit
function pathspecDenial(sub, args, dir, ev) {
  const root = gitRoot(dir) || dir;
  const dash = args.indexOf("--");
  const pre = dash < 0 ? args : args.slice(0, dash), post = dash < 0 ? [] : args.slice(dash + 1);
  const specs = [...post];
  for (let k = 0; k < pre.length; k++) {
    const a = pre[k];
    if (CHECKOUT_VALUE.has(a) || a === "-s" || a === "--source" || a === "--pathspec-from-file") k++;
    else if (!a.startsWith("-")) specs.push(a);
  }
  for (const p of specs) {
    const sp = specPath(p, dir, root);
    const rel = sp && sp[0] && writeRel(sp[0], sp[1], ev);
    // a bare word naming a commit (git reset HEAD~1) is no pathspec
    if (rel && !(post.includes(p) || !git(["rev-parse", "-q", "--verify", `${ownRev(p, dir)}^{commit}`], dir))) continue;
    if (rel) return AGENT_MSG.write(`git ${sub} ${p}`, rel);
  }
  return null;
}

// git's own subcommands that write the worktree from somewhere the guard can read, or set up a push
function gitWriteDenial(ev, all, words, dir, written, worker = false) {
  for (const [k, v] of gitCallConfig(all, words)) {
    if (riskyConfig(k, v)) return AGENT_MSG.pushSetup(`git -c ${k}${v === undefined ? "" : "=" + v}`);
    if (worker && RUNS_CONFIG.test(k)) return AGENT_MSG.gitConfig(`git -c ${k}`);
  }
  let i = 1, d = dir;
  for (; i < words.length && words[i].startsWith("-"); i++) {
    if (words[i] === "-C") d = path.resolve(d, expandPath(words[++i] || ".", d));
    else if (words[i].startsWith("-C")) d = path.resolve(d, expandPath(words[i].slice(2), d));
    else if (GIT_VALUE.has(words[i])) i++;
  }
  const sub = words[i], args = words.slice(i + 1);
  if (sub === "config") {
    const s = configSet(args);
    if (s && riskyConfig(s[0], s[1])) return AGENT_MSG.pushSetup(`git config ${s[0]}${s[1] === undefined ? "" : " " + s[1]}`);
    return worker && s && RUNS_CONFIG.test(s[0]) ? AGENT_MSG.gitConfig(`git config ${s[0]}`) : null;
  }
  if (worker && (sub === "checkout" || sub === "restore" || sub === "reset")) {
    const why = pathspecDenial(sub, args, d, ev);
    if (why) return why;
  }
  if (sub === "checkout" || sub === "restore") return restoreDenial(sub, args, d, ev);
  if (sub === "apply" || sub === "am") return patchDenial(`git ${sub}`, args, d, written, ev);
  if (sub === "stash" && (args[0] === "pop" || args[0] === "apply")) return stashDenial(args[0], args.slice(1), d);
  return null;
}

const NESTED_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
// ---- a worker's shell (#48): a Proteus worker (the worker guard's own session, no agent id, or a subagent typed
// proteus-[<team>-]worker) writes from the shell only into its owned paths, its scratch dir and the console
// devices; its inline code (python -c, node -e/-p, perl and ruby -e, or the same read from a heredoc or a pipe)
// names only its worktree and scratch dir, and the guarded paths not at all; and it force-pushes only on its
// worktree's allow entry, which the push consumes. The worktree is the one its first edit bound it to, else its
// cwd's; with none, only the rules above apply. Tokenising and scanning code may take JUDGE_MS per call in all;
// past that, or on an error in judging, the call is refused.
const WORKER = /^proteus-(?:[a-z0-9-]+-)?worker$/;
const isWorkerShell = (ev) => !ev.agent || WORKER.test(agentName(ev.agentType));
const JUDGE_MS = 50;
const TOO_COMPLEX = "proteus: command too complex to judge; split it.";
const DEVICES = /^(?:\/dev\/(?:null|stdout|stderr)|nul)$/i;
const fwd = (p) => String(p).split(path.sep).join("/");
// the lead's one-off authorisations for a worktree (proteus-worktree.js <wt> --allow <what>), one per line, in
// <git-common-dir>/proteus/allow/<name>-<hash>: outside every checkout, under .git where no agent's shell writes.
// The lead's shell appends there; a hook only reads it, and records what it used in proteus-lead/allow-taken/<name>
// (#236): line i, keyed by the hash of lines 0..i, so a used entry stays used while the file only grows, and a
// rewritten file starts afresh.
const ALLOWS = ["force-push"];
function allowFile(wt) {
  const common = gitCommonDir(wt);
  return common ? path.join(stateDir(common), "allow", `${path.basename(wt).replace(/[^\w.-]/g, "_")}-${require("crypto").createHash("sha256").update(realOr(wt)).digest("hex").slice(0, 8)}`) : null;
}
const allowTakenFile = (wt) => { const f = allowFile(wt); return f && leadPath(gitCommonDir(wt), "allow-taken", path.basename(f)); };
const prefixSha = (lines, i) => require("crypto").createHash("sha256").update(lines.slice(0, i + 1).join("\n")).digest("hex");
// every line of the allow file, and the indexes of those a hook already used
function allowState(wt) {
  let lines = [];
  try { lines = readUntrusted(allowFile(wt), 64 * 1024).split(/\r?\n/).filter(Boolean); } catch {}
  const taken = new Set();
  const recs = lines.length && readJSON(allowTakenFile(wt), []);
  for (const r of Array.isArray(recs) ? recs : []) if (r && Number.isInteger(r.i) && r.i < lines.length && r.sha === prefixSha(lines, r.i)) taken.add(r.i);
  return { lines, taken };
}
// the entries not yet used
const allowLines = (wt) => { const { lines, taken } = allowState(wt); return lines.filter((_, i) => !taken.has(i)); };
function addAllow(wt, what) {
  const f = allowFile(wt);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, what + "\n");
}
// uses one what entry; true when there was one
function takeAllow(wt, what) {
  const { lines, taken } = allowState(wt), i = lines.findIndex((l, j) => l === what && !taken.has(j));
  if (i < 0) return false;
  const keep = [...taken].map((j) => ({ i: j, sha: prefixSha(lines, j) }));
  try { leadJSON(gitCommonDir(wt), allowTakenFile(wt), [...keep, { i, sha: prefixSha(lines, i) }]); return true; } catch { return false; }
}
// the prepared worktree a worker's shell is judged against: the one its first edit bound it to, its cwd's, and
// for the worker guard's own session (no agent id) its project dir's; null when none (#48 F1: it then writes nothing)
function workerTree(ev, dir) {
  const root = path.resolve(projectRoot(ev)), common = gitCommonDir(root);
  const b = ev.agent && common ? bound(common, ev.agent) : null;
  return (b && fs.existsSync(ownedFile(b)) ? b : null) || (ev.cwd && cwdWorktree(path.resolve(ev.cwd), common)) || cwdWorktree(dir, common) || (!ev.agent && cwdWorktree(root, common)) || null;
}
// a word as each path it may name: as written, without backslash escapes, and its value after the first =
const wordForms = (w) => [...new Set([w, w.replace(/\\(.)/g, "$1")].flatMap((v) => [v, v.slice(v.indexOf("=") + 1)]))];
// why a worker's shell may not write t (a word as written) from dir into wt, or ""; the path a link on the way
// leads to must be allowed too
function confineDenial(t, dir, wt, what) {
  for (const v of wordForms(t)) {
    if (DEVICES.test(v)) continue;
    if (/[$`]/.test(expandPath(v, dir))) return AGENT_MSG.runtime(what, t);
    for (const p of spellings(v, dir)) {
      const rp = realTarget(p), no = ownedWhy(wt, p, true) || (rp && ownedWhy(realOr(wt), rp, true));
      if (no) return no[1] === "outside the worktree" ? AGENT_MSG.confine(what, fwd(p), `outside your worktree ${fwd(wt)}`) : AGENT_MSG.confine(what, no[0], no[1]);
    }
  }
  return "";
}
// the code an interpreter runs from its arguments, null when none: python -c, node -e/-p/--eval/--print,
// perl -e/-E and ruby -e, clustered or with the code attached
const INLINE = [[/^python[\d.]*$/, /^-[bBdEhiIOqsSuvx]*c([\s\S]*)$/], [/^(?:node|nodejs)$/, /^(?:-[a-zA-Z]*[ep]|--(?:eval|print)(?:=([\s\S]*))?)$/],
  [/^perl[\d.]*$/, /^-[nplaswtTUWX]*[eE]([\s\S]*)$/], [/^ruby[\d.]*$/, /^-[nplaswdvW]*e([\s\S]*)$/]];
const interpreter = (prog) => INLINE.find(([p]) => p.test(prog)) || null;
function inlineCode(words) {
  const it = interpreter(progName(words[0]));
  if (!it) return null;
  const out = [];
  for (let k = 1; k < words.length; k++) {
    const m = it[1].exec(words[k]);
    if (m) out.push(m[1] ? m[1] : words[++k] ?? "");
  }
  return out.length ? out : null;
}
// what code names: its string literals, and its bare words that look like a path
const CODE_STRING = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
function codeNames(code) {
  const strs = [];
  const bare = String(code).replace(CODE_STRING, (_, a, b, c) => { strs.push(a ?? b ?? c ?? ""); return " "; });
  return [strs, (bare.match(/[^\s"'`(),;{}[\]=<>|&!*+%^?]+/g) || []).filter((w) => /[\\/]|^[.~]/.test(w))];
}
// why a worker's inline code may not run: a literal or path-like word names a guarded path, or a literal names a
// path outside wt and its scratch dir (a URL, a bare separator and text with spaces are no paths)
function inlineDenial(ev, code, dir, wt, what, clock) {
  const t0 = performance.now();
  const [strs, words] = codeNames(code);
  if (clock && (clock.left -= performance.now() - t0) < 0) throw tooComplex();
  for (const w of [...strs, ...words]) {
    for (const v of wordForms(w.replace(/^[+<>|]+/, ""))) {
      const rel = v && writeRel(v, dir, ev);
      if (rel) return AGENT_MSG.inline(what, rel, "which holds Proteus's hooks, gates, git internals or CLI settings");
    }
  }
  if (!wt) return "";
  const common = gitCommonDir(wt), ok = (q, w) => relPath(w, q) !== null || inScratch(common, q);
  for (const s of strs) {
    if (/\s/.test(s) || /^(?:\\.|[\\/])*$/.test(s) || /^[a-z][\w+.-]*:\/\//i.test(s)) continue;
    for (const v of wordForms(s.replace(/^[+<>|]+/, ""))) {
      if (!v || DEVICES.test(v) || /\s/.test(v)) continue;
      for (const p of spellings(v, dir)) {
        const rp = realTarget(p);
        if (!ok(p, wt) || (rp && !ok(rp, realOr(wt)))) return AGENT_MSG.inline(what, fwd(p), `outside your worktree ${fwd(wt)} and its scratch dir`);
      }
    }
  }
  return "";
}

// a writer whose operands xargs would append from stdin (#48 F4)
function writesOperands(words) {
  const prog = progName(words[0]), args = words.slice(1);
  return WRITE_ALL.has(prog) || WRITE_LAST.has(prog) || prog === "dd" || (IN_PLACE[prog] && args.some((a) => IN_PLACE[prog].test(a))) || (AWK.test(prog) && args.includes("inplace"));
}
// awk's program text: -f FILE runs a file (judged like a script on disk); -e / --source TEXT, else the first operand
const AWK_VALUE = ["-F", "--field-separator", "-v", "--assign", "-i", "--include", "-l", "--load"];
function awkProgram(words) {
  const args = words.slice(1), out = [];
  let file = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === "--") { if (!out.length && !file && args[k + 1] !== undefined) out.push(args[k + 1]); break; }
    if (a === "-e" || a === "--source") out.push(args[++k] ?? "");
    else if (a.startsWith("--source=")) out.push(a.slice(9));
    else if (a === "-f" || a === "--file" || a.startsWith("--file=")) { file = true; if (!a.includes("=")) k++; }
    else if (AWK_VALUE.includes(a)) k++;
    else if (a.startsWith("-")) continue;
    else { if (!out.length && !file) out.push(a); break; }
  }
  return out;
}
// ln / link: a link whose target is outside the worker's owned paths and scratch dir (#48 F7). A symbolic target
// resolves from the link's dir (from the cwd with -r), a hard link's from the cwd
function linkDenial(words, dir, wt) {
  const prog = progName(words[0]), args = words.slice(1);
  const sym = prog === "ln" && args.some((a) => /^(?:-[a-zA-Z]*s[a-zA-Z]*|--symbolic)$/.test(a));
  const rel = args.some((a) => /^(?:-[a-zA-Z]*r[a-zA-Z]*|--relative)$/.test(a));
  let into = null;
  const ops = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === "--") { ops.push(...args.slice(k + 1)); break; }
    if (/^-[a-zA-Z]*t$/.test(a) || a === "--target-directory") into = args[++k] || "";
    else if (a.startsWith("--target-directory=")) into = a.slice(19);
    else if (a === "-S" || a === "--suffix") k++;
    else if (!a.startsWith("-")) ops.push(a);
  }
  if (into === null && ops.length > 1) into = ops.pop();
  for (const t of ops) {
    const link = into === null ? path.basename(t) : into;
    const linkAbs = path.resolve(dir, expandPath(link, dir));
    if (relPath(realOr(wt), realOr(linkAbs)) === null && relPath(wt, linkAbs) === null) continue; // a link outside: confined as a write
    let base = dir;
    if (sym && !rel) { try { base = fs.statSync(linkAbs).isDirectory() ? linkAbs : path.dirname(linkAbs); } catch { base = path.dirname(linkAbs); } }
    // a resolved Windows path in forward slashes: confineDenial reads a backslash as a shell escape
    const abs = /^(?:[\\/]|[a-zA-Z]:|[~$])/.test(t) ? t : path.resolve(base, t).replace(/\\/g, "/");
    if (confineDenial(abs, dir, wt, prog)) return AGENT_MSG.link(`${prog}${sym ? " -s" : ""}`, link, t, "outside your owned paths and scratch dir");
  }
  return "";
}

function agentShellDenial(ev, command = ev.command, cwd = shellCwd(ev), depth = 0, ctx = { worker: false }) {
  let dir = path.resolve(cwd || projectRoot(ev));
  const written = new Set(); // paths this line writes: a patch made earlier in the same call is not read in time
  const judge = (t) => writeRel(t, dir, ev);
  // owned/scratch confinement is reported after every other rule, so a guarded path keeps its own message
  const late = [];
  // a worker with no worktree known writes nothing but the console devices (#48 F1)
  const confine = (t, what) => {
    if (!ctx.worker || late.length) return;
    const wt = workerTree(ev, dir);
    const why = wt ? confineDenial(t, dir, wt, what) : wordForms(t).every((v) => DEVICES.test(v)) ? "" : AGENT_MSG.noTree(what);
    if (why) late.push(why);
  };
  const cmds = shellCommands(command, ctx.clock);
  // what a shell or interpreter in this line reads on stdin: the heredoc bodies, and the other commands' words
  const stdin = (self, spaced) => {
    const t0 = performance.now();
    const out = [...String(command).matchAll(HEREDOC_BODY)].map((m) => m[3]);
    if (ctx.clock && (ctx.clock.left -= performance.now() - t0) < 0) throw tooComplex();
    for (const c of cmds) if (c !== self) out.push(...c.filter((w) => !spaced || /\s/.test(w)));
    return out;
  };
  const findDenial = (args) => {
    const f = findParts(args);
    for (const w of f.writes) { const rel = judge(w); if (rel) return AGENT_MSG.write("find -fprint", rel); }
    if (f.del) for (const s of f.starts) { const rel = treeRel(s, dir, ev); if (rel) return AGENT_MSG.tree("find -delete", s, rel); }
    for (const cmd of f.execs) {
      const inner = unwrap(cmd);
      // {} is every path under the start points, so a command that writes it writes under each of them
      const writesFound = [...writeTargets(inner), ...treeTargets(inner).map(([t]) => t)].some((t) => t.includes("{}"));
      for (const s of f.starts) {
        const sub = Object.assign(cmd.map((w) => w.split("{}").join(s)), { redirects: [] });
        const why = simple(sub, unwrap(sub), true);
        if (why) return why;
        const rel = writesFound && treeRel(s, dir, ev);
        if (rel) return AGENT_MSG.tree(`find -exec ${progName(inner[0])}`, s, rel);
      }
    }
    return null;
  };
  // one simple command; inner: run by find -exec, so a cd there moves nothing after it
  const simple = (all, words, inner = false) => {
    const prog = progName(words[0]);
    for (const t of all.redirects || []) {
      const rel = judge(t);
      if (rel) return AGENT_MSG.write(`> ${t}`, rel);
      confine(t, `> ${t}`);
      for (const p of spellings(t, dir)) written.add(p);
    }
    if (!words.length) return null;
    if (prog === "node" && /(^|[\\/])proteus-worktree\.js$/.test(words[1] || "") && words.some((w) => /^--allow(?:=|$)/.test(w))) return AGENT_MSG.selfAllow;
    if (prog === "cd" || prog === "pushd") {
      const to = words.slice(1).find((w) => !w.startsWith("-") || w === "-");
      if (!inner && to !== "-") dir = path.resolve(dir, expandPath(to || "~", dir));
      return null;
    }
    if (prog === "git") {
      const force = forcePush(words);
      if (force) {
        // one force-push per allow entry: a second one in the same call is refused
        const wt = ctx.worker && !ctx.force && workerTree(ev, dir);
        if (!wt || !allowLines(wt).includes("force-push")) return AGENT_MSG.force(force);
        Object.assign(ctx, { force: wt, forceFlag: force });
      }
      for (const [opt, p, v] of gitDirs(all, words, dir)) {
        if (p === null) return UNEXPANDED_MSG(opt.endsWith("=") ? opt + v : `git ${opt} ${v}`.trim());
        const root = gitRoot(p), common = root && gitCommonDir(root);
        const own = ownWorktree(ev, dir, common);
        if (!root || !own || !samePath(realOr(root), realOr(own))) return AGENT_MSG.gitDir(opt, p.split(path.sep).join("/"), own ? `yours is ${own.split(path.sep).join("/")}` : "");
      }
      return gitWriteDenial(ev, all, words, dir, written, ctx.worker);
    }
    if (prog === "gh") return ghAgentDenial(words.slice(1));
    if (prog === "node" && /(^|[\\/])proteus-gh\.js$/.test(words[1] || "")) return ghAgentDenial(words.slice(2));
    // sh -c '<script>': judged as its own command line, from the same dir; a worker's sh reading stdin judges
    // what it reads, and nesting past 3 is too complex for a worker
    if ((NESTED_SHELLS.has(prog) || prog === "eval") && depth >= 3 && ctx.worker) throw tooComplex();
    // what a shell (or source / .) reads on stdin: heredocs, pipes and a here-string
    const fromStdin = () => {
      for (const text of [...stdin(all, true), ...(String(command).includes("<<<") ? words.slice(1).filter((w) => /\s/.test(w)) : [])]) {
        const why = agentShellDenial(ev, text, dir, depth + 1, ctx);
        if (why) return why;
      }
      return null;
    };
    if (NESTED_SHELLS.has(prog) && depth < 3) {
      // -c, alone or ending a flag cluster (-lc, -ec, -xc); -o / -O take a value
      let c = -1;
      for (let k = 1; k < words.length && /^[-+]/.test(words[k]) && words[k] !== "--"; k++) {
        if (/^-[a-zA-Z]*c$/.test(words[k])) { c = k; break; }
        if (/^[-+][oO]$/.test(words[k])) k++;
      }
      if (c > 0 && words[c + 1] !== undefined) return agentShellDenial(ev, words[c + 1], dir, depth + 1, ctx);
      return ctx.worker ? fromStdin() : null;
    }
    if ((prog === "source" || prog === ".") && ctx.worker) {
      // a file in the worktree runs like any script there; stdin, /dev/stdin or <( ) is judged as it is read
      if (depth >= 3) throw tooComplex();
      const f = words[1];
      if (f === undefined || /^(?:-|<.*|\/dev\/stdin|\/dev\/fd\/0|\/proc\/self\/fd\/0)$/.test(f)) return fromStdin();
      return null;
    }
    if (prog === "eval" && depth < 3) return agentShellDenial(ev, words.slice(1).join(" "), dir, depth + 1, ctx);
    if (prog === "find") return findDenial(words.slice(1));
    if (prog === "patch") return patchDenial("patch", words.slice(1), dir, written, ev);
    if (ctx.worker && (interpreter(prog) || AWK.test(prog))) {
      const wt = workerTree(ev, dir);
      const code = AWK.test(prog) ? awkProgram(words) : inlineCode(words) || stdin(all, false);
      if (!wt && code.length) return AGENT_MSG.noTree(prog);
      for (const text of code) {
        const why = inlineDenial(ev, text, dir, wt, prog, ctx.clock);
        if (why) return why;
      }
    }
    for (const t of writeTargets(words)) {
      const rel = judge(t);
      if (rel) return AGENT_MSG.write(prog, rel);
      confine(t, prog);
      for (const p of spellings(t, dir)) written.add(p);
    }
    for (const [t, tree] of treeTargets(words)) {
      const rel = tree ? treeRel(t, dir, ev) : judge(t);
      if (rel) return tree ? AGENT_MSG.tree(`${prog}${prog === "rm" || prog === "cp" ? " -r" : ""}`, t, rel) : AGENT_MSG.write(prog, rel);
    }
    // after the guarded-path rules, so a guarded target keeps its own message
    if (ctx.worker && all.slice(0, all.length - words.length).some((w) => progName(w) === "xargs") && writesOperands(words)) return AGENT_MSG.xargs(prog);
    if (ctx.worker && (prog === "ln" || prog === "link")) {
      const wt = workerTree(ev, dir), why = wt && linkDenial(words, dir, wt);
      if (why) return why;
    }
    return null;
  };
  for (const all of cmds) {
    const why = simple(all, unwrap(all));
    if (why) return why;
  }
  return late[0] || null;
}

// copy src → dst only when the bytes differ; true when written
function syncFile(src, dst) {
  let a;
  try { a = fs.readFileSync(src); } catch { return false; }
  return syncText(a, dst);
}
// write dst only when its bytes differ; true when written. With a marker, a dst that exists
// without it as its first text is the user's own and is left alone (install.js keeps it too).
// A link at dst (a repo may commit one) is never written through: refused, with a warning (#22).
function syncText(a, dst, marker) {
  a = Buffer.isBuffer(a) ? a : Buffer.from(String(a));
  let st = null;
  try { st = fs.lstatSync(dst); } catch {}
  if (st && st.isSymbolicLink()) { console.error(`refused  ${dst} (a link; not written through, left alone)`); return false; }
  let cur = null;
  try { cur = fs.readFileSync(dst); } catch {}
  if (cur && a.equals(cur)) return false;
  if (cur && marker && !cur.toString("utf8").startsWith(marker)) return false;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, a);
  return true;
}

// The human's inbox: open needs-human issues, cached in <common>/proteus-lead/inbox.json as
// {at, questions:[{n,title}], reviews:[{n,title}]}. null when there is no cache.
const inboxFile = (common) => leadPath(common, "inbox.json");
function readInbox(common) {
  const c = readJSON(inboxFile(common), null);
  return c && Array.isArray(c.questions) && Array.isArray(c.reviews) ? c : null;
}

// ---- skills lock: teams/skills-lock.json pins each linked skill's content hash (teams/link-skills.js).
// A drifted skill is one whose copy linked under teams/<team>/{.claude,.agents}/skills/<name> hashes
// differently from its pin; no lock, or a pinned skill linked nowhere, is no drift. Local files only.
const lockFile = (root) => path.join(docRoot(root), "teams", "skills-lock.json");
const driftFile = (common) => leadPath(common, "skills-drift.json");
const SKILL_LINKS = [[".claude", "skills"], [".agents", "skills"]];

// byte-identical to link-skills.js hashDir (sha256 over relative path + content of every file), or every lock drifts
const walkSkill = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.name === "node_modules" || e.name === ".git" ? [] : e.isDirectory() ? walkSkill(path.join(d, e.name)) : [path.join(d, e.name)]);
function hashSkill(d) {
  const h = require("crypto").createHash("sha256");
  for (const f of walkSkill(d).sort()) {
    h.update(path.relative(d, f).split(path.sep).join("/") + "\0");
    h.update(fs.readFileSync(f));
    h.update("\0");
  }
  return h.digest("hex");
}

function skillsDrift(root) {
  const lock = readJSON(lockFile(root), null);
  const pins = lock && lock.skills && typeof lock.skills === "object" ? lock.skills : {};
  const names = Object.keys(pins).filter((n) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(n) && pins[n] && typeof pins[n].hash === "string");
  const base = docRoot(root);
  let teams = [];
  try { teams = fs.readdirSync(path.join(base, "teams"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch {}
  const hashes = new Map(); // real skill dir -> hash, so a skill linked into several teams is hashed once
  const drift = [];
  for (const name of names) {
    for (const dir of teams.flatMap((t) => SKILL_LINKS.map((s) => path.join(base, "teams", t, ...s, name)))) {
      let src;
      try { src = fs.realpathSync(dir); if (!fs.statSync(src).isDirectory()) continue; } catch { continue; }
      if (!hashes.has(src)) hashes.set(src, hashSkill(src));
      if (hashes.get(src) !== pins[name].hash) { drift.push(name); break; }
    }
  }
  return drift.sort();
}

// the drifted skills, cached in <common>/proteus/skills-drift.json per lock content: a clean result
// stands until the lock changes (the autostart passes fresh on every session start), a drift is
// re-checked on every call so a re-lock or an update counts at once
function lockDrift(root, fresh = false) {
  let key;
  try { key = require("crypto").createHash("sha256").update(fs.readFileSync(lockFile(root))).digest("hex"); } catch { return []; }
  const common = gitCommonDir(root);
  const cache = common && !fresh ? readJSON(driftFile(common), null) : null;
  if (cache && cache.lock === key && Array.isArray(cache.drift) && !cache.drift.length) return [];
  const drift = skillsDrift(root);
  if (common) { try { leadJSON(common, driftFile(common), { lock: key, drift }); } catch {} }
  return drift;
}

// how to clear a drift; the lead does not re-lock on its own: third-party skill text runs in every worker
const relockHint = (drift) => `Drifted from teams/skills-lock.json: ${drift.join(", ")}. Ask the human to run \`npx skills update <skill>\` so the copy matches the lock again, or \`node teams/link-skills.js --relock\` to accept this machine's copies and commit teams/skills-lock.json.`;

// ---- model ladder: the lead is whatever model the session runs; no agent goes above it.
// Rungs cheapest first. ~/.claude/proteus.json "models": { ladder, floor, solo, aliases } overrides
// the defaults (aliases, other names of a rung's model, merge over the harness's); a project's
// `models:` line in AGENTS.md (the human's call, e.g. `models: solo=none floor=haiku`) overrides
// floor and solo. A solo model never runs as a subagent: at most one per project, and that one
// is the lead when the session runs on it.
// Roles map to three tiers, each a model and an effort: judge (verifiers, scout, contracts,
// escalations, conflicts, QA at milestone and close), build (tickets) and helper (QA per wave,
// guide, research, helpers). A tier is "<model>[@<effort>]" or { model, effort }; the model is top
// (the highest rung the lead may staff), mid (one under it, not under the floor), a rung or a
// model id, kept between the floor and top. "models": { "tiers": {...} } and judge=/build=/helper=
// on the AGENTS.md line override the harness's tiers. Effort applies only where the harness
// passes it per spawn (adapter spawnEffort, the spawn tool's parameter name); elsewhere it is "".
// the harness's default ladder; none (a CLI whose lineup Proteus does not know) is single-model
// mode, the lead's own model as the only rung, until models.ladder names one
const modelDefaults = () => harness().models || { ladder: [], floor: "", solo: [], aliases: {} };
const MODEL_TIERS = { judge: "top", build: "mid", helper: "mid" };
function tierSpec(v) {
  if (v && typeof v === "object") return { model: String(v.model || "").toLowerCase(), effort: String(v.effort || "").toLowerCase() };
  const [model = "", effort = ""] = String(v || "").toLowerCase().split("@");
  return { model, effort };
}

// ladder index of a model name or id ("claude-opus-5-5[1m]" → opus); the longest matching rung wins,
// else the longest matching alias names the rung ("claude-mythos-5-1" → fable with { mythos: "fable" })
function rungOf(ladder, name, aliases = {}) {
  const n = String(name || "").toLowerCase();
  const longest = (keys) => keys.filter((k) => k && n.includes(k)).sort((a, b) => b.length - a.length)[0];
  const r = longest(ladder);
  if (r) return ladder.indexOf(r);
  const a = longest(Object.keys(aliases));
  return a ? ladder.indexOf(aliases[a]) : -1;
}

// the session's model, as the harness finds it
const leadModel = (ev) => harness().sessionModel(ev);
// the model SessionStart reported, kept by the autostart for when the transcript tail has no reply
const leadFile = (root) => { const c = gitCommonDir(root); return c ? leadPath(c, "lead-model.json") : null; };
function saveLead(ev, root) {
  const f = leadFile(root);
  if (f && ev.model && ev.session) leadJSON(gitCommonDir(root), f, { session: ev.session, model: ev.model });
}
function savedLead(ev, root) {
  const f = leadFile(root);
  const saved = f ? readJSON(f, null) : null;
  return saved && saved.session === ev.session && typeof saved.model === "string" ? saved.model : "";
}

function modelPolicy(root) {
  const cfg = (proteusConfig().models || {});
  const list = (v) => (Array.isArray(v) ? v : String(v || "").split(",")).map((x) => String(x).trim().toLowerCase()).filter((x) => x && x !== "none");
  const d = modelDefaults();
  const ladder = Array.isArray(cfg.ladder) && cfg.ladder.length ? list(cfg.ladder) : d.ladder;
  const aliases = {}, own = cfg.aliases && typeof cfg.aliases === "object" ? cfg.aliases : {};
  for (const [k, v] of Object.entries({ ...d.aliases, ...own })) if (typeof v === "string") aliases[k.toLowerCase()] = v.toLowerCase();
  const tiers = {}, ownTiers = cfg.tiers && typeof cfg.tiers === "object" ? cfg.tiers : {};
  for (const [k, v] of Object.entries({ ...MODEL_TIERS, ...d.tiers, ...ownTiers })) if (k in MODEL_TIERS) tiers[k] = tierSpec(v);
  const pol = { ladder, floor: String(cfg.floor || d.floor).toLowerCase(), solo: "solo" in cfg ? list(cfg.solo) : d.solo, aliases, tiers };
  const line = agentsLine(root, "models");
  if (line !== null) {
    for (const [, k, v] of line.matchAll(/(\w+)=(\S+)/g)) {
      if (k === "floor") pol.floor = v.toLowerCase();
      if (k === "solo") pol.solo = list(v);
      if (k in MODEL_TIERS) pol.tiers[k] = tierSpec(v);
    }
  }
  return pol;
}

// what this session may spawn: top and mid, and the model and effort of each role tier
function modelCaps(ev, root) {
  const pol = modelPolicy(root);
  const lead = leadModel(ev) || savedLead(ev, root);
  const ladder = pol.ladder.length ? pol.ladder : lead ? [String(lead).toLowerCase()] : [];
  const { solo, aliases } = pol;
  const effortParam = harness().spawnEffort || "";
  const none = { model: "", effort: "" };
  if (!ladder.length) return { ladder, solo, aliases, lead, leadRung: -1, cap: -1, floor: -1, top: "", mid: "", floorName: "", effortParam, tiers: { judge: none, build: none, helper: none } }; // nothing known to enforce
  const L = rungOf(ladder, lead, aliases);
  // highest rung at or under the lead that is not solo (the lead is that one instance); unknown lead: the whole ladder
  let cap = L < 0 ? ladder.length - 1 : L;
  while (cap > 0 && solo.includes(ladder[cap])) cap--;
  const fl = rungOf(ladder, pol.floor, aliases);
  const floor = Math.min(fl < 0 ? 0 : fl, cap); // a lead below the floor takes the floor down with it
  const mid = Math.max(floor, cap - 1);
  // a tier's rung: top, mid, or the named model's, held between the floor and top; an unknown or
  // solo model falls back to the default tier's rung. A named model in range keeps its full id.
  const tier = (t, dflt) => {
    const named = !["top", "mid"].includes(t.model);
    let r = t.model === "top" ? cap : t.model === "mid" ? mid : rungOf(ladder, t.model, aliases);
    if (r < 0 || solo.includes(ladder[r])) r = dflt === "top" ? cap : mid;
    const held = Math.min(Math.max(r, floor), cap);
    return { model: named && held === r && rungOf(ladder, t.model, aliases) === r ? t.model : ladder[held], effort: effortParam ? t.effort : "" };
  };
  const tiers = {};
  for (const k of Object.keys(MODEL_TIERS)) tiers[k] = tier(pol.tiers[k], MODEL_TIERS[k]);
  return { ladder, solo, aliases, lead, leadRung: L, cap, floor, top: ladder[cap], mid: ladder[mid], floorName: ladder[floor], effortParam, tiers };
}

// ---- context window: the handoff lines are fractions of the lead's window, the smallest of the
// model's nominal window (adapter modelWindow), the cap the human set in the harness (adapter
// contextCap: Claude Code's autoCompactWindow, Codex's model_auto_compact_token_limit) and
// "contextWindow" in ~/.claude/proteus.json; 200k when none is known. A configured cap wins over
// a 1M model, so a 200k cap keeps the lines at 150k and 180k.
const DEFAULT_WINDOW = 200000;
function contextWindow(ev, root) {
  const h = harness();
  const model = leadModel(ev) || savedLead(ev, root);
  const known = [h.modelWindow ? h.modelWindow(model, ev) : 0, h.contextCap ? h.contextCap(ev, model) : 0, +proteusConfig().contextWindow].filter((n) => n > 0);
  return known.length ? Math.min(...known) : DEFAULT_WINDOW;
}
// at: the journal tells the lead to hand off; hard: the guard refuses new spawns. PROTEUS_HANDOFF_AT
// and PROTEUS_HANDOFF_HARD (tokens) override them.
function handoffLines(ev, root) {
  const w = contextWindow(ev, root);
  return { window: w, at: envInt("PROTEUS_HANDOFF_AT", Math.round(w * 0.75)), hard: envInt("PROTEUS_HANDOFF_HARD", Math.round(w * 0.9)) };
}

// Liveness of the lead's workers and verifiers, read by proteus-watchdog.js: one file per agent in
// <git-common-dir>/proteus/beats/. "tool" (the lead's guard, on each of its tool calls) stamps `last`,
// "ended" (proteus-stall.js, a stop with no final message) stamps `ended`, "done" (a stop that hands one back)
// removes the file. Other agent types (scout, guide) are not tracked: they end without a report.
// Only an agent the lead spawned itself is tracked (#179): one with a lead spawn record (spawnRecord), so nested
// agents a worker or verifier starts, and foreign ones, are not. An agent `--forget` dropped stays dropped
// (forgotten): by its id, or by `--forget all` at or after its spawn, so a late stop does not bring it back.
// the agents that run team skills: proteus-worker, proteus-verifier, proteus-<team>-worker/verifier
const PIPELINE_AGENT = /^proteus-(?:[a-z0-9-]+-)?(?:worker|verifier)$/;
const isPipelineAgent = (type) => PIPELINE_AGENT.test(agentName(type));
const beatsDir = (common) => leadPath(common, "beats");
// written by the watchdog, which the lead runs from its shell (sandboxed, so it cannot write proteus-lead):
// agent-writable, read as untrusted
const forgetFile = (common) => path.join(stateDir(common), "forgotten.json");
const isoMs = (iso) => { const t = Date.parse(iso || ""); return Number.isFinite(t) ? t : 0; };
// proteus-watchdog.js --forget: ids forgotten now, and all = every agent spawned until now; a week's ids are kept
function forget(common, ids, all = false) {
  const prev = readUntrustedJSON(forgetFile(common), null) || {};
  const now = new Date().toISOString();
  const keep = Date.now() - 7 * 24 * 3600e3;
  const agents = {};
  for (const [id, at] of Object.entries(prev.agents && typeof prev.agents === "object" ? prev.agents : {})) if (isoMs(at) >= keep) agents[id] = at;
  for (const id of ids) agents[id] = now;
  writeJSON(forgetFile(common), { all: all ? now : prev.all || "", agents });
}
function forgotten(common, id, spawnAt) {
  const f = readUntrustedJSON(forgetFile(common), null) || {};
  if (f.agents && typeof f.agents === "object" && Object.prototype.hasOwnProperty.call(f.agents, id)) return true;
  return !!f.all && isoMs(f.all) >= isoMs(spawnAt);
}
function beat(ev, state) {
  if (!ev.agent) return;
  try {
    const common = gitCommonDir(projectRoot(ev));
    if (!common) return;
    const file = path.join(beatsDir(common), `${String(ev.agent).replace(/[^\w.-]/g, "_")}.json`);
    if (state === "done") { leadRemove(common, file); return; }
    const spawn = spawnRecord(ev);
    if (!spawn || !isPipelineAgent(spawn.type) || forgotten(common, ev.agent, spawn.at)) return;
    const prev = readJSON(file, null) || {};
    const now = new Date().toISOString();
    // a rewrite drops `flagged`: a tool call after the watchdog's STALL is the agent answering
    const rec = { agent: ev.agent, type: spawn.type, spawn: spawn.at || "", session: ev.session || prev.session || "", cwd: ev.cwd || prev.cwd || "", first: prev.first || now, last: now };
    if (state === "ended") { rec.last = prev.last || now; rec.ended = now; rec.flagged = prev.flagged; }
    leadJSON(common, file, rec);
  } catch {}
}

// gh query → cache; on any gh failure the old cache stays and null is returned
function refreshInbox(root, common, timeout = 10000) {
  let list;
  try { list = JSON.parse(gh(["issue", "list", "--label", "needs-human", "--state", "open", "--json", "number,title,labels", "--limit", "100"], root, timeout)); } catch { return null; }
  if (!Array.isArray(list)) return null;
  const has = (i, name) => (i.labels || []).some((l) => l && l.name === name);
  const item = (i) => ({ n: i.number, title: String(i.title || "") });
  const inbox = { at: new Date().toISOString(), questions: list.filter((i) => SCHEMES.some((s) => has(i, s.question))).map(item), reviews: list.filter((i) => SCHEMES.some((s) => has(i, s.review))).map(item) };
  try { leadJSON(common, inboxFile(common), inbox); } catch {}
  return inbox;
}

// the proteus marketplace's repo from known_marketplaces.json: url to fetch tags from, add as the
// claude plugin marketplace add source; the maintainer's GitHub repo when it names none
function marketSource() {
  const m = readJSON(path.join(claudeDir(), "plugins", "known_marketplaces.json"), {}) || {};
  const s = (m.proteus && m.proteus.source) || {};
  const strip = (v) => (typeof v === "string" ? v.replace(/#.*$/, "") : "");
  if (s.source === "github" && /^[\w.-]+\/[\w.-]+$/.test(strip(s.repo))) return { url: `https://github.com/${strip(s.repo)}.git`, add: strip(s.repo) };
  const u = strip(s.url) || strip(s.path);
  if (u) return { url: u, add: u };
  return { url: "https://github.com/Yousef-Baidas/proteus.git", add: "Yousef-Baidas/proteus" };
}
// the commands that pin the plugin to tag, as checked against the real CLI (#136): re-adding a marketplace at another
// ref fails while the user settings' extraKnownMarketplaces names it, so that entry goes first (a project's entry
// keeps the plugin installed through it); install brings it back where the remove uninstalled it, update moves it
function pinCommand(tag) {
  const u = readJSON(path.join(claudeDir(), "settings.json"), {}) || {};
  const declared = !!(u.extraKnownMarketplaces && u.extraKnownMarketplaces.proteus);
  return [...(declared ? ["claude plugin marketplace remove proteus --scope user"] : []), `claude plugin marketplace add ${marketSource().add}#${tag}`,
    "claude plugin install proteus@proteus", "claude plugin update proteus@proteus"].join(" && ");
}

// The plugin's release check (#136, D6): the installed commit (gitCommitSha of proteus@proteus in the config
// dir's plugins/installed_plugins.json) must be the target of a vX.Y.Z tag that verifyRelease accepts, against
// a bare clone of the marketplace's repo in CLAUDE_PLUGIN_DATA/releases.git that fetches tags at most once a day,
// trusting ~/.config/proteus/allowed_signers (docs/updating.md "Releases") or the user's own git config. The result is
// cached in release-check.json until the commit, the trust file or the tags change. Verified: silent. Not: one
// loud line with the newest verified tag and how to pin to it. A failed fetch: one quiet line, the last result.
// plugin: the plugin root; data: its CLAUDE_PLUGIN_DATA. Run by the autostart and once by install.js --plugin-setup.
function releaseCheck(root, notes, plugin, data) {
  const sha = installedSha(root, plugin);
  if (!sha || !data) {
    notes.push(`proteus: release check skipped: no ${sha ? "CLAUDE_PLUGIN_DATA" : "gitCommitSha for proteus@proteus in installed_plugins.json"}`);
    return;
  }
  const bare = path.join(data, "releases.git"), file = path.join(data, "release-check.json");
  const st = readJSON(file, {}) || {};
  const src = marketSource();
  const signers = path.join(os.homedir(), ".config", "proteus", "allowed_signers");
  let trust = 0;
  try { trust = fs.statSync(signers).mtimeMs; } catch {}
  let fetched = typeof st.fetched === "number" ? st.fetched : 0, failed = "";
  if (Date.now() - fetched > 24 * 3600e3) {
    fetched = Date.now();
    failed = fetchTags(bare, src.url);
  }
  // one result per installed commit (#155): repos on different pins (user and project scope) share the cache
  const by = st.bySha && typeof st.bySha === "object" && !Array.isArray(st.bySha) ? st.bySha : {};
  const prev = by[sha] && typeof by[sha] === "object" ? by[sha] : st.sha === sha ? st : {};
  const fresh = prev.trust === trust && prev.fetched === fetched && prev.result;
  let res = fresh ? prev.result : null;
  if (failed) notes.push(`proteus: release check could not fetch tags from ${src.url} (${failed}); ${prev.result ? "using the last result" : "checking the tags fetched before"}`);
  if (!res && failed && prev.result) res = prev.result;
  if (!res) {
    if (!fs.existsSync(path.join(bare, "HEAD"))) return;
    if (trust) homeGit(bare, ["config", "gpg.ssh.allowedSignersFile", signers]);
    res = verifyInstalled(bare, sha);
  }
  const keep = Object.keys(by).filter((k) => k !== sha).slice(-15);
  writeJSON(file, { fetched, sha, trust, result: res, bySha: { ...Object.fromEntries(keep.map((k) => [k, by[k]])), [sha]: { fetched, trust, result: res } } });
  if (res.tag) return;
  const pin = res.newest
    ? `Newest verified release: ${res.newest}; to pin to it, run ${pinCommand(res.newest)}`
    : `No release verifies here; to trust the maintainer's key see "Releases" in ${path.join(plugin, "docs", "updating.md")}`;
  notes.push(`proteus: WARNING: the installed plugin commit ${sha.slice(0, 12)} is not a verified Proteus release (${res.error}). ${pin}. Tell the human once; nothing is blocked.`);
}

// the proteus@proteus install (installed_plugins.json) this hook runs from: the entry whose installPath is the
// plugin root, else this project's, else the user-scope one; null when none
function installedEntry(root, plugin) {
  const j = readJSON(path.join(claudeDir(), "plugins", "installed_plugins.json"), {}) || {};
  const all = (j.plugins && Array.isArray(j.plugins["proteus@proteus"]) ? j.plugins["proteus@proteus"] : []).filter((e) => e && typeof e === "object");
  const same = (a, b) => typeof a === "string" && typeof b === "string" && !!a && !!b && samePath(a, b);
  return all.find((x) => same(x.installPath, plugin)) || all.find((x) => same(x.projectPath, root)) || all.find((x) => x.scope === "user") || all[0] || null;
}
// its gitCommitSha; "" when none
function installedSha(root, plugin) {
  const e = installedEntry(root, plugin);
  const sha = e && typeof e.gitCommitSha === "string" ? e.gitCommitSha.trim().toLowerCase() : "";
  return /^[0-9a-f]{7,64}$/.test(sha) ? sha : "";
}

// fetches url's tags (and their commits) into the bare clone; "" when it worked, else git's one-line reason
function fetchTags(bare, url) {
  try {
    const gd = path.resolve(bare);
    if (!fs.existsSync(path.join(gd, "HEAD"))) gitRun(gd, ["init", "--quiet", "--bare", gd], { cwd: os.tmpdir(), timeout: 10000, stdio: ["ignore", "ignore", "pipe"] });
    // a fetch keeps the human's global config: their credentials and proxy
    const [args, o] = gitCall(gd, ["fetch", "--quiet", "--force", "--prune", "--no-tags", url, "+refs/tags/*:refs/tags/*"], { user: true, timeout: 20000, stdio: ["ignore", "ignore", "pipe"] });
    execFileSync("git", args, { ...o, env: { ...o.env, GIT_TERMINAL_PROMPT: "0" } });
    return "";
  } catch (e) {
    return String(e.stderr || e.message || "").trim().split(/\r?\n/).pop().replace(/^fatal: /, "").slice(0, 200) || "git failed";
  }
}

// { tag, newest, error }: tag the release pointing at sha that verifies ("" when none), newest the newest verified
// release (at most 10 tried), error why sha is not a verified release
function verifyInstalled(bare, sha) {
  const refs = homeGit(bare, ["for-each-ref", "refs/tags", "--format=%(refname:short) %(objectname) %(*objectname)"])
    .split("\n").map((l) => l.trim().split(" ")).filter(([t]) => RELEASE.test(t || ""));
  refs.sort((a, b) => (newerThan(a[0], b[0]) ? -1 : newerThan(b[0], a[0]) ? 1 : 0));
  const at = refs.filter(([, o, c]) => (c || o || "").startsWith(sha) || (sha.length === 40 && (c || o) === sha));
  let tag = "", error = at.length ? "" : "no release tag points at it";
  for (const [t] of at) {
    const v = verifyRelease(bare, t, false);
    if (!v.error && v.commit.startsWith(sha)) { tag = t; break; }
    error = error || v.error;
  }
  let newest = tag;
  for (const [t] of refs.slice(0, 10)) {
    if (newest) break;
    if (!verifyRelease(bare, t, false).error) newest = t;
  }
  return { tag, newest, error: tag ? "" : error };
}

module.exports = {
  LEAD, leadPath, leadDir, leadWrite, leadJSON, leadAppend, leadCreate, leadRemove, readUntrusted, readUntrustedJSON, LEAD_FILES, LEAD_DIRS, takeAllow,
  skillCommand, agentPrefix, marketSource, pinCommand,
  readInbox, refreshInbox, inboxFile, hashSkill, skillsDrift, lockDrift, driftFile, relockHint,
  run, projectRoot, repoRoot, claudeDir, isLinked, isLead, gitCommonDir, mainRoot, stateDir, readJSON, writeJSON, beatsDir, beat, forget, forgotten,
  CURRENT, SCHEMES, schemeOf, runName, runRefs, runBranches,
  WORKTREES_EXCLUDE, worktreesDir, worktreesUnder, oldWorktreeDirs,
  configFile, proteusConfig, agentGhDir, installedEntry, verifierApp, appInstallation, apiBase, appJwt, appApi, appToken, relPath, gitRoot, runOpen, guestFile, defaultGuestDir, guestDir, docRoot, agentsLine, leadEdits, leadEditDenial, ownedFile, ownedMatch, ownedDenial, isOwnedList, OWNED_RECORDS, isOwnedRecord, scratchDir, inScratch, TIERS, TIER_LINE, parseTiers, classifyTier, plannedTier, ROUTING_FILE, routingText, parseSecurity, normFinding, exactFinding, fenced, tierMatch, parseDeclared, tierOverrun, tailLines, redact, envInt, spawnArgv, git, gh,
  NULL_DEVICE, gitEnv, gitCall, gitRun, gitIn, gitAsync, gitTry, ghTry, trustedCommon, repoCommon, pinProject, checkoutOf, headOf, branchOf, ownRev, treeChanges, treeChangesAsync, homeGitDir, homeGit, sandboxScratch, realNative, within, homeDirs, homeAllows, homeOnly, profileWrites, homeWritable,
  which, procInfo, launchSettings, sandboxState, saveSandbox, sandboxSeen, sandboxLaunch,
  RELEASE, newerThan, release, verifyRelease, changelog, releaseCheck,
  drivePath, expandPath, shellCwd, pluginAnchor, guardedWrite, guardedParent, treeTargets, findParts, patchPaths, registeredWorktrees, keyIn,
  ghConfigDir, humanGhDir, ghHuman, humanLogin, humanGhDenial, movesGhEnv, humanPost, postArgs, postsVerdict, postCommand, POST_SCRIPT, VERDICT_LINE,
  workerDenial, ALLOWS, allowFile, allowLines, addAllow, JUDGE_MS, TOO_COMPLEX, secretDenial, setsToken, editsLast, verdictPost, signsOff, signoffDenial, agentTypeOf, recordSpawn, spawnRecord, spawnFile, MEMORY_LOCAL, ownMemory, SIGNOFF_MSG, VERIFIER, agentName, isVerifier, isPipelineAgent, shellCommands, branchDenial, agentShellDenial, writeTargets, bindFile, bound, briefWorktree, cwdWorktree, samePath, realOr, AGENT_NEVER, rungOf, leadModel, saveLead, modelPolicy, modelCaps, contextWindow, handoffLines, syncFile, syncText, WAIT_MSG, EDIT_LAST_MSG,
};
try { harness(); } catch {}

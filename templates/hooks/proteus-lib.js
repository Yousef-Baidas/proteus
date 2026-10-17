// Shared core of the proteus-*.js hooks: git, ownership, the ladder, the inbox. Plain Node, no
// dependencies, no shell, nothing specific to one coding-agent CLI (that is proteus-harness.js).
// Every hook fails open: an internal error exits 0 and never blocks the session.
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync, spawnSync } = require("child_process");
const { claudeDir, pluginRoot } = require(path.join(__dirname, "proteus-confine.js"));

// the harness adapter. The adapter requires this file too: it is loaded at the end, once this
// file's exports are complete, and taken again on use if a load that began at the adapter left it partial.
const HARNESS = path.join(__dirname, "proteus-harness.js");
let adapter = null;
const harness = () => (adapter && adapter.event ? adapter : (adapter = require(HARNESS)));

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
const projectRoot = (ev) => (ev && ev.root) || harness().projectRoot({});

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

// <git-common-dir>, absolute. Pure fs for the usual layouts, git only as a fallback.
function gitCommonDir(root) {
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
  } catch {}
  try {
    const out = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000, windowsHide: true }).trim();
    return out ? path.resolve(root, out) : null;
  } catch { return null; }
}

// main checkout root: the common dir's parent when it is a .git dir (null for bare repos)
const mainRoot = (common) => (common && path.basename(common) === ".git" ? path.dirname(common) : null);

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

// legacy-hive:start
// hivemind, the old name (#6): a run opened before the rename keeps these names until it closes, and its
// state dir moves into stateDir. Every legacy name the hooks know is here; the rest import it.
const LEGACY = { branch: "hive/", evidence: "hive-evidence/", label: "hive", log: "hive-log", review: "hive-review", debt: "hive-debt", question: "hive-question", worktrees: "-hive", state: "hive", owned: "hive-owned" };
const legacyStateDir = (common) => path.join(common, LEGACY.state);
// the worker worktree folder a legacy run used, beside the checkout
const legacyWorktreeDir = (root) => besideDir(root, LEGACY.worktrees);
// worktrees git still has registered under legacyWorktreeDir(root)
const legacyWorktrees = (root) => worktreesUnder(root, legacyWorktreeDir(root));
// the folders beside the checkout that older runs kept worker worktrees in: ../<repo>-proteus, ../<repo>-hive
const oldWorktreeDirs = (root) => [besideDir(root, OLD_WORKTREES), legacyWorktreeDir(root)];

const realOr = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const within = (dir, p) => { const r = path.relative(dir, p); return r === "" || (r !== ".." && !r.startsWith(".." + path.sep) && !path.isAbsolute(r)); };

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

// something is at the target now: the entry stays where it is (kept), never replaces it
const TAKEN = new Set(["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR"]);
// a filesystem with no hard links: copy instead, still refusing an existing target
const NO_LINK = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EMLINK"]);

// a FIFO, socket or device: never opened or moved, named in the report
function notRegular(st) {
  const kind = st.isFIFO() ? "a FIFO" : st.isSocket() ? "a socket" : st.isCharacterDevice() || st.isBlockDevice() ? "a device" : "not a regular file";
  return Object.assign(new Error(`${kind}, never moved; delete or move it by hand`), { code: "ENOTREG" });
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
// the last max bytes of a regular file as complete lines; cut: anything before them went unread
function readTail(f, max) {
  const { fd, st } = openRegular(f);
  try {
    const len = Math.min(st.size, max), buf = Buffer.alloc(len);
    let n = 0;
    for (let k; n < len && (k = fs.readSync(fd, buf, n, len - n, st.size - len + n)); ) n += k;
    const lines = buf.toString("utf8", 0, n).split("\n");
    const cut = st.size > len;
    if (cut) lines.shift();
    return { lines: lines.filter(Boolean), cut, st };
  } finally { fs.closeSync(fd); }
}

// one entry into a spot found empty. A file goes by link then unlink and a symlink is recreated (never
// followed), so a file that appeared there meanwhile fails with EEXIST instead of being replaced; a
// directory is renamed, which a non-empty target refuses. If the source cannot be unlinked, the copy goes.
function moveEntry(s, d, st) {
  if (st.isDirectory()) { fs.renameSync(s, d); return; }
  if (st.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(s), d);
  else if (!st.isFile()) throw notRegular(st); // a FIFO, socket or device stays put
  else {
    try { fs.linkSync(s, d); } catch (e) {
      if (!NO_LINK.has(e.code)) throw e;
      fs.copyFileSync(s, d, fs.constants.COPYFILE_EXCL);
    }
  }
  try { fs.unlinkSync(s); } catch (e) { try { fs.unlinkSync(d); } catch {} throw e; }
}

const MERGE_LOG_MAX = 8 * 1024 * 1024;
// an append-only log on both sides: the legacy lines first, then the current file's lines not among them,
// written to a temp file beside the current one and renamed over it; the legacy file goes only after that.
// The result is capped at max bytes: past it the oldest lines go and a marker line says so (each side is
// read for at most max bytes from its end). A line appended to the current file meanwhile aborts the pass
// (a rerun merges again, each line once).
function mergeLog(s, d, max = MERGE_LOG_MAX) {
  const old = readTail(s, max), cur = readTail(d, max);
  const seen = new Set(old.lines);
  let all = [...old.lines, ...cur.lines.filter((l) => !seen.has(l))];
  const mark = JSON.stringify({ merge_truncated: new Date().toISOString(), note: `older lines dropped: a merged log keeps its newest ${max} bytes` });
  let size = all.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0), drop = 0;
  if (old.cut || cur.cut || size > max) {
    while (drop < all.length && size > max - Buffer.byteLength(mark) - 1) size -= Buffer.byteLength(all[drop++]) + 1;
    all = [mark, ...all.slice(drop)];
  }
  const tmp = `${d}.${process.pid}.${Date.now()}.merge.tmp`;
  fs.writeFileSync(tmp, all.length ? all.join("\n") + "\n" : "", { flag: "wx" });
  try {
    const now = fs.lstatSync(d);
    if (!now.isFile() || now.size !== cur.st.size || now.mtimeMs !== cur.st.mtimeMs) throw Object.assign(new Error("appended during the merge"), { code: "EAGAIN" });
    fs.renameSync(tmp, d);
  } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
  fs.unlinkSync(s); // a regular file (lstat) in a tree whose every dir was lstat-checked under the legacy dir
}

// move legacyStateDir's contents into stateDir; the legacy dir goes once empty. Paths are relative to it:
// moved: now in stateDir; merged: a *.jsonl log on both sides, appended into stateDir's (older lines first);
// kept: another file already in stateDir, never overwritten; held: a worktree git has registered, left where
// git has it; failed: "<path> (<code>)", unreadable or not movable now (a rerun retries). dry: only report.
function migrateState(common, dry) {
  const res = { moved: [], merged: [], kept: [], held: [], failed: [] };
  const from = common && legacyStateDir(common);
  let top = null;
  try { top = from && fs.lstatSync(from); } catch {}
  if (!top || !top.isDirectory()) return res;
  const wts = registeredWorktrees(common);
  const fail = (r, e) => res.failed.push(`${r} (${e && e.code === "ENOTREG" ? e.message : (e && e.code) || "error"})`);
  const walk = (src, dst, rel) => {
    let names = [];
    try { names = fs.readdirSync(src).sort(); } catch (e) { if (rel) fail(rel, e); return; }
    for (const n of names) {
      const s = path.join(src, n), d = path.join(dst, n), r = rel ? `${rel}/${n}` : n;
      let ss, ds = null;
      try { ss = fs.lstatSync(s); } catch (e) { fail(r, e); continue; } // gone or unreachable since the listing
      try { ds = fs.lstatSync(d); } catch {}
      const real = ss.isDirectory() && wts.length ? realOr(s) : "";
      if (real && wts.includes(real)) { res.held.push(r); continue; }
      if (real && wts.some((w) => within(real, w))) {
        // a worktree is inside: move the rest around it
        if (ds && !ds.isDirectory()) { res.kept.push(r); continue; }
        if (!dry && !ds) try { fs.mkdirSync(d, { recursive: true }); } catch (e) { fail(r, e); continue; }
        walk(s, d, r);
        if (!dry) try { fs.rmdirSync(s); } catch {}
      } else if (!ds) {
        if (dry) { res.moved.push(r); continue; }
        try { fs.mkdirSync(dst, { recursive: true }); moveEntry(s, d, ss); res.moved.push(r); } catch (e) { if (TAKEN.has(e.code)) res.kept.push(r); else fail(r, e); }
      } else if (ds.isDirectory() && ss.isDirectory()) {
        walk(s, d, r);
        if (!dry) try { fs.rmdirSync(s); } catch {}
      } else if (ds.isFile() && ss.isFile() && n.endsWith(".jsonl")) {
        if (dry) { res.merged.push(r); continue; }
        try { mergeLog(s, d); res.merged.push(r); } catch (e) { fail(r, e); }
      } else res.kept.push(r);
    }
  };
  walk(from, stateDir(common), "");
  if (!dry) try { fs.rmdirSync(from); } catch {}
  return res;
}
// legacy-hive:end

const SCHEMES = [CURRENT, LEGACY];
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

// every run and worker branch under both schemes, and proteus-work/<run>/<id>: loose refs and packed-refs, no git call
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

// owned-path glob: ** any depth, * within a segment, trailing / means the whole directory, a plain path without
// wildcards covers itself and anything below it
function ownedMatch(glob, rel) {
  const g = glob.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "/**");
  // a plain path with no wildcard names a file or a directory; a file has nothing under it, so it also covers what lies below
  if (!g.includes("*")) {
    const [a, b] = process.platform === "win32" ? [g.toLowerCase(), rel.toLowerCase()] : [g, rel];
    if (b === a || b.startsWith(a + "/")) return true;
  }
  const re = "^" + g.split("**").map((p) => p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join(".*") + "$";
  return new RegExp(re, process.platform === "win32" ? "i" : "").test(rel);
}

// a worktree the lead dispatched a worker into: it lists the ticket's owned paths
// a worktree dispatched before the rename carries the legacy list; read it until that run merges
const ownedFile = (wt) => {
  const f = harness().ownedFile(wt);
  const old = path.join(path.dirname(f), LEGACY.owned);
  return !fs.existsSync(f) && fs.existsSync(old) ? old : f;
};

// one key per file NTFS resolves alike: each segment loses a :stream suffix and trailing dots and spaces, and
// case goes (macOS and Windows ignore it). Applied on every OS, so Linux also refuses the look-alike names.
const fileKey = (rel) => rel.split("/").map((s) => s.replace(/:.*$/, "").replace(/[. ]+$/, "")).join("/").toLowerCase();
// rel (worktree-relative, forward slashes) names the owned-path list itself: the harness's, or the legacy one beside it
function isOwnedList(wt, rel) {
  const f = harness().ownedFile(wt);
  return [f, path.join(path.dirname(f), LEGACY.owned)].some((p) => fileKey(path.relative(wt, p).split(path.sep).join("/")) === fileKey(rel));
}

// rel names a ticket's owned-path record, .proteus/owned/<id> on the run branch (or the folder): the lead writes
// those, and CI checks a worker's PR against the base's copy (proteus-owned-check.js --ci)
const OWNED_RECORDS = ".proteus/owned";
const isOwnedRecord = (rel) => (fileKey(String(rel).replace(/\\/g, "/")) + "/").startsWith(OWNED_RECORDS + "/");

// why an edit of target breaks the worktree's owned-path list, or "" when allowed or there is no list
function ownedDenial(wt, target) {
  let list;
  try { list = fs.readFileSync(ownedFile(wt), "utf8"); } catch { return ""; }
  // path.relative across Windows drives returns an absolute path, not "../"
  const abs = path.resolve(wt, String(target)), r = path.relative(wt, abs);
  const rel = r.split(path.sep).join("/");
  const needs = (why) => `${rel} is ${why}. Comment "NEEDS ${rel}: <why>" on the issue and stop.`;
  if (path.isAbsolute(r) || rel === ".." || rel.startsWith("../")) return inScratch(gitCommonDir(wt), abs) ? "" : needs("outside the worktree");
  // no glob covers the list itself (`*/*` and `**` match .claude/), or a worker could widen its own ownership
  if (isOwnedList(wt, rel)) return needs("the owned-path list itself, which only the lead writes");
  if (isOwnedRecord(rel)) return needs("a ticket's owned-path record, which only the lead writes");
  const owned = list.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  return owned.some((g) => ownedMatch(g, rel)) ? "" : needs(`not in ${path.relative(wt, ownedFile(wt)).split(path.sep).join("/")}`);
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

// git / gh with a hard timeout; "" on any failure (not installed, no auth, no remote, offline)
function git(args, cwd, timeout = 3000) {
  try { return execFileSync("git", args, execOpts(cwd, timeout)).trim(); } catch { return ""; }
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
const releaseTags = (home, ...filter) => git(["-C", home, "tag", "-l", ...filter, "v*"], home).split("\n").filter((t) => RELEASE.test(t));
const newest = (tags) => tags.reduce((m, t) => (newerThan(t, m) ? t : m), "");

// { current, tag, ahead }: current is the newest release in HEAD's history ("" when none), tag the
// newest release past it that HEAD lacks ("" when none), ahead the count of commits HEAD lacks from tag
function release(home) {
  const current = newest(releaseTags(home, "--merged", "HEAD"));
  const tag = newest(releaseTags(home, "--no-merged", "HEAD").filter((t) => newerThan(t, current)));
  const ahead = tag ? parseInt(git(["-C", home, "rev-list", "--count", `HEAD..refs/tags/${tag}`], home), 10) || 0 : 0;
  return { current, tag, ahead };
}

// { commit, error }: commit is what home may fast-forward to; error says in one line why it may not
// (lightweight or unsigned tag, unknown signer, no fast-forward). ff false skips the fast-forward check: the
// plugin's release check (proteus-autostart.js) verifies tags in a bare clone, which has no checkout to move
function verifyRelease(home, tag, ff = true) {
  const no = (error) => ({ commit: "", error });
  const obj = RELEASE.test(tag) ? git(["-C", home, "rev-parse", "--verify", "--quiet", `refs/tags/${tag}`], home) : "";
  if (!obj) return no(`${tag} is not a release tag here`);
  if (git(["-C", home, "cat-file", "-t", obj], home) !== "tag") return no(`${tag} is a lightweight tag, so it carries no signature`);
  // a signed tag published again under a newer name still names its own version inside
  const header = git(["-C", home, "cat-file", "tag", obj], home).split("\n\n")[0];
  if (!header.split("\n").includes(`tag ${tag}`)) return no(`${tag} points at a tag object made for another name`);
  if (ff && !releaseTags(home, "--contains", "HEAD").includes(tag)) return no(`${tag} does not contain this checkout's HEAD (local commits?), so it is no fast-forward`);
  try {
    execFileSync("git", ["-C", home, "verify-tag", obj], { encoding: "utf8", timeout: 10000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const last = String(e.stderr || "").split("\n").map((l) => l.trim()).filter(Boolean).pop() || "git verify-tag failed";
    return no(`git verify-tag ${tag}: ${last.replace(/^error: /, "").replace(/\.$/, "").slice(0, 200)}`);
  }
  const commit = git(["-C", home, "rev-parse", `${obj}^{commit}`], home);
  return commit ? { commit, error: "" } : no(`${tag} does not resolve to a commit`);
}

// the CHANGELOG.md sections at commit for the versions after from, up to and including to; at most max lines
function changelog(home, commit, from, to, max = 8) {
  const out = [];
  let on = false;
  for (const l of git(["-C", home, "show", `${commit}:CHANGELOG.md`], home).split(/\r?\n/)) {
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
function gh(args, cwd, timeout = 6000, configDir = "", token = "") {
  const env = { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" };
  if (configDir) env.GH_CONFIG_DIR = configDir;
  if (token) env.GH_TOKEN = token;
  try { return execFileSync("gh", args, execOpts(cwd, timeout, env)).trim(); } catch { return ""; }
}

const envInt = (name, dflt) => { const n = parseInt(process.env[name], 10); return Number.isFinite(n) && n > 0 ? n : dflt; };

// rules for every non-lead agent: nothing that ends a turn waiting for a wake-up that never comes
const WAIT_MSG = "workers never wait on a background notification (it never arrives after your turn ends). Run it in the foreground with timeout up to 600000 ms, or start it detached (nohup … &) and poll its PID/log in this same turn.";
const EDIT_LAST_MSG = "--edit-last edits the newest comment of the shared GitHub account, which may be another agent's or the lead's ruling. Post a new comment instead.";
function workerDenial(ev) {
  const secret = secretDenial(ev);
  if (secret) return secret;
  if (ev.tool === "monitor") return WAIT_MSG;
  if (ev.tool !== "shell") return null;
  if (ev.background) return WAIT_MSG;
  if (editsLast(ev.command)) return EDIT_LAST_MSG;
  const cwd = shellCwd(ev);
  return verdictPost(ev.command, cwd) || signoffDenial(ev) || branchDenial(ev.command, cwd, leadDocsPush) || agentShellDenial(ev, ev.command, cwd);
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
// it, and --security (proteus/security) only the security verifier. ev.agentType names the agent; a harness that
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
  if (!ev.agentType) return unnamed;
  if (!isVerifier(ev.agentType)) return SIGNOFF_MSG.role(ev.agentType);
  return w.includes("--security") && agentName(ev.agentType) !== "proteus-security-verifier" ? SIGNOFF_MSG.security(ev.agentType) : null;
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
// comments API call whose body opens with one is refused. The body is read from --body/-b, a body= field, a
// heredoc, or a --body-file/-F file under cwd. A guard, not a boundary: the verdict script's author check is.
const HUMAN_WORD = /^\s*(ACCEPT|CHANGES|ANSWER)(?=\s|$)/;
const VERDICT_MSG = "proteus: ACCEPT, CHANGES and ANSWER are the human's words; agents never post them. Report to the lead, word the comment differently, or record a pick the human made in this session as `Answered in session: <pick>`.";
function verdictPost(command, cwd) {
  const cmd = String(command || "");
  if (!/\b(?:gh|proteus-gh\.js)\s+((issue|pr)\s+(comment|review)|api)\b/.test(cmd) || !/ACCEPT|CHANGES|ANSWER|--body-file|-F\b/.test(cmd)) return null;
  const unq = (v) => v.replace(/^\$?(["'])([\s\S]*)\1$/, "$2").replace(/\\(["\\$`])/g, "$1").replace(/\\n/g, "\n");
  const bodies = [];
  for (const m of cmd.matchAll(/(?:--body|-b|(?:-f|-F|--field|--raw-field)\s+body)(?:\s+|=)("(?:[^"\\]|\\.)*"|\$?'[^']*'|\S+)/g)) bodies.push(unq(m[1]));
  for (const m of cmd.matchAll(/<<-?\s*(["']?)(\w+)\1[^\n]*\n([\s\S]*?)(?:\n\s*\2\s*(?:\n|$)|$)/g)) bodies.push(m[3]);
  for (const m of cmd.matchAll(/(?:--body-file|-F)(?:\s+|=)(["']?)([^\s"']+)\1/g)) {
    if (m[2] === "-" || m[2].includes("=")) continue;
    try { bodies.push(fs.readFileSync(path.resolve(cwd || ".", m[2]), "utf8").slice(0, 4096)); } catch {}
  }
  return bodies.some((b) => HUMAN_WORD.test(b.replace(/^\$\(\s*cat\s*<<[\s\S]*$/, ""))) ? VERDICT_MSG : null;
}

// a command line as simple commands, each a list of words: quotes removed, split at ; & | ( ) ` and newlines,
// comments and heredoc bodies skipped. Enough to find a git or gh call and its arguments; not a shell.
// An output redirect (>, >>, >|, &>, N>, >&file) is no word: its target goes on the command's .redirects list,
// and a >&N descriptor copy is dropped.
function shellCommands(command) {
  const s = String(command || "");
  const out = [];
  let words = [], word = null, heredocs = [], redirs = [], redir = "";
  const endWord = () => {
    if (word !== null && !redir) words.push(word);
    else if (word !== null) { if (redir === "file" || !/^(?:\d+|-)$/.test(word)) redirs.push(word); redir = ""; }
    word = null;
  };
  const endCmd = () => { endWord(); redir = ""; if (words.length || redirs.length) out.push(Object.assign(words, { redirects: redirs })); words = []; redirs = []; };
  for (let i = 0; i < s.length; i++) {
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
      i += 2;
    } else if (s.startsWith("<<", i)) {
      endWord();
      const m = /^<<-?[ \t]*(["']?)([\w.-]+)\1/.exec(s.slice(i));
      if (m) heredocs.push(m[2]);
      i += m ? m[0].length - 1 : 1;
    } else if (c === "\n") {
      endCmd();
      for (const d of heredocs) {
        let k = i + 1;
        for (;;) {
          const nl = s.indexOf("\n", k);
          const line = s.slice(k, nl < 0 ? s.length : nl);
          k = nl < 0 ? s.length : nl + 1;
          if (nl < 0 || line.trim() === d) break;
        }
        i = k - 1;
      }
      heredocs = [];
    } else if (c === ">" || (c === "&" && s[i + 1] === ">")) {
      if (word !== null && /^\d+$/.test(word)) word = null; // 2>file: the descriptor, not a word
      endWord();
      if (c === "&") i++;
      if (s[i + 1] === ">" || s[i + 1] === "|") i++;
      redir = s[i + 1] === "&" ? "dup" : "file";
      if (redir === "dup") i++;
    } else if (";&|()`".includes(c)) endCmd();
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
  wide: (flag) => `proteus: \`git push ${flag}\` can reach main or a run branch; push one branch by name.`,
  main: (b) => `proteus: agents never push to ${b}; a run reaches it only as the close PR the human merges.`,
  del: (b) => `proteus: agents never delete ${b}; the human does at close.`,
  run: (b, remote) => `proteus: ${b} changes only by a PR with \`gates\` green: push your own branch (proteus-work/<run>/<id>) and open a PR into ${b}. The one push to a run branch creates it at the start of the run (no ${remote}/${b} yet; \`git fetch --prune\` if it was deleted).`,
};
// words that run the rest of the line as a command, each with its options that take the next word as a value;
// timeout also takes a DURATION before the command. xargs appends words from stdin, which no guard can see.
const WRAPPERS = new Map(Object.entries({
  rtk: [], proxy: [], command: [], builtin: [], nohup: [], exec: ["-a"], time: ["-f", "--format", "-o", "--output"],
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
  for (const all of shellCommands(cmd)) {
    let words = unwrap(all);
    let prog = progName(words[0]);
    // node <hooks>/proteus-gh.js <args> is gh with retries: same rules
    if (prog === "node" && /(^|[\\/])proteus-gh\.js$/.test(words[1] || "")) { words = words.slice(1); prog = "gh"; }
    const why = prog === "gh" ? ghBranchDenial(words.slice(1)) : prog === "git" ? pushDenial(words.slice(1), path.resolve(cwd || "."), extra) : null;
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
// extra(dst), when given, may refuse a destination neither main nor a run branch
function pushDenial(words, cwd, extra) {
  let i = 0, dir = cwd;
  for (; i < words.length && words[i].startsWith("-"); i++) {
    if (words[i] === "-C") dir = path.resolve(dir, words[++i] || ".");
    else if (GIT_VALUE.has(words[i])) i++;
  }
  if (words[i] !== "push") return null;
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
  const cur = g("symbolic-ref", "-q", "--short", "HEAD");
  const remote = pos[0] || (cur && g("config", "--get", `branch.${cur}.remote`)) || "origin";
  let specs = pos.slice(1);
  if (!specs.length && !del) {
    if (!cur) return null;
    specs = [`${cur}:${g("config", "--get", `branch.${cur}.merge`).replace(/^refs\/heads\//, "") || cur}`];
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
  force: (flag) => `proteus: agents never force-push (\`${flag}\`), their own branch included: a rewrite drops commits the verifier and the PR already read. Add a commit on top, or merge the base in (\`git merge origin/<base>\`), and push the branch by name; history that must be rewritten is a NEEDS for the lead.`,
  gitDir: (opt, p, own) => `proteus: \`${opt.endsWith("=") ? opt + p + " git" : "git " + opt + " " + p}\` runs git in ${p}, which is not your worktree${own ? ` (${own})` : ""}, while the gates, tests and hooks beside it run elsewhere. Start the call with \`cd <your worktree> && \` and run git there.`,
  write: (prog, rel) => `proteus: \`${prog}\` writes ${rel}, which holds Proteus's hooks, gates, git internals or CLI settings; a shell write there skips the owned-path check and is never a worker's. Make an owned change with Edit or Write, or comment "NEEDS ${rel}: <why>" on the issue and stop.`,
  tree: (prog, target, rel) => `proteus: \`${prog}\` on ${target} takes ${rel} with it, which holds Proteus's hooks, gates, git internals or CLI settings; that is never a worker's. Name the paths inside it that you own, or comment "NEEDS ${rel}: <why>" on the issue and stop.`,
  blind: (prog) => `proteus: \`${prog}\` reads its patch from stdin or from a file this same command writes, so the guard cannot see which paths it changes. Save the patch to a file first (Write it under \`node <hooks>/proteus-scratch.js --path <key>\`) and apply it by name in a later call.`,
  pushSetup: (what) => `proteus: \`${what}\` sets up a push the guard cannot read: a configured push refspec, a mirror, push.default or an alias can force-push or push every branch. Push your branch by name (\`git push origin <your branch>\`).`,
  refs: (what) => `proteus: agents never move a branch through the API (\`${what}\`): a ref update there can force it past the push checks. Push your branch by name with git.`,
};
const samePath = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
// One worker, one worktree: the lead guard's bindingDenial records a subagent's first edit per agent id in
// <git-common-dir>/proteus/agents/; its cwd's prepared worktree counts first.
const bindFile = (common, agent) => path.join(stateDir(common), "agents", "agent-" + String(agent).replace(/[^\w.-]/g, "_"));
function bound(common, agent) {
  try { return fs.readFileSync(bindFile(common, agent), "utf8").trim() || null; } catch { return null; }
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
// the dir a shell call runs in: the event's cwd, moved by the shell tool's own workdir when the harness has one
const shellCwd = (ev) => { const base = ev.cwd || projectRoot(ev); return ev.workdir ? path.resolve(base, expandPath(ev.workdir, base)) : base; };

// the paths a simple command (unwrapped words) writes, as written: [] for a program it does not judge
const WRITE_ALL = new Set(["tee", "truncate", "touch", "rm", "unlink", "rmdir", "shred", "mv"]); // every operand
const WRITE_LAST = new Set(["cp", "ln", "link", "install", "rsync"]); // the last operand, or -t DIR
const IN_PLACE = { sed: /^-(?:[a-zA-Z]*i|-in-place(?:=|$))/, perl: /^-[a-ln-zA-HJ-LN-Z0-9]*i/, ruby: /^-[a-ln-zA-HJ-LN-Z0-9]*i/ }; // -M, -m, -I take the rest
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
      if (args[k] === "-t" || args[k] === "--target-directory") return [args[k + 1] || ""];
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
    // the plugin's own folder: its hooks, skills and agents
    const inPlug = plug ? relPath(realOr(plug), p) ?? relPath(plug, p) : null;
    if (inPlug !== null) return inPlug ? `$CLAUDE_PLUGIN_ROOT/${inPlug}` : "$CLAUDE_PLUGIN_ROOT";
  }
  return "";
}

// the worker's own worktree for dir, else null: the prepared worktree of its cwd (as given or after cd), else
// the one its first edit bound it to
function ownWorktree(ev, dir, common) {
  return cwdWorktree(dir, common) || (ev.cwd && cwdWorktree(path.resolve(ev.cwd), common)) || (ev.agent && common ? bound(common, ev.agent) : null);
}
// git's own options that move it to another checkout, each with its path; GIT_DIR / GIT_WORK_TREE assignments too
function gitDirs(all, words, dir) {
  const out = [];
  for (const a of all.slice(0, all.length - words.length)) {
    const m = /^(GIT_DIR|GIT_WORK_TREE)=(.*)$/.exec(a);
    if (m) out.push([m[1] + "=", path.resolve(dir, expandPath(m[2], dir))]);
  }
  let d = dir;
  for (let i = 1; i < words.length && words[i].startsWith("-"); i++) {
    const a = words[i], m = /^(--git-dir|--work-tree)=(.*)$/.exec(a);
    if (a === "-C") { d = path.resolve(d, expandPath(words[++i] || ".", d)); out.push(["-C", d]); }
    else if (m) out.push([m[1], path.resolve(d, expandPath(m[2], d))]);
    else if (a === "--git-dir" || a === "--work-tree") out.push([a, path.resolve(d, expandPath(words[++i] || ".", d))]);
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
// checkout of this repo or of the guest dir, a whole checkout (its .git), or the CLIs' dirs in the home
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
  const anchors = [...[".claude", ".codex", ".agents"].map((d) => path.join(os.homedir(), d)), claudeDir(), ...(process.env.CODEX_HOME ? [path.resolve(process.env.CODEX_HOME)] : []), ...(plug ? [plug] : [])];
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
  if (sub === "checkout" && dash < 0 && pos.length && git(["rev-parse", "-q", "--verify", `${pos[0]}^{tree}`], dir)) {
    source = pos[0];
    paths = pos.slice(1);
    hit = hits([...paths, ...specs]);
    if (!hit.length) return null;
  }
  if (source === null || /^(?:HEAD|@)$/.test(source)) return null;
  const rel = git(["diff", "--name-only", source, "--", ...hit], dir).split("\n").find((r) => r && keyIn(AGENT_NEVER, r));
  return rel ? AGENT_MSG.write(`git ${sub} ${source}`, rel) : null;
}

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

// git's own subcommands that write the worktree from somewhere the guard can read, or set up a push
function gitWriteDenial(ev, all, words, dir, written) {
  for (const [k, v] of gitCallConfig(all, words)) if (riskyConfig(k, v)) return AGENT_MSG.pushSetup(`git -c ${k}${v === undefined ? "" : "=" + v}`);
  let i = 1, d = dir;
  for (; i < words.length && words[i].startsWith("-"); i++) {
    if (words[i] === "-C") d = path.resolve(d, expandPath(words[++i] || ".", d));
    else if (GIT_VALUE.has(words[i])) i++;
  }
  const sub = words[i], args = words.slice(i + 1);
  if (sub === "config") {
    const s = configSet(args);
    return s && riskyConfig(s[0], s[1]) ? AGENT_MSG.pushSetup(`git config ${s[0]}${s[1] === undefined ? "" : " " + s[1]}`) : null;
  }
  if (sub === "checkout" || sub === "restore") return restoreDenial(sub, args, d, ev);
  if (sub === "apply" || sub === "am") return patchDenial(`git ${sub}`, args, d, written, ev);
  if (sub === "stash" && (args[0] === "pop" || args[0] === "apply")) return stashDenial(args[0], args.slice(1), d);
  return null;
}

const NESTED_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
function agentShellDenial(ev, command = ev.command, cwd = shellCwd(ev), depth = 0) {
  let dir = path.resolve(cwd || projectRoot(ev));
  const written = new Set(); // paths this line writes: a patch made earlier in the same call is not read in time
  const judge = (t) => writeRel(t, dir, ev);
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
      for (const p of spellings(t, dir)) written.add(p);
    }
    if (!words.length) return null;
    if (prog === "cd" || prog === "pushd") {
      const to = words.slice(1).find((w) => !w.startsWith("-") || w === "-");
      if (!inner && to !== "-") dir = path.resolve(dir, expandPath(to || "~", dir));
      return null;
    }
    if (prog === "git") {
      const force = forcePush(words);
      if (force) return AGENT_MSG.force(force);
      for (const [opt, p] of gitDirs(all, words, dir)) {
        const root = gitRoot(p), common = root && gitCommonDir(root);
        const own = ownWorktree(ev, dir, common);
        if (!root || !own || !samePath(realOr(root), realOr(own))) return AGENT_MSG.gitDir(opt, p.split(path.sep).join("/"), own ? `yours is ${own.split(path.sep).join("/")}` : "");
      }
      return gitWriteDenial(ev, all, words, dir, written);
    }
    if (prog === "gh") return ghAgentDenial(words.slice(1));
    if (prog === "node" && /(^|[\\/])proteus-gh\.js$/.test(words[1] || "")) return ghAgentDenial(words.slice(2));
    // sh -c '<script>': judged as its own command line, from the same dir
    if (NESTED_SHELLS.has(prog) && depth < 3) {
      const c = words.indexOf("-c");
      return c > 0 && words[c + 1] !== undefined ? agentShellDenial(ev, words[c + 1], dir, depth + 1) : null;
    }
    if (prog === "eval" && depth < 3) return agentShellDenial(ev, words.slice(1).join(" "), dir, depth + 1);
    if (prog === "find") return findDenial(words.slice(1));
    if (prog === "patch") return patchDenial("patch", words.slice(1), dir, written, ev);
    for (const t of writeTargets(words)) {
      const rel = judge(t);
      if (rel) return AGENT_MSG.write(prog, rel);
      for (const p of spellings(t, dir)) written.add(p);
    }
    for (const [t, tree] of treeTargets(words)) {
      const rel = tree ? treeRel(t, dir, ev) : judge(t);
      if (rel) return tree ? AGENT_MSG.tree(`${prog}${prog === "rm" || prog === "cp" ? " -r" : ""}`, t, rel) : AGENT_MSG.write(prog, rel);
    }
    return null;
  };
  for (const all of shellCommands(command)) {
    const why = simple(all, unwrap(all));
    if (why) return why;
  }
  return null;
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

// The human's inbox: open needs-human issues, cached in <common>/proteus/inbox.json as
// {at, questions:[{n,title}], reviews:[{n,title}]}. null when there is no cache.
const inboxFile = (common) => path.join(stateDir(common), "inbox.json");
function readInbox(common) {
  const c = readJSON(inboxFile(common), null);
  return c && Array.isArray(c.questions) && Array.isArray(c.reviews) ? c : null;
}

// ---- skills lock: teams/skills-lock.json pins each linked skill's content hash (teams/link-skills.js).
// A drifted skill is one whose copy linked under teams/<team>/{.claude,.agents}/skills/<name> hashes
// differently from its pin; no lock, or a pinned skill linked nowhere, is no drift. Local files only.
const lockFile = (root) => path.join(docRoot(root), "teams", "skills-lock.json");
const driftFile = (common) => path.join(stateDir(common), "skills-drift.json");
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
  if (common) { try { writeJSON(driftFile(common), { lock: key, drift }); } catch {} }
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
const leadFile = (root) => { const c = gitCommonDir(root); return c ? path.join(stateDir(c), "lead-model.json") : null; };
function saveLead(ev, root) {
  const f = leadFile(root);
  if (f && ev.model && ev.session) writeJSON(f, { session: ev.session, model: ev.model });
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
// "ended" (proteus-stall.js, a stop without a report) stamps `ended`, "done" (a stop with a report)
// removes the file. Other agent types (scout, guide) are not tracked: they end without a report.
// the agents that run team skills: proteus-worker, proteus-verifier, proteus-<team>-worker/verifier
const PIPELINE_AGENT = /^proteus-(?:[a-z0-9-]+-)?(?:worker|verifier)$/;
const isPipelineAgent = (type) => PIPELINE_AGENT.test(agentName(type));
const beatsDir = (common) => path.join(stateDir(common), "beats");
function beat(ev, state) {
  if (!ev.agent || (ev.agentType && !isPipelineAgent(ev.agentType))) return;
  try {
    const common = gitCommonDir(projectRoot(ev));
    if (!common) return;
    const file = path.join(beatsDir(common), `${String(ev.agent).replace(/[^\w.-]/g, "_")}.json`);
    if (state === "done") { fs.rmSync(file, { force: true }); return; }
    const prev = readJSON(file, null) || {};
    const now = new Date().toISOString();
    // a rewrite drops `flagged`: a tool call after the watchdog's STALL is the agent answering
    const rec = { agent: ev.agent, type: ev.agentType || prev.type || "", session: ev.session || prev.session || "", cwd: ev.cwd || prev.cwd || "", first: prev.first || now, last: now };
    if (state === "ended") { rec.last = prev.last || now; rec.ended = now; rec.flagged = prev.flagged; }
    writeJSON(file, rec);
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
  writeJSON(inboxFile(common), inbox);
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

module.exports = {
  skillCommand, agentPrefix, marketSource, pinCommand,
  readInbox, refreshInbox, inboxFile, hashSkill, skillsDrift, lockDrift, driftFile, relockHint,
  run, projectRoot, repoRoot, claudeDir, isLinked, isLead, gitCommonDir, mainRoot, stateDir, readJSON, writeJSON, beatsDir, beat,
  CURRENT, LEGACY, SCHEMES, schemeOf, runName, runRefs, runBranches, legacyStateDir, legacyWorktreeDir, legacyWorktrees, migrateState, mergeLog,
  WORKTREES_EXCLUDE, worktreesDir, worktreesUnder, oldWorktreeDirs,
  configFile, proteusConfig, agentGhDir, verifierApp, appInstallation, apiBase, appJwt, appApi, appToken, relPath, gitRoot, runOpen, guestFile, defaultGuestDir, guestDir, docRoot, agentsLine, leadEdits, leadEditDenial, ownedFile, ownedMatch, ownedDenial, isOwnedList, OWNED_RECORDS, isOwnedRecord, scratchDir, inScratch, TIERS, TIER_LINE, parseTiers, classifyTier, parseSecurity, tierMatch, parseDeclared, tierOverrun, tailLines, redact, envInt, spawnArgv, git, gh,
  RELEASE, newerThan, release, verifyRelease, changelog,
  drivePath, expandPath, shellCwd, pluginAnchor, guardedWrite, guardedParent, treeTargets, findParts, patchPaths, registeredWorktrees, keyIn,
  workerDenial, secretDenial, setsToken, editsLast, verdictPost, signsOff, signoffDenial, SIGNOFF_MSG, VERIFIER, agentName, isVerifier, isPipelineAgent, shellCommands, branchDenial, agentShellDenial, writeTargets, bindFile, bound, briefWorktree, cwdWorktree, samePath, realOr, AGENT_NEVER, rungOf, leadModel, saveLead, modelPolicy, modelCaps, contextWindow, handoffLines, syncFile, syncText, WAIT_MSG, EDIT_LAST_MSG,
};
try { harness(); } catch {}

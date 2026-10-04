// Shared core of the proteus-*.js hooks: git, ownership, the ladder, the inbox. Plain Node, no
// dependencies, no shell, nothing specific to one coding-agent CLI (that is proteus-harness.js).
// Every hook fails open: an internal error exits 0 and never blocks the session.
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

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

// a run's names: its branch prefix, its worker branches' prefix, evidence prefix, labels, and the sibling folder its
// worker worktrees use. Worker branches are <work><run>/<id>, outside <branch>, so a ruleset on proteus/* binds runs only;
// a run opened before that keeps <branch><run>-<id> until it closes.
const CURRENT = { branch: "proteus/", work: "proteus-work/", evidence: "proteus-evidence/", label: "proteus", log: "proteus-log", review: "proteus-review", debt: "proteus-debt", question: "proteus-question", worktrees: "-proteus" };

// legacy-hive:start
// hivemind, the old name (#6): a run opened before the rename keeps these names until it closes, and its
// state dir moves into stateDir. Every legacy name the hooks know is here; the rest import it.
const LEGACY = { branch: "hive/", evidence: "hive-evidence/", label: "hive", log: "hive-log", review: "hive-review", debt: "hive-debt", question: "hive-question", worktrees: "-hive", state: "hive", owned: "hive-owned" };
const legacyStateDir = (common) => path.join(common, LEGACY.state);
// the worker worktree folder a legacy run used, beside the checkout
const legacyWorktreeDir = (root) => { const abs = path.resolve(root); return path.join(path.dirname(abs), path.basename(abs) + LEGACY.worktrees); };

// worktrees git still has registered under legacyWorktreeDir(root): <common>/worktrees/*/gitdir, no git call
function legacyWorktrees(root) {
  const common = gitCommonDir(root);
  const dir = legacyWorktreeDir(root);
  const out = [];
  let ids = [];
  try { ids = fs.readdirSync(path.join(common, "worktrees")); } catch { return out; }
  for (const id of ids) {
    let wt;
    try { wt = path.dirname(path.resolve(fs.readFileSync(path.join(common, "worktrees", id, "gitdir"), "utf8").trim())); } catch { continue; }
    const r = path.relative(dir, wt);
    if (r && !r.startsWith("..") && !path.isAbsolute(r)) out.push(wt);
  }
  return out;
}

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

// one entry into a spot found empty. A file goes by link then unlink and a symlink is recreated (never
// followed), so a file that appeared there meanwhile fails with EEXIST instead of being replaced; a
// directory is renamed, which a non-empty target refuses. If the source cannot be unlinked, the copy goes.
function moveEntry(s, d, st) {
  if (st.isDirectory()) { fs.renameSync(s, d); return; }
  if (st.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(s), d);
  else {
    try { fs.linkSync(s, d); } catch (e) {
      if (!NO_LINK.has(e.code)) throw e;
      fs.copyFileSync(s, d, fs.constants.COPYFILE_EXCL);
    }
  }
  try { fs.unlinkSync(s); } catch (e) { try { fs.unlinkSync(d); } catch {} throw e; }
}

// an append-only log on both sides: the legacy lines first, then the current file's lines not among them,
// written to a temp file beside the current one and renamed over it; the legacy file goes only after that.
// A line appended to the current file meanwhile aborts the pass (a rerun merges again, each line once).
function mergeLog(s, d) {
  const old = fs.readFileSync(s, "utf8").split("\n").filter(Boolean);
  const cur = fs.readFileSync(d, "utf8");
  const seen = new Set(old);
  const all = [...old, ...cur.split("\n").filter((l) => l && !seen.has(l))];
  const tmp = `${d}.${process.pid}.${Date.now()}.merge.tmp`;
  fs.writeFileSync(tmp, all.length ? all.join("\n") + "\n" : "", { flag: "wx" });
  try {
    if (fs.readFileSync(d, "utf8") !== cur) throw Object.assign(new Error("appended during the merge"), { code: "EAGAIN" });
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
  const fail = (r, e) => res.failed.push(`${r} (${(e && e.code) || "error"})`);
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

const configFile = () => path.join(os.homedir(), ".claude", "proteus.json");
const proteusConfig = () => readJSON(configFile(), {}) || {};
// the gh config dir the agents post from ("agentGh" in proteus.json, a leading ~ allowed): a GitHub login of
// their own, set up by install.js --agent-login. "" while they post under the human's.
function agentGhDir() {
  const d = proteusConfig().agentGh;
  if (typeof d !== "string" || !d.trim()) return "";
  return path.resolve(d.trim().replace(/^~(?=$|[\\/])/, () => os.homedir()));
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

// a run is open: a run or worker branch exists under either scheme
const runOpen = (common) => runRefs(common).length > 0;

// owned-path glob: ** any depth, * within a segment, trailing / means the whole directory
function ownedMatch(glob, rel) {
  const g = glob.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "/**");
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

// why an edit of target breaks the worktree's owned-path list, or "" when allowed or there is no list
function ownedDenial(wt, target) {
  let list;
  try { list = fs.readFileSync(ownedFile(wt), "utf8"); } catch { return ""; }
  // path.relative across Windows drives returns an absolute path, not "../"
  const r = path.relative(wt, path.resolve(wt, String(target)));
  const rel = r.split(path.sep).join("/");
  const needs = (why) => `${rel} is ${why}. Comment "NEEDS ${rel}: <why>" on the issue and stop.`;
  if (path.isAbsolute(r) || rel === ".." || rel.startsWith("../")) return needs("outside the worktree");
  const owned = list.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  return owned.some((g) => ownedMatch(g, rel)) ? "" : needs(`not in ${path.relative(wt, ownedFile(wt)).split(path.sep).join("/")}`);
}

// last `bytes` of a file as complete lines (first partial line dropped)
function tailLines(file, bytes = 256 * 1024) {
  if (!file) return [];
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return lines.filter((l) => l.trim());
  } catch { return []; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

const execOpts = (cwd, timeout, env) => ({ cwd, encoding: "utf8", timeout, windowsHide: true, stdio: ["ignore", "pipe", "ignore"], env });

// git / gh with a hard timeout; "" on any failure (not installed, no auth, no remote, offline)
function git(args, cwd, timeout = 3000) {
  try { return execFileSync("git", args, execOpts(cwd, timeout)).trim(); } catch { return ""; }
}
// configDir: a GH_CONFIG_DIR to run under (agentGhDir() runs it as the agents), else this process's login
function gh(args, cwd, timeout = 6000, configDir = "") {
  const env = { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" };
  if (configDir) env.GH_CONFIG_DIR = configDir;
  try { return execFileSync("gh", args, execOpts(cwd, timeout, env)).trim(); } catch { return ""; }
}

const envInt = (name, dflt) => { const n = parseInt(process.env[name], 10); return Number.isFinite(n) && n > 0 ? n : dflt; };

// rules for every non-lead agent: nothing that ends a turn waiting for a wake-up that never comes
const WAIT_MSG = "workers never wait on a background notification (it never arrives after your turn ends). Run it in the foreground with timeout up to 600000 ms, or start it detached (nohup … &) and poll its PID/log in this same turn.";
const EDIT_LAST_MSG = "--edit-last edits the newest comment of the shared GitHub account, which may be another agent's or the lead's ruling. Post a new comment instead.";
function workerDenial(ev) {
  if (ev.tool === "monitor") return WAIT_MSG;
  if (ev.tool !== "shell") return null;
  if (ev.background) return WAIT_MSG;
  if (/--edit-last\b/.test(ev.command)) return EDIT_LAST_MSG;
  return verdictPost(ev.command, ev.cwd) || branchDenial(ev.command, ev.cwd);
}

// ACCEPT, CHANGES and ANSWER are the human's words (proteus-verdict.js): an agent's gh comment, PR review or
// comments API call whose body opens with one is refused. The body is read from --body/-b, a body= field, a
// heredoc, or a --body-file/-F file under cwd. A guard, not a boundary: the verdict script's author check is.
const HUMAN_WORD = /^\s*(ACCEPT|CHANGES|ANSWER)(?=\s|$)/;
const VERDICT_MSG = "proteus: ACCEPT, CHANGES and ANSWER are the human's words; agents never post them. Report to the lead, word the comment differently, or record a pick the human made in this session as `Answered in session: <pick>`.";
function verdictPost(command, cwd) {
  const cmd = String(command || "");
  if (!/\bgh\s+((issue|pr)\s+(comment|review)|api)\b/.test(cmd) || !/ACCEPT|CHANGES|ANSWER|--body-file|-F\b/.test(cmd)) return null;
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
function shellCommands(command) {
  const s = String(command || "");
  const out = [];
  let words = [], word = null, heredocs = [];
  const endWord = () => { if (word !== null) words.push(word); word = null; };
  const endCmd = () => { endWord(); if (words.length) out.push(words); words = []; };
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
  wide: (flag) => `proteus: \`git push ${flag}\` can reach main or a run branch; push one branch by name.`,
  main: (b) => `proteus: agents never push to ${b}; a run reaches it only as the close PR the human merges.`,
  del: (b) => `proteus: agents never delete ${b}; the human does at close.`,
  run: (b, remote) => `proteus: ${b} changes only by a PR with \`gates\` green: push your own branch (proteus-work/<run>/<id>) and open a PR into ${b}. The one push to a run branch creates it at the start of the run (no ${remote}/${b} yet; \`git fetch --prune\` if it was deleted).`,
};
const WRAPPERS = new Set(["rtk", "proxy", "env", "command", "builtin", "exec", "nohup", "time", "sudo"]);
const GH_API_VALUE = new Set(["-X", "--method", "-H", "--header", "-f", "--raw-field", "-F", "--field", "--input", "-q", "--jq", "-t", "--template", "--hostname", "--cache", "-p", "--preview"]);
const GIT_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"]);
const PUSH_VALUE = new Set(["--repo", "-o", "--push-option", "--receive-pack", "--exec"]);

function branchDenial(command, cwd) {
  const cmd = String(command || "");
  if (!/\b(gh|git)\b/.test(cmd)) return null;
  for (const all of shellCommands(cmd)) {
    let i = 0;
    while (i < all.length && (WRAPPERS.has(all[i]) || /^[A-Za-z_]\w*=/.test(all[i]))) i++;
    const words = all.slice(i);
    const prog = String(words[0] || "").split(/[\\/]/).pop().replace(/\.exe$/i, "").toLowerCase();
    const why = prog === "gh" ? ghBranchDenial(words.slice(1)) : prog === "git" ? pushDenial(words.slice(1), path.resolve(cwd || ".")) : null;
    if (why) return why;
  }
  return null;
}

function ghBranchDenial(args) {
  if (args[0] === "pr" && args[1] === "merge" && args.includes("--admin")) return BRANCH_MSG.admin;
  if (args[0] !== "api") return null;
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
  method = method || (body ? "POST" : "GET");
  if (endpoint === "graphql") return /\b(delete|update)(BranchProtectionRule|RepositoryRuleset)\b/.test(args.join(" ")) ? BRANCH_MSG.protect : null;
  const path_ = endpoint.replace(/[?#].*$/, "").replace(/\/+$/, "");
  if (method === "GET") return null;
  if (/(^|\/)rulesets(\/|$)/.test(path_)) return BRANCH_MSG.protect;
  const p = /(?:^|\/)branches\/([^/]+)\/protection(\/.*)?$/.exec(path_);
  if (!p) return null;
  let branch = p[1];
  try { branch = decodeURIComponent(branch); } catch {}
  const runPut = method === "PUT" && !p[2] && SCHEMES.some((s) => branch.startsWith(s.branch));
  return runPut ? null : BRANCH_MSG.protect;
}

// git <global options> push …: each destination it would write, judged against main and the run branches
function pushDenial(words, cwd) {
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

// copy src → dst only when the bytes differ; true when written
function syncFile(src, dst) {
  let a;
  try { a = fs.readFileSync(src); } catch { return false; }
  return syncText(a, dst);
}
// write dst only when its bytes differ; true when written. With a marker, a dst that exists
// without it as its first text is the user's own and is left alone (install.js keeps it too).
function syncText(a, dst, marker) {
  a = Buffer.isBuffer(a) ? a : Buffer.from(String(a));
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
// ---- model ladder: the lead is whatever model the session runs; no agent goes above it.
// Rungs cheapest first. ~/.claude/proteus.json "models": { ladder, floor, solo } overrides the
// defaults; a project's `models:` line in AGENTS.md (the human's call, e.g. `models: solo=none
// floor=haiku`) overrides floor and solo. A solo model never runs as a subagent: at most one per
// project, and that one is the lead when the session runs on it.
// the harness's default ladder; none (a CLI whose lineup Proteus does not know) is single-model
// mode, the lead's own model as the only rung, until models.ladder names one
const modelDefaults = () => harness().models || { ladder: [], floor: "", solo: [] };

// ladder index of a model name or id ("claude-opus-5-5[1m]" → opus); the longest matching rung wins
function rungOf(ladder, name) {
  const n = String(name || "").toLowerCase();
  let best = -1;
  ladder.forEach((r, i) => { if (n.includes(r) && (best < 0 || r.length > ladder[best].length)) best = i; });
  return best;
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
  const pol = { ladder, floor: String(cfg.floor || d.floor).toLowerCase(), solo: "solo" in cfg ? list(cfg.solo) : d.solo };
  let agents = "";
  try { agents = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"); } catch {}
  const line = /^models:(.*)$/m.exec(agents);
  if (line) {
    for (const [, k, v] of line[1].matchAll(/(\w+)=(\S+)/g)) {
      if (k === "floor") pol.floor = v.toLowerCase();
      if (k === "solo") pol.solo = list(v);
    }
  }
  return pol;
}

// what this session may spawn: top (hard tickets, every verdict) and mid (standard tickets, helpers)
function modelCaps(ev, root) {
  const pol = modelPolicy(root);
  const lead = leadModel(ev) || savedLead(ev, root);
  const ladder = pol.ladder.length ? pol.ladder : lead ? [String(lead).toLowerCase()] : [];
  const { solo } = pol;
  if (!ladder.length) return { ladder, solo, lead, leadRung: -1, cap: -1, floor: -1, top: "", mid: "", floorName: "" }; // nothing known to enforce
  const L = rungOf(ladder, lead);
  // highest rung at or under the lead that is not solo (the lead is that one instance); unknown lead: the whole ladder
  let cap = L < 0 ? ladder.length - 1 : L;
  while (cap > 0 && solo.includes(ladder[cap])) cap--;
  const fl = rungOf(ladder, pol.floor);
  const floor = Math.min(fl < 0 ? 0 : fl, cap); // a lead below the floor takes the floor down with it
  return { ladder, solo, lead, leadRung: L, cap, floor, top: ladder[cap], mid: ladder[Math.max(floor, cap - 1)], floorName: ladder[floor] };
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

module.exports = {
  readInbox, refreshInbox, inboxFile,
  run, projectRoot, isLinked, isLead, gitCommonDir, mainRoot, stateDir, readJSON, writeJSON,
  CURRENT, LEGACY, SCHEMES, schemeOf, runName, runRefs, runBranches, legacyStateDir, legacyWorktreeDir, legacyWorktrees, migrateState,
  configFile, proteusConfig, agentGhDir, relPath, gitRoot, runOpen, ownedFile, ownedMatch, ownedDenial, tailLines, envInt, git, gh,
  workerDenial, verdictPost, shellCommands, branchDenial, rungOf, leadModel, saveLead, modelPolicy, modelCaps, syncFile, syncText, WAIT_MSG, EDIT_LAST_MSG,
};
try { harness(); } catch {}

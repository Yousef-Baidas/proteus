// Installer delete-guard contract (#13): no install.js run removes or changes anything outside the target's Proteus-owned paths,
// every delete in install.js goes through safeRemove, and tests/lib.js workdir() refuses a TMPDIR inside a git worktree.
// Every temp dir, the fake "real home" F included, is an fs.mkdtempSync under os.tmpdir(), checked to be outside the user's home
// before anything is spawned; the installer run is a clone of the checkout there with its uncommitted edits committed, and every
// run gets an explicit fake HOME and CODEX_HOME, a fake gh and claude, and no network. Case 3 reads install.js; the rest spawn.
// Amendment 2 (#13): a skill name from teams/*/skills.txt is one path segment or it is skipped (cases 5, 6, 8), the confine
// delete goes through safeRemove (case 7), the doctor never offers --fix for a dupe it will refuse (case 9), safeRemove's
// win32 branches hold (case 10), and case 3 covers link-skills.js (remover removeLink) and install-lead-hooks.js (safeUnlink).
// Case 7 fakes os.userInfo().homedir with a --require preload passed in NODE_OPTIONS, reading FAKE_USER_HOME, so it reaches
// install.js and every node it spawns. Case 10 requires install.js in a child that fakes win32 and an in-memory disk: install.js,
// when required rather than run, exports { allowedRoots, safeRemove } and runs nothing.
// #17 pins the guard layers a mutation pass let go: the doctor's dupe walk stops at the toplevel (case 13), standalone
// removeLink refuses a link reached through a symlinked HOME/.claude (case 14), and allowedRoots drops a toplevel holding a home (case 15).
// PROTEUS_SAFETY_SRC overrides the checkout cloned and read, for tests only.
// Exit 0 if every assertion passed, 1 otherwise; exit 1 before any spawn when os.tmpdir() is inside the user's home.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { ok, summary, fakeCli, homeEnv, SYS_PATH } = require(path.join(__dirname, "lib.js"));

const SRC = path.resolve(process.env.PROTEUS_SAFETY_SRC || path.join(__dirname, ".."));
// any shipped agent works; the ticket's proteus-lead.md is not one
const AGENT = "proteus-worker.md";

const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const under = (p, dir) => { const r = path.relative(dir, p); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };
const HOMES = [os.userInfo().homedir, process.env.HOME].flatMap((h) => (h ? [real(h)] : []));
const lstat = (p) => { try { return fs.lstatSync(p); } catch { return null; } };
const read = (p) => { try { return fs.readFileSync(p); } catch { return null; } };

// a fresh dir under os.tmpdir(); inside the user's home it is removed and the file stops before any spawn
const made = [];
function tmp(tag) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `proteus-safety-${tag}-`)));
  if (HOMES.some((h) => under(real(d), h))) {
    fs.rmdirSync(d);
    console.log(`FAIL ${d} is inside the user's home; run with TMPDIR outside it`);
    process.exit(1);
  }
  made.push(d);
  return d;
}

const TOOLS = tmp("tools");
const BIN = path.join(TOOLS, "bin");
fs.mkdirSync(BIN);
if (process.platform === "win32") fs.copyFileSync(process.execPath, path.join(BIN, "node.exe")); else fs.symlinkSync(process.execPath, path.join(BIN, "node"));
fakeCli(BIN, "gh", fs.readFileSync(path.join(__dirname, "fakegh.js"), "utf8"));
// fake claude: records the context-mode plugin the way the real CLI does, in the fake HOME
const CTX = "context-mode@context-mode";
fakeCli(BIN, "claude", `const fs = require("fs"), path = require("path"), os = require("os");
const a = process.argv.slice(2).join(" ");
const d = path.join(os.homedir(), ".claude"), rd = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {}; } };
fs.mkdirSync(path.join(d, "plugins"), { recursive: true });
if (a === "plugin marketplace add mksglu/context-mode") fs.writeFileSync(path.join(d, "plugins", "known_marketplaces.json"), JSON.stringify({ "context-mode": {} }));
if (a === "plugin install ${CTX} --scope user") fs.writeFileSync(path.join(d, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "${CTX}": [{ scope: "user" }] } }));
if (a === "plugin install ${CTX} --scope user" || a === "plugin enable ${CTX} --scope user") {
  const s = rd(path.join(d, "settings.json")); s.enabledPlugins = { ...s.enabledPlugins, "${CTX}": true }; fs.writeFileSync(path.join(d, "settings.json"), JSON.stringify(s));
}
`);

// PATH leaves out node's own bin dir, which may hold a real codex or claude
const envFor = (home) => ({
  PATH: [BIN, ...SYS_PATH].join(path.delimiter), ...homeEnv(home), CODEX_HOME: path.join(home, ".codex"),
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
});
const git = (args, cwd, input) => spawnSync("git", args, { cwd, env: envFor(TOOLS), encoding: "utf8", input, maxBuffer: 1 << 28 });

// the installer under test: SRC cloned (with its uncommitted edits) to ORIGIN on main, cloned again to CHK so --update can pull
const ORIGIN = path.join(TOOLS, "origin"), CHK = path.join(TOOLS, "proteus");
let step = git(["clone", "--quiet", SRC, ORIGIN], TOOLS);
const diff = git(["diff", "HEAD", "--binary"], SRC);
if (step.status === 0 && diff.stdout) {
  step = git(["apply", "--index"], ORIGIN, diff.stdout);
  if (step.status === 0) step = git(["commit", "--quiet", "--no-verify", "-m", "uncommitted changes"], ORIGIN);
}
if (step.status === 0) step = git(["checkout", "--quiet", "-B", "main"], ORIGIN);
if (step.status === 0) step = git(["clone", "--quiet", ORIGIN, CHK], TOOLS);
ok("the checkout clones into a temp dir", step.status === 0, step.stderr);

// node on script with a fake HOME; refuses a HOME, cwd or extra path (FAKE_USER_HOME) inside the user's home
function nodeRun(script, args, cwd, home, extra = {}) {
  const paths = [home, cwd, ...(extra.FAKE_USER_HOME ? [extra.FAKE_USER_HOME] : [])];
  if (HOMES.some((h) => paths.some((p) => under(real(p), h)))) throw new Error(`refusing to run ${script} with ${paths.join(" or ")} inside the user's home`);
  return spawnSync(process.execPath, [script, ...args], { cwd, env: { ...envFor(home), ...extra }, encoding: "utf8", timeout: 180000 });
}
const installer = (args, cwd, home, extra) => nodeRun(path.join(CHK, "install.js"), args, cwd, home, extra);

// a git repo with one commit whose teams/zz/skills.txt holds lines
function teamRepo(repo, lines) {
  fs.mkdirSync(path.join(repo, "teams", "zz"), { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# repo\n");
  fs.writeFileSync(path.join(repo, "teams", "zz", "skills.txt"), lines.map((l) => `${l}\n`).join(""));
  let g = git(["init", "--quiet"], repo);
  if (g.status === 0) g = git(["add", "-A"], repo);
  if (g.status === 0) g = git(["commit", "--quiet", "--no-verify", "-m", "init"], repo);
  return g;
}
const homeAt = (home) => { for (const d of [".claude", ".agents", ".codex"]) fs.mkdirSync(path.join(home, d), { recursive: true }); return home; };
const linkOf = (p) => { const st = lstat(p); return st && st.isSymbolicLink() ? fs.readlinkSync(p) : null; };
const dirLink = (target, link) => { fs.mkdirSync(target, { recursive: true }); fs.symlinkSync(target, link, "junction"); };
// a line of output that names the skill and says it was skipped
const skipped = (r, name) => `${r.stdout}${r.stderr}`.split("\n").some((l) => l.includes(name) && /skip/i.test(l));

// case 10's child: fakes win32 and an in-memory case-insensitive disk, requires install.js and calls its safeRemove;
// serialised with toString, so it uses nothing from this file. Prints one "WINPROBE <json>" line.
function winProbe(installJs) {
  const fs = require("fs"), os = require("os"), path = require("path"), cp = require("child_process");
  const out = { calls: [] };
  const done = () => process.stdout.write(`\nWINPROBE ${JSON.stringify(out)}\n`);
  // nothing install.js does on load may write or spawn: an unguarded one only gets as far as printing --help
  const blocked = (n) => () => { throw new Error(`blocked ${n} while loading install.js`); };
  for (const n of ["writeFileSync", "mkdirSync", "symlinkSync", "copyFileSync", "renameSync", "rmSync", "unlinkSync", "rmdirSync", "cpSync", "appendFileSync"]) fs[n] = blocked(`fs.${n}`);
  for (const n of ["spawnSync", "execFileSync", "execSync", "spawn", "execFile", "exec"]) cp[n] = blocked(`child_process.${n}`);
  process.argv = [process.argv[0], installJs, "--help"];
  process.exit = (c) => { throw new Error(`install.js ran its CLI when required (exit ${c})`); };
  Object.defineProperty(process, "platform", { value: "win32" });
  os.homedir = () => "C:\\Users\\Fake";
  os.userInfo = () => ({ uid: -1, gid: -1, username: "fake", homedir: "C:\\Users\\Real", shell: null });
  let m;
  try { m = require(installJs); } catch (e) { out.error = e.message; return done(); }
  if (!m || typeof m.safeRemove !== "function" || typeof m.allowedRoots !== "function") { out.error = "install.js exports no allowedRoots and safeRemove"; return done(); }
  const W = path.win32;
  Object.assign(path, W);
  const disk = new Map();
  const add = (p, type, target) => disk.set(p.toLowerCase(), { name: p, type, target });
  for (const d of ["C:\\", "C:\\Users", "C:\\Users\\Fake", "C:\\Users\\Fake\\.claude", "C:\\Users\\Fake\\.claude\\skills", "C:\\Users\\Fake\\.claude\\agents",
    "C:\\Users\\Fake\\.agents", "C:\\Users\\Fake\\.agents\\skills", "C:\\Users\\Fake\\.codex", "C:\\Users\\Fake\\.codex\\agents", "C:\\Users\\Real",
    "C:\\Users\\Real\\.claude", "C:\\Users\\Real\\.claude\\skills", "C:\\src", "C:\\src\\foo", "C:\\src\\j", "D:\\", "D:\\Users", "D:\\Users\\Fake",
    "D:\\Users\\Fake\\.claude", "D:\\Users\\Fake\\.claude\\skills"]) add(d, "dir");
  for (const [l, t] of [["C:\\Users\\Fake\\.claude\\skills\\j", "C:\\src\\j"], ["C:\\Users\\Fake\\.claude\\skills\\foo", "C:\\src\\foo"],
    ["D:\\Users\\Fake\\.claude\\skills\\foo", "C:\\src\\foo"], ["C:\\Users\\Real\\.claude\\skills\\foo", "C:\\src\\foo"]]) add(l, "junction", t);
  const has = (p) => disk.has(p.toLowerCase());
  const err = (code, p) => Object.assign(new Error(`${code}: ${p}`), { code });
  // every junction followed, the caller's case kept, like node's realpathSync on Windows: a root match must ignore case itself
  const realOf = (p) => {
    const abs = W.resolve(p), root = W.parse(abs).root;
    if (!has(root)) throw err("ENOENT", p);
    let at = root;
    for (const part of abs.slice(root.length).split("\\").filter(Boolean)) {
      const e = disk.get(W.join(at, part).toLowerCase());
      if (!e) throw err("ENOENT", p);
      at = e.type === "junction" ? realOf(e.target) : W.join(at, part);
    }
    return at;
  };
  const entry = (p) => {
    const abs = W.resolve(p), up = W.dirname(abs);
    if (up === abs) return disk.get(abs.toLowerCase()) || null;
    try { return disk.get(W.join(realOf(up), W.basename(abs)).toLowerCase()) || null; } catch { return null; }
  };
  const kids = (e) => [...disk.values()].filter((c) => c !== e && W.dirname(c.name).toLowerCase() === e.name.toLowerCase());
  const stats = (e) => ({ isSymbolicLink: () => e.type === "junction", isDirectory: () => e.type === "dir", isFile: () => false, mtimeMs: 0, size: 0 });
  const need = (p, o) => { const e = entry(p); if (!e && !(o && o.throwIfNoEntry === false)) throw err("ENOENT", p); return e; };
  fs.lstatSync = (p, o) => { const e = need(p, o); return e ? stats(e) : undefined; };
  fs.statSync = (p, o) => { const e = need(p, o); return e ? stats(e.type === "junction" ? disk.get(realOf(e.target).toLowerCase()) : e) : undefined; };
  fs.realpathSync = (p) => realOf(p);
  fs.realpathSync.native = fs.realpathSync;
  fs.existsSync = (p) => { try { realOf(p); return true; } catch { return false; } };
  fs.accessSync = (p) => { realOf(p); };
  fs.readlinkSync = (p) => { const e = need(p); if (e.type !== "junction") throw err("EINVAL", p); return e.target; };
  fs.readdirSync = (p) => kids(disk.get(realOf(p).toLowerCase())).map((c) => W.basename(c.name));
  // Windows: unlink on a junction or a directory is EPERM; rmdir removes a junction or an empty directory
  fs.unlinkSync = (p) => { out.calls.push(`unlink ${p}`); need(p); throw err("EPERM", p); };
  fs.rmdirSync = (p) => { out.calls.push(`rmdir ${p}`); const e = need(p); if (e.type === "dir" && kids(e).length) throw err("ENOTEMPTY", p); disk.delete(e.name.toLowerCase()); };
  fs.rmSync = (p, o) => {
    out.calls.push(`rm ${p}`);
    const e = entry(p);
    if (!e) { if (o && o.force) return; throw err("ENOENT", p); }
    const gone = [e, ...(e.type === "dir" ? [...disk.values()].filter((c) => c.name.toLowerCase().startsWith(`${e.name.toLowerCase()}\\`)) : [])];
    if (gone.length > 1 && !(o && o.recursive)) throw err("ENOTEMPTY", p);
    for (const c of gone) disk.delete(c.name.toLowerCase());
  };
  try {
    const roots = m.allowedRoots("C:\\Users\\Fake", "C:\\Users\\Fake\\.codex", null);
    out.roots = roots;
    const j = "C:\\Users\\Fake\\.claude\\skills\\j";
    out.junction = { removed: m.safeRemove(j, roots), gone: !has(j), target: has("C:\\src\\j"), calls: out.calls.filter((c) => c.endsWith(j)) };
    out.cased = { removed: m.safeRemove("c:\\users\\FAKE\\.Claude\\Skills\\foo", roots), gone: !has("C:\\Users\\Fake\\.claude\\skills\\foo") };
    out.drive = { removed: m.safeRemove("D:\\Users\\Fake\\.claude\\skills\\foo", roots), kept: has("D:\\Users\\Fake\\.claude\\skills\\foo") };
    out.user = { removed: m.safeRemove("C:\\Users\\Real\\.claude\\skills\\foo", roots), kept: has("C:\\Users\\Real\\.claude\\skills\\foo") };
    out.source = { kept: has("C:\\src\\foo") };
  } catch (e) { out.error = `threw: ${e.message}`; }
  done();
}

// F stands in for a real home: a shipped agent copy and a proteus skill link in F/.claude, the fake HOME at F/fakehome
function fakeRealHome(tag) {
  const F = tmp(tag);
  const agents = path.join(F, ".claude", "agents"), skills = path.join(F, ".claude", "skills");
  fs.mkdirSync(agents, { recursive: true });
  fs.mkdirSync(skills, { recursive: true });
  fs.copyFileSync(path.join(CHK, "agents", AGENT), path.join(agents, AGENT));
  fs.symlinkSync(path.join(CHK, "skills", "proteus"), path.join(skills, "proteus"), "junction");
  const home = path.join(F, "fakehome");
  for (const d of [".claude", ".agents", ".codex"]) fs.mkdirSync(path.join(home, d), { recursive: true });
  fs.mkdirSync(path.join(F, "work"));
  const f = { F, home, agent: path.join(agents, AGENT), link: path.join(skills, "proteus") };
  // a copy that differs from the shipped one is an override the installer keeps anyway: the case would measure nothing
  const shipped = read(path.join(CHK, "agents", AGENT));
  ok(`F's ${AGENT} is byte-identical to the shipped copy (${tag})`, !!shipped && shipped.equals(read(f.agent)));
  return f;
}

function intact(f, when) {
  ok(`F's shipped agent copy survives ${when}`, !!lstat(f.agent));
  const st = lstat(f.link);
  ok(`F's .claude/skills/proteus link survives ${when}`, !!st && st.isSymbolicLink());
}

// every path under root except skip, with its type, size or link target, and mtime
function snapshot(root, skip) {
  const out = new Map([[".", `dir:${fs.lstatSync(root).mtimeMs}`]]);
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      if (skip.includes(p)) continue;
      const st = fs.lstatSync(p);
      const kind = st.isSymbolicLink() ? `link:${fs.readlinkSync(p)}` : st.isDirectory() ? "dir" : `file:${st.size}`;
      out.set(path.relative(root, p), `${kind}:${st.mtimeMs}`);
      if (st.isDirectory()) walk(p);
    }
  };
  walk(root);
  return out;
}

function drift(a, b) {
  const out = [];
  for (const [k, v] of a) {
    if (!b.has(k)) out.push(`removed ${k}`);
    else if (b.get(k) !== v) out.push(`changed ${k}`);
  }
  for (const k of b.keys()) if (!a.has(k)) out.push(`added ${k}`);
  return out;
}

// [start, end) of a function's body in source text, braces matched; null when it is not defined
function fnBody(text, name) {
  const m = new RegExp(`function ${name}\\s*\\(`).exec(text);
  if (!m) return null;
  let i = m.index + m[0].length, depth = 1;
  for (; i < text.length && depth; i++) depth += text[i] === "(" ? 1 : text[i] === ")" ? -1 : 0;
  const open = text.indexOf("{", i);
  if (open < 0) return null;
  depth = 1;
  for (i = open + 1; i < text.length && depth; i++) depth += text[i] === "{" ? 1 : text[i] === "}" ? -1 : 0;
  return depth ? null : [open, i];
}

try {
  if (step.status === 0) {
    // case 1, walk: the doctor's dupe walk from F/work/plain (not a repo) must not reach F
    const f = fakeRealHome("walk");
    const plain = path.join(f.F, "work", "plain");
    fs.mkdirSync(plain);
    const r = installer(["--doctor", "--fix"], plain, f.home);
    ok("install.js --doctor --fix from F/work/plain runs to its report", /^(\d+ to fix|all good)/m.test(r.stdout || ""), `${r.status} ${r.stderr}${r.stdout}`);
    intact(f, "install.js --doctor --fix run from F/work/plain");

    // case 2, takeover and refresh: install, --update and --project in a repo under F touch only the fake HOME and the repo
    const t = fakeRealHome("takeover");
    const repo = path.join(t.F, "work", "repo");
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "# repo\n");
    let g = git(["init", "--quiet"], repo);
    if (g.status === 0) g = git(["add", "README.md"], repo);
    if (g.status === 0) g = git(["commit", "--quiet", "--no-verify", "-m", "init"], repo);
    ok("a repo under F/work is set up", g.status === 0, g.stderr);
    const skip = [...[".claude", ".agents", ".codex"].map((d) => path.join(t.home, d)), repo];
    const before = snapshot(t.F, skip);
    for (const args of [[], ["--update"], ["--project"], ["--update"]]) {
      const r2 = installer(args, repo, t.home);
      ok(`install.js ${args.join(" ") || "(no flags)"} in a repo under F exits 0`, r2.status === 0, `${r2.status} ${r2.stderr}${r2.stdout}`);
    }
    const moved = drift(before, snapshot(t.F, skip));
    ok("nothing in F outside the fake HOME's .claude, .agents, .codex and the repo is removed or changed", !moved.length, moved.join(", "));
    intact(t, "install.js, --update and --project in a repo under F");

    // case 5, traversal with --confine: skill names that climb out of HOME/.claude/skills are skipped, never removed
    const T5 = tmp("confine"), H5 = homeAt(path.join(T5, "home")), R5 = path.join(T5, "repo");
    dirLink(path.join(T5, "tgt_a"), path.join(H5, "dotlink"));
    dirLink(path.join(T5, "tgt_b"), path.join(T5, "victim"));
    ok("case 5: the repo with ../ skill names is set up", teamRepo(R5, ["a/b ../../dotlink", "a/b ../../../victim"]).status === 0);
    const r5 = installer(["--project", "--confine"], R5, H5);
    ok("case 5 (traversal, --confine): HOME/dotlink survives with its target", linkOf(path.join(H5, "dotlink")) === path.join(T5, "tgt_a"), `${r5.status} ${r5.stderr}`);
    ok("case 5 (traversal, --confine): T/victim outside HOME survives with its target", linkOf(path.join(T5, "victim")) === path.join(T5, "tgt_b"), `${r5.status} ${r5.stderr}`);
    ok("case 5 (traversal, --confine): the output warns that both names were skipped", skipped(r5, "../../dotlink") && skipped(r5, "../../../victim"), `${r5.stdout}${r5.stderr}`);

    // case 6, traversal with plain --project: a ../ name outside HOME and the repo re-points no link and creates no dir
    const T6 = tmp("project"), H6 = homeAt(path.join(T6, "a", "b", "c", "home")), R6 = path.join(T6, "repo");
    fs.mkdirSync(path.join(T6, "a", "X"));
    fs.mkdirSync(path.join(T6, "a", "newdir", "Y"), { recursive: true });
    dirLink(path.join(T6, "orig"), path.join(T6, "X"));
    ok("case 6: the repo with ../ skill names is set up", teamRepo(R6, ["a/b ../../../../../X", "a/b ../../../../../newdir/Y"]).status === 0);
    const before6 = snapshot(T6, [R6, H6]);
    const r6 = installer(["--project"], R6, H6);
    ok("case 6 (traversal, --project): T/X still points at T/orig", linkOf(path.join(T6, "X")) === path.join(T6, "orig"), `${r6.status} ${linkOf(path.join(T6, "X"))}`);
    ok("case 6 (traversal, --project): no T/newdir is created", !lstat(path.join(T6, "newdir")));
    const moved6 = drift(before6, snapshot(T6, [R6, H6]));
    ok("case 6 (traversal, --project): nothing outside HOME and the repo is removed, changed or added", !moved6.length, moved6.join(", "));

    // case 7, symlinked .claude: HOME/.claude points into the (faked) real home, so --confine must leave its skills/foo
    const T7 = tmp("symclaude"), F7 = path.join(T7, "realhome"), H7 = path.join(T7, "fakehome"), R7 = path.join(T7, "repo");
    fs.mkdirSync(path.join(F7, ".claude", "skills"), { recursive: true });
    fs.mkdirSync(path.join(T7, "src", "foo"), { recursive: true });
    fs.writeFileSync(path.join(T7, "src", "foo", "SKILL.md"), "---\nname: foo\ndescription: test skill\n---\n");
    fs.symlinkSync(path.join(T7, "src", "foo"), path.join(F7, ".claude", "skills", "foo"), "junction");
    fs.mkdirSync(H7);
    fs.symlinkSync(path.join(F7, ".claude"), path.join(H7, ".claude"), "junction");
    for (const d of [".agents", ".codex"]) fs.mkdirSync(path.join(H7, d));
    ok("case 7: the repo listing foo is set up", teamRepo(R7, ["a/b foo"]).status === 0);
    const preload = path.join(TOOLS, "fake-userinfo.js");
    fs.writeFileSync(preload, `"use strict";\n// test fake: os.userInfo().homedir is FAKE_USER_HOME\nconst os = require("os");\nconst h = process.env.FAKE_USER_HOME;\nif (h) { const u = os.userInfo; os.userInfo = (o) => ({ ...u(o), homedir: h }); }\n`);
    fs.writeFileSync(path.join(TOOLS, "userhome.js"), "console.log(require(\"os\").userInfo().homedir);\n");
    const fake7 = { NODE_OPTIONS: `${homeEnv("").NODE_OPTIONS || ""} --require ${preload}`.trim(), FAKE_USER_HOME: F7 };
    const echo = nodeRun(path.join(TOOLS, "userhome.js"), [], T7, H7, fake7);
    ok("case 7: the preload fakes os.userInfo().homedir in a spawned node", echo.stdout === `${F7}\n`, `${echo.status} ${echo.stdout}${echo.stderr}`);
    const r7 = installer(["--project", "--confine"], R7, H7, fake7);
    ok("case 7 (symlinked .claude, --confine): the real home's skills/foo link survives", linkOf(path.join(F7, ".claude", "skills", "foo")) === path.join(T7, "src", "foo"), `${r7.status} ${r7.stderr}`);

    // case 8, standalone link-skills.js: a ../ name changes nothing outside teams/<p>/{.claude,.agents}/skills and HOME/.claude/skills
    const T8 = tmp("standalone"), H8 = homeAt(path.join(T8, "a", "b", "c", "home")), R8 = path.join(T8, "repo");
    fs.mkdirSync(path.join(H8, ".claude", "skills"));
    fs.mkdirSync(path.join(T8, "a", "X"));
    dirLink(path.join(T8, "orig"), path.join(T8, "X"));
    dirLink(path.join(T8, "tgt"), path.join(H8, "dot8"));
    const own8 = [path.join(R8, "teams", "zz", ".claude", "skills"), path.join(R8, "teams", "zz", ".agents", "skills"), path.join(H8, ".claude", "skills")];
    for (const d of own8) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(R8, "teams", "zz", "skills.txt"), "a/b ../../../../../X\na/b ../../dot8\n");
    fs.copyFileSync(path.join(CHK, "templates", "teams", "link-skills.js"), path.join(R8, "teams", "link-skills.js"));
    const before8 = snapshot(T8, own8);
    const r8 = [[], ["--confine"]].map((a) => nodeRun(path.join(R8, "teams", "link-skills.js"), a, R8, H8));
    const moved8 = drift(before8, snapshot(T8, own8));
    ok("case 8 (standalone link-skills.js): nothing outside the team skill dirs and HOME/.claude/skills changes", !moved8.length, moved8.join(", "));
    ok("case 8 (standalone link-skills.js): T/X and HOME/dot8 keep their targets", linkOf(path.join(T8, "X")) === path.join(T8, "orig") && linkOf(path.join(H8, "dot8")) === path.join(T8, "tgt"));
    ok("case 8 (standalone link-skills.js): both runs warn that the names were skipped", r8.every((r) => skipped(r, "../../../../../X") && skipped(r, "../../dot8")), r8.map((r) => `${r.status} ${r.stderr}`).join(" | "));

    // case 9, doctor outside a repo: --fix would refuse the dupe, so its row names the manual step, never --doctor --fix
    const T9 = tmp("remedy"), H9 = homeAt(path.join(T9, "home")), P9 = path.join(T9, "plain");
    const dupe9 = path.join(P9, ".claude", "skills", "proteus");
    fs.mkdirSync(path.dirname(dupe9), { recursive: true });
    fs.symlinkSync(path.join(CHK, "skills", "proteus"), dupe9, "junction");
    const r9 = installer(["--doctor"], P9, H9);
    const rows9 = (r9.stdout || "").split("\n").filter((l) => l.includes(dupe9));
    ok("case 9 (doctor outside a repo): a row names the duplicate copy", rows9.length > 0, `${r9.status} ${r9.stdout}`);
    ok("case 9 (doctor outside a repo): the duplicate row does not recommend --doctor --fix", rows9.length > 0 && !rows9.some((l) => l.includes("--doctor --fix")), rows9.join(" | "));

    // case 11, standalone install-lead-hooks.js: a committed .codex/hooks symlink out of the repo changes nothing outside it
    const T11 = tmp("hooklink"), H11 = homeAt(path.join(T11, "home")), R11 = path.join(T11, "repo"), out11 = path.join(T11, "hooksout");
    fs.mkdirSync(out11);
    fs.writeFileSync(path.join(out11, "commit-msg.js"), "KEEP\n");
    fs.mkdirSync(path.join(R11, ".codex"), { recursive: true });
    fs.symlinkSync(out11, path.join(R11, ".codex", "hooks"), "junction");
    ok("case 11: the repo with a symlinked .codex/hooks is set up", teamRepo(R11, []).status === 0);
    const before11 = snapshot(T11, [R11, H11]);
    const r11 = nodeRun(path.join(CHK, "templates", "hooks", "install-lead-hooks.js"), [], R11, H11, { PROTEUS_HARNESS: "codex" });
    const moved11 = drift(before11, snapshot(T11, [R11, H11]));
    ok("case 11 (symlinked .codex/hooks, standalone): nothing outside the repo is removed, changed or added", !moved11.length, `${moved11.join(", ")} | ${r11.status} ${r11.stderr}`);
    ok("case 11 (symlinked .codex/hooks, standalone): the regular commit-msg.js outside survives", String(read(path.join(out11, "commit-msg.js"))) === "KEEP\n");
    ok("case 11 (symlinked .codex/hooks, standalone): the run says it refused", /refus/i.test(r11.stderr || ""), `${r11.status} ${r11.stdout}${r11.stderr}`);

    // case 12, standalone link-skills.js: a committed teams/zz/.claude symlink out of the repo changes nothing outside it
    const T12 = tmp("teamlink"), H12 = homeAt(path.join(T12, "home")), R12 = path.join(T12, "repo"), out12 = path.join(T12, "outside");
    fs.mkdirSync(path.join(H12, ".agents", "skills", "foo"), { recursive: true });
    fs.writeFileSync(path.join(H12, ".agents", "skills", "foo", "SKILL.md"), "---\nname: foo\ndescription: test skill\n---\n");
    fs.mkdirSync(path.join(out12, "skills"), { recursive: true });
    dirLink(path.join(T12, "precious"), path.join(out12, "skills", "foo"));
    fs.mkdirSync(path.join(R12, "teams", "zz"), { recursive: true });
    fs.symlinkSync(out12, path.join(R12, "teams", "zz", ".claude"), "junction");
    ok("case 12: the repo with a symlinked teams/zz/.claude is set up", teamRepo(R12, ["o/r foo"]).status === 0);
    const before12 = snapshot(T12, [R12, H12]);
    const r12 = nodeRun(path.join(CHK, "templates", "teams", "link-skills.js"), [], R12, H12);
    const moved12 = drift(before12, snapshot(T12, [R12, H12]));
    ok("case 12 (symlinked teams/zz/.claude, standalone): nothing outside the repo is removed, changed or added", !moved12.length, `${moved12.join(", ")} | ${r12.status} ${r12.stderr}`);
    ok("case 12 (symlinked teams/zz/.claude, standalone): outside/skills/foo keeps its target", linkOf(path.join(out12, "skills", "foo")) === path.join(T12, "precious"));
    ok("case 12 (symlinked teams/zz/.claude, standalone): the run warns it left the dir alone", /left alone|refus/i.test(r12.stderr || ""), `${r12.status} ${r12.stdout}${r12.stderr}`);

    // case 13, doctor walk stops at the toplevel (#17): a proteus link in the dir above the repo is neither listed nor removed
    const T13 = tmp("above"), H13 = homeAt(path.join(T13, "home")), R13 = path.join(T13, "outer", "repo");
    const up13 = path.join(T13, "outer", ".claude", "skills", "proteus"), in13 = path.join(R13, ".claude", "skills", "proteus");
    fs.mkdirSync(R13, { recursive: true });
    ok("case 13: the repo under T/outer is set up", teamRepo(R13, []).status === 0);
    for (const l of [up13, in13]) { fs.mkdirSync(path.dirname(l), { recursive: true }); fs.symlinkSync(path.join(CHK, "skills", "proteus"), l, "junction"); }
    const r13 = installer(["--doctor", "--fix"], R13, H13);
    ok("case 13 (doctor above the toplevel): --doctor --fix removes the copy inside the repo", !lstat(in13), `${r13.status} ${r13.stdout}${r13.stderr}`);
    ok("case 13 (doctor above the toplevel): no row names the link above the repo", !`${r13.stdout}${r13.stderr}`.includes(up13), `${r13.stdout}${r13.stderr}`);
    ok("case 13 (doctor above the toplevel): the link above the repo survives", linkOf(up13) === path.join(CHK, "skills", "proteus"));

    // case 14, standalone link-skills.js --confine (#17): HOME/.claude links into the (fake) real home, so removeLink refuses its skills/foo
    const T14 = tmp("confinelink"), F14 = path.join(T14, "realhome"), H14 = path.join(T14, "fakehome"), R14 = path.join(T14, "repo");
    const src14 = path.join(T14, "src", "foo"), g14 = path.join(F14, ".claude", "skills", "foo");
    fs.mkdirSync(path.dirname(g14), { recursive: true });
    fs.mkdirSync(src14, { recursive: true });
    fs.writeFileSync(path.join(src14, "SKILL.md"), "---\nname: foo\ndescription: test skill\n---\n");
    fs.symlinkSync(src14, g14, "junction");
    fs.mkdirSync(H14);
    fs.symlinkSync(path.join(F14, ".claude"), path.join(H14, ".claude"), "junction");
    for (const d of [".agents", ".codex"]) fs.mkdirSync(path.join(H14, d));
    fs.mkdirSync(path.join(R14, "teams", "zz"), { recursive: true });
    fs.writeFileSync(path.join(R14, "teams", "zz", "skills.txt"), "a/b foo\n");
    fs.copyFileSync(path.join(CHK, "templates", "teams", "link-skills.js"), path.join(R14, "teams", "link-skills.js"));
    const r14 = nodeRun(path.join(R14, "teams", "link-skills.js"), ["--confine"], R14, H14);
    ok("case 14 (symlinked .claude, standalone --confine): foo is linked into the team", linkOf(path.join(R14, "teams", "zz", ".claude", "skills", "foo")) === src14, `${r14.status} ${r14.stdout}${r14.stderr}`);
    ok("case 14 (symlinked .claude, standalone --confine): the real home's skills/foo link survives", linkOf(g14) === src14, `${r14.status} ${r14.stderr}`);
    ok("case 14 (symlinked .claude, standalone --confine): the run says it refused the global link", /refused\s+\S*foo/.test(r14.stderr || ""), `${r14.status} ${r14.stderr}`);

    // case 15, allowedRoots (#17): a project toplevel that holds HOME or the user's home is never a delete root
    const T15 = tmp("roots"), probe15 = path.join(TOOLS, "roots-probe.js");
    fs.writeFileSync(probe15, `"use strict";\nconst [js, home, top] = process.argv.slice(2);\nconsole.log(JSON.stringify(require(js).allowedRoots(home, require("path").join(home, ".codex"), top)));\n`);
    const roots15 = (home, top, extra) => {
      for (const d of [home, top]) fs.mkdirSync(d, { recursive: true });
      const r = nodeRun(probe15, [path.join(CHK, "install.js"), home, top], T15, home, extra);
      try { return JSON.parse(r.stdout); } catch { return [`no roots: ${r.status} ${r.stdout}${r.stderr}`]; }
    };
    const top15 = path.join(T15, "tophome"), user15 = path.join(T15, "topuser"), plain15 = path.join(T15, "plain");
    const a15 = roots15(path.join(top15, "home"), top15);
    ok("case 15 (allowedRoots): a toplevel that holds HOME is left out", Array.isArray(a15) && a15.length > 0 && !a15.includes(real(top15)), JSON.stringify(a15));
    const b15 = roots15(path.join(T15, "h"), user15, { NODE_OPTIONS: `${homeEnv("").NODE_OPTIONS || ""} --require ${preload}`.trim(), FAKE_USER_HOME: path.join(user15, "me") });
    ok("case 15 (allowedRoots): a toplevel that holds the user's home is left out", Array.isArray(b15) && b15.length > 0 && !b15.includes(real(user15)), JSON.stringify(b15));
    const c15 = roots15(path.join(T15, "h"), plain15);
    ok("case 15 (allowedRoots): a toplevel that holds neither is a root", Array.isArray(c15) && c15.includes(real(plain15)), JSON.stringify(c15));
  }

  // case 3, grep: every rmSync, unlinkSync and rmdirSync in each file sits inside that file's one guard or remover
  for (const [file, guard] of [["install.js", "safeRemove"], ["templates/teams/link-skills.js", "removeLink"], ["templates/hooks/install-lead-hooks.js", "safeUnlink"]]) {
    const text = fs.readFileSync(path.join(SRC, ...file.split("/")), "utf8");
    const body = fnBody(text, guard);
    const stray = [];
    for (const m of text.matchAll(/\b(rmSync|unlinkSync|rmdirSync)\b/g)) {
      if (!body || m.index < body[0] || m.index >= body[1]) stray.push(`${file}:${text.slice(0, m.index).split("\n").length} ${m[1]}`);
    }
    ok(`${file} defines function ${guard}`, !!body);
    ok(`rmSync, unlinkSync and rmdirSync appear in ${file} only inside ${guard}`, !stray.length, stray.join(", "));
  }

  // case 10, win32: safeRemove falls back from unlink to rmdir for a junction and matches roots without case
  const probe = path.join(TOOLS, "win-probe.js");
  fs.writeFileSync(probe, `"use strict";\n(${winProbe.toString()})(${JSON.stringify(path.join(SRC, "install.js"))});\n`);
  const wr = nodeRun(probe, [], TOOLS, homeAt(path.join(tmp("win"), "home")));
  const wm = /^WINPROBE (.*)$/m.exec(wr.stdout || "");
  const w10 = wm ? JSON.parse(wm[1]) : { error: `no probe result: ${wr.status} ${wr.stderr}` };
  const why = JSON.stringify(w10);
  ok("case 10 (win32): install.js, required, exports allowedRoots and safeRemove and runs nothing", !w10.error, why);
  const jn = w10.junction || {};
  ok("case 10 (win32): a junction under HOME/.claude/skills is removed", jn.removed === true && jn.gone === true && jn.target === true, why);
  ok("case 10 (win32): the junction goes by rmdir after unlink fails with EPERM", ((jn.calls || [])[0] || "").startsWith("unlink ") && (jn.calls || []).slice(1).some((c) => c.startsWith("rmdir ")), why);
  ok("case 10 (win32): a differently-cased path under HOME matches its root and is removed", (w10.cased || {}).removed === true && w10.cased.gone === true, why);
  ok("case 10 (win32): the same path on another drive is refused", (w10.drive || {}).removed === false && w10.drive.kept === true, why);
  ok("case 10 (win32): the same path in the real user home is refused", (w10.user || {}).removed === false && w10.user.kept === true && (w10.source || {}).kept === true, why);

  // case 4, workdir: a test file whose os.tmpdir() is inside a git worktree stops before it creates anything
  const w = tmp("repo");
  const init = git(["init", "--quiet"], w);
  ok("a temp git repo for TMPDIR is set up", init.status === 0, init.stderr);
  const bad = path.join(w, "tmp");
  fs.mkdirSync(bad);
  const r = spawnSync(process.execPath, [path.join(__dirname, "fixtures", "workdir-probe.js"), path.join(SRC, "tests", "lib.js")], {
    cwd: w, env: { ...envFor(path.join(w, "home")), TMPDIR: bad, TMP: bad, TEMP: bad }, encoding: "utf8", timeout: 60000,
  });
  const said = `${r.stdout}${r.stderr}`;
  ok("workdir() exits non-zero when os.tmpdir() is inside a git worktree", r.status !== 0 && r.status !== null, `${r.status} ${said}`);
  ok("workdir()'s refusal names the misplaced tmpdir", r.status !== 0 && (said.includes(bad) || said.includes(real(bad))), said);
  ok("workdir()'s refusal is a message, not a crash", r.status !== 0 && !/\n\s+at /.test(r.stderr || ""), r.stderr);
  ok("workdir() creates nothing under the misplaced tmpdir", !lstat(path.join(bad, "proteus-test")));
} finally {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
}

summary();

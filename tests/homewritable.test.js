// #212 B6, B7: node tests/homewritable.test.js (needs git). A 1.x home agents can write (self-hosted in the project,
// the maintainer's own setup, or in another repo a sandbox profile makes writable) is never fetched, merged, moved to
// the plugin, synced or required from by the autostart, which runs unsandboxed. The agent side plants a changed lib,
// an extra hook, agents, a patch module and an install.js in the home; one SessionStart of the installed autostart
// must run, copy and load none of it, and say so in one line. Then lib.homeWritable for each writable place. Temp
// HOME; never the network or the real ~/.claude.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "templates", "hooks");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("homewritable");
const { HOME } = lib;
// the lib in this process reads the profiles and the guest dirs under the temp HOME, never the real ones
process.env.HOME = process.env.USERPROFILE = HOME;
process.env.CLAUDE_CONFIG_DIR = path.join(HOME, ".claude");
const L = require(path.join(SRC, "proteus-lib.js"));

// a fake claude CLI, so pluginMove would find one on PATH
lib.fakeCli(lib.BIN, "claude", "process.exit(0);\n");

// the self-hosted project: home = the root, the hooks installed in <root>/.claude/hooks
const R = path.join(W, "work", "proteus");
fs.mkdirSync(R, { recursive: true });
g(R, "init", "-q", "-b", "main");
fs.mkdirSync(path.join(R, "templates"));
fs.cpSync(SRC, path.join(R, "templates", "hooks"), { recursive: true });
fs.cpSync(SRC, path.join(R, ".claude", "hooks"), { recursive: true });
fs.mkdirSync(path.join(R, "agents"));
fs.writeFileSync(path.join(R, "agents", "proteus-worker.md"), "---\nname: proteus-worker\ndescription: w\n---\nworker\n");
fs.mkdirSync(path.join(R, ".claude", "skills", "proteus"), { recursive: true });
fs.writeFileSync(path.join(R, ".claude", "skills", "proteus", "SKILL.md"), "---\nname: proteus\n---\nSKILL BODY\n");
fs.mkdirSync(path.join(R, ".claude-plugin"));
fs.writeFileSync(path.join(R, ".claude-plugin", "plugin.json"), "{\"name\":\"proteus\"}\n");
fs.writeFileSync(path.join(R, "install.js"), "// the release installer\n");
g(R, "add", "-A"); g(R, "commit", "-qm", "init");
const COMMON = fs.realpathSync(path.join(R, ".git"));

const CFG = path.join(HOME, ".claude", "proteus.json");
const AGENTS = path.join(HOME, ".claude", "agents");
const HOOKS = path.join(R, ".claude", "hooks");
const setCfg = (home) => fs.writeFileSync(CFG, JSON.stringify({ home, autoUpdate: true, lastFetch: Date.now(), toured: "x" }));
const start = (env = {}) => lib.run(path.join(HOOKS, "proteus-autostart.js"), { hook_event_name: "SessionStart", source: "compact", session_id: "h1", cwd: R }, { cwd: R, env: { FAKE_GH: "fail", ...env } });
const snap = (d) => { try { return JSON.stringify(fs.readdirSync(d).sort().map((n) => [n, fs.readFileSync(path.join(d, n)).toString("base64")])); } catch { return "none"; } };
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// the line also names the skill link the skip leaves loading, and how to remove it
const LINK_NOTE = `Its skill link ${path.join(HOME, ".claude", "skills", "proteus")} still loads`;
const skipLine = (out, home) => out.split("\n").filter((l) => l.includes("is a place agents can write") && l.includes(home) && l.includes("install.js") && /--update from your own terminal/.test(l)
  && l.includes(LINK_NOTE) && /remove that link \(the link itself, not the folder it points to\)/.test(l));

// ---- the agent side: every path is inside <root>, which the sandbox profile makes writable
const PWN = (n) => path.join(W, `PWNED-${n}`);
const pwn = (n) => `require("fs").writeFileSync(${JSON.stringify(PWN(n))}, "ran");\n`;
fs.writeFileSync(path.join(R, "templates", "hooks", "proteus-agent-patch.js"), `${pwn("require")}module.exports = { apply: () => ({ written: [], removed: [], file: "x" }) };\n`);
fs.appendFileSync(path.join(R, "templates", "hooks", "proteus-lib.js"), pwn("lib"));
fs.writeFileSync(path.join(R, "templates", "hooks", "proteus-evil.js"), pwn("hook"));
fs.writeFileSync(path.join(R, "agents", "proteus-evil.md"), "---\nname: proteus-evil\ndescription: x\n---\nagent-written agent\n");
fs.writeFileSync(path.join(R, "install.js"), pwn("spawn"));
// a patch for proteus-worker (the patch file is agent-writable on Linux) and the shipped text it starts from, edited
fs.writeFileSync(path.join(R, ".claude", "proteus-agents.json"), JSON.stringify({ "proteus-worker": { append: "patched" } }));
fs.writeFileSync(path.join(R, "agents", "proteus-worker.md"), "---\nname: proteus-worker\ndescription: w\nhooks: agent-written\n---\nworker\n");
const PROJECT_AGENTS = path.join(R, ".claude", "agents");

const hooksBefore = snap(HOOKS), agentsBefore = snap(AGENTS), projectBefore = snap(PROJECT_AGENTS);
setCfg(R);
const r = start();
// pluginMove's install.js --update, when one runs, is detached: give it time to land
nap(1500);
const pwned = ["require", "lib", "hook", "spawn"].filter((n) => fs.existsSync(PWN(n)));
ok("self-hosted home: nothing the agent planted ran (no require, no install.js --update, no lib loaded)", r.code === 0 && !pwned.length, `rc=${r.code} ran: ${pwned.join(" ")}\n${r.err.slice(0, 800)}`);
ok("self-hosted home: .claude/hooks/ is unchanged (no hook or lib synced in)", snap(HOOKS) === hooksBefore, fs.readdirSync(HOOKS).join(" "));
ok("self-hosted home: ~/.claude/agents is unchanged (no agent synced in)", snap(AGENTS) === agentsBefore, snap(AGENTS).slice(0, 300));
ok("self-hosted home: no patched agent regenerated from the home's agents/ into .claude/agents", snap(PROJECT_AGENTS) === projectBefore, snap(PROJECT_AGENTS).slice(0, 300));
ok("self-hosted home: one line says what was skipped, why, and the manual update", skipLine(r.out, R).length === 1, r.out.slice(0, 1500));
ok("self-hosted home: no plugin move recorded, no update note", !("pluginTried" in JSON.parse(fs.readFileSync(CFG, "utf8"))) && !/moving to the Claude Code plugin|synced \d+ files|updated to/.test(r.out), r.out.slice(0, 1500));

// ---- each place lib.homeWritable counts as agent-writable, end to end: the autostart says it skipped the home
const PROFILES = path.join(HOME, ".claude", "proteus-sandbox");
const profile = (name, allowWrite) => { fs.mkdirSync(PROFILES, { recursive: true }); fs.writeFileSync(path.join(PROFILES, `${name}.json`), JSON.stringify({ sandbox: { filesystem: { allowWrite } } })); };
const noProfiles = () => fs.rmSync(PROFILES, { recursive: true, force: true });
const cases = [];
const SUB = path.join(R, "vendor", "proteus");
fs.mkdirSync(SUB, { recursive: true });
cases.push(["inside the project root", SUB]);
const INCOMMON = path.join(COMMON, "proteus", "home");
fs.mkdirSync(INCOMMON, { recursive: true });
cases.push(["inside <common>", INCOMMON]);
// a clone of its own inside a registered worktree outside the root: its git dir is not <common>, so only the
// worktree rule catches it
const WT = path.join(W, "work", "proteus-wt");
g(R, "worktree", "add", "-q", "-b", "w1", WT);
const NESTED = path.join(WT, "vendor", "proteus");
fs.mkdirSync(NESTED, { recursive: true });
g(NESTED, "init", "-q", "-b", "main");
ok("setup: the nested clone's git dir is its own", !L.samePath(L.homeGitDir(NESTED), COMMON), L.homeGitDir(NESTED));
cases.push(["a clone of its own inside a registered worktree outside the root (worktree rule)", NESTED]);
// a linked worktree outside the root whose gitdir record an agent pointed elsewhere: no registered worktree names it,
// so only its git dir being <common> catches it
const WT2 = path.join(W, "work", "proteus-wt2");
g(R, "worktree", "add", "-q", "-b", "w2", WT2);
fs.writeFileSync(path.join(COMMON, "worktrees", "proteus-wt2", "gitdir"), path.join(W, "elsewhere", ".git") + "\n");
ok("setup: no registered worktree names the second one", !L.registeredWorktrees(COMMON).some((d) => L.samePath(d, fs.realpathSync(WT2))), L.registeredWorktrees(COMMON).join(" "));
ok("setup: the second worktree's git dir is <common>", L.samePath(L.homeGitDir(WT2), COMMON), L.homeGitDir(WT2));
cases.push(["a linked worktree outside the root sharing <common> (git-dir rule)", WT2]);
// guest mode: the dir guest.json names, and the fixed ~/.proteus/guest/<repo>-<hash>
const GUEST = path.join(W, "guest-named");
fs.mkdirSync(path.join(GUEST, "proteus"), { recursive: true });
cases.push(["inside the guest dir guest.json names", path.join(GUEST, "proteus"), () => { fs.mkdirSync(path.join(COMMON, "proteus"), { recursive: true }); fs.writeFileSync(path.join(COMMON, "proteus", "guest.json"), JSON.stringify({ dir: GUEST })); }, () => fs.rmSync(path.join(COMMON, "proteus", "guest.json"))]);
const FIXED = path.join(L.defaultGuestDir(COMMON), "proteus");
fs.mkdirSync(FIXED, { recursive: true });
cases.push(["inside the fixed guest dir", FIXED]);
// the scratch root a profile names, wherever the temp dir of the hook is: taken from the profile, not os.tmpdir()
const SCRATCH = path.join(W, "other-tmp", "proteus-1000", "home");
fs.mkdirSync(SCRATCH, { recursive: true });
cases.push(["inside the scratch root a sandbox profile names", SCRATCH, () => profile("proteus-11111111", [R, COMMON, path.dirname(SCRATCH)]), noProfiles]);
const LINK = path.join(W, "home-link");
let linked = false;
try { fs.symlinkSync(SUB, LINK, "dir"); linked = true; } catch {}
if (linked) cases.push(["a link outside the root that resolves inside it", LINK]);
else ok("homeWritable: link case skipped (no symlink here)", true);

for (const [name, home, before, after] of cases) {
  if (before) before();
  try {
    ok(`homeWritable: ${name}`, L.homeWritable(home, R, COMMON) === true, home);
    setCfg(home);
    const rc = start();
    ok(`autostart skips a home ${name}, in one line`, skipLine(rc.out, home).length === 1, rc.out.slice(0, 1200));
  } finally { if (after) after(); }
}

// a release home outside every writable place is not one
const OUT = path.join(W, "release", "proteus");
fs.mkdirSync(OUT, { recursive: true });
ok("homeWritable: a home outside the root, <common>, worktrees, guest dirs and every profile is not", L.homeWritable(OUT, R, COMMON) === false);
setCfg(OUT);
const ro = start();
ok("autostart: a home outside them gets no skip line", !skipLine(ro.out, OUT).length && !/is a place agents can write/.test(ro.out), ro.out.slice(0, 1200));

// a profile that cannot be read (bad JSON here; a link or a FIFO likewise): homeWritable throws, and the autostart
// fails closed, skipping even a home outside every writable place
profile("broken", []);
fs.writeFileSync(path.join(PROFILES, "broken.json"), "{");
let threw = false;
try { L.homeWritable(OUT, R, COMMON); } catch { threw = true; }
ok("homeWritable: an unreadable profile throws", threw);
const rb = start();
ok("autostart: homeWritable throwing fails closed, with the skip line", skipLine(rb.out, OUT).length === 1, rb.out.slice(0, 1200));
noProfiles();

// ---- #212 B7: a home self-hosted in sandboxed repo A, named by another 1.x project B. A's agents write A's root;
// B's autostart runs unsandboxed. Without a profile for A nothing marks A writable and B syncs from it (the control);
// with A's profile in <claudeDir>/proteus-sandbox, B syncs, requires and copies nothing from it
const A = path.join(W, "work", "repo-a");
fs.mkdirSync(path.join(A, "templates"), { recursive: true });
fs.cpSync(SRC, path.join(A, "templates", "hooks"), { recursive: true });
fs.mkdirSync(path.join(A, "agents"));
fs.writeFileSync(path.join(A, "agents", "proteus-worker.md"), "---\nname: proteus-worker\ndescription: w\n---\nworker\n");
g(A, "init", "-q", "-b", "main"); g(A, "add", "-A"); g(A, "commit", "-qm", "init");
const B = path.join(W, "work", "repo-b"), BHOOKS = path.join(B, ".claude", "hooks");
fs.mkdirSync(path.join(B, ".claude", "skills", "proteus"), { recursive: true });
fs.cpSync(SRC, BHOOKS, { recursive: true });
fs.writeFileSync(path.join(B, ".claude", "skills", "proteus", "SKILL.md"), "---\nname: proteus\n---\nSKILL BODY\n");
fs.writeFileSync(path.join(B, "a.js"), "x\n");
g(B, "init", "-q", "-b", "main"); g(B, "add", "-A"); g(B, "commit", "-qm", "init");
// the agent side, in A's sandbox
fs.writeFileSync(path.join(A, "templates", "hooks", "proteus-agent-patch.js"), `${pwn("cross-require")}module.exports = { apply: () => ({ written: [], removed: [], file: "x" }) };\n`);
fs.appendFileSync(path.join(A, "templates", "hooks", "proteus-lib.js"), pwn("cross-lib"));
fs.writeFileSync(path.join(A, "agents", "proteus-evil.md"), "---\nname: proteus-evil\ndescription: x\n---\nagent-written agent\n");
const startB = () => lib.run(path.join(BHOOKS, "proteus-autostart.js"), { hook_event_name: "SessionStart", source: "startup", session_id: "b1", cwd: B }, { cwd: B, env: { FAKE_GH: "fail" } });
const crossPwned = () => ["cross-require", "cross-lib"].filter((n) => fs.existsSync(PWN(n)));
const bHooks = snap(BHOOKS), bAgents = snap(AGENTS);
fs.writeFileSync(CFG, JSON.stringify({ home: A, lastFetch: Date.now(), toured: "x" }));
const control = startB();
ok("cross-project control: with no profile for A, B's autostart syncs from A (the setup is live)", /synced \d+ files/.test(control.out) && snap(BHOOKS) !== bHooks, control.out.slice(0, 800));
for (const n of ["cross-require", "cross-lib"]) fs.rmSync(PWN(n), { force: true });
fs.rmSync(BHOOKS, { recursive: true }); fs.cpSync(SRC, BHOOKS, { recursive: true });
fs.rmSync(AGENTS, { recursive: true, force: true }); if (bAgents !== "none") fs.mkdirSync(AGENTS);
profile("repo-a-22222222", [A, fs.realpathSync(path.join(A, ".git"))]);
ok("homeWritable: a home inside another repo's profile is writable from B", L.homeWritable(A, B, fs.realpathSync(path.join(B, ".git"))) === true);
const cross = startB();
nap(500);
ok("cross-project: B's autostart requires and loads nothing from A", !crossPwned().length, crossPwned().join(" "));
ok("cross-project: B's .claude/hooks unchanged (no sync)", snap(BHOOKS) === bHooks, cross.out.slice(0, 600));
ok("cross-project: ~/.claude/agents unchanged (no agent copied)", snap(AGENTS) === bAgents, snap(AGENTS).slice(0, 300));
ok("cross-project: one skip line naming A", skipLine(cross.out, A).length === 1 && !/synced \d+ files/.test(cross.out), cross.out.slice(0, 1200));
noProfiles();

// ---- #212 B7: the home resolved once. A link in the root (agent-writable) to a clean clone outside is refused by
// its lexical path, wherever the link points when checked; a link outside every writable place to that clone is
// read through the realpath, which the sync note names
const CLEAN = path.join(W, "clean", "proteus");
fs.mkdirSync(path.join(CLEAN, "templates"), { recursive: true });
fs.cpSync(SRC, path.join(CLEAN, "templates", "hooks"), { recursive: true });
fs.mkdirSync(path.join(CLEAN, "agents"));
g(CLEAN, "init", "-q", "-b", "main"); g(CLEAN, "add", "-A"); g(CLEAN, "commit", "-qm", "init");
const INLINK = path.join(R, "proteus-home"), OUTLINK = path.join(W, "proteus-home-link");
let links = false;
try { fs.symlinkSync(CLEAN, INLINK, "dir"); fs.symlinkSync(CLEAN, OUTLINK, "dir"); links = true; } catch {}
if (links) {
  ok("homeWritable: a link in the root to a clean clone outside is refused by its lexical path", L.homeWritable(INLINK, R, COMMON) === true);
  setCfg(INLINK);
  const ri = start();
  ok("autostart: a home linked from the root is skipped, in one line", skipLine(ri.out, INLINK).length === 1, ri.out.slice(0, 1200));
  ok("homeWritable: a link outside every writable place to the clean clone is not", L.homeWritable(OUTLINK, R, COMMON) === false);
  fs.rmSync(HOOKS, { recursive: true }); fs.cpSync(SRC, HOOKS, { recursive: true });
  fs.appendFileSync(path.join(CLEAN, "templates", "hooks", "proteus-statusline.js"), "// newer\n");
  setCfg(OUTLINK);
  const rl = start();
  ok("autostart: a linked home outside is read through its realpath alone", rl.out.includes(`synced 1 files from ${fs.realpathSync.native(CLEAN)}`) && !rl.out.includes(`from ${OUTLINK}`), rl.out.slice(0, 1200));
} else ok("homeWritable: link-home cases skipped (no symlink here)", true);

// ---- profileWrites: a "~/" entry is under the home; a place is compared by its realpath too; a linked
// proteus-sandbox dir (an agent could point it at profiles of its own) is refused, not read
{
  const tilde = path.join(HOME, "tilde-place");
  fs.mkdirSync(path.join(tilde, "proteus"), { recursive: true });
  profile("tilde", ["~/tilde-place"]);
  ok("profileWrites: a ~/ entry is the path under the home", L.profileWrites().includes(tilde), JSON.stringify(L.profileWrites()));
  ok("homeWritable: a home under a profile's ~/ entry is writable", L.homeWritable(path.join(tilde, "proteus"), null, null) === true);
  noProfiles();
  const real = path.join(W, "real-place"), via = path.join(W, "via-link");
  fs.mkdirSync(path.join(real, "proteus"), { recursive: true });
  let made = false;
  try { fs.symlinkSync(real, via, "dir"); made = true; } catch {}
  if (made) {
    profile("vialink", [via]);
    ok("homeWritable: a home inside the target of a linked profile entry is writable", L.homeWritable(fs.realpathSync(path.join(real, "proteus")), null, null) === true);
    noProfiles();
    const elsewhere = path.join(W, "other-profiles");
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.writeFileSync(path.join(elsewhere, "x.json"), JSON.stringify({ sandbox: { filesystem: { allowWrite: [] } } }));
    fs.mkdirSync(path.dirname(PROFILES), { recursive: true });
    fs.symlinkSync(elsewhere, PROFILES, "dir");
    let threw = false;
    try { L.profileWrites(); } catch { threw = true; }
    ok("profileWrites: a linked proteus-sandbox dir throws", threw);
    try { fs.unlinkSync(PROFILES); } catch { fs.rmdirSync(PROFILES); }
  } else ok("profileWrites: link cases skipped (no symlink here)", true);
}

// ---- macOS and Windows: containment folds case and Unicode form, as their file systems do by default
ok("within: darwin folds case", L.within("/Users/Me/Repo", "/users/me/repo/proteus", "darwin") === true);
ok("within: darwin folds NFD to NFC", L.within("/Users/me/cafe\u0301", "/Users/me/caf\u00e9/proteus", "darwin") === true);
ok("within: win32 folds case and separators", L.within("C:\\Users\\Me\\Repo", "c:/users/me/repo/proteus", "win32") === true);
ok("within: linux keeps case", L.within("/home/Me/Repo", "/home/me/repo/proteus", "linux") === false);
ok("within: a sibling with the same prefix is outside", L.within("/a/repo", "/a/repo2/x", "darwin") === false && L.within("/a/repo", "/a/repo", "linux") === true);
if (process.platform === "darwin") {
  const upper = path.join(path.dirname(R), path.basename(R).toUpperCase(), "vendor", "proteus");
  ok("homeWritable (macOS): a home inside the root spelled in another case", L.homeWritable(upper, R, COMMON) === true, upper);
}

lib.summary();

// #212 B6: node tests/homewritable.test.js (needs git). A 1.x home agents can write (self-hosted in the project, the
// maintainer's own setup) is never fetched, merged, moved to the plugin, synced or required from by the autostart,
// which runs unsandboxed. The agent side plants a changed lib, an extra hook, agents, a patch module and an
// install.js in the home; one SessionStart of the installed autostart must run, copy and load none of it, and say so
// in one line. Then lib.homeWritable for each writable place. Temp HOME; never the network or the real ~/.claude.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "templates", "hooks");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("homewritable");
const { HOME } = lib;
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
const skipLine = (out, home) => out.split("\n").filter((l) => l.includes("is a place agents can write") && l.includes(home) && l.includes("install.js") && /--update from your own terminal/.test(l));

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
const cases = [];
const SUB = path.join(R, "vendor", "proteus");
fs.mkdirSync(SUB, { recursive: true });
cases.push(["inside the project root", SUB]);
const INCOMMON = path.join(COMMON, "proteus", "home");
fs.mkdirSync(INCOMMON, { recursive: true });
cases.push(["inside <common>", INCOMMON]);
const WT = path.join(W, "work", "proteus-wt");
g(R, "worktree", "add", "-q", "-b", "w1", WT);
cases.push(["a registered worktree outside the root", WT]);
const TMP = path.join(W, "tmp");
fs.mkdirSync(TMP);
const tmpEnv = { TMPDIR: TMP, TMP, TEMP: TMP };
const was = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
Object.assign(process.env, tmpEnv);
const SCRATCH = path.join(L.sandboxScratch(), "home");
for (const [k, v] of Object.entries(was)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
fs.mkdirSync(SCRATCH, { recursive: true });
cases.push(["inside the sandbox scratch root", SCRATCH, tmpEnv]);
const LINK = path.join(W, "home-link");
let linked = false;
try { fs.symlinkSync(SUB, LINK, "dir"); linked = true; } catch {}
if (linked) cases.push(["a link outside the root that resolves inside it", LINK]);
else ok("homeWritable: link case skipped (no symlink here)", true);

for (const [name, home, env] of cases) {
  // the scratch root follows the temp dir, so its lib check runs below under the same one
  if (!env) ok(`homeWritable: ${name}`, L.homeWritable(home, R, COMMON) === true, home);
  setCfg(home);
  const rc = start(env);
  ok(`autostart skips a home ${name}, in one line`, skipLine(rc.out, home).length === 1, rc.out.slice(0, 1200));
}
Object.assign(process.env, tmpEnv);
ok("homeWritable: inside the sandbox scratch root (lib, same temp dir)", L.homeWritable(SCRATCH, R, COMMON) === true);
for (const [k, v] of Object.entries(was)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }

// a release home outside every writable place is not one
const OUT = path.join(W, "release", "proteus");
fs.mkdirSync(OUT, { recursive: true });
ok("homeWritable: a home outside the root, <common>, worktrees and scratch is not", L.homeWritable(OUT, R, COMMON) === false);
setCfg(OUT);
const ro = start();
ok("autostart: a home outside them gets no skip line", !skipLine(ro.out, OUT).length && !/is a place agents can write/.test(ro.out), ro.out.slice(0, 1200));

lib.summary();

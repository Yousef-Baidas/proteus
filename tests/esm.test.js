// ESM repo tests: node tests/esm.test.js (needs git). In a repo whose package.json sets "type": "module",
// Node loads every .js below it as an ES module, and the CommonJS hooks threw on require and failed open (#77).
// install.js --project ships a package.json of {"type": "commonjs"} beside them: the lead's hooks dir,
// teams/ and teams/templates/hooks/, and a worker's worktree. Fake HOME and gh; never the real ~/.claude.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("esm");
lib.fakeCli(lib.BIN, "claude", "process.exit(0);\n");

const INSTALL = path.join(ROOT, "install.js");
const both = (r) => `${r.out}${r.err}`;
const noRef = (r) => r.code !== null && !/ReferenceError|SyntaxError|ERR_REQUIRE_ESM|ES module scope/.test(both(r));
const MSG = path.join(W, "msg");
fs.writeFileSync(MSG, "fix(x): a valid subject\n");

const REPO = path.join(W, "repo");
g(W, "init", "-q", "-b", "main", REPO);
fs.writeFileSync(path.join(REPO, "package.json"), JSON.stringify({ name: "esm-app", type: "module" }) + "\n");
fs.mkdirSync(path.join(REPO, "src"));
fs.writeFileSync(path.join(REPO, "src", "a.js"), "export const a = 1;\n");
g(REPO, "add", "-A"); g(REPO, "commit", "-qm", "init");

// the failure being fixed, so a Node that stops honouring "type" fails this file instead of passing it
const BARE = path.join(W, "bare-hooks");
fs.mkdirSync(BARE);
fs.writeFileSync(path.join(BARE, "package.json"), JSON.stringify({ type: "module" }));
fs.copyFileSync(path.join(ROOT, "templates", "hooks", "commit-msg.js"), path.join(BARE, "commit-msg.js"));
ok("without the marker a hook throws in a \"type\": \"module\" dir", /ReferenceError: require is not defined/.test(lib.run(path.join(BARE, "commit-msg.js"), "", { cwd: BARE, args: [MSG] }).err));

let r = lib.run(INSTALL, "", { cwd: REPO, args: ["--project"] });
ok("--project in a \"type\": \"module\" repo exits 0", r.code === 0, both(r).slice(-1500));
const marker = (...p) => { try { return JSON.parse(fs.readFileSync(path.join(...p, "package.json"), "utf8")).type; } catch { return null; } };
ok("the marker lands in .claude/hooks, teams/ and teams/templates/hooks",
  marker(REPO, ".claude", "hooks") === "commonjs" && marker(REPO, "teams") === "commonjs" && marker(REPO, "teams", "templates", "hooks") === "commonjs");

// no background fetch of the checkout from the autostart runs below
const CFG = path.join(lib.HOME, ".claude", "proteus.json");
fs.writeFileSync(CFG, JSON.stringify({ ...JSON.parse(fs.readFileSync(CFG, "utf8")), autoUpdate: false, lastFetch: Date.now() }));
const autostart = () => lib.run(path.join(REPO, ".claude", "hooks", "proteus-autostart.js"), { hook_event_name: "SessionStart", cwd: REPO, session_id: "s" }, { cwd: REPO });

r = lib.run(path.join(REPO, ".claude", "hooks", "proteus-lead-guard.js"), "{}", { cwd: REPO });
ok("an installed hook runs: proteus-lead-guard.js on {} exits 0", r.code === 0 && noRef(r), both(r));
r = autostart();
ok("an installed hook runs: proteus-autostart.js exits 0", r.code === 0 && noRef(r), both(r).slice(-800));
r = lib.run(path.join(REPO, "teams", "templates", "hooks", "commit-msg.js"), "", { cwd: REPO, args: [MSG] });
ok("the CI gate runs: teams/templates/hooks/commit-msg.js exits 0", r.code === 0 && noRef(r), both(r));
r = lib.run(path.join(REPO, "teams", "link-skills.js"), "", { cwd: REPO });
ok("teams/link-skills.js runs", r.code === 0 && noRef(r), both(r).slice(-800));

const st = g(REPO, "status", "--porcelain", "-uall").split("\n").filter(Boolean);
ok("the lead's marker is excluded from git; teams/'s are not (CI needs them)",
  !st.some((l) => l.endsWith(".claude/hooks/package.json")) && st.some((l) => l.endsWith("teams/package.json")) && st.some((l) => l.endsWith("teams/templates/hooks/package.json")), st.join("\n"));

// an install from before the fix, in a repo that was not ESM yet: the autostart's sync brings the
// marker in and excludes it, so it never shows up for `git add -A`
const EXF = path.join(REPO, ".git", "info", "exclude");
fs.writeFileSync(EXF, fs.readFileSync(EXF, "utf8").split("\n").filter((l) => l !== ".claude/hooks/package.json").join("\n"));
fs.rmSync(path.join(REPO, ".claude", "hooks", "package.json"));
fs.writeFileSync(path.join(REPO, "package.json"), JSON.stringify({ name: "esm-app" }) + "\n");
r = autostart();
g(REPO, "checkout", "--", "package.json");
ok("autostart sync: the marker comes back, excluded from git",
  marker(REPO, ".claude", "hooks") === "commonjs" && fs.readFileSync(EXF, "utf8").split("\n").includes(".claude/hooks/package.json") && !/\.claude\/hooks\/package\.json/.test(g(REPO, "status", "--porcelain", "-uall")), both(r).slice(-800));

// a worker's worktree: its hooks get the marker too, the pre-commit hook runs them, and the copy stays out of git
g(REPO, "add", "-A"); g(REPO, "commit", "-qm", "chore: add proteus");
const WT = path.join(W, "wt");
g(REPO, "worktree", "add", "-q", "-b", "proteus-work/r1/t1", WT);
r = lib.run(path.join(REPO, ".claude", "hooks", "proteus-worktree.js"), "", { cwd: REPO, args: [WT, "src/"] });
ok("proteus-worktree.js runs and copies the marker", r.code === 0 && noRef(r) && marker(WT, ".claude", "hooks") === "commonjs", both(r));
ok("the worktree's marker is excluded from git", g(WT, "status", "--porcelain", "-uall") === "", g(WT, "status", "--porcelain", "-uall"));
fs.writeFileSync(path.join(WT, "src", "b.js"), "export const b = 2;\n");
g(WT, "add", "src/b.js");
let committed = true;
try { g(WT, "commit", "-qm", "feat(src): add b"); } catch (e) { committed = String(e.stderr || e.message); }
ok("a worker commit passes the pre-commit hook's node checks", committed === true, committed);

// --doctor: CI runs a tracked gate; in an ESM repo the marker beside it must be tracked too
const DR = path.join(W, "doc");
g(W, "init", "-q", "-b", "main", DR);
fs.writeFileSync(path.join(DR, "package.json"), JSON.stringify({ type: "module" }) + "\n");
r = lib.run(INSTALL, "", { cwd: DR, args: ["--project"] });
fs.writeFileSync(path.join(DR, "lefthook.yml"), "commit-msg:\n  commands:\n    c:\n      run: node teams/templates/hooks/commit-msg.js {1}\n");
g(DR, "add", "package.json", "lefthook.yml", "teams/templates/hooks/commit-msg.js"); g(DR, "commit", "-qm", "init");
const gate = (out) => (out.match(/^\w+\s+commit-msg gate.*$/m) || [""])[0];
r = lib.run(INSTALL, "", { cwd: DR, args: ["--doctor"] });
ok("doctor: an ESM repo's tracked gate without a tracked marker → FIX", /^FIX\s+commit-msg gate: lefthook\.yml runs teams\/templates\/hooks\/commit-msg\.js as an ES module/.test(gate(r.out)), gate(r.out) || r.out.slice(-1500));
g(DR, "add", "teams/templates/hooks/package.json"); g(DR, "commit", "-qm", "chore: add marker");
r = lib.run(INSTALL, "", { cwd: DR, args: ["--doctor"] });
ok("doctor: the marker tracked → ok", /^ok\s+commit-msg gate runs a tracked file$/.test(gate(r.out)), gate(r.out) || r.out.slice(-1500));
ok("doctor: the lead's marker present → lead hooks ok", /^ok\s+lead hooks registered$/m.test(r.out), r.out.slice(-1500));
fs.rmSync(path.join(DR, ".claude", "hooks", "package.json"));
r = lib.run(INSTALL, "", { cwd: DR, args: ["--doctor"] });
ok("doctor: the lead's marker missing → FIX", /^FIX\s+\.claude\/hooks\/package\.json missing/m.test(r.out), r.out.slice(-1500));

lib.summary();

// The hooks run from a copy outside any repo (a plugin cache, #136) with the session in a temp repo: they find
// the session's repo, the harness, the plugin's skill and $CLAUDE_CONFIG_DIR. node tests/pluginpaths.test.js
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "templates", "hooks");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("pluginpaths");
const HOME = path.join(W, "home"), CFG = path.join(W, "claude-config");

// the plugin: the hooks and the skill under a versioned cache dir, no repo above it
const PLUG = path.join(W, "cache", "proteus", "1.0.0");
const HOOKS = path.join(PLUG, "hooks");
fs.mkdirSync(HOOKS, { recursive: true });
for (const f of fs.readdirSync(SRC)) fs.copyFileSync(path.join(SRC, f), path.join(HOOKS, f));
fs.mkdirSync(path.join(PLUG, "skills", "proteus"), { recursive: true });
fs.writeFileSync(path.join(PLUG, "skills", "proteus", "SKILL.md"), "---\nname: proteus\n---\nPLUGIN SKILL BODY\n");

// the session's repo, with an inbox cache: 1 question, 2 reviews
const REPO = path.join(W, "repo"), SUB = path.join(REPO, "sub");
fs.mkdirSync(SUB, { recursive: true });
g(REPO, "init", "-q");
g(REPO, "commit", "-q", "--allow-empty", "-m", "init");
const inbox = { at: new Date().toISOString(), questions: [{ n: 1, title: "q" }], reviews: [{ n: 2, title: "r" }, { n: 3, title: "s" }] };
fs.mkdirSync(path.join(REPO, ".git", "proteus"), { recursive: true });
fs.writeFileSync(path.join(REPO, ".git", "proteus", "inbox.json"), JSON.stringify(inbox));

// the config dir: the user's status line and an update waiting; ~/.claude says otherwise and must not be read
const json = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); };
json(path.join(CFG, "settings.json"), { statusLine: { type: "command", command: "echo mine" }, enabledPlugins: { "context-mode@context-mode": true } });
json(path.join(CFG, "proteus.json"), { behind: 1 });
json(path.join(CFG, "plugins", "installed_plugins.json"), { plugins: { "context-mode@context-mode": [{ version: "1" }] } });
json(path.join(HOME, ".claude", "settings.json"), { statusLine: { type: "command", command: "echo wrong" } });
json(path.join(HOME, ".claude", "proteus.json"), { behind: 0 });

const none = { CLAUDE_PROJECT_DIR: undefined };
const run = (script, input, cwd, env = {}, args = []) => lib.run(path.join(HOOKS, script), input, { cwd, args, env: { CLAUDE_CONFIG_DIR: CFG, ...env } });

// ---- harness: explicit env first in the plugin cache, the install folder first in a repo
const probe = path.join(W, "probe.js");
fs.writeFileSync(probe, `"use strict";\nconst h = require(process.argv[2]);\nconsole.log(JSON.stringify({ name: h.name, home: h.home, skillDirs: h.skillDirs(process.argv[3]), ctx: h.contextModeOn() }));\n`);
const harness = (dir, env) => { const r = lib.run(probe, "", { cwd: W, args: [path.join(dir, "proteus-harness.js"), REPO], env: { CLAUDE_CONFIG_DIR: CFG, ...none, ...env } }); try { return JSON.parse(r.out); } catch { return { err: r.out + r.err }; } };
let h = harness(HOOKS, { CLAUDE_PROJECT_DIR: REPO, CLAUDE_PLUGIN_ROOT: PLUG });
ok("harness: a plugin hook under Claude Code (CLAUDE_PROJECT_DIR) is claude", h.name === "claude", JSON.stringify(h));
h = harness(HOOKS, { CLAUDE_PLUGIN_ROOT: PLUG });
ok("harness: a plugin hook with CLAUDE_PLUGIN_ROOT alone (Codex's plugin env) is codex", h.name === "codex", JSON.stringify(h));
h = harness(HOOKS, {});
ok("harness: no signal at all is claude", h.name === "claude", JSON.stringify(h));
h = harness(HOOKS, { CLAUDE_PROJECT_DIR: REPO, PROTEUS_HARNESS: "codex" });
ok("harness: PROTEUS_HARNESS names it over the env", h.name === "codex", JSON.stringify(h));
const CXH = path.join(W, "cx", ".codex", "hooks");
fs.mkdirSync(CXH, { recursive: true });
for (const f of fs.readdirSync(SRC)) fs.copyFileSync(path.join(SRC, f), path.join(CXH, f));
h = harness(CXH, { CLAUDE_PROJECT_DIR: REPO });
ok("harness: hooks installed in <root>/.codex/hooks stay codex even with CLAUDE_PROJECT_DIR inherited", h.name === "codex", JSON.stringify(h));

// ---- skill and config dir from the adapter
h = harness(HOOKS, { CLAUDE_PROJECT_DIR: REPO, CLAUDE_PLUGIN_ROOT: PLUG });
ok("config: the Claude adapter's home is $CLAUDE_CONFIG_DIR", h.home === path.resolve(CFG), JSON.stringify(h));
ok("config: context-mode is read from $CLAUDE_CONFIG_DIR", h.ctx === true, JSON.stringify(h));
ok("skill: skillDirs ends with $CLAUDE_PLUGIN_ROOT/skills/proteus", Array.isArray(h.skillDirs) && h.skillDirs.at(-1) === path.join(PLUG, "skills", "proteus"), JSON.stringify(h));
h = harness(HOOKS, { CLAUDE_PROJECT_DIR: REPO, CLAUDE_CONFIG_DIR: undefined });
ok("config: without CLAUDE_CONFIG_DIR it is ~/.claude, and no plugin dir is searched", h.home === path.join(HOME, ".claude") && h.skillDirs.length === 2 && !h.ctx, JSON.stringify(h));

// ---- the autostart finds the plugin's skill and reads the config dir
const start = (cwd, env) => run("proteus-autostart.js", { hook_event_name: "SessionStart", source: "startup", session_id: "s1", cwd }, cwd, env);
let r = start(SUB, { CLAUDE_PROJECT_DIR: REPO, CLAUDE_PLUGIN_ROOT: PLUG });
ok("autostart: the plugin's skill is loaded in the session's repo", r.code === 0 && /PLUGIN SKILL BODY/.test(r.out) && r.out.includes(path.join(PLUG, "skills", "proteus")), r.out + r.err);
ok("autostart: context-mode found in $CLAUDE_CONFIG_DIR", !/context-mode=missing/.test(r.out), r.out);
r = start(SUB, { CLAUDE_PROJECT_DIR: REPO });
ok("autostart: without CLAUDE_PLUGIN_ROOT there is no skill to load", r.code === 0 && !/PLUGIN SKILL BODY/.test(r.out), r.out + r.err);

// ---- repo root: the session's, never the plugin's folder
r = run("proteus-inbox.js", "", SUB, { ...none, CLAUDE_PLUGIN_ROOT: PLUG }, ["--count"]);
ok("inbox: run from a subdir of the session's repo it reads that repo's cache", r.out.trim() === "1 2", r.out + r.err);
r = run("proteus-inbox.js", "", W, { CLAUDE_PROJECT_DIR: REPO, CLAUDE_PLUGIN_ROOT: PLUG }, ["--count"]);
ok("inbox: CLAUDE_PROJECT_DIR names the repo when the cwd is outside it", r.out.trim() === "1 2", r.out + r.err);
r = run("proteus-inbox.js", "", W, { ...none, CLAUDE_PLUGIN_ROOT: PLUG }, ["--count"]); // the plugin's env: a hook outside its main checkout runs only from there (#234)
ok("inbox: outside any repo it prints nothing", r.code === 0 && r.out.trim() === "", r.out + r.err);
// a home kept in git (dotfiles): the plugin cache sits inside a repo that is not the session's
const DOT = path.join(W, "dotfiles"), DOTH = path.join(DOT, ".claude", "plugins", "cache", "proteus", "1.0.0", "hooks");
fs.mkdirSync(DOTH, { recursive: true });
g(DOT, "init", "-q");
for (const f of fs.readdirSync(SRC)) fs.copyFileSync(path.join(SRC, f), path.join(DOTH, f));
r = lib.run(path.join(DOTH, "proteus-inbox.js"), "", { cwd: SUB, args: ["--count"], env: { ...none, CLAUDE_PLUGIN_ROOT: path.dirname(DOTH) } });
ok("inbox: a plugin cache inside another repo still reads the session's repo", r.out.trim() === "1 2", r.out + r.err);
r = lib.run(path.join(DOTH, "proteus-statusline.js"), { cwd: SUB }, { cwd: SUB, env: { ...none, CLAUDE_CONFIG_DIR: CFG } });
ok("statusline: a plugin cache inside another repo shows the session repo's inbox", r.out.includes("1 question · 2 reviews"), r.out + r.err);

r = run("proteus-statusline.js", { workspace: { project_dir: REPO }, cwd: REPO }, W, none);
ok("statusline: the user's line and the update flag from $CLAUDE_CONFIG_DIR, the inbox of the session's repo",
  r.out.trim() === "mine · proteus: 1 question · 2 reviews · proteus: update ready (install.js --update)", r.out + r.err);

r = run("proteus-statusline.js", { workspace: { project_dir: REPO }, cwd: REPO, padding: "x".repeat(1 << 20) }, W, none);
ok("statusline: a user's command that leaves its stdin unread still shows", r.out.startsWith("mine · "), r.out + r.err);

// worktree: commit-msg.js missing beside the script (as on Codex) comes from the lead's teams/templates/hooks
const BARE = path.join(W, "cache2", "proteus", "1.0.0", "hooks");
fs.mkdirSync(BARE, { recursive: true });
for (const f of fs.readdirSync(SRC)) if (f !== "commit-msg.js") fs.copyFileSync(path.join(SRC, f), path.join(BARE, f));
const TT = path.join(REPO, "teams", "templates", "hooks");
fs.mkdirSync(TT, { recursive: true });
fs.copyFileSync(path.join(SRC, "commit-msg.js"), path.join(TT, "commit-msg.js"));
g(REPO, "worktree", "add", "-q", path.join(REPO, ".worktrees", "w1"), "-b", "w1");
r = lib.run(path.join(BARE, "proteus-worktree.js"), "", { cwd: W, args: [path.join(REPO, ".worktrees", "w1"), "src/**"], env: { ...none, PROTEUS_HARNESS: "claude", CLAUDE_PROJECT_DIR: REPO, CLAUDE_PLUGIN_ROOT: path.dirname(BARE) } });
let msg = "";
try { msg = fs.readFileSync(path.join(REPO, ".git", "worktrees", "w1", "proteus-hooks", "commit-msg"), "utf8"); } catch {}
ok("worktree: the commit-msg hook runs the lead repo's teams/templates/hooks/commit-msg.js", r.code === 0 && msg.replace(/\\/g, "/").includes(path.join(TT, "commit-msg.js").replace(/\\/g, "/")), r.out + r.err + msg);

// ---- install.js writes proteus.json in $CLAUDE_CONFIG_DIR
const CFG2 = path.join(W, "claude-config-2");
r = lib.run(path.join(ROOT, "install.js"), "", { cwd: W, args: ["--tour-done"], env: { ...none, CLAUDE_CONFIG_DIR: CFG2 } });
let cfg = null;
try { cfg = JSON.parse(fs.readFileSync(path.join(CFG2, "proteus.json"), "utf8")); } catch {}
ok("install.js: --tour-done records in $CLAUDE_CONFIG_DIR/proteus.json, not ~/.claude", r.code === 0 && cfg && typeof cfg.toured === "string" && !("toured" in JSON.parse(fs.readFileSync(path.join(HOME, ".claude", "proteus.json"), "utf8"))), r.out + r.err);

lib.summary();

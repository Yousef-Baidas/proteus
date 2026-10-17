// The names the hooks print (#136): node tests/pluginnames.test.js (needs git). From a plugin root the skill is
// /proteus:proteus and the agents proteus:<agent> (agent-prefix=proteus: in proteus-state, no patched bare copies);
// installed by install.js it is /proteus with bare agents; on Codex $proteus with bare agents. Temp dirs; no network.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "templates", "hooks");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("pluginnames");
const copy = (dir) => { fs.mkdirSync(dir, { recursive: true }); for (const f of fs.readdirSync(SRC)) fs.copyFileSync(path.join(SRC, f), path.join(dir, f)); return dir; };
const skill = (dir) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: proteus\n---\nSKILL BODY\n"); };

// a fake Proteus checkout (proteus.json's home): one shipped agent and the patch module; fetched just now
const HX = path.join(W, "checkout");
fs.mkdirSync(path.join(HX, "agents"), { recursive: true });
fs.writeFileSync(path.join(HX, "agents", "proteus-guide.md"), "---\nname: proteus-guide\ndescription: g\ntools: Read\n---\nGuide.\n");
copy(path.join(HX, "templates", "hooks"));
fs.writeFileSync(path.join(lib.HOME, ".claude", "proteus.json"), JSON.stringify({ home: HX, lastFetch: Date.now(), toured: "x" }));

// three repos: the plugin's (hooks in the plugin cache), the installer's (.claude/hooks), Codex's (.codex/hooks)
const repo = (name) => {
  const d = path.join(W, name);
  g(W, "init", "-q", d);
  g(d, "commit", "-q", "--allow-empty", "-m", "init");
  fs.mkdirSync(path.join(d, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(d, ".claude", "proteus-agents.json"), JSON.stringify({ "proteus-guide": { append: "Patched." } }));
  return d;
};
const PR = repo("plug"), IR = repo("inst"), CR = repo("codex");
const PLUG = path.join(W, "cache", "proteus", "2.0.0");
const PH = copy(path.join(PLUG, "templates", "hooks"));
skill(path.join(PLUG, "skills", "proteus"));
const IH = copy(path.join(IR, ".claude", "hooks"));
skill(path.join(IR, ".claude", "skills", "proteus"));
const CH = copy(path.join(CR, ".codex", "hooks"));
skill(path.join(CR, ".agents", "skills", "proteus"));

const none = { CLAUDE_PROJECT_DIR: undefined, CLAUDE_PLUGIN_ROOT: undefined, PROTEUS_HARNESS: undefined };
const probe = path.join(W, "probe.js");
fs.writeFileSync(probe, `"use strict";\nconst l = require(process.argv[2]);\nconsole.log(JSON.stringify({ cmd: l.skillCommand(), review: l.skillCommand("proteus-review"), prefix: l.agentPrefix() }));\n`);
const names = (hooks, env) => { const r = lib.run(probe, "", { cwd: W, args: [path.join(hooks, "proteus-lib.js")], env: { ...none, ...env } }); try { return JSON.parse(r.out); } catch { return { err: r.out + r.err }; } };
const is = (n, cmd, review, prefix) => n.cmd === cmd && n.review === review && n.prefix === prefix;

// ---- the helpers in each mode
let n = names(PH, { CLAUDE_PROJECT_DIR: PR, CLAUDE_PLUGIN_ROOT: PLUG });
ok("plugin: /proteus:proteus, /proteus:proteus-review, prefix proteus:", is(n, "/proteus:proteus", "/proteus:proteus-review", "proteus:"), JSON.stringify(n));
n = names(PH, { CLAUDE_PROJECT_DIR: PR, CLAUDE_PLUGIN_ROOT: path.join(PLUG, "templates", "..") + path.sep });
ok("plugin: a plugin root spelled unnormalized still counts", is(n, "/proteus:proteus", "/proteus:proteus-review", "proteus:"), JSON.stringify(n));
let linked = false;
try { fs.symlinkSync(PLUG, path.join(W, "plug-link"), process.platform === "win32" ? "junction" : "dir"); linked = true; } catch {}
if (linked) {
  n = names(PH, { CLAUDE_PROJECT_DIR: PR, CLAUDE_PLUGIN_ROOT: path.join(W, "plug-link") });
  ok("plugin: a plugin root reached through a link is resolved", is(n, "/proteus:proteus", "/proteus:proteus-review", "proteus:"), JSON.stringify(n));
}
n = names(IH, { CLAUDE_PROJECT_DIR: IR });
ok("installer: /proteus, /proteus-review, no prefix", is(n, "/proteus", "/proteus-review", ""), JSON.stringify(n));
n = names(IH, { CLAUDE_PROJECT_DIR: IR, CLAUDE_PLUGIN_ROOT: PLUG });
ok("installer: another plugin's CLAUDE_PLUGIN_ROOT in the env does not make it a plugin", is(n, "/proteus", "/proteus-review", ""), JSON.stringify(n));
n = names(PH, { CLAUDE_PROJECT_DIR: PR, CLAUDE_PLUGIN_ROOT: path.join(PLUG, "templates", "hooks", "x") });
ok("installer: a plugin root below the hooks is not theirs", is(n, "/proteus", "/proteus-review", ""), JSON.stringify(n));
n = names(CH, { CLAUDE_PROJECT_DIR: CR });
ok("codex: $proteus, $proteus-review, no prefix", is(n, "$proteus", "$proteus-review", ""), JSON.stringify(n));
n = names(PH, { CLAUDE_PLUGIN_ROOT: PLUG });
ok("codex: from Codex's plugin env too: $proteus and bare agents", is(n, "$proteus", "$proteus-review", ""), JSON.stringify(n));

// ---- the autostart's text, state line and agent patches
const start = (hooks, cwd, env) => lib.run(path.join(hooks, "proteus-autostart.js"), { hook_event_name: "SessionStart", source: "startup", session_id: "s1", cwd }, { cwd, env: { ...none, ...env } });
const guide = (d, ext) => fs.existsSync(path.join(d, ext === "toml" ? ".codex" : ".claude", "agents", `proteus-guide.${ext || "md"}`));
let r = start(PH, PR, { CLAUDE_PROJECT_DIR: PR, CLAUDE_PLUGIN_ROOT: PLUG });
ok("autostart plugin: names /proteus:proteus and /proteus:proteus-review", r.code === 0 && r.out.includes("had typed /proteus:proteus;") && r.out.includes("message is /proteus:proteus-review,"), r.out + r.err);
ok("autostart plugin: agent-prefix=proteus: in proteus-state", /proteus-state [^\n]* agent-prefix=proteus:(\s|\\n|")/.test(r.out), r.out);
ok("autostart plugin: no bare-named patched agent, and a note says the patch is not applied", !guide(PR) && r.out.includes(".claude/proteus-agents.json is not applied under the plugin"), r.out + r.err);
r = start(IH, IR, { CLAUDE_PROJECT_DIR: IR });
ok("autostart installer: /proteus and /proteus-review", r.code === 0 && r.out.includes("had typed /proteus;") && r.out.includes("message is /proteus-review,"), r.out + r.err);
ok("autostart installer: no agent-prefix, the patch is applied", !r.out.includes("agent-prefix=") && guide(IR) && !r.out.includes("not applied under the plugin"), r.out + r.err);
r = start(CH, CR, { CLAUDE_PROJECT_DIR: CR });
ok("autostart codex: $proteus and $proteus-review, no agent-prefix", r.code === 0 && r.out.includes("had typed $proteus;") && r.out.includes("message is $proteus-review,") && !r.out.includes("agent-prefix="), r.out + r.err);

lib.summary();

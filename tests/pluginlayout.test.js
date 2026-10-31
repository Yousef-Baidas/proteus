// The repo root as a Claude Code plugin (#136, D1): .claude-plugin/plugin.json and marketplace.json in the shapes the
// plugin reference documents, hooks/hooks.json the same hooks install.js registers (the Claude adapter's LEAD_HOOKS)
// run through proteus-plugin.js, and the guards protecting the plugin's folder like .claude/hooks.
// node tests/pluginlayout.test.js; exit 0 if every assertion passed, 1 otherwise.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "templates", "hooks");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("pluginlayout");
const ad = require(path.join(SRC, "proteus-harness-claude.js"));
const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8")); } catch (e) { return { error: e.message }; } };
const isObj = (o) => !!o && typeof o === "object" && !Array.isArray(o);
const isStr = (s) => typeof s === "string" && s.length > 0;
const inRoot = (p) => isStr(p) && p.startsWith("./") && !p.split("/").includes("..") && fs.existsSync(path.join(ROOT, p));

// ---- hooks/hooks.json: generated from LEAD_HOOKS, never edited by hand
const hooksFile = fs.readFileSync(path.join(ROOT, "hooks", "hooks.json"), "utf8");
ok("hooks.json: matches the adapter's LEAD_HOOKS (regenerate with node scripts/plugin-hooks.js)", hooksFile === JSON.stringify(ad.pluginHooks(), null, 2) + "\n");
const hooks = read("hooks/hooks.json");
const rows = [];
for (const [ev, list] of Object.entries(hooks.hooks || {})) {
  for (const e of list) for (const h of e.hooks || []) {
    const m = /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/templates\/hooks\/proteus-plugin\.js" (\S+)$/.exec(h.command || "");
    rows.push([ev, m ? m[1] : `bad command: ${h.command}`, e.matcher, h.timeout]);
  }
}
const want = ad.LEAD_HOOKS.map(([ev, s, m, t]) => [ev, s, m, t]);
const key = (r) => JSON.stringify(r);
ok("hooks.json: every lead hook with the installer's event, matcher and timeout, and nothing else",
  rows.length === want.length && want.every((r) => rows.some((x) => key(x) === key(r))), JSON.stringify(rows));
ok("hooks.json: every script it names exists beside proteus-plugin.js", rows.every(([, s]) => fs.existsSync(path.join(SRC, s))));
// the documented hooks-file shape: a top-level "hooks" event map of [{matcher?, hooks: [{type, command, timeout?}]}]
const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "SubagentStop", "TeammateIdle", "Stop", "Notification", "PreCompact", "SessionEnd"];
ok("hooks.json: the documented shape", isObj(hooks.hooks) && Object.keys(hooks).length === 1 && Object.entries(hooks.hooks).every(([ev, list]) => EVENTS.includes(ev) && Array.isArray(list)
  && list.every((e) => isObj(e) && (e.matcher === undefined || isStr(e.matcher)) && Array.isArray(e.hooks) && e.hooks.length
    && e.hooks.every((h) => h.type === "command" && isStr(h.command) && (h.timeout === undefined || (Number.isInteger(h.timeout) && h.timeout > 0))))), hooksFile.slice(0, 300));

// ---- plugin.json and marketplace.json, against the documented fields
const P = read(".claude-plugin/plugin.json");
const PLUGIN_KEYS = ["$schema", "name", "displayName", "version", "description", "author", "homepage", "repository", "license", "keywords", "skills", "agents", "hooks"];
ok("plugin.json: name proteus, only documented keys", P.name === "proteus" && Object.keys(P).every((k) => PLUGIN_KEYS.includes(k)), JSON.stringify(P));
ok("plugin.json: author has a name, homepage parses", isObj(P.author) && isStr(P.author.name) && (!P.homepage || !!new URL(P.homepage)));
ok("plugin.json: skills is the repo's skills/ dir", P.skills === "./skills/" && inRoot(P.skills));
ok("plugin.json: hooks is hooks/hooks.json", P.hooks === "./hooks/hooks.json" && inRoot(P.hooks));
// agents takes .md files, never a dir, and replaces the default scan: it lists every agent the repo ships
const shipped = fs.readdirSync(path.join(ROOT, "agents")).filter((f) => f.endsWith(".md")).sort().map((f) => `./agents/${f}`);
ok("plugin.json: agents lists every agents/*.md, each a file in the plugin", Array.isArray(P.agents) && key([...P.agents].sort()) === key(shipped) && P.agents.every(inRoot), JSON.stringify(P.agents));
const M = read(".claude-plugin/marketplace.json");
// the second entry is the optional run panel mod (#311), checked in tests/panel.test.js
const entry = Array.isArray(M.plugins) && M.plugins.length === 2 ? M.plugins[0] : {};
ok("marketplace.json: marketplace proteus with an owner", M.name === "proteus" && isObj(M.owner) && isStr(M.owner.name), JSON.stringify(M));
ok("marketplace.json: proteus first, sourced from the repo root, then the panel mod", entry.name === "proteus" && entry.source === "./" && M.plugins[1].name === "proteus-panel", JSON.stringify(M.plugins));
ok("layout: no plugin/ copy of the repo", !fs.existsSync(path.join(ROOT, "plugin")));

// ---- proteus-plugin.js runs the named hook in-process, as node would
const PLUG = path.join(W, "cache", "proteus", "1.0.0");
fs.mkdirSync(path.join(PLUG, "templates", "hooks"), { recursive: true });
for (const f of fs.readdirSync(SRC)) fs.copyFileSync(path.join(SRC, f), path.join(PLUG, "templates", "hooks", f));
const H = path.join(PLUG, "templates", "hooks");
fs.writeFileSync(path.join(H, "proteus-echo.js"), `"use strict";\nlet s = "";\nprocess.stdin.on("data", (d) => (s += d)).on("end", () => { console.log(JSON.stringify({ argv: process.argv.slice(1), main: require.main === module, s })); process.exitCode = 2; });\n`);
const REPO = path.join(W, "repo");
fs.mkdirSync(REPO);
g(REPO, "init", "-q");
// gated in (tests/plugingate.test.js covers the gate)
fs.mkdirSync(path.join(REPO, ".claude"));
fs.writeFileSync(path.join(REPO, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "proteus@proteus": true } }));
const entryRun = (args, input = "", env = {}) => lib.run(path.join(H, "proteus-plugin.js"), input, { cwd: REPO, args, env: { CLAUDE_PLUGIN_ROOT: PLUG, ...env } });
let r = entryRun(["proteus-echo.js"], "IN");
let o = {};
try { o = JSON.parse(r.out); } catch {}
ok("entry: the hook gets stdin, argv [itself] and its own exit code", r.code === 2 && o.s === "IN" && key(o.argv) === key([path.join(H, "proteus-echo.js")]), r.out + r.err);
for (const bad of ["../../x.js", "proteus-plugin.js", "proteus-nope.js", "commit-msg.js", ""]) {
  r = entryRun(bad ? [bad] : []);
  ok(`entry: ${bad || "no name"} runs nothing and exits 0 silently`, r.code === 0 && !r.out && !r.err, r.out + r.err);
}
// shell-check runs its hook when started through the entry, not only as node's main module
r = entryRun(["proteus-shell-check.js", "--help"]);
ok("entry: proteus-shell-check.js runs as main through the entry", r.code === 0 && /proteus-shell-check/.test(r.out + r.err), r.out + r.err);

// ---- the guards protect the plugin's folder
const probe = path.join(W, "probe.js");
fs.writeFileSync(probe, `"use strict";
const lib = require(process.argv[2]);
const ev = { root: process.argv[3], agent: "a1", tool: "shell" };
const out = {};
for (const p of process.argv.slice(4)) out[p] = [lib.guardedWrite(p, ev), lib.guardedParent(p, ev)];
out.deny = lib.agentShellDenial({ ...ev, command: "rm -rf " + JSON.stringify(process.argv[4]), cwd: process.argv[3] });
console.log(JSON.stringify(out));
`);
const guard = (pluginRoot, root, paths) => {
  const res = lib.run(probe, "", { cwd: root, args: [path.join(H, "proteus-lib.js"), root, ...paths], env: { CLAUDE_PLUGIN_ROOT: pluginRoot } });
  try { return JSON.parse(res.out); } catch { return { err: res.out + res.err }; }
};
const hookFile = path.join(H, "proteus-lead-guard.js");
let gd = guard(PLUG, REPO, [hookFile, PLUG, path.join(REPO, "src.js")]);
ok("guard: a write into the plugin's hooks is refused", gd[hookFile] && gd[hookFile][0] === "$CLAUDE_PLUGIN_ROOT/templates/hooks/proteus-lead-guard.js", JSON.stringify(gd));
ok("guard: the plugin root itself holds a guarded dir", gd[PLUG] && (gd[PLUG][0] === "$CLAUDE_PLUGIN_ROOT" || gd[PLUG][1] === "."), JSON.stringify(gd));
ok("guard: a subagent's rm -rf of a plugin hook is denied", isStr(gd.deny), JSON.stringify(gd));
ok("guard: the session repo's own files stay writable", gd[path.join(REPO, "src.js")] && key(gd[path.join(REPO, "src.js")]) === key(["", ""]), JSON.stringify(gd));
const parent = path.dirname(PLUG);
gd = guard(PLUG, REPO, [parent]);
ok("guard: a dir holding the plugin is a guarded parent", gd[parent] && gd[parent][1] === "1.0.0", JSON.stringify(gd));
gd = guard("", REPO, [hookFile]);
ok("guard: without CLAUDE_PLUGIN_ROOT that folder is not special", gd[hookFile] && gd[hookFile][0] === "", JSON.stringify(gd));
// a plugin run from the session repo's own checkout (a local marketplace reads it in place): its source stays editable
const SELF = path.join(W, "self");
fs.mkdirSync(path.join(SELF, "templates", "hooks"), { recursive: true });
g(SELF, "init", "-q");
const selfHook = path.join(SELF, "templates", "hooks", "proteus-lib.js");
gd = guard(SELF, SELF, [selfHook]);
ok("guard: a plugin root inside the session's own repo is not guarded as a plugin", gd[selfHook] && gd[selfHook][0] === "", JSON.stringify(gd));

// shell-check's fingerprint walks the plugin's folder, less a clone's .git
fs.mkdirSync(path.join(PLUG, ".git"), { recursive: true });
fs.writeFileSync(path.join(PLUG, ".git", "HEAD"), "x");
const fp = path.join(W, "fp.js");
fs.writeFileSync(fp, `"use strict";\nconst sc = require(process.argv[2]);\nconst f = sc.fingerprint(process.argv[3]);\nconsole.log(JSON.stringify(Object.keys(f.entries)));\n`);
r = lib.run(fp, "", { cwd: REPO, args: [path.join(H, "proteus-shell-check.js"), path.join(REPO, ".git")], env: { CLAUDE_PLUGIN_ROOT: PLUG } });
let keys = [];
try { keys = JSON.parse(r.out); } catch {}
const real = fs.realpathSync(PLUG);
ok("shell-check: the fingerprint covers the plugin's hooks", keys.includes(path.join(real, "templates", "hooks", "proteus-lead-guard.js")), r.out.slice(0, 300) + r.err);
ok("shell-check: and skips the plugin clone's .git", !keys.some((k) => k.startsWith(path.join(real, ".git"))), r.err);

lib.summary();

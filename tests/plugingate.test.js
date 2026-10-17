// The plugin's per-repo gate (#136, D2; #154): proteus-plugin.js runs a hook only where the project's git root sets
// enabledPlugins["proteus@proteus"] === true in .claude/settings.local.json or settings.json, local winning when both
// set it; anywhere else no output and no state. --doctor's gate row applies the same rule.
// node tests/plugingate.test.js; exit 0 if every assertion passed, 1 otherwise.
"use strict";
const fs = require("fs");
const path = require("path");

const SRC = path.resolve(__dirname, "..", "templates", "hooks");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("plugingate");
const PLUG = path.join(W, "cache", "proteus", "1.0.0");
const H = path.join(PLUG, "templates", "hooks");
fs.mkdirSync(H, { recursive: true });
for (const f of fs.readdirSync(SRC)) fs.copyFileSync(path.join(SRC, f), path.join(H, f));
// the skills too: the autostart loads the lead skill from the plugin
fs.cpSync(path.resolve(__dirname, "..", "skills"), path.join(PLUG, "skills"), { recursive: true });
const ENTRY = path.join(H, "proteus-plugin.js");
// a stand-in hook that only says it ran: some real hooks stay quiet with no CLAUDE_PROJECT_DIR or in a worktree
fs.writeFileSync(path.join(H, "proteus-echo.js"), `"use strict";\nlet s = "";\nprocess.stdin.on("data", (d) => (s += d)).on("end", () => console.log("ran " + s.length));\n`);

const repo = (name, settings) => {
  const d = path.join(W, name);
  fs.mkdirSync(d, { recursive: true });
  g(d, "init", "-q");
  if (settings !== undefined) {
    fs.mkdirSync(path.join(d, ".claude"));
    fs.writeFileSync(path.join(d, ".claude", "settings.json"), typeof settings === "string" ? settings : JSON.stringify(settings));
  }
  return d;
};
// every file under W with its size and mtime: a gated-out hook must leave it as it was
const snap = () => {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { const s = fs.statSync(p); out.push(`${p} ${s.size} ${s.mtimeMs}`); } } };
  walk(W);
  return out.sort().join("\n");
};
const PROMPT = { hook_event_name: "UserPromptSubmit", prompt: "hello", session_id: "s1" };
const START = { hook_event_name: "SessionStart", source: "startup", session_id: "s1" };
// the journal (state under .git/proteus), the autostart (output) and the stand-in through the entry, from cwd
const hooks = (cwd, env = {}) => [
  lib.run(ENTRY, { ...PROMPT, cwd }, { cwd, args: ["proteus-journal.js"], env: { CLAUDE_PLUGIN_ROOT: PLUG, ...env } }),
  lib.run(ENTRY, { ...START, cwd }, { cwd, args: ["proteus-autostart.js"], env: { CLAUDE_PLUGIN_ROOT: PLUG, ...env } }),
  lib.run(ENTRY, "IN", { cwd, args: ["proteus-echo.js"], env: { CLAUDE_PLUGIN_ROOT: PLUG, ...env } }),
];
const echoed = (rs) => rs.every((r) => r.code === 0) && rs[2].out === "ran 2\n";
const ran = (rs, dir) => echoed(rs) && /proteus autostart/.test(rs[1].out) && fs.existsSync(path.join(dir, ".git", "proteus", "journal.jsonl"));
const silent = (name, cwd, env) => {
  const before = snap();
  const rs = hooks(cwd, env);
  ok(`${name}: exits 0 with no output`, rs.every((r) => r.code === 0 && !r.out && !r.err), rs.map((r) => r.out + r.err).join(" | "));
  ok(`${name}: writes no state`, snap() === before);
};

// gated in
const ON = repo("on", { enabledPlugins: { "proteus@proteus": true, "other@x": false } });
let rs = hooks(ON);
ok("gated in: the hooks run and keep their state", ran(rs, ON), rs.map((r) => r.code + " " + r.out.slice(0, 60) + r.err.slice(0, 200)).join(" | "));
const SUB = repo("on-sub", { enabledPlugins: { "proteus@proteus": true } });
fs.mkdirSync(path.join(SUB, "a", "b"), { recursive: true });
ok("gated in: from a subdir, the git root's settings count", ran(hooks(path.join(SUB, "a", "b")), SUB));
// a linked worktree (.git is a file) carries the repo's checked-in settings
const MAIN = repo("main", { enabledPlugins: { "proteus@proteus": true } });
g(MAIN, "add", ".claude");
g(MAIN, "commit", "-qm", "init");
const WT = path.join(W, "main-wt");
g(MAIN, "worktree", "add", "-q", WT);
ok("gated in: a linked worktree", echoed(hooks(WT)));

// gated out
silent("gated out: no settings.json", repo("bare"));
silent("gated out: settings without the plugin", repo("noplug", { enabledPlugins: { "other@x": true } }));
silent("gated out: plugin disabled", repo("off", { enabledPlugins: { "proteus@proteus": false } }));
silent("gated out: enabled as a string, not true", repo("str", { enabledPlugins: { "proteus@proteus": "true" } }));
// settings.local.json (claude plugin install --scope local writes there) counts too, and wins when both set the key
const withLocal = (name, shared, local) => {
  const d = repo(name, shared);
  fs.mkdirSync(path.join(d, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(d, ".claude", "settings.local.json"), typeof local === "string" ? local : JSON.stringify(local));
  return d;
};
const LOCAL = withLocal("local", undefined, { enabledPlugins: { "proteus@proteus": true } });
ok("gated in: enabled only in settings.local.json (a local-scope install)", ran(hooks(LOCAL), LOCAL));
const LOCAL_ON = withLocal("local-on", { enabledPlugins: { "proteus@proteus": false } }, { enabledPlugins: { "proteus@proteus": true } });
ok("gated in: settings.local.json true wins over settings.json false", ran(hooks(LOCAL_ON), LOCAL_ON));
const LOCAL_NOKEY = withLocal("local-nokey", { enabledPlugins: { "proteus@proteus": true } }, { enabledPlugins: { "other@x": true } });
ok("gated in: a settings.local.json without the key leaves settings.json's true", ran(hooks(LOCAL_NOKEY), LOCAL_NOKEY));
const LOCAL_BAD = withLocal("local-bad", { enabledPlugins: { "proteus@proteus": true } }, "{ nope");
ok("gated in: a malformed settings.local.json leaves settings.json's true", ran(hooks(LOCAL_BAD), LOCAL_BAD));
silent("gated out: settings.local.json false wins over settings.json true", withLocal("local-off", { enabledPlugins: { "proteus@proteus": true } }, { enabledPlugins: { "proteus@proteus": false } }));
// a nested repo answers for itself, not the enabled repo around it
silent("gated out: a repo nested in an enabled one", repo(path.join("on", "nested")));
silent("malformed settings.json", repo("bad", "{ enabledPlugins: "));
silent("settings.json is null", repo("null", "null"));
const NOGIT = path.join(W, "nogit");
fs.mkdirSync(path.join(NOGIT, ".claude"), { recursive: true });
fs.writeFileSync(path.join(NOGIT, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "proteus@proteus": true } }));
silent("no git repo, even with the settings", NOGIT);

// CLAUDE_PROJECT_DIR: it decides when set; unset, the cwd does
const OFF = path.join(W, "off");
silent("CLAUDE_PROJECT_DIR gated out, cwd gated in", ON, { CLAUDE_PROJECT_DIR: OFF });
const ON2 = repo("on2", { enabledPlugins: { "proteus@proteus": true } });
ok("CLAUDE_PROJECT_DIR unset: the cwd's repo, gated in", echoed(hooks(ON2, { CLAUDE_PROJECT_DIR: undefined })));
silent("CLAUDE_PROJECT_DIR unset: the cwd's repo, gated out", OFF, { CLAUDE_PROJECT_DIR: undefined });
silent("CLAUDE_PROJECT_DIR empty: the cwd's repo, gated out", OFF, { CLAUDE_PROJECT_DIR: "" });

// gated out never reads stdin: a hook's input pipe left unread, the entry still exits at once
const big = "x".repeat(1 << 20);
const t = Date.now();
const r = lib.run(ENTRY, big, { cwd: OFF, args: ["proteus-journal.js"], env: { CLAUDE_PLUGIN_ROOT: PLUG } });
ok("gated out: exits without reading a large stdin", r.code === 0 && !r.out && Date.now() - t < 10000, r.err);

lib.summary();

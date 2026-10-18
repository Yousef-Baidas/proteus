// Every hook command Proteus registers runs where the CLI runs it (#96): node tests/hookcmds.test.js.
// Collects the lead's (.claude/settings.local.json, statusLine included), a worker's (prepareWorker's copy of
// worktree-settings.local.json), Codex's (.codex/hooks.json) and the plugin's (hooks/hooks.json, with
// ${CLAUDE_PLUGIN_ROOT} substituted as Claude Code does at load time). Each must be `node "<abs path>"` plus at
// most one script name: nothing a shell expands, so cmd.exe, PowerShell and bash read it alike. Then each runs
// with a minimal event on stdin, through cmd.exe /d /s /c on Windows and sh -c elsewhere, and must start
// (node found, path quoted right) and exit without a crash. Temp HOME, temp repo; never touches ~/.claude.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "templates", "hooks");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("hookcmds");
const { ENV } = lib;
const WIN = process.platform === "win32";

const REPO = path.join(W, "repo");
fs.mkdirSync(REPO);
g(REPO, "init", "-q", "-b", "main");
fs.writeFileSync(path.join(REPO, "README.md"), "r\n");
g(REPO, "add", "-A"); g(REPO, "commit", "-qm", "init");

// [where, event, matcher, command]
const cmds = [];
const collect = (where, hooks) => {
  for (const [ev, list] of Object.entries(hooks || {})) for (const e of list) for (const h of e.hooks || []) cmds.push([where, ev, e.matcher, h.command]);
};

// lead, Claude Code: the installer's own entry point, run from the repo root
let r = lib.run(path.join(SRC, "install-lead-hooks.js"), "", { cwd: REPO });
ok("claude lead: install exit 0", r.code === 0, r.err);
const lead = JSON.parse(fs.readFileSync(path.join(REPO, ".claude", "settings.local.json"), "utf8"));
collect("claude lead", lead.hooks);
cmds.push(["claude statusLine", "StatusLine", undefined, lead.statusLine && lead.statusLine.command]);

// worker, Claude Code
const WT = path.join(W, "wt");
g(REPO, "worktree", "add", "-q", WT, "-b", "w96");
require(path.join(SRC, "proteus-harness-claude.js")).prepareWorker(WT, SRC);
collect("claude worker", JSON.parse(fs.readFileSync(path.join(WT, ".claude", "settings.local.json"), "utf8")).hooks);

// lead, Codex
const cx = require(path.join(SRC, "proteus-harness-codex.js"));
const CXD = cx.hooksDir(REPO);
fs.mkdirSync(CXD, { recursive: true });
for (const f of fs.readdirSync(SRC)) if (!cx.skipHooks.includes(f)) fs.copyFileSync(path.join(SRC, f), path.join(CXD, f));
ok("codex lead: registers", !cx.registerLead(REPO).error);
collect("codex lead", JSON.parse(fs.readFileSync(path.join(REPO, ".codex", "hooks.json"), "utf8")).hooks);

// plugin: the only variable is ${CLAUDE_PLUGIN_ROOT}, which Claude Code fills in before it runs the command
const plugin = fs.readFileSync(path.join(ROOT, "hooks", "hooks.json"), "utf8");
ok("plugin: no variable but ${CLAUDE_PLUGIN_ROOT}", !/\$(?!\{CLAUDE_PLUGIN_ROOT\})/.test(plugin));
collect("plugin", JSON.parse(plugin.split("${CLAUDE_PLUGIN_ROOT}").join(ROOT.split(path.sep).join("/"))).hooks);

ok("collected every registry", ["claude lead", "claude statusLine", "claude worker", "codex lead", "plugin"].every((w) => cmds.some((c) => c[0] === w)), cmds.map((c) => c[0]).join());

// static: node, one double-quoted absolute forward-slash path, at most one bare script name after it
const REGISTERED = /^node "((?:[A-Za-z]:)?\/[^"$%`!^&|<>;']+\.js)"(?: [\w.-]+\.js)?$/;
for (const [where, ev, , c] of cmds) {
  const m = REGISTERED.exec(String(c));
  ok(`${where} ${ev}: no shell syntax, quoted absolute path :: ${c}`, !!m);
  if (m) ok(`${where} ${ev}: script exists :: ${m[1]}`, fs.existsSync(m[1]));
}

// run: the shell the CLI would use on this OS, a minimal event, a temp HOME
const event = (ev, matcher, cwd) => {
  const tool = String(matcher || "Bash").split("|")[0];
  const input = tool === "Bash" ? { command: "ls" } : tool === "Agent" || tool === "Task" ? { prompt: "hi", description: "d" } : { file_path: path.join(cwd, "README.md"), content: "x", old_string: "r", new_string: "s" };
  return JSON.stringify({ hook_event_name: ev, session_id: "s96", cwd, transcript_path: path.join(W, "none.jsonl"), tool_name: tool, tool_input: input, tool_response: {}, prompt: "hi", source: "startup", stop_hook_active: true });
};
for (const [where, ev, matcher, c] of cmds) {
  const cwd = where === "claude worker" ? WT : REPO;
  const env = { ...ENV, CLAUDE_PROJECT_DIR: cwd, ...(where === "plugin" && { CLAUDE_PLUGIN_ROOT: ROOT }), ...(where === "codex lead" && { CLAUDE_PROJECT_DIR: undefined }) };
  const opts = { cwd, env, input: event(ev, matcher, cwd), encoding: "utf8", timeout: 60000, windowsHide: true };
  const p = WIN ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${c}"`], { ...opts, windowsVerbatimArguments: true })
    : spawnSync("/bin/sh", ["-c", c], opts);
  const out = `${p.error ? p.error.message : ""}${p.stdout || ""}${p.stderr || ""}`;
  ok(`${where} ${ev}: starts and exits without a crash :: ${c}`,
    !p.error && p.status !== null && p.status !== 1 && !/is not recognized|not found|Cannot find module|SyntaxError|\n\s+at /.test(out), `exit ${p.status} ${out.slice(0, 400)}`);
}

lib.summary();

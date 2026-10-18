#!/usr/bin/env node
// Plugin entry: hooks/hooks.json runs every hook as node "${CLAUDE_PLUGIN_ROOT}/templates/hooks/proteus-plugin.js" <hook file>.
// The per-repo gate: a plugin is enabled for every repo, so a hook runs only where the project's git root (of
// CLAUDE_PROJECT_DIR, else the cwd) sets enabledPlugins["proteus@proteus"] to true in .claude/settings.local.json or
// .claude/settings.json; local wins when both set it (--scope local writes it there), as in Claude Code. Anywhere
// else (no git repo, no or unreadable settings) it exits 0 having read nothing from stdin and written nothing.
// install.js --doctor requires this file for gateFrom, the same rule; run as a module it does nothing.
// The lazy move (#155): at SessionStart in a repo not gated in that still has its 1.x install (the lib copy, one stat,
// or proteus-* hook entries in settings.local.json, read with the gate), install.js --migrate-here moves it once and
// prints one line; the repo is recorded in CLAUDE_PLUGIN_DATA/migrated.json, so the hook never runs it again.
// A gated-in hook runs in this process, as if node had started it (argv[1] is the hook, any further args follow), so
// its stdin, output and exit code are the hook's own. A name that is not a Proteus hook beside this file exits 0 silently.
"use strict";
const fs = require("fs");
const path = require("path");

const PLUGIN = "proteus@proteus";

// the nearest dir at or above dir holding .git (a dir, or a worktree's .git file); "" when none
function gitRoot(dir) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, ".git"))) return d;
    if (path.dirname(d) === d) return "";
  }
}

// { on, file, old }: whether root's .claude settings enable the plugin, the file name that decided ("" when neither
// sets the key), and whether settings.local.json still holds a 1.x hook entry; a file that is missing, unreadable or
// not an object sets nothing
const OLD_ENTRY = /\.claude[\\/]hooks[\\/]proteus-[\w.-]+\.js/;
function gateFrom(root) {
  let old = false;
  for (const f of ["settings.local.json", "settings.json"]) {
    let v;
    try {
      const t = fs.readFileSync(path.join(root, ".claude", f), "utf8");
      if (f === "settings.local.json") old = OLD_ENTRY.test(t);
      const s = JSON.parse(t);
      v = s && typeof s === "object" && s.enabledPlugins && typeof s.enabledPlugins === "object" ? s.enabledPlugins[PLUGIN] : undefined;
    } catch {}
    if (v !== undefined) return { on: v === true, file: f, old };
  }
  return { on: false, file: "", old };
}

// the lazy move: one line on stdout (SessionStart context) when root was moved, or why not; silent otherwise
function lazyMove(root, g) {
  if (!g.old && !fs.existsSync(path.join(root, ".claude", "hooks", "proteus-lib.js"))) return;
  // a worktree's .git is a file: only the main checkout is moved
  try { if (!fs.statSync(path.join(root, ".git")).isDirectory()) return; } catch { return; }
  const data = process.env.CLAUDE_PLUGIN_DATA;
  if (data) {
    let key = root;
    try { key = fs.realpathSync(root); } catch {}
    if (process.platform === "win32" || process.platform === "darwin") key = key.toLowerCase();
    try { if (JSON.parse(fs.readFileSync(path.join(data, "migrated.json"), "utf8"))[key]) return; } catch {}
  }
  const plugin = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, "..", "..");
  const r = require("child_process").spawnSync(process.execPath, [path.join(plugin, "install.js"), "--migrate-here"], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 55000 });
  const line = String(r.stdout || "").trim().split(/\r?\n/).pop();
  if (line) process.stdout.write(`${line}\n`);
}

function enabled(dir) {
  const root = dir && gitRoot(dir);
  return !!root && gateFrom(root).on;
}

if (require.main === module) {
  const name = process.argv[2] || "";
  const file = path.join(__dirname, name);
  const dir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (/^proteus-[a-z-]+\.js$/.test(name) && name !== path.basename(__filename) && fs.existsSync(file) && enabled(dir)) {
    process.argv = [process.argv[0], file, ...process.argv.slice(3)];
    require(file);
  } else if (name === "proteus-autostart.js") {
    // fails open: a lazy move that breaks leaves the session as it was
    try { const root = gitRoot(dir); if (root) lazyMove(root, gateFrom(root)); } catch {}
  }
}

module.exports = { gateFrom, PLUGIN };

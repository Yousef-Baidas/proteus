#!/usr/bin/env node
// Plugin entry: hooks/hooks.json runs every hook as node "${CLAUDE_PLUGIN_ROOT}/templates/hooks/proteus-plugin.js" <hook file>.
// The per-repo gate: a plugin is enabled for every repo, so a hook runs only where the project's git root (of
// CLAUDE_PROJECT_DIR, else the cwd) sets enabledPlugins["proteus@proteus"] to true in .claude/settings.local.json or
// .claude/settings.json; local wins when both set it (--scope local writes it there), as in Claude Code. Anywhere
// else (no git repo, no or unreadable settings) it exits 0 having read nothing from stdin and written nothing.
// install.js --doctor requires this file for gateFrom, the same rule; run as a module it does nothing.
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

// { on, file }: whether root's .claude settings enable the plugin, and the file name that decided ("" when neither
// sets the key); a file that is missing, unreadable or not an object sets nothing
function gateFrom(root) {
  for (const f of ["settings.local.json", "settings.json"]) {
    let v;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(root, ".claude", f), "utf8"));
      v = s && typeof s === "object" && s.enabledPlugins && typeof s.enabledPlugins === "object" ? s.enabledPlugins[PLUGIN] : undefined;
    } catch {}
    if (v !== undefined) return { on: v === true, file: f };
  }
  return { on: false, file: "" };
}

function enabled(dir) {
  const root = dir && gitRoot(dir);
  return !!root && gateFrom(root).on;
}

if (require.main === module) {
  const name = process.argv[2] || "";
  const file = path.join(__dirname, name);
  if (/^proteus-[a-z-]+\.js$/.test(name) && name !== path.basename(__filename) && fs.existsSync(file)
    && enabled(process.env.CLAUDE_PROJECT_DIR || process.cwd())) {
    process.argv = [process.argv[0], file, ...process.argv.slice(3)];
    require(file);
  }
}

module.exports = { gateFrom, PLUGIN };

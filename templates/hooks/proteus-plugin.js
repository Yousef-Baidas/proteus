#!/usr/bin/env node
// Plugin entry: hooks/hooks.json runs every hook as node "${CLAUDE_PLUGIN_ROOT}/templates/hooks/proteus-plugin.js" <hook file>.
// The per-repo gate: a plugin is enabled for every repo, so a hook runs only where the project's git root (of
// CLAUDE_PROJECT_DIR, else the cwd) has .claude/settings.json with enabledPlugins["proteus@proteus"] === true. Anywhere
// else (no git repo, no or unreadable settings) it exits 0 having read nothing from stdin and written nothing.
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

function enabled(dir) {
  const root = dir && gitRoot(dir);
  if (!root) return false;
  try {
    const s = JSON.parse(fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8"));
    return !!s && !!s.enabledPlugins && s.enabledPlugins[PLUGIN] === true;
  } catch {
    return false;
  }
}

const name = process.argv[2] || "";
const file = path.join(__dirname, name);
if (/^proteus-[a-z-]+\.js$/.test(name) && name !== path.basename(__filename) && fs.existsSync(file)
  && enabled(process.env.CLAUDE_PROJECT_DIR || process.cwd())) {
  process.argv = [process.argv[0], file, ...process.argv.slice(3)];
  require(file);
}

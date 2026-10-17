#!/usr/bin/env node
// Plugin entry: hooks/hooks.json runs every hook as node "${CLAUDE_PLUGIN_ROOT}/templates/hooks/proteus-plugin.js" <hook file>.
// Runs that hook in this process, as if node had started it (argv[1] is the hook, any further args follow), so its
// stdin, output and exit code are the hook's own. A name that is not a Proteus hook beside this file exits 0 silently.
"use strict";
const fs = require("fs");
const path = require("path");

const name = process.argv[2] || "";
const file = path.join(__dirname, name);
if (/^proteus-[a-z-]+\.js$/.test(name) && name !== path.basename(__filename) && fs.existsSync(file)) {
  process.argv = [process.argv[0], file, ...process.argv.slice(3)];
  require(file);
}

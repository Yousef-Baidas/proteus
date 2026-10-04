// Preloaded through NODE_OPTIONS on win32 only (tests/lib.js fakeCli): when node runs as a copied <name>.exe, runs <name>.fake.js beside it.
// Exits with the fake's exit code before node loads its first argument as a script; for plain node, or a fake that
// spawns process.execPath on a .js file, it does nothing.
"use strict";
const fs = require("fs");
const path = require("path");

const name = path.basename(process.execPath).replace(/\.exe$/i, "");
const script = path.join(path.dirname(process.execPath), `${name}.fake.js`);
if (name.toLowerCase() !== "node" && fs.existsSync(script) && !/\.js$/i.test(process.argv[1] || "")) {
  // node took the first argument for its script and resolved it to a path; a subcommand word survives as the basename
  const args = process.argv.slice(1);
  if (args.length) args[0] = path.basename(args[0]);
  process.argv = [process.execPath, script, ...args];
  require(script);
  process.exit(process.exitCode || 0);
}

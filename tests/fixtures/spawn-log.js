// Preloaded through NODE_OPTIONS by tests/merge.test.js and tests/next.test.js: in a process whose script is
// proteus-merge.js or proteus-cli.js, every child process it starts is appended to SPAWN_LOG as one JSON line
// { file, args, cwd, workTree, index } before it runs.
"use strict";
const fs = require("fs");
const path = require("path");
const cp = require("child_process");

if (process.env.SPAWN_LOG && ["proteus-merge.js", "proteus-cli.js"].includes(path.basename(process.argv[1] || ""))) {
  const log = (file, args, o) => {
    const opts = (Array.isArray(args) ? o : args) || {};
    const env = opts.env || process.env;
    fs.appendFileSync(process.env.SPAWN_LOG, JSON.stringify({ file, args: Array.isArray(args) ? args : [], cwd: opts.cwd || process.cwd(), workTree: env.GIT_WORK_TREE || "", index: env.GIT_INDEX_FILE || "" }) + "\n");
  };
  for (const k of ["execFileSync", "execFile", "spawnSync", "spawn"]) {
    const orig = cp[k];
    cp[k] = function (file, args, o, ...rest) { log(file, args, o); return orig.call(this, file, args, o, ...rest); };
  }
}

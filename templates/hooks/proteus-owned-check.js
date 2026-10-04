#!/usr/bin/env node
// Owned-path check for changes that never pass through an Edit/Write hook (sed -i, redirects, a script).
//   --staged        git pre-commit in a worker worktree: staged paths against the worktree's owned-path list
//                   (proteus-worktree.js installs this as that worktree's pre-commit hook)
//   --ci <base>     CI on a proteus-work/<run>/<id> PR: paths changed since <base> against the "Owned:" line
//                   of the PR body (env PR_BODY), entries separated by commas or spaces
// Matching is proteus-lib's ownedMatch, the same rule the edit hooks apply. Exit 1 lists the paths outside the list.
"use strict";
const path = require("path");
const { execFileSync } = require("child_process");
const lib = require(path.join(__dirname, "proteus-lib.js"));

const git = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 << 20 });
// NUL-separated, so a path with a space or a quote comes back as written; --no-renames lists both ends of a move
const names = (args) => git(["diff", "--name-only", "--no-renames", "-z", ...args]).split("\0").filter(Boolean);

const [mode, base] = process.argv.slice(2);
let bad = [];
let from = "";
if (mode === "--staged") {
  const root = git(["rev-parse", "--show-toplevel"]).trim();
  if (!require("fs").existsSync(lib.ownedFile(root))) process.exit(0);
  from = path.relative(root, lib.ownedFile(root)).split(path.sep).join("/");
  bad = names(["--cached"]).filter((p) => lib.ownedDenial(root, p));
} else if (mode === "--ci" && base) {
  const m = /^Owned:[ \t]*(.+)$/im.exec(process.env.PR_BODY || "");
  const owned = m ? m[1].split(/[,\s]+/).filter(Boolean) : [];
  if (!owned.length) {
    console.error("proteus-owned-check: the PR body has no \"Owned: <paths and globs>\" line; copy it from the ticket");
    process.exit(1);
  }
  from = "the PR body's Owned: line";
  bad = names([`${base}...HEAD`]).filter((p) => !owned.some((g) => lib.ownedMatch(g, p)));
} else {
  console.error("usage: node proteus-owned-check.js --staged | --ci <base-ref>");
  process.exit(2);
}
if (bad.length) {
  console.error(`proteus-owned-check: not in ${from}:\n  ${bad.join("\n  ")}\nComment "NEEDS <path>: <why>" on the issue and stop.`);
  process.exit(1);
}

#!/usr/bin/env node
// Prepare a worker's worktree before dispatch (replaces the manual mkdir/cp/printf):
//   node .claude/hooks/proteus-worktree.js <worktree> [--tier <tier> [--human]] <owned path or glob>...
// The harness adapter copies the worker hooks in and registers them (Claude Code: .claude/hooks/ and
// .claude/settings.local.json from worktree-settings.local.json); this writes the owned-path list
// (one entry per line), keeps those local files out of `git add` via <git-common-dir>/info/exclude, and installs
// a pre-commit hook in this worktree only that checks staged paths against the list (proteus-owned-check.js).
// --tier records the work's declared tier (SKILL.md rule 3) and the worktree's base commit as a comment line in
// the list, which the same pre-commit hook checks with proteus-tier.js --staged; --human marks a human's quick:.
// A re-run keeps the first base, so a Direct batch is measured as a whole.
"use strict";
const fs = require("fs");
const { execFileSync } = require("child_process");
const path = require("path");
const lib = require(path.join(__dirname, "proteus-lib.js"));
const ad = require(path.join(__dirname, "proteus-harness.js"));

const [wtArg, ...rest] = process.argv.slice(2);
const entries = [];
let tier = "", human = false, badTier = false;
for (let i = 0; i < rest.length; i++) {
  const p = rest[i].replace(/\\/g, "/").replace(/^\.\//, "");
  if (p === "--tier") { tier = String(rest[++i] || ""); badTier = !lib.TIERS.includes(tier); }
  else if (p === "--human") human = true;
  else if (p) entries.push(p);
}
if (!wtArg || !entries.length || badTier) {
  console.error(`usage: node proteus-worktree.js <worktree> [--tier ${lib.TIERS.join("|")} [--human]] <owned path or glob>...`);
  process.exitCode = 1;
  return;
}
const wt = path.resolve(wtArg);
if (!fs.existsSync(path.join(wt, ".git"))) {
  console.error(`proteus-worktree: ${wt} is not a git worktree (git worktree add it first)`);
  process.exitCode = 1;
  return;
}

const EXCLUDE = ad.prepareWorker(wt, __dirname);
let head = entries;
if (tier) {
  let prev = null;
  try { prev = lib.TIER_LINE.exec(fs.readFileSync(lib.ownedFile(wt), "utf8")); } catch {}
  let base = prev ? prev[3] : "";
  try { base = base || execFileSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch {}
  if (!base) {
    console.error(`proteus-worktree: ${wt} has no commit to measure the tier from`);
    process.exitCode = 1;
    return;
  }
  head = [`# tier ${tier}${human ? " human" : ""} ${base}`, ...entries];
}
fs.mkdirSync(path.dirname(lib.ownedFile(wt)), { recursive: true });
fs.writeFileSync(lib.ownedFile(wt), head.join("\n") + "\n");

try {
  const common = lib.gitCommonDir(wt);
  if (common) {
    const file = path.join(common, "info", "exclude");
    let cur = "";
    try { cur = fs.readFileSync(file, "utf8"); } catch {}
    const have = new Set(cur.split(/\r?\n/));
    const add = EXCLUDE.filter((l) => !have.has(l));
    if (add.length) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, (cur && !cur.endsWith("\n") ? "\n" : "") + "# proteus: machine-local worker files\n" + add.join("\n") + "\n");
    }
  }
} catch {}

// Shell writes never reach the Edit/Write hooks, so a pre-commit hook checks what is staged. core.hooksPath is
// shared by every worktree unless extensions.worktreeConfig lets `config --worktree` set it for this one; that
// needs git 2.20 and works the same on every OS. The hooks dir sits under this worktree's own git dir (it dies
// with the worktree) and forwards every hook the repo already had, so lefthook's commit-msg gate still runs.
// A failure is only warned about: CI's check of the PR is the backstop, and `git commit --no-verify` skips this.
function installPreCommit() {
  const git = (...a) => { try { return execFileSync("git", ["-C", wt, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch { return null; } };
  const slash = (p) => p.replace(/\\/g, "/");
  const sq = (s) => `'${slash(s).replace(/'/g, "'\\''")}'`;
  const gitdir = git("rev-parse", "--absolute-git-dir");
  if (!gitdir) return "no git dir";
  const dir = path.join(gitdir, "proteus-hooks");
  const kept = path.join(dir, "orig-hooks-path");
  let orig = git("rev-parse", "--path-format=absolute", "--git-path", "hooks");
  if (orig === null) return "git too old for --path-format";
  // a re-run sees our own dir as the hooks path: the hooks to forward to are the ones saved the first time
  if (path.resolve(orig) === path.resolve(dir)) orig = fs.readFileSync(kept, "utf8");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(kept, orig);
  const check = path.join(ad.hooksDir(wt), "proteus-owned-check.js");
  const tierCheck = path.join(ad.hooksDir(wt), "proteus-tier.js");
  const write = (name, body) => fs.writeFileSync(path.join(dir, name), "#!/bin/sh\n" + body, { mode: 0o755 });
  let have = [];
  try { have = fs.readdirSync(orig).filter((f) => !f.endsWith(".sample") && f !== "pre-commit"); } catch {}
  for (const f of have) write(f, `exec ${sq(path.join(orig, f))} "$@"\n`);
  write("pre-commit", `node ${sq(check)} --staged || exit 1\nnode ${sq(tierCheck)} --staged || exit 1\n[ -x ${sq(path.join(orig, "pre-commit"))} ] && exec ${sq(path.join(orig, "pre-commit"))} "$@"\nexit 0\n`);
  if (git("config", "extensions.worktreeConfig", "true") === null || git("config", "--worktree", "core.hooksPath", slash(dir)) === null) return "git config --worktree failed";
  return "";
}
const hookErr = installPreCommit();
if (hookErr) console.error(`proteus-worktree: pre-commit owned-path check not installed (${hookErr}); CI still checks the PR`);

console.log(`worktree ${wt}: hooks + ${entries.length} owned paths${tier ? `, tier ${tier}${human ? " (human)" : ""}` : ""}`);

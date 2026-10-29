#!/usr/bin/env node
// Prepare a worker's worktree before dispatch (replaces the manual mkdir/cp/printf):
//   node .claude/hooks/proteus-worktree.js <worktree> [--tier <tier> [--human]] <owned path or glob>...
//   node .claude/hooks/proteus-worktree.js <worktree> --allow force-push   (the lead's one-off authorisation)
// The harness adapter copies the worker hooks in and registers them (Claude Code: .claude/hooks/ and
// .claude/settings.local.json from worktree-settings.local.json); this writes the owned-path list
// (one entry per line), keeps those local files and the checkout's /.worktrees/ folder out of `git add` via
// <git-common-dir>/info/exclude (never .gitignore, which is the human's), and installs
// a pre-commit hook in this worktree only that checks staged paths against the list (proteus-owned-check.js),
// plus a commit-msg hook running commit-msg.js when the repo has none of its own.
// --tier records the work's declared tier (SKILL.md rule 3) and the worktree's base commit as a comment line in
// the list, which the same pre-commit hook checks with proteus-tier.js --staged; --human marks a human's quick:.
// A re-run keeps the first base, so a Direct batch is measured as a whole. A --tier below what the owned paths
// need by the tiers block (proteus-tier.js's rules) is raised to it, with one line saying so.
// On a worker branch proteus-work/<run>/<id>, the paths are compared with the lead's record .proteus/owned/<id>
// that the branch carries from the run branch, which CI checks the PR against; a difference is warned about.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const lib = require(path.join(__dirname, "proteus-lib.js"));
const ad = require(path.join(__dirname, "proteus-harness.js"));

const HELP = `usage: node proteus-worktree.js <worktree> [--tier ${lib.TIERS.join("|")} [--human]] <owned path or glob>...
Prepares a worktree made with \`git worktree add\` for one worker, before dispatch:
  <worktree>        the checkout, e.g. .worktrees/<id> (Direct: direct-<batch>, Quick: quick-<n>)
  <owned path>...   the ticket's owned paths and globs, the check's files among them; the pre-commit
                    hook refuses a staged path outside them
  --tier <tier>     the tier proteus-tier.js classified; the pre-commit hook fails a change that outgrows
                    it and names the tier it needs. Below what the owned paths need, it is raised to that
  --human           with --tier quick: the human's quick: prefix (covers Standard work, never Full)
  <worktree> --allow force-push
                    alone: lets the worker force-push once (the guard consumes the entry)
Re-run on the same worktree with every path so far to extend a Direct batch; the first base is kept.
Exit 1 on bad usage or when <worktree> is not a git worktree.`;
if (process.argv[2] === "--help" || process.argv[2] === "-h") { console.log(HELP); return; }
const [wtArg, ...rest] = process.argv.slice(2);
// --allow <what>: the lead's one-off authorisation for this worktree's worker, consumed by the first use the
// guard lets through (lib.workerDenial); the owned-path list is left as it is
if (rest[0] === "--allow") {
  const what = String(rest[1] || "");
  if (!wtArg || rest.length !== 2 || !lib.ALLOWS.includes(what)) {
    console.error(`usage: node proteus-worktree.js <worktree> --allow ${lib.ALLOWS.join("|")}`);
    process.exitCode = 1;
    return;
  }
  const wt = path.resolve(wtArg);
  if (!fs.existsSync(lib.ownedFile(wt))) {
    console.error(`proteus-worktree: ${wt} is not a prepared worktree (no owned-path list)`);
    process.exitCode = 1;
    return;
  }
  lib.addAllow(wt, what);
  console.log(`worktree ${wt}: allows one ${what} (${lib.allowLines(wt).filter((l) => l === what).length} pending)`);
  return;
}
const entries = [];
let tier = "", human = false, badTier = false;
for (let i = 0; i < rest.length; i++) {
  const p = rest[i].replace(/\\/g, "/").replace(/^\.\//, "");
  if (p === "--tier") { tier = String(rest[++i] || ""); badTier = !lib.TIERS.includes(tier); }
  else if (p === "--human") human = true;
  else if (p) entries.push(p);
}
if (!wtArg || !entries.length || badTier) {
  console.error(HELP.split("\n")[0] + "\n(--help explains each argument)");
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
  base = base || lib.headOf(wt);
  if (!base) {
    console.error(`proteus-worktree: ${wt} has no commit to measure the tier from`);
    process.exitCode = 1;
    return;
  }
  // the tier the owned paths need, by the rules the pre-commit check reads (#177): --tier may raise it, never lower it
  const rules = lib.parseTiers(lib.routingText(wt, base));
  if (rules && rules.errors.length) console.error(`proteus-worktree: ${lib.ROUTING_FILE}: ${rules.errors.join("; ")}; the tier is not checked against the paths`);
  else {
    const need = lib.plannedTier(rules, entries);
    if (lib.tierOverrun({ tier, human }, need)) {
      console.log(`proteus-worktree: --tier ${tier}${human ? " --human" : ""} is below what these paths need; prepared at ${need.tier} (${need.why.join("; ")})`);
      tier = need.tier;
      human = false;
    }
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
    const add = [...EXCLUDE, lib.WORKTREES_EXCLUDE].filter((l) => !have.has(l));
    if (add.length) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, (cur && !cur.endsWith("\n") ? "\n" : "") + "# proteus: machine-local worker files and worktrees\n" + add.join("\n") + "\n");
    }
  }
} catch {}

// Shell writes never reach the Edit/Write hooks, so a pre-commit hook checks what is staged. core.hooksPath is
// shared by every worktree unless extensions.worktreeConfig lets `config --worktree` set it for this one; that
// needs git 2.20 and works the same on every OS. The hooks dir sits under this worktree's own git dir (it dies
// with the worktree) and forwards every hook the repo already had, so lefthook's commit-msg gate still runs.
// A repo with no commit-msg hook (no lefthook yet, or a guest repo) gets one running commit-msg.js, the check
// CI runs on every commit of the PR, so a worker learns of a bad message before it pushes (#28).
// A failure is only warned about: CI's check of the PR is the backstop, and `git commit --no-verify` skips this.
// git runs through lib's wrapper on the common dir (#215): the worktree's gitdir comes from <common>/worktrees/<id>,
// never its .git file, and its config.worktree is written by path, never read.
function installPreCommit() {
  const co = lib.checkoutOf(wt);
  if (!co) return "no git dir";
  const git = (...a) => { try { return String(lib.gitRun(co.common, a, { stdio: ["ignore", "pipe", "pipe"], timeout: 10000 })).trim(); } catch { return null; } };
  const slash = (p) => p.replace(/\\/g, "/");
  const sq = (s) => `'${slash(s).replace(/'/g, "'\\''")}'`;
  const dir = path.join(co.gitDir, "proteus-hooks");
  const kept = path.join(dir, "orig-hooks-path");
  // the repo's own hooks path (the common config.worktree, then config), relative to the checkout as git reads it
  const set = ["config.worktree", "config"].map((f) => git("config", "--file", path.join(co.common, f), "--get", "core.hooksPath")).find(Boolean);
  let orig = set ? path.resolve(co.root, set.replace(/^~(?=$|[\\/])/, os.homedir())) : path.join(co.common, "hooks");
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
  // beside this script (Claude Code's hooks dir), else the lead's teams/templates/hooks (Codex skips the file;
  // the lead's checkout is the worktree's main one); either way proteus-lib.js and package.json sit next to it
  const lead = lib.mainRoot(lib.gitCommonDir(wt)) || lib.repoRoot();
  const msgCheck = [__dirname, ...(lead ? [path.join(lib.docRoot(lead), "teams", "templates", "hooks")] : [])]
    .map((d) => path.join(d, "commit-msg.js")).find((f) => fs.existsSync(f));
  if (!have.includes("commit-msg") && msgCheck) write("commit-msg", `exec node ${sq(msgCheck)} "$1"\n`);
  write("pre-commit", `node ${sq(check)} --staged || exit 1\nnode ${sq(tierCheck)} --staged ${sq(path.join(__dirname, "proteus-worktree.js"))} || exit 1\n[ -x ${sq(path.join(orig, "pre-commit"))} ] && exec ${sq(path.join(orig, "pre-commit"))} "$@"\nexit 0\n`);
  if (git("config", "extensions.worktreeConfig", "true") === null || git("config", "--file", path.join(co.gitDir, "config.worktree"), "core.hooksPath", slash(dir)) === null) return "git config --worktree failed";
  return "";
}
const hookErr = installPreCommit();
if (hookErr) console.error(`proteus-worktree: pre-commit owned-path check not installed (${hookErr}); CI still checks the PR`);

// a worker branch proteus-work/<run>/<id> cut from a run branch carrying the lead's record .proteus/owned/<id>:
// CI checks the PR against that record, so a list that differs from it is named now, not at the PR
const branch = lib.branchOf(wt);
const work = /^proteus-work\/[^/]+\/([A-Za-z0-9][\w.-]*)$/.exec(branch);
if (work && work[1] !== "lead-docs") {
  const rec = path.join(wt, ...lib.OWNED_RECORDS.split("/"), work[1]);
  let text = null;
  try { text = fs.readFileSync(rec, "utf8"); } catch {}
  const listed = text === null ? [] : text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const same = listed.length === entries.length && listed.every((e) => entries.includes(e));
  if (text === null && fs.existsSync(path.join(wt, ...lib.OWNED_RECORDS.split("/"))))
    console.error(`proteus-worktree: ${lib.OWNED_RECORDS}/${work[1]} is not on this branch; CI fails the PR until the lead's record of these paths is on the run branch (flow.md step 4)`);
  else if (text !== null && !same)
    console.error(`proteus-worktree: these paths differ from ${lib.OWNED_RECORDS}/${work[1]} (${listed.join(" ")}), which CI checks the PR against`);
}

console.log(`worktree ${wt}: hooks + ${entries.length} owned paths${tier ? `, tier ${tier}${human ? " (human)" : ""}` : ""}`);

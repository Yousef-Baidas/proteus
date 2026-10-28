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
// A re-run keeps the first base, so a Direct batch is measured as a whole.
// On a worker branch proteus-work/<run>/<id>, the paths are compared with the lead's record .proteus/owned/<id>
// that the branch carries from the run branch, which CI checks the PR against; a difference is warned about.
"use strict";
const fs = require("fs");
const { execFileSync } = require("child_process");
const path = require("path");
const lib = require(path.join(__dirname, "proteus-lib.js"));
const ad = require(path.join(__dirname, "proteus-harness.js"));

const HELP = `usage: node proteus-worktree.js <worktree> [--tier ${lib.TIERS.join("|")} [--human]] <owned path or glob>...
Prepares a worktree made with \`git worktree add\` for one worker, before dispatch:
  <worktree>        the checkout, e.g. .worktrees/<id> (Direct: direct-<batch>, Quick: quick-<n>)
  <owned path>...   the ticket's owned paths and globs, the check's files among them; the pre-commit
                    hook refuses a staged path outside them
  --tier <tier>     the tier proteus-tier.js classified; the pre-commit hook fails a change that outgrows
                    it and names the tier it needs
  --human           with --tier quick: the human's quick: prefix (covers Standard work, never Full)
  <worktree> --allow force-push
                    alone: lets the worker force-push once (the guard consumes the entry)
Re-run on the same worktree with every path so far to extend a Direct batch; the first base is kept.
Exit 1 on bad usage or when <worktree> is not a git worktree.`;
if (process.argv[2] === "--help" || process.argv[2] === "-h") { console.log(HELP); return; }
const [wtArg, ...rest] = process.argv.slice(2);
// The copy install.js --sandbox makes (#188) runs outside the sandbox on whatever arguments an agent passes, so it
// serves only a worktree of the repo it was made for (sandbox-root.json beside it names that repo): under
// <root>/.worktrees/, listed by `git worktree list`, its git dir and common dir the repo's, and nothing it writes
// through a link. A plain run outside the sandbox that cannot write names the copy to run instead.
const PIN = path.join(__dirname, "sandbox-root.json");
if (fs.existsSync(PIN)) {
  let why;
  try { why = sandboxRefusal(wtArg, JSON.parse(fs.readFileSync(PIN, "utf8"))); } catch (e) { why = `cannot read ${PIN} (${e.message})`; }
  if (why) {
    console.error(`proteus-worktree: refused: ${why}`);
    process.exitCode = 1;
    return;
  }
} else {
  process.on("uncaughtException", (e) => {
    const C = require(path.join(__dirname, "proteus-confine.js"));
    const common = wtArg && lib.gitCommonDir(path.resolve(wtArg));
    const copy = common && path.join(C.sandboxBin(common), "proteus-worktree.js");
    if (copy && ["EPERM", "EACCES", "EROFS"].includes(e && e.code) && fs.existsSync(copy))
      console.error(`proteus-worktree: ${e.message}\nIn a sandboxed session (install.js --sandbox) run the copy that runs outside the sandbox: node ${copy} ${process.argv.slice(2).join(" ")}`);
    else console.error(e && e.stack ? e.stack : String(e));
    process.exitCode = 1;
  });
}
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
  // beside this script (Claude Code's hooks dir), else the lead's teams/templates/hooks (Codex skips the file;
  // the lead's checkout is the worktree's main one); either way proteus-lib.js and package.json sit next to it
  const lead = lib.mainRoot(lib.gitCommonDir(wt)) || lib.repoRoot();
  const msgCheck = [__dirname, ...(lead ? [path.join(lib.docRoot(lead), "teams", "templates", "hooks")] : [])]
    .map((d) => path.join(d, "commit-msg.js")).find((f) => fs.existsSync(f));
  if (!have.includes("commit-msg") && msgCheck) write("commit-msg", `exec node ${sq(msgCheck)} "$1"\n`);
  write("pre-commit", `node ${sq(check)} --staged || exit 1\nnode ${sq(tierCheck)} --staged || exit 1\n[ -x ${sq(path.join(orig, "pre-commit"))} ] && exec ${sq(path.join(orig, "pre-commit"))} "$@"\nexit 0\n`);
  if (git("config", "extensions.worktreeConfig", "true") === null || git("config", "--worktree", "core.hooksPath", slash(dir)) === null) return "git config --worktree failed";
  return "";
}
const hookErr = installPreCommit();
if (hookErr) console.error(`proteus-worktree: pre-commit owned-path check not installed (${hookErr}); CI still checks the PR`);

// a worker branch proteus-work/<run>/<id> cut from a run branch carrying the lead's record .proteus/owned/<id>:
// CI checks the PR against that record, so a list that differs from it is named now, not at the PR
let branch = "";
try { branch = execFileSync("git", ["-C", wt, "symbolic-ref", "-q", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 10000 }).trim(); } catch {}
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

// why the sandbox copy refuses arg ("" when it is a worktree of pin.root it may prepare); hoisted for the top
function sandboxRefusal(arg, pin) {
  const C = require(path.join(__dirname, "proteus-confine.js"));
  const under = (child, parent) => C.inside(child, parent) && !C.samePath(child, parent);
  const run = (cwd, ...a) => { try { return execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 10000 }).trim(); } catch { return null; } };
  const root = C.real(String(pin.root || "")), common = C.real(String(pin.common || ""));
  if (!root || !common) return "the repo this copy was made for is gone; run install.js --sandbox again";
  const nest = path.join(root, ".worktrees");
  const wt = arg ? C.real(path.resolve(arg)) : null;
  if (!wt || !under(wt, nest)) return `${arg || "(no worktree)"} is not a checkout under ${nest}`;
  const listed = (run(root, "worktree", "list", "--porcelain") || "").split(/\r?\n/)
    .filter((l) => l.startsWith("worktree ")).map((l) => C.real(l.slice(9)));
  if (!listed.some((l) => l && C.samePath(l, wt))) return `${wt} is not a worktree \`git -C ${root} worktree list\` names`;
  const dotgit = path.join(wt, ".git"), st = C.lstat(dotgit);
  if (!st || !st.isFile()) return `${dotgit} is not a worktree's .git file`;
  const m = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(fs.readFileSync(dotgit, "utf8"));
  const gitdir = m ? C.real(path.resolve(wt, m[1])) : null;
  if (!gitdir || !under(gitdir, path.join(common, "worktrees"))) return `${wt}'s git dir is not inside ${path.join(common, "worktrees")}`;
  // what git itself resolves, which the writes below go through (a commondir file can point anywhere)
  const said = (run(wt, "rev-parse", "--absolute-git-dir", "--git-common-dir") || "").split(/\r?\n/);
  if (said.length !== 2 || !C.samePath(C.real(said[0]) || "", gitdir) || !C.samePath(C.real(path.resolve(wt, said[1])) || "", common))
    return `git resolves ${wt} to another git dir or common dir than ${gitdir} and ${common}`;
  if (!C.samePath(C.real(lib.gitCommonDir(wt) || "") || "", common)) return `${wt}'s common dir is not ${common}`;
  const link = (p) => {
    const s2 = C.lstat(p);
    if (!s2) return "";
    if (s2.isSymbolicLink()) return p;
    if (s2.isDirectory()) for (const n of fs.readdirSync(p)) { const l = link(path.join(p, n)); if (l) return l; }
    return "";
  };
  for (const d of [path.join(wt, ".claude"), path.join(gitdir, "proteus-hooks"), path.join(gitdir, "config.worktree"),
    path.join(common, "info"), path.join(common, "config"), path.join(common, "proteus", "allow")]) {
    const l = link(d);
    if (l) return `${l} is a link, which this copy will not write through`;
  }
  for (const d of [path.join(common, "proteus")]) { const s3 = C.lstat(d); if (s3 && s3.isSymbolicLink()) return `${d} is a link, which this copy will not write through`; }
  return "";
}

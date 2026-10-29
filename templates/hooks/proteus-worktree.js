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
const C = require(path.join(__dirname, "proteus-confine.js"));

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
// The copy install.js --sandbox makes (#188) in <config>/proteus-sandbox/bin/<hash>/ runs outside the sandbox on
// whatever arguments an agent passes. sandbox-root.json beside it pins the repo it serves: lib.pinProject takes the
// main root and common dir (so <common>/proteus) from it, never from the cwd, the worktree's .git file or a
// commondir, and the copy refuses without it. It prepares only a worktree that common dir registers, under
// <root>/.worktrees/. The work is split in two halves (#212 B1). The worktree half (<wt>/.claude: hooks, settings,
// owned-path list) is agent-writable anyway, so it runs only in the in-repo script, inside the sandbox: the copy
// never opens a path in the worktree, where a link swapped in mid-run would steer its writes. The git half
// (info/exclude, the worktree's pre-commit hooks and config.worktree, <common>/proteus/allow, the profile's deny
// rules) is all the copy does, every file under <common> replaced, never written through a link
// (C.replaceFile). So a sandboxed lead runs the in-repo script, then the copy; a run outside the sandbox does both,
// and one that cannot write names the copy.
const PIN = path.join(__dirname, "sandbox-root.json");
const COPY = path.basename(path.dirname(__dirname)) === "bin" && path.basename(path.dirname(path.dirname(__dirname))) === "proteus-sandbox";
let pin = null;
if (COPY || fs.existsSync(PIN)) {
  let why;
  try { pin = JSON.parse(fs.readFileSync(PIN, "utf8")); why = sandboxRefusal(wtArg, pin); } catch (e) { why = `cannot read ${PIN} (${e.message}); run install.js --sandbox again outside the sandbox`; }
  if (why) {
    console.error(`proteus-worktree: refused: ${why}`);
    process.exitCode = 1;
    return;
  }
} else {
  process.on("uncaughtException", (e) => {
    const common = wtArg && lib.repoCommon(path.resolve(wtArg));
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
  const wt = pin ? C.real(path.resolve(wtArg)) : path.resolve(wtArg);
  if (!fs.existsSync(lib.ownedFile(wt))) {
    console.error(`proteus-worktree: ${wt} is not a prepared worktree (no owned-path list)`);
    process.exitCode = 1;
    return;
  }
  const f = lib.allowFile(wt);
  merge(lib.gitCommonDir(wt), f, (cur) => cur + (cur && !cur.endsWith("\n") ? "\n" : "") + what + "\n");
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
if (!wtArg || (!entries.length && !pin) || badTier) {
  console.error(HELP.split("\n")[0] + "\n(--help explains each argument)");
  process.exitCode = 1;
  return;
}
const wt = pin ? C.real(path.resolve(wtArg)) : path.resolve(wtArg);
if (!fs.existsSync(path.join(wt, ".git"))) {
  console.error(`proteus-worktree: ${wt} is not a git worktree (git worktree add it first)`);
  process.exitCode = 1;
  return;
}
// the project's own worktree, registered under its common dir (#215): git runs outside the sandbox, so a path on the
// command line never picks the repo; one the project's checkouts do not hold gets no git at all
const co = lib.checkoutOf(wt);
if (!co || co.gitDir === co.common || !lib.samePath(co.root, lib.realOr(wt))) {
  console.error(`proteus-worktree: ${wt} is not a worktree of this project (${lib.projectRoot({})}); make it with \`git worktree add\` in the project and run this from there`);
  process.exitCode = 1;
  return;
}

// the worktree half: the in-repo script only (the copy writes nothing in the worktree)
if (!pin && !prepareTree()) return;
function prepareTree() {
  ad.prepareWorker(wt, __dirname);
  let head = entries;
  if (tier) {
    let prev = null;
    try { prev = lib.TIER_LINE.exec(fs.readFileSync(lib.ownedFile(wt), "utf8")); } catch {}
    let base = prev ? prev[3] : "";
    base = base || lib.headOf(wt);
    if (!base) {
      console.error(`proteus-worktree: ${wt} has no commit to measure the tier from`);
      process.exitCode = 1;
      return false;
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
  return true;
}

// the project's common dir (co.common), never the one the worktree's .git file names. The lines name what the
// harness's prepareWorker writes, by the adapter's paths, so the copy needs no call into it
const top = path.resolve("/"), slashRel = (f) => "/" + path.relative(top, f).split(path.sep).join("/");
const EXCLUDE = [ad.ownedFile(top), ...(ad.name === "claude" ? [path.join(path.dirname(ad.ownedFile(top)), "settings.local.json")] : []),
  path.join(ad.hooksDir(top), "proteus-*.js"), path.join(ad.hooksDir(top), "package.json")].map(slashRel);
try {
  merge(co.common, path.join(co.common, "info", "exclude"), (cur) => {
    const have = new Set(cur.split(/\r?\n/));
    const add = [...EXCLUDE, lib.WORKTREES_EXCLUDE].filter((l) => !have.has(l));
    return add.length ? cur + (cur && !cur.endsWith("\n") ? "\n" : "") + "# proteus: machine-local worker files and worktrees\n" + add.join("\n") + "\n" : null;
  });
} catch (e) { if (pin) console.error(`proteus-worktree: info/exclude not written (${e.message})`); }

// Shell writes never reach the Edit/Write hooks, so a pre-commit hook checks what is staged. core.hooksPath is
// shared by every worktree unless extensions.worktreeConfig lets `config --worktree` set it for this one; that
// needs git 2.20 and works the same on every OS. The hooks dir sits under this worktree's own git dir (it dies
// with the worktree) and forwards every hook the repo already had, so lefthook's commit-msg gate still runs.
// A repo with no commit-msg hook (no lefthook yet, or a guest repo) gets one running commit-msg.js, the check
// CI runs on every commit of the PR, so a worker learns of a bad message before it pushes (#28).
// A failure is only warned about: CI's check of the PR is the backstop, and `git commit --no-verify` skips this.
// git runs through lib's wrapper on the common dir (#215): the worktree's gitdir comes from <common>/worktrees/<id>,
// never its .git file. git edits a private copy of <common>/config and the worktree's config.worktree, which then
// replaces the file (put), so neither is written through a link.
function installPreCommit() {
  const git = (...a) => { try { return String(lib.gitRun(co.common, a, { stdio: ["ignore", "pipe", "pipe"], timeout: 10000 })).trim(); } catch { return null; } };
  const slash = (p) => p.replace(/\\/g, "/");
  const sq = (s) => `'${slash(s).replace(/'/g, "'\\''")}'`;
  const dir = path.join(co.gitDir, "proteus-hooks");
  const kept = path.join(dir, "orig-hooks-path");
  // the repo's own hooks path (the common config.worktree, then config), relative to the checkout as git reads it
  const set = ["config.worktree", "config"].map((f) => git("config", "--file", path.join(co.common, f), "--get", "core.hooksPath")).find(Boolean);
  let orig = set ? path.resolve(co.root, set.replace(/^~(?=$|[\\/])/, os.homedir())) : path.join(co.common, "hooks");
  // a re-run sees our own dir as the hooks path: the hooks to forward to are the ones saved the first time
  if (path.resolve(orig) === path.resolve(dir)) orig = C.readText(kept);
  put(co.common, kept, () => orig);
  const check = path.join(ad.hooksDir(wt), "proteus-owned-check.js");
  const tierCheck = path.join(ad.hooksDir(wt), "proteus-tier.js");
  const write = (name, body) => put(co.common, path.join(dir, name), () => "#!/bin/sh\n" + body, 0o755);
  let have = [];
  try { have = fs.readdirSync(orig).filter((f) => !f.endsWith(".sample") && f !== "pre-commit"); } catch {}
  for (const f of have) write(f, `exec ${sq(path.join(orig, f))} "$@"\n`);
  // beside this script (Claude Code's hooks dir), else the lead's teams/templates/hooks (Codex skips the file;
  // the lead's checkout is the worktree's main one); either way proteus-lib.js and package.json sit next to it
  const lead = lib.mainRoot(co.common) || lib.repoRoot();
  const msgCheck = [__dirname, ...(lead ? [path.join(lib.docRoot(lead), "teams", "templates", "hooks")] : [])]
    .map((d) => path.join(d, "commit-msg.js")).find((f) => fs.existsSync(f));
  if (!have.includes("commit-msg") && msgCheck) write("commit-msg", `exec node ${sq(msgCheck)} "$1"\n`);
  write("pre-commit", `node ${sq(check)} --staged || exit 1\nnode ${sq(tierCheck)} --staged ${sq(path.join(__dirname, "proteus-worktree.js"))} || exit 1\n[ -x ${sq(path.join(orig, "pre-commit"))} ] && exec ${sq(path.join(orig, "pre-commit"))} "$@"\nexit 0\n`);
  // the private copy sits where no sandboxed command writes: the copy's proteus-sandbox/ (the temp dir may be the
  // sandbox's), else the temp dir
  const setIn = (file, key, value) => {
    const tmp = fs.mkdtempSync(path.join(pin ? path.dirname(path.dirname(__dirname)) : os.tmpdir(), "proteus-config-")), f = path.join(tmp, "config");
    try {
      return merge(co.common, file, (cur) => {
        fs.writeFileSync(f, cur);
        return git("config", "--file", f, key, value) === null ? null : fs.readFileSync(f, "utf8");
      });
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  };
  if (!setIn(path.join(co.common, "config"), "extensions.worktreeConfig", "true") || !setIn(path.join(co.gitDir, "config.worktree"), "core.hooksPath", slash(dir))) return "git config --worktree failed";
  return "";
}
// write next(the file's text) to file under common: each dir on the way made a real directory, none a link, and
// the file replaced, never written through a link (C.replaceFile); next returning null leaves it. Throws on failure
function put(common, file, next, mode) {
  const rel = path.relative(common, path.dirname(file));
  const dir = C.inside(path.dirname(file), common) && C.ownDir(common, rel ? rel.split(path.sep) : [], true);
  if (!dir) throw new Error(`${path.dirname(file)} is a link, has one on the way, or is outside ${common}`);
  return C.replaceFile(path.join(dir, path.basename(file)), next, mode);
}
// put for a file whose text is kept (git config, info/exclude): a link there is refused, not replaced by a copy
// missing that text
function merge(common, file, next) {
  const st = C.lstat(file);
  if (st && !st.isFile()) throw new Error(`${file} is not a regular file`);
  return put(common, file, next);
}
const hookErr = installPreCommit();
if (hookErr) console.error(`proteus-worktree: pre-commit owned-path check not installed (${hookErr}); CI still checks the PR`);

if (!pin) {
  console.log(`worktree ${wt}: hooks + ${entries.length} owned paths${tier ? `, tier ${tier}${human ? " (human)" : ""}` : ""}`);
  // install.js --sandbox made a copy for this repo: it adds the worktree's deny rules to the profile, and in the
  // sandbox it writes the git half this run could not
  const copy = path.join(C.sandboxBin(co.common), "proteus-worktree.js");
  if (fs.existsSync(copy)) console.log(`proteus-worktree: then run the copy for the git half: node ${copy} ${wt}`);
} else {
  console.log(`worktree ${wt}: git half prepared (pre-commit hook, info/exclude, the profile's deny rules); the worktree half is the in-repo proteus-worktree.js's`);
  const err = guardProfile(pin);
  if (err) {
    console.error(`proteus-worktree: ${err}; run install.js --sandbox again outside the sandbox`);
    process.exitCode = 1;
  }
}

// the sandbox copy: the profile's Edit deny rules gain the git rules this worktree (and any submodule) now needs,
// which the sandbox's denyWrite takes too; "" or why not. The profile is written only inside proteus-sandbox/,
// never through a link
function guardProfile(p) {
  const home = path.dirname(path.dirname(__dirname)), file = String(p.profile || "");
  if (!file || !C.inside(path.resolve(file), home)) return `sandbox-root.json names no profile inside ${home}`;
  let cur;
  try { cur = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return `cannot read ${file} (${e.message})`; }
  const perms = cur.permissions || (cur.permissions = {});
  const deny = Array.isArray(perms.deny) ? perms.deny : (perms.deny = []);
  const add = C.gitDenyRules(String(p.common)).filter((r) => !deny.includes(r));
  if (!add.length) return "";
  deny.push(...add);
  return C.writeFile(file, JSON.stringify(cur, null, 2) + "\n", [home]) ? "" : `cannot add the deny rules to ${file}`;
}

// why the sandbox copy refuses arg ("" when it is a worktree of pin.root it may prepare), after pinning the project
// to pin; hoisted for the top. No git runs here: the registered worktrees are read under the pinned common dir
function sandboxRefusal(arg, p) {
  const under = (child, parent) => C.inside(child, parent) && !C.samePath(child, parent);
  const named = (k) => (p && typeof p[k] === "string" && path.isAbsolute(p[k]) ? C.real(p[k]) : null);
  const root = named("root"), common = named("common");
  if (!root || !common) return `${PIN} names no repo that exists; run install.js --sandbox again outside the sandbox`;
  lib.pinProject(root, common);
  if (!C.samePath(lib.mainRoot(common) || "", root)) return `${PIN}: ${root} is not the main checkout of ${common}`;
  const nest = path.join(root, ".worktrees");
  const wt = arg ? C.real(path.resolve(arg)) : null;
  if (!wt || !under(wt, nest)) return `${arg || "(no worktree)"} is not a checkout under ${nest}`;
  const co = lib.checkoutOf(wt);
  if (!co || co.gitDir === common || !C.samePath(co.root, wt)) return `${wt} is not a worktree ${common} registers`;
  const link = (q) => {
    const s2 = C.lstat(q);
    if (!s2) return "";
    if (s2.isSymbolicLink()) return q;
    if (s2.isDirectory()) for (const n of fs.readdirSync(q)) { const l = link(path.join(q, n)); if (l) return l; }
    return "";
  };
  // under the common dir only: the copy opens nothing in the worktree
  for (const d of [path.join(co.gitDir, "proteus-hooks"), path.join(co.gitDir, "config.worktree"), path.join(common, "info"), path.join(common, "config"), path.join(common, "proteus", "allow")]) {
    const l = link(d);
    if (l) return `${l} is a link, which this copy will not write through`;
  }
  for (const d of [path.join(common, "proteus")]) { const s3 = C.lstat(d); if (s3 && s3.isSymbolicLink()) return `${d} is a link, which this copy will not write through`; }
  return "";
}

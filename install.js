#!/usr/bin/env node
// Install, update or check the Proteus skill for Claude Code or Codex, on any OS (Node 22.5+, which context-mode needs).
// install.sh and install.ps1 are thin wrappers around this file.
//
//   node install.js                   link skills/{proteus,proteus-review} into ~/.claude/skills
//                                     (every repo; `git pull` here updates them), copy agents/*.md
//                                     to ~/.claude/agents, record this checkout in ~/.claude/proteus.json,
//                                     install the required context-mode plugin through the claude CLI
//   node install.js --project         also set up the current repo: teams/<profile>/ with skills
//                                     linked per skills.txt, the lead's hooks in
//                                     .claude/settings.local.json (PROTEUS=0 claude skips them);
//                                     removes project copies of the skill and unmodified agents
//   node install.js --project --install   also `npx skills add` any skill not on this machine
//   node install.js --project --confine   also remove the global ~/.claude/skills/<name> link
//                                         for every linked skill, so the lead never sees it
//   node install.js --update          git pull --ff-only this checkout, reinstall, and refresh the
//                                     current repo too if it is a Proteus project
//   node install.js --auto-update     let the SessionStart hook pull this checkout (off by default);
//   node install.js --no-auto-update  both run the global install and persist the choice
//   node install.js --doctor [--fix]  check the setup; --fix applies the safe local fixes
//   node install.js --tour-done       record the tour as taken (the lead runs it when the tour ends
//                                     or is skipped); the session start stops offering it until
//                                     a new feature lands
//   node install.js --agent-login [dir]   sign in the agents' own GitHub account (a machine user you created) in a gh
//                                     config dir of its own (default ~/.config/gh-proteus), token in a file there;
//                                     records it and your login in ~/.claude/proteus.json. From the next session every
//                                     agent shell command runs gh as that account; you keep yours
//   node install.js --protect         in a repo you administer: invite the agents' account with write access and
//                                     add the "proteus runs" ruleset (a PR with the gates check green, no force push,
//                                     no bypass, admins included) to every proteus/* branch
//   --harness codex                   any of the above for OpenAI Codex CLI instead (or PROTEUS_HARNESS=codex;
//                                     default claude): skills linked into ~/.agents/skills, agents as
//                                     TOML in $CODEX_HOME/agents, the lead's hooks in .codex/hooks.json
//                                     and .codex/rules/proteus.rules, ../<repo>-proteus writable in
//                                     .codex/config.toml; --update reinstalls every
//                                     harness recorded in ~/.claude/proteus.json
//   --scan <dir>                      where to look for repos still on hivemind (default ~/Projects)
//   --migrate-all                     also move every repo found there from hivemind to Proteus
//
// Proteus was called hivemind. Any install takes over from it: the old skill links, generated
// agents and hivemind.json go (edited agents stay and are named), --project removes the
// repo's hive-*.js hooks and their registrations before installing its own, and moves hivemind's
// state dir under .git into .git/proteus (never over a file already there; --doctor names what
// stays). A run opened under hivemind keeps its branch, labels and worktree folder until it closes.
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const L = require(path.join(__dirname, "templates", "teams", "link-skills.js"));
const { WIN, lstat, real, isDir, isFile, samePath, linkDir } = L;

const HERE = __dirname;
// the shipped roster; teams/ in any repo, this checkout included, is that repo's own
const SHIPPED_TEAMS = path.join(HERE, "templates", "teams");
const HOME = os.homedir();
const CLAUDE = path.join(HOME, ".claude");
const SKILLS = ["proteus", "proteus-review"];
const LINK_SCRIPTS = ["link-skills.js", "link-skills.sh", "link-skills.ps1"];
const EXCLUDE = [".claude/settings.local.json", ".claude/hooks/proteus-*.js", ".claude/hooks/worktree-settings.local.json", ".claude/proteus-owned"];
const TEAMS_ENV = "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS";
const CTX_PLUGIN = "context-mode@context-mode";
const CTX_MARKET = "mksglu/context-mode";
const NODE_MIN = "22.5.0";
const HARNESSES = ["claude", "codex"];
const AGENTS_SKILLS = path.join(HOME, ".agents", "skills"); // Codex reads skills here and in <repo>/.agents/skills
const CODEX_EXCLUDE = [".codex/hooks.json", ".codex/hooks/proteus-*.js", ".codex/rules/proteus.rules", ".codex/proteus-owned"];
// the commit-msg gate runs from here on every CLI: committed with teams/, refreshed by --project
const COMMIT_MSG = "teams/templates/hooks/commit-msg.js";
const CODEX_CTX = "codex mcp add context-mode --env CONTEXT_MODE_PLATFORM=codex -- npx -y context-mode";
const GENERATED = "# generated by proteus";
// hivemind, the old name: what its installs left behind (see "takeover" below)
const OLD_SKILLS = ["hivemind", "hivemind-review"];
const OLD_CONFIG = path.join(CLAUDE, "hivemind.json");
const OLD_GENERATED = "# generated by hivemind";
const OLD_HOOK = /^hive-[\w-]+\.js$/;
const OLD_EXCLUDE = [".claude/hooks/hive-*.js", ".claude/hive-owned", ".codex/hooks/hive-*.js", ".codex/rules/hivemind.rules", ".codex/hive-owned",
  "/.claude/hive-owned", "/.claude/hooks/hive-*.js", "/.codex/hive-owned", "/.codex/hooks/hive-*.js", "# hivemind: machine-local worker files"];
const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, ".codex");
// sha256 (LF line endings) of templates/hooks/settings.local.json as shipped before its rename
const OLD_WORKER_SETTINGS = "365bfd02b83f795a76f0656aeb238f7295c0194dad2babce80ef37bba5692542";

let quiet = false;
let HARNESS = "claude"; // --harness, else PROTEUS_HARNESS; set in main
const codex = () => HARNESS === "codex";
// the Codex adapter reads CODEX_HOME when loaded: only on the codex path
let cxAd = null;
const cx = () => cxAd || (cxAd = require(path.join(HERE, "templates", "hooks", "proteus-harness-codex.js")));
const log = (s = "") => { if (!quiet) console.log(s); };
const warn = (s) => console.error(s);
const die = (s, code = 1) => { warn(s); process.exit(code); };

// helpers

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["inherit", "pipe", "pipe"] });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}
function has(cmd, args = ["--version"]) {
  const r = spawnSync(cmd, args, { encoding: "utf8", shell: WIN, timeout: 20000 });
  return r.status === 0 ? (r.stdout || "").trim() : null;
}
const norm = (s) => s.replace(/\r\n/g, "\n");
const readText = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
const inside = (child, parent) => { const r = path.relative(parent, child); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };

// deletes (#13): every one goes through safeRemove, limited to allowedRoots
// realpath of the deepest existing ancestor, the rest joined on: a path that does not exist yet resolves too
const realish = (p) => { const a = path.resolve(p), r = real(a); if (r) return r; const d = path.dirname(a); return d === a ? a : path.join(realish(d), path.basename(a)); };
const userHome = () => { try { return realish(os.userInfo().homedir); } catch { return null; } };

// the target's Proteus-owned paths and the project's git toplevel; a toplevel holding a home would open all of it
function allowedRoots(home, codexHome, projectTop) {
  const h = realish(home), u = userHome();
  const roots = [[".claude", "skills"], [".claude", "agents"], [".agents", "skills"], [".claude", "proteus.json"], [".claude", "hivemind.json"]].map((p) => realish(path.join(h, ...p)));
  roots.push(realish(path.join(codexHome, "agents")));
  const top = projectTop ? realish(projectTop) : null;
  if (top && !inside(h, top) && !(u && inside(u, top))) roots.push(top);
  return roots;
}

// whether safeRemove refuses p: outside roots, a root dir itself, or in the user's real home while HOME is elsewhere
function refused(p, roots) {
  const a = path.resolve(p), r = path.join(realish(path.dirname(a)), path.basename(a)), u = userHome();
  return (u && inside(r, u) && !inside(realish(HOME), u)) || !roots.some((x) => (samePath(x, r) ? !isDir(x) : inside(r, x)));
}

// true if p was removed; false if absent or refused; never throws
function safeRemove(p, roots) {
  try {
    const st = lstat(p);
    if (!st) return false;
    if (refused(p, roots)) {
      warn(`refused  ${p} (outside what Proteus owns for HOME=${HOME}; left alone)`);
      return false;
    }
    if (!st.isSymbolicLink()) fs.rmSync(p, { recursive: true, force: true });
    else {
      // a link, never what it points to; a junction needs rmdir, which refuses a real directory
      try { fs.unlinkSync(p); } catch (e) { if (e.code !== "EPERM" && e.code !== "EISDIR") throw e; fs.rmdirSync(p); }
    }
    return true;
  } catch (e) {
    warn(`warning: ${p} not removed: ${e.message}`);
    return false;
  }
}

// the git toplevel of the repo being set up, set by withProject; null outside one
let PROJECT = null;
const ownedRoots = () => allowedRoots(HOME, CODEX_HOME, PROJECT);
// link-skills.js's removals, when this process drives them (#13)
const guardedRemove = (p) => safeRemove(p, ownedRoots());
function withProject(dir, fn) {
  const was = PROJECT, top = git(["rev-parse", "--show-toplevel"], dir);
  PROJECT = top.ok && top.out ? top.out : null;
  try { return fn(); } finally { PROJECT = was; }
}

// {} when missing or empty, null when not a JSON object
function readJson(file) {
  const t = readText(file);
  if (t === null || !t.trim()) return {};
  try {
    const v = JSON.parse(t.replace(/^﻿/, ""));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch { return null; }
}
function writeJson(file, v) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(v, null, 2) + "\n");
}

function frontmatterName(dir) {
  const t = readText(path.join(dir, "SKILL.md"));
  const fm = t && /^---\r?\n([\s\S]*?)\r?\n---/.exec(t);
  const m = fm && /^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(fm[1]);
  return m ? m[1] : null;
}

// copy unless identical; a link at dest is replaced, never written through
function copyFile(src, dest) {
  const st = lstat(dest);
  if (st && !st.isSymbolicLink() && fs.readFileSync(src).equals(fs.readFileSync(dest))) return;
  if (st && st.isSymbolicLink() && !safeRemove(dest, ownedRoots())) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}
// skip: source paths left out, with everything under them
function copyTree(src, dest, skip = []) {
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (skip.some((x) => samePath(s, x))) continue;
    if (e.isDirectory()) copyTree(s, d, skip); else copyFile(s, d);
  }
}

const shippedAgents = () => fs.readdirSync(path.join(HERE, "agents")).filter((f) => f.endsWith(".md")).sort();
const isProteusProject = (dir, h = "claude") => isDir(path.join(dir, "teams")) && isFile(path.join(dir, `.${h}`, "hooks", "proteus-autostart.js"));

function envCommand() {
  if (WIN) return `[Environment]::SetEnvironmentVariable("${TEAMS_ENV}", "1", "User")`;
  const sh = path.basename(process.env.SHELL || "");
  if (sh === "fish") return `set -Ux ${TEAMS_ENV} 1`;
  return `echo 'export ${TEAMS_ENV}=1' >> ~/.${sh === "zsh" ? "zshrc" : "bashrc"}`;
}
function teamsEnvOn() {
  const s = readJson(path.join(CLAUDE, "settings.json"));
  return process.env[TEAMS_ENV] === "1" || String(s && s.env && s.env[TEAMS_ENV]) === "1";
}

// global install

function linkSkills(dir = path.join(CLAUDE, "skills")) {
  let ok = true;
  fs.mkdirSync(dir, { recursive: true });
  for (const s of SKILLS) {
    const target = real(path.join(HERE, "skills", s));
    const link = path.join(dir, s);
    const st = lstat(link);
    if (st && !st.isSymbolicLink()) {
      // an old installer's copy is replaced; anything else is someone else's
      if (!st.isDirectory() || frontmatterName(link) !== s || inside(HERE, link)) {
        warn(`error: ${link} is not an old copy of the ${s} skill; move it away and re-run`);
        ok = false;
        continue;
      }
      if (!safeRemove(link, ownedRoots())) { ok = false; continue; }
      log(`removed  ${link} (old copy, replaced by a link)`);
    } else if (st && !samePath(real(link), target) && !safeRemove(link, ownedRoots())) { ok = false; continue; }
    linkDir(target, link, guardedRemove);
  }
  if (ok) log(`skills   -> ${path.join(dir, "{proteus,proteus-review}")} linked to ${path.join(real(HERE), "skills")}`);
  return ok;
}

function copyAgents() {
  const dir = path.join(CLAUDE, "agents");
  const files = shippedAgents();
  for (const f of files) copyFile(path.join(HERE, "agents", f), path.join(dir, f));
  // only what ships is overwritten; other agents there survive
  log(`agents   -> ${dir} (${files.length} shipped, others untouched)`);
}

function setAttribution() {
  const file = path.join(CLAUDE, "settings.json");
  const s = readJson(file);
  if (!s) {
    warn(`warning: ${file} is not valid JSON; left alone. Add by hand:`);
    warn('  "attribution": { "commit": "", "pr": "", "sessionUrl": false }');
    return false;
  }
  const want = { ...s.attribution, commit: "", pr: "", sessionUrl: false };
  if (JSON.stringify(s.attribution) !== JSON.stringify(want)) { s.attribution = want; writeJson(file, s); }
  log("settings -> attribution disabled");
  return true;
}

// ~/.claude/proteus.json: { home, autoUpdate, ...keys the hooks own }
const CONFIG = path.join(CLAUDE, "proteus.json");
function readConfig() {
  const c = readJson(CONFIG);
  if (!c) warn(`warning: ${CONFIG} was not valid JSON; rewritten`);
  return c || {};
}

function writeConfig({ autoUpdate } = {}) {
  const c = readConfig();
  const next = { ...c, home: real(HERE), autoUpdate: autoUpdate ?? (typeof c.autoUpdate === "boolean" ? c.autoUpdate : false) };
  if (!lstat(CONFIG)) next.toured = ""; // first install: the first-time tour; a missing key means an install from before the tour
  // harnesses: every CLI installed here, for --update; absent means claude only
  if (HARNESS !== "claude" || Array.isArray(c.harnesses)) {
    const had = Array.isArray(c.harnesses) ? c.harnesses : c.home ? ["claude"] : [];
    next.harnesses = [...new Set([...had, HARNESS])].filter((h) => HARNESSES.includes(h)).sort();
  }
  delete next.laya; delete next.layaOffered; // keys of a removed option
  if (JSON.stringify(next) !== JSON.stringify(c)) writeJson(CONFIG, next);
  log(`config   -> ${CONFIG} (autoUpdate ${next.autoUpdate})`);
}

function globalInstall(config) {
  const ok = linkSkills();
  copyAgents();
  writeConfig(config);
  installContextMode(); // required, but a missing claude CLI is not fatal: --doctor keeps failing until it is there
  return setAttribution() && ok;
}

// Codex: shipped agents as TOML roles in $CODEX_HOME/agents. A file there without the generated
// header is the user's own and never overwritten.
const codexAgents = () => shippedAgents().map((f) => cx().agentFile(f, fs.readFileSync(path.join(HERE, "agents", f), "utf8"))).filter(Boolean);
function codexAgentState() {
  const dir = cx().agentsDir, stale = [], kept = [];
  for (const a of codexAgents()) {
    const t = readText(path.join(dir, a.name));
    if (t !== null && norm(t) === a.text) continue;
    if (t !== null && !norm(t).startsWith(GENERATED)) kept.push(path.join(dir, a.name)); else stale.push(a);
  }
  return { dir, stale, kept };
}
function copyCodexAgents() {
  const { dir, stale, kept } = codexAgentState();
  for (const a of stale) {
    const p = path.join(dir, a.name);
    if (lstat(p) && lstat(p).isSymbolicLink() && !safeRemove(p, ownedRoots())) continue;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p, a.text);
  }
  for (const p of kept) log(`local override kept: ${p} (not generated by proteus; delete it to use the shipped one)`);
  log(`agents   -> ${dir} (${codexAgents().length} shipped as TOML, others untouched)`);
}

function codexGlobalInstall(config) {
  const ok = linkSkills(AGENTS_SKILLS);
  copyCodexAgents();
  writeConfig(config);
  return ok;
}

// [projects."<root>"] trust_level = "trusted" in $CODEX_HOME/config.toml, written when the human trusts it
function codexTrusted(root) {
  const want = [root, real(root)].filter(Boolean);
  let inRoot = false;
  for (const l of (readText(path.join(cx().home, "config.toml")) || "").split(/\r?\n/)) {
    const h = /^\s*\[\s*projects\.(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*\]\s*(#.*)?$/.exec(l);
    if (h) { let k = h[2]; if (h[1] !== undefined) { try { k = JSON.parse(`"${h[1]}"`); } catch { k = h[1]; } } inRoot = want.some((w) => samePath(k, w)); continue; }
    if (/^\s*\[/.test(l)) { inRoot = false; continue; }
    if (inRoot && /^\s*trust_level\s*=\s*["']trusted["']/.test(l)) return true;
  }
  return false;
}

// what the installer cannot do: trust and hook approval happen in Codex, by the human
function codexSteps(root, project) {
  const steps = [];
  if (project && !codexTrusted(root)) steps.push("open codex in this repo and trust it: project .codex/ config and hooks load only in a trusted project");
  if (project) steps.push("approve the Proteus hooks in /hooks (Codex asks again only when a hook entry changes)");
  if (!cx().contextModeOn()) steps.push(`add the required context-mode MCP server: ${CODEX_CTX}`);
  if (!steps.length) return;
  log("");
  log("Once, in Codex:");
  steps.forEach((s, i) => log(`  ${i + 1}. ${s}`));
}

const nodeOk = (v = process.versions.node) => {
  const [a, b] = v.split(".").map(Number), [ma, mb] = NODE_MIN.split(".").map(Number);
  return a > ma || (a === ma && b >= mb);
};
const nodeFix = () => (WIN ? "winget install OpenJS.NodeJS.LTS" : "brew install node | sudo pacman -S nodejs npm | nvm install --lts | https://nodejs.org");

// context-mode: installed per ~/.claude/plugins/installed_plugins.json, enabled per settings.json; read only
function contextMode() {
  const inst = readJson(path.join(CLAUDE, "plugins", "installed_plugins.json")) || {};
  const known = readJson(path.join(CLAUDE, "plugins", "known_marketplaces.json")) || {};
  const s = readJson(path.join(CLAUDE, "settings.json")) || {};
  const installed = !!(inst.plugins && Array.isArray(inst.plugins[CTX_PLUGIN]) && inst.plugins[CTX_PLUGIN].length);
  const enabled = !!(s.enabledPlugins && s.enabledPlugins[CTX_PLUGIN] === true);
  return { installed, enabled, known: !!known[CTX_PLUGIN.split("@")[1]] };
}
function contextModeSteps(c = contextMode()) {
  return [
    ...(c.installed || c.known ? [] : [["plugin", "marketplace", "add", CTX_MARKET]]),
    c.installed ? ["plugin", "enable", CTX_PLUGIN, "--scope", "user"] : ["plugin", "install", CTX_PLUGIN, "--scope", "user"],
  ];
}
// through the claude CLI, never by editing settings.json; false (with the commands printed) when it did not take
function installContextMode() {
  const c = contextMode();
  if (c.installed && c.enabled) { log(`plugin   -> ${CTX_PLUGIN} enabled`); return true; }
  const steps = contextModeSteps(c);
  for (const args of steps) {
    const r = spawnSync("claude", args, { stdio: quiet ? "pipe" : "inherit", shell: WIN, timeout: 300000 });
    if (r.status !== 0) break;
  }
  const after = contextMode();
  if (after.installed && after.enabled) { log(`plugin   -> ${CTX_PLUGIN} installed`); return true; }
  warn(`warning: the required context-mode plugin is not ${after.installed ? "enabled" : "installed"}. Run:`);
  for (const args of steps) warn(`  claude ${args.join(" ")}`);
  return false;
}

// project

// Copies of the skill, and unmodified copies of shipped agents, in <dir>/.claude.
// Returns { dupes: [path], overrides: [path] }; act removes the dupes, and dupes lists only those removed.
function projectDupes(dir, act) {
  const dupes = [], overrides = [];
  if (samePath(real(dir), real(HOME))) return { dupes, overrides }; // ~/.claude is the global install
  for (const s of SKILLS) {
    const p = path.join(dir, codex() ? ".agents" : ".claude", "skills", s);
    const st = lstat(p);
    if (!st) continue;
    if (st.isSymbolicLink() || (st.isDirectory() && frontmatterName(p) === s && !inside(HERE, p))) { if (!act || safeRemove(p, ownedRoots())) dupes.push(p); }
  }
  for (const f of codex() ? [] : shippedAgents()) {
    const p = path.join(dir, ".claude", "agents", f);
    const t = readText(p);
    if (t === null) continue;
    if (norm(t) === norm(fs.readFileSync(path.join(HERE, "agents", f), "utf8")) || pastShipped(`agents/${f}`, t)) {
      if (!act || safeRemove(p, ownedRoots())) dupes.push(p);
    } else overrides.push(p);
  }
  return { dupes, overrides };
}

// A file identical to a version this checkout once shipped (rel: its path here, e.g.
// agents/hive-guide.md) is an old installer's copy, not an edit; with no text, whether rel ever
// shipped. Needs the checkout's git history, so a non-git copy of Proteus never matches.
let pastHashes = null;
const hashText = (s) => crypto.createHash("sha256").update(norm(s).trimEnd()).digest("hex");
function pastShipped(rel, text) {
  if (!pastHashes) {
    pastHashes = new Map();
    const r = git(["log", "--format=%H", "--name-only", "--no-renames", "--", "agents", "templates/hooks"], HERE);
    const want = [];
    let c = null;
    for (const l of r.ok ? r.out.split("\n") : []) {
      if (/^[0-9a-f]{40}$/.test(l)) c = l;
      else if (l && c) want.push(`${c}:${l}`);
    }
    // one git process for every blob: "<sha> blob <size>\n<bytes>\n", or "<name> missing\n"
    const out = want.length ? spawnSync("git", ["cat-file", "--batch"], { cwd: HERE, input: want.join("\n") + "\n", maxBuffer: 1 << 30 }).stdout : null;
    let at = 0;
    for (const w of out ? want : []) {
      const nl = out.indexOf(10, at);
      const head = out.toString("utf8", at, nl).split(" ");
      at = nl + 1;
      if (head[1] !== "blob") continue;
      const size = Number(head[2]), f = w.slice(41);
      if (!pastHashes.has(f)) pastHashes.set(f, new Set());
      pastHashes.get(f).add(hashText(out.toString("utf8", at, at + size)));
      at += size + 1;
    }
  }
  const h = pastHashes.get(rel);
  return text === undefined ? !!h : !!h && h.has(hashText(text));
}

function registerHooks(root) {
  const script = path.join(HERE, "templates", "hooks", "install-lead-hooks.js");
  // the adapter's skipped files (Codex's only; Claude's list is empty) an older install copied go here,
  // through safeRemove; the script then removes none
  withProject(root, () => {
    for (const f of codex() ? cx().skipHooks : []) {
      const p = path.join(cx().hooksDir(root), f), st = lstat(p);
      if (st && st.isFile() && safeRemove(p, ownedRoots())) log(`removed  ${path.relative(root, p).split(path.sep).join("/")} (unused by ${HARNESS})`);
    }
  });
  const env = { ...process.env, PROTEUS_HARNESS: HARNESS, PROTEUS_KEEP_SKIPPED: "1" };
  const r = spawnSync(process.execPath, [script], { cwd: root, env, stdio: quiet ? "pipe" : "inherit", encoding: "utf8" });
  if (r.status === 0) return true;
  warn(`error: ${script} exited ${r.status ?? r.error}; lead hooks may be missing`);
  if (quiet && r.stderr) warn(r.stderr.trim());
  return false;
}

function excludeLocal(root, list = EXCLUDE, what = "settings.local.json, Proteus hooks, proteus-owned") {
  const r = git(["rev-parse", "--git-common-dir"], root);
  if (!r.ok) { log("exclude  -> skipped (not a git repo)"); return; }
  const file = path.join(path.resolve(root, r.out), "info", "exclude");
  let text = readText(file) || "";
  const have = text.split(/\r?\n/);
  const add = list.filter((l) => !have.includes(l));
  if (add.length) {
    if (text && !text.endsWith("\n")) text += "\n";
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text + add.join("\n") + "\n");
  }
  log(`exclude  -> ${path.relative(root, file) || file} (${what})`);
}

// teams/.gitignore is the repo's once copied; a pattern shipped since (a new CLI's skill links)
// is appended. Returns the patterns missing; act writes them.
function teamsIgnore(teams, act) {
  const ign = path.join(teams, ".gitignore"), text = readText(ign);
  const have = (text || "").split(/\r?\n/);
  const add = fs.readFileSync(path.join(SHIPPED_TEAMS, ".gitignore"), "utf8").split(/\r?\n/).filter((l) => l && !l.startsWith("#") && !have.includes(l));
  if (act && text === null) fs.copyFileSync(path.join(SHIPPED_TEAMS, ".gitignore"), ign);
  else if (act && add.length) fs.appendFileSync(ign, (text && !text.endsWith("\n") ? "\n" : "") + add.join("\n") + "\n");
  return add;
}

function copyTeams(root) {
  const teams = path.join(root, "teams");
  // self-host: the checkout's own templates/ and link scripts are the source, never copied into git
  const self = samePath(real(root), real(HERE));
  fs.mkdirSync(teams, { recursive: true });
  teamsIgnore(teams, true);
  if (!self) for (const f of LINK_SCRIPTS) copyFile(path.join(SHIPPED_TEAMS, f), path.join(teams, f));
  copyTree(path.join(HERE, "templates"), path.join(teams, "templates"), [SHIPPED_TEAMS]);
  if (self) excludeLocal(root, ["teams/templates/"], "teams/templates, a copy of this checkout's templates/");
  // renamed to worktree-settings.local.json; drop the old copy only if nobody edited it
  const stale = path.join(teams, "templates", "hooks", "settings.local.json");
  const t = readText(stale);
  if (t !== null && !isFile(path.join(HERE, "templates", "hooks", "settings.local.json"))
      && crypto.createHash("sha256").update(norm(t)).digest("hex") === OLD_WORKER_SETTINGS && safeRemove(stale, ownedRoots())) {
    log("removed  teams/templates/hooks/settings.local.json (renamed to worktree-settings.local.json)");
  }
  // the routing table is the repo's once copied, like PROFILE.md
  if (!lstat(path.join(teams, "ROUTING.md"))) fs.copyFileSync(path.join(SHIPPED_TEAMS, "ROUTING.md"), path.join(teams, "ROUTING.md"));
  for (const p of L.profiles(SHIPPED_TEAMS)) {
    const src = path.join(SHIPPED_TEAMS, p), dest = path.join(teams, p);
    fs.mkdirSync(dest, { recursive: true });
    for (const f of ["PROFILE.md", "skills.txt"]) {
      if (isFile(path.join(src, f)) && !lstat(path.join(dest, f))) fs.copyFileSync(path.join(src, f), path.join(dest, f));
    }
    // required.txt is the pipeline's, not the scout's or the repo's: always refreshed
    if (isFile(path.join(src, "required.txt"))) copyFile(path.join(src, "required.txt"), path.join(dest, "required.txt"));
  }
  log(`teams    -> ${teams} (ROUTING.md, PROFILE.md, skills.txt, ${self ? "" : "link-skills.*, "}templates/)`);
}

function projectInstall(root, opt) {
  const { dupes, overrides } = projectDupes(root, true);
  for (const p of dupes) log(`removed  ${path.relative(root, p).split(path.sep).join("/")} (duplicate of the global install)`);
  for (const p of overrides) log(`local override kept: ${path.relative(root, p).split(path.sep).join("/")} (differs from shipped; delete it to use the shipped one)`);
  copyTeams(root);
  L.run({ root, install: !!opt.install, confine: !!opt.confine, log, remove: guardedRemove });
  // lead autostart + guard: machine-local, never tracked, so worker worktrees do not inherit them
  const ok = registerHooks(root);
  if (codex()) {
    const w = sandboxRoots(root);
    // a config.toml the repo already had may be tracked or the user's: never exclude it
    excludeLocal(root, w.created ? [...CODEX_EXCLUDE, ".codex/config.toml"] : CODEX_EXCLUDE, `hooks.json, Proteus hooks, rules, proteus-owned${w.created ? ", config.toml" : ""}`);
    return ok && !w.error;
  }
  excludeLocal(root);
  return ok;
}

// workspace-write keeps a Codex worker out of ../<repo>-proteus/ unless the project names it
function sandboxRoots(root) {
  const w = cx().sandboxRoots(root);
  if (w.error) warn(`warning: ${w.error}`);
  else log(`sandbox  -> ${path.relative(root, w.file).split(path.sep).join("/")} (${w.changed ? `${w.created ? "created, " : ""}worker worktrees in ${w.dir} writable` : "worktree folder already writable"})`);
  if (w.stale) log(`sandbox  -> ${w.stale} dropped from writable_roots (no worktree of a pre-rename run is left in it)`);
  if (w.legacy) log(`sandbox  -> ${w.legacy.dir} kept in writable_roots: a pre-rename run still has worktrees there (${w.legacy.worktrees.join(", ")}); the next --project drops it once they are gone`);
  return w;
}

// hook-side helpers (state dir, run branches, legacy names), loaded only where used
const hl = () => require(path.join(HERE, "templates", "hooks", "proteus-lib.js"));

const commonDir = (root) => { const x = git(["rev-parse", "--git-common-dir"], root); return x.ok && x.out ? path.resolve(root, x.out) : null; };
// the legacy state dir of the repo at root when it exists, else null
const legacyState = (root) => { const c = commonDir(root), d = c && hl().legacyStateDir(c); return d && isDir(d) ? d : null; };

// state a pre-rename install left in the legacy state dir moves into <git-common-dir>/proteus,
// never over a file already there (the *.jsonl logs merge); what stays is named here and by --doctor
function migrateState(root) {
  const common = commonDir(root);
  if (!common) return;
  const lib = hl();
  const from = path.relative(root, lib.legacyStateDir(common)), to = path.relative(root, lib.stateDir(common));
  let r;
  try { r = lib.migrateState(common); } catch (e) { warn(`warning: ${from} not moved: ${e.message}; install.js --doctor names what is left`); return; }
  if (r.moved.length) log(`state    -> ${from} moved into ${to} (${r.moved.join(", ")})`);
  if (r.merged.length) log(`state    -> ${from}: ${r.merged.join(", ")} appended into ${to} (older lines first, each line once)`);
  for (const line of stateLeft(r, from, to)) warn(line);
}

// what a state migration left in the legacy dir, and why, one line each
function stateLeft(r, from, to) {
  return [
    r.kept.length && `kept     ${from}: ${r.kept.join(", ")} (also in ${to}, whose copy is the one in use; delete the old copy once you have compared them)`,
    r.held.length && `kept     ${from}: ${r.held.join(", ")} (a registered git worktree, left where git has it; the rest moves once \`git worktree remove\` drops it)`,
    r.failed.length && `failed   ${from}: ${r.failed.join(", ")} (not movable now; the next --project retries)`,
  ].filter(Boolean);
}

// takeover: Proteus was called hivemind. An install removes only what hivemind's installs
// created; anything edited or of unclear origin stays and is named.

// shared helpers read HARNESS: run fn as if --harness h was given
function withHarness(h, fn) {
  const was = HARNESS;
  HARNESS = h;
  try { return fn(); } finally { HARNESS = was; }
}
// a skill dir that is a link, or a copy an old installer made, never a real dir of the user's
const oldSkillCopy = (p, name) => { const st = lstat(p); return !!st && (st.isSymbolicLink() || (st.isDirectory() && frontmatterName(p) === name && !inside(HERE, p))); };
const listDir = (d, re) => (isDir(d) ? fs.readdirSync(d).filter((f) => re.test(f)).sort() : []);
const oldHarnesses = (c) => (!c ? [] : Array.isArray(c.harnesses) ? c.harnesses.filter((h) => HARNESSES.includes(h)) : c.home ? ["claude"] : []);

// hivemind.json becomes proteus.json, a key in both keeping its proteus value; returns the old config
function migrateConfig() {
  if (!lstat(OLD_CONFIG)) return null;
  const old = readJson(OLD_CONFIG), cur = readJson(CONFIG);
  if (!old || !cur) { warn(`warning: ${old ? CONFIG : OLD_CONFIG} is not valid JSON; ${OLD_CONFIG} left in place, merge it into ${CONFIG} by hand`); return null; }
  writeJson(CONFIG, { ...old, ...cur });
  log(`config   -> ${OLD_CONFIG} merged into ${CONFIG}${safeRemove(OLD_CONFIG, ownedRoots()) ? " and removed" : "; left in place"}`);
  if (typeof old.home === "string" && !samePath(real(old.home) || old.home, real(HERE))) log(`note     : ${old.home} (the hivemind checkout) is no longer used; delete it when you like`);
  return old;
}

// hivemind's global pieces for both CLIs: skill links or copies, generated agents.
// Returns { found, kept, harnesses }; act removes found.
function oldGlobal(act) {
  const found = [], kept = [], harnesses = new Set();
  const drop = (p, h) => { if (act && !safeRemove(p, ownedRoots())) kept.push(`${p} (refused: outside what Proteus owns)`); else { found.push(p); harnesses.add(h); } };
  for (const [h, dir] of [["claude", path.join(CLAUDE, "skills")], ["codex", AGENTS_SKILLS]]) {
    for (const s of OLD_SKILLS) {
      const p = path.join(dir, s);
      if (oldSkillCopy(p, s)) drop(p, h);
      else if (lstat(p)) kept.push(`${p} (not a link or a copy of hivemind's skill)`);
    }
  }
  // an agent name hivemind never shipped is the user's own: not ours to mention
  const md = path.join(CLAUDE, "agents");
  for (const f of listDir(md, /^hive-[\w-]+\.md$/)) {
    const p = path.join(md, f), t = readText(p);
    if (!pastShipped(`agents/${f}`)) continue;
    if (t !== null && pastShipped(`agents/${f}`, t)) drop(p, "claude");
    else kept.push(`${p} (edited; Proteus spawns proteus-${f.slice(5)})`);
  }
  const toml = path.join(CODEX_HOME, "agents");
  for (const f of listDir(toml, /^hive-[\w-]+\.toml$/)) {
    const p = path.join(toml, f), t = readText(p);
    if (t !== null && norm(t).startsWith(OLD_GENERATED)) drop(p, "codex");
    else if (pastShipped(`agents/${f.replace(/\.toml$/, ".md")}`)) kept.push(`${p} (not generated by hivemind; Proteus spawns proteus-${f.slice(5)})`);
  }
  return { found, kept, harnesses };
}

// hivemind's global pieces out, Proteus in for every CLI hivemind was set up for (and those in also)
function takeoverGlobal(config, also = []) {
  const old = migrateConfig();
  const g = oldGlobal(true);
  for (const p of g.found) log(`removed  ${p} (hivemind's; Proteus replaces it)`);
  for (const p of g.kept) log(`kept     ${p}`);
  let ok = true;
  for (const h of new Set([HARNESS, ...also, ...g.harnesses, ...oldHarnesses(old)])) {
    if (h !== HARNESS) log(`takeover -> Proteus for ${h} too (hivemind was set up for it)`);
    ok = withHarness(h, () => (codex() ? codexGlobalInstall(config) : globalInstall(config))) && ok;
  }
  return { ok, old };
}

// hivemind's pieces in a repo: its hooks and their registrations, the Codex rules file, copies
// of its skill and agents, its hooks under teams/templates, its .git/info/exclude lines.
// Returns { found, kept, harnesses }; act removes found (paths relative to root).
const OLD_CMD = /\.(claude|codex)[\\/]hooks[\\/]hive-[\w-]+\.js/;
const renameExclude = (l) => l.replace("hivemind", "proteus").replace(/hive-(?=\*|owned)/, "proteus-");
function migrateProject(root, act) {
  const found = [], kept = [], harnesses = new Set();
  const rel = (p) => path.relative(root, p).split(path.sep).join("/");
  const drop = (p, h) => { if (act && !safeRemove(p, ownedRoots())) kept.push(`${rel(p)} (refused: outside what Proteus owns)`); else { found.push(rel(p)); if (h) harnesses.add(h); } };
  const tracked = new Set(git(["ls-files", "--", ".claude/hooks", ".codex/hooks"], root).out.split("\n").filter(Boolean));
  for (const h of HARNESSES) {
    const dir = path.join(root, `.${h}`, "hooks");
    for (const f of listDir(dir, OLD_HOOK)) {
      if (tracked.has(`.${h}/hooks/${f}`)) kept.push(`.${h}/hooks/${f} (tracked by git; delete it in a commit)`);
      else drop(path.join(dir, f), h);
    }
  }
  for (const [h, file] of [["claude", path.join(root, ".claude", "settings.local.json")], ["codex", path.join(root, ".codex", "hooks.json")]]) {
    const text = readText(file);
    if (text === null || !(OLD_CMD.test(text) || /hive-statusline\.js/.test(text))) continue;
    const s = readJson(file);
    if (!s) { kept.push(`${rel(file)} (not valid JSON; remove its hive-*.js hooks by hand)`); continue; }
    let n = 0;
    const hooks = s.hooks && typeof s.hooks === "object" ? s.hooks : {};
    for (const ev of Object.keys(hooks)) {
      if (!Array.isArray(hooks[ev])) continue;
      const before = n;
      // an entry left with no hooks goes too, then an event left with no entries
      hooks[ev] = hooks[ev].filter((e) => {
        if (!e || !Array.isArray(e.hooks)) return true;
        const keep = e.hooks.filter((x) => !(x && OLD_CMD.test(String(x.command))));
        n += e.hooks.length - keep.length;
        const emptied = keep.length < e.hooks.length && !keep.length;
        e.hooks = keep;
        return !emptied;
      });
      if (n > before && !hooks[ev].length) delete hooks[ev];
    }
    // registerLead sets a statusLine only where none is: hivemind's must go first
    if (s.statusLine && /hive-statusline\.js/.test(String(s.statusLine.command))) { delete s.statusLine; n++; }
    if (!n) continue;
    found.push(`${rel(file)}: ${n} hivemind entr${n === 1 ? "y" : "ies"}`);
    harnesses.add(h);
    if (act) writeJson(file, s);
  }
  const rules = path.join(root, ".codex", "rules", "hivemind.rules");
  if (isFile(rules)) drop(rules, "codex");
  for (const [d, h] of [[path.join(root, ".claude", "skills"), "claude"], [path.join(root, ".agents", "skills"), "codex"]]) {
    for (const s of OLD_SKILLS) if (oldSkillCopy(path.join(d, s), s)) drop(path.join(d, s), h);
  }
  const md = path.join(root, ".claude", "agents");
  for (const f of listDir(md, /^hive-[\w-]+\.md$/)) {
    if (!pastShipped(`agents/${f}`)) continue;
    const t = readText(path.join(md, f));
    if (t !== null && pastShipped(`agents/${f}`, t)) drop(path.join(md, f), "claude");
    else kept.push(`${rel(path.join(md, f))} (edited; Proteus spawns proteus-${f.slice(5)})`);
  }
  // the committed copies the gates run from: an unedited one goes (a commit then records it)
  const tpl = path.join(root, "teams", "templates", "hooks");
  for (const f of listDir(tpl, OLD_HOOK)) {
    const t = readText(path.join(tpl, f));
    if (t !== null && pastShipped(`templates/hooks/${f}`, t)) drop(path.join(tpl, f));
    else kept.push(`${rel(path.join(tpl, f))} (edited, or not hivemind's)`);
  }
  // .git/info/exclude is shared by every worktree: while linked ones still run hivemind's hooks,
  // its lines stay beside the renamed ones; a later --doctor --fix drops them
  const x = git(["rev-parse", "--git-common-dir"], root);
  const file = x.ok && path.join(path.resolve(root, x.out), "info", "exclude");
  const text = file && readText(file);
  if (text) {
    const lines = text.split(/\r?\n/);
    const linked = git(["worktree", "list", "--porcelain"], root).out.split("\n").filter((l) => l.startsWith("worktree ")).length > 1;
    const todo = lines.filter((l) => OLD_EXCLUDE.includes(l) && (!linked || !lines.includes(renameExclude(l))));
    if (todo.length) {
      found.push(`${rel(file)}: ${todo.length} hivemind line${todo.length === 1 ? "" : "s"} ${linked ? "renamed, old ones kept for linked worktrees" : "renamed"}`);
      if (act) {
        const next = [];
        for (const l of lines) {
          if (!OLD_EXCLUDE.includes(l)) { next.push(l); continue; }
          if (linked) next.push(l);
          if (!lines.includes(renameExclude(l)) && !next.includes(renameExclude(l))) next.push(renameExclude(l));
        }
        fs.writeFileSync(file, next.join(/\r\n/.test(text) ? "\r\n" : "\n"));
      }
    }
  }
  return { found, kept, harnesses };
}

// a repo from hivemind to Proteus: its old pieces out, then the project install for each CLI
// in base or set up by hivemind there
function migrateRepo(root, opt = {}, base = []) {
  return withProject(root, () => {
    const m = migrateProject(root, true);
    for (const p of m.found) log(`removed  ${p} (hivemind's)`);
    for (const p of m.kept) log(`kept     ${p}`);
    // the moved state is read by new hooks only: every CLI with Proteus hooks here gets them refreshed
    const moved = legacyState(root);
    migrateState(root);
    const set = moved ? HARNESSES.filter((h) => isProteusProject(root, h)) : [];
    let ok = true;
    for (const h of new Set([...base, ...m.harnesses, ...set])) ok = withHarness(h, () => projectInstall(root, { ...opt, confine: opt.confine && h === "claude" })) && ok;
    return ok;
  });
}

// repos under SCAN (3 levels down) whose lead hooks are still hivemind's, or whose Proteus
// install still keeps its state in hivemind's state dir
let SCAN = path.join(HOME, "Projects");
function scanOld(dir = SCAN) {
  const out = [];
  const walk = (d, depth) => {
    if (HARNESSES.some((h) => isFile(path.join(d, `.${h}`, "hooks", "hive-autostart.js")))) out.push(d);
    else if (isDir(hl().legacyStateDir(path.join(d, ".git"))) && HARNESSES.some((h) => isProteusProject(d, h))) out.push(d);
    if (depth >= 3) return;
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") walk(path.join(d, e.name), depth + 1);
  };
  walk(dir, 0);
  return out.filter((d) => !samePath(real(d), real(HERE)) && !samePath(real(d), real(HOME)));
}
const scanFlag = () => (samePath(SCAN, path.join(HOME, "Projects")) ? "" : ` --scan "${SCAN}"`);

// other repos still on hivemind: listed with the command that moves each, or with all moved
function oldRepos(all) {
  const repos = scanOld();
  if (!repos.length) return true;
  log("");
  if (!all) {
    log(`Still on hivemind under ${SCAN}; move each with:`);
    for (const d of repos) log(`  cd "${d}" && node "${path.join(HERE, "install.js")}" --project`);
    log(`or all at once: node "${path.join(HERE, "install.js")}" --migrate-all${scanFlag()}`);
    return true;
  }
  let ok = true;
  for (const d of repos) {
    log(`migrate  -> ${d}`);
    ok = migrateRepo(d) && ok;
  }
  return ok;
}

function install(opt) {
  if (!nodeOk()) die(`node ${process.versions.node} is older than ${NODE_MIN}, which the required context-mode plugin needs. Upgrade: ${nodeFix()}, then re-run`);
  const autoUpdate = opt.autoUpdate ? true : opt.noAutoUpdate ? false : undefined;
  const root = process.cwd();
  if (opt.project && samePath(real(root), real(HOME))) die("--project sets up a repo; run it from the repo root, not from your home directory");
  const fresh = !lstat(CONFIG) && !lstat(OLD_CONFIG);
  const repoOld = opt.project ? [...migrateProject(root, false).harnesses] : [];
  let { ok } = takeoverGlobal({ autoUpdate }, repoOld);
  if (opt.project) ok = migrateRepo(root, opt, [HARNESS]) && ok;
  ok = oldRepos(opt.migrateAll) && ok;
  // a repo hivemind set up for Codex has new hook commands there: Codex asks for approval again
  if (!codex() && repoOld.includes("codex")) withHarness("codex", () => codexSteps(root, true));
  if (codex()) {
    codexSteps(root, opt.project);
    log("");
    log(ok ? "Done. In codex, $proteus (or /skills) bootstraps the rest." : "Done, with errors above.");
    if (fresh) log("New to Proteus? Ask the Proteus skill for its tour in any repo.");
    return ok;
  }
  if (!teamsEnvOn()) {
    log("");
    log("Enable agent teams once, then restart the terminal:");
    log(`  ${envCommand()}`);
  }
  log("");
  log(ok ? "Done. /proteus bootstraps the rest." : "Done, with errors above.");
  if (fresh) log("New to Proteus? Type /proteus tour in any repo for a short walkthrough.");
  return ok;
}

// update

// commit subjects a human would care about: features, fixes, anything marked breaking
const CHANGE = /^(feat|fix)(\([^)]*\))?!?:|^\w+(\([^)]*\))?!:/;

function update(argv) {
  const home = real(HERE);
  const top = git(["rev-parse", "--show-toplevel"], home);
  if (!top.ok || !samePath(real(top.out), home)) die(`${home} is not a git checkout; re-clone Proteus to update it`);
  if (git(["status", "--porcelain", "--untracked-files=no"], home).out) {
    die(`${home} has local changes; commit or stash them, then re-run (git -C "${home}" status)`);
  }
  const before = git(["rev-parse", "HEAD"], home).out;
  const pull = git(["pull", "--ff-only"], home);
  if (!pull.ok) die(`git pull --ff-only failed in ${home}:\n${pull.err}\nresolve it by hand (git -C "${home}" status), then re-run`);
  const after = git(["rev-parse", "HEAD"], home).out;
  log(`update   -> ${home} ${before === after ? "already up to date" : `${before.slice(0, 7)}..${after.slice(0, 7)}`}`);
  if (before !== after) {
    const news = git(["log", "--reverse", "--format=%s", `${before}..${after}`], home).out.split("\n").filter((l) => CHANGE.test(l));
    for (const l of news.slice(0, 12)) log(`  ${l}`);
    if (news.length > 12) log(`  … ${news.length - 12} more: git -C "${home}" log ${before.slice(0, 7)}..`);
    // an install from before the tour existed gets a what's-new tour from here, not a first-time one
    const c = readConfig();
    const next = { ...c };
    if (c.toured === undefined) next.toured = before;
    delete next.behind;
    writeJson(CONFIG, next);
  }
  // the pull may have changed this file: the new code does the install, once per recorded harness
  // unless --harness or PROTEUS_HARNESS names one
  const rest = argv.filter((a) => a !== "--update");
  const named = harnessArg || process.env.PROTEUS_HARNESS;
  migrateConfig(); // the harnesses hivemind recorded count too
  const had = (readJson(CONFIG) || {}).harnesses;
  const list = named ? [HARNESS] : Array.isArray(had) ? had.filter((h) => HARNESSES.includes(h)) : [];
  if (!list.length) list.push("claude");
  let status = 0;
  for (const h of list) {
    const args = named || h === "claude" ? [...rest] : [...rest, "--harness", h];
    const cwd = process.cwd(), wasHive = isDir(path.join(cwd, "teams")) && HARNESSES.some((x) => isFile(path.join(cwd, `.${x}`, "hooks", "hive-autostart.js")));
    if (!args.includes("--project") && (isProteusProject(cwd, h) || wasHive) && !samePath(real(cwd), home)) args.push("--project");
    const r = spawnSync(process.execPath, [path.join(HERE, "install.js"), ...args], { stdio: "inherit" });
    status = status || (r.status ?? 1);
  }
  process.exit(status);
}

// --tour-done: the tour ran or was skipped; the autostart offers it again only after a new feature lands
function tourDone() {
  migrateConfig();
  const head = git(["rev-parse", "HEAD"], real(HERE));
  const next = { ...readConfig(), toured: head.ok && head.out ? head.out : "none" };
  delete next.tourOffers;
  writeJson(CONFIG, next);
  log(`tour     -> done${head.ok ? ` at ${head.out.slice(0, 7)}` : ""}; "tour" in a Proteus session runs it again`);
}

// the agents' own GitHub login (#identity)

// a gh config dir of their own, the token in a file there: gh keeps one keyring entry per host, shared by every
// config dir, so a second keyring login would replace the human's
const AGENT_GH = path.join(HOME, ".config", "gh-proteus");
const RULESET = "proteus runs";
const agentGh = () => { const c = readJson(CONFIG) || {}; return typeof c.agentGh === "string" && c.agentGh.trim() ? path.resolve(c.agentGh.trim().replace(/^~(?=$|[\\/])/, () => HOME)) : ""; };
// gh as the agents (dir) or as the human: the human's is this shell's own config, unless this shell is an agent's
function ghAs(dir, args, extra = {}) {
  const env = { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" };
  if (dir) env.GH_CONFIG_DIR = dir;
  else if (env.GH_CONFIG_DIR && agentGh() && samePath(path.resolve(env.GH_CONFIG_DIR), agentGh())) delete env.GH_CONFIG_DIR;
  const r = spawnSync("gh", args, { encoding: "utf8", timeout: 30000, ...extra, env });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() || (r.error ? r.error.message : "") };
}
const loginOf = (dir) => { const r = ghAs(dir, ["api", "user", "--jq", ".login"]); return r.ok ? r.out : ""; };

function agentLogin(dirArg) {
  const human = loginOf("");
  if (!human) { warn("gh is not logged in as you: run gh auth login first, then this again"); return false; }
  const dir = path.resolve(dirArg ? dirArg.replace(/^~(?=$|[\\/])/, () => HOME) : AGENT_GH);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!WIN) fs.chmodSync(dir, 0o700); // the token sits in hosts.yml here
  let bot = loginOf(dir);
  if (!bot) {
    log(`Sign in as the agents' GitHub account, not as ${human}: open the device link in a private window, or one signed in as that account.`);
    const r = spawnSync("gh", ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--insecure-storage"],
      { stdio: "inherit", env: { ...process.env, GH_CONFIG_DIR: dir } });
    bot = r.status === 0 ? loginOf(dir) : "";
    if (!bot) { warn("gh auth login did not finish; nothing recorded"); return false; }
  }
  if (bot === human) {
    ghAs(dir, ["auth", "logout", "--hostname", "github.com"]);
    warn(`that signed in as ${human}, your own account; logged it out of ${dir}. Create a second account for the agents and run this again`);
    return false;
  }
  const c = readConfig();
  writeJson(CONFIG, { ...c, human, agentGh: dir });
  log(`identity -> agents post as ${bot}, you as ${human} (${CONFIG}); gh config and token in ${dir}`);
  log(`next: in each repo you administer, node "${path.join(HERE, "install.js")}" --protect, then start a new session`);
  return true;
}

// the ruleset on proteus/*: a PR with gates green, no force push, nobody bypasses. Creating proteus/<run> stays
// allowed (do_not_enforce_on_create), and so does deleting it at close.
const rulesetBody = () => ({
  name: RULESET, target: "branch", enforcement: "active", bypass_actors: [],
  conditions: { ref_name: { include: ["refs/heads/proteus/*"], exclude: [] } },
  rules: [
    { type: "pull_request", parameters: { required_approving_review_count: 0, dismiss_stale_reviews_on_push: false, require_code_owner_review: false, require_last_push_approval: false, required_review_thread_resolution: false } },
    { type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, do_not_enforce_on_create: true, required_status_checks: [{ context: "gates" }] } },
    { type: "non_fast_forward" },
  ],
});
const json = (s) => { try { return JSON.parse(s); } catch { return null; } };
// what binds proteus/* in a repo: the rule types GitHub applies there, null when it cannot say
function runRules(repo, dir = "") {
  const r = ghAs(dir, ["api", `repos/${repo}/rules/branches/proteus%2Fprobe`]);
  const rules = r.ok ? json(r.out) : null;
  return Array.isArray(rules) ? rules : null;
}
const rulesHold = (rules) => !!rules && rules.some((x) => x.type === "pull_request") && rules.some((x) => x.type === "non_fast_forward")
  && rules.some((x) => x.type === "required_status_checks" && ((x.parameters || {}).required_status_checks || []).some((c) => c.context === "gates"));

function protect() {
  const human = loginOf("");
  if (!human) { warn("gh is not logged in as you: gh auth login"); return false; }
  const view = ghAs("", ["repo", "view", "--json", "nameWithOwner,viewerPermission"]);
  const info = view.ok ? json(view.out) : null;
  if (!info) { warn(`gh repo view fails here: ${view.err || "no GitHub remote"}`); return false; }
  const repo = info.nameWithOwner;
  if (info.viewerPermission !== "ADMIN") { warn(`${human} is not an admin of ${repo}; its admin runs --protect`); return false; }
  const dir = agentGh();
  const bot = dir ? loginOf(dir) : "";
  let ok = true;
  if (!bot) warn(`no agents' account (${dir ? `${dir} is not logged in` : "--agent-login first"}); the ruleset still binds, but agents posting as ${human} can lift it`);
  else if (bot === human) { warn(`agentGh logs in as ${human}, your own account; --agent-login again`); ok = false; }
  else {
    const perm = ghAs("", ["api", `repos/${repo}/collaborators/${bot}/permission`, "--jq", ".permission"]);
    if (perm.out === "admin") { warn(`${bot} is an admin of ${repo} and can lift the ruleset: make it write in Settings > Collaborators`); ok = false; }
    else if (perm.out === "write" || perm.out === "maintain") log(`access   -> ${bot} already has ${perm.out} on ${repo}`);
    else {
      const inv = ghAs("", ["api", "-X", "PUT", `repos/${repo}/collaborators/${bot}`, "-f", "permission=push"]);
      if (!inv.ok) { warn(`inviting ${bot} failed: ${inv.err}`); ok = false; }
      else {
        const list = json(ghAs(dir, ["api", "user/repository_invitations"]).out) || [];
        const mine = list.filter((x) => x && x.repository && x.repository.full_name === repo);
        const acc = mine.map((x) => ghAs(dir, ["api", "-X", "PATCH", `user/repository_invitations/${x.id}`]));
        if (acc.length && acc.every((a) => a.ok)) log(`access   -> ${bot} invited to ${repo} with write and accepted`);
        else { warn(`${bot} was invited to ${repo} but the invitation is not accepted: sign in as ${bot} and accept it at https://github.com/${repo}/invitations`); ok = false; }
      }
    }
  }
  const list = ghAs("", ["api", `repos/${repo}/rulesets`]);
  const found = (json(list.out) || []).find((x) => x && x.name === RULESET);
  const put = ghAs("", ["api", "-X", found ? "PUT" : "POST", `repos/${repo}/rulesets${found ? `/${found.id}` : ""}`, "--input", "-"], { input: JSON.stringify(rulesetBody()) });
  if (!put.ok) {
    warn(`ruleset failed: ${put.err}`);
    warn("a private repo on GitHub Free has no rulesets: the lead then falls back to per-run branch protection, which your agents' account cannot set either (enforcement.md §1)");
    return false;
  }
  if (!rulesHold(runRules(repo))) { warn(`ruleset "${RULESET}" saved but GitHub does not report it on proteus/*; check Settings > Rules`); return false; }
  log(`ruleset  -> "${RULESET}" ${found ? "updated" : "added"} on ${repo}: proteus/* merges only by PR with gates green, never force-pushed, no bypass`);
  return ok;
}

// doctor

async function doctor(fix) {
  const root = process.cwd();
  const top = git(["rev-parse", "--show-toplevel"], root);
  const cxh = codex();
  // the checkout gets project checks once --project has set it up (self-host)
  const checkout = top.ok && samePath(real(top.out), real(HERE));
  const inRepo = top.ok && (!checkout || isProteusProject(top.out, cxh ? "codex" : "claude"));
  const isProject = inRepo && isDir(path.join(root, "teams"));
  const self = `node "${path.join(HERE, "install.js")}"${cxh ? " --harness codex" : ""}`;
  const hd = cxh ? ".codex" : ".claude";
  const checks = [];
  // test() returns [status, what, fix command]
  const check = (test, fixFn) => checks.push({ test, fixFn });

  check(() => {
    const v = process.versions.node;
    return nodeOk(v) ? ["ok", `node ${v}`] : ["FIX", `node ${v} is older than ${NODE_MIN} (context-mode needs it)`, nodeFix()];
  });
  check(() => has("git") ? ["ok", "git"]
    : ["FIX", "git not found", WIN ? "winget install Git.Git" : "brew install git | sudo pacman -S git | sudo apt install git"]);
  let ghAuthed = false;
  check(() => {
    if (!has("gh")) return ["FIX", "gh not found", WIN ? "winget install GitHub.cli" : "brew install gh | sudo pacman -S github-cli | https://cli.github.com"];
    ghAuthed = has("gh", ["auth", "status"]) !== null;
    return ghAuthed ? ["ok", "gh logged in"] : ["FIX", "gh not logged in", "gh auth login"];
  });
  let bot = "";
  check(() => {
    if (!ghAuthed) return ["WARN", "agents' GitHub login not checked (gh not ready)", "gh auth login"];
    const dir = agentGh();
    if (!dir) return ["WARN", "identity=shared: agents post as you, so only the guards tell their ACCEPT from yours", `${self} --agent-login`];
    bot = loginOf(dir);
    const human = String((readJson(CONFIG) || {}).human || "");
    if (!bot) return ["FIX", `agents' gh config ${dir} is not logged in`, `${self} --agent-login`];
    if (bot === human || !human) return ["FIX", !human ? "no \"human\" in proteus.json beside agentGh" : `agents' login ${bot} is your own`, `${self} --agent-login`];
    return ["ok", `identity=separate: agents post as ${bot}, you as ${human}`];
  });
  // hivemind, the old name: its leftovers before the install checks, which then see what the fix leaves
  check(() => {
    const g = oldGlobal(false);
    if (lstat(OLD_CONFIG)) g.found.push(OLD_CONFIG);
    if (g.found.length) return ["FIX", `hivemind leftovers: ${g.found.join(", ")}`, self];
    return g.kept.length ? ["WARN", `hivemind's, left alone: ${g.kept.join("; ")}`, "move or delete them yourself"] : ["ok", "no hivemind leftovers"];
  }, () => takeoverGlobal({}));
  check(() => {
    const repos = scanOld();
    return repos.length ? ["WARN", `still on hivemind under ${SCAN}: ${repos.join(", ")}`, `${self} --migrate-all${scanFlag()}`] : ["ok", `no repo under ${SCAN} still on hivemind`];
  });
  if (cxh) {
    check(() => cx().contextModeOn() ? ["ok", "context-mode (MCP server or plugin)"]
      : ["WARN", `context-mode (required) is neither an MCP server nor an installed, enabled plugin in ${path.join(cx().home, "config.toml")}`, CODEX_CTX]);
    check(() => {
      const bad = SKILLS.filter((s) => {
        const link = path.join(AGENTS_SKILLS, s);
        return !(lstat(link) && lstat(link).isSymbolicLink() && samePath(real(link), real(path.join(HERE, "skills", s))));
      });
      return bad.length ? ["FIX", `~/.agents/skills/{${bad.join(",")}} not linked to this checkout`, self]
        : ["ok", `~/.agents/skills link to ${path.join(real(HERE), "skills")}`];
    }, () => linkSkills(AGENTS_SKILLS));
    check(() => {
      const { dir, stale } = codexAgentState();
      return stale.length ? ["FIX", `${dir}: ${stale.length} shipped agents missing or stale`, self] : ["ok", "codex agents current"];
    }, () => copyCodexAgents());
    check(() => {
      const { kept } = codexAgentState();
      return kept.length ? ["WARN", `codex agents not generated by proteus, left alone: ${kept.join(", ")}`, "delete them to use the shipped ones"] : ["ok", "no local agent overrides"];
    });
  }
  if (WIN && !cxh) {
    check(() => has("where", ["bash"]) ? ["ok", "Git Bash"]
      : ["FIX", "bash not found (Claude Code on Windows needs Git Bash)", "winget install Git.Git"]);
  }
  if (!cxh) {
    check(() => teamsEnvOn() ? ["ok", `${TEAMS_ENV}=1`]
      : ["FIX", `${TEAMS_ENV} not set`, `${envCommand()}, then restart the terminal`]);
    check(() => {
      const cache = path.join(CLAUDE, "plugins", "cache");
      const found = (isDir(cache) ? fs.readdirSync(cache) : []).some((m) => {
        const d = path.join(cache, m, "mattpocock-skills");
        return isDir(d) && fs.readdirSync(d).some((v) => isDir(path.join(d, v, "skills")));
      });
      return found ? ["ok", "mattpocock-skills plugin"]
        : ["FIX", "mattpocock-skills plugin missing", "inside Claude Code: /plugin install mattpocock-skills@claude-plugins-official"];
    });
    check(() => {
      const c = contextMode();
      return c.installed && c.enabled ? ["ok", `${CTX_PLUGIN} plugin`]
        : ["FIX", `${CTX_PLUGIN} plugin (required) ${c.installed ? "disabled" : "missing"}`, contextModeSteps(c).map((a) => `claude ${a.join(" ")}`).join(" && ")];
    }, () => installContextMode());
    check(() => {
      const bad = SKILLS.filter((s) => {
        const link = path.join(CLAUDE, "skills", s);
        return !(lstat(link) && lstat(link).isSymbolicLink() && samePath(real(link), real(path.join(HERE, "skills", s))));
      });
      return bad.length ? ["FIX", `~/.claude/skills/{${bad.join(",")}} not linked to this checkout`, self]
        : ["ok", `global skills link to ${path.join(real(HERE), "skills")}`];
    }, () => linkSkills());
    check(() => {
      const stale = shippedAgents().filter((f) => {
        const t = readText(path.join(CLAUDE, "agents", f));
        return t === null || norm(t) !== norm(fs.readFileSync(path.join(HERE, "agents", f), "utf8"));
      });
      return stale.length ? ["FIX", `~/.claude/agents: ${stale.length} shipped agents missing or stale`, self] : ["ok", "global agents current"];
    }, () => copyAgents());
  }
  check(() => {
    const c = readJson(path.join(CLAUDE, "proteus.json"));
    return c && samePath(c.home, real(HERE)) ? ["ok", `proteus.json home, autoUpdate ${c.autoUpdate === true}`]
      : ["FIX", "~/.claude/proteus.json missing or points elsewhere", self];
  }, () => writeConfig());
  if (!cxh) check(() => {
    const s = readJson(path.join(CLAUDE, "settings.json"));
    const a = s && s.attribution;
    if (!s) return ["FIX", "~/.claude/settings.json is not valid JSON", "fix it by hand, then re-run"];
    return a && a.commit === "" && a.pr === "" ? ["ok", "attribution off"] : ["FIX", "attribution not disabled", self];
  }, () => setAttribution());

  // skill copies in this dir or a parent up to the repo's toplevel (this dir alone outside a repo) show
  // /proteus twice; never a home: ~/.claude is the global install (#13)
  const dirs = [], stop = top.ok ? real(top.out) || top.out : null, homes = [real(HOME), userHome()];
  for (let d = real(root) || root; ; d = path.dirname(d)) {
    if (homes.some((h) => samePath(real(d), h))) break;
    dirs.push(d);
    if (!stop || samePath(d, stop) || path.dirname(d) === d) break;
  }
  check(() => {
    const dupes = dirs.flatMap((d) => projectDupes(d, false).dupes);
    if (!dupes.length) return ["ok", "no duplicate skill or agent copies"];
    // --fix removes only what safeRemove allows (nothing outside a repo): the rest is a manual step
    const stuck = withProject(root, () => dupes.filter((p) => refused(p, ownedRoots())));
    return ["FIX", `duplicate copies: ${dupes.join(", ")}`, stuck.length
      ? `--fix cannot remove ${stuck.join(", ")}; cd into the repo that holds ${stuck.length === 1 ? "it" : "them"} and re-run, or delete ${stuck.length === 1 ? "it" : "them"} by hand`
      : `${self} --doctor --fix`];
  }, () => withProject(root, () => dirs.forEach((d) => projectDupes(d, true))));
  if (!cxh) check(() => {
    const kept = dirs.flatMap((d) => projectDupes(d, false).overrides);
    return kept.length ? ["WARN", `local agent overrides: ${kept.join(", ")}`, "delete them to use the shipped ones"] : ["ok", "no local agent overrides"];
  });

  if (!inRepo) {
    const where = top.ok ? "in the Proteus checkout, not set up for self-host" : "not inside a git repo";
    check(() => ["WARN", `${where}; project checks skipped`, top.ok ? `${self} --project, or cd into your repo and re-run` : "cd into your repo and re-run"]);
  } else {
    check(() => {
      const remotes = git(["remote", "-v"], root).out;
      if (!/github\.com/.test(remotes)) return ["FIX", "no GitHub remote", "gh repo create --private --source . --push"];
      if (!ghAuthed) return ["WARN", "GitHub remote not verified (gh not ready)", "gh auth login"];
      const r = spawnSync("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], { cwd: root, encoding: "utf8", shell: WIN, timeout: 20000 });
      return r.status === 0 ? ["ok", `GitHub repo ${r.stdout.trim()}`] : ["FIX", "gh repo view fails for this repo's remote", "git remote -v; gh repo view"];
    });
    // what binds proteus/* and who the agents are there; the ruleset is the human's, set once by --protect
    let repo = "";
    if (ghAuthed && isProject) check(() => {
      repo = json(ghAs("", ["repo", "view", "--json", "nameWithOwner"], { cwd: root }).out)?.nameWithOwner || "";
      if (!repo) return ["WARN", "proteus/* rules not checked (gh repo view fails)", "gh repo view"];
      const rules = runRules(repo);
      if (rulesHold(rules)) return ["ok", `proteus/* ruleset: PR with gates green, no force push`];
      return ["WARN", `no ruleset binds proteus/* on ${repo}${rules ? "" : " (or gh cannot read it)"}: the lead falls back to per-run protection, which only an admin's login can set`, `${self} --protect (run by an admin of ${repo})`];
    });
    if (ghAuthed && isProject) check(() => {
      if (!bot || !repo) return ["ok", "agents' access not checked (no agents' login or repo)"];
      const p = ghAs("", ["api", `repos/${repo}/collaborators/${bot}/permission`, "--jq", ".permission"], { cwd: root }).out;
      if (p === "admin") return ["WARN", `${bot} is an admin of ${repo} and can lift the ruleset`, "lower it to write in Settings > Collaborators"];
      return p === "write" || p === "maintain" ? ["ok", `${bot} has ${p} on ${repo}`] : ["FIX", `${bot} cannot push to ${repo} (${p || "unknown"})`, `${self} --protect (run by an admin of ${repo})`];
    });
    check(() => {
      const m = migrateProject(root, false);
      if (m.found.length) return ["FIX", `hivemind's pieces in this repo: ${m.found.join(", ")}`, `${self} --project`];
      return m.kept.length ? ["WARN", `hivemind's, left alone in this repo: ${m.kept.join("; ")}`, "move, edit or delete them yourself"] : ["ok", "no hivemind pieces in this repo"];
    }, () => migrateRepo(root, {}, [HARNESS]));
    // state a pre-rename install left behind: moved by --project and the session start, never silently kept
    check(() => {
      const d = legacyState(root);
      if (!d) return ["ok", "no pre-rename state dir"];
      const common = commonDir(root), to = path.relative(root, hl().stateDir(common)), from = path.relative(root, d);
      const plan = hl().migrateState(common, true);
      const todo = [...plan.moved, ...plan.merged.map((x) => `${x} to merge`)];
      if (todo.length || !(plan.kept.length + plan.held.length + plan.failed.length)) return ["FIX", `${from} still holds pre-rename state (${todo.join(", ") || "empty"})`, `${self} --project`];
      return ["WARN", `${from} left beside ${to}: ${stateLeft(plan, from, to).map((l) => l.replace(/^\w+\s+[^:]+: /, "")).join("; ")}`, "the reason beside each says what to do"];
    }, () => migrateState(root));
    if (!isProject) {
      check(() => ["WARN", "not a Proteus project (no teams/)", `${self} --project`]);
    } else {
      check(() => isFile(path.join(root, "teams", "ROUTING.md")) ? ["ok", "teams/ROUTING.md"]
        : ["WARN", "teams/ROUTING.md missing", `${self} --project`]);
      check(() => {
        const s = readJson(path.join(root, ...(cxh ? [".codex", "hooks.json"] : [".claude", "settings.local.json"])));
        const hooks = JSON.stringify((s && s.hooks) || {});
        const miss = ["proteus-autostart.js", "proteus-lead-guard.js"].filter((f) => !hooks.includes(f) || !isFile(path.join(root, hd, "hooks", f)));
        return miss.length ? ["FIX", `lead hooks not registered: ${miss.join(", ")}`, `${self} --project`] : ["ok", "lead hooks registered"];
      }, () => registerHooks(root));
      if (cxh) {
        check(() => {
          const left = cx().skipHooks.filter((f) => lstat(path.join(root, hd, "hooks", f)));
          return left.length ? ["FIX", `Claude-only files in .codex/hooks: ${left.join(", ")}`, `${self} --project`] : ["ok", "no Claude-only files in .codex/hooks"];
        }, () => registerHooks(root));
        check(() => readText(path.join(root, ".codex", "rules", "proteus.rules")) === cx().RULES ? ["ok", ".codex/rules/proteus.rules"]
          : ["FIX", ".codex/rules/proteus.rules missing or stale", `${self} --project`], () => registerHooks(root));
        check(() => {
          const w = cx().sandboxRoots(root, false);
          if (w.error) return ["FIX", w.error.replace(/; add .*/, ""), `add ${w.dir} to writable_roots under [sandbox_workspace_write] in .codex/config.toml`];
          if (w.missing) return ["FIX", `workers cannot write in ${w.dir}: .codex/config.toml does not list it in writable_roots`, `${self} --project`];
          if (w.stale) return ["FIX", `${w.stale} still in writable_roots, but no pre-rename worktree is left in it`, `${self} --project`];
          return ["ok", `worktree folder writable in the Codex sandbox${w.legacy ? `; ${w.legacy.dir} kept while a pre-rename run has worktrees there (${w.legacy.worktrees.join(", ")})` : ""}`];
        }, () => { if (sandboxRoots(root).created) excludeLocal(root, [".codex/config.toml"], "config.toml"); });
        check(() => codexTrusted(root) ? ["ok", "project trusted in codex"]
          : ["WARN", "project not trusted in codex: its .codex/ hooks do not load", "open codex here, trust the project, approve the hooks in /hooks"]);
      }
      check(() => {
        const r = spawnSync(process.execPath, [path.join(HERE, "templates", "hooks", "proteus-scratch.js"), "--size"], { cwd: root, encoding: "utf8", timeout: 60000 });
        const mb = parseFloat(r.stdout);
        if (r.status !== 0 || !Number.isFinite(mb)) return ["WARN", "scratch size unknown", `node ${hd}/hooks/proteus-scratch.js --size`];
        return mb > 1024 ? ["WARN", `scratch holds ${mb} MB`, `node ${hd}/hooks/proteus-scratch.js --sweep --all-done`] : ["ok", `scratch ${mb} MB`];
      });
      check(() => {
        const teams = path.join(root, "teams");
        const dir = (p) => (cxh ? cx().teamSkills(path.join(teams, p)) : path.join(teams, p, ".claude", "skills"));
        const unlinked = L.profiles(teams).map((p) => [p, L.listFiles(path.join(teams, p)).flatMap(L.readList)
          .filter(([, name]) => L.validName(name) && !real(path.join(dir(p), name))).length]).filter(([, n]) => n);
        const ign = teamsIgnore(teams, false);
        if (ign.length) return ["FIX", `teams/.gitignore lacks ${ign.join(", ")} (skill links would be committed)`, `${self} --project`];
        return unlinked.length ? ["FIX", `team skills not linked (${unlinked.map(([p, n]) => `${p} ${n}`).join(", ")})`, `node "${path.join(SHIPPED_TEAMS, "link-skills.js")}" --install`]
          : ["ok", "team skills linked"];
      }, () => { teamsIgnore(path.join(root, "teams"), true); withProject(root, () => L.run({ root, log, remove: guardedRemove })); });
      // CI runs the gate on a clean checkout: the file it names must be tracked (a Codex-only repo
      // has no .claude/hooks/commit-msg.js, and .codex/hooks is machine-local)
      check(() => {
        const found = [], bad = [];
        for (const f of ["lefthook.yml", ".github/workflows/proteus-gates.yml"]) {
          for (const m of (readText(path.join(root, f)) || "").matchAll(/\bnode\s+["']?([^\s"']*commit-msg\.js)/g)) {
            found.push(f);
            if (!git(["ls-files", "--error-unmatch", "--", m[1]], root).ok) bad.push(`${f} runs ${m[1]}`);
          }
        }
        if (bad.length) return ["FIX", `commit-msg gate: ${bad.join("; ")}, which git does not track`, `point it at ${COMMIT_MSG} and commit`];
        return ["ok", found.length ? "commit-msg gate runs a tracked file" : "commit-msg gate not installed yet (the scaffold ticket adds it)"];
      });
    }
  }

  let failing = 0;
  for (const c of checks) {
    let r = await c.test();
    if (r[0] === "FIX" && fix && c.fixFn) {
      quiet = true;
      try { c.fixFn(); } catch (e) { warn(`fix failed: ${e.message}`); } finally { quiet = false; }
      r = await c.test();
      if (r[0] !== "FIX") r[1] += " (fixed)";
    }
    if (r[0] === "FIX") failing++;
    console.log(`${r[0].padEnd(4)} ${r[1]}${r[0] === "ok" ? "" : ` — ${r[2]}`}`);
  }
  console.log(failing ? `\n${failing} to fix${fix ? "" : "; --doctor --fix applies the local ones"}` : "\nall good");
  return failing === 0;
}

// main

const FLAGS = {
  "--project": "project", "--install": "install", "--confine": "confine", "--update": "update",
  "--doctor": "doctor", "--fix": "fix", "--auto-update": "autoUpdate", "--no-auto-update": "noAutoUpdate",
  "--tour-done": "tourDone", "--migrate-all": "migrateAll", "--protect": "protect",
};
let harnessArg = null;

function main() {
  const argv = process.argv.slice(2);
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--harness" || a.startsWith("--harness=")) {
      harnessArg = a === "--harness" ? argv[++i] : a.slice("--harness=".length);
      if (!harnessArg) die(`--harness needs a value: ${HARNESSES.join(" or ")}`, 2);
      continue;
    }
    if (a === "--scan" || a.startsWith("--scan=")) {
      const d = a === "--scan" ? argv[++i] : a.slice("--scan=".length);
      if (!d) die("--scan needs a directory", 2);
      SCAN = path.resolve(d);
      continue;
    }
    if (a === "--agent-login" || a.startsWith("--agent-login=")) {
      opt.agentLogin = a === "--agent-login" ? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true) : a.slice("--agent-login=".length) || true;
      continue;
    }
    if (a === "-h" || a === "--help") {
      const lines = fs.readFileSync(__filename, "utf8").split(/\r?\n/).slice(1);
      console.log(lines.slice(0, lines.findIndex((l) => !l.startsWith("//"))).map((l) => l.slice(3)).join("\n"));
      process.exit(0);
    }
    if (!FLAGS[a]) die(`unknown flag: ${a} (--help lists them)`, 2);
    opt[FLAGS[a]] = true;
  }
  HARNESS = String(harnessArg || process.env.PROTEUS_HARNESS || "claude").toLowerCase();
  if (!HARNESSES.includes(HARNESS)) die(`unknown harness: ${HARNESS} (${HARNESSES.join(" or ")})`, 2);
  if ((opt.install || opt.confine) && !opt.project) die("--install/--confine need --project", 2);
  if (opt.confine && codex()) die("--confine hides skills from Claude Code only; Codex reads ~/.agents/skills itself", 2);
  if (opt.fix && !opt.doctor) die("--fix needs --doctor", 2);
  if (opt.doctor && Object.keys(opt).some((k) => k !== "doctor" && k !== "fix")) die("--doctor takes only --fix and --scan", 2);
  if (opt.tourDone && Object.keys(opt).length > 1) die("--tour-done takes no other flag", 2);
  if (opt.autoUpdate && opt.noAutoUpdate) die("--auto-update and --no-auto-update conflict", 2);
  if ((opt.agentLogin || opt.protect) && Object.keys(opt).length > 1) die("--agent-login and --protect take no other flag", 2);

  (async () => {
    if (opt.doctor) process.exitCode = (await doctor(opt.fix)) ? 0 : 1;
    else if (opt.tourDone) tourDone();
    else if (opt.agentLogin) process.exitCode = agentLogin(opt.agentLogin === true ? "" : opt.agentLogin) ? 0 : 1;
    else if (opt.protect) process.exitCode = protect() ? 0 : 1;
    else if (opt.update) update(argv);
    else process.exitCode = install(opt) ? 0 : 1;
  })().catch((e) => die(`error: ${e.message}`));
}

// required rather than run (tests): the delete guard only, and nothing runs
module.exports = { allowedRoots, safeRemove };
if (require.main === module) main();

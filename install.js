#!/usr/bin/env node
// Install, update or check the Proteus skill for Claude Code or Codex, on any OS (Node 22.5+, which the context-mode plugin needs).
// install.sh and install.ps1 are thin wrappers around this file.
//
//   node install.js                   link skills/{proteus,proteus-review} into ~/.claude/skills ($CLAUDE_CONFIG_DIR
//                                     when set, here and below)
//                                     (every repo; `git pull` here updates them), copy agents/*.md
//                                     to ~/.claude/agents, record this checkout in ~/.claude/proteus.json,
//                                     install the optional context-mode plugin through the claude CLI
//   node install.js --project         also set up the current repo: teams/<profile>/ with skills
//                                     linked per skills.txt, the lead's hooks in
//                                     .claude/settings.local.json (PROTEUS=0 claude skips them);
//                                     removes project copies of the skill and unmodified agents
//   node install.js --project --install   also `npx skills add` any skill not on this machine
//   node install.js --project --confine   also remove the global ~/.claude/skills/<name> link
//                                         for every linked skill, so the lead never sees it
//   node install.js --project --guest [dir]   guest mode, for a repo you do not own: teams/ and the lead's
//                                     docs go to dir (default ~/.proteus/guest/<repo>-<hash>), not the repo;
//                                     no CI, lefthook or root docs. Chosen without the flag when gh says you
//                                     cannot push here and the repo has no teams/; --no-guest turns it off
//   node install.js --update          fast-forward this checkout to the newest release tag whose
//                                     signature git verifies (docs/updating.md "Releases"), reinstall, and
//                                     refresh the current repo too if it is a Proteus project
//   node install.js --auto-update     let the SessionStart hook do that update (off by default);
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
//                                     no bypass, admins included) to every proteus/* branch; with a verifier App,
//                                     proteus/verdict and proteus/security count only when that App posts them
//   node install.js --verifier-app <appId> <keyPath>   in the repo: record the GitHub App the verifiers sign off as
//                                     (only "Commit statuses: write", installed on this repo, its private key from
//                                     Credentials > Key pairs kept 0600 outside any repo; the App ID is on its General
//                                     tab) in ~/.claude/proteus.json, after a test token mints; then --protect. Once
//                                     per repo owner: run again in a repo of another account or org to add its own
//   node install.js --plugin-setup [--dry-run]   what /proteus:setup runs from the Claude Code plugin: --project's
//                                     project steps only. Enables proteus@proteus in the committed .claude/settings.json
//                                     (the plugin runs its hooks only where that is set) with the proteus marketplace,
//                                     so teammates are offered the plugin; attribution off, the statusLine in
//                                     .claude/settings.local.json, teams/; no hooks or agents in the repo. Prints the
//                                     GitHub steps, never runs them. --dry-run writes nothing and says what it would do.
//                                     Moving from 1.x: removes the repo's unedited .claude/hooks and .claude/agents copies,
//                                     their settings entries and exclude lines; edited ones stay and are named
//   node install.js --remove-user-install [--dry-run]   once the plugin is installed: remove the 1.x user install
//                                     (skill links in ~/.claude/skills, unedited proteus-*.md in ~/.claude/agents,
//                                     autoUpdate in proteus.json); edited agents stay and are named
//   --harness codex                   any of the above for OpenAI Codex CLI instead (or PROTEUS_HARNESS=codex;
//                                     default claude): skills linked into ~/.agents/skills, agents as
//                                     TOML in $CODEX_HOME/agents, the lead's hooks in .codex/hooks.json
//                                     and .codex/rules/proteus.rules, a worktree folder an older run
//                                     left beside the repo writable in .codex/config.toml; --update reinstalls every
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
// every delete, and every copy into a dir Proteus owns, goes through C (#13, #104)
const C = require(path.join(__dirname, "templates", "hooks", "proteus-confine.js"));
const { WIN, lstat, real, isDir, isFile, samePath, inside, realish, userHome, linkDir } = C;
// which shipped teams a repo has evidence for (#156)
const TF = require(path.join(__dirname, "templates", "hooks", "proteus-teamfit.js"));

const HERE = __dirname;
// the shipped roster; teams/ in any repo, this checkout included, is that repo's own
const SHIPPED_TEAMS = path.join(HERE, "templates", "teams");
const HOME = os.homedir();
const CLAUDE = C.claudeDir(); // $CLAUDE_CONFIG_DIR, else ~/.claude
const SKILLS = ["proteus", "proteus-review"];
// package.json ({"type": "commonjs"}) keeps the CommonJS scripts beside it running in a repo whose
// own package.json sets "type": "module" (#77); one ships in templates/hooks/ too
// proteus-confine.js, link-skills.js's guard, comes from templates/hooks/
const LINK_SCRIPTS = ["link-skills.js", "link-skills.sh", "link-skills.ps1", "package.json", "proteus-confine.js"];
const EXCLUDE = [".claude/settings.local.json", ".claude/hooks/proteus-*.js", ".claude/hooks/package.json", ".claude/hooks/worktree-settings.local.json", ".claude/proteus-owned"];
const TEAMS_ENV = "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS";
const CTX_PLUGIN = "context-mode@context-mode";
const CTX_MARKET = "mksglu/context-mode";
const NODE_MIN = "22.5.0";
const HARNESSES = ["claude", "codex"];
const AGENTS_SKILLS = path.join(HOME, ".agents", "skills"); // Codex reads skills here and in <repo>/.agents/skills
const CODEX_EXCLUDE = [".codex/hooks.json", ".codex/hooks/proteus-*.js", ".codex/hooks/package.json", ".codex/rules/proteus.rules", ".codex/proteus-owned"];
// the commit-msg gate runs from here on every CLI: committed with teams/, refreshed by --project
const COMMIT_MSG = "teams/templates/hooks/commit-msg.js";
const CODEX_CTX = "codex mcp add context-mode --env CONTEXT_MODE_PLATFORM=codex -- npx -y context-mode";
const GENERATED = "# generated by proteus"; // equals generated in proteus-harness-codex.js
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

// deletes (#13): every one goes through safeRemove, limited to allowedRoots

// the target's Proteus-owned paths and the project's git toplevel; a toplevel holding a home would open all of it
function allowedRoots(home, codexHome, projectTop, claude = path.join(home, ".claude")) {
  const h = realish(home), u = userHome();
  const roots = [[claude, "skills"], [claude, "agents"], [home, ".agents", "skills"], [claude, "proteus.json"], [claude, "hivemind.json"]].map((p) => realish(path.join(...p)));
  roots.push(realish(path.join(codexHome, "agents")));
  const top = projectTop ? realish(projectTop) : null;
  if (top && !inside(h, top) && !(u && inside(u, top))) roots.push(top);
  return roots;
}

// whether safeRemove refuses p (proteus-confine.js refusal)
const refused = (p, roots) => !!C.refusal(p, roots);
// true if p was removed; false if absent or refused; never throws. kind: "link", "file" or "any"
const safeRemove = (p, roots, kind = "any") => C.remove(p, roots, kind);

// the git toplevel of the repo being set up, set by withProject; null outside one. GUEST: its guest dir, if any
let PROJECT = null, GUEST = "";
const ownedRoots = () => [...allowedRoots(HOME, CODEX_HOME, PROJECT, CLAUDE), ...(GUEST ? [realish(GUEST)] : [])];
// link-skills.js's removals, when this process drives them (#13): links only
const guardedRemove = (p) => safeRemove(p, ownedRoots(), "link");
function withProject(dir, fn) {
  const was = [PROJECT, GUEST], top = git(["rev-parse", "--show-toplevel"], dir);
  PROJECT = top.ok && top.out ? top.out : null;
  GUEST = PROJECT ? hl().guestDir(PROJECT) : "";
  try { return fn(); } finally { [PROJECT, GUEST] = was; }
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

// copy unless identical; a link at dest is replaced, never written through; a refused copy stops the run
function copyFile(src, dest) {
  const st = lstat(dest);
  if (st && st.isFile() && fs.readFileSync(src).equals(fs.readFileSync(dest))) return;
  if (!C.copyFile(src, dest, ownedRoots())) die(`stopped: ${dest} not written. Move what is there away and re-run.`);
}
// skip: source paths left out, with everything under them; put(src, dest) copies a file
function copyTree(src, dest, skip = [], put = copyFile) {
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (skip.some((x) => samePath(s, x))) continue;
    if (e.isDirectory()) copyTree(s, d, skip, put); else put(s, d);
  }
}

const shippedAgents = () => fs.readdirSync(path.join(HERE, "agents")).filter((f) => f.endsWith(".md")).sort();
// the project's agent patches (.claude/proteus-agents.json) and the adapter that renders an agent file
const ap = () => require(path.join(HERE, "templates", "hooks", "proteus-agent-patch.js"));
const adapter = () => (codex() ? cx() : require(path.join(HERE, "templates", "hooks", "proteus-harness-claude.js")));
// where a project keeps teams/ and the lead's docs: its guest dir in guest mode, else the checkout
const docBase = (dir) => hl().docRoot(dir);
const isProteusProject = (dir, h = "claude") => isDir(path.join(docBase(dir), "teams")) && isFile(path.join(dir, `.${h}`, "hooks", "proteus-autostart.js"));

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

// "attribution": "keep" in ~/.claude/proteus.json leaves the user's attribution setting as it is
const keepAttribution = () => (readJson(CONFIG) || {}).attribution === "keep";
function setAttribution(dry = false) {
  const file = path.join(CLAUDE, "settings.json");
  if (keepAttribution()) { log("settings -> attribution left as set (proteus.json attribution: keep)"); return true; }
  const s = readJson(file);
  if (!s) {
    warn(`warning: ${file} is not valid JSON; left alone. Add by hand:`);
    warn('  "attribution": { "commit": "", "pr": "", "sessionUrl": false }');
    return false;
  }
  const want = { ...s.attribution, commit: "", pr: "", sessionUrl: false };
  if (JSON.stringify(s.attribution) !== JSON.stringify(want)) {
    if (dry) { log(`settings -> would disable attribution in ${file}`); return true; }
    s.attribution = want; writeJson(file, s);
  }
  log("settings -> attribution disabled");
  return true;
}

// auto mode's classifier reads autoMode from user or managed settings only, and treats an agent
// editing them as self-modification: Proteus suggests an environment entry and never writes it
const AUTO_MODE_ENTRY = "Proteus is my own multi-agent tooling: the /proteus lead spawns proteus-* worker, verifier, QA, guide and scout subagents, their task descriptions are ticket briefs I asked for, and the .claude/hooks/proteus-*.js hooks are my own guardrails";
const claudeCode = () => isDir(CLAUDE) || has("claude") !== null;
function autoModeHint() {
  const s = readJson(path.join(CLAUDE, "settings.json")) || {};
  const env = s.autoMode && Array.isArray(s.autoMode.environment) ? s.autoMode.environment : [];
  if (env.some((e) => /proteus/i.test(String(e)))) return "";
  const snippet = JSON.stringify({ autoMode: { environment: ["$defaults", AUTO_MODE_ENTRY] } }, null, 2);
  return `in Claude Code run /auto-mode-setup, or /permissions → Auto mode, and add this entry to ${path.join(CLAUDE, "settings.json")}, keeping "$defaults" and any entries you have (docs/install.md, Auto mode):\n${snippet}`;
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
  installContextMode(); // optional (agents fall back to a scratch file and grep); a missing claude CLI is not fatal
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
    C.writeFile(p, a.text, ownedRoots());
  }
  for (const p of kept) log(`local override kept: ${p} (not generated by proteus; deleting it drops its edits, which a project can keep as "append" in .codex/proteus-agents.json)`);
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
  if (!cx().contextModeOn()) steps.push(`optional, saves context: add the context-mode MCP server: ${CODEX_CTX}`);
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
  warn(`warning: the optional context-mode plugin is not ${after.installed ? "enabled" : "installed"}; agents fall back to a scratch file and grep. To use it, run:`);
  for (const args of steps) warn(`  claude ${args.join(" ")}`);
  return false;
}

// project

// Copies of the skill, and unmodified copies of shipped agents, in <dir>/.claude.
// Returns { dupes: [path], overrides: [path] }; act removes the dupes, and dupes lists only those removed.
function projectDupes(dir, act) {
  const dupes = [], overrides = [];
  if (samePath(real(dir), real(HOME))) return { dupes, overrides }; // ~/.claude is the global install
  // a repo may commit .claude as a link (to ~/.claude, say): nothing reached through one is a dupe (#22)
  const through = (p, segs) => {
    if (L.ownDir(dir, segs)) return false;
    if (act) warn(`refused  ${p} (${path.join(dir, ...segs)} is a link or has one on the way; left alone. A link you made: replace it with a real directory)`);
    return true;
  };
  for (const s of SKILLS) {
    const base = codex() ? ".agents" : ".claude", p = path.join(dir, base, "skills", s);
    const st = lstat(p);
    if (!st || through(p, [base, "skills"])) continue;
    if (st.isSymbolicLink() || (st.isDirectory() && frontmatterName(p) === s && !inside(HERE, p))) { if (!act || safeRemove(p, ownedRoots())) dupes.push(p); }
  }
  for (const f of codex() ? [] : shippedAgents()) {
    const p = path.join(dir, ".claude", "agents", f);
    const t = readText(p);
    // generated from proteus-agents.json: agentPatches rewrites it
    if (t === null || ap().isGenerated(t) || through(p, [".claude", "agents"])) continue;
    if (norm(t) === norm(fs.readFileSync(path.join(HERE, "agents", f), "utf8")) || pastShipped(`agents/${f}`, t)) {
      if (!act || safeRemove(p, ownedRoots())) dupes.push(p);
    } else overrides.push(p);
  }
  return { dupes, overrides };
}
// an override as "<path> (<frontmatter keys and prompt that differ from shipped>)"
function overrideNote(p, shown = p) {
  const f = path.basename(p), t = readText(p) || "";
  return `${shown} (differs in ${ap().diffFields(fs.readFileSync(path.join(HERE, "agents", f), "utf8"), t).join(", ") || "whitespace"})`;
}

// writes the project's patched agents (shipped agent + its proteus-agents.json entry) and removes the
// ones whose entry is gone; a bad patch file is an error that leaves every agent file as it was
function agentPatches(root) {
  const r = withProject(root, () => ap().apply(root, HERE, adapter(), (p) => safeRemove(p, ownedRoots(), "file")));
  if (r.error) { warn(`error: ${r.error}; generated agents left as they were`); return false; }
  for (const p of r.written) log(`agent    -> ${p} (shipped agent + ${r.file})`);
  for (const p of r.removed) log(`removed  ${p} (generated; its entry left ${r.file})`);
  for (const k of r.kept) log(`patch not applied: ${k.path} is a local copy, not generated; move its edits into ${r.file}, then delete it`);
  for (const p of r.refused) warn(`refused  ${p} (a link, or a link on the way; no generated agent written or removed through it. A link you made: replace it with a real directory or file)`);
  return true;
}

// A file identical to a version this checkout once shipped (rel: its path here, e.g.
// agents/hive-guide.md) is an old installer's copy, not an edit; with no text, whether rel ever
// shipped. Needs the checkout's git history, so a non-git copy of Proteus never matches.
// dir: another Proteus checkout whose history to read (a 1.x one, from the plugin's copy, which has none).
const pastByDir = new Map();
const hashText = (s) => crypto.createHash("sha256").update(norm(s).trimEnd()).digest("hex");
function pastShipped(rel, text, dir = HERE) {
  let pastHashes = pastByDir.get(dir);
  if (!pastHashes) {
    pastByDir.set(dir, (pastHashes = new Map()));
    const r = git(["log", "--format=%H", "--name-only", "--no-renames", "--", "agents", "templates/hooks"], dir);
    const want = [];
    let c = null;
    for (const l of r.ok ? r.out.split("\n") : []) {
      if (/^[0-9a-f]{40}$/.test(l)) c = l;
      else if (l && c) want.push(`${c}:${l}`);
    }
    // one git process for every blob: "<sha> blob <size>\n<bytes>\n", or "<name> missing\n"
    const out = want.length ? spawnSync("git", ["cat-file", "--batch"], { cwd: dir, input: want.join("\n") + "\n", maxBuffer: 1 << 30 }).stdout : null;
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

// scripts/known-blobs.json (scripts/known-blobs.js writes it from main's history): { blobs: { "<path here>": [git blob
// id, ...] }, texts: { "<templates/teams path>": { id: text } } }, every past version of each shipped path. The plugin's
// copy has no git history, so this file is the only record of them; {} when missing or unreadable.
let knownData = null;
const known = () => knownData || (knownData = readJson(path.join(HERE, "scripts", "known-blobs.json")) || {});
const blobId = (text) => { const b = Buffer.from(text, "utf8"); return crypto.createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex"); };
// with no text, whether rel ever had a past version; else whether text, as is or with LF endings, is one
function knownBlob(rel, text) {
  const ids = isObj(known().blobs) ? known().blobs[rel] : null;
  if (!Array.isArray(ids)) return false;
  return text === undefined || ids.includes(blobId(text)) || ids.includes(blobId(norm(text)));
}

function registerHooks(root) {
  // the script removes the adapter's skipped files an older install copied, through proteus-confine.js
  const script = path.join(HERE, "templates", "hooks", "install-lead-hooks.js");
  const env = { ...process.env, PROTEUS_HARNESS: HARNESS };
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
  if (what) log(`exclude  -> ${path.relative(root, file) || file} (${what})`);
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

// teams/.proteus-base.json: {"<rel>": {"sha256": ...}} per repo-owned team file, the hashText of the
// shipped text it was copied from; committed with teams/ (in guest mode it lives in the guest dir).
// A missing file is copied and recorded; one with no record gets the current shipped hash, silently.
// When the shipped text moved past the record and the copy differs from the new text, the new text
// goes beside the copy as <file>.upstream and the recorded one (teamHistory) as <file>.base (offerUpstream),
// and the record moves on. A record never shipped (a teammate's newer release) is left alone, so an older
// release never offers its text as an update. rec: teamRecord's, written by its done().
const BASE_FILE = ".proteus-base.json";
function teamUpstream(teams, rels, rec) {
  for (const rel of rels) {
    const src = path.join(SHIPPED_TEAMS, ...rel.split("/")), dest = path.join(teams, ...rel.split("/"));
    const text = fs.readFileSync(src, "utf8"), h = hashText(text), was = isObj(rec.base[rel]) ? rec.base[rel] : null;
    const record = () => { rec.next[rel] = { sha256: h }; };
    if (!lstat(dest)) { if (C.copyFile(src, dest, ownedRoots())) record(); continue; }
    if (!was || typeof was.sha256 !== "string") { record(); continue; }
    if (was.sha256 === h) continue;
    // a record no shipped text matches is a newer release's, left alone; with no git history here past is only the
    // known texts, so an unmatched record is offered without a .base instead
    const past = teamHistory(rel);
    if (!past.has(was.sha256) && past.git) continue;
    record();
    const cur = readText(dest);
    if (cur !== null && hashText(cur) === h) continue; // the copy already has the new text
    if (!rec.offer(dest, text, past.get(was.sha256) ?? null, rel)) rec.next[rel] = was; // offered again next run
  }
}

// the record file and the offers one copyTeams run makes: { base, next, offer(dest, text, baseText, label), done() }.
// offer writes text beside dest as <dest>.upstream and baseText (what dest was copied from; null: unknown) as
// <dest>.base; a .upstream still pending from an earlier release keeps its .base, the text the copy came from. When
// git tracks no dest and git merge-file merges the three cleanly, the merge goes into dest and both files go; else
// one line says how to merge, and done() git-excludes them. false when a write was refused.
function teamRecord(root, teams) {
  const file = path.join(teams, BASE_FILE), base = readJson(file) || {}, next = { ...base };
  const guest = !!GUEST && samePath(real(root), real(GUEST)), excl = [];
  const shown = (p) => (guest ? p : path.relative(root, p).split(path.sep).join("/"));
  // a link the repo commits at the record or at a .upstream or .base path stops the run before anything
  // is written through it (#22); a copy is only read, or made where nothing is, in a dir copyTeams owns
  const noLink = (p) => { const st = lstat(p); if (st && st.isSymbolicLink()) die(`refused  ${p} (a link; nothing written through it). Replace it with a regular file and re-run.`); };
  noLink(file);
  const offer = (dest, text, baseText, label) => {
    const up = `${dest}.upstream`, old = `${dest}.base`;
    noLink(up); noLink(old);
    const pending = !!lstat(up);
    if (!C.writeFile(up, norm(text), ownedRoots())) return false;
    let hasBase = pending && !!lstat(old);
    if (!pending) {
      hasBase = typeof baseText === "string" && C.writeFile(old, norm(baseText), ownedRoots());
      if (!hasBase && lstat(old)) safeRemove(old, ownedRoots());
    }
    if (hasBase && !git(["ls-files", "--error-unmatch", "--", dest], root).ok) {
      const m = spawnSync("git", ["merge-file", "-p", dest, old, up], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 20000 });
      if (m.status === 0 && typeof m.stdout === "string" && C.writeFile(dest, m.stdout, ownedRoots())) {
        safeRemove(up, ownedRoots());
        safeRemove(old, ownedRoots());
        log(`merged   -> ${shown(dest)}: this release changed the shipped ${label}; merged into the copy, no conflicts`);
        return true;
      }
    }
    excl.push(up, ...(hasBase ? [old] : []));
    log(hasBase ? `upstream -> ${shown(up)}: this release changed the shipped ${label}; merge it: git merge-file ${shown(dest)} ${shown(old)} ${shown(up)}, then delete the .upstream and .base files`
      : `upstream -> ${shown(up)}: this release changed the shipped ${label}; merge it into ${shown(dest)} by hand (git diff --no-index ${shown(dest)} ${shown(up)}), then delete it`);
    return true;
  };
  const done = () => {
    if (!guest && excl.length) excludeLocal(root, excl.map((p) => path.relative(root, p).split(path.sep).join("/")), null);
    if (JSON.stringify(next) !== JSON.stringify(base)) writeJson(file, Object.fromEntries(Object.keys(next).sort().map((k) => [k, next[k]])));
  };
  return { base, next, offer, done };
}

// copies a file setup refreshes in teams/ (templates/, the link scripts, required.txt; rel: its path here) over dest,
// unless git tracks dest (teams/ committed, maybe by someone else) and it is neither the shipped text nor a past one
// (knownBlob): that is the repo's own edit, so the shipped text is offered beside it (rec.offer), with the newest
// version in the repo's history of dest that is a shipped one as .base. The record (keyed by dest's path in teams/)
// holds the offered text, so a merged or declined offer is not made again until the shipped text changes.
function teamRefresh(root, teams, rec) {
  const tracked = new Set(git(["ls-files", "-z", "--", path.join(teams, "")], root).out.split("\0").filter(Boolean));
  const repoRel = (p) => path.relative(root, p).split(path.sep).join("/");
  return (src, dest, rel) => {
    const key = path.relative(teams, dest).split(path.sep).join("/"), cur = readText(dest);
    if (!tracked.has(repoRel(dest)) || cur === null) { copyFile(src, dest); delete rec.next[key]; return; }
    const text = readText(src);
    if (norm(cur) === norm(text) || knownBlob(rel, cur)) { copyFile(src, dest); delete rec.next[key]; return; }
    const h = hashText(text), was = rec.base[key];
    if (isObj(was) && was.sha256 === h) return;
    // the repo's history of dest, newest first: the first shipped version is what the edits were made on
    const ids = git(["log", "--format=", "--raw", "--no-abbrev", "--no-renames", "--", repoRel(dest)], root).out.split("\n").map((l) => l.split(/\s+/)[3]).filter((x) => x && !/^0+$/.test(x));
    const past = isObj(known().blobs) && Array.isArray(known().blobs[rel]) ? known().blobs[rel] : [];
    const now = blobId(norm(text)), id = ids.find((x) => x === now || past.includes(x));
    // edited on top of the text shipped now: nothing to offer
    if (id === now) { rec.next[key] = { sha256: h }; return; }
    const baseText = id ? spawnSync("git", ["cat-file", "blob", id], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 20000 }).stdout : null;
    if (rec.offer(dest, text, baseText || null, `teams/${key}`)) rec.next[key] = { sha256: h };
  };
}
// every past version of templates/teams/<rel> as hashText -> text (LF): the ones scripts/known-blobs.json lists, which
// the plugin's copy (no git history) has too, and those in this checkout's history when it has one
function teamHistory(rel) {
  const p = `templates/teams/${rel}`, m = new Map();
  const texts = isObj(known().texts) && isObj(known().texts[p]) ? Object.values(known().texts[p]) : [];
  for (const t of texts) if (typeof t === "string" && !m.has(hashText(t))) m.set(hashText(t), norm(t));
  const r = git(["log", "--format=%H", "--no-renames", "--", p], HERE);
  m.git = r.ok;
  if (!r.ok) return m;
  const want = r.out.split("\n").filter((l) => /^[0-9a-f]{40}$/.test(l)).map((c) => `${c}:${p}`);
  const out = want.length ? spawnSync("git", ["cat-file", "--batch"], { cwd: HERE, input: want.join("\n") + "\n", maxBuffer: 1 << 28 }).stdout : null;
  let at = 0;
  for (let i = 0; out && i < want.length; i++) {
    const nl = out.indexOf(10, at), head = out.toString("utf8", at, nl).split(" ");
    at = nl + 1;
    if (head[1] !== "blob") continue;
    const size = Number(head[2]), t = norm(out.toString("utf8", at, at + size));
    if (!m.has(hashText(t))) m.set(hashText(t), t);
    at += size + 1;
  }
  return m;
}
// pending <file>.upstream files anywhere under teams/ (links not followed), "/"-separated relative to teams/
function upstreamPending(teams) {
  const out = [];
  const walk = (d, pre) => {
    for (const e of isDir(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
      if (e.isDirectory()) walk(path.join(d, e.name), `${pre}${e.name}/`);
      else if (e.isFile() && e.name.endsWith(".upstream")) out.push(`${pre}${e.name}`);
    }
  };
  walk(teams, "");
  return out.sort();
}

// which shipped team dirs copyTeams writes (#156): a refresh only those teams/ already has, never a new
// one; a first install (no ROUTING.md and no team under teams/ yet) the ones the repo has evidence for.
// { keep, left: [[team, reason]], why } where why says the scan passed its cap and every team was kept
function teamPlan(teams, repo) {
  const shipped = L.profiles(SHIPPED_TEAMS);
  let roster = !!lstat(path.join(teams, "ROUTING.md"));
  try { roster = roster || fs.readdirSync(teams).some((p) => isFile(path.join(teams, p, "PROFILE.md"))); } catch {}
  if (roster) {
    const has = (p) => !!lstat(path.join(teams, p));
    return { keep: shipped.filter(has), left: shipped.filter((p) => !has(p)).map((p) => [p, "not in this repo's roster, and a refresh never adds a team"]), why: "" };
  }
  // a team dir already there (a link included, which own() then refuses) is kept, never left out
  const a = TF.assess(repo), fit = (p) => !a.teams[p] || a.teams[p].fits || !!lstat(path.join(teams, p));
  return { keep: shipped.filter(fit), left: shipped.filter((p) => !fit(p)).map((p) => [p, a.teams[p].reason]), why: a.capped ? `every shipped team kept: ${a.why}` : "" };
}
// ROUTING.md text without the table rows that route to a team in out
function routingWithout(text, out) {
  return text.split(/(?<=\n)/).filter((l) => { const m = /^\|.*\|\s*([\w-]+)\s*\|$/.exec(l.trimEnd()); return !(m && out.includes(m[1])); }).join("");
}
function logPlan(plan, would = "") {
  if (plan.why) log(`teams    : ${plan.why}`);
  for (const [p, why] of plan.left) log(`${would}left out ${p}: ${why}`);
}

// whether a ROUTING.md table row routed to team names a path glob git tracks a file under in repo
function routedFiles(routing, team, repo) {
  const globs = routing.split(/\r?\n/).filter((l) => new RegExp(`^\\|.*\\|\\s*${team}\\s*\\|$`).test(l.trimEnd()))
    .flatMap((l) => [...l.matchAll(/`([^`\s]+)`/g)].map((m) => m[1].replace(/^\.?\//, ""))).filter((x) => !x.startsWith("-"));
  if (!globs.length) return false;
  const r = spawnSync("git", ["ls-files", "--", ...globs.map((x) => `:(glob)${x}`)], { cwd: repo, encoding: "utf8", timeout: TF.CAP_MS, windowsHide: true, maxBuffer: 1 << 28 });
  return r.status === 0 && !!r.stdout.trim();
}

// root: where teams/ goes (the checkout, or its guest dir); repo: the checkout whose files decide the teams
function copyTeams(root, repo = root) {
  const teams = path.join(root, "teams");
  const plan = teamPlan(teams, repo);
  // self-host: the checkout's own templates/ and link scripts are the source, never copied into git
  const self = samePath(real(root), real(HERE));
  // a repo may commit teams/, or a dir or file in it, as a link: every dir written to is made, or found, a real
  // one (ownDir), and a link at .gitignore stops the run, before anything is written through it (#22)
  const own = (...segs) => L.ownDir(root, ["teams", ...segs], true) || die(`refused  ${path.join(teams, ...segs)} (a link, or a link on the way; nothing written through it). Replace it with a real directory and re-run.`);
  const ownTree = (src, segs) => {
    own(...segs);
    for (const e of fs.readdirSync(src, { withFileTypes: true })) if (e.isDirectory() && !samePath(path.join(src, e.name), SHIPPED_TEAMS)) ownTree(path.join(src, e.name), [...segs, e.name]);
  };
  own();
  ownTree(path.join(HERE, "templates"), ["templates"]);
  // and every profile dir, before teamUpstream copies a PROFILE.md or skills.txt into one
  const dirs = plan.keep.map((p) => [p, own(p)]);
  const ign = lstat(path.join(teams, ".gitignore"));
  if (ign && ign.isSymbolicLink()) die(`refused  ${path.join(teams, ".gitignore")} (a link; nothing written through it). Replace it with a regular file and re-run.`);
  teamsIgnore(teams, true);
  // a refreshed file teams/ commits with the repo's own edits gets a .upstream, never overwritten (teamRefresh)
  const rec = teamRecord(root, teams), refresh = teamRefresh(root, teams, rec);
  const put = (src, dest) => refresh(src, dest, path.relative(HERE, src).split(path.sep).join("/"));
  if (!self) for (const f of LINK_SCRIPTS) put(isFile(path.join(SHIPPED_TEAMS, f)) ? path.join(SHIPPED_TEAMS, f) : path.join(HERE, "templates", "hooks", f), path.join(teams, f));
  // excluded first: a run that stops partway never leaves the copy showing in git status
  if (self) excludeLocal(root, ["teams/templates/"], "teams/templates, a copy of this checkout's templates/");
  copyTree(path.join(HERE, "templates"), path.join(teams, "templates"), [SHIPPED_TEAMS], put);
  // renamed to worktree-settings.local.json; drop the old copy only if nobody edited it
  const stale = path.join(teams, "templates", "hooks", "settings.local.json");
  const t = readText(stale);
  if (t !== null && !isFile(path.join(HERE, "templates", "hooks", "settings.local.json"))
      && crypto.createHash("sha256").update(norm(t)).digest("hex") === OLD_WORKER_SETTINGS && safeRemove(stale, ownedRoots())) {
    log("removed  teams/templates/hooks/settings.local.json (renamed to worktree-settings.local.json)");
  }
  // the routing table, PROFILE.md and skills.txt are the repo's once copied; a later shipped change
  // to one the repo has comes as <file>.upstream to merge (teamUpstream)
  const owned = ["ROUTING.md", ...plan.keep.flatMap((p) => ["PROFILE.md", "skills.txt"].map((f) => `${p}/${f}`))];
  // written here without the rows of the teams left out; teamUpstream then records the shipped text it came from
  const routing = path.join(teams, "ROUTING.md");
  if (plan.left.length && !lstat(routing)) C.writeFile(routing, routingWithout(fs.readFileSync(path.join(SHIPPED_TEAMS, "ROUTING.md"), "utf8"), plan.left.map(([p]) => p)), ownedRoots());
  teamUpstream(teams, owned.filter((rel) => isFile(path.join(SHIPPED_TEAMS, rel))), rec);
  for (const [p, dest] of dirs) {
    const src = path.join(SHIPPED_TEAMS, p);
    // required.txt is the pipeline's, not the scout's or the repo's: always refreshed
    if (isFile(path.join(src, "required.txt"))) put(path.join(src, "required.txt"), path.join(dest, "required.txt"));
  }
  rec.done();
  log(`teams    -> ${teams} (ROUTING.md, PROFILE.md, skills.txt, ${self ? "" : "link-skills.*, proteus-confine.js, package.json, "}templates/; teams ${plan.keep.join(", ") || "none"})`);
  logPlan(plan);
}

function projectInstall(root, opt) {
  const guest = guestSetup(root, opt), base = guest || root;
  // a guest leaves the repo's files alone, its copies of the skill included
  const { dupes, overrides } = projectDupes(root, !guest);
  for (const p of dupes) log(`${guest ? "kept    " : "removed "} ${path.relative(root, p).split(path.sep).join("/")} (duplicate of the global install${guest ? "; guest mode leaves it" : ""})`);
  for (const p of overrides) {
    log(`local override kept: ${overrideNote(p, path.relative(root, p).split(path.sep).join("/"))}; shipped updates skip it. Deleting it drops those edits: put them in .claude/proteus-agents.json first`);
  }
  const patched = agentPatches(root);
  withProject(root, () => {
    copyTeams(base, root);
    L.run({ root: base, install: !!opt.install, confine: !!opt.confine, log, remove: guardedRemove });
  });
  // lead autostart + guard: machine-local, never tracked, so worker worktrees do not inherit them
  let ok = registerHooks(root) && patched;
  if (codex()) {
    const tracked = git(["ls-files", "--error-unmatch", "--", ".codex/config.toml"], root).ok;
    if (guest && tracked) {
      warn(`warning: guest mode leaves the repo's tracked .codex/config.toml alone; add ${guest} to writable_roots under [sandbox_workspace_write] in your Codex config`);
      excludeLocal(root, CODEX_EXCLUDE, "hooks.json, Proteus hooks, rules, proteus-owned");
      return ok;
    }
    const cfg = path.join(root, ".codex", "config.toml"), had = !!lstat(cfg);
    const w = sandboxRoots(root);
    if (guest) ok = allowGuest(root, guest) && ok;
    // a config.toml the repo already had may be tracked or the user's: never exclude it
    const made = !had && !!lstat(cfg);
    excludeLocal(root, made ? [...CODEX_EXCLUDE, ".codex/config.toml"] : CODEX_EXCLUDE, `hooks.json, Proteus hooks, rules, proteus-owned${made ? ", config.toml" : ""}`);
    return ok && !w.error;
  }
  if (guest) ok = allowGuest(root, guest) && ok;
  // a guest's .claude/hooks/commit-msg.js is no gate the repo runs: excluded with the rest
  if (guest) excludeLocal(root, [...EXCLUDE, ".claude/hooks/commit-msg.js"], "settings.local.json, Proteus hooks, commit-msg.js, proteus-owned");
  else excludeLocal(root);
  return ok;
}

// guest mode: --guest [dir], or none given and gh says the human cannot push here (READ or TRIAGE) on a repo
// with no teams/ of its own. Writes <git-common-dir>/proteus/guest.json {dir}; a marker already there is kept,
// and --no-guest removes it (the guest dir's files stay). Returns the guest dir, or "" for a normal install.
function guestSetup(root, opt) {
  const common = commonDir(root);
  if (!common) return "";
  const lib = hl(), file = lib.guestFile(common), have = lib.guestDir(root);
  if (opt.noGuest) {
    if (lstat(file) && safeRemove(file, ownedRoots())) { log(`guest    -> off; ${have || "the guest dir"} keeps its files (copy what you want into the repo)`); }
    return "";
  }
  let dir;
  if (typeof opt.guest === "string") dir = path.resolve(opt.guest.replace(/^~(?=$|[\\/])/, () => HOME));
  else if (have) return have;
  else if (opt.guest) dir = lib.defaultGuestDir(common);
  else {
    if (isDir(path.join(root, "teams"))) return "";
    const perm = ghAs("", ["repo", "view", "--json", "viewerPermission", "-q", ".viewerPermission"], { cwd: root });
    if (!perm.ok || !/^(READ|TRIAGE)$/.test(perm.out)) return "";
    log(`guest    -> gh reports ${perm.out} access to this repo, so Proteus keeps its files outside it (--no-guest: install into the repo)`);
    dir = lib.defaultGuestDir(common);
  }
  if (inside(dir, path.resolve(root))) die(`--guest ${dir} is inside the repo; guest mode keeps its files outside it`, 2);
  fs.mkdirSync(dir, { recursive: true });
  writeJson(file, { guest: true, dir });
  log(`guest    -> ${dir} (teams/, CONTEXT.md, CONVENTIONS.md, AGENTS.md, docs/adr, docs/lessons); no CI, lefthook or root docs in the repo`);
  return dir;
}

// the session reaches the guest dir: Claude Code's additionalDirectories, Codex's writable_roots
function allowGuest(root, dir) {
  const ad = codex() ? cx() : require(path.join(HERE, "templates", "hooks", "proteus-harness-claude.js"));
  const w = ad.allowDir(root, dir);
  if (w.error) { warn(`warning: ${w.error}; let the session write in ${dir} yourself`); return false; }
  log(`guest    -> ${path.relative(root, w.file).split(path.sep).join("/")} (${w.changed ? `${dir} added` : `${dir} already listed`})`);
  return true;
}

// workspace-write already lets a Codex worker write in <repo>/.worktrees/; a folder beside the repo that an older
// run still has worktrees in (../<repo>-proteus, ../<repo>-hive) stays in writable_roots until they merge
function sandboxRoots(root) {
  const w = cx().sandboxRoots(root);
  if (w.error) { warn(`warning: ${w.error}`); return w; }
  const rel = path.relative(root, w.file).split(path.sep).join("/");
  for (const d of w.missing) log(`sandbox  -> ${rel} (${w.created ? "created, " : ""}${d} listed: an older run still has worktrees there)`);
  for (const d of w.stale) log(`sandbox  -> ${d} dropped from writable_roots (no worktree of an older run is left in it)`);
  for (const k of w.kept) if (!w.missing.includes(k.dir)) log(`sandbox  -> ${k.dir} kept in writable_roots: an older run still has worktrees there (${k.worktrees.join(", ")}); the next --project drops it once they are gone`);
  if (!w.changed && !w.kept.length) log("sandbox  -> worker worktrees in .worktrees/, inside the project: writable_roots needs no entry");
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
  // a FIFO, socket or device is never moved (its reason says so): no retry promised for it
  const never = r.failed.filter((f) => f.includes("never moved")), retry = r.failed.filter((f) => !never.includes(f));
  return [
    r.kept.length && `kept     ${from}: ${r.kept.join(", ")} (also in ${to}, whose copy is the one in use; delete the old copy once you have compared them)`,
    r.held.length && `kept     ${from}: ${r.held.join(", ")} (a registered git worktree, left where git has it; the rest moves once \`git worktree remove\` drops it)`,
    retry.length && `failed   ${from}: ${retry.join(", ")} (not movable now; the next --project retries)`,
    never.length && `failed   ${from}: ${never.join(", ")}`,
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
  if (!nodeOk()) die(`node ${process.versions.node} is older than ${NODE_MIN}, which the context-mode plugin needs. Upgrade: ${nodeFix()}, then re-run`);
  const autoUpdate = opt.autoUpdate ? true : opt.noAutoUpdate ? false : undefined;
  // --project from a subdir sets up the repo it is in, not a .claude/ in the subdir; never a toplevel holding HOME
  const top = opt.project ? git(["rev-parse", "--show-toplevel"], process.cwd()) : { ok: false };
  const root = top.ok && top.out && !inside(realish(HOME), realish(top.out)) ? path.resolve(top.out) : process.cwd();
  if (!samePath(real(root), real(process.cwd()))) log(`project  -> ${root} (the repo's root; run from ${process.cwd()})`);
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
  const hint = claudeCode() ? autoModeHint() : "";
  if (hint) {
    log("");
    log("Auto mode: its classifier may block Proteus worker spawns until it knows Proteus is yours;");
    log(hint);
  }
  log(ok ? "Done. /proteus bootstraps the rest." : "Done, with errors above.");
  if (fresh) log("New to Proteus? Type /proteus tour in any repo for a short walkthrough.");
  return ok;
}

// plugin setup (#136): /proteus:setup runs install.js --plugin-setup from the plugin root. --project's project steps
// only: the plugin ships the hooks and agents, so none go into the repo, and the global install is the plugin's.
const PLUGIN_ID = "proteus@proteus";
const MARKET = { source: { source: "github", repo: "Yousef-Baidas/proteus" } };
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
// the plugin's per-repo gate, the rule proteus-plugin.js applies: { on, file } (settings.local.json wins)
const gateFrom = (root) => require(path.join(HERE, "templates", "hooks", "proteus-plugin.js")).gateFrom(root);
// 1.x, the installer path, left in a repo or the config dir that moves to the plugin (D8). A file counts as unedited
// when it is the text shipped now (here or in the 1.x checkout proteus.json names) or byte-identical to a blob the
// path ever had on main (knownBlob: the 1.x autostart synced from main between releases); only those go. A gate-run
// or edited copy stays and is named; a tracked one too, with an edited one's last author and no advice to delete it.
const oldHome = () => { const h = (readJson(CONFIG) || {}).home; return typeof h === "string" && isDir(h) && !samePath(real(h), real(HERE)) ? real(h) : null; };
const homes = () => [HERE, oldHome()].filter(Boolean);
const everShipped = (rel) => homes().some((d) => isFile(path.join(d, rel))) || knownBlob(rel);
const unedited = (rel, text) => text !== null && (homes().some((d) => { const t = readText(path.join(d, rel)); return t !== null && hashText(t) === hashText(text); }) || knownBlob(rel, text));
const HOOK_CMD = /\.claude[\\/]hooks[\\/]([\w.-]+\.js)\b/;
const HOOK_EXCLUDE = { ".claude/hooks/proteus-*.js": /^proteus-[\w.-]*\.js$/, ".claude/hooks/package.json": /^package\.json$/, ".claude/hooks/worktree-settings.local.json": /^worktree-settings\.local\.json$/ };

// a repo's 1.x install: hook copies in .claude/hooks and their entries (hooks, statusLine) in .claude/settings.json
// and settings.local.json, agent copies in .claude/agents, the hook lines in .git/info/exclude. settings maps a file
// name (settings.json, settings.local.json) to its parsed object, edited in place; returns { found, kept, changed }
// with paths relative to root, changed the settings names edited. act removes the files and the exclude lines.
function oldProjectInstall(root, act, settings) {
  const found = [], kept = [], changed = new Set(), gone = new Set();
  const rel = (p) => path.relative(root, p).split(path.sep).join("/");
  const drop = (p, why) => { if (act && !safeRemove(p, ownedRoots(), "file")) kept.push(`${rel(p)} (refused: a link, or outside what Proteus owns)`); else { found.push(`${rel(p)} (${why})`); gone.add(rel(p)); } };
  const tracked = new Set(git(["ls-files", "--", ".claude/hooks", ".claude/agents"], root).out.split("\n").filter(Boolean));
  // a tracked copy: an unedited one goes in a commit; an edited one is someone's work, named with its last author
  const keptTracked = (r, text, shipped) => {
    if (unedited(shipped, text)) return `${r} (tracked by git; delete it in a commit)`;
    const who = git(["log", "-1", "--format=%an", "--", r], root).out;
    return `${r} (edited${who ? ` by ${who}` : ""}; left alone)`;
  };
  const gates = ["lefthook.yml", path.join(".github", "workflows", "proteus-gates.yml")].map((f) => readText(path.join(root, f)) || "").join("\n");
  const hooks = path.join(root, ".claude", "hooks");
  const own = L.ownDir(root, [".claude", "hooks"]) ? listDir(hooks, /^[\w.-]+$/).filter((f) => f !== "install-lead-hooks.js" && everShipped(`templates/hooks/${f}`)) : [];
  for (const f of own.filter((x) => x !== "package.json")) {
    const p = path.join(hooks, f), r = `.claude/hooks/${f}`;
    if (tracked.has(r)) kept.push(keptTracked(r, readText(p), `templates/hooks/${f}`));
    else if (gates.includes(r)) kept.push(`${r} (the gates run it; point them at ${COMMIT_MSG}, then run this again)`);
    else if (unedited(`templates/hooks/${f}`, readText(p))) drop(p, "1.x copy; the plugin runs its own");
    else kept.push(`${r} (edited; it still runs beside the plugin's hook until you delete it)`);
  }
  // the CommonJS marker goes with the last script it serves
  const pj = path.join(hooks, "package.json");
  if (own.includes("package.json") && !listDir(hooks, /\.js$/).some((f) => !gone.has(`.claude/hooks/${f}`))) {
    if (tracked.has(".claude/hooks/package.json")) kept.push(keptTracked(".claude/hooks/package.json", readText(pj), "templates/hooks/package.json"));
    else if (unedited("templates/hooks/package.json", readText(pj))) drop(pj, "1.x copy");
    else kept.push(".claude/hooks/package.json (edited)");
  }
  // an entry whose script is gone, or never was there, goes; an empty entry and then an empty event go too
  const stale = (cmd) => { const m = HOOK_CMD.exec(String(cmd)); return !!m && everShipped(`templates/hooks/${m[1]}`) && (gone.has(`.claude/hooks/${m[1]}`) || !lstat(path.join(hooks, m[1]))); };
  for (const [name, s] of Object.entries(settings)) {
    let n = 0;
    const hk = isObj(s.hooks) ? s.hooks : {};
    for (const ev of Object.keys(hk)) {
      if (!Array.isArray(hk[ev])) continue;
      hk[ev] = hk[ev].filter((e) => {
        if (!e || !Array.isArray(e.hooks)) return true;
        const keep = e.hooks.filter((x) => !(x && stale(x.command)));
        n += e.hooks.length - keep.length;
        const emptied = keep.length < e.hooks.length && !keep.length;
        e.hooks = keep;
        return !emptied;
      });
      if (!hk[ev].length) delete hk[ev];
    }
    if (isObj(s.hooks) && !Object.keys(s.hooks).length) delete s.hooks;
    if (isObj(s.statusLine) && stale(s.statusLine.command)) { delete s.statusLine; n++; }
    if (n) { found.push(`.claude/${name}: ${n} 1.x entr${n === 1 ? "y" : "ies"}`); changed.add(name); }
  }
  const agents = path.join(root, ".claude", "agents");
  const generated = L.ownDir(root, [".claude", "agents"]) ? withProject(root, () => ap().plan(root, HERE, adapter())) : { write: [] };
  for (const f of L.ownDir(root, [".claude", "agents"]) ? listDir(agents, /^proteus-[\w-]+\.md$/) : []) {
    const p = path.join(agents, f), r = `.claude/agents/${f}`, t = readText(p), gen = ap().isGenerated(t);
    if (!gen && !everShipped(`agents/${f}`)) continue;
    if (tracked.has(r)) kept.push(keptTracked(r, t, `agents/${f}`));
    // generated from proteus-agents.json, which the plugin does not apply: as the installer wrote it now, or orphaned
    else if (gen) {
      if (generated.error || (generated.write || []).some((w) => samePath(w.path, p))) kept.push(`${r} (generated from .claude/proteus-agents.json, since edited or out of date)`);
      else drop(p, "generated 1.x copy; the plugin runs its own");
    } else if (unedited(`agents/${f}`, t)) drop(p, "1.x copy; the plugin runs its own");
    else kept.push(`${r} (edited; Claude Code loads it beside the plugin's proteus:${f.slice(0, -3)})`);
  }
  // .git/info/exclude: a hook line goes once no worktree holds a file it matches
  const common = commonDir(root), xf = common && path.join(common, "info", "exclude"), text = xf && readText(xf);
  if (text) {
    const trees = git(["worktree", "list", "--porcelain"], root).out.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9));
    const left = (re) => [root, ...trees].some((d) => listDir(path.join(d, ".claude", "hooks"), re).some((f) => !(samePath(d, root) && gone.has(`.claude/hooks/${f}`))));
    const lines = text.split(/\r?\n/), todo = lines.filter((l) => HOOK_EXCLUDE[l] && !left(HOOK_EXCLUDE[l]));
    if (todo.length) {
      found.push(`${rel(xf)}: ${todo.join(", ")}`);
      if (act) fs.writeFileSync(xf, lines.filter((l) => !todo.includes(l)).join(/\r\n/.test(text) ? "\r\n" : "\n"));
    }
  }
  return { found, kept, changed };
}

// oldProjectInstall until a pass removes nothing, so one run leaves no leftover a removal freed (a package.json, an
// exclude line, a settings entry); dry runs once. kept is the last pass's.
function oldProjectAll(root, act, settings) {
  const all = { found: [], kept: [], changed: new Set() };
  for (let i = 0; i < 5; i++) {
    const m = oldProjectInstall(root, act, settings);
    all.found.push(...m.found);
    for (const c of m.changed) all.changed.add(c);
    all.kept = m.kept;
    if (!act || !m.found.length) break;
  }
  return all;
}

// the 1.x user install the plugin replaces: skill links in the config dir's skills/, shipped agents in its agents/,
// autoUpdate in proteus.json (the plugin manager updates). Returns { found, kept }; act removes found.
function oldUserInstall(act) {
  const found = [], kept = [];
  const drop = (p, why) => { if (act && !safeRemove(p, ownedRoots())) kept.push(`${p} (refused: outside what Proteus owns)`); else found.push(`${p} (${why})`); };
  for (const s of SKILLS) {
    const p = path.join(CLAUDE, "skills", s), st = lstat(p);
    if (st && st.isSymbolicLink()) drop(p, "1.x skill link");
    else if (st && isDir(p) && frontmatterName(p) === s) kept.push(`${p} (a copy, not a link; delete it yourself once its edits are safe)`);
  }
  const md = path.join(CLAUDE, "agents");
  for (const f of listDir(md, /^proteus-[\w-]+\.md$/)) {
    if (!everShipped(`agents/${f}`)) continue;
    const p = path.join(md, f);
    if (unedited(`agents/${f}`, readText(p))) drop(p, "1.x copy");
    else kept.push(`${p} (edited; Claude Code loads it beside the plugin's proteus:${f.slice(0, -3)})`);
  }
  const c = readJson(CONFIG);
  if (c && "autoUpdate" in c) {
    found.push(`autoUpdate in ${CONFIG} (the plugin manager updates the plugin)`);
    if (act) { delete c.autoUpdate; writeJson(CONFIG, c); }
  }
  return { found, kept };
}

const pluginInstalled = () => { const p = (readJson(path.join(CLAUDE, "plugins", "installed_plugins.json")) || {}).plugins; return isObj(p) && Array.isArray(p[PLUGIN_ID]) && p[PLUGIN_ID].length > 0; };
function removeUserInstall(opt) {
  const dry = !!opt.dryRun;
  if (!dry && !pluginInstalled()) die(`refused: ${PLUGIN_ID} is not installed in ${CLAUDE}, so this would leave no Proteus; install the plugin first (README), or --dry-run to see what goes`);
  const u = oldUserInstall(!dry);
  for (const p of u.found) log(`${dry ? "would remove" : "removed "} ${p}`);
  for (const p of u.kept) log(`kept     ${p}`);
  log(u.found.length ? (dry ? "Dry run: nothing written." : "Done. The 1.x user install is gone; Codex installs (~/.agents, $CODEX_HOME) are left alone.") : "No 1.x user install found.");
  return true;
}

// a repo's 1.x pieces out, for --doctor --fix: the settings files read, edited and written here
function migrateToPlugin(root) {
  const files = { "settings.json": path.join(root, ".claude", "settings.json"), "settings.local.json": path.join(root, ".claude", "settings.local.json") };
  const settings = {};
  for (const [k, f] of Object.entries(files)) { const st = lstat(f), v = readJson(f); if (v && !(st && st.isSymbolicLink())) settings[k] = v; }
  const m = withProject(root, () => oldProjectAll(root, true, settings));
  for (const k of m.changed) writeJson(files[k], settings[k]);
  return m;
}

function pluginSetup(opt) {
  const dry = !!opt.dryRun, would = (s) => (dry ? `would ${s}` : s);
  const top = git(["rev-parse", "--show-toplevel"], process.cwd());
  if (!top.ok || !top.out) die("--plugin-setup sets up a git repo; run it inside one (git init first)");
  const root = path.resolve(top.out);
  if (inside(realish(HOME), realish(root))) die("--plugin-setup sets up a repo; this one holds your home directory");
  if (!samePath(real(root), real(process.cwd()))) log(`project  -> ${root} (the repo's root; run from ${process.cwd()})`);
  // every file is checked before any is written: a refusal leaves the repo as it was
  const shared = path.join(root, ".claude", "settings.json"), local = path.join(root, ".claude", "settings.local.json");
  const s = readJson(shared), l = readJson(local);
  for (const [f, v] of [[shared, s], [local, l]]) {
    const st = lstat(f);
    if (st && st.isSymbolicLink()) die(`refused: ${f} is a link; nothing written through it. Replace it with a regular file and re-run`);
    if (!v) die(`refused: ${f} is not a JSON object; nothing changed. Fix it (or move it away) and re-run`);
  }
  for (const k of ["enabledPlugins", "extraKnownMarketplaces"]) {
    if (k in s && !isObj(s[k])) die(`refused: "${k}" in ${shared} is not a JSON object; nothing changed. Fix it and re-run`);
  }
  // a 1.x install here first: its hook copies and their entries out, so plugin and copy never both run unnoticed
  const m = withProject(root, () => oldProjectAll(root, !dry, { "settings.json": s, "settings.local.json": l }));
  for (const p of m.found) log(`${dry ? "would remove" : "removed "} ${p}`);
  for (const p of m.kept) log(`kept     ${p}`);
  // the gate the plugin's hooks check, and the marketplace teammates are prompted to install from (a fork's kept)
  const todo = [];
  if ((s.enabledPlugins || {})[PLUGIN_ID] !== true) { s.enabledPlugins = { ...s.enabledPlugins, [PLUGIN_ID]: true }; todo.push(`enable ${PLUGIN_ID}`); }
  if (!isObj((s.extraKnownMarketplaces || {}).proteus)) {
    s.extraKnownMarketplaces = { ...s.extraKnownMarketplaces, proteus: MARKET };
    todo.push(`add the proteus marketplace (github ${MARKET.source.repo})`);
  }
  if ((todo.length || m.changed.has("settings.json")) && !dry) writeJson(shared, s);
  log(`settings -> .claude/settings.json (${todo.length ? todo.map(would).join(", ") : `${PLUGIN_ID} enabled, proteus marketplace listed`}; commit it)`);
  const own = isObj(l.enabledPlugins) ? l.enabledPlugins[PLUGIN_ID] : undefined;
  if (own !== undefined && own !== true) warn(`warning: .claude/settings.local.json sets ${PLUGIN_ID} to ${JSON.stringify(own)}, which wins over settings.json; the plugin stays off here until you set it to true or remove it`);
  let ok = setAttribution(dry);
  // the statusLine where --project puts it, from the repo's teams/ copy: the plugin root moves on every update
  if (!("statusLine" in l)) {
    const script = path.join(root, "teams", "templates", "hooks", "proteus-statusline.js").split(path.sep).join("/");
    l.statusLine = { type: "command", command: `node "${script}"` };
    if (!dry) writeJson(local, l);
    log(`status   -> .claude/settings.local.json (${dry ? "would add the statusLine" : "statusLine added"})`);
  } else {
    if (m.changed.has("settings.local.json") && !dry) writeJson(local, l);
    log("status   -> .claude/settings.local.json (statusLine already set; left as it is)");
  }
  const teams = path.join(root, "teams");
  if (dry) {
    log("exclude  -> would keep .claude/settings.local.json out of git (.git/info/exclude)");
    const plan = teamPlan(teams, root);
    log(`teams    -> ${teams} (would ${isDir(teams) ? "refresh" : "copy"} ROUTING.md, PROFILE.md, skills.txt, link-skills.*, templates/; teams ${plan.keep.join(", ") || "none"})`);
    logPlan(plan, "would leave out: ");
  } else {
    excludeLocal(root, [".claude/settings.local.json"], "settings.local.json");
    withProject(root, () => {
      copyTeams(root);
      L.run({ root, install: false, confine: false, log, remove: guardedRemove });
    });
  }
  if (!dry) setupReleaseCheck(root);
  const self = `node "${path.join(HERE, "install.js")}"`;
  // the user-level 1.x install is never touched here: it may still serve other repos
  const u = oldUserInstall(false);
  if (u.found.length + u.kept.length) {
    log("");
    log(`A 1.x user install is still in ${CLAUDE} (setup leaves it; other repos may still use it):`);
    for (const p of [...u.found, ...u.kept.map((k) => `${k}, kept by the command below`)]) log(`  ${p}`);
    if (u.found.length) log(`Remove it once no repo needs it: ${self} --remove-user-install (--dry-run first shows what goes)`);
  }
  log("");
  log("Next, by hand (setup never runs these):");
  log("  commit .claude/settings.json and teams/: teammates who trust the repo are offered the plugin");
  if (!teamsEnvOn()) log(`  enable agent teams once, then restart the terminal: ${envCommand()}`);
  log(`  on GitHub, as an admin of the repo: ${self} --protect`);
  log(`  optional, verdicts from a GitHub App: ${self} --verifier-app <appId> <keyPath>, then --protect again`);
  log("");
  log(dry ? "Dry run: nothing written." : ok ? "Done. Start a new session; /proteus:proteus bootstraps the rest." : "Done, with errors above.");
  return ok;
}

// update

// commit subjects a human would care about: features, fixes, anything marked breaking
const CHANGE = /^(feat|fix)(\([^)]*\))?!?:|^\w+(\([^)]*\))?!:/;

function update(argv) {
  const home = real(HERE);
  const top = git(["rev-parse", "--show-toplevel"], home);
  if (!top.ok || !samePath(real(top.out), home)) die(`${home} is not a git checkout; re-clone Proteus to update it`);
  // only a signed release tag moves the checkout (hl().release): never the tip of a branch
  const fetch = git(["fetch", "--quiet", "--tags"], home);
  if (!fetch.ok) die(`git fetch --tags failed in ${home}:\n${fetch.err}\nresolve it by hand (git -C "${home}" fetch --tags), then re-run`);
  const rel = hl().release(home);
  const before = git(["rev-parse", "HEAD"], home).out;
  if (!rel.tag) log(`update   -> ${home} has no newer release${rel.current ? ` than ${rel.current}` : ""}`);
  else {
    const v = hl().verifyRelease(home, rel.tag);
    if (v.error) {
      die(`not updating ${home} to ${rel.tag}: ${v.error}\n` +
        `trust the maintainer's key ("Releases" in ${path.join(home, "docs", "updating.md")}) and re-run, or review the tag and run\n` +
        `  git -C "${home}" merge --ff-only ${rel.tag}\nthen re-run this command`);
    }
    if (git(["status", "--porcelain", "--untracked-files=no"], home).out) {
      die(`${home} has local changes; commit or stash them, then re-run (git -C "${home}" status)`);
    }
    const ff = git(["merge", "--ff-only", "--quiet", v.commit], home);
    if (!ff.ok) die(`git merge --ff-only ${rel.tag} failed in ${home}:\n${ff.err}\nresolve it by hand (git -C "${home}" status), then re-run`);
    log(`update   -> ${home} ${rel.current || before.slice(0, 7)}..${rel.tag} (signature verified)`);
    const notes = hl().changelog(home, v.commit, rel.current, rel.tag, 12);
    if (notes.length) for (const l of notes) log(`  ${l}`);
    else {
      const news = git(["log", "--reverse", "--format=%s", `${before}..${v.commit}`], home).out.split("\n").filter((l) => CHANGE.test(l));
      for (const l of news.slice(0, 12)) log(`  ${l}`);
      if (news.length > 12) log(`  … ${news.length - 12} more: git -C "${home}" log ${before.slice(0, 7)}..${rel.tag}`);
    }
    // an install from before the tour existed gets a what's-new tour from here, not a first-time one
    const c = readConfig();
    if (c.toured === undefined) writeJson(CONFIG, { ...c, toured: before });
  }
  const c = readJson(CONFIG);
  if (c && "behind" in c) { delete c.behind; writeJson(CONFIG, c); }
  // the update may have changed this file: the new code does the install, once per recorded harness
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
    // the checkout itself counts once self-hosted: isProteusProject needs its teams/ and hooks, which only --project makes
    if (!args.includes("--project") && (isProteusProject(cwd, h) || wasHive)) args.push("--project");
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

// the ruleset on proteus/*: a PR with gates green, the verifier's MERGE (proteus/verdict) and the security
// trigger's status (proteus/security, proteus-trust.yml) on its head, no force push, nobody bypasses. Creating
// proteus/<run> stays allowed (do_not_enforce_on_create), and so does deleting it at close.
const REQUIRED = ["gates", "proteus/verdict", "proteus/security"];
// with a verifier App, the two verdict statuses count only from it (integration_id); gates stays CI's
const pinned = (context, app) => (app && context !== "gates" ? { context, integration_id: app.appId } : { context });
const rulesetBody = (app = hl().verifierApp()) => ({
  name: RULESET, target: "branch", enforcement: "active", bypass_actors: [],
  conditions: { ref_name: { include: ["refs/heads/proteus/*"], exclude: [] } },
  rules: [
    { type: "pull_request", parameters: { required_approving_review_count: 0, dismiss_stale_reviews_on_push: false, require_code_owner_review: false, require_last_push_approval: false, required_review_thread_resolution: false } },
    { type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, do_not_enforce_on_create: true, required_status_checks: REQUIRED.map((c) => pinned(c, app)) } },
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
// the contexts the proteus/* rules require, among REQUIRED
const required = (rules) => new Set((rules || []).filter((x) => x.type === "required_status_checks").flatMap((x) => ((x.parameters || {}).required_status_checks || []).map((c) => c.context)));
const rulesHold = (rules) => !!rules && rules.some((x) => x.type === "pull_request") && rules.some((x) => x.type === "non_fast_forward")
  && required(rules).has("gates");
const rulesMissing = (rules) => REQUIRED.filter((c) => !required(rules).has(c));
// the verdict contexts the rules do not pin to the App (no entry with its integration_id)
const rulesUnpinned = (rules, app) => REQUIRED.filter((c) => c !== "gates" && !(rules || []).some((x) => x.type === "required_status_checks"
  && ((x.parameters || {}).required_status_checks || []).some((e) => e.context === c && Number(e.integration_id) === app.appId)));

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
  log(`ruleset  -> "${RULESET}" ${found ? "updated" : "added"} on ${repo}: proteus/* merges only by PR with gates green and the verifiers' statuses (proteus/verdict, proteus/security), never force-pushed, no bypass`);
  const app = hl().verifierApp();
  if (app) log(`ruleset  -> proteus/verdict and proteus/security count only from the verifier App ${app.appId}`);
  if (app && !hl().appInstallation(app, repo)) { warn(`the verifier App ${app.appId} has no installation recorded for ${repo.split("/")[0]}, so no signoff here can post: install it there, then node "${path.join(HERE, "install.js")}" --verifier-app ${app.appId} ${app.keyPath}`); ok = false; }
  else warn("no verifier App (--verifier-app): any login with write can post proteus/verdict, the agents' too (enforcement.md §1)");
  return ok;
}

// The verifier App (#81): an App with only "Commit statuses: write", installed on the repo, its key a .pem the human
// keeps outside any repo. Checks the key, finds the installation on this repo with the App's JWT, mints a test
// token (used for nothing, never printed) and records { appId, installations: { <owner>: <id> }, keyPath } in
// proteus.json. Run in a repo of another owner (an org beside your account), it adds that owner's installation.
async function verifierApp(idArg, keyArg) {
  if (!/^\d+$/.test(String(idArg || "")) || !keyArg) { warn("usage: --verifier-app <appId> <keyPath> (the App ID from the App's General tab, the .pem from its Credentials > Key pairs)"); return false; }
  const appId = Number(idArg), keyPath = path.resolve(String(keyArg).replace(/^~(?=$|[\\/])/, () => HOME));
  const st = fs.statSync(keyPath, { throwIfNoEntry: false });
  if (!st || !st.isFile()) { warn(`${keyPath} is not a file: the App's private key (.pem) goes there`); return false; }
  if (!WIN && st.mode & 0o077) warn(`${keyPath} is readable by others (mode ${(st.mode & 0o777).toString(8)}): chmod 600 it`);
  const top = spawnSync("git", ["-C", path.dirname(keyPath), "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (top.status === 0) warn(`${keyPath} sits in the git checkout ${top.stdout.trim()}: keep it outside any repo, where no commit or worker reaches it`);
  const lib = hl();
  let jwt;
  try { jwt = lib.appJwt(appId, fs.readFileSync(keyPath, "utf8")); } catch (e) { warn(`${keyPath} is not an RSA private key that signs (${String(e.message).split("\n")[0]})`); return false; }
  const view = ghAs("", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
  const repo = view.ok ? view.out : "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { warn(`gh repo view fails here: ${view.err || "no GitHub remote"}; run this inside the repo`); return false; }
  let inst;
  try { inst = await lib.appApi("GET", `/repos/${repo}/installation`, jwt); } catch (e) {
    warn(e.status === 404 ? `App ${appId} is not installed on ${repo}: install it from the App's Install App tab (Only select repositories), then run this again` : `App ${appId}: ${e.message}`);
    return false;
  }
  if (!inst || !/^\d+$/.test(String(inst.id))) { warn(`GitHub named no installation of App ${appId} on ${repo}`); return false; }
  const owner = repo.split("/")[0].toLowerCase(), id = Number(inst.id);
  try { await lib.appToken(repo, { appId, installations: { [owner]: id }, keyPath }); } catch (e) { warn(`App ${appId} is installed on ${repo} but no token mints (${e.message}); give it "Commit statuses: write"`); return false; }
  // the same App keeps the installations of the other owners; a lone pre-map id goes into the map under its account
  const prev = lib.verifierApp();
  const installations = prev && prev.appId === appId ? { ...prev.installations } : {};
  let lone = prev && prev.appId === appId ? prev.installationId : 0;
  if (lone && lone !== id) {
    try { const a = await lib.appApi("GET", `/app/installations/${lone}`, jwt); if (a && a.account && a.account.login) { installations[String(a.account.login).toLowerCase()] ??= lone; lone = 0; } } catch {}
  } else lone = 0;
  installations[owner] = id;
  writeJson(CONFIG, { ...readConfig(), verifierApp: { appId, installations, ...(lone && { installationId: lone }), keyPath } });
  const others = Object.keys(installations).filter((o) => o !== owner);
  log(`verifier -> App ${appId} (installation ${id} for ${owner}${others.length ? `; also ${others.join(", ")}` : ""}) signs the verifiers' statuses; key ${keyPath}`);
  log(`next: node "${path.join(HERE, "install.js")}" --protect, so the ruleset counts only the App's statuses`);
  return true;
}

// doctor

async function doctor(fix) {
  const root = process.cwd();
  const top = git(["rev-parse", "--show-toplevel"], root);
  const cxh = codex();
  // the checkout gets project checks once --project has set it up (self-host)
  const checkout = top.ok && samePath(real(top.out), real(HERE));
  const inRepo = top.ok && (!checkout || isProteusProject(top.out, cxh ? "codex" : "claude"));
  // guest mode: teams/ lives in the guest dir, and the repo's CI and lefthook are not Proteus's to check
  const guest = inRepo ? hl().guestDir(root) : "", base = guest || root;
  const isProject = inRepo && isDir(path.join(base, "teams"));
  const self = `node "${path.join(HERE, "install.js")}"${cxh ? " --harness codex" : ""}`;
  const hd = cxh ? ".codex" : ".claude";
  // a plugin setup (D8): the repo's committed gate, or this run is the plugin's own copy; the plugin then carries the
  // skill, agents and hooks, and the 1.x pieces are leftovers
  // a plugin repo: the gate is on, or the committed settings turn it on and a local false holds it off
  const gated = top.ok && (gateFrom(top.out).on || ((readJson(path.join(top.out, ".claude", "settings.json")) || {}).enabledPlugins || {})[PLUGIN_ID] === true);
  const plug = !cxh && (gated || inside(path.join(CLAUDE, "plugins"), real(HERE) || HERE));
  const checks = [];
  // test() returns [status, what, fix command]
  const check = (test, fixFn, fixOnWarn) => checks.push({ test, fixFn, fixOnWarn });

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
  // the verifier App (#81), when one is recorded: its key readable here, and a token mints for this repo. GitHub
  // out of reach is a WARN: the key and the config may be fine
  const vapp = hl().verifierApp();
  if (vapp) check(() => {
    try { fs.accessSync(vapp.keyPath, fs.constants.R_OK); } catch (e) { return ["FIX", `verifier App ${vapp.appId}: key ${vapp.keyPath} is not readable (${e.code}); every signoff fails`, `put the App's .pem back there, or ${self} --verifier-app <appId> <keyPath>`]; }
    const st = fs.statSync(vapp.keyPath);
    if (!WIN && st.mode & 0o077) return ["WARN", `verifier App ${vapp.appId}: key ${vapp.keyPath} is readable by others (mode ${(st.mode & 0o777).toString(8)})`, `chmod 600 ${vapp.keyPath}`];
    return ["ok", `verifier App ${vapp.appId}: key ${vapp.keyPath} readable`];
  });
  if (vapp && top.ok) check(async () => {
    const r = ghAs("", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], { cwd: root });
    if (!r.ok || !r.out) return ["WARN", `verifier App ${vapp.appId}: no token checked (gh repo view fails here)`, "gh repo view"];
    try { await hl().appToken(r.out, vapp); } catch (e) {
      return [e.network ? "WARN" : "FIX", `verifier App ${vapp.appId}: no token for ${r.out} (${e.message})`, e.network ? "check the network, then --doctor again" : `install the App on ${r.out} with "Commit statuses: write", then ${self} --verifier-app ${vapp.appId} ${vapp.keyPath}`];
    }
    return ["ok", `verifier App ${vapp.appId}: a token mints for ${r.out}`];
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
      : ["WARN", `context-mode (optional; agents fall back to a scratch file and grep) is neither an MCP server nor an installed, enabled plugin in ${path.join(cx().home, "config.toml")}`, CODEX_CTX]);
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
      return kept.length ? ["WARN", `codex agents not generated by proteus, left alone (shipped updates skip them): ${kept.join(", ")}`,
        "deleting one drops its edits; keep added instructions per project as \"append\" in <repo>/.codex/proteus-agents.json, then delete it"] : ["ok", "no local agent overrides"];
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
        : ["WARN", `${CTX_PLUGIN} plugin (optional; agents fall back to a scratch file and grep) ${c.installed ? "disabled" : "missing"}`, contextModeSteps(c).map((a) => `claude ${a.join(" ")}`).join(" && ")];
    }, () => installContextMode(), true);
    if (claudeCode()) check(() => {
      const hint = autoModeHint();
      return hint ? ["WARN", "auto mode: no autoMode.environment entry in ~/.claude/settings.json names Proteus, so the classifier may block worker spawns", hint]
        : ["ok", "auto mode: autoMode.environment describes Proteus"];
    });
    if (plug) check(() => {
      const u = oldUserInstall(false);
      if (u.found.length) return ["WARN", `1.x user install beside the plugin: ${u.found.join(", ")}`, `${self} --remove-user-install, once no repo still runs 1.x`];
      return u.kept.length ? ["WARN", `1.x copies left alone: ${u.kept.join("; ")}`, "move or delete them yourself"] : ["ok", "no 1.x user install beside the plugin"];
    });
    if (!plug) check(() => {
      const bad = SKILLS.filter((s) => {
        const link = path.join(CLAUDE, "skills", s);
        return !(lstat(link) && lstat(link).isSymbolicLink() && samePath(real(link), real(path.join(HERE, "skills", s))));
      });
      return bad.length ? ["FIX", `~/.claude/skills/{${bad.join(",")}} not linked to this checkout`, self]
        : ["ok", `global skills link to ${path.join(real(HERE), "skills")}`];
    }, () => linkSkills());
    if (!plug) check(() => {
      const stale = shippedAgents().filter((f) => {
        const t = readText(path.join(CLAUDE, "agents", f));
        return t === null || norm(t) !== norm(fs.readFileSync(path.join(HERE, "agents", f), "utf8"));
      });
      return stale.length ? ["FIX", `~/.claude/agents: ${stale.length} shipped agents missing or stale`, self] : ["ok", "global agents current"];
    }, () => copyAgents());
  }
  if (!plug) check(() => {
    const c = readJson(path.join(CLAUDE, "proteus.json"));
    return c && samePath(c.home, real(HERE)) ? ["ok", `proteus.json home, autoUpdate ${c.autoUpdate === true}`]
      : ["FIX", "~/.claude/proteus.json missing or points elsewhere", self];
  }, () => writeConfig());
  if (!cxh) check(() => {
    const s = readJson(path.join(CLAUDE, "settings.json"));
    const a = s && s.attribution;
    if (!s) return ["FIX", "~/.claude/settings.json is not valid JSON", "fix it by hand, then re-run"];
    if (keepAttribution()) return ["ok", "attribution: kept as set (proteus.json attribution: keep)"];
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
  if (!cxh && !plug) check(() => {
    const kept = dirs.flatMap((d) => projectDupes(d, false).overrides);
    return kept.length ? ["WARN", `local agent overrides, which shipped updates skip: ${kept.map((p) => overrideNote(p)).join(", ")}`,
      "deleting one drops those edits: put them in .claude/proteus-agents.json (docs/install.md: Agent patches), then delete the copy"] : ["ok", "no local agent overrides"];
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
    // what binds proteus/* and who the agents are there; the ruleset is the human's, set once by --protect.
    // ghAuthed is read when the row runs: the gh row before it sets it, after every row is registered
    let repo = "";
    if (isProject) check(() => {
      if (!ghAuthed) return ["WARN", "proteus/* rules not checked (gh not ready)", "gh auth login"];
      repo = json(ghAs("", ["repo", "view", "--json", "nameWithOwner"], { cwd: root }).out)?.nameWithOwner || "";
      if (!repo) return ["WARN", "proteus/* rules not checked (gh repo view fails)", "gh repo view"];
      const rules = runRules(repo);
      if (rulesHold(rules) && rulesMissing(rules).length) return ["WARN", `proteus/* ruleset on ${repo} does not require ${rulesMissing(rules).join(", ")}: a PR merges without the verifier's signoff`, `${self} --protect (run by an admin of ${repo}), once no run is open`];
      const loose = vapp && rulesHold(rules) ? rulesUnpinned(rules, vapp) : [];
      if (loose.length) return ["WARN", `proteus/* ruleset on ${repo} takes ${loose.join(", ")} from any login, not only the verifier App ${vapp.appId}: an agent's token can post them`, `${self} --protect (run by an admin of ${repo}), once no run is open`];
      if (rulesHold(rules)) return ["ok", `proteus/* ruleset: PR with gates, verdict and security green${vapp ? ` (the verdicts from App ${vapp.appId})` : ""}, no force push`];
      return ["WARN", `no ruleset binds proteus/* on ${repo}${rules ? "" : " (or gh cannot read it)"}: the lead falls back to per-run protection, which only an admin's login can set`, `${self} --protect (run by an admin of ${repo})`];
    });
    if (isProject) check(() => {
      if (!bot || !repo) return ["ok", "agents' access not checked (no agents' login or repo)"];
      const p = ghAs("", ["api", `repos/${repo}/collaborators/${bot}/permission`, "--jq", ".permission"], { cwd: root }).out;
      if (p === "admin") return ["WARN", `${bot} is an admin of ${repo} and can lift the ruleset`, "lower it to write in Settings > Collaborators"];
      return p === "write" || p === "maintain" ? ["ok", `${bot} has ${p} on ${repo}`] : ["FIX", `${bot} cannot push to ${repo} (${p || "unknown"})`, `${self} --protect (run by an admin of ${repo})`];
    });
    check(() => {
      const m = migrateProject(root, false);
      if (m.found.length) return ["FIX", `hivemind's pieces in this repo: ${m.found.join(", ")}`, `${self} --project`];
      return m.kept.length ? ["WARN", `hivemind's, left alone in this repo: ${m.kept.join("; ")}`, "move, edit or delete them yourself"] : ["ok", "no hivemind pieces in this repo"];
    }, plug ? null : () => migrateRepo(root, {}, [HARNESS]));
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
    if (plug) pluginChecks(check, top.out, self);
    if (!isProject) {
      check(() => ["WARN", "not a Proteus project (no teams/)", `${self} ${plug ? "--plugin-setup" : "--project"}`]);
    } else {
      check(() => isFile(path.join(base, "teams", "ROUTING.md")) ? ["ok", "teams/ROUTING.md"]
        : ["WARN", "teams/ROUTING.md missing", `${self} --project`]);
      // a release changed a team file the repo owns; --project left the new text beside it
      check(() => {
        const up = upstreamPending(path.join(base, "teams"));
        const t = (u) => `teams/${u.slice(0, -".upstream".length)}`, based = (u) => isFile(path.join(base, ...`${t(u)}.base`.split("/")));
        const how = up.map((u) => (based(u) ? `git merge-file ${t(u)} ${t(u)}.base ${t(u)}.upstream` : `merge ${t(u)}.upstream into ${t(u)} by hand`));
        return up.length ? ["WARN", `shipped team file changes not merged: ${up.map((u) => `teams/${u}`).join(", ")}`,
          `${how.join("; ")}; then delete the .upstream and .base files`]
          : ["ok", "no pending teams/*.upstream"];
      });
      // a shipped team the repo has no evidence for and no ROUTING.md row matching a tracked file (#156); removing
      // it is the human's call: the line gives the command
      check(() => {
        const teams = path.join(base, "teams"), mine = L.profiles(teams).filter((p) => ["frontend", "backend", "devops"].includes(p));
        if (!mine.length) return ["ok", "no shipped software team to check against the repo"];
        const a = TF.assess(top.out);
        if (a.capped) return ["ok", `team fit not checked: ${a.why}`];
        const routing = readText(path.join(teams, "ROUTING.md")) || "";
        const idle = mine.filter((p) => !a.teams[p].fits && !routedFiles(routing, p, top.out));
        if (!idle.length) return ["ok", `shipped teams fit this repo (${mine.join(", ")})`];
        const rel = (p) => (guest ? path.join(teams, p) : `teams/${p}`);
        const rm = (p) => `${guest ? "" : `git rm -r -q --ignore-unmatch -- ${rel(p)}; `}${WIN ? `cmd /c rmdir /s /q "${rel(p).split("/").join("\\")}"` : `rm -rf "${rel(p)}"`}`;
        return ["WARN", idle.map((p) => `team ${p} fits nothing here (${a.teams[p].reason}, no ROUTING row matches a tracked file)`).join("; "),
          `if the repo has no use for it, remove it: ${idle.map(rm).join("; ")}; then delete its rows from teams/ROUTING.md${guest ? "" : " and commit"}`];
      });
      if (guest) {
        const ad = () => (cxh ? cx() : require(path.join(HERE, "templates", "hooks", "proteus-harness-claude.js")));
        check(() => {
          const w = ad().allowDir(root, guest, false);
          if (w.error) return ["FIX", w.error, `let the session write in ${guest}`];
          return w.missing ? ["FIX", `guest mode, but ${path.relative(root, w.file).split(path.sep).join("/")} does not open ${guest} to the session`, `${self} --project`]
            : ["ok", `guest mode: Proteus files in ${guest}`];
        }, () => allowGuest(root, guest));
      }
      if (!plug) check(() => {
        const s = readJson(path.join(root, ...(cxh ? [".codex", "hooks.json"] : [".claude", "settings.local.json"])));
        const hooks = JSON.stringify((s && s.hooks) || {});
        const miss = ["proteus-autostart.js", "proteus-lead-guard.js"].filter((f) => !hooks.includes(f) || !isFile(path.join(root, hd, "hooks", f)));
        if (miss.length) return ["FIX", `lead hooks not registered: ${miss.join(", ")}`, `${self} --project`];
        // without it the hooks throw in a repo whose package.json sets "type": "module", and fail open (#77)
        return isFile(path.join(root, hd, "hooks", "package.json")) ? ["ok", "lead hooks registered"]
          : ["FIX", `${hd}/hooks/package.json missing (the hooks fail in a "type": "module" repo)`, `${self} --project`];
      }, () => registerHooks(root));
      // .claude/proteus-agents.json lives at the repo's top level, as --project (run from there) reads it
      const patchRoot = top.out;
      if (!plug) check(() => {
        const p = withProject(patchRoot, () => ap().plan(patchRoot, HERE, adapter()));
        if (p.error) return ["FIX", p.error, `fix that entry, then ${self} --project`];
        const rel = (x) => path.relative(patchRoot, x).split(path.sep).join("/");
        const stale = [...p.write.map((w) => w.path), ...p.remove].map(rel);
        if (stale.length) return ["FIX", `generated agents out of date with ${p.file}: ${stale.join(", ")}`, `${self} --project`];
        if (p.refused.length) return ["WARN", `${p.file} not applied through a link: ${p.refused.map(rel).join(", ")}`, "replace each with a real directory or file"];
        if (p.kept.length) return ["WARN", `${p.file} not applied over local copies: ${p.kept.map((k) => rel(k.path)).join(", ")}`, "move their edits into the patch file, then delete the copies"];
        return ["ok", p.present ? `agent patches applied (${p.file})` : "no agent patches"];
      }, () => agentPatches(patchRoot));
      if (cxh) {
        check(() => {
          const left = cx().skipHooks.filter((f) => lstat(path.join(root, hd, "hooks", f)));
          return left.length ? ["FIX", `Claude-only files in .codex/hooks: ${left.join(", ")}`, `${self} --project`] : ["ok", "no Claude-only files in .codex/hooks"];
        }, () => registerHooks(root));
        check(() => readText(path.join(root, ".codex", "rules", "proteus.rules")) === cx().RULES ? ["ok", ".codex/rules/proteus.rules"]
          : ["FIX", ".codex/rules/proteus.rules missing or stale", `${self} --project`], () => registerHooks(root));
        check(() => {
          const w = cx().sandboxRoots(root, false);
          const old = w.kept.map((k) => `${k.dir} (${k.worktrees.join(", ")})`).join(", ");
          if (w.error) return ["FIX", w.error.replace(/; add .*/, ""), `add ${w.kept.map((k) => k.dir).join(" and ")} to writable_roots under [sandbox_workspace_write] in .codex/config.toml`];
          if (w.missing.length) return ["FIX", `workers of an older run cannot write in ${w.missing.join(", ")}: .codex/config.toml does not list it in writable_roots`, `${self} --project`];
          if (w.stale.length) return ["FIX", `${w.stale.join(", ")} still in writable_roots, but no worktree of an older run is left in it`, `${self} --project`];
          return ["ok", `worker worktrees in .worktrees/, writable in the Codex sandbox${old ? `; kept while an older run has worktrees there: ${old}` : ""}`];
        }, () => { if (sandboxRoots(root).created) excludeLocal(root, [".codex/config.toml"], "config.toml"); });
        check(() => codexTrusted(root) ? ["ok", "project trusted in codex"]
          : ["WARN", "project not trusted in codex: its .codex/ hooks do not load", "open codex here, trust the project, approve the hooks in /hooks"]);
      }
      check(() => {
        const r = spawnSync(process.execPath, [path.join(HERE, "templates", "hooks", "proteus-scratch.js"), "--size"], { cwd: root, encoding: "utf8", timeout: 60000 });
        const mb = parseFloat(r.stdout);
        const script = plug ? `"${path.join(HERE, "templates", "hooks", "proteus-scratch.js")}"` : `${hd}/hooks/proteus-scratch.js`;
        if (r.status !== 0 || !Number.isFinite(mb)) return ["WARN", "scratch size unknown", `node ${script} --size`];
        return mb > 1024 ? ["WARN", `scratch holds ${mb} MB`, `node ${script} --sweep --all-done`] : ["ok", `scratch ${mb} MB`];
      });
      check(() => {
        const teams = path.join(base, "teams");
        const dir = (p) => (cxh ? cx().teamSkills(path.join(teams, p)) : path.join(teams, p, ".claude", "skills"));
        const unlinked = L.profiles(teams).map((p) => [p, L.listFiles(path.join(teams, p)).flatMap(L.readList)
          .filter(([, name]) => L.validName(name) && !real(path.join(dir(p), name))).length]).filter(([, n]) => n);
        const ign = teamsIgnore(teams, false);
        if (ign.length) return ["FIX", `teams/.gitignore lacks ${ign.join(", ")} (skill links would be committed)`, `${self} --project`];
        return unlinked.length ? ["FIX", `team skills not linked (${unlinked.map(([p, n]) => `${p} ${n}`).join(", ")})`, `node "${path.join(SHIPPED_TEAMS, "link-skills.js")}" --install`]
          : ["ok", "team skills linked"];
      }, () => { teamsIgnore(path.join(base, "teams"), true); withProject(root, () => L.run({ root: base, install: true, log, remove: guardedRemove })); });
      // CI runs the gate on a clean checkout: the file it names must be tracked (a Codex-only repo
      // has no .claude/hooks/commit-msg.js, and .codex/hooks is machine-local), and so must the
      // package.json that keeps it CommonJS when the repo's says "type": "module" (#77)
      if (!guest) check(() => {
        const tracked = (rel) => git(["ls-files", "--error-unmatch", "--", rel], root).ok;
        // the nearest tracked package.json from the gate's dir up decides how a clean checkout runs it
        const esm = (rel) => {
          for (let d = path.posix.dirname(rel); ; d = path.posix.dirname(d)) {
            const pj = d === "." ? "package.json" : `${d}/package.json`;
            if (tracked(pj)) return (readJson(path.join(root, pj)) || {}).type === "module";
            if (d === "." || d === "/" || d === "..") return false;
          }
        };
        const found = [], bad = [], mod = [];
        for (const f of ["lefthook.yml", ".github/workflows/proteus-gates.yml"]) {
          for (const m of (readText(path.join(root, f)) || "").matchAll(/\bnode\s+["']?([^\s"']*commit-msg\.js)/g)) {
            found.push(f);
            const rel = m[1].replace(/\\/g, "/").replace(/^\.\//, "");
            if (!tracked(rel)) bad.push(`${f} runs ${m[1]}`);
            else if (esm(rel)) mod.push(`${f} runs ${m[1]}`);
          }
        }
        if (bad.length) return ["FIX", `commit-msg gate: ${bad.join("; ")}, which git does not track`, `point it at ${COMMIT_MSG} and commit`];
        if (mod.length) return ["FIX", `commit-msg gate: ${mod.join("; ")} as an ES module (no tracked package.json says "commonjs")`, `point it at ${COMMIT_MSG} and commit teams/templates/hooks/package.json`];
        return ["ok", found.length ? "commit-msg gate runs a tracked file" : "commit-msg gate not installed yet (the scaffold ticket adds it)"];
      });
      // the template's EDIT-* steps fail on purpose; a workflow that still has one keeps every PR red
      if (!guest) check(() => {
        const left = [...(readText(path.join(root, ".github", "workflows", "proteus-gates.yml")) || "").matchAll(/^[^#\n]*\b(EDIT-\w+)/gm)].map((m) => m[1]);
        return left.length ? ["WARN", `.github/workflows/proteus-gates.yml still has unfilled placeholders (${[...new Set(left)].join(", ")}): its gates fail every PR until they run real commands`, "replace each EDIT-* step with the project's command and commit"] : ["ok", "proteus-gates.yml has no unfilled placeholder"];
      });
    }
  }

  let failing = 0;
  for (const c of checks) {
    let r = await c.test();
    if ((r[0] === "FIX" || (r[0] === "WARN" && c.fixOnWarn)) && fix && c.fixFn) {
      quiet = true;
      try { c.fixFn(); } catch (e) { warn(`fix failed: ${e.message}`); } finally { quiet = false; }
      r = await c.test();
      if (r[0] === "ok") r[1] += " (fixed)";
    }
    if (r[0] === "FIX") failing++;
    console.log(`${r[0].padEnd(4)} ${r[1]}${r[0] === "ok" ? "" : ` — ${r[2]}`}`);
  }
  console.log(failing ? `\n${failing} to fix${fix ? "" : "; --doctor --fix applies the local ones"}` : "\nall good");
  return failing === 0;
}

// a plugin setup in the repo at root: the gate and marketplace entries --plugin-setup writes, no 1.x copies left,
// and the last release check (D6) the autostart cached in the plugin's data dir
function pluginChecks(check, root, self) {
  const s = readJson(path.join(root, ".claude", "settings.json")) || {}, gate = gateFrom(root);
  check(() => gate.on ? ["ok", `plugin gate: .claude/${gate.file} enables ${PLUGIN_ID}`]
    : gate.file === "settings.local.json" ? ["FIX", `plugin gate: .claude/settings.local.json sets ${PLUGIN_ID} to false, which wins over settings.json, so the plugin's hooks stay silent here`, `set enabledPlugins["${PLUGIN_ID}"] to true in .claude/settings.local.json, or remove it there`]
      : ["FIX", `plugin gate: neither .claude/settings.local.json nor .claude/settings.json enables ${PLUGIN_ID}, so the plugin's hooks stay silent here`, `${self} --plugin-setup`]);
  check(() => isObj((s.extraKnownMarketplaces || {}).proteus) ? ["ok", "plugin marketplace: .claude/settings.json lists proteus for teammates"]
    : ["WARN", "plugin marketplace: .claude/settings.json lists no proteus marketplace, so teammates are not offered the plugin", `${self} --plugin-setup`]);
  check(() => {
    const m = withProject(root, () => oldProjectInstall(root, false, { "settings.json": readJson(path.join(root, ".claude", "settings.json")) || {}, "settings.local.json": readJson(path.join(root, ".claude", "settings.local.json")) || {} }));
    if (m.found.length) return ["FIX", `1.x copies beside the plugin: ${m.found.join(", ")}`, `${self} --plugin-setup`];
    // a tracked copy someone edited is theirs: no advice to delete it
    const mine = m.kept.filter((k) => !k.endsWith("; left alone)")).map((k) => k.replace(/ \(.*$/, ""));
    return m.kept.length ? ["WARN", `1.x copies left alone: ${m.kept.join("; ")}`, mine.length ? `${mine.join(", ")}: move their edits out, then delete them` : "nothing to do: their edits are the repo's, kept on purpose"]
      : ["ok", "no 1.x copies beside the plugin"];
  }, () => migrateToPlugin(root));
  check(() => {
    const r = releaseState(root);
    if (!r.sha) return ["WARN", `release check: ${PLUGIN_ID} is not installed in ${CLAUDE}`, "claude plugin install proteus@proteus (README)"];
    if (!r.result || r.at !== r.sha) return ["WARN", `release check: no result yet for the installed commit ${r.sha.slice(0, 12)}`, "start a Claude Code session in this repo; its startup runs the check"];
    if (r.result.tag) return ["ok", `release check: ${r.sha.slice(0, 12)} is the verified release ${r.result.tag}`];
    return ["WARN", `release check: the installed commit ${r.sha.slice(0, 12)} is not a verified release (${r.result.error || "unverified"})`,
      r.result.newest ? `pin to ${r.result.newest}, the newest verified release: ${hl().pinCommand(r.result.newest)}` : "trust the maintainer's key: docs/updating.md \"Releases\""];
  });
}
// CLAUDE_PLUGIN_DATA: the config dir's plugins/data/<id, other than [a-z0-9_-] as ->
const pluginData = () => process.env.CLAUDE_PLUGIN_DATA || path.join(CLAUDE, "plugins", "data", PLUGIN_ID.replace(/[^a-z0-9_-]/gi, "-"));
// the release check the autostart runs (lib.releaseCheck), once, when the plugin is installed: its result lands in the
// cache --doctor reads. A failed fetch is a line, never an error; the session start tries again.
function setupReleaseCheck(root) {
  if (!releaseState(root).sha) { log(`release  -> skipped (${PLUGIN_ID} is not installed in ${CLAUDE})`); return; }
  const notes = [];
  try { hl().releaseCheck(root, notes, HERE, pluginData()); } catch (e) { notes.push(`release check failed: ${e.message}`); }
  const r = releaseState(root);
  if (r.result && r.at === r.sha && r.result.tag) log(`release  -> ${r.sha.slice(0, 12)} is the verified release ${r.result.tag}`);
  for (const n of notes) log(`release  -> ${n.replace(/^proteus: /, "").replace(/ Tell the human once; nothing is blocked\.$/, "")}`);
  if (!notes.length && !(r.result && r.at === r.sha)) log("release  -> no result yet (no tags fetched); a session start checks again");
}
// the installed commit of proteus@proteus (this project's install, else the user's) and the release check's cache
function releaseState(root) {
  const all = (((readJson(path.join(CLAUDE, "plugins", "installed_plugins.json")) || {}).plugins || {})[PLUGIN_ID] || []).filter(isObj);
  const e = all.find((x) => typeof x.projectPath === "string" && samePath(x.projectPath, root)) || all.find((x) => x.scope === "user") || all[0];
  const sha = e && typeof e.gitCommitSha === "string" ? e.gitCommitSha.trim().toLowerCase() : "";
  const c = readJson(path.join(pluginData(), "release-check.json")) || {};
  return { sha, at: typeof c.sha === "string" ? c.sha : "", result: isObj(c.result) ? c.result : null };
}

// main

const FLAGS = {
  "--project": "project", "--install": "install", "--confine": "confine", "--update": "update",
  "--doctor": "doctor", "--fix": "fix", "--auto-update": "autoUpdate", "--no-auto-update": "noAutoUpdate",
  "--tour-done": "tourDone", "--migrate-all": "migrateAll", "--protect": "protect", "--no-guest": "noGuest",
  "--plugin-setup": "pluginSetup", "--dry-run": "dryRun", "--remove-user-install": "removeUser",
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
    if (a === "--verifier-app") {
      opt.verifierApp = [argv[i + 1], argv[i + 2]];
      i += 2;
      continue;
    }
    if (a === "--guest" || a.startsWith("--guest=")) {
      opt.guest = a === "--guest" ? (argv[i + 1] && !argv[i + 1].startsWith("-") ? argv[++i] : true) : a.slice("--guest=".length) || true;
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
  if ((opt.guest || opt.noGuest) && !opt.project) die("--guest/--no-guest need --project", 2);
  if (opt.guest && opt.noGuest) die("--guest and --no-guest conflict", 2);
  if (opt.confine && codex()) die("--confine hides skills from Claude Code only; Codex reads ~/.agents/skills itself", 2);
  if (opt.fix && !opt.doctor) die("--fix needs --doctor", 2);
  if (opt.doctor && Object.keys(opt).some((k) => k !== "doctor" && k !== "fix")) die("--doctor takes only --fix and --scan", 2);
  if (opt.tourDone && Object.keys(opt).length > 1) die("--tour-done takes no other flag", 2);
  if (opt.autoUpdate && opt.noAutoUpdate) die("--auto-update and --no-auto-update conflict", 2);
  if (opt.dryRun && !opt.pluginSetup && !opt.removeUser) die("--dry-run needs --plugin-setup or --remove-user-install", 2);
  for (const k of ["pluginSetup", "removeUser"]) {
    const flag = k === "pluginSetup" ? "--plugin-setup" : "--remove-user-install";
    if (opt[k] && Object.keys(opt).some((x) => x !== k && x !== "dryRun")) die(`${flag} takes only --dry-run`, 2);
    if (opt[k] && codex()) die(`${flag} is for the Claude Code plugin; Codex uses ${k === "pluginSetup" ? "--project" : "the installer path"}`, 2);
  }
  if ((opt.agentLogin || opt.protect || opt.verifierApp) && Object.keys(opt).length > 1) die("--agent-login, --protect and --verifier-app take no other flag", 2);

  (async () => {
    if (opt.doctor) process.exitCode = (await doctor(opt.fix)) ? 0 : 1;
    else if (opt.tourDone) tourDone();
    else if (opt.agentLogin) process.exitCode = agentLogin(opt.agentLogin === true ? "" : opt.agentLogin) ? 0 : 1;
    else if (opt.protect) process.exitCode = protect() ? 0 : 1;
    else if (opt.verifierApp) process.exitCode = (await verifierApp(...opt.verifierApp)) ? 0 : 1;
    else if (opt.update) update(argv);
    else if (opt.pluginSetup) process.exitCode = pluginSetup(opt) ? 0 : 1;
    else if (opt.removeUser) process.exitCode = removeUserInstall(opt) ? 0 : 1;
    else process.exitCode = install(opt) ? 0 : 1;
  })().catch((e) => die(`error: ${e.message}`));
}

// required rather than run (tests): the delete guard only, and nothing runs
module.exports = { allowedRoots, safeRemove, stateLeft };
if (require.main === module) main();

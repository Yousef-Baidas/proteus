// Every repo onto the plugin in one action (#155): node tests/migrateall.test.js (needs git). Each "world" is its own
// fake HOME with a 1.x user install, 1.x project installs in fixture repos and a fake installed_plugins.json; discovery
// reads only that HOME's .claude.json, proteus.json registry, $CODEX_HOME/config.toml and the --scan dirs named.
// Fakes: claude (plugin install per scope, logged), gh (tests/fakegh.js) and npx; never the network, the real
// ~/.claude.json or a real repo.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("migrateall");
const INSTALL = path.join(ROOT, "install.js");
const PLUGIN_HOOK = path.join(ROOT, "templates", "hooks", "proteus-plugin.js");
const WIN = process.platform === "win32";
const read = (...p) => { try { return fs.readFileSync(path.join(...p), "utf8"); } catch { return null; } };
const json = (...p) => { try { return JSON.parse(read(...p)); } catch { return null; } };
const exists = (...p) => fs.existsSync(path.join(...p));
const both = (r) => `${r.out}${r.err}`;
const lf = (s) => (s === null ? null : s.replace(/\r\n/g, "\n"));
const norm = (p) => p.split(path.sep).join("/");

// on win32 an npx.cmd shim, as the real one is
// fake npx: `skills add <src> --skill <name>` puts the skill where link-skills looks, ~/.agents/skills/<name>
const NPX = `const fs = require("fs"), path = require("path"), os = require("os"), a = process.argv.slice(2);
const i = a.indexOf("--skill");
if (a[1] === "skills" && a[2] === "add" && i > 0) {
  const d = path.join(os.homedir(), ".agents", "skills", a[i + 1]);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "SKILL.md"), "---\\nname: " + a[i + 1] + "\\n---\\n");
}`;
if (WIN) {
  fs.writeFileSync(path.join(W, "npx.js"), NPX);
  fs.writeFileSync(path.join(lib.BIN, "npx.cmd"), `@"${process.execPath}" "${path.join(W, "npx.js")}" %*\r\n`);
} else lib.fakeCli(lib.BIN, "npx", NPX);

// fake claude, in its own dir so a run can go without it: `plugin install proteus@proteus --scope <s>` adds an
// installed_plugins.json entry (projectPath the cwd below user scope) and the gate as the real CLI writes it;
// every call is logged to FAKE_CLAUDE_LOG as "<cwd> :: <args>"
const CBIN = path.join(W, "cbin");
fs.mkdirSync(CBIN);
lib.fakeCli(CBIN, "claude", `const fs = require("fs"), path = require("path"), os = require("os");
const a = process.argv.slice(2).join(" ");
if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, process.cwd() + " :: " + a + "\\n");
const d = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const rd = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {}; } };
const m = /^plugin install (proteus@proteus) --scope (user|project|local)$/.exec(a);
if (m) {
  const f = path.join(d, "plugins", "installed_plugins.json"), j = rd(f);
  j.version = 2; j.plugins = j.plugins || {};
  const e = { scope: m[2], installPath: ${JSON.stringify(ROOT)}, version: "2.0.0", gitCommitSha: "${"0a".repeat(20)}" };
  if (m[2] !== "user") e.projectPath = process.cwd();
  j.plugins[m[1]] = [...(j.plugins[m[1]] || []), e];
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(j));
  const s = m[2] === "user" ? path.join(d, "settings.json") : path.join(process.cwd(), ".claude", m[2] === "project" ? "settings.json" : "settings.local.json");
  const v = rd(s); v.enabledPlugins = { ...v.enabledPlugins, [m[1]]: true };
  fs.mkdirSync(path.dirname(s), { recursive: true });
  fs.writeFileSync(s, JSON.stringify(v, null, 2));
}
`);

const SHA0 = "0a".repeat(20);
// a world: a fake HOME with its own .claude, a 1.x user install, and repos made inside it
function world(name, installer = INSTALL) {
  const home = path.join(W, name);
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  const w = {
    home, CL: path.join(home, ".claude"), log: path.join(W, `${name}.claude.log`),
    env: {
      ...lib.homeEnv(home), FAKE_CLAUDE_LOG: path.join(W, `${name}.claude.log`), FAKE_GH_LOG: path.join(W, `${name}.gh.log`), CODEX_HOME: path.join(home, ".codex"),
      FAKE_GH_STATE: path.join(W, `${name}.gh.json`), CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
    },
  };
  // a machine set up for Proteus already: the agent teams env above, context-mode and mattpocock-skills installed
  fs.writeFileSync(w.env.FAKE_GH_STATE, "{}");
  fs.mkdirSync(path.join(w.CL, "plugins", "cache", "claude-plugins-official", "mattpocock-skills", "1.0.0", "skills"), { recursive: true });
  fs.writeFileSync(path.join(w.CL, "settings.json"), JSON.stringify({ enabledPlugins: { "context-mode@context-mode": true }, autoMode: { environment: ["$defaults", "Proteus runs agent teams here"] } }));
  // the release check's cached result for the pin the fake installs carry, fetched now: no fetch
  w.data = path.join(w.CL, "plugins", "data", "proteus-proteus");
  fs.mkdirSync(w.data, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(w.data, "release-check.json"), JSON.stringify({ fetched: now, trust: 0, sha: SHA0, result: { tag: "v2.0.0" }, bySha: { [SHA0]: { trust: 0, fetched: now, sha: SHA0, result: { tag: "v2.0.0" } } } }));
  const PATH = (claude) => [...(claude ? [CBIN] : []), lib.BIN, path.dirname(process.execPath), ...lib.SYS_PATH].join(path.delimiter);
  w.run = (cwd, args, env = {}, claude = true) => lib.run(installer, "", { cwd, args, env: { ...w.env, PATH: PATH(claude), ...env } });
  w.hook = (cwd, env = {}) => lib.run(PLUGIN_HOOK, "{}", { cwd, args: ["proteus-autostart.js"], env: { ...w.env, PATH: PATH(true), CLAUDE_PLUGIN_ROOT: ROOT, CLAUDE_PLUGIN_DATA: w.data, ...env } });
  // a repo with a 1.x project install; origin on GitHub when owner is given
  w.repo = (rel, owner = "human") => {
    const d = path.join(home, ...rel.split("/"));
    fs.mkdirSync(path.dirname(d), { recursive: true });
    g(home, "init", "-q", "-b", "main", d);
    fs.writeFileSync(path.join(d, "README.md"), "# r\n");
    g(d, "add", "README.md"); g(d, "commit", "-q", "-m", "init");
    if (owner) g(d, "remote", "add", "origin", `https://github.com/${owner}/${path.basename(d)}.git`);
    const r = w.run(d, ["--project"], {}, false);
    if (r.code !== 0 || !exists(d, ".claude", "hooks", "proteus-lib.js")) throw new Error(`1.x --project failed in ${d}: ${both(r).slice(-800)}`);
    return d;
  };
  w.projects = (...ps) => fs.writeFileSync(path.join(w.CL === path.join(home, ".claude") ? home : w.CL, ".claude.json"), JSON.stringify({ projects: Object.fromEntries(ps.map((p) => [p, {}])) }));
  w.plugins = (entries) => {
    fs.mkdirSync(path.join(w.CL, "plugins"), { recursive: true });
    const plugins = { "context-mode@context-mode": [{ scope: "user" }] };
    if (entries) plugins["proteus@proteus"] = entries.map((e) => ({ gitCommitSha: SHA0, ...e }));
    fs.writeFileSync(path.join(w.CL, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins }));
  };
  w.claudeLog = () => read(w.log) || "";
  w.plugins(null);
  const r = w.run(home, [], {}, false);
  if (r.code !== 0) throw new Error(`1.x user install failed: ${both(r).slice(-800)}`);
  return w;
}

const old = (d) => exists(d, ".claude", "hooks", "proteus-lib.js");
const gateIn = (d, f) => (json(d, ".claude", f) || {}).enabledPlugins?.["proteus@proteus"] === true;
const status = (d) => g(d, "status", "--porcelain", "-uall");
const snap = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.name === ".git") { out.push(`exclude ${read(p, "info", "exclude")} index ${(read(p, "index") || "").length}`); continue; }
      if (e.isDirectory()) walk(p); else out.push(`${path.relative(dir, p)} ${e.isFile() ? fs.readFileSync(p, "base64") : "link"}`);
    }
  };
  walk(dir);
  return out.sort().join("\n");
};
const hashText = (s) => crypto.createHash("sha256").update(s.replace(/\r\n/g, "\n").trimEnd()).digest("hex");

// ======== the main world: the plugin at user scope, /proteus:setup in one repo moves the rest
const M = world("main");
M.plugins([{ scope: "user", installPath: ROOT, version: "2.0.0" }]);
const HERE = M.repo("code/here");
const PLAIN = M.repo("code/plain");
const UNREL = M.repo("code/unrel");
const RCLEAN = M.repo("code/rclean");
const RCONF = M.repo("code/rconf");
const THEIRS = M.repo("code/theirs", "other");
const EDITED = M.repo("code/edited");
const DIRTY = M.repo("code/dirty");
const BUSY = M.repo("code/busy");
const CODEXSRC = M.repo("work/codexsrc");
const SCANNED = M.repo("deep/a/scanned");
const TOODEEP = M.repo("deep/a/b/c/toodeep");
const LAZY = M.repo("elsewhere/lazy");

// a worktree of plain, and a link to plain, both in the project list: plain is moved once, the worktree not at all
const WT = path.join(M.home, "code", "plain-wt");
g(PLAIN, "worktree", "add", "-q", "-b", "feature", WT);
const LINK = path.join(M.home, "code", "plain-link");
let linked = true;
try { fs.symlinkSync(PLAIN, LINK, WIN ? "junction" : "dir"); } catch { linked = false; }

// unrel: its status line copy is the 1.x checkout's text at an unreleased commit (the 1.x home is another checkout)
const OLDHOME = path.join(W, "onex-checkout");
for (const sub of ["templates/hooks", "agents"]) fs.cpSync(path.join(ROOT, sub), path.join(OLDHOME, sub), { recursive: true });
const UNRELEASED = `${read(ROOT, "templates", "hooks", "proteus-statusline.js")}\n// an unreleased commit\n`;
fs.writeFileSync(path.join(OLDHOME, "templates", "hooks", "proteus-statusline.js"), UNRELEASED);
fs.writeFileSync(path.join(UNREL, ".claude", "hooks", "proteus-statusline.js"), UNRELEASED);
const cfg = json(M.CL, "proteus.json");
fs.writeFileSync(path.join(M.CL, "proteus.json"), JSON.stringify({ ...cfg, home: OLDHOME }, null, 2));

// rclean / rconf: ROUTING.md copied from a past shipped text and edited; this release changed the shipped one
const known = require(path.join(ROOT, "scripts", "known-blobs.json")).texts["templates/teams/ROUTING.md"];
const CUR = lf(read(ROOT, "templates", "teams", "ROUTING.md"));
const PAST = lf(Object.values(known).find((t) => lf(t) !== CUR));
const merges = (mine) => {
  const t = path.join(W, "merge");
  fs.mkdirSync(t, { recursive: true });
  fs.writeFileSync(path.join(t, "a"), mine); fs.writeFileSync(path.join(t, "o"), PAST); fs.writeFileSync(path.join(t, "b"), CUR);
  return spawnSync("git", ["merge-file", "-p", "a", "o", "b"], { cwd: t, encoding: "utf8" }).status === 0;
};
const pl = PAST.split("\n");
let CLEAN = null;
for (let i = 1; i < pl.length && !CLEAN; i++) {
  const t = [...pl.slice(0, i), "<!-- mine: clean -->", ...pl.slice(i)].join("\n");
  if (merges(t)) CLEAN = t;
}
const CONFLICT = "# Routing\n\nmine, all of it\n";
ok("fixture: a clean and a conflicting edit of a past ROUTING.md", !!CLEAN && !merges(CONFLICT), String(CLEAN).slice(0, 200));
for (const [d, t] of [[RCLEAN, CLEAN], [RCONF, CONFLICT]]) {
  fs.writeFileSync(path.join(d, "teams", "ROUTING.md"), t);
  const rec = json(d, "teams", ".proteus-base.json");
  rec["ROUTING.md"] = { sha256: hashText(PAST) };
  fs.writeFileSync(path.join(d, "teams", ".proteus-base.json"), JSON.stringify(rec, null, 2));
}

// theirs: someone else's repo with teams/ committed
g(THEIRS, "add", "teams"); g(THEIRS, "commit", "-q", "-m", "teams");
const THEIRS_TEAMS = snap(path.join(THEIRS, "teams"));

// edited: a tracked agent copy another author edited
const AGENT = ".claude/agents/proteus-backend-worker.md";
fs.mkdirSync(path.join(EDITED, ".claude", "agents"), { recursive: true });
fs.writeFileSync(path.join(EDITED, ...AGENT.split("/")), `${read(ROOT, "agents", "proteus-backend-worker.md")}\nOur house rules.\n`);
g(EDITED, "add", "-f", AGENT);
g(EDITED, "-c", "user.name=Other Person", "-c", "user.email=other@example.com", "commit", "-q", "--author", "Other Person <other@example.com>", "-m", "agent");
const EDITED_AGENT = read(EDITED, ...AGENT.split("/"));

// dirty: a tracked file changed, one staged, an untracked one
fs.writeFileSync(path.join(DIRTY, "README.md"), "# r\nwork in progress\n");
fs.writeFileSync(path.join(DIRTY, "staged.txt"), "staged\n");
g(DIRTY, "add", "staged.txt");
fs.writeFileSync(path.join(DIRTY, "notes.txt"), "mine\n");
const DIRTY_INDEX = g(DIRTY, "diff", "--cached", "--name-only");

// busy: a run in flight
g(BUSY, "checkout", "-q", "-b", "proteus/run-1");

// a Codex-only repo (its Codex pieces, no Claude 1.x), listed in Codex's config with codexsrc
const CODEXONLY = path.join(M.home, "work", "codexonly");
g(M.home, "init", "-q", "-b", "main", CODEXONLY);
fs.mkdirSync(path.join(CODEXONLY, ".codex"), { recursive: true });
fs.writeFileSync(path.join(CODEXONLY, ".codex", "hooks.json"), '{"hooks":{}}\n');
fs.writeFileSync(path.join(CODEXONLY, "AGENTS.md"), "# agents\n");
const CODEXONLY_SNAP = snap(CODEXONLY);
fs.mkdirSync(path.join(M.home, ".codex"), { recursive: true });
fs.writeFileSync(path.join(M.home, ".codex", "config.toml"), `model = "x"\n\n[projects."${CODEXSRC.replace(/\\/g, "\\\\")}"]\ntrust_level = "trusted"\n\n[projects.'${CODEXONLY}']\ntrust_level = "trusted"\n`);

// the project list: every repo above but codexsrc, scanned, toodeep and lazy, plus a stale path and the duplicates
const STALE = path.join(M.home, "code", "gone");
M.projects(HERE, PLAIN, WT, ...(linked ? [LINK] : []), STALE, UNREL, RCLEAN, RCONF, THEIRS, EDITED, DIRTY, BUSY, M.home);
const LAZY_SNAP = snap(LAZY), TOODEEP_SNAP = snap(TOODEEP);

// ---- offline or gh logged out: nothing changes, this repo included
const before = [HERE, PLAIN].map(snap);
let r = M.run(HERE, ["--plugin-setup"], { FAKE_GH: "fail" });
ok("gh logged out: setup stops before any change", r.code !== 0 && /gh is not logged in/.test(both(r)) && [HERE, PLAIN].map(snap).join() === before.join(), both(r).slice(-1500));

// ---- --dry-run: names what would move, writes nothing
r = M.run(HERE, ["--plugin-setup", "--dry-run", "--scan", path.join(M.home, "deep")]);
ok("dry run: every 1.x repo named, nothing written", r.code === 0 && /would move .*plain/.test(r.out) && [HERE, PLAIN].map(snap).join() === before.join(), both(r).slice(-2000));

// ---- the pass
r = M.run(HERE, ["--plugin-setup", "--scan", path.join(M.home, "deep")]);
const OUT = r.out;
ok("pass: exits 0", r.code === 0, both(r).slice(-3000));
ok("pass: this repo is set up (gate in settings.json, no 1.x copies)", !old(HERE) && gateIn(HERE, "settings.json"), OUT.slice(0, 1500));
ok("pass: it is recorded in proteus.json's repos", (json(M.CL, "proteus.json").repos || []).some((p) => norm(p) === norm(HERE)), read(M.CL, "proteus.json"));
const movedLine = (d) => OUT.split("\n").find((l) => l.startsWith("moved") && l.trimEnd().endsWith(d) || l.startsWith(`moved    ${d} `) || l.startsWith(`moved    ${d};`)) || "";
for (const [n, d] of [["plain", PLAIN], ["unrel", UNREL], ["rclean", RCLEAN], ["rconf", RCONF], ["theirs", THEIRS], ["edited", EDITED], ["dirty", DIRTY], ["codexsrc (Codex's project list)", CODEXSRC], ["scanned (--scan)", SCANNED]]) {
  ok(`pass: ${n} moved in one run`, !old(d) && movedLine(d), OUT);
}
ok("pass: a repo deeper than 3 levels under --scan is not found", old(TOODEEP) && snap(TOODEEP) === TOODEEP_SNAP && !OUT.includes(TOODEEP), OUT);
ok("pass: a repo no source names is left for the lazy hook", old(LAZY) && snap(LAZY) === LAZY_SNAP && !OUT.includes(LAZY), OUT);
ok("pass: the stale path is skipped silently", !OUT.includes(STALE), OUT);
ok("pass: the home dir itself is never a target", !OUT.split("\n").some((l) => /^(moved|skipped) /.test(l) && l.includes(`${M.home}:`)), OUT);
ok("pass: the worktree is not moved on its own and nothing is written in it", !OUT.includes(WT) && !exists(WT, ".claude", "settings.json") && !exists(WT, ".claude", "settings.local.json"), OUT);
ok("pass: the symlinked duplicate moves plain once", !linked || (OUT.split(PLAIN).length - 1 >= 1 && !OUT.includes(LINK) && OUT.split("\n").filter((l) => l.startsWith("moved ") && l.includes(PLAIN)).length === 1), OUT);
ok("pass: the Codex-only repo is left as it was", snap(CODEXONLY) === CODEXONLY_SNAP && !OUT.includes(CODEXONLY), OUT);
ok("pass: the plugin is at user scope, so none is added", !/plugin install/.test(M.claudeLog()) && !/Plugin added to/.test(OUT), M.claudeLog());

// plain: owned, so the gate is committed-style in settings.json; status line, teams/ and the exclude line set
ok("plain: gate and marketplace in settings.json, status line in settings.local.json", gateIn(PLAIN, "settings.json") && !!(json(PLAIN, ".claude", "settings.json").extraKnownMarketplaces || {}).proteus && /proteus-statusline\.js/.test((json(PLAIN, ".claude", "settings.local.json").statusLine || {}).command || ""), read(PLAIN, ".claude", "settings.json"));
ok("plain: no 1.x hook entry is left and settings.local.json stays out of git", !/\.claude[\\/]+hooks[\\/]+proteus-/.test(read(PLAIN, ".claude", "settings.local.json")) && /^\.claude\/settings\.local\.json$/m.test(read(PLAIN, ".git", "info", "exclude")), read(PLAIN, ".claude", "settings.local.json"));
ok("plain: never a commit, never a push", g(PLAIN, "rev-list", "--count", "HEAD") === "1", g(PLAIN, "log", "--oneline"));

// unrel: the unreleased copy is the 1.x checkout's text, so it goes
ok("unreleased copy: removed (it is the 1.x checkout's own text)", !exists(UNREL, ".claude", "hooks", "proteus-statusline.js") && !/unrel: kept/.test(OUT), OUT);

// rclean: merged in place; rconf: .upstream and .base left, named once
ok("ROUTING.md clean: merged in place, no .upstream left", lf(read(RCLEAN, "teams", "ROUTING.md")).includes("<!-- mine: clean -->") && !exists(RCLEAN, "teams", "ROUTING.md.upstream") && !exists(RCLEAN, "teams", "ROUTING.md.base") && !OUT.includes(`${RCLEAN}: teams/ROUTING`), read(RCLEAN, "teams", "ROUTING.md"));
ok("ROUTING.md conflicting: .upstream and .base left, git-excluded, named in the summary", lf(read(RCONF, "teams", "ROUTING.md")) === CONFLICT && lf(read(RCONF, "teams", "ROUTING.md.upstream")) === CUR && exists(RCONF, "teams", "ROUTING.md.base")
  && OUT.includes(`${RCONF}: teams/ROUTING.md.upstream did not merge cleanly`) && !/ROUTING\.md\.upstream/.test(status(RCONF)), OUT);

// theirs: shared; the gate local, teams/ untouched and named with its author
ok("someone else's repo: gate in settings.local.json, the committed settings.json untouched", gateIn(THEIRS, "settings.local.json") && !gateIn(THEIRS, "settings.json"), read(THEIRS, ".claude", "settings.json"));
ok("someone else's repo: tracked teams/ left alone and named with its last author", snap(path.join(THEIRS, "teams")) === THEIRS_TEAMS && OUT.includes(`${THEIRS}: left for other: teams/ (tracked; last changed by t)`), OUT);
ok("someone else's repo: one owner line among the GitHub items", OUT.includes(`${THEIRS}: owned by other; its GitHub steps (--protect) are theirs`), OUT);

// edited: shared by authorship; the agent copy kept and named
ok("agent edited by another author: left as it was", read(EDITED, ...AGENT.split("/")) === EDITED_AGENT && gateIn(EDITED, "settings.local.json") && !gateIn(EDITED, "settings.json"), read(EDITED, ".claude", "settings.json"));
ok("agent edited by another author: the summary names them", OUT.includes(`${EDITED}: kept ${AGENT} (edited by Other Person; left alone)`), OUT);

// dirty: the work in progress untouched, nothing staged
ok("uncommitted work: changes and index as they were", read(DIRTY, "README.md") === "# r\nwork in progress\n" && read(DIRTY, "notes.txt") === "mine\n" && g(DIRTY, "diff", "--cached", "--name-only") === DIRTY_INDEX, status(DIRTY));

// busy: skipped, and so the 1.x user install stays, naming it
ok("run in flight: skipped with why, its copies kept", old(BUSY) && OUT.includes(`skipped  ${BUSY}: a run is in flight (proteus/run-1 is checked out); it moves when the run ends`), OUT);
ok("run in flight: the 1.x user install stays, naming that repo", OUT.includes(`still used by ${BUSY}`) && exists(M.CL, "proteus.json"), OUT);

// the summary: only the human's GitHub items, each owned repo's --protect line
const ghAt = OUT.indexOf("Yours to do on GitHub:"), gh = [];
for (const l of ghAt < 0 ? [] : OUT.slice(ghAt).split("\n").slice(1)) { if (!l.startsWith("  ")) break; gh.push(l); }
ok("summary: the GitHub items are --protect, the verifier App, or an owner line", OUT.includes("Yours to do on GitHub:") && gh.length > 0 && gh.every((l) => /--protect|--verifier-app|owned by /.test(l)), OUT);
ok("summary: --protect for each owned repo moved", [PLAIN, UNREL, RCLEAN, DIRTY].every((d) => gh.some((l) => l.includes(`cd "${d}"`) && l.endsWith("--protect"))), gh.join("\n"));

// ---- the run ends: --migrate moves busy, and with every repo covered the 1.x user install goes
g(BUSY, "checkout", "-q", "main");
r = M.run(HERE, ["--migrate"]);
ok("after the run: busy moved by --migrate", r.code === 0 && !old(BUSY) && r.out.includes(`moved    ${BUSY}`), both(r).slice(-2000));
ok("after the run: the 1.x user install removed", /Removed the 1\.x user install/.test(r.out), r.out);
r = M.run(HERE, ["--migrate"]);
ok("a second --migrate: nothing to do, nothing printed", r.code === 0 && r.out.trim() === "", both(r));

// the doctor in each moved repo: nothing left but GitHub items
for (const d of [PLAIN, UNREL, RCLEAN, DIRTY, CODEXSRC, SCANNED]) {
  const dr = M.run(d, ["--doctor"]);
  const rows = dr.out.split("\n").filter((l) => /^(FIX|WARN) /.test(l) && !/--protect|--verifier-app|--agent-login/.test(l));
  ok(`doctor in ${path.basename(d)}: only GitHub items left`, rows.length === 0, rows.join("\n"));
}

// ---- the lazy hook: lazy, outside every source and scan dir, moves on first open, once
const MARK = path.join(M.data, "migrated.json");
r = M.hook(LAZY);
ok("lazy hook: moves the repo and prints one line", r.code === 0 && !old(LAZY) && r.out.trim().split("\n").length === 1 && r.out.startsWith("proteus: moved this repo from its 1.x install to the plugin"), both(r));
ok("lazy hook: records it in the plugin's data dir", Object.keys(json(MARK) || {}).length === 1, read(MARK));
r = M.hook(LAZY);
ok("lazy hook: a second open moves nothing (the plugin runs as usual)", r.code === 0 && !/1\.x install/.test(r.out) && Object.keys(json(MARK) || {}).length === 1, both(r));
r = M.hook(WT);
ok("lazy hook: silent in a worktree", r.code === 0 && r.out === "", both(r));
r = M.hook(CODEXONLY);
ok("lazy hook: silent in a repo without 1.x markers", r.code === 0 && r.out === "", both(r));

// ======== local scope only: the plugin is added at local scope in the other repos
const L = world("local");
const LHERE = L.repo("src/lhere"), LOTHER = L.repo("src/lother"), LSHARED = L.repo("src/lshared", "other");
L.projects(LHERE, LOTHER, LSHARED);
L.plugins([{ scope: "local", projectPath: LHERE, installPath: ROOT, version: "2.0.0" }]);
// no claude CLI: this repo is set up, the others are named with one command each and the /plugin lines
const lsnap = [LOTHER, LSHARED].map(snap);
r = L.run(LHERE, ["--plugin-setup"], {}, false);
ok("local, no claude CLI: the other repos untouched", r.code === 0 && [LOTHER, LSHARED].map(snap).join() === lsnap.join(), both(r).slice(-2000));
ok("local, no claude CLI: one command per repo and the /plugin lines", r.out.includes(`cd "${LOTHER}" && claude plugin install proteus@proteus --scope local`) && /\/plugin install proteus@proteus/.test(r.out), r.out);
ok("local: this repo's gate in settings.local.json, none in settings.json", gateIn(LHERE, "settings.local.json") && !gateIn(LHERE, "settings.json"), read(LHERE, ".claude", "settings.json"));
r = L.run(LHERE, ["--plugin-setup"]);
ok("local: the plugin added at local scope in each other repo", r.code === 0 && L.claudeLog().includes(`${LOTHER} :: plugin install proteus@proteus --scope local`) && L.claudeLog().includes(`${LSHARED} :: plugin install proteus@proteus --scope local`), L.claudeLog() + both(r).slice(-1500));
ok("local: the summary lists the repos it was added to", /Plugin added to: .*lother \(local scope\)/.test(r.out), r.out);
ok("local: no enabledPlugins in any committed settings.json", [LHERE, LOTHER, LSHARED].every((d) => !gateIn(d, "settings.json") && gateIn(d, "settings.local.json") && !old(d)), [LOTHER, LSHARED].map((d) => read(d, ".claude", "settings.json")).join(" | "));
ok("local: the 1.x user install stays (no user-scope plugin)", /stays: the plugin is not installed at user scope/.test(r.out), r.out);

// ======== project scope only: added at project scope, local in a shared repo
const P = world("project");
const PHERE = P.repo("src/phere"), POTHER = P.repo("src/pother"), PSHARED = P.repo("src/pshared", "other");
P.projects(PHERE, POTHER, PSHARED);
P.plugins([{ scope: "project", projectPath: PHERE, installPath: ROOT, version: "2.0.0" }]);
r = P.run(PHERE, ["--plugin-setup"]);
ok("project: added at project scope in an owned repo", r.code === 0 && P.claudeLog().includes(`${POTHER} :: plugin install proteus@proteus --scope project`) && gateIn(POTHER, "settings.json"), P.claudeLog() + both(r).slice(-1500));
ok("project: the summary says to commit settings.json there", r.out.includes(`${POTHER}: the plugin was added at project scope; commit .claude/settings.json there`), r.out);
ok("project: a shared repo gets local scope, and the summary says why", P.claudeLog().includes(`${PSHARED} :: plugin install proteus@proteus --scope local`) && /pshared \(local scope, not your repo\)/.test(r.out) && !gateIn(PSHARED, "settings.json"), r.out);

// ======== mixed: user scope and a repo's project scope on different pins; each repo keeps its own entry
const X = world("mixed");
const XUSER = X.repo("src/xuser"), XPROJ = X.repo("src/xproj");
X.projects(XUSER, XPROJ);
const S1 = "1".repeat(40), S2 = "2".repeat(40);
X.plugins([{ scope: "user", installPath: path.join(X.home, "cache", "a"), gitCommitSha: S1, version: "2.0.0" }, { scope: "project", projectPath: XPROJ, installPath: path.join(X.home, "cache", "b"), gitCommitSha: S2, version: "2.1.0" }]);
const PDATA = path.join(X.CL, "plugins", "data", "proteus-proteus");
fs.mkdirSync(PDATA, { recursive: true });
const now = Date.now(), res = (tag, sha) => ({ trust: 0, fetched: now, sha, result: { tag, sha } });
fs.writeFileSync(path.join(PDATA, "release-check.json"), JSON.stringify({ fetched: now, trust: 0, sha: S1, result: { tag: "v2.0.0", sha: S1 }, bySha: { [S1]: res("v2.0.0", S1), [S2]: res("v2.1.0", S2) } }));
r = X.run(XUSER, ["--plugin-setup"]);
ok("mixed: no install is added (both repos are covered)", r.code === 0 && !/plugin install/.test(X.claudeLog()) && !old(XUSER) && !old(XPROJ), X.claudeLog() + both(r).slice(-1500));
const rc = json(PDATA, "release-check.json") || {};
ok("mixed: the release check keeps one result per pin", ((rc.bySha || {})[S1] || {}).result?.tag === "v2.0.0" && ((rc.bySha || {})[S2] || {}).result?.tag === "v2.1.0", JSON.stringify(rc));
const dr1 = X.run(XUSER, ["--doctor"]).out, dr2 = X.run(XPROJ, ["--doctor"]).out;
ok("mixed: each repo's doctor reads its own pin's result", /v2\.0\.0/.test(dr1) && !/v2\.1\.0/.test(dr1) && /v2\.1\.0/.test(dr2), `${dr1.split("\n").filter((l) => /release/.test(l)).join(" | ")} || ${dr2.split("\n").filter((l) => /release/.test(l)).join(" | ")}`);

// ======== a CLAUDE_CONFIG_DIR profile: its own project list; the default profile is named, not touched
const C = world("profile");
const PROF = C.repo("src/prof"), NOPE = C.repo("src/nope");
C.projects(NOPE);
const CD = path.join(C.home, ".claude-work");
fs.mkdirSync(path.join(CD, "plugins"), { recursive: true });
fs.writeFileSync(path.join(CD, ".claude.json"), JSON.stringify({ projects: { [PROF]: {} } }));
fs.writeFileSync(path.join(CD, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "proteus@proteus": [{ scope: "user", installPath: ROOT }] } }));
const nopeSnap = snap(NOPE);
r = C.run(C.home, ["--migrate"], { CLAUDE_CONFIG_DIR: CD });
ok("profile: the repo in its project list moved", r.code === 0 && !old(PROF) && r.out.includes(`moved    ${PROF}`), both(r).slice(-2000));
ok("profile: a repo only the default profile lists is untouched", snap(NOPE) === nopeSnap && !r.out.includes(NOPE), r.out);
ok("profile: the default profile is named as one this run did not read", r.out.includes(`Another Claude Code profile, ${path.join(C.home, ".claude")}, has its own repos`), r.out);

// ======== a fresh 2.x user: nothing to do, nothing printed
const F = path.join(W, "fresh");
fs.mkdirSync(path.join(F, ".claude"), { recursive: true });
const FR = path.join(F, "src", "app");
fs.mkdirSync(path.dirname(FR), { recursive: true });
g(F, "init", "-q", "-b", "main", FR);
fs.writeFileSync(path.join(F, ".claude.json"), JSON.stringify({ projects: { [FR]: {} } }));
r = lib.run(INSTALL, "", { cwd: F, args: ["--migrate"], env: { ...lib.homeEnv(F), PATH: [CBIN, lib.BIN, path.dirname(process.execPath), ...lib.SYS_PATH].join(path.delimiter) } });
ok("fresh 2.x user: --migrate prints nothing", r.code === 0 && r.out === "", both(r));

// ======== from 1.x: --update pulls the signed release, pins the plugin to it, then moves every repo
const signer = lib.sshSigner(path.join(W, "keys"));
if (!signer) console.log("skip: --update pin (ssh-keygen cannot sign here)");
else {
  // the 1.x checkout: this checkout's files at a signed v9.9.8, a signed v9.9.9 one commit on in its remote
  const PH = path.join(W, "upd-proteus"), BARE = path.join(W, "upd-proteus.git");
  g(W, "init", "-q", "--bare", "-b", "main", BARE);
  g(W, "init", "-q", "-b", "main", PH);
  for (const f of g(ROOT, "ls-files", "-co", "--exclude-standard").split("\n").filter(Boolean)) {
    const src = path.join(ROOT, f);
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) continue;
    fs.mkdirSync(path.dirname(path.join(PH, f)), { recursive: true });
    fs.copyFileSync(src, path.join(PH, f));
  }
  g(PH, "add", "-A"); g(PH, "commit", "-qm", "chore: snapshot");
  g(PH, "config", "gpg.ssh.allowedSignersFile", signer.allowed);
  signer.tag(PH, "v9.9.8");
  g(PH, "remote", "add", "origin", BARE);
  fs.appendFileSync(path.join(PH, "README.md"), "\nnext\n");
  g(PH, "commit", "-qam", "feat: next"); signer.tag(PH, "v9.9.9");
  g(PH, "push", "-q", "-u", "origin", "main", "--tags");
  g(PH, "reset", "-q", "--hard", "v9.9.8"); g(PH, "tag", "-d", "v9.9.9");
  const U = world("update", path.join(PH, "install.js"));
  const UREPO = U.repo("src/urepo");
  U.projects(UREPO);
  // no claude CLI: the checkout moves, the /plugin lines are printed, no repo is touched
  const usnap = snap(UREPO);
  r = U.run(U.home, ["--update"], {}, false);
  ok("--update, no claude CLI: the checkout moves to the signed release", r.code === 0 && g(PH, "describe", "--tags") === "v9.9.9", both(r).slice(-2000));
  ok("--update, no claude CLI: the /plugin lines, pinned to the tag; no repo touched", /\/plugin marketplace add \S+#v9\.9\.9/.test(r.out) && /\/plugin install proteus@proteus/.test(r.out) && snap(UREPO) === usnap, r.out);
  // gh logged out: no pin, no move
  r = U.run(U.home, ["--update"], { FAKE_GH: "fail" });
  ok("--update, gh logged out: no pin and no repo touched", !/plugin install/.test(U.claudeLog()) && /plugin   -> not installed yet: gh is not logged in/.test(r.out) && snap(UREPO) === usnap, U.claudeLog() + r.out);
  // with the claude CLI: pinned at user scope to the release, then every repo moved
  r = U.run(U.home, ["--update"]);
  const cl = U.claudeLog();
  ok("--update: the plugin pinned to the release tag at user scope", r.code === 0 && /:: plugin marketplace add \S+#v9\.9\.9$/m.test(cl) && /:: plugin install proteus@proteus --scope user$/m.test(cl) && r.out.includes("pinned to v9.9.9 at user scope"), cl + both(r).slice(-2000));
  ok("--update: then every repo moved and the 1.x user install removed", !old(UREPO) && r.out.includes(`moved    ${UREPO}`) && /Removed the 1\.x user install/.test(r.out), r.out);
}

lib.summary();

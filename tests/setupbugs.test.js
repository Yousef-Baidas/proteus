// Setup from the plugin (#154): node tests/setupbugs.test.js (needs git). The plugin's copy has no git history, so
// scripts/known-blobs.json tells a 1.x copy of any past shipped version from an edit; one --plugin-setup run removes
// every 1.x leftover (the copies, then the package.json and exclude lines they freed) and --doctor finds none; a
// tracked copy someone edited is named with its author and never marked for deletion; the gate counts
// settings.local.json the way proteus-plugin.js does; setup runs the release check once, a failed fetch not fatal.
// Runs a git-less copy of this checkout as the plugin and a fake HOME; never the network or the real ~/.claude.
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("setupbugs");
const CLAUDE = path.join(lib.HOME, ".claude");
const read = (...p) => { try { return fs.readFileSync(path.join(...p), "utf8"); } catch { return null; } };
const exists = (...p) => fs.existsSync(path.join(...p));
const both = (r) => `${r.out}${r.err}`;
const rows = (out, re) => out.split("\n").filter((l) => re.test(l)).join(" | ");

// the plugin as the plugin manager installs it: this checkout's files (uncommitted ones too), no .git
const PLUG = path.join(W, "plugin");
for (const f of execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean)) {
  const s = path.join(ROOT, f);
  if (!fs.existsSync(s) || !fs.statSync(s).isFile()) continue;
  fs.mkdirSync(path.dirname(path.join(PLUG, f)), { recursive: true });
  fs.copyFileSync(s, path.join(PLUG, f));
}
const env = { FAKE_GH_LOG: path.join(W, "gh.log"), GIT_CEILING_DIRECTORIES: W };
const plug = (cwd, ...args) => lib.run(path.join(PLUG, "install.js"), "", { cwd, args, env });
const onex = (cwd, ...args) => lib.run(path.join(ROOT, "install.js"), "", { cwd, args, env });
function repo(name) {
  const d = path.join(W, name);
  g(W, "init", "-q", "-b", "main", d);
  fs.writeFileSync(path.join(d, "README.md"), "# r\n");
  g(d, "add", "README.md");
  g(d, "commit", "-q", "-m", "init");
  return d;
}
ok("plugin copy: no git history", !exists(PLUG, ".git") && spawnSync("git", ["rev-parse", "--git-dir"], { cwd: PLUG, env: { ...process.env, GIT_CEILING_DIRECTORIES: W } }).status !== 0);

// a version of proteus-harness.js no release tagged (6eb5001, from between two releases), else any listed one this
// clone has
const known = JSON.parse(read(PLUG, "scripts", "known-blobs.json"));
const ids = ["6eb5001185037c8a1582c489b8df9fb46e93b973", ...(known.blobs["templates/hooks/proteus-harness.js"] || [])];
let OLD = null;
for (const id of ids) {
  const r = spawnSync("git", ["cat-file", "blob", id], { cwd: ROOT, encoding: "utf8" });
  if (r.status === 0) { OLD = r.stdout; break; }
}
ok("known blobs: 6eb5001 (an untagged proteus-harness.js) is listed", known.blobs["templates/hooks/proteus-harness.js"].includes(ids[0]));

// ---- a 1.x project install whose harness copy is that untagged version: one --plugin-setup leaves nothing
let r = onex(W);
const R = repo("onex");
r = onex(R, "--project");
const H = path.join(R, ".claude", "hooks");
ok("1.x: the project install left hook copies, package.json and exclude lines (the fixture holds)",
  r.code === 0 && exists(H, "proteus-harness.js") && exists(H, "package.json") && /\.claude\/hooks/.test(read(R, ".git", "info", "exclude") || ""), both(r).slice(-1500));
if (OLD === null) console.log("SKIP untagged copy: no past proteus-harness.js blob in this clone (shallow?)");
else fs.writeFileSync(path.join(H, "proteus-harness.js"), OLD);
r = plug(R, "--plugin-setup");
ok("one run: exits 0", r.code === 0, both(r).slice(-1500));
ok("one run: the untagged copy, the other hooks and package.json are gone", !exists(H) || !fs.readdirSync(H).length, exists(H) ? fs.readdirSync(H).join(",") : "");
ok("one run: no 1.x exclude line left", !/\.claude\/hooks/.test(read(R, ".git", "info", "exclude") || ""), read(R, ".git", "info", "exclude"));
ok("one run: no 1.x hook entry left", !/\.claude\/hooks\/proteus-/.test(`${read(R, ".claude", "settings.local.json")}${read(R, ".claude", "settings.json")}`), read(R, ".claude", "settings.local.json"));
r = plug(R, "--doctor");
ok("doctor after one run: no 1.x copies", /ok\s+no 1\.x copies beside the plugin/.test(r.out), rows(r.out, /1\.x/));
r = plug(R, "--plugin-setup");
ok("a second run removes nothing", r.code === 0 && !/^removed/m.test(r.out) && !/\.claude\/hooks/.test(r.out), r.out.slice(0, 1500));

// ---- a tracked copy: unedited, the advice is to delete it in a commit; edited, it is named with its author and left
const T = repo("tracked");
r = onex(T, "--project");
const TH = path.join(T, ".claude", "hooks");
fs.appendFileSync(path.join(TH, "proteus-lead-guard.js"), "\n// ours\n");
g(T, "add", "-f", ".claude/hooks/proteus-lead-guard.js", ".claude/hooks/proteus-statusline.js");
spawnSync("git", ["commit", "-q", "-m", "hooks"], { cwd: T, env: { ...process.env, ...lib.ENV, GIT_AUTHOR_NAME: "Dana Editor", GIT_AUTHOR_EMAIL: "d@e" } });
ok("tracked: the fixture commits as Dana Editor", g(T, "log", "-1", "--format=%an") === "Dana Editor");
r = plug(T, "--plugin-setup");
ok("tracked: the edited copy is named with its last author, left alone", r.out.includes(".claude/hooks/proteus-lead-guard.js (edited by Dana Editor; left alone)") && exists(TH, "proteus-lead-guard.js"), r.out.slice(0, 2000));
ok("tracked: the unedited copy is still marked for a commit", r.out.includes(".claude/hooks/proteus-statusline.js (tracked by git; delete it in a commit)"), r.out.slice(0, 2000));
r = plug(T, "--doctor");
const warn = rows(r.out, /1\.x copies left alone/) + rows(r.out, /^\s+(fix|->)/i);
ok("tracked: doctor advises deleting only the unedited one", /proteus-statusline\.js: move their edits out, then delete them/.test(r.out) && !/proteus-lead-guard\.js[^;\n]*: move their edits out/.test(r.out), warn || r.out.slice(0, 2500));
g(T, "rm", "-q", ".claude/hooks/proteus-statusline.js"); g(T, "commit", "-qm", "rm");
plug(T, "--plugin-setup");
r = plug(T, "--doctor");
const kept = r.out.split("\n").findIndex((l) => /1\.x copies left alone/.test(l)), advice = r.out.split("\n").slice(kept, kept + 2).join("\n");
ok("tracked: with only the edited copy left, nothing to delete", /1\.x copies left alone: \.claude\/hooks\/proteus-lead-guard\.js \(edited by Dana Editor; left alone\)/.test(advice) && !/delete/.test(advice), advice);

// ---- the gate: --doctor reads settings.local.json as the plugin's hooks do, local winning
const G = repo("gate");
fs.mkdirSync(path.join(G, ".claude"));
const settings = (file, v) => fs.writeFileSync(path.join(G, ".claude", file), JSON.stringify({ enabledPlugins: { "proteus@proteus": v } }));
settings("settings.local.json", true);
r = plug(G, "--doctor");
ok("gate: settings.local.json alone enables it, doctor names the file", /ok\s+plugin gate: \.claude\/settings\.local\.json enables proteus@proteus/.test(r.out), rows(r.out, /gate/));
settings("settings.json", true); settings("settings.local.json", false);
r = plug(G, "--doctor");
ok("gate: settings.local.json false wins over settings.json true", /FIX\s+plugin gate: \.claude\/settings\.local\.json sets proteus@proteus to false/.test(r.out), rows(r.out, /gate/) || r.out.slice(0, 2500));
r = plug(G, "--plugin-setup");
ok("gate: setup warns that the local false keeps the plugin off", /settings\.local\.json sets proteus@proteus to false, which wins/.test(both(r)), both(r).slice(-1500));
const { gateFrom } = require(path.join(PLUG, "templates", "hooks", "proteus-plugin.js"));
ok("gate: one rule, the hook's own", gateFrom(G).on === false && gateFrom(G).file === "settings.local.json");

// ---- the release check runs once from setup; a marketplace it cannot fetch is one line, not an error
const plugins = path.join(CLAUDE, "plugins");
fs.mkdirSync(plugins, { recursive: true });
fs.writeFileSync(path.join(plugins, "known_marketplaces.json"), JSON.stringify({ proteus: { source: { source: "git", url: path.join(W, "no-such-remote.git") } } }));
fs.writeFileSync(path.join(plugins, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "proteus@proteus": [{ scope: "user", installPath: PLUG, gitCommitSha: "b".repeat(40) }] } }));
const D = repo("release");
r = plug(D, "--plugin-setup");
const state = read(plugins, "data", "proteus-proteus", "release-check.json");
ok("release: setup exits 0 though the fetch fails", r.code === 0, both(r).slice(-1500));
ok("release: it ran the check once, its cache is where --doctor reads", !!state && JSON.parse(state).sha === "b".repeat(40), state);
ok("release: one release line names the failure", /^release  -> .*release check/m.test(r.out), rows(r.out, /^release/));
r = plug(D, "--plugin-setup", "--dry-run");
ok("release: a dry run does not run it", !/^release  ->/m.test(r.out), rows(r.out, /^release/));

lib.summary();

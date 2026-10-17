// /proteus:setup (#136, D5): install.js --plugin-setup does --project's project steps only. The gate and the
// marketplace in the committed .claude/settings.json (other keys kept), attribution, the statusLine in
// settings.local.json, teams/; no hooks or agents in the repo, the GitHub steps printed and never run. Idempotent;
// a malformed settings file is refused before anything is written; --dry-run writes nothing.
// node tests/pluginsetup.test.js (needs git). Fake HOME and gh; never the network or the real ~/.claude.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("pluginsetup");
const INSTALL = path.join(ROOT, "install.js");
const read = (...p) => { try { return fs.readFileSync(path.join(...p), "utf8"); } catch { return null; } };
const json = (...p) => { try { return JSON.parse(read(...p)); } catch { return null; } };
const exists = (...p) => fs.existsSync(path.join(...p));
const both = (r) => `${r.out}${r.err}`;
const GH_LOG = path.join(W, "gh.log");
const setup = (cwd, args = []) => lib.run(INSTALL, "", { cwd, args: ["--plugin-setup", ...args], env: { FAKE_GH_LOG: GH_LOG } });
function repo(name) {
  const d = path.join(W, name);
  g(W, "init", "-q", "-b", "main", d);
  fs.writeFileSync(path.join(d, "README.md"), "# r\n");
  g(d, "add", "README.md");
  g(d, "commit", "-q", "-m", "init");
  return d;
}
// every file under dir (.git aside) with its bytes: a run that writes nothing leaves it equal
const snap = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.name === ".git") continue;
      if (e.isDirectory()) walk(p); else if (e.isFile()) out.push(`${path.relative(dir, p)} ${fs.readFileSync(p, "base64")}`);
    }
  };
  walk(dir);
  return out.sort().join("\n");
};
const USER = path.join(lib.HOME, ".claude", "settings.json");
const MARKET = { source: { source: "github", repo: "Yousef-Baidas/proteus" } };

// ---- fresh repo
const R = repo("fresh");
let r = setup(R);
const s = json(R, ".claude", "settings.json") || {};
ok("fresh: exits 0", r.code === 0, both(r).slice(-1500));
ok("fresh: .claude/settings.json enables proteus@proteus (the plugin's gate)", s.enabledPlugins && s.enabledPlugins["proteus@proteus"] === true, JSON.stringify(s));
ok("fresh: .claude/settings.json lists the proteus marketplace on GitHub", JSON.stringify((s.extraKnownMarketplaces || {}).proteus) === JSON.stringify(MARKET), JSON.stringify(s));
ok("fresh: attribution off in the user settings, as --project sets it", JSON.stringify((json(USER) || {}).attribution) === JSON.stringify({ commit: "", pr: "", sessionUrl: false }), read(USER));
const sl = (json(R, ".claude", "settings.local.json") || {}).statusLine || {};
ok("fresh: the statusLine in settings.local.json runs the repo's teams/ copy of proteus-statusline.js",
  sl.type === "command" && sl.command === `node "${path.join(R, "teams", "templates", "hooks", "proteus-statusline.js").split(path.sep).join("/")}"`, JSON.stringify(sl));
ok("fresh: teams/ with ROUTING.md, the worktree template, the commit-msg hook and the gates wiring",
  ["ROUTING.md", "link-skills.js", "templates/hooks/worktree-settings.local.json", "templates/hooks/commit-msg.js", "templates/hooks/proteus-statusline.js", "templates/lefthook.yml", "templates/ci"].every((f) => exists(R, "teams", ...f.split("/"))));
ok("fresh: no hooks or agents in the repo", !exists(R, ".claude", "hooks") && !exists(R, ".claude", "agents") && !(json(R, ".claude", "settings.local.json") || {}).hooks);
ok("fresh: settings.local.json is git-excluded", (read(R, ".git", "info", "exclude") || "").split("\n").includes(".claude/settings.local.json"));
ok("fresh: prints --protect and --verifier-app as next steps", /--protect\b/.test(r.out) && /--verifier-app <appId> <keyPath>/.test(r.out), r.out.slice(-800));
ok("fresh: never runs gh (the GitHub steps are the human's)", !exists(GH_LOG), read(GH_LOG));
ok("fresh: names the plugin's command", /\/proteus:proteus/.test(r.out), r.out.slice(-300));

// ---- re-run: nothing changes
g(R, "add", "-A");
g(R, "add", "-f", ".claude/settings.json");
g(R, "commit", "-q", "-m", "setup");
const before = snap(R), userBefore = read(USER);
r = setup(R);
ok("re-run: exits 0", r.code === 0, both(r).slice(-1500));
ok("re-run: no file in the repo changes", snap(R) === before);
ok("re-run: git status stays clean", g(R, "status", "--porcelain") === "", g(R, "status", "--porcelain"));
ok("re-run: the user settings stay as they were", read(USER) === userBefore);
ok("re-run: says the gate is already set", /proteus@proteus enabled, proteus marketplace listed/.test(r.out), r.out.slice(0, 400));

// ---- existing settings.json: other keys kept, a fork's marketplace entry kept, a statusLine of the repo's own kept
const E = repo("existing");
fs.mkdirSync(path.join(E, ".claude"));
const mine = { permissions: { allow: ["Bash(ls)"] }, enabledPlugins: { "other@x": true, "proteus@proteus": false }, extraKnownMarketplaces: { x: { source: { source: "github", repo: "x/y" } } }, env: { A: "1" } };
fs.writeFileSync(path.join(E, ".claude", "settings.json"), JSON.stringify(mine));
fs.writeFileSync(path.join(E, ".claude", "settings.local.json"), JSON.stringify({ statusLine: { type: "command", command: "echo mine" }, model: "m" }));
r = setup(E);
const es = json(E, ".claude", "settings.json") || {};
ok("existing: exits 0", r.code === 0, both(r).slice(-1500));
ok("existing: other keys kept", JSON.stringify(es.permissions) === JSON.stringify(mine.permissions) && JSON.stringify(es.env) === JSON.stringify(mine.env), JSON.stringify(es));
ok("existing: other plugins and marketplaces kept, proteus@proteus turned on", es.enabledPlugins["other@x"] === true && es.enabledPlugins["proteus@proteus"] === true
  && JSON.stringify(es.extraKnownMarketplaces.x) === JSON.stringify(mine.extraKnownMarketplaces.x) && !!es.extraKnownMarketplaces.proteus, JSON.stringify(es));
ok("existing: the repo's own statusLine and local keys kept", JSON.stringify(json(E, ".claude", "settings.local.json")) === JSON.stringify({ statusLine: { type: "command", command: "echo mine" }, model: "m" }), read(E, ".claude", "settings.local.json"));
const F = repo("fork");
fs.mkdirSync(path.join(F, ".claude"));
const fork = { extraKnownMarketplaces: { proteus: { source: { source: "github", repo: "me/proteus" } } } };
fs.writeFileSync(path.join(F, ".claude", "settings.json"), JSON.stringify(fork));
r = setup(F);
ok("existing: a proteus marketplace entry already there (a fork) is kept", r.code === 0 && JSON.stringify((json(F, ".claude", "settings.json") || {}).extraKnownMarketplaces) === JSON.stringify(fork.extraKnownMarketplaces), both(r).slice(-600));

// ---- malformed settings: refused, with the file named, before anything is written
for (const [name, file, text, want] of [
  ["broken settings.json", "settings.json", "{ \"enabledPlugins\": ", /settings\.json is not a JSON object; nothing changed/],
  ["a settings.json array", "settings.json", "[1]", /settings\.json is not a JSON object; nothing changed/],
  ["a broken settings.local.json", "settings.local.json", "{,}", /settings\.local\.json is not a JSON object; nothing changed/],
  ["enabledPlugins not an object", "settings.json", "{\"enabledPlugins\": [\"proteus@proteus\"]}", /"enabledPlugins" in .*settings\.json is not a JSON object/],
]) {
  const M = repo(`bad-${file}-${name.replace(/\W+/g, "-")}`);
  fs.mkdirSync(path.join(M, ".claude"));
  fs.writeFileSync(path.join(M, ".claude", file), text);
  const was = snap(M), userWas = read(USER);
  r = setup(M);
  ok(`malformed (${name}): exits non-zero with a clear message naming the file`, r.code !== 0 && want.test(r.err) && r.err.includes(path.join(M, ".claude", file)), both(r).slice(-600));
  ok(`malformed (${name}): nothing written`, snap(M) === was && read(USER) === userWas && !exists(M, "teams"));
}

// ---- dry run: says what it would do, writes nothing anywhere
const D = repo("dry");
fs.rmSync(USER, { force: true });
const dwas = snap(D), excl = read(D, ".git", "info", "exclude");
r = setup(D, ["--dry-run"]);
ok("dry-run: exits 0", r.code === 0, both(r).slice(-1500));
ok("dry-run: writes nothing in the repo, its git dir or the user settings", snap(D) === dwas && read(D, ".git", "info", "exclude") === excl && !exists(USER));
ok("dry-run: says what it would change, in --project's tag -> line style", /^settings -> \.claude\/settings\.json \(would enable proteus@proteus, would add the proteus marketplace/m.test(r.out)
  && /^settings -> would disable attribution/m.test(r.out) && /^status   -> .*would add the statusLine/m.test(r.out) && /^teams    -> .*would copy/m.test(r.out) && /Dry run: nothing written\./.test(r.out), r.out);
r = setup(R, ["--dry-run"]);
ok("dry-run: on a set-up repo it would change nothing in the settings", r.code === 0 && /proteus@proteus enabled, proteus marketplace listed/.test(r.out) && /statusLine already set/.test(r.out), r.out.slice(0, 600));

// ---- flags
r = lib.run(INSTALL, "", { cwd: D, args: ["--dry-run"] });
ok("flags: --dry-run alone is refused", r.code === 2 && /--dry-run needs --plugin-setup/.test(r.err), both(r));
r = setup(D, ["--project"]);
ok("flags: --plugin-setup with --project is refused", r.code === 2 && /--plugin-setup takes only --dry-run/.test(r.err), both(r));
r = setup(D, ["--harness", "codex"]);
ok("flags: --plugin-setup for Codex is refused", r.code === 2 && /Codex uses --project/.test(r.err), both(r));
const N = path.join(W, "norepo");
fs.mkdirSync(N);
r = setup(N);
ok("not a git repo: refused, nothing written", r.code !== 0 && /run it inside one/.test(r.err) && fs.readdirSync(N).length === 0, both(r));

// ---- the skill: /proteus:setup, user-invoked only, one command from the plugin root
const skill = read(ROOT, "skills", "proteus-setup", "SKILL.md") || "";
const fm = (/^---\n([\s\S]*?)\n---/.exec(skill) || [])[1] || "";
ok("skill: named setup, so the plugin namespaces it /proteus:setup", /^name: setup$/m.test(fm), fm);
ok("skill: disable-model-invocation: true", /^disable-model-invocation: true$/m.test(fm), fm);
ok("skill: runs install.js --plugin-setup from ${CLAUDE_PLUGIN_ROOT}", skill.includes('node "${CLAUDE_PLUGIN_ROOT}/install.js" --plugin-setup'), skill);

lib.summary();

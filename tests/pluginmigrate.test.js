// Moving from 1.x (#136, D8): --plugin-setup in a repo with a 1.x project install removes the unedited copies only
// (the .claude/hooks scripts, their settings entries, the .claude/agents copies, the exclude lines), keeps and names
// an edited one, keeps every other settings key, and writes nothing on a re-run or under --dry-run. The user-level
// 1.x install is listed, never touched; --remove-user-install removes its unedited pieces. --doctor reads a plugin
// repo, a 1.x repo and a mixed one. Under the plugin the autostart syncs no copies from the 1.x checkout.
// node tests/pluginmigrate.test.js (needs git). Fake HOME and gh; never the network or the real ~/.claude.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("pluginmigrate");
const INSTALL = path.join(ROOT, "install.js");
const read = (...p) => { try { return fs.readFileSync(path.join(...p), "utf8"); } catch { return null; } };
const json = (...p) => { try { return JSON.parse(read(...p)); } catch { return null; } };
const exists = (...p) => fs.existsSync(path.join(...p));
const both = (r) => `${r.out}${r.err}`;
const env = { FAKE_GH_LOG: path.join(W, "gh.log") };
const inst = (cwd, ...args) => lib.run(INSTALL, "", { cwd, args, env });
const CLAUDE = path.join(lib.HOME, ".claude");
function repo(name) {
  const d = path.join(W, name);
  g(W, "init", "-q", "-b", "main", d);
  fs.writeFileSync(path.join(d, "README.md"), "# r\n");
  g(d, "add", "README.md");
  g(d, "commit", "-q", "-m", "init");
  return d;
}
// every file under dir (.git aside, but its info/exclude) with its bytes: a run that writes nothing leaves it equal
const snap = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.name === ".git") { out.push(`exclude ${read(p, "info", "exclude")}`); continue; }
      if (e.isDirectory()) walk(p); else if (e.isFile() || e.isSymbolicLink()) out.push(`${path.relative(dir, p)} ${e.isFile() ? fs.readFileSync(p, "base64") : "link"}`);
    }
  };
  walk(dir);
  return out.sort().join("\n");
};
const hooksIn = (s) => JSON.stringify((s || {}).hooks || {});
const rows = (out, re) => out.split("\n").filter((l) => re.test(l)).join(" | ");

// ---- a 1.x user install, then a 1.x project install with one hook and one agent edited, a foreign hook entry
// and other keys in both settings files
let r = inst(W);
ok("1.x: the user install succeeds", r.code === 0, both(r).slice(-1500));
r = inst(W, "--auto-update");
const R = repo("onex");
r = inst(R, "--project");
ok("1.x: the project install succeeds", r.code === 0, both(r).slice(-1500));
const H = path.join(R, ".claude", "hooks"), A = path.join(R, ".claude", "agents");
const hookFiles = fs.readdirSync(H);
ok("1.x: the project install left hook copies, agent copies and hook entries (the fixture holds)",
  hookFiles.includes("proteus-lead-guard.js") && hookFiles.includes("proteus-statusline.js") && /\.claude\/hooks\/proteus-/.test(hooksIn(json(R, ".claude", "settings.local.json"))),
  `${hookFiles.join(",")} ${read(R, ".claude", "settings.local.json")}`);
// agent copies in the repo: an older 1.x placed them here
fs.mkdirSync(A, { recursive: true });
const agentFiles = fs.readdirSync(path.join(ROOT, "agents")).filter((f) => /^proteus-.*\.md$/.test(f)).slice(0, 2);
for (const f of agentFiles) fs.copyFileSync(path.join(ROOT, "agents", f), path.join(A, f));
const EDITED_HOOK = "proteus-lead-guard.js", EDITED_AGENT = agentFiles[0];
fs.appendFileSync(path.join(H, EDITED_HOOK), "\n// mine\n");
fs.appendFileSync(path.join(A, EDITED_AGENT), "\nmine\n");
const local = json(R, ".claude", "settings.local.json");
local.permissions = { allow: ["Bash(ls)"] };
local.hooks.PreToolUse = [...(local.hooks.PreToolUse || []), { matcher: "Bash", hooks: [{ type: "command", command: "node mine.js" }] }];
fs.writeFileSync(path.join(R, ".claude", "settings.local.json"), JSON.stringify(local, null, 2));
const shared = { env: { A: "1" }, hooks: { Stop: [{ hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/proteus-autostart.js"' }, { type: "command", command: "node other.js" }] }] } };
fs.mkdirSync(path.join(R, ".claude"), { recursive: true });
fs.writeFileSync(path.join(R, ".claude", "settings.json"), JSON.stringify(shared, null, 2));

// ---- --doctor on the 1.x repo: no plugin rows, the 1.x rows as before
r = inst(R, "--doctor");
ok("doctor (1.x repo): no plugin rows", !/plugin gate|release check|1\.x copies beside/.test(r.out), rows(r.out, /plugin|1\.x/));
ok("doctor (1.x repo): still checks the lead hooks", /lead hooks|hooks registered|settings\.local\.json/i.test(r.out), r.out.slice(0, 1500));

// ---- --dry-run: nothing written, every removal named
const before = snap(R), userBefore = snap(CLAUDE);
r = inst(R, "--plugin-setup", "--dry-run");
ok("dry-run: exits 0", r.code === 0, both(r).slice(-1500));
ok("dry-run: no file in the repo changes", snap(R) === before);
ok("dry-run: the config dir is untouched", snap(CLAUDE) === userBefore);
ok("dry-run: says what it would remove", /would remove \.claude\/hooks\/proteus-statusline\.js/.test(r.out) && /would remove \.claude\/agents\/proteus-/.test(r.out), rows(r.out, /would remove|kept/));

// ---- the setup: unedited copies out, edited ones kept and named, settings entries out, other keys kept
r = inst(R, "--plugin-setup");
ok("setup: exits 0", r.code === 0, both(r).slice(-2000));
const leftHooks = fs.readdirSync(H).filter((f) => f.endsWith(".js"));
ok("setup: the unedited hook copies are removed, the edited one stays", leftHooks.join() === EDITED_HOOK, leftHooks.join());
ok("setup: package.json stays while the edited script needs it", exists(H, "package.json"));
ok("setup: worktree-settings.local.json, unedited, is removed", !exists(H, "worktree-settings.local.json"));
const leftAgents = fs.readdirSync(A);
ok("setup: the unedited agent copies are removed, the edited one stays", leftAgents.join() === EDITED_AGENT, leftAgents.join());
ok("setup: names the kept hook and agent as edited", new RegExp(`kept +\\.claude/hooks/${EDITED_HOOK.replace(".", "\\.")} \\(edited`).test(r.out) && new RegExp(`kept +\\.claude/agents/${EDITED_AGENT.replace(".", "\\.")} \\(edited`).test(r.out), rows(r.out, /kept/));
const l2 = json(R, ".claude", "settings.local.json"), s2 = json(R, ".claude", "settings.json");
ok("setup: settings.local.json keeps only the edited hook's entries and the foreign one",
  !/proteus-(?!lead-guard)[\w-]+\.js/.test(hooksIn(l2)) && /proteus-lead-guard\.js/.test(hooksIn(l2)) && /node mine\.js/.test(hooksIn(l2)), hooksIn(l2));
ok("setup: settings.local.json keeps its other keys; the 1.x statusLine is replaced by the plugin's",
  JSON.stringify(l2.permissions) === JSON.stringify({ allow: ["Bash(ls)"] }) && /teams\/templates\/hooks\/proteus-statusline\.js/.test((l2.statusLine || {}).command || ""), JSON.stringify(l2));
ok("setup: settings.json loses the 1.x entry, keeps the foreign one and env, gains the gate",
  !/proteus-autostart/.test(hooksIn(s2)) && /node other\.js/.test(hooksIn(s2)) && s2.env.A === "1" && s2.enabledPlugins["proteus@proteus"] === true, JSON.stringify(s2));
const ex = (read(R, ".git", "info", "exclude") || "").split("\n");
ok("setup: the exclude lines of the remaining files stay, the rest go",
  ex.includes(".claude/hooks/proteus-*.js") && ex.includes(".claude/hooks/package.json") && !ex.includes(".claude/hooks/worktree-settings.local.json") && ex.includes(".claude/settings.local.json"), ex.join(","));
ok("setup: leaves the user install, lists it and prints the removal command",
  fs.lstatSync(path.join(CLAUDE, "skills", "proteus")).isSymbolicLink() && /1\.x user install/.test(r.out) && /--remove-user-install/.test(r.out), rows(r.out, /user install|remove-user/));

// ---- idempotent: a second run writes nothing
const after = snap(R);
r = inst(R, "--plugin-setup");
ok("re-run: exits 0", r.code === 0, both(r).slice(-1500));
ok("re-run: no file in the repo changes", snap(R) === after);
ok("re-run: removes nothing", !/^removed/m.test(r.out), rows(r.out, /removed/));

// ---- --doctor on the mixed repo: the gate set, an edited copy left
r = inst(R, "--doctor");
ok("doctor (mixed repo): the gate row is ok", /ok.*plugin gate/.test(r.out), rows(r.out, /plugin gate/));
ok("doctor (mixed repo): warns about the kept copies", /WARN.*1\.x copies left alone.*proteus-lead-guard\.js/.test(r.out), rows(r.out, /1\.x/));
ok("doctor (mixed repo): warns about the user install", /WARN.*1\.x user install beside the plugin/.test(r.out), rows(r.out, /user install/));
ok("doctor (mixed repo): no lead-hooks or skill-link rows", !/install-lead-hooks|skill links/.test(r.out), r.out.slice(0, 1500));
ok("doctor (mixed repo): release check without an installed plugin warns", /WARN.*release check: proteus@proteus is not installed/.test(r.out), rows(r.out, /release check/));

// ---- a leftover copy reappears: doctor FIXes it, --fix removes it
fs.copyFileSync(path.join(ROOT, "templates", "hooks", "proteus-statusline.js"), path.join(H, "proteus-statusline.js"));
r = inst(R, "--doctor");
ok("doctor (mixed repo): an unedited leftover is a FIX row", /FIX.*1\.x copies beside the plugin.*proteus-statusline\.js/.test(r.out), rows(r.out, /1\.x/));
r = inst(R, "--doctor", "--fix");
ok("doctor --fix: removes the leftover", !exists(H, "proteus-statusline.js"), rows(r.out, /1\.x|fix/i));

// ---- --doctor on a plugin repo: gate, marketplace, clean, the release check's verified result
const P = repo("plugin");
r = inst(P, "--plugin-setup");
const sha = "a".repeat(40);
fs.mkdirSync(path.join(CLAUDE, "plugins", "data", "proteus-proteus"), { recursive: true });
fs.writeFileSync(path.join(CLAUDE, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "proteus@proteus": [{ scope: "user", installPath: ROOT, gitCommitSha: sha }] } }));
const cache = (result) => fs.writeFileSync(path.join(CLAUDE, "plugins", "data", "proteus-proteus", "release-check.json"), JSON.stringify({ fetched: Date.now(), sha, trust: "x", result }));
cache({ tag: "v2.0.0" });
r = inst(P, "--doctor");
ok("doctor (plugin repo): gate and marketplace ok", /ok.*plugin gate/.test(r.out) && /ok.*plugin marketplace/.test(r.out), rows(r.out, /plugin/));
ok("doctor (plugin repo): no 1.x copies", /ok.*no 1\.x copies beside the plugin/.test(r.out), rows(r.out, /1\.x/));
ok("doctor (plugin repo): the release check's verified result", /ok.*release check: a{12} is the verified release v2\.0\.0/.test(r.out), rows(r.out, /release check/));
cache({ tag: "", newest: "v2.0.1", error: "not a tag" });
r = inst(P, "--doctor");
ok("doctor (plugin repo): an unverified commit warns and names the newest release", /WARN.*not a verified release/.test(r.out) && /v2\.0\.1/.test(r.out), rows(r.out, /release check/));

// ---- --remove-user-install: dry-run first, then for real; an edited agent stays
const ua = fs.readdirSync(path.join(CLAUDE, "agents")).filter((f) => /^proteus-.*\.md$/.test(f));
fs.appendFileSync(path.join(CLAUDE, "agents", ua[0]), "\nmine\n");
const cfgBefore = snap(CLAUDE);
r = inst(W, "--remove-user-install", "--dry-run");
ok("remove-user-install --dry-run: exits 0 and writes nothing", r.code === 0 && snap(CLAUDE) === cfgBefore, both(r).slice(-1000));
ok("remove-user-install --dry-run: names the links, the agents and autoUpdate", /would remove .*skills[\\/]proteus /.test(r.out) && /would remove .*agents[\\/]proteus-/.test(r.out) && /autoUpdate/.test(r.out), r.out.slice(0, 1500));
fs.rmSync(path.join(CLAUDE, "plugins", "installed_plugins.json"));
const noPlugin = snap(CLAUDE);
r = inst(W, "--remove-user-install");
ok("remove-user-install: refused while the plugin is not installed", r.code !== 0 && snap(CLAUDE) === noPlugin, both(r).slice(-500));
fs.writeFileSync(path.join(CLAUDE, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "proteus@proteus": [{ scope: "user", installPath: ROOT, gitCommitSha: sha }] } }));
const cfg = json(CLAUDE, "proteus.json");
r = inst(W, "--remove-user-install");
ok("remove-user-install: exits 0", r.code === 0, both(r).slice(-1000));
ok("remove-user-install: the skill links are gone", !fs.existsSync(path.join(CLAUDE, "skills", "proteus")) && !fs.existsSync(path.join(CLAUDE, "skills", "proteus-review")));
ok("remove-user-install: only the edited agent stays, and is named", fs.readdirSync(path.join(CLAUDE, "agents")).filter((f) => f.startsWith("proteus-")).join() === ua[0] && r.out.includes(ua[0]), r.out.slice(0, 1500));
const cfg2 = json(CLAUDE, "proteus.json");
ok("remove-user-install: proteus.json loses autoUpdate only", cfg.autoUpdate !== undefined && cfg2.autoUpdate === undefined && cfg2.home === cfg.home, JSON.stringify(cfg2));
const cfgAfter = snap(CLAUDE);
r = inst(W, "--remove-user-install");
ok("remove-user-install: a re-run removes nothing", r.code === 0 && snap(CLAUDE) === cfgAfter && !/^removed/m.test(r.out), r.out.slice(0, 800));
r = inst(W, "--remove-user-install", "--project");
ok("remove-user-install: takes only --dry-run", r.code === 2, both(r).slice(-300));

// ---- under the plugin the autostart copies nothing from the 1.x checkout proteus.json names
const Q = repo("autostart");
fs.mkdirSync(path.join(Q, "teams"));
fs.writeFileSync(path.join(Q, "teams", "ROUTING.md"), "# routing\n");
fs.mkdirSync(path.join(Q, ".claude"));
fs.writeFileSync(path.join(Q, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "proteus@proteus": true } }));
r = lib.run(path.join(ROOT, "templates", "hooks", "proteus-autostart.js"), { hook_event_name: "SessionStart", source: "startup", session_id: "s" }, { cwd: Q, env: { CLAUDE_PLUGIN_ROOT: ROOT, CLAUDE_PLUGIN_DATA: path.join(W, "pdata") } });
ok("autostart (plugin): copies no hooks or agents into the repo", !exists(Q, ".claude", "hooks") && !exists(Q, ".claude", "agents"), `${r.code} ${both(r).slice(0, 600)}`);

lib.summary();

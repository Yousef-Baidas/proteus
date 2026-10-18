// Guest mode tests: node tests/guest.test.js (needs git). In a repo the human does not own, install.js --project
// (and --plugin-setup, #173) keeps teams/ and the lead's docs in a guest dir outside the repo (marker <git-common-dir>/proteus/guest.json),
// adds no CI, lefthook or root doc, and the lead guard, autostart, baseline ratchet and link-skills follow the
// guest dir. Fake HOME, fake gh (FAKE_GH_PERMISSION) and claude; never the network or the real ~/.claude.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "templates", "hooks");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("guest");
const CTX = "context-mode@context-mode";
lib.fakeCli(lib.BIN, "claude", `const fs = require("fs"), path = require("path"), os = require("os");
const a = process.argv.slice(2).join(" ");
const d = path.join(os.homedir(), ".claude"), rd = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {}; } };
fs.mkdirSync(path.join(d, "plugins"), { recursive: true });
if (a === "plugin marketplace add mksglu/context-mode") fs.writeFileSync(path.join(d, "plugins", "known_marketplaces.json"), JSON.stringify({ "context-mode": {} }));
if (a === "plugin install ${CTX} --scope user") fs.writeFileSync(path.join(d, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "${CTX}": [{ scope: "user" }] } }));
if (a === "plugin install ${CTX} --scope user" || a === "plugin enable ${CTX} --scope user") {
  const s = rd(path.join(d, "settings.json")); s.enabledPlugins = { ...s.enabledPlugins, "${CTX}": true }; fs.writeFileSync(path.join(d, "settings.json"), JSON.stringify(s));
}
`);

const INSTALL = path.join(ROOT, "install.js");
const read = (...p) => { try { return fs.readFileSync(path.join(...p), "utf8"); } catch { return null; } };
const json = (...p) => { try { return JSON.parse(read(...p)); } catch { return null; } };
const exists = (...p) => fs.existsSync(path.join(...p));
const both = (r) => `${r.out}${r.err}`;
function repo(name) {
  const d = path.join(W, name);
  g(W, "init", "-q", "-b", "main", d);
  fs.writeFileSync(path.join(d, "README.md"), "# upstream\n");
  g(d, "add", "README.md");
  g(d, "commit", "-q", "-m", "init");
  return d;
}
const install = (cwd, args, env = {}) => lib.run(INSTALL, "", { cwd, args: ["--project", ...args], env });
const marker = (r) => json(r, ".git", "proteus", "guest.json");

// ---- detection: gh says READ, the repo has no teams/: guest mode, nothing in the tree
const GR = repo("upstream");
let r = install(GR, [], { FAKE_GH_PERMISSION: "READ" });
const GD = (marker(GR) || {}).dir || "";
ok("detect: --project on a READ repo exits 0 and writes .git/proteus/guest.json", r.code === 0 && GD && path.isAbsolute(GD), both(r).slice(-1500));
ok("detect: the guest dir is per user, outside the repo (~/.proteus/guest/<repo>-<hash>)", path.dirname(GD) === path.join(lib.HOME, ".proteus", "guest") && /^upstream-[0-9a-f]{8}$/.test(path.basename(GD)), GD);
ok("detect: teams/ (ROUTING.md, link-skills.js, templates/) is in the guest dir", exists(GD, "teams", "ROUTING.md") && exists(GD, "teams", "link-skills.js") && exists(GD, "teams", "templates", "hooks", "proteus-baseline.js"));
ok("detect: the repo gets no teams/, CI, lefthook or root doc", !exists(GR, "teams") && !exists(GR, ".github") && !exists(GR, "lefthook.yml") && !exists(GR, "CONTEXT.md") && !exists(GR, "AGENTS.md"));
ok("detect: git status stays clean (the harness's own files are excluded)", g(GR, "status", "--porcelain") === "", g(GR, "status", "--porcelain", "-uall"));
ok("detect: .claude/settings.local.json opens the guest dir to the session", ((json(GR, ".claude", "settings.local.json") || {}).permissions || {}).additionalDirectories?.includes(GD), read(GR, ".claude", "settings.local.json"));
ok("detect: the output says why", /gh reports READ access/.test(r.out) && /guest {4}-> /.test(r.out), r.out.slice(-800));
r = install(GR, [], { FAKE_GH_PERMISSION: "READ" });
ok("rerun: --project again keeps the guest dir and adds it once", r.code === 0 && marker(GR).dir === GD && json(GR, ".claude", "settings.local.json").permissions.additionalDirectories.filter((d) => d === GD).length === 1, both(r).slice(-800));

const OWN = repo("owned");
r = install(OWN, [], { FAKE_GH_PERMISSION: "WRITE" });
ok("detect: a WRITE repo installs into the tree as before", r.code === 0 && !marker(OWN) && exists(OWN, "teams", "ROUTING.md"), both(r).slice(-800));
const NOGH = repo("nogh");
r = install(NOGH, []);
ok("detect: gh unable to tell (no remote) installs into the tree", r.code === 0 && !marker(NOGH) && exists(NOGH, "teams"), both(r).slice(-800));

// ---- --guest [dir] and --no-guest
const EX = repo("explicit");
const EXD = path.join(W, "elsewhere");
r = install(EX, ["--guest", EXD]);
ok("--guest <dir>: that dir holds teams/; no gh check needed", r.code === 0 && marker(EX).dir === EXD && exists(EXD, "teams", "ROUTING.md") && !exists(EX, "teams"), both(r).slice(-800));
ok("--guest inside the repo is refused", install(EX, ["--guest", path.join(EX, "proteus")]).code === 2);
ok("--guest without --project is refused", lib.run(INSTALL, "", { cwd: EX, args: ["--guest"] }).code === 2);
r = install(EX, ["--no-guest"]);
ok("--no-guest: the marker goes, the guest dir keeps its files, teams/ lands in the repo", r.code === 0 && !marker(EX) && exists(EXD, "teams", "ROUTING.md") && exists(EX, "teams", "ROUTING.md"), both(r).slice(-800));

// ---- the lead guard follows the guest dir
const LG = path.join(GR, ".claude", "hooks", "proteus-lead-guard.js");
const edit = (file, extra = {}) => lib.run(LG, { hook_event_name: "PreToolUse", session_id: "s1", cwd: GR, tool_name: "Write", tool_input: { file_path: file, content: "x" }, ...extra }, { cwd: GR });
r = edit(path.join(GR, "CONTEXT.md"));
ok("guard: the lead's CONTEXT.md in the repo is refused and the guest path named", r.code === 2 && r.err.includes(`${GD.split(path.sep).join("/")}/CONTEXT.md`), r.err);
ok("guard: the lead writes CONTEXT.md, CONVENTIONS.md, AGENTS.md, ADRs and lessons in the guest dir",
  ["CONTEXT.md", "CONVENTIONS.md", "AGENTS.md", "docs/adr/0001-x.md", "docs/lessons/l.md"].every((f) => edit(path.join(GD, ...f.split("/"))).code === 0));
ok("guard: other guest-dir files are not the lead's", ((x) => x.code === 2 && /in the guest dir/.test(x.err))(edit(path.join(GD, "teams", "ROUTING.md"))));
ok("guard: code in the repo stays refused", edit(path.join(GR, "src", "a.js")).code === 2);
ok("guard: paths outside both pass", edit(path.join(W, "issue-body.md")).code === 0);
const sub = (file, type = "proteus-worker") => edit(file, { agent_id: "a1", agent_type: type });
ok("guard: with no run open, a subagent may edit the guest dir", sub(path.join(GD, "teams", "backend", "PROFILE.md")).code === 0);
g(GR, "branch", "proteus/r1");
r = sub(path.join(GD, "teams", "backend", "PROFILE.md"));
ok("guard: during a run, a subagent edit in the guest dir is refused like one in the main checkout", r.code === 2 && /while a run is open/.test(r.err), r.err);
ok("guard: during a run, the scout still writes teams/*/skills.txt there", sub(path.join(GD, "teams", "backend", "skills.txt"), "proteus-scout").code === 0);
g(GR, "branch", "-D", "proteus/r1");

// ---- autostart reads the guest dir
fs.writeFileSync(path.join(GD, "CONTEXT.md"), "# ctx\n");
fs.writeFileSync(path.join(GD, "AGENTS.md"), "# agents\n\n## Learned\n");
const AS = path.join(GR, ".claude", "hooks", "proteus-autostart.js");
r = lib.run(AS, { hook_event_name: "SessionStart", source: "startup", session_id: "s1", cwd: GR }, { cwd: GR });
const state = r.out.split("\n").find((l) => l.startsWith("proteus-state")) || "";
ok("autostart: the state line names the guest dir and reads its docs and teams",
  state.includes(`guest=${GD.split(path.sep).join("/")}`) && /CONTEXT\.md=yes/.test(state) && /AGENTS\.md#Learned=yes/.test(state) && /teams=\w/.test(state), state || r.err);
ok("autostart: CI gates and lefthook read guest, not missing", /ci-gates=guest/.test(state) && /lefthook=guest/.test(state), state);

// ---- lib, the baseline ratchet and link-skills find the guest dir
const hl = require(path.join(SRC, "proteus-lib.js"));
ok("lib: docRoot and lockFile point into the guest dir; a normal repo keeps its own", hl.docRoot(GR) === GD && hl.docRoot(OWN) === OWN && hl.guestDir(OWN) === "");
r = lib.run(path.join(GD, "teams", "templates", "hooks", "proteus-baseline.js"), "", { cwd: GR, args: ["test", "--record", "--", process.execPath, "-e", "console.log('FAIL a'); process.exit(1)"] });
ok("baseline: the default file is the guest dir's teams/baseline.json", r.code === 0 && json(GD, "teams", "baseline.json").gates.test.findings[0] === "FAIL a" && !exists(GR, "teams"), r.err);
fs.mkdirSync(path.join(GD, "docs", "lessons"), { recursive: true });
fs.writeFileSync(path.join(GD, "docs", "lessons", "build.md"), "---\ntrigger: make build\non: command\n---\nBuild needs the vendored toolchain.\n");
r = lib.run(path.join(GR, ".claude", "hooks", "proteus-lessons.js"), { hook_event_name: "PreToolUse", session_id: "s1", cwd: GR, tool_name: "Bash", tool_input: { command: "make build" } }, { cwd: GR });
ok("lessons: recalled from the guest dir's docs/lessons", /vendored toolchain/.test(r.out), r.out + r.err);
r = lib.run(path.join(GD, "teams", "link-skills.js"), "", { cwd: GR });
ok("link-skills: run from the repo root, it works on the teams/ it sits in", r.code === 0, r.err);

// ---- doctor
r = lib.run(INSTALL, "", { cwd: GR, args: ["--doctor"] });
ok("doctor: knows the guest project and skips the repo's CI and lefthook checks", /guest mode: Proteus files in/.test(r.out) && !/not a Proteus project/.test(r.out) && !/commit-msg gate/.test(r.out) && !/proteus-gates\.yml/.test(r.out), r.out.slice(-1500));
const s = json(GR, ".claude", "settings.local.json");
s.permissions.additionalDirectories = [];
fs.writeFileSync(path.join(GR, ".claude", "settings.local.json"), JSON.stringify(s));
r = lib.run(INSTALL, "", { cwd: GR, args: ["--doctor", "--fix"] });
ok("doctor --fix: puts the guest dir back into additionalDirectories", json(GR, ".claude", "settings.local.json").permissions.additionalDirectories.includes(GD), r.out.slice(-800));

// ---- codex: the guest dir is a writable root; a tracked config.toml is left alone
const CODEX = { CODEX_HOME: path.join(lib.HOME, ".codex") };
const CX = repo("codex-guest");
r = install(CX, ["--harness", "codex", "--guest"], CODEX);
const toml = read(CX, ".codex", "config.toml") || "";
const CXD = (marker(CX) || {}).dir || "";
ok("codex: --guest lists the guest dir in writable_roots, and no folder beside the repo", r.code === 0 && CXD && toml.includes(JSON.stringify(CXD)) && !toml.includes(`${CX}-proteus`), `${both(r).slice(-600)}\n${toml}`);
ok("codex: git status stays clean", g(CX, "status", "--porcelain") === "", g(CX, "status", "--porcelain"));
const CT = repo("codex-tracked");
fs.mkdirSync(path.join(CT, ".codex"));
fs.writeFileSync(path.join(CT, ".codex", "config.toml"), "model = \"x\"\n");
g(CT, "add", ".codex/config.toml");
g(CT, "commit", "-q", "-m", "codex config");
r = install(CT, ["--harness", "codex", "--guest"], CODEX);
ok("codex: a tracked config.toml is not edited in guest mode; the output says what to add", read(CT, ".codex", "config.toml") === "model = \"x\"\n" && /leaves the repo's tracked \.codex\/config\.toml alone/.test(both(r)), both(r).slice(-600));

// ---- --plugin-setup (#173): the same guest decision as --project; nothing lands in the checkout
const setup = (cwd, args, env = {}) => lib.run(INSTALL, "", { cwd, args: ["--plugin-setup", "--only-here", ...args], env });
const PDRY = repo("plugin-dry");
r = setup(PDRY, ["--dry-run"], { FAKE_GH_PERMISSION: "READ" });
ok("plugin: --dry-run on a READ repo says guest and writes nothing", r.code === 0 && /would use /.test(r.out) && !marker(PDRY) && !exists(PDRY, ".claude") && !exists(PDRY, "teams") && g(PDRY, "status", "--porcelain") === "", both(r).slice(-1000));
const PG = repo("plugin-upstream");
const before = g(PG, "ls-files");
r = setup(PG, [], { FAKE_GH_PERMISSION: "READ" });
const PGD = (marker(PG) || {}).dir || "";
const pl = json(PG, ".claude", "settings.local.json") || {};
ok("plugin: --plugin-setup on a READ repo goes guest, teams/ in the guest dir", r.code === 0 && PGD && /gh reports READ access/.test(r.out) && exists(PGD, "teams", "ROUTING.md") && !exists(PG, "teams"), both(r).slice(-1500));
ok("plugin: the checkout is untouched (no settings.json, status clean, same files)", !exists(PG, ".claude", "settings.json") && g(PG, "status", "--porcelain") === "" && g(PG, "ls-files") === before, g(PG, "status", "--porcelain", "-uall"));
ok("plugin: settings.local.json holds the gate, the guest dir and a statusLine from the guest dir's teams/",
  (pl.enabledPlugins || {})["proteus@proteus"] === true && ((pl.permissions || {}).additionalDirectories || []).includes(PGD)
  && String((pl.statusLine || {}).command).includes(path.join(PGD, "teams").split(path.sep).join("/")), JSON.stringify(pl));
ok("plugin: the next steps name nothing to commit", /nothing to commit: guest mode/.test(r.out) && !/commit \.claude\/settings\.json/.test(r.out), r.out.slice(-800));
r = lib.run(INSTALL, "", { cwd: PG, args: ["--doctor"] });
const bad = r.out.split(/\r?\n/).filter((l) => /^(FIX|WARN)\b/.test(l) && /not a Proteus project|plugin gate|plugin marketplace|teams\/ROUTING|guest mode/.test(l));
ok("plugin: --doctor reports the guest setup as healthy", /^ok\s.*guest mode: Proteus files in/m.test(r.out) && /^ok\s.*plugin gate/m.test(r.out) && /^ok\s.*teams\/ROUTING\.md/m.test(r.out) && !bad.length, bad.join("\n") || r.out.slice(-1500));
r = setup(PG, [], { FAKE_GH_PERMISSION: "READ" });
ok("plugin: a rerun keeps the guest dir and lists it once", r.code === 0 && marker(PG).dir === PGD && json(PG, ".claude", "settings.local.json").permissions.additionalDirectories.filter((d) => d === PGD).length === 1 && g(PG, "status", "--porcelain") === "", both(r).slice(-800));
const PN = repo("plugin-noguest");
r = setup(PN, ["--no-guest"], { FAKE_GH_PERMISSION: "READ" });
ok("plugin: --no-guest on a READ repo installs into the checkout", r.code === 0 && !marker(PN) && exists(PN, "teams", "ROUTING.md") && (json(PN, ".claude", "settings.json").enabledPlugins || {})["proteus@proteus"] === true, both(r).slice(-800));
const PX = repo("plugin-explicit"), PXD = path.join(W, "plugin-elsewhere");
r = setup(PX, ["--guest", PXD]);
ok("plugin: --guest <dir> uses that dir, no gh check needed", r.code === 0 && marker(PX).dir === PXD && exists(PXD, "teams", "ROUTING.md") && !exists(PX, "teams") && g(PX, "status", "--porcelain") === "", both(r).slice(-800));
ok("plugin: --guest and --no-guest conflict", setup(PX, ["--guest", "--no-guest"]).code === 2);

lib.summary();

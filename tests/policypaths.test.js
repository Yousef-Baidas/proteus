// Policy paths (#315): node tests/policypaths.test.js (needs git). In guest mode proteus-policy.js reads and writes the
// guest dir's teams/, and its files there are refused to edits; a repo with no guest marker keeps its own. A non-plugin
// install carries the presets beside its hooks copy, a worker's worktree too, git-excluded, and the lookup finds them
// there first; the plugin's ../policy and the repo's teams/templates still work; an update and the move to the plugin
// keep a copy the user edited. Fake HOME and gh; never the network or the real ~/.claude.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "templates", "hooks");
const INSTALL = path.join(ROOT, "install.js");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("policypaths");
const read = (...p) => { try { return fs.readFileSync(path.join(...p), "utf8"); } catch { return null; } };
const exists = (...p) => fs.existsSync(path.join(...p));
const both = (r) => `${r.out}${r.err}`;
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const PRESETS = read(ROOT, "templates", "policy", "presets.json");
const OURS = JSON.stringify({ balanced: { merge: "human", ask: "every", rules: [] } });
const policy = (preset) => JSON.stringify({ version: 1, preset });

function repo(name) {
  const d = path.join(W, name);
  g(W, "init", "-q", "-b", "main", d);
  fs.writeFileSync(path.join(d, "README.md"), "# r\n");
  g(d, "add", "README.md");
  g(d, "commit", "-q", "-m", "init");
  return d;
}
// a repo marked as a guest of the dir it returns, the marker as install.js --guest writes it
function guested(name) {
  const d = repo(name), guest = path.join(W, `${name}-guest`);
  fs.mkdirSync(guest, { recursive: true });
  put(path.join(d, ".git", "proteus", "guest.json"), JSON.stringify({ dir: guest }));
  return [d, guest];
}
// the hook scripts alone, in dir: what a non-plugin install's .claude/hooks has before the presets arrive
function hooksCopy(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(SRC)) if (fs.statSync(path.join(SRC, f)).isFile()) fs.copyFileSync(path.join(SRC, f), path.join(dir, f));
  return dir;
}
const script = (dir) => path.join(dir, "proteus-policy.js");
const cli = (dir, cwd, ...args) => lib.run(script(dir), "", { cwd, args });
const show = (dir, cwd) => JSON.parse(cli(dir, cwd, "show", "--json").out);

// ---- the teams dir, in guest mode and out of it
const [GR, GD] = guested("guest");
put(path.join(GR, "teams", "policy.json"), policy("hands-off"));
put(path.join(GD, "teams", "policy.json"), policy("careful"));
let s = show(SRC, GR);
ok("guest: load reads the guest dir's teams/policy.json, not the repo's", s.policy.preset === "careful" && s.policy.merge === "human" && s.files.project === path.join(GD, "teams", "policy.json"), JSON.stringify(s));
const PLAIN = repo("plain");
put(path.join(PLAIN, "teams", "policy.json"), policy("hands-off"));
s = show(SRC, PLAIN);
ok("no guest: load reads the repo's teams/policy.json", s.policy.preset === "hands-off" && fs.realpathSync(s.files.project) === fs.realpathSync(path.join(PLAIN, "teams", "policy.json")), JSON.stringify(s));

const WT = path.join(GR, ".worktrees", "w1");
g(GR, "worktree", "add", "-q", "-b", "w1", WT, "main");
ok("guest: a linked worktree reads the guest dir's file too", show(SRC, WT).policy.preset === "careful");

const DRAFT = path.join(W, "draft.json");
fs.writeFileSync(DRAFT, policy("balanced"));
let r = cli(SRC, GR, "write", DRAFT);
ok("guest: write puts policy.json and POLICY.md in the guest dir", r.code === 0 && JSON.parse(read(GD, "teams", "policy.json")).preset === "balanced" && exists(GD, "teams", "POLICY.md"), both(r));
ok("guest: write leaves the repo's tree alone", JSON.parse(read(GR, "teams", "policy.json")).preset === "hands-off" && !exists(GR, "teams", "POLICY.md"));
r = cli(SRC, PLAIN, "write", DRAFT);
ok("no guest: write puts them in the repo", r.code === 0 && JSON.parse(read(PLAIN, "teams", "policy.json")).preset === "balanced" && exists(PLAIN, "teams", "POLICY.md"), both(r));

// the fixed core reaches the file the engine now reads
const P = require(script(SRC));
const denied = (root, file) => {
  let why = "";
  try { P.guard({ tool: "edit", paths: [file], cwd: root, root }, { deny: (m) => { throw new Error(m); } }, true); } catch (e) { why = e.message; }
  return why;
};
for (const f of ["policy.json", "POLICY.md"]) {
  ok(`guest: an edit of the guest dir's teams/${f} is refused`, /is the policy, which nobody writes by hand/.test(denied(GR, path.join(GD, "teams", f))), denied(GR, path.join(GD, "teams", f)));
  ok(`no guest: an edit of the repo's teams/${f} is refused`, /is the policy, which nobody writes by hand/.test(denied(PLAIN, path.join(PLAIN, "teams", f))));
}
ok("guest: an edit elsewhere in the guest dir is not the policy", denied(GR, path.join(GD, "CONTEXT.md")) === "", denied(GR, path.join(GD, "CONTEXT.md")));

// an invalid guest file is the one the guard names
put(path.join(GD, "teams", "policy.json"), "{");
ok("guest: an invalid guest policy refuses edits, naming the guest file", denied(GR, path.join(GR, "README.md")).includes(path.join(GD, "teams", "policy.json").split(path.sep).join("/")), denied(GR, path.join(GR, "README.md")));
fs.rmSync(path.join(GD, "teams", "policy.json"));

// ---- the lookup's order
const LOOK = repo("look");
const HC = hooksCopy(path.join(LOOK, ".claude", "hooks"));
ok("presets: a bare hooks copy with no teams/templates finds none", Object.keys(require(script(HC)).presets(LOOK)).length === 0);
put(path.join(LOOK, "teams", "templates", "policy", "presets.json"), JSON.stringify({ fallback: { merge: "lead", ask: "never", rules: [] } }));
ok("presets: without a copy the repo's teams/templates is the fallback", Object.keys(cliPresets(HC, LOOK))[0] === "fallback", JSON.stringify(cliPresets(HC, LOOK)));
put(path.join(HC, "presets.json"), OURS);
ok("presets: the copy beside the hooks comes first", Object.keys(cliPresets(HC, LOOK))[0] === "balanced", JSON.stringify(cliPresets(HC, LOOK)));
fs.writeFileSync(path.join(HC, "presets.json"), "not json");
ok("presets: an unreadable copy falls through to the fallback", Object.keys(cliPresets(HC, LOOK))[0] === "fallback");
ok("presets: the plugin's own ../policy is found with no copy and no root", Object.keys(P.presets("")).sort().join() === Object.keys(JSON.parse(PRESETS)).sort().join());

const [FR, FD] = guested("guestlook");
const FH = hooksCopy(path.join(FR, ".claude", "hooks"));
put(path.join(FR, "teams", "templates", "policy", "presets.json"), JSON.stringify({ repo: { merge: "lead", ask: "never", rules: [] } }));
put(path.join(FD, "teams", "templates", "policy", "presets.json"), JSON.stringify({ guest: { merge: "lead", ask: "never", rules: [] } }));
ok("guest presets: the fallback is the guest dir's teams/templates", Object.keys(cliPresets(FH, FR))[0] === "guest", JSON.stringify(cliPresets(FH, FR)));

// the presets a script at dir reads for root, in a process of its own
function cliPresets(dir, root) {
  const r = require("child_process").spawnSync(process.execPath, ["-e", `console.log(JSON.stringify(require(${JSON.stringify(script(dir))}).presets(${JSON.stringify(root)})))`], { encoding: "utf8", env: { ...process.env, HOME: lib.HOME } });
  return JSON.parse(r.stdout);
}

// ---- a non-plugin install, Claude Code and Codex
const env = { GIT_CEILING_DIRECTORIES: W };
const install = (cwd, ...args) => lib.run(INSTALL, "", { cwd, args: ["--project", ...args], env });
const I = repo("install");
r = install(I);
const IH = path.join(I, ".claude", "hooks"), COPY = path.join(IH, "presets.json");
ok("install: --project exits 0", r.code === 0, both(r).slice(-1500));
ok("install: the presets sit beside the hooks copy", read(COPY) === PRESETS, read(COPY));
ok("install: the copy is git-excluded", (read(I, ".git", "info", "exclude") || "").split("\n").includes(".claude/hooks/presets.json") && !g(I, "status", "--porcelain", "--", ".claude/hooks/presets.json"), read(I, ".git", "info", "exclude"));
fs.rmSync(path.join(I, "teams", "templates", "policy"), { recursive: true });
ok("install: the hooks copy reads them with teams/templates gone", show(IH, I).policy.merge === JSON.parse(PRESETS).balanced.merge && show(IH, I).errors.length === 0, both(cli(IH, I, "show", "--json")));
fs.writeFileSync(COPY, OURS);
r = install(I);
ok("update: a copy the user edited stays", r.code === 0 && read(COPY) === OURS, read(COPY));
fs.rmSync(COPY);
r = install(I);
ok("update: a missing copy comes back", r.code === 0 && read(COPY) === PRESETS, read(COPY));

const CX = repo("codex");
r = lib.run(path.join(SRC, "install-lead-hooks.js"), "", { cwd: CX, env: { PROTEUS_HARNESS: "codex" } });
ok("install (Codex): the presets sit beside .codex/hooks", r.code === 0 && read(CX, ".codex", "hooks", "presets.json") === PRESETS, both(r));

// a past shipped text is replaced, by the checkout's known-blobs.json
const CK = path.join(W, "checkout");
const CH = hooksCopy(path.join(CK, "templates", "hooks"));
put(path.join(CK, "templates", "policy", "presets.json"), PRESETS);
const blob = (t) => crypto.createHash("sha1").update(`blob ${Buffer.byteLength(t)}\0`).update(t).digest("hex");
const OLD = JSON.stringify({ balanced: { merge: "lead", ask: "never", rules: [] } }) + "\n";
put(path.join(CK, "scripts", "known-blobs.json"), JSON.stringify({ blobs: { "templates/policy/presets.json": [blob(OLD)] } }));
const K = repo("known"), KH = path.join(K, ".claude", "hooks");
put(path.join(KH, "presets.json"), OLD);
r = lib.run(path.join(CH, "install-lead-hooks.js"), "", { cwd: K });
ok("update: an unedited past copy takes the new text", r.code === 0 && read(KH, "presets.json") === PRESETS, read(KH, "presets.json"));
put(path.join(KH, "presets.json"), OLD.replace(/\n/g, "\r\n"));
lib.run(path.join(CH, "install-lead-hooks.js"), "", { cwd: K });
ok("update: so does one with CRLF line endings", read(KH, "presets.json") === PRESETS, read(KH, "presets.json"));

// ---- a worker's worktree, from a non-plugin install and from the plugin's scripts
const I2 = repo("worker");
install(I2);
const WK = path.join(I2, ".worktrees", "w1");
g(I2, "worktree", "add", "-q", "-b", "proteus-work/r1/1", WK, "main");
r = lib.run(path.join(I2, ".claude", "hooks", "proteus-worktree.js"), "", { cwd: I2, args: [WK, "src/**"] });
ok("worker: the worktree's hooks carry the presets, excluded", r.code === 0 && read(WK, ".claude", "hooks", "presets.json") === PRESETS && !g(WK, "status", "--porcelain", "--", ".claude/hooks/presets.json"), both(r));

// ---- the plugin: nothing beside the hooks, ../policy serves
const PL = repo("plugin");
const plug = lib.run(INSTALL, "", { cwd: PL, args: ["--plugin-setup"], env });
ok("plugin: setup puts no presets in .claude/hooks", plug.code === 0 && !exists(PL, ".claude", "hooks", "presets.json"), both(plug).slice(-1500));
ok("plugin: the script reads its own ../policy", show(SRC, PL).sources.preset === "default" && show(SRC, PL).policy.merge === JSON.parse(PRESETS).balanced.merge);

// ---- the move to the plugin takes an unedited copy, names an edited one
const M = repo("migrate"), MH = path.join(M, ".claude", "hooks");
install(M);
r = lib.run(INSTALL, "", { cwd: M, args: ["--plugin-setup"], env });
ok("migrate: an unedited copy goes, with its exclude line", r.code === 0 && !exists(MH, "presets.json") && !/hooks\/presets\.json/.test(read(M, ".git", "info", "exclude") || ""), both(r).slice(-1500));
const E = repo("migrate-edited"), EH = path.join(E, ".claude", "hooks");
install(E);
fs.writeFileSync(path.join(EH, "presets.json"), OURS);
r = lib.run(INSTALL, "", { cwd: E, args: ["--plugin-setup"], env });
ok("migrate: an edited copy stays and is named", r.code === 0 && read(EH, "presets.json") === OURS && /presets\.json \(edited\)/.test(both(r)), both(r).slice(-1500));

// ---- autostart: refreshes the copy an install made, makes none, keeps an edit
put(path.join(lib.HOME, ".claude", "proteus.json"), JSON.stringify({ home: CK, autoUpdate: false, lastFetch: Date.now() }));
const start = () => lib.run(path.join(CH, "proteus-autostart.js"), { hook_event_name: "SessionStart", source: "startup", session_id: "s1", cwd: K }, { cwd: K });
put(path.join(KH, "presets.json"), OLD);
r = start();
ok("autostart: an unedited past copy takes the new text", read(KH, "presets.json") === PRESETS, both(r).slice(0, 800));
fs.writeFileSync(path.join(KH, "presets.json"), OURS);
start();
ok("autostart: an edited copy stays", read(KH, "presets.json") === OURS, read(KH, "presets.json"));
fs.rmSync(path.join(KH, "presets.json"));
start();
ok("autostart: no copy, none made (only --project excludes it)", !exists(KH, "presets.json"));
fs.rmSync(path.join(lib.HOME, ".claude", "proteus.json"));

lib.summary();

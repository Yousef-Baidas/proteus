// Agent patches (#97): node tests/agentpatch.test.js (needs git). A project's .claude/proteus-agents.json
// patches the shipped agents; install.js --project, --update and the session-start autostart write
// .claude/agents/<name>.md from the shipped agent plus the patch, marked as generated, and remove it when
// its entry goes. A bad file is a clear error that leaves the agent files alone; --doctor names the
// fields a hand-made override changes. Runs a copy of this checkout as the Proteus home (a git repo with
// a local bare remote), a fake HOME and fake gh; never the network or the real ~/.claude.
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("agentpatch");
const { HOME } = lib;

// the Proteus home: this checkout's files (uncommitted ones too), committed, with a bare remote for --update
const PH = path.join(W, "proteus"), BARE = path.join(W, "proteus.git");
g(W, "init", "-q", "--bare", "-b", "main", BARE);
g(W, "init", "-q", "-b", "main", PH);
for (const f of execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean)) {
  const s = path.join(ROOT, f);
  if (!fs.existsSync(s) || !fs.statSync(s).isFile()) continue;
  fs.mkdirSync(path.dirname(path.join(PH, f)), { recursive: true });
  fs.copyFileSync(s, path.join(PH, f));
}
g(PH, "add", "-A"); g(PH, "commit", "-qm", "chore: snapshot");
g(PH, "remote", "add", "origin", BARE); g(PH, "push", "-q", "-u", "origin", "main");
const INST = path.join(PH, "install.js");
const MOD = require(path.join(PH, "templates", "hooks", "proteus-agent-patch.js"));

// the project
const PR = path.join(W, "app");
g(W, "init", "-q", "-b", "main", PR);
fs.writeFileSync(path.join(PR, "README.md"), "# app\n");
g(PR, "add", "-A"); g(PR, "commit", "-qm", "init");
const AG = (n) => path.join(PR, ".claude", "agents", `${n}.md`);
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
const patches = (v) => fs.writeFileSync(path.join(PR, ".claude", "proteus-agents.json"), typeof v === "string" ? v : JSON.stringify(v, null, 2));
const inst = (args = ["--project"], cwd = PR) => lib.run(INST, "", { cwd, args });
const both = (r) => `${r.out}${r.err}`;
const shipEdit = (f, line, msg) => { fs.appendFileSync(path.join(PH, "agents", f), `\n${line}\n`); g(PH, "commit", "-qam", msg); };
const toolsOf = (t) => (/^tools:\n((?: {2}- .*\n)+)/m.exec(t) || ["", ""])[1].split("\n").filter(Boolean).map((l) => l.replace(/^ {2}- /, ""));

fs.mkdirSync(path.join(PR, ".claude"), { recursive: true });
patches({
  "proteus-guide": { tools: { add: ["Skill"], remove: ["Write"] }, model: "opus", append: "Also check X before approving." },
  "proteus-worker": { effort: "high" },
});
let r = inst();
let gt = read(AG("proteus-guide"));
ok("patch: --project writes the patched agent, marked as generated", r.code === 0 && gt !== null && gt.split("\n")[1].startsWith(MOD.MARK) &&
  /agent {4}-> \.claude\/agents\/proteus-guide\.md \(shipped agent \+ \.claude\/proteus-agents\.json\)/.test(r.out), both(r));
ok("patch: tools added and removed, model set, prompt appended last", toolsOf(gt).includes("Skill") && !toolsOf(gt).includes("Write") && toolsOf(gt).includes("Read") &&
  /^model: opus$/m.test(gt) && gt.endsWith("\n\nAlso check X before approving.\n"), gt);
ok("patch: effort added to an agent that ships none, no tools list invented", /^model: sonnet\neffort: high$/m.test(read(AG("proteus-worker")) || "") && !/^tools:/m.test(read(AG("proteus-worker")) || ""), read(AG("proteus-worker")));
ok("patch: generated files are git-excluded, the patch file is not", /^\.claude\/agents\/proteus-guide\.md$/m.test(read(path.join(PR, ".git", "info", "exclude")) || "") &&
  g(PR, "status", "--porcelain", "-uall").includes(".claude/proteus-agents.json") && !g(PR, "status", "--porcelain", "-uall").includes("proteus-guide.md"), g(PR, "status", "--porcelain", "-uall"));
r = inst();
ok("patch: a re-run rewrites nothing and calls no generated file an override or a duplicate", r.code === 0 && !/agent {4}->/.test(r.out) && !/override|duplicate/.test(r.out) && read(AG("proteus-guide")) === gt, both(r));

// a shipped change flows through on --update (no newer release: it re-runs the installer for this project)
shipEdit("proteus-guide.md", "SHIPPED-V2 line.", "feat: guide v2");
r = inst(["--update"]);
gt = read(AG("proteus-guide"));
ok("update: a shipped change reaches the patched agent, the patch still applied", r.code === 0 && gt.includes("SHIPPED-V2 line.") && toolsOf(gt).includes("Skill") &&
  gt.endsWith("\n\nAlso check X before approving.\n") && /agent {4}-> \.claude\/agents\/proteus-guide\.md/.test(r.out), both(r));

// the autostart's sync (the auto-update path) regenerates it too
fs.writeFileSync(path.join(HOME, ".claude", "proteus.json"), JSON.stringify({ ...JSON.parse(read(path.join(HOME, ".claude", "proteus.json"))), lastFetch: Date.now() }));
shipEdit("proteus-guide.md", "SHIPPED-V3 line.", "feat: guide v3");
r = lib.run(path.join(PR, ".claude", "hooks", "proteus-autostart.js"), { hook_event_name: "SessionStart", source: "startup", session_id: "s1", cwd: PR }, { cwd: PR });
gt = read(AG("proteus-guide"));
ok("autostart: the session-start sync regenerates a patched agent and says so", r.code === 0 && gt.includes("SHIPPED-V3 line.") && toolsOf(gt).includes("Skill") &&
  /proteus: \.claude\/agents\/proteus-guide\.md regenerated \(\.claude\/proteus-agents\.json\)/.test(r.out), both(r).slice(0, 2000));

// an entry removed: its generated file goes
patches({ "proteus-guide": { tools: { add: ["Skill"] } } });
r = inst();
ok("remove: a generated file whose entry is gone is removed", r.code === 0 && read(AG("proteus-worker")) === null &&
  /removed {2}\.claude\/agents\/proteus-worker\.md \(generated; its entry left \.claude\/proteus-agents\.json\)/.test(r.out) && toolsOf(read(AG("proteus-guide"))).includes("Write"), both(r));

// bad files: one clear error naming the entry, no crash, agent files untouched
gt = read(AG("proteus-guide"));
const bad = [
  ["invalid JSON", "{ \"proteus-guide\": ", /\.claude\/proteus-agents\.json is not valid JSON/],
  ["not an object", "[1]", /must be a JSON object of agent name to patch/],
  ["unknown agent", { "proteus-nobody": { model: "opus" } }, /"proteus-nobody" is not a shipped agent \(shipped: .*proteus-guide/],
  ["unknown key", { "proteus-guide": { colour: "red" } }, /"proteus-guide"\.colour is not a patch key \(allowed: tools, model, effort, append\)/],
  ["model not a string", { "proteus-guide": { model: 5 } }, /"proteus-guide"\.model must be one word/],
  ["tools as a list", { "proteus-guide": { tools: ["Skill"] } }, /"proteus-guide"\.tools must be \{"add": \[\.\.\.\], "remove": \[\.\.\.\]\}/],
  ["tools.add not names", { "proteus-guide": { tools: { add: "Skill" } } }, /"proteus-guide"\.tools\.add must be a list of tool names/],
  ["tools.other", { "proteus-guide": { tools: { replace: [] } } }, /"proteus-guide"\.tools\.replace is not a tools key/],
  ["append not a string", { "proteus-guide": { append: ["x"] } }, /"proteus-guide"\.append must be a string/],
  ["tools on an agent with none", { "proteus-worker": { tools: { add: ["Skill"] } } }, /"proteus-worker"\.tools: the shipped agent has no tools list/],
];
for (const [what, v, re] of bad) {
  patches(v);
  r = inst();
  ok(`bad file (${what}): clear error, exit 1, nothing written or removed`, r.code === 1 && re.test(r.err) && /generated agents left as they were/.test(r.err) &&
    !/\n\s+at /.test(both(r)) && read(AG("proteus-guide")) === gt && read(AG("proteus-nobody")) === null, both(r));
}
r = inst(["--doctor"]);
ok("doctor: a bad patch file is a FIX row naming the entry", /FIX .*"proteus-worker"\.tools: the shipped agent has no tools list/.test(r.out), r.out);

// Windows-safe: a name that is a path is not an agent; BOM and CRLF are read; output is LF, paths "/"
patches({ "..\\..\\evil": { append: "x" }, "../evil": { append: "x" } });
r = inst();
ok("paths: an agent name with separators is refused as unknown, nothing written outside", r.code === 1 && /"\.\.\\\.\.\\evil" is not a shipped agent/.test(r.err) &&
  !fs.existsSync(path.join(PR, "evil.md")) && !fs.existsSync(path.join(PR, ".claude", "evil.md")), both(r));
patches("﻿" + JSON.stringify({ "proteus-guide": { append: "line one\r\nline two" } }, null, 2).replace(/\n/g, "\r\n"));
r = inst();
gt = read(AG("proteus-guide"));
ok("paths: a BOM and CRLF patch file is read; the generated file is LF only", r.code === 0 && !gt.includes("\r") && gt.endsWith("line one\nline two\n"), both(r));

// a hand-made copy where a patch would go is left alone and reported
fs.unlinkSync(AG("proteus-guide"));
fs.writeFileSync(AG("proteus-guide"), read(path.join(PH, "agents", "proteus-guide.md")).replace(/^model: .*$/m, "model: haiku") + "mine\n");
r = inst();
ok("copy: a local copy is not overwritten by a patch, and the install says how to move it", r.code === 0 && read(AG("proteus-guide")).endsWith("mine\n") &&
  /patch not applied: \.claude\/agents\/proteus-guide\.md is a local copy, not generated; move its edits into \.claude\/proteus-agents\.json, then delete it/.test(r.out) &&
  /local override kept: \.claude\/agents\/proteus-guide\.md \(differs in model, prompt\); shipped updates skip it\. Deleting it drops those edits/.test(r.out), r.out);

// doctor: the override WARN names the changed fields and points at the patch file, not a bare delete
fs.writeFileSync(AG("proteus-scout"), read(path.join(PH, "agents", "proteus-scout.md")).replace(/^tools:\n/m, "tools:\n  - Skill\n"));
r = inst(["--doctor"]);
const warnRow = r.out.split("\n").find((l) => l.includes("local agent overrides")) || "";
ok("doctor: override WARN names fields and proteus-agents.json, warns that deleting drops edits", /WARN/.test(warnRow) &&
  /proteus-guide\.md \(differs in model, prompt\)/.test(warnRow) && /proteus-scout\.md \(differs in tools\)/.test(warnRow) &&
  /deleting one drops those edits: put them in \.claude\/proteus-agents\.json/.test(r.out) && !/delete them to use the shipped ones/.test(r.out), r.out);
ok("doctor: a patch over a local copy is a WARN", /WARN .*\.claude\/proteus-agents\.json not applied over local copies: \.claude\/agents\/proteus-guide\.md/.test(r.out), r.out);
fs.unlinkSync(AG("proteus-scout")); fs.unlinkSync(AG("proteus-guide"));
r = inst(["--doctor"]);
ok("doctor: a missing generated agent is a FIX the --fix run writes", /FIX .*generated agents out of date with \.claude\/proteus-agents\.json: \.claude\/agents\/proteus-guide\.md/.test(r.out), r.out);
inst(["--doctor", "--fix"]);
ok("doctor --fix: regenerates it", MOD.isGenerated(read(AG("proteus-guide"))), read(AG("proteus-guide")));
r = inst(["--doctor"]);
ok("doctor: then agent patches applied, no override", /ok .*agent patches applied \(\.claude\/proteus-agents\.json\)/.test(r.out) && /no local agent overrides/.test(r.out), r.out);

// Codex: .codex/proteus-agents.json, a TOML role in .codex/agents, append only
{
  const cx = require(path.join(PH, "templates", "hooks", "proteus-harness-codex.js"));
  const CP = path.join(W, "cxapp");
  fs.mkdirSync(path.join(CP, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(CP, ".codex", "proteus-agents.json"), JSON.stringify({ "proteus-guide": { model: "o3" } }));
  let x = MOD.apply(CP, PH, cx);
  ok("codex: model is refused, naming Codex and the entry", /"proteus-guide"\.model: Codex roles take no model/.test(x.error || ""), JSON.stringify(x));
  fs.writeFileSync(path.join(CP, ".codex", "proteus-agents.json"), JSON.stringify({ "proteus-guide": { append: "Codex extra." } }));
  x = MOD.apply(CP, PH, cx);
  const t = read(path.join(CP, ".codex", "agents", "proteus-guide.toml")) || "";
  ok("codex: append lands in a marked TOML role", !x.error && t.startsWith(MOD.MARK) && t.split("\n").filter((l) => l.startsWith("# generated by proteus")).length === 1 &&
    /developer_instructions = ".*Codex extra\."/.test(t) && x.written[0] === ".codex/agents/proteus-guide.toml", JSON.stringify(x) + t.slice(0, 300));
  fs.writeFileSync(path.join(CP, ".codex", "proteus-agents.json"), "{}");
  x = MOD.apply(CP, PH, cx);
  ok("codex: removed with its entry", !x.error && !fs.existsSync(path.join(CP, ".codex", "agents", "proteus-guide.toml")), JSON.stringify(x));
}

lib.summary();

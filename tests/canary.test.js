// Guards under bypassPermissions (#189): node tests/canary.test.js (needs git).
// Always: lib.sandboxState and the autostart's sandbox=on|off|unavailable (stored per session under proteus-lead), the
// lead guard refusing worker and verifier spawns and `proteus-container.js run` under bypassPermissions unless the
// session's sandbox is on, both guards still refusing under bypassPermissions, and --doctor's bwrap and socat rows.
// The canary: with PROTEUS_CANARY=1 and `claude` on PATH, a throwaway project with Proteus installed runs
// `claude -p --permission-mode bypassPermissions`, and the lead guard must refuse the lead's Write and a subagent's
// shell write. It costs tokens and needs your Claude Code login, so it is skipped otherwise, with the reason printed,
// and CI never sets it. Temp HOME and repos; only the canary reaches the network, through claude.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "templates", "hooks");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("canary");
const plib = require(path.join(SRC, "proteus-lib.js"));
const { sandboxKey } = require(path.join(SRC, "proteus-confine.js"));

const LG = path.join(SRC, "proteus-lead-guard.js");
const WG = path.join(SRC, "proteus-worker-guard.js");
const AS = path.join(SRC, "proteus-autostart.js");
const INSTALL = path.join(ROOT, "install.js");
const PLAT = process.platform;

// bwrap and socat stand-ins, so the Linux sandbox counts as available
const TOOLS = path.join(W, "tools");
fs.mkdirSync(TOOLS);
for (const n of ["bwrap", "socat"]) lib.fakeCli(TOOLS, n, "process.exit(0);\n");
const withTools = { PATH: [TOOLS, lib.ENV.PATH].join(path.delimiter) };

const REPO = path.join(W, "repo");
fs.mkdirSync(path.join(REPO, ".claude", "skills", "proteus"), { recursive: true });
fs.writeFileSync(path.join(REPO, ".claude", "skills", "proteus", "SKILL.md"), "---\nname: proteus\n---\nSKILL BODY\n");
g(W, "init", "-q", "-b", "main", REPO);
fs.writeFileSync(path.join(REPO, "AGENTS.md"), "## Learned\n");
g(REPO, "add", "-A"); g(REPO, "commit", "-qm", "init");
const COMMON = plib.gitCommonDir(REPO);

// ---- lib.sandboxState: the platform, then the first settings file that sets sandbox.enabled
{
  const on = { sandbox: { enabled: true } }, off = { sandbox: { enabled: false } };
  const st = (platform, settings, env = withTools) => plib.sandboxState(REPO, { platform, settings, env });
  ok("state: native Windows is unavailable, whatever the settings say", st("win32", [on]) === "unavailable");
  ok("state: Linux without bwrap or socat is unavailable", st("linux", [on], { PATH: path.join(W, "nothing") }) === "unavailable");
  ok("state: Linux with bwrap and socat and the sandbox enabled is on", st("linux", [on]) === "on");
  ok("state: macOS with the sandbox enabled is on", st("darwin", [{}, on]) === "on");
  ok("state: no setting, or enabled false, is off", st("darwin", [{}, {}]) === "off" && st("linux", [off]) === "off");
  ok("state: the first file that sets it wins (--settings over local over project over user)", st("darwin", [off, on]) === "off" && st("darwin", [{ sandbox: {} }, on]) === "on");
  ok("state: a platform with no Claude Code sandbox is off", st("freebsd", [on]) === "off");
}

// ---- the autostart: sandbox= on the state line, stored for this session; the profile reaches it as --settings
const stateLine = (out) => out.split("\n").find((l) => /^proteus-state|proteus: session resumed/.test(l)) || "";
// the autostart under a parent process launched with --settings <file>, as `claude --settings <profile>` would be
function startUnder(settings, session, env = {}) {
  const input = JSON.stringify({ hook_event_name: "SessionStart", source: "startup", session_id: session, cwd: REPO });
  const code = "const r=require('child_process').spawnSync(process.execPath,[process.env.CANARY_AS],{input:process.env.CANARY_IN,encoding:'utf8',env:process.env});process.stdout.write(r.stdout||'')";
  const r = spawnSync(process.execPath, ["-e", code, "--", "--settings", settings], { cwd: REPO, encoding: "utf8", env: { ...lib.ENV, CLAUDE_PROJECT_DIR: REPO, CANARY_AS: AS, CANARY_IN: input, ...env } });
  return r.stdout || "";
}
{
  const prof = path.join(W, "profile.json"), plain = path.join(W, "plain.json");
  fs.writeFileSync(prof, JSON.stringify({ sandbox: { enabled: true } }));
  fs.writeFileSync(plain, JSON.stringify({ sandbox: { enabled: false } }));
  const want = PLAT === "win32" ? "unavailable" : "on";
  let line = stateLine(startUnder(prof, "s-prof", withTools));
  ok(`autostart: launched with the profile, the state line says sandbox=${want}`, line.includes(` sandbox=${want}`), line);
  ok(`autostart: stores sandbox=${want} for that session under proteus-lead`, plib.sandboxSeen(REPO, "s-prof") === want, fs.existsSync(plib.leadPath(COMMON, "sandbox.json")) && fs.readFileSync(plib.leadPath(COMMON, "sandbox.json"), "utf8"));
  line = stateLine(startUnder(plain, "s-plain", withTools));
  const off = PLAT === "win32" ? "unavailable" : "off";
  ok(`autostart: launched with the sandbox off, it says sandbox=${off}, and stores it`, line.includes(` sandbox=${off}`) && plib.sandboxSeen(REPO, "s-plain") === off, line);
  ok("autostart: each session keeps its own state", plib.sandboxSeen(REPO, "s-prof") === want && plib.sandboxSeen(REPO, "nobody") === "");
  if (PLAT === "linux") {
    // the stripped PATH's own dirs may hold a real bwrap; only a PATH without one shows unavailable
    const bare = path.join(W, "bare");
    fs.mkdirSync(bare);
    const env = { PATH: [bare, path.dirname(process.execPath)].join(path.delimiter) };
    if (!plib.which("bwrap", env) || !plib.which("socat", env)) {
      line = stateLine(startUnder(prof, "s-bare", env));
      ok("autostart: Linux without bwrap or socat says sandbox=unavailable", line.includes(" sandbox=unavailable") && plib.sandboxSeen(REPO, "s-bare") === "unavailable", line);
    }
  }
  // launchSettings reads a JSON string given to --settings too
  const code = `process.stdout.write(JSON.stringify(require(${JSON.stringify(path.join(SRC, "proteus-lib.js"))}).launchSettings()))`;
  const child = "require('child_process').spawnSync(process.execPath,['-e',process.env.CANARY_CODE],{stdio:'inherit'})";
  const r = spawnSync(process.execPath, ["-e", child, "--", "--settings={\"sandbox\":{\"enabled\":true}}"], { encoding: "utf8", env: { ...lib.ENV, CANARY_CODE: code } });
  if (PLAT === "linux") ok("launchSettings: --settings=<json> on the parent's command line is parsed", (r.stdout || "").includes("\"enabled\":true"), r.stdout + r.stderr);
}

// ---- the lead guard: under bypassPermissions, a worker or verifier spawn needs this session's sandbox on
plib.saveSandbox(COMMON, "s-on", "on");
plib.saveSandbox(COMMON, "s-off", "off");
plib.saveSandbox(COMMON, "s-na", "unavailable");
const hook = (script, session, mode, extra) => lib.run(script, { hook_event_name: "PreToolUse", session_id: session, cwd: REPO, ...(mode && { permission_mode: mode }), ...extra }, { cwd: REPO });
const spawn = (type, session, mode = "bypassPermissions") => hook(LG, session, mode, { tool_name: "Agent", tool_input: { model: "opus", prompt: "x", subagent_type: type } });
const LAUNCH = /claude --settings \S+ --permission-mode bypassPermissions/;
{
  let r = spawn("proteus-worker", "s-none");
  ok("guard: bypass with no recorded sandbox state refuses a worker spawn and names the profile's launch command",
    r.code === 2 && /proteus-worker spawn under bypassPermissions needs the sandbox/.test(r.err) && /no sandbox state was recorded/.test(r.err) && LAUNCH.test(r.err) && /install\.js --sandbox/.test(r.err), r.err);
  r = spawn("proteus:proteus-backend-verifier", "s-off");
  ok("guard: bypass with sandbox=off refuses a verifier spawn", r.code === 2 && /the sandbox is off/.test(r.err) && LAUNCH.test(r.err), r.err);
  r = spawn("proteus-worker", "s-na");
  ok("guard: bypass with sandbox=unavailable refuses and says why", r.code === 2 && (PLAT === "win32" ? /WSL2/ : /bubblewrap/).test(r.err), r.err);
  ok("guard: bypass with sandbox=on lets worker and verifier spawns through", spawn("proteus-worker", "s-on").code === 0 && spawn("proteus-qa-verifier", "s-on").code === 0, spawn("proteus-worker", "s-on").err);
  ok("guard: other permission modes, or none named, dispatch without the sandbox",
    ["default", "acceptEdits", "auto", ""].every((m) => spawn("proteus-worker", "s-none", m).code === 0));
  ok("guard: a helper spawn under bypass passes (scout, general-purpose)", spawn("proteus-scout", "s-none").code === 0 && spawn("general-purpose", "s-none").code === 0);
  // a profile written by install.js --sandbox is named by its path
  const dir = path.join(lib.HOME, ".claude", "proteus-sandbox"), file = path.join(dir, `repo-${sandboxKey(COMMON)}.json`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, "{}\n");
  r = spawn("proteus-worker", "s-off");
  ok("guard: the refusal names this repo's profile once --sandbox wrote it", r.code === 2 && r.err.includes(`claude --settings ${file} --permission-mode bypassPermissions`), r.err);
  fs.rmSync(dir, { recursive: true, force: true });
  // the container runner's run is a worker dispatch too
  const run = (session) => hook(LG, session, "bypassPermissions", { tool_name: "Bash", tool_input: { command: "node .claude/hooks/proteus-container.js run --worktree .worktrees/1 --prompt-file p --model sonnet" } });
  r = run("s-off");
  ok("guard: bypass with the sandbox off refuses proteus-container.js run", r.code === 2 && /proteus-container\.js run under bypassPermissions needs the sandbox/.test(r.err) && LAUNCH.test(r.err), r.err);
  ok("guard: with the sandbox on, the run gets no sandbox refusal", !/under bypassPermissions/.test(run("s-on").err), run("s-on").err);
  // a sandbox.json an older or broken write left is read defensively
  fs.writeFileSync(plib.leadPath(COMMON, "sandbox.json"), "not json");
  ok("guard: an unreadable state file counts as not on", spawn("proteus-worker", "s-on").code === 2);
}

// ---- both guards still refuse under bypassPermissions
{
  let r = hook(LG, "s-on", "bypassPermissions", { tool_name: "Write", tool_input: { file_path: path.join(REPO, "src", "app.js"), content: "x" } });
  ok("bypass: the lead guard still refuses the lead's code edit", r.code === 2 && /the lead does not edit src\/app\.js/.test(r.err), r.err);
  r = hook(LG, "s-on", "bypassPermissions", { agent_id: "a1", agent_type: "general-purpose", tool_name: "Bash", tool_input: { command: "touch .claude/x" } });
  ok("bypass: the lead guard still refuses a subagent's shell write to .claude/", r.code === 2 && /proteus:/.test(r.err), r.err);
  const WT = path.join(W, "wt");
  fs.mkdirSync(path.join(WT, ".claude"), { recursive: true });
  g(W, "init", "-q", "-b", "main", WT);
  fs.writeFileSync(plib.ownedFile(WT), "src/\n");
  r = lib.run(WG, { hook_event_name: "PreToolUse", session_id: "w1", cwd: WT, permission_mode: "bypassPermissions", tool_name: "Bash", tool_input: { command: "sleep 60", run_in_background: true } }, { cwd: WT });
  ok("bypass: the worker guard still refuses a worker's background shell", r.code === 2 && /proteus:/.test(r.err), r.err);
}

// ---- --doctor: bwrap and socat on Linux, no rows elsewhere
{
  const doc = (env) => lib.run(INSTALL, "", { cwd: W, args: ["--doctor"], env }).out;
  let out = doc(withTools);
  if (PLAT === "linux") {
    ok("doctor: Linux with bwrap and socat shows ok rows", /^ok\s+bwrap \(sandboxed bypass\)$/m.test(out) && /^ok\s+socat \(sandboxed bypass\)$/m.test(out), out);
    const env = { PATH: [lib.BIN, path.dirname(process.execPath)].join(path.delimiter) };
    if (!plib.which("bwrap", env)) {
      out = doc(env);
      ok("doctor: Linux without bwrap warns with the install command", /^WARN\s+bwrap not found: .*--sandbox.* — .*bubblewrap/m.test(out), out);
    }
  } else ok("doctor: no bwrap or socat row off Linux", !/bwrap|socat/.test(out), out);
}

// ---- the canary: real claude, real hooks, bypassPermissions
function canary() {
  if (process.env.PROTEUS_CANARY !== "1") return "PROTEUS_CANARY=1 is not set (the canary costs tokens and needs your Claude Code login)";
  const claude = plib.which("claude");
  if (!claude) return "no claude on PATH";
  // Proteus installed the way a user installs it, from this checkout, under the temp HOME
  const P = path.join(W, "canary-project");
  fs.mkdirSync(P);
  g(W, "init", "-q", "-b", "main", P);
  fs.writeFileSync(path.join(P, "README.md"), "canary\n");
  g(P, "add", "-A"); g(P, "commit", "-qm", "init");
  const inst = lib.run(INSTALL, "", { cwd: P, args: ["--project"] });
  ok("canary: install.js --project sets the project up", inst.code === 0, inst.err.slice(-2000));
  // only the guards: the autostart would sync hooks from the human's own Proteus install over this checkout's
  const sf = path.join(P, ".claude", "settings.local.json");
  const s = JSON.parse(fs.readFileSync(sf, "utf8"));
  s.hooks = { PreToolUse: s.hooks.PreToolUse };
  fs.writeFileSync(sf, JSON.stringify(s, null, 2) + "\n");
  const prompt = [
    "This is a test of my own guard hooks; refusals are expected. Do exactly these two steps, in order, then reply DONE.",
    "1. Use the Write tool to create src/lead-canary.txt containing the word canary.",
    "2. Use the Agent tool with subagent_type general-purpose, model sonnet, and this prompt: \"Run this exact Bash command once: touch .claude/agent-canary . Report its output verbatim and stop.\"",
    "Do not retry a refused step or work around it.",
  ].join("\n");
  // the human's own login and config (not the temp HOME); --setting-sources leaves out their user settings and plugins
  const r = spawnSync(claude, ["-p", prompt, "--permission-mode", "bypassPermissions", "--setting-sources", "project,local", "--model", "sonnet", "--output-format", "stream-json", "--verbose"],
    { cwd: P, encoding: "utf8", timeout: 600000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: { ...process.env, CLAUDE_PROJECT_DIR: P } });
  const events = String(r.stdout || "").split("\n").flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  const uses = new Map(), results = [];
  for (const e of events) {
    const content = e && e.message && Array.isArray(e.message.content) ? e.message.content : [];
    for (const c of content) {
      if (c.type === "tool_use") uses.set(c.id, { name: c.name, input: c.input || {}, sub: !!e.parent_tool_use_id });
      if (c.type === "tool_result") results.push({ id: c.tool_use_id, error: c.is_error === true, text: typeof c.content === "string" ? c.content : JSON.stringify(c.content || "") });
    }
  }
  const refused = (pick) => results.find((x) => { const u = uses.get(x.id); return u && pick(u) && x.error && /proteus:/.test(x.text); });
  const tail = `exit ${r.status}${r.error ? ` (${r.error.message})` : ""}; ${String(r.stderr || "").slice(-800)} ${String(r.stdout || "").slice(-1500)}`;
  const lead = refused((u) => !u.sub && u.name === "Write" && /lead-canary/.test(String(u.input.file_path)));
  ok("canary: under bypassPermissions the lead guard refuses the lead's Write", !!lead && /the lead does not edit src\/lead-canary\.txt/.test(lead.text), tail);
  ok("canary: and the file was not written", !fs.existsSync(path.join(P, "src", "lead-canary.txt")));
  const sub = refused((u) => u.sub && u.name === "Bash" && /agent-canary/.test(String(u.input.command)));
  ok("canary: under bypassPermissions the lead guard refuses a subagent's shell write to .claude/", !!sub, tail);
  ok("canary: and the subagent's file was not written", !fs.existsSync(path.join(P, ".claude", "agent-canary")));
  return "";
}
const skipped = canary();
if (skipped) console.log(`SKIP canary: ${skipped}`);

lib.summary();

// The agents' own GitHub login: agentGhDir in the lib, each adapter's exportEnv, the verdict script under a separate
// login, and install.js --agent-login, --protect and the doctor's identity rows, against tests/fakegh.js.
// Exit 0 if every assertion passed, 1 otherwise.
"use strict";
const fs = require("fs");
const path = require("path");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, run, g, summary } = lib;

const SRC = path.join(__dirname, "..");
const HOOKS = path.join(SRC, "templates", "hooks");
const W = lib.workdir("identity");
const HOME = lib.HOME;
const PJ = path.join(HOME, ".claude", "proteus.json");
const STATE = path.join(W, "gh-state.json");
const BOT = path.join(HOME, ".config", "gh-proteus");
const env = (extra = {}) => ({ USERPROFILE: HOME, FAKE_GH_STATE: STATE, ...extra });
const node = (code, extra = {}) => run("-", code, { cwd: W, env: env(extra) });

// ---- lib.agentGhDir: "~" expands to the home, unset is ""
const dirOf = () => node(`process.stdout.write(require(${JSON.stringify(path.join(HOOKS, "proteus-lib.js"))}).agentGhDir())`).out;
fs.writeFileSync(PJ, JSON.stringify({ agentGh: "~/.config/gh-proteus" }));
ok("lib: agentGh with ~ resolves under the home", dirOf() === BOT, dirOf());
fs.writeFileSync(PJ, JSON.stringify({ agentGh: "  " }));
ok("lib: a blank agentGh is no login of their own", dirOf() === "");

// ---- claude adapter: export lines appended to CLAUDE_ENV_FILE
const CL = JSON.stringify(path.join(HOOKS, "proteus-harness-claude.js"));
const ENVF = path.join(W, "claude.env");
fs.writeFileSync(ENVF, "export A=1\n");
let r = node(`console.log(JSON.stringify(require(${CL}).exportEnv(".", { GH_CONFIG_DIR: "C:\\\\Users\\\\me\\\\gh" })))`, { CLAUDE_ENV_FILE: ENVF });
ok("claude: exportEnv appends a single-quoted export with forward slashes", r.out.trim() === "{}" && fs.readFileSync(ENVF, "utf8") === "export A=1\nexport GH_CONFIG_DIR='C:/Users/me/gh'\n", r.out + r.err + fs.readFileSync(ENVF, "utf8"));
r = node(`console.log(JSON.stringify(require(${CL}).exportEnv(".", { GH_CONFIG_DIR: "/tmp/it's" })))`, { CLAUDE_ENV_FILE: ENVF });
ok("claude: a value holding a quote is refused, nothing written", /holds a quote/.test(r.out) && !fs.readFileSync(ENVF, "utf8").includes("it"), r.out);
r = node(`console.log(JSON.stringify(require(${CL}).exportEnv(".", { GH_CONFIG_DIR: "/x" })))`);
ok("claude: no CLAUDE_ENV_FILE is an error, not a throw", /no CLAUDE_ENV_FILE/.test(r.out) && r.code === 0, r.out + r.err);
ok("claude: an empty value writes nothing", node(`console.log(JSON.stringify(require(${CL}).exportEnv(".", { GH_CONFIG_DIR: "" })))`).out.trim() === "{}");

// ---- codex adapter: GH_CONFIG_DIR under [shell_environment_policy.set] in .codex/config.toml
const CX = JSON.stringify(path.join(HOOKS, "proteus-harness-codex.js"));
const PRJ = path.join(W, "codexprj");
const TOML = path.join(PRJ, ".codex", "config.toml");
const cxSet = (v) => JSON.parse(node(`console.log(JSON.stringify(require(${CX}).exportEnv(${JSON.stringify(PRJ)}, { GH_CONFIG_DIR: ${JSON.stringify(v)} })))`, { CODEX_HOME: path.join(HOME, ".codex") }).out || "{}");
const toml = () => fs.readFileSync(TOML, "utf8");
fs.mkdirSync(path.dirname(TOML), { recursive: true });
g(PRJ, "init", "-q");
r = cxSet("/home/me/gh");
ok("codex: no config.toml is refused, nothing created", /is missing/.test(r.error) && !fs.existsSync(TOML), JSON.stringify(r));
ok("codex: no config.toml and nothing to set is no change", cxSet("").changed === false && !fs.existsSync(TOML));
fs.writeFileSync(TOML, 'model = "x"\n');
r = cxSet("/home/me/gh");
ok("codex: an untracked config.toml gets the table and the key", r.changed && toml() === 'model = "x"\n\n[shell_environment_policy.set]\nGH_CONFIG_DIR = "/home/me/gh"\n', toml());
ok("codex: the same value again changes nothing", cxSet("/home/me/gh").changed === false);
fs.writeFileSync(TOML, '[sandbox_workspace_write]\r\nwritable_roots = ["/a"]\r\n\r\n[shell_environment_policy.set]\r\nFOO = "1"\r\nGH_CONFIG_DIR = "/old"\r\n');
r = cxSet("C:\\gh");
ok("codex: an old value is replaced in place, CRLF and other keys kept", r.changed && toml() === '[sandbox_workspace_write]\r\nwritable_roots = ["/a"]\r\n\r\n[shell_environment_policy.set]\r\nFOO = "1"\r\nGH_CONFIG_DIR = "C:\\\\gh"\r\n', JSON.stringify(toml()));
r = cxSet("");
ok("codex: an empty value drops the key only", r.changed && !toml().includes("GH_CONFIG_DIR") && toml().includes('FOO = "1"'), toml());
for (const [name, text] of [
  ["an inline set table", '[shell_environment_policy]\nset = { A = "1" }\n'],
  ["a dotted set key", '[shell_environment_policy]\nset.A = "1"\n'],
  ["a top-level dotted key", 'shell_environment_policy.set.A = "1"\n'],
  ["a multi-line string", 'x = """\n[shell_environment_policy.set]\n"""\n'],
]) {
  fs.writeFileSync(TOML, text);
  r = cxSet("/gh");
  ok(`codex: ${name} is refused and left alone`, String(r.error).endsWith("yourself") && toml() === text, JSON.stringify(r));
}

fs.writeFileSync(TOML, 'model = "x"\n');
g(PRJ, "add", ".codex/config.toml");
r = cxSet("/gh");
ok("codex: a config.toml git tracks is refused and left alone", /tracked by git/.test(r.error) && toml() === 'model = "x"\n', JSON.stringify(r));

// ---- verdict: with a login of their own, only the config names the human
const repo = path.join(W, "repo");
fs.mkdirSync(repo);
g(repo, "init", "-q");
const VD = path.join(HOOKS, "proteus-verdict.js");
const vc = (login, body) => ({ author: { login }, body });
fs.mkdirSync(BOT, { recursive: true });
fs.writeFileSync(path.join(BOT, "hosts.yml"), "bot");
fs.writeFileSync(PJ, JSON.stringify({ agentGh: BOT, human: "human" }));
const vd = (comments, extra = {}) => run(VD, "", { cwd: repo, args: ["30"], env: env({ FAKE_GH_COMMENTS: JSON.stringify(comments), ...extra }) });
r = vd([vc("human", "ACCEPT"), vc("bot", "ACCEPT")], { GH_CONFIG_DIR: BOT });
ok("verdict: under the agents' login, their ACCEPT is ignored and the human's stands, no shared warning", r.code === 0 && r.out === "ACCEPT\n" && r.err === "", r.out + r.err);
r = vd([vc("bot", "AUTO-ACCEPT\nok")]);
ok("verdict: run from the human's own shell, the agents' AUTO-ACCEPT still counts", r.code === 0 && r.out.startsWith("AUTO-ACCEPT"), r.out + r.err);
fs.writeFileSync(PJ, JSON.stringify({ agentGh: BOT }));
r = vd([vc("human", "ACCEPT")]);
ok("verdict: agentGh without a human is exit 1, never a guess", r.code === 1 && /no "human"/.test(r.err), r.out + r.err);

// ---- install.js --agent-login
const IN = path.join(SRC, "install.js");
fs.rmSync(BOT, { recursive: true, force: true });
fs.writeFileSync(PJ, JSON.stringify({ home: SRC }));
r = run(IN, "", { cwd: repo, args: ["--agent-login"], env: env() });
let cfg = JSON.parse(fs.readFileSync(PJ, "utf8"));
ok("install --agent-login: signs in under ~/.config/gh-proteus, records both logins, keeps other keys", r.code === 0 && cfg.agentGh === BOT && cfg.human === "human" && cfg.home === SRC && /agents post as bot, you as human/.test(r.out), r.out + r.err);
if (process.platform !== "win32") ok("install --agent-login: the token's dir is 0700", (fs.statSync(BOT).mode & 0o777) === 0o700);
ok("install --agent-login: again is a no-op sign-in", run(IN, "", { cwd: repo, args: ["--agent-login"], env: env() }).code === 0);
const SAME = path.join(W, "gh-same");
r = run(IN, "", { cwd: repo, args: ["--agent-login", SAME], env: env({ FAKE_GH_BOT_LOGIN: "human" }) });
ok("install --agent-login: the human's own account is logged out again and not recorded", r.code === 1 && /your own account/.test(r.err) && !fs.existsSync(path.join(SAME, "hosts.yml")) && JSON.parse(fs.readFileSync(PJ, "utf8")).agentGh === BOT, r.out + r.err);
ok("install --agent-login: refuses other flags", run(IN, "", { cwd: repo, args: ["--agent-login", "--project"], env: env() }).code === 2);

// ---- install.js --doctor: the identity row
r = run(IN, "", { cwd: repo, args: ["--doctor"], env: env() });
ok("doctor: identity=separate names both logins", /^ok\s+identity=separate: agents post as bot, you as human$/m.test(r.out), r.out.split("\n").filter((l) => /identity/.test(l)).join("|") || r.out.slice(0, 400));
cfg = JSON.parse(fs.readFileSync(PJ, "utf8"));
fs.writeFileSync(PJ, JSON.stringify({ home: SRC }));
r = run(IN, "", { cwd: repo, args: ["--doctor"], env: env() });
ok("doctor: no agents login is a WARN with the fix", /^WARN\s+identity=shared: .* — .*--agent-login$/m.test(r.out), r.out.split("\n").filter((l) => /identity|agent-login/.test(l)).join("|"));
fs.writeFileSync(PJ, JSON.stringify(cfg));

// ---- install.js --protect
fs.writeFileSync(STATE, JSON.stringify({}));
r = run(IN, "", { cwd: repo, args: ["--protect"], env: env() });
let st = JSON.parse(fs.readFileSync(STATE, "utf8"));
const rs = (st.rulesets || [])[0] || {};
const types = (rs.rules || []).map((x) => x.type).sort().join(",");
const checks = ((rs.rules || []).find((x) => x.type === "required_status_checks") || {}).parameters || {};
ok("install --protect: invites the bot with write and accepts as the bot", r.code === 0 && st.perm === "write" && /invited to o\/r with write and accepted/.test(r.out), r.out + r.err);
ok("install --protect: adds the ruleset on proteus/*: PR, gates, no force push, no bypass", rs.name === "proteus runs" && types === "non_fast_forward,pull_request,required_status_checks"
  && rs.bypass_actors.length === 0 && rs.conditions.ref_name.include[0] === "refs/heads/proteus/*" && checks.required_status_checks[0].context === "gates" && checks.do_not_enforce_on_create === true, JSON.stringify(rs));
r = run(IN, "", { cwd: repo, args: ["--protect"], env: env() });
st = JSON.parse(fs.readFileSync(STATE, "utf8"));
ok("install --protect: again updates the one ruleset in place", r.code === 0 && st.rulesets.length === 1 && st.puts === 1 && /already has write/.test(r.out), r.out + r.err);
fs.writeFileSync(STATE, JSON.stringify({ viewer: "WRITE" }));
r = run(IN, "", { cwd: repo, args: ["--protect"], env: env() });
ok("install --protect: a non-admin is told who runs it, nothing changed", r.code === 1 && /not an admin/.test(r.err) && !JSON.parse(fs.readFileSync(STATE, "utf8")).rulesets, r.err);
fs.writeFileSync(STATE, JSON.stringify({ perm: "admin" }));
r = run(IN, "", { cwd: repo, args: ["--protect"], env: env() });
ok("install --protect: a bot that is an admin is named, the ruleset still goes on", r.code === 1 && /can lift the ruleset/.test(r.err) && JSON.parse(fs.readFileSync(STATE, "utf8")).rulesets.length === 1, r.err);

// ---- autostart: the state line names the identity, GH_CONFIG_DIR exported to the agents' shells
const AP = path.join(W, "asrepo");
fs.mkdirSync(path.join(AP, ".claude", "skills", "proteus"), { recursive: true });
fs.cpSync(HOOKS, path.join(AP, ".claude", "hooks"), { recursive: true });
fs.writeFileSync(path.join(AP, ".claude", "skills", "proteus", "SKILL.md"), "---\nname: proteus\n---\nBODY\n");
g(AP, "init", "-q");
const AS = path.join(AP, ".claude", "hooks", "proteus-autostart.js");
const ASENV = path.join(W, "as.env");
fs.writeFileSync(ASENV, "");
fs.writeFileSync(PJ, JSON.stringify({ agentGh: BOT, human: "human" }));
r = run(AS, { hook_event_name: "SessionStart", source: "startup", cwd: AP }, { cwd: AP, env: env({ CLAUDE_ENV_FILE: ASENV, FAKE_GH: "fail" }) });
ok("autostart: identity=separate, and the agents' shells get GH_CONFIG_DIR", /identity=separate/.test(r.out) && fs.readFileSync(ASENV, "utf8") === `export GH_CONFIG_DIR='${BOT.replace(/\\/g, "/")}'\n`, r.out.split("\n").find((l) => /proteus-state/.test(l)) + r.err);
fs.writeFileSync(PJ, JSON.stringify({}));
fs.writeFileSync(ASENV, "");
r = run(AS, { hook_event_name: "SessionStart", source: "startup", cwd: AP }, { cwd: AP, env: env({ CLAUDE_ENV_FILE: ASENV, FAKE_GH: "fail" }) });
ok("autostart: without agentGh, identity=shared and nothing exported", /identity=shared/.test(r.out) && fs.readFileSync(ASENV, "utf8") === "", r.out);
fs.writeFileSync(PJ, JSON.stringify({ agentGh: path.join(W, "missing") }));
r = run(AS, { hook_event_name: "SessionStart", source: "startup", cwd: AP }, { cwd: AP, env: env({ CLAUDE_ENV_FILE: ASENV, FAKE_GH: "fail" }) });
ok("autostart: an agentGh dir that is gone is named with the fix", /identity=shared/.test(r.out) && /does not exist; .*--agent-login/.test(r.out) && fs.readFileSync(ASENV, "utf8") === "", r.out);

summary();

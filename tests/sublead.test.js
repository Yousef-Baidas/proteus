// Sub-lead tests: node tests/sublead.test.js (needs git). proteus-sublead.js against a repo with a proteus/r1 run branch
// and a local bare origin: the depth check (by name and by record, refused at 3), start's checkout, branch, pushed ref,
// state and beat, the headless session's argv (budget, no credential, no bare mode) through a fake claude, its
// permission mode against the lead's as the lead guard recorded it (refused when unknown or not auto/bypass), the runtime
// bound, and pr's one PR into the parent run with the sub-run's owned records left out. No model or network call.
"use strict";
const fs = require("fs");
const path = require("path");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const SCRIPT = path.join(__dirname, "..", "templates", "hooks", "proteus-sublead.js");
const W = lib.workdir("sublead");
const slash = (p) => String(p).replace(/\\/g, "/");

const ORIGIN = path.join(W, "origin.git");
g(W, "init", "-q", "--bare", "-b", "main", ORIGIN);
const REPO = path.join(W, "repo");
g(W, "init", "-q", "-b", "main", REPO);
fs.writeFileSync(path.join(REPO, "a.txt"), "a\n");
g(REPO, "add", "-A");
g(REPO, "commit", "-qm", "init");
g(REPO, "checkout", "-q", "-b", "proteus/r1");
fs.mkdirSync(path.join(REPO, ".proteus", "owned"), { recursive: true });
fs.writeFileSync(path.join(REPO, ".proteus", "owned", "9"), "src/api/\nsrc/ui/\n");
g(REPO, "add", "-A");
g(REPO, "commit", "-qm", "records");
g(REPO, "checkout", "-q", "main");
g(REPO, "remote", "add", "origin", ORIGIN);
g(REPO, "push", "-q", "origin", "main", "proteus/r1");
const COMMON = path.join(REPO, ".git");
const SUBS = path.join(COMMON, "proteus", "subleads");
const BEAT = path.join(COMMON, "proteus-lead", "beats", "sublead-r1.9.json");
fs.mkdirSync(path.join(REPO, ".claude"), { recursive: true });
fs.writeFileSync(path.join(REPO, ".claude", "settings.local.json"), '{"hooks":{}}\n');

// the fake claude: logs argv, stdin, cwd and whether the beat was out while it ran; FAKE_MODE ok, budget or hang
const LOG = path.join(W, "claude.jsonl");
const FAKE = `
const fs = require("fs");
const input = fs.readFileSync(0, "utf8");
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: process.argv.slice(2), input, cwd: process.cwd(), beat: fs.existsSync(process.env.FAKE_BEAT) }) + "\\n");
const mode = process.env.FAKE_MODE || "ok";
console.log(JSON.stringify({ type: "system", subtype: "init" }));
if (mode === "hang") setInterval(() => {}, 1000);
else {
  console.log(JSON.stringify({ type: "result", subtype: mode === "budget" ? "error_max_budget_usd" : "success", is_error: mode === "budget", result: "working\\nDONE r1.9 PR#40", total_cost_usd: 1.5 }));
  process.exit(mode === "budget" ? 1 : 0);
}
`;
if (process.platform === "win32") {
  fs.writeFileSync(lib.fakeScript(lib.BIN, "claude"), FAKE);
  fs.writeFileSync(path.join(lib.BIN, "claude.cmd"), `@"${process.execPath}" "%~dp0claude.fake.js" %*\r\n`);
} else lib.fakeCli(lib.BIN, "claude", FAKE);

// the fake gh for pr: logs every call; pr list finds none, issue view answers the ticket, pr create prints a URL
const GHLOG = path.join(W, "gh.jsonl");
lib.fakeCli(lib.BIN, "gh", `
const a = process.argv.slice(2);
require("fs").appendFileSync(process.env.GH_LOG, JSON.stringify(a) + "\\n");
if (a[0] === "pr" && a[1] === "list") { process.stdout.write("[]"); process.exit(0); }
if (a[0] === "issue" && a[1] === "view") { process.stdout.write(JSON.stringify({ title: "ticket 9", body: "Owned: src/api/ src/ui/\\nTier: full" })); process.exit(0); }
if (a[0] === "pr" && a[1] === "create") { process.stdout.write("https://github.com/o/r/pull/41\\n"); process.exit(0); }
process.exit(1);
`);

const calls = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const ghCalls = () => (fs.existsSync(GHLOG) ? fs.readFileSync(GHLOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const go = (args, { cwd = REPO, env = {} } = {}) => lib.run(SCRIPT, "", { cwd, args, env: { FAKE_LOG: LOG, FAKE_BEAT: BEAT, GH_LOG: GHLOG, ...env } });
const Sub = require(SCRIPT);

// ---- depth, a code check
ok("depth: a run of its own is depth 1", Sub.depthOf(COMMON, "r1") === 1);
ok("depth: each .<ticket> suffix is one level more", Sub.depthOf(COMMON, "r1.9") === 2 && Sub.depthOf(COMMON, "r1.9.12") === 3);
fs.mkdirSync(SUBS, { recursive: true });
fs.writeFileSync(path.join(SUBS, "deep.json"), JSON.stringify({ depth: 3 }));
ok("depth: the recorded depth raises the name's count", Sub.depthOf(COMMON, "deep") === 3);
fs.writeFileSync(path.join(SUBS, "r1.9.12.json"), JSON.stringify({ depth: 1 }));
ok("depth: a record can never lower the name's count", Sub.depthOf(COMMON, "r1.9.12") === 3);
ok("depth: refusal names the limit at depth 3 and nothing below", /depth 3, the limit of 3/.test(Sub.refusal(COMMON, "r1.9.12")) && Sub.refusal(COMMON, "r1.9") === "");
ok("depth: no start command offered at depth 3", Sub.startCmd(COMMON, "r1.9.12", 4) === "" && Sub.startCmd(COMMON, "r1.9", 4).endsWith("start 4 r1.9 --budget <usd>"));
let r = go(["start", "4", "r1.9.12", "--budget", "2"]);
ok("depth: start refuses a sub-lead below depth 3, exit 1, no session", r.code === 1 && /^SUBLEAD refused: run r1\.9\.12 is at depth 3/m.test(r.out) && !calls().length, r.out + r.err);
r = go(["start", "4", "deep", "--budget", "2"]);
ok("depth: start refuses by the recorded depth too", r.code === 1 && /SUBLEAD refused: run deep is at depth 3/.test(r.out) && !calls().length, r.out + r.err);
r = go(["depth", "r1.9.12"]);
ok("depth: the depth command prints the depth, exit 1 at the limit", r.code === 1 && r.out.trim() === "depth 3 of 3", r.out + r.err);
fs.rmSync(SUBS, { recursive: true });

// ---- usage
for (const [name, args] of [["no budget", ["start", "9", "r1"]], ["zero budget", ["start", "9", "r1", "--budget", "0"]], ["budget not a number", ["start", "9", "r1", "--budget", "lots"]],
  ["no ticket", ["start", "--budget", "1"]], ["minutes past the cap", ["start", "9", "r1", "--budget", "1", "--minutes", "5000"]], ["unknown flag", ["start", "9", "r1", "--budget", "1", "--yolo"]],
  ["bad model", ["start", "9", "r1", "--budget", "1", "--model", "a b"]], ["unknown command", ["go"]]]) {
  r = go(args);
  ok(`usage: ${name} exits 2, no session`, r.code === 2 && !calls().length, r.out + r.err);
}

// ---- the permission mode: never more permissive than the lead's, as the lead guard recorded it
const PROFILE = "/p/profile.json";
const LIST = ["default", "acceptEdits", "plan", "dontAsk", "", "bogus"];
ok("mode: lead on bypassPermissions with the sandbox profile gets that profile and bypassPermissions",
  JSON.stringify(Sub.permArgs("bypassPermissions", PROFILE)) === JSON.stringify(["--settings", PROFILE, "--permission-mode", "bypassPermissions"]));
ok("mode: lead on auto gets auto, with or without a profile, never bypass", [PROFILE, ""].every((p) => JSON.stringify(Sub.permArgs("auto", p)) === JSON.stringify(["--permission-mode", "auto"])));
ok("mode: lead on bypassPermissions without a profile is refused", typeof Sub.permArgs("bypassPermissions", "") === "string");
ok("mode: any other or unknown mode is refused, profile or not", LIST.every((m) => [PROFILE, ""].every((p) => typeof Sub.permArgs(m, p) === "string")));
const HL = require(path.join(__dirname, "..", "templates", "hooks", "proteus-lib.js"));
const LG = path.join(__dirname, "..", "templates", "hooks", "proteus-lead-guard.js");
const leadCall = (mode, cwd = REPO) => lib.run(LG, { hook_event_name: "PreToolUse", session_id: "s-lead", cwd, permission_mode: mode, tool_name: "Bash",
  tool_input: { command: `node ${SCRIPT} start 9 r1 --budget 1` } }, { cwd });
r = go(["start", "9", "r1", "--budget", "1"]);
ok("mode: no recorded mode, start refuses, exit 1, no session, no checkout",
  r.code === 1 && /^SUBLEAD refused: the lead's permission mode is unknown; a headless sub-lead cannot answer permission prompts/m.test(r.out) && !calls().length && !fs.existsSync(path.join(REPO, ".worktrees")), r.out + r.err);
fs.mkdirSync(path.join(COMMON, "proteus"), { recursive: true });
fs.writeFileSync(path.join(COMMON, "proteus", "lead-mode.json"), JSON.stringify({ [fs.realpathSync.native(REPO)]: { mode: "auto", at: Date.now() } }));
r = go(["start", "9", "r1", "--budget", "1"]);
ok("mode: a record where agents can write is never read, start refuses", r.code === 1 && /unknown/.test(r.out) && !calls().length, r.out + r.err);
for (const m of ["default", "acceptEdits", "plan"]) {
  const lg = leadCall(m);
  r = go(["start", "9", "r1", "--budget", "1"]);
  ok(`mode: lead on ${m}, start refuses, exit 1, no session`, lg.code === 0 && r.code === 1 && new RegExp(`permission mode is ${m};`).test(r.out) && !calls().length, r.out + r.err + lg.err);
}
HL.saveLeadMode(COMMON, REPO, "auto", Date.now() - 600e3);
ok("mode: a record older than 5 minutes is not read", HL.leadModeSeen(COMMON, REPO) === "");
const OTHER = path.join(W, "other");
g(W, "init", "-q", "-b", "main", OTHER);
HL.saveLeadMode(COMMON, OTHER, "bypassPermissions");
ok("mode: a record is per checkout", HL.leadModeSeen(COMMON, REPO) === "" && HL.leadModeSeen(COMMON, OTHER) === "bypassPermissions");
let lg = leadCall("auto");
ok("mode: the lead guard stores the lead's mode for its checkout, under proteus-lead", lg.code === 0 && HL.leadModeSeen(COMMON, REPO) === "auto" && HL.leadModeSeen(COMMON, path.join(REPO, "a.txt")) === "auto", lg.err);

// ---- start
r = go(["start", "9", "r1", "--budget", "3.5", "--model", "claude-test-1"], { env: { SECRET_TOKEN: "s3cr3t-value" } });
const CO = path.join(REPO, ".worktrees", "r1.9");
const c = calls()[0] || { argv: [], input: "" };
ok("start: exit 0 with the started and done lines", r.code === 0 && /^SUBLEAD r1\.9 started depth=2 branch=proteus\/r1\.9 /m.test(r.out) && /^SUBLEAD r1\.9 done \$1\.50: DONE r1\.9 PR#40$/m.test(r.out), r.out + r.err);
ok("start: the sub-run's checkout is on its own branch, cut from the parent run's tip", g(CO, "rev-parse", "--abbrev-ref", "HEAD") === "proteus/r1.9" && g(CO, "rev-parse", "HEAD") === g(REPO, "rev-parse", "proteus/r1"), r.out);
ok("start: the sub-run branch is pushed to origin", g(ORIGIN, "rev-parse", "refs/heads/proteus/r1.9") === g(REPO, "rev-parse", "proteus/r1"));
const st = JSON.parse(fs.readFileSync(path.join(SUBS, "r1.9.json"), "utf8"));
ok("start: the state records the depth, parent, ticket and caps", st.depth === 2 && st.parent === "r1" && st.ticket === 9 && st.budget === 3.5 && st.minutes === 240 && st.ok === true && st.costUsd === 1.5, JSON.stringify(st));
ok("start: the recorded depth is what depthOf reads", Sub.depthOf(COMMON, "r1.9") === 2);
ok("start: the lead's settings are copied into the checkout", fs.readFileSync(path.join(CO, ".claude", "settings.local.json"), "utf8") === '{"hooks":{}}\n');
ok("start: claude runs headless in the checkout", calls().length === 1 && c.argv[0] === "-p" && slash(fs.realpathSync(c.cwd)) === slash(fs.realpathSync(CO)), JSON.stringify(c));
const flag = (f) => { const i = c.argv.indexOf(f); return i < 0 ? null : c.argv[i + 1]; };
ok("budget: the cap goes to --max-budget-usd", flag("--max-budget-usd") === "3.5", JSON.stringify(c.argv));
ok("start: --model is passed on", flag("--model") === "claude-test-1", JSON.stringify(c.argv));
ok("start: stream-json output, auto permission mode without a sandbox profile", flag("--output-format") === "stream-json" && c.argv.includes("--verbose") && flag("--permission-mode") === "auto", JSON.stringify(c.argv));
ok("security: no credential, bare mode or permission skip on the command line", !c.argv.some((a) => /s3cr3t|token|key|--bare|dangerously/i.test(a)), JSON.stringify(c.argv));
ok("start: the prompt goes on stdin, naming the sub-run, the goal ticket and the pr step", /lead of Proteus run r1\.9/.test(c.input) && /ticket #9 of run r1/.test(c.input) && /proteus-sublead\.js pr r1\.9/.test(c.input) && /\$3\.5 of spend, 240 minutes/.test(c.input), c.input);
ok("watch: the beat is out while the session runs, then removed", c.beat === true && !fs.existsSync(BEAT), JSON.stringify(c));

// ---- a second start reuses the checkout; a budget stop is a failure
fs.rmSync(LOG, { force: true });
r = go(["start", "9", "r1", "--budget", "1"], { env: { FAKE_MODE: "budget" } });
ok("budget: a session stopped by its cap fails, exit 1", r.code === 1 && /^SUBLEAD r1\.9 failed: error_max_budget_usd/m.test(r.out) && calls().length === 1, r.out + r.err);

// ---- runtime bound
fs.rmSync(LOG, { force: true });
const t0 = Date.now();
r = go(["start", "9", "r1", "--budget", "1"], { env: { FAKE_MODE: "hang", PROTEUS_SUBLEAD_TIMEOUT_MS: "1500" } });
ok("runtime: a session past its minutes is stopped, exit 1", r.code === 1 && /^SUBLEAD r1\.9 failed: past its 240 minutes, stopped$/m.test(r.out) && Date.now() - t0 < 20000, r.out + r.err);
ok("runtime: the beat is removed after a stop", !fs.existsSync(BEAT));

// ---- the sandbox profile: used only when the lead itself runs bypassPermissions
const PROFILES = path.join(lib.HOME, ".claude", "proteus-sandbox");
fs.mkdirSync(PROFILES, { recursive: true });
const PROF = path.join(PROFILES, `repo-${require(path.join(__dirname, "..", "templates", "hooks", "proteus-confine.js")).sandboxKey(COMMON)}.json`);
fs.writeFileSync(PROF, '{"sandbox":{"enabled":true}}\n');
const argvOf = () => { const a = (calls()[0] || { argv: [] }).argv; const at = (f) => { const i = a.indexOf(f); return i < 0 ? null : a[i + 1]; }; return { a, at }; };
fs.rmSync(LOG, { force: true });
lg = leadCall("auto");
r = go(["start", "9", "r1", "--budget", "1"]);
let v = argvOf();
ok("mode: lead on auto with a sandbox profile present runs auto, never bypass or the profile",
  lg.code === 0 && r.code === 0 && v.at("--permission-mode") === "auto" && !v.a.includes("bypassPermissions") && !v.a.includes("--settings"), r.out + JSON.stringify(v.a));
fs.rmSync(LOG, { force: true });
lg = leadCall("bypassPermissions");
r = go(["start", "9", "r1", "--budget", "1"]);
v = argvOf();
ok("mode: lead on bypassPermissions with the profile runs that profile and bypassPermissions",
  lg.code === 0 && r.code === 0 && v.at("--permission-mode") === "bypassPermissions" && slash(v.at("--settings")) === slash(PROF), r.out + JSON.stringify(v.a));
fs.rmSync(LOG, { force: true });
lg = leadCall("default");
r = go(["start", "9", "r1", "--budget", "1"]);
ok("mode: lead on default with the profile present is refused, no session", lg.code === 0 && r.code === 1 && /permission mode is default;/.test(r.out) && !calls().length, r.out + r.err);
fs.rmSync(PROFILES, { recursive: true });
fs.rmSync(LOG, { force: true });
lg = leadCall("bypassPermissions");
r = go(["start", "9", "r1", "--budget", "1"]);
ok("mode: lead on bypassPermissions without the profile is refused, no session", lg.code === 0 && r.code === 1 && /without the repo's sandbox profile/.test(r.out) && !calls().length, r.out + r.err);

// ---- pr: the sub-run's result as one PR into the parent run
g(CO, "checkout", "-q", "proteus/r1.9");
fs.mkdirSync(path.join(CO, "src", "api"), { recursive: true });
fs.writeFileSync(path.join(CO, "src", "api", "x.js"), "x\n");
fs.writeFileSync(path.join(CO, ".proteus", "owned", "1"), "src/api/\n");
g(CO, "add", "-A");
g(CO, "commit", "-qm", "work and a sub-run record");
g(CO, "push", "-q", "origin", "proteus/r1.9");
r = go(["pr", "r1.9"], { cwd: CO });
const head = (() => { try { return g(ORIGIN, "rev-parse", "refs/heads/proteus-work/r1/9"); } catch { return ""; } })();
ok("pr: exit 0 with the PR line", r.code === 0 && r.out.trim() === "PR#41 https://github.com/o/r/pull/41", r.out + r.err);
ok("pr: the head is proteus-work/<parent>/<ticket>, the sub-run's tip plus one commit", !!head && g(ORIGIN, "rev-parse", `${head}^`) === g(ORIGIN, "rev-parse", "refs/heads/proteus/r1.9"), head);
const files = head ? g(ORIGIN, "ls-tree", "-r", "--name-only", head).split("\n") : [];
ok("pr: the sub-run's own record is left out, the parent's kept, the work kept", !files.includes(".proteus/owned/1") && files.includes(".proteus/owned/9") && files.includes("src/api/x.js"), files.join(" "));
const create = ghCalls().find((a) => a[0] === "pr" && a[1] === "create") || [];
const arg = (f) => create[create.indexOf(f) + 1];
ok("pr: into the parent run branch from the work branch", arg("--base") === "proteus/r1" && arg("--head") === "proteus-work/r1/9", JSON.stringify(create));
ok("pr: the body closes the ticket with the parent record's Owned: and the ticket's Tier:", (arg("--body") || "").startsWith("Closes #9\nOwned: src/api/ src/ui/\nTier: full\n"), arg("--body"));
r = go(["pr", "r1"]);
ok("pr: a run that is not a sub-run is refused, exit 2", r.code === 2 && /not a sub-run/.test(r.err), r.out + r.err);

lib.summary();

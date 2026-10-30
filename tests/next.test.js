// proteus-cli.js next tests: node tests/next.test.js (needs git). A repo with a proteus/r1 branch, the fake gh
// (FAKE_GH_NEXT) answering the tracker, and beat files and an inbox cache written into the lead's state dir. Each line
// kind for its case, their order, WAIT only when idle, the verifier line per head, a repeat call writing nothing, the
// exit codes and --json. Then what next executes: the worktree prep (made here, or a RUN line under a sandbox
// profile), and the merge batch against a real origin repo with FAKE_GH_MERGE merging there, with result pass|fail;
// every child it starts is logged (fixtures/spawn-log.js), so nothing sandboxed runs. No network.
"use strict";
const fs = require("fs");
const path = require("path");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const SCRIPT = path.join(__dirname, "..", "templates", "hooks", "proteus-cli.js");
const W = lib.workdir("next");

const REPO = path.join(W, "repo");
g(W, "init", "-q", "-b", "main", REPO);
fs.writeFileSync(path.join(REPO, "a.txt"), "a\n");
g(REPO, "add", "-A");
g(REPO, "commit", "-qm", "init");
g(REPO, "checkout", "-q", "-b", "proteus/r1");
// the lead's records of tickets 1-11 on the run branch, so these cases never need origin (whose URL is not reachable)
fs.mkdirSync(path.join(REPO, ".proteus", "owned"), { recursive: true });
for (let n = 1; n <= 11; n++) fs.writeFileSync(path.join(REPO, ".proteus", "owned", String(n)), `src/t${n}.js\n`);
g(REPO, "add", "-A");
g(REPO, "commit", "-qm", "records");
g(REPO, "checkout", "-q", "main");
g(REPO, "remote", "add", "origin", "https://github.com/o/r.git");
const COMMON = path.join(REPO, ".git");
const LEAD = path.join(COMMON, "proteus-lead");
const STATE = path.join(W, "gh.json");
const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
const SHA = (c) => c.repeat(40);

const ms = { title: "r1/core", number: 1 };
const issue = (n, o = {}) => ({ number: n, title: `ticket ${n}`, state: "OPEN", milestone: ms, labels: [{ name: "proteus" }, { name: "profile:backend" }, { name: "difficulty:standard" }], body: `Owned: src/t${n}.js`, ...o });
const VERDICT = { __typename: "StatusContext", context: "proteus/verdict", state: "SUCCESS" };
const CI = { __typename: "CheckRun", name: "gates", status: "COMPLETED", conclusion: "SUCCESS" };
const pr = (n, ticket, sha, checks) => ({ number: n, headRefName: `proteus-work/r1/${ticket}`, headRefOid: sha, body: `Closes #${ticket}`, isDraft: false, statusCheckRollup: checks });

// the busy case: #1 has a green PR (12), #2 a PR with no verdict (13), #3 ready, #4 waits on #3
const BUSY = {
  issues: [issue(1), issue(2), issue(3), issue(4, { body: "Owned: src/t4.js\nDepends on: #3" })],
  prs: [pr(12, 1, SHA("a"), [VERDICT, CI]), pr(13, 2, SHA("b"), [CI])],
  reviews: [],
  inbox: [{ number: 30, title: "which db?", labels: [{ name: "needs-human" }, { name: "proteus-question" }] }],
  statuses: { [SHA("a")]: [{ context: "proteus/verdict", state: "success", creator: { login: "verifier-app[bot]" } }] },
};
const IDLE = { issues: [issue(1, { state: "CLOSED" }), issue(4, { body: "Owned: src/t4.js\nDepends on: #3" })], prs: [], reviews: [], inbox: [] };

const next = (state, args = [], env = {}) => {
  fs.writeFileSync(STATE, JSON.stringify(state));
  return lib.run(SCRIPT, "", { cwd: REPO, args: ["next", ...args], env: { FAKE_GH_NEXT: STATE, ...env } });
};
const lines = (r) => r.out.trim().split("\n").filter(Boolean);
const kinds = (r) => lines(r).map((l) => (l.startsWith("SPAWN ") ? l.split(" ").slice(0, 2).join(" ") : l.split(" ")[0]));
const beat = (agent, rec) => {
  fs.mkdirSync(path.join(LEAD, "beats"), { recursive: true });
  fs.writeFileSync(path.join(LEAD, "beats", `${agent}.json`), JSON.stringify({ agent, type: "proteus-worker", spawn: ago(120), first: ago(120), cwd: "/w", ...rec }));
};
const clearBeats = () => fs.rmSync(path.join(LEAD, "beats"), { recursive: true, force: true });

// each line kind, in order
beat("w-stalled", { last: ago(60) });
beat("w-again", { last: ago(90), flagged: ago(30) });
beat("w-fine", { last: ago(1) });
let r = next(BUSY);
const L = lines(r);
ok("busy: exits 0", r.code === 0, r.err);
ok("busy: ASK names the needs-human issue's URL and title", L.includes("ASK https://github.com/o/r/issues/30 which db?"), r.out);
ok("busy: STOP for the agent still stalled after its STALL", L.some((l) => /^STOP w-again no tool call for 90m, cwd \/w$/.test(l)), r.out);
ok("busy: NUDGE for the newly stalled agent, none for the active one", L.some((l) => l.startsWith("NUDGE w-stalled no tool call for 60m")) && !r.out.includes("w-fine"), r.out);
ok("busy: MERGE for the green PR with its head, verdict and poster", L.includes(`MERGE PR#12 ${SHA("a").slice(0, 12)} verdict=success by=verifier-app[bot]`), r.out);
ok("busy: SPAWN verifier for the PR with no verdict, not for the green one", L.includes(`SPAWN verifier PR#13 #2 head=${SHA("b").slice(0, 12)} brief: node ${SCRIPT} brief verifier 13`) && !L.some((l) => l.startsWith("SPAWN verifier PR#12")), r.out);
ok("busy: SPAWN worker for the ready ticket only, with its worktree", L.includes(`SPAWN worker #3 team=backend difficulty=standard worktree=${path.join(REPO, ".worktrees", "3")} brief: node ${SCRIPT} brief worker 3`) && !L.some((l) => /^SPAWN worker #(1|2|4)\b/.test(l)), r.out);
ok("busy: BLOCKED for the ticket waiting on another", L.includes("BLOCKED #4 waits on #3"), r.out);
ok("busy: with no gate command, MERGE lines and DECIDE, nothing merged", L.includes("DECIDE suite: no gate command in ## Learned"), r.out);
ok("busy: the lines come in order ASK, STOP, NUDGE, MERGE, DECIDE, SPAWN verifier, SPAWN worker, BLOCKED, no WAIT",
  kinds(r).join() === "ASK,STOP,NUDGE,MERGE,DECIDE,SPAWN verifier,SPAWN worker,BLOCKED", kinds(r).join());

// the inbox cache, when there is one, is what ASK reads
fs.writeFileSync(path.join(LEAD, "inbox.json"), JSON.stringify({ at: ago(5), questions: [{ n: 31, title: "cached q" }], reviews: [{ n: 32, title: "review r1/core" }] }));
r = next(BUSY);
ok("inbox: ASK lines come from the cache, questions then reviews", lines(r).filter((l) => l.startsWith("ASK ")).join("|") === "ASK https://github.com/o/r/issues/31 cached q|ASK https://github.com/o/r/issues/32 review r1/core", r.out);
fs.rmSync(path.join(LEAD, "inbox.json"));

// WAIT only when nothing but BLOCKED is due
clearBeats();
r = next(IDLE);
ok("idle: BLOCKED then WAIT with the watchdog's command from this script's dir",
  r.code === 0 && lines(r).join("|") === `BLOCKED #4 waits on #3|WAIT node ${path.join(path.dirname(SCRIPT), "proteus-watchdog.js")} --wait`, r.out + r.err);
beat("w-stalled", { last: ago(60) });
r = next(IDLE);
ok("idle: a NUDGE is due, so no WAIT", kinds(r).join() === "NUDGE,BLOCKED", r.out);
clearBeats();
r = next({ ...IDLE, issues: [issue(1, { state: "CLOSED" })] });
ok("idle: nothing at all due prints WAIT alone", kinds(r).join() === "WAIT", r.out);

// a verifier spawn recorded for the head: not listed again; a new head: listed again. The record is the lead guard's,
// from a spawn whose prompt carries the tokens next printed
const TP = path.join(W, "lead.jsonl");
fs.writeFileSync(TP, JSON.stringify({ type: "assistant", message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "x" }], usage: { input_tokens: 1000 } } }) + "\n");
const spawn = (type, name, prompt) => lib.run(path.join(path.dirname(SCRIPT), "proteus-lead-guard.js"), { hook_event_name: "PreToolUse", session_id: "s1", cwd: REPO, transcript_path: TP, tool_name: "Agent", tool_input: { model: "opus", subagent_type: type, name, prompt } }, { cwd: REPO });
let s = spawn("proteus-verifier", "verify-13", `Review SPAWN verifier PR#13 #2 head=${SHA("b").slice(0, 12)} against its contract.`);
const rec = (name) => { try { return JSON.parse(fs.readFileSync(path.join(LEAD, "spawns", `spawn-${name}.json`), "utf8")); } catch { return null; } };
ok("verifier: the lead guard records the spawn's PR and head", s.code === 0 && rec("verify-13") && rec("verify-13").pr === 13 && rec("verify-13").head === SHA("b").slice(0, 12), JSON.stringify(rec("verify-13")) + s.err);
r = next(BUSY);
ok("verifier: a spawn recorded for the PR's head is not listed again", !lines(r).some((l) => l.startsWith("SPAWN verifier PR#13")), r.out);
r = next({ ...BUSY, prs: [BUSY.prs[0], pr(13, 2, SHA("c"), [CI])] });
ok("verifier: a new head on the same PR is listed again", lines(r).includes(`SPAWN verifier PR#13 #2 head=${SHA("c").slice(0, 12)} brief: node ${SCRIPT} brief verifier 13`), r.out);
fs.rmSync(path.join(LEAD, "spawns"), { recursive: true, force: true });
s = spawn("proteus-verifier", "verify-13b", "Review PR#13 against its contract.");
r = next(BUSY);
ok("verifier: a spawn without head= records neither field and matches nothing", s.code === 0 && rec("verify-13b") && !("pr" in rec("verify-13b")) && !("head" in rec("verify-13b")) && lines(r).some((l) => l.startsWith("SPAWN verifier PR#13")), JSON.stringify(rec("verify-13b")) + r.out);
fs.rmSync(path.join(LEAD, "spawns"), { recursive: true, force: true });

// the prompt's tokens, parsed only for a verifier's spawn
const { spawnTarget } = require(path.join(path.dirname(SCRIPT), "proteus-lib.js"));
const show = (x) => JSON.stringify(x);
ok("spawn tokens: both, the first of each", show(spawnTarget("proteus-verifier", "PR#13 #2 head=bbbbbbbbbbbb then PR#14 head=cccccccccccc")) === show({ pr: 13, head: "bbbbbbbbbbbb" }));
ok("spawn tokens: a team verifier counts", show(spawnTarget("proteus:proteus-backend-verifier", "PR#7 head=0123456789ab")) === show({ pr: 7, head: "0123456789ab" }));
ok("spawn tokens: PR# missing records neither", show(spawnTarget("proteus-verifier", "head=bbbbbbbbbbbb")) === "{}");
ok("spawn tokens: head= missing records neither", show(spawnTarget("proteus-verifier", "PR#13 #2")) === "{}");
ok("spawn tokens: a worker's spawn records neither", show(spawnTarget("proteus-worker", "PR#13 head=bbbbbbbbbbbb")) === "{}");
ok("spawn tokens: a malformed sha records neither (short, long, not hex)",
  ["head=bbbbbbbbbbb", `head=${SHA("b")}`, "head=bbbbbbbbbbbz", "head=BBBBBBBBBBBB"].every((h) => show(spawnTarget("proteus-verifier", `PR#13 ${h}`)) === "{}"));

// a repeat call with nothing new due: refs and the lead's state dir unchanged (the worktree #3 was prepared above)
beat("w-stalled", { last: ago(60) });
beat("w-again", { last: ago(90), flagged: ago(30) });
beat("w-old", { last: ago(2 * 24 * 60) });
fs.writeFileSync(path.join(LEAD, "inbox.json"), JSON.stringify({ at: ago(5), questions: [], reviews: [] }));
const snap = (d) => fs.readdirSync(d, { recursive: true }).sort().map((f) => { const st = fs.lstatSync(path.join(d, f)); return `${f}:${st.size}:${st.mtimeMs}:${st.isFile() ? fs.readFileSync(path.join(d, f), "utf8") : ""}`; }).join("\n");
const refs = () => g(REPO, "for-each-ref", "--format=%(refname) %(objectname)");
const before = { refs: refs(), lead: snap(LEAD), state: fs.existsSync(path.join(COMMON, "proteus")) ? snap(path.join(COMMON, "proteus")) : "" };
r = next(BUSY);
next(BUSY, ["--json"]);
next(IDLE);
ok("repeat: the run had something to say", r.code === 0 && lines(r).length > 3, r.out);
ok("repeat: no ref changed", refs() === before.refs);
ok("repeat: the lead's state dir is unchanged (no STALL flag, no old beat dropped, no inbox write)", snap(LEAD) === before.lead);
ok("repeat: <common>/proteus is unchanged", (fs.existsSync(path.join(COMMON, "proteus")) ? snap(path.join(COMMON, "proteus")) : "") === before.state);
fs.rmSync(path.join(LEAD, "inbox.json"));
clearBeats();

// exit codes
r = next(BUSY, [], { FAKE_GH: "fail" });
ok("exit 1 when the tracker cannot be read, nothing on stdout", r.code === 1 && !r.out.trim() && /tracker unreachable/.test(r.err), `${r.code} ${r.out} ${r.err}`);
const BARE = path.join(W, "bare");
g(W, "init", "-q", "-b", "main", BARE);
g(BARE, "commit", "-q", "--allow-empty", "-m", "init");
r = lib.run(SCRIPT, "", { cwd: BARE, args: ["next"], env: { FAKE_GH_NEXT: STATE } });
ok("exit 2 when there is no run", r.code === 2 && /no run named/.test(r.err), `${r.code} ${r.err}`);
r = next(BUSY, ["--bogus"]);
ok("exit 2 on an unknown argument", r.code === 2, `${r.code} ${r.err}`);
r = lib.run(SCRIPT, "", { cwd: REPO, args: ["later"] });
ok("exit 2 on an unknown command", r.code === 2 && /unknown command/.test(r.err), `${r.code} ${r.err}`);

// --json: the same actions as an array of { kind, ... }
beat("w-stalled", { last: ago(60) });
r = next(BUSY, ["--json"]);
let j = null;
try { j = JSON.parse(r.out); } catch {}
ok("json: an array of objects each with a kind", Array.isArray(j) && j.every((a) => a && typeof a.kind === "string"), r.out);
const find = (pred) => (j || []).find(pred) || {};
ok("json: ASK carries n, url and title", find((a) => a.kind === "ASK").url === "https://github.com/o/r/issues/30" && find((a) => a.kind === "ASK").title === "which db?");
ok("json: NUDGE carries agent and reason", find((a) => a.kind === "NUDGE").agent === "w-stalled" && /no tool call/.test(find((a) => a.kind === "NUDGE").reason));
const m = find((a) => a.kind === "MERGE");
ok("json: MERGE carries pr, the full head, verdict and by", m.pr === 12 && m.head === SHA("a") && m.verdict === "success" && m.by === "verifier-app[bot]", JSON.stringify(m));
const v = find((a) => a.kind === "SPAWN" && a.role === "verifier");
ok("json: SPAWN verifier carries pr, ticket and head", v.pr === 13 && v.ticket === 2 && v.head === SHA("b"), JSON.stringify(v));
const w = find((a) => a.kind === "SPAWN" && a.role === "worker");
ok("json: SPAWN worker carries ticket, team, difficulty, speculative", w.ticket === 3 && w.team === "backend" && w.difficulty === "standard" && w.speculative === false, JSON.stringify(w));
ok("json: BLOCKED carries ticket and reason", find((a) => a.kind === "BLOCKED").ticket === 4 && find((a) => a.kind === "BLOCKED").reason === "waits on #3");
ok("json: the same kinds in the same order as the lines", j && j.map((a) => (a.kind === "SPAWN" ? `SPAWN ${a.role}` : a.kind)).join() === kinds(next(BUSY)).join(), r.out);
clearBeats();
r = next(IDLE, ["--json"]);
try { j = JSON.parse(r.out); } catch { j = null; }
ok("json: WAIT carries the command", j && j[j.length - 1].kind === "WAIT" && j[j.length - 1].command.endsWith("proteus-watchdog.js --wait"), r.out);

// worktree prep: a ready ticket's worktree made with its owned list and the tier its Tier line names (#3 above got the
// default); a bad Tier line or a path in the way is BLOCKED prep, and the other tickets go on
const WT = (n) => path.join(REPO, ".worktrees", String(n));
const OWNED = (n) => require(path.join(path.dirname(SCRIPT), "proteus-lib.js")).ownedFile(WT(n));
const ownedText = (n) => { try { return fs.readFileSync(OWNED(n), "utf8"); } catch { return ""; } };
ok("prep: #3's worktree is on its worker branch", g(WT(3), "rev-parse", "--abbrev-ref", "HEAD") === "proteus-work/r1/3");
ok("prep: #3's owned list names src/t3.js at the default tier", /^# tier standard [0-9a-f]{40}$/m.test(ownedText(3)) && /^src\/t3\.js$/m.test(ownedText(3)), ownedText(3));
const PREP = { issues: [issue(5, { body: "Owned: src/t5.js\nTier: full" }), issue(6, { body: "Owned: src/t6.js\nTier: huge" }), issue(7, { body: "Owned: src/t7.js" })], prs: [], reviews: [], inbox: [] };
fs.mkdirSync(WT(7), { recursive: true });
fs.writeFileSync(path.join(WT(7), "x"), "in the way\n");
r = next(PREP);
ok("prep: #5's worktree has its Tier line's tier", /^# tier full [0-9a-f]{40}$/m.test(ownedText(5)) && /^src\/t5\.js$/m.test(ownedText(5)), ownedText(5));
ok("prep: SPAWN worker #5 names its worktree", lines(r).includes(`SPAWN worker #5 team=backend difficulty=standard worktree=${WT(5)} brief: node ${SCRIPT} brief worker 5`), r.out);
ok("prep: an unknown tier is BLOCKED prep, no worktree", lines(r).some((l) => /^BLOCKED #6 prep: Tier: huge is not one of direct, quick, standard, full$/.test(l)) && !fs.existsSync(WT(6)), r.out);
ok("prep: a dir in the way is BLOCKED prep", lines(r).some((l) => /^BLOCKED #7 prep: .*7 exists and is not a worktree on proteus-work\/r1\/7$/.test(l)), r.out);
ok("prep: no SPAWN worker for a ticket whose prep failed", !lines(r).some((l) => /^SPAWN worker #(6|7)\b/.test(l)), r.out);
const again = { refs: refs(), owned: ownedText(5) };
r = next(PREP);
ok("prep: a second call still lists SPAWN worker #5 with its worktree", lines(r).includes(`SPAWN worker #5 team=backend difficulty=standard worktree=${WT(5)} brief: node ${SCRIPT} brief worker 5`), r.out);
ok("prep: a second call changes no ref and no owned list", refs() === again.refs && ownedText(5) === again.owned);
// once its worker is spawned, the branch counts as in flight: no SPAWN worker again
spawn("proteus-backend-worker", "w5", "You are worker #5 of run r1.");
ok("prep: the worker's spawn record carries its ticket", rec("w5") && rec("w5").ticket === 5, show(rec("w5")));
r = next(PREP);
ok("prep: no SPAWN worker #5 once its worker is spawned", !lines(r).some((l) => l.startsWith("SPAWN worker #5")), r.out);
fs.rmSync(path.join(LEAD, "spawns", "spawn-w5.json"), { force: true });
// or once something is committed on its branch past the base, spawn record or not
fs.writeFileSync(path.join(WT(5), "t5.txt"), "work\n");
g(WT(5), "add", "-A");
g(WT(5), "-c", "core.hooksPath=/dev/null", "commit", "-qm", "work");
r = next(PREP);
ok("prep: no SPAWN worker #5 once its branch has a commit", !lines(r).some((l) => l.startsWith("SPAWN worker #5")), r.out);

// a slice ticket (teams.md) is Quick or Standard only: a slice: label on a hard or full one is DECIDE, no prep
const sliced = (n, d, extra = "") => issue(n, { labels: [{ name: "proteus" }, { name: "profile:backend" }, { name: `difficulty:${d}` }, { name: "slice:frontend,devops" }], body: `Owned: src/t${n}.js${extra}` });
r = next({ issues: [sliced(9, "hard"), sliced(10, "standard", "\nTier: full"), sliced(11, "standard")], prs: [], reviews: [], inbox: [] });
ok("slice: a hard slice ticket is DECIDE, no worktree, no SPAWN", lines(r).includes("DECIDE #9 slice: tier hard too large") && !fs.existsSync(WT(9)) && !lines(r).some((l) => l.startsWith("SPAWN worker #9")), r.out);
ok("slice: a full-tier slice ticket is DECIDE, no worktree, no SPAWN", lines(r).includes("DECIDE #10 slice: tier full too large") && !fs.existsSync(WT(10)) && !lines(r).some((l) => l.startsWith("SPAWN worker #10")), r.out);
ok("slice: a standard slice ticket is prepared and spawned", lines(r).includes(`SPAWN worker #11 team=backend difficulty=standard worktree=${WT(11)} brief: node ${SCRIPT} brief worker 11`), r.out);
ok("slice: the label parses to its teams", JSON.stringify(require(SCRIPT).sliceTeams(["profile:backend", "slice:frontend, devops", "slice:qa"])) === JSON.stringify(["frontend", "devops", "qa"]));

// under install.js --sandbox the prep runs in the sandbox: a RUN line with both steps and the copy, nothing made
const PROFILE = path.join(lib.HOME, ".claude", "proteus-sandbox", "bin", require(path.join(path.dirname(SCRIPT), "proteus-confine.js")).sandboxKey(COMMON), "proteus-worktree.js");
fs.mkdirSync(path.dirname(PROFILE), { recursive: true });
fs.writeFileSync(PROFILE, "process.exit(0);\n");
const PLOG = path.join(W, "profile-spawns.jsonl");
r = next({ ...PREP, issues: [issue(8, { body: "Owned: src/t8.js\nTier: quick" })] }, [], { SPAWN_LOG: PLOG, NODE_OPTIONS: [lib.ENV.NODE_OPTIONS, `--require "${path.join(__dirname, "fixtures", "spawn-log.js").replace(/\\/g, "/")}"`].filter(Boolean).join(" ") });
const pkids = fs.existsSync(PLOG) ? fs.readFileSync(PLOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
ok("profile: nothing of the prep runs (no proteus-worktree.js, no git worktree add)", !pkids.some((c) => /proteus-worktree\.js|\bworktree add\b/.test([c.file, ...(c.args || [])].join(" "))), JSON.stringify(pkids));
ok("profile: the log saw next's children", pkids.length > 0, pkids.length);
const runLine = lines(r).find((l) => l.startsWith("RUN ")) || "";
ok("profile: the prep is one RUN line: worktree add, proteus-worktree.js with the tier and owned list, then the copy",
  runLine.includes(`git worktree add -b 'proteus-work/r1/8' '${WT(8)}' `) && runLine.includes(`proteus-worktree.js' '${WT(8)}' --tier quick 'src/t8.js' && node '${PROFILE}' '${REPO}'`), r.out);
ok("profile: no worktree made and no SPAWN worker #8", !fs.existsSync(WT(8)) && !lines(r).some((l) => l.startsWith("SPAWN worker #8")), r.out);
fs.rmSync(PROFILE);

// the merge batch: proteus-merge.js's own batch against a real origin, the fake gh's NEXT and MERGE on one file. Every
// child proteus-cli.js starts is logged: nothing sandboxed (run-tree, the suite, the watchdog) ever runs
const HOOKS = path.dirname(SCRIPT);
const LOG = path.join(W, "spawns.jsonl");
const SHIM = `--require "${path.join(__dirname, "fixtures", "spawn-log.js").replace(/\\/g, "/")}"`;
const logged = { SPAWN_LOG: LOG, NODE_OPTIONS: [lib.ENV.NODE_OPTIONS, SHIM].filter(Boolean).join(" ") };
const put = (dir, files) => { for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), body); };
function batchRepo(name, tickets, gate = true) {
  const B = lib.workdir(name), origin = path.join(B, "origin.git"), root = path.join(B, "root");
  g(B, "init", "-q", "--bare", "-b", "main", origin);
  g(B, "clone", "-q", origin, root);
  put(root, { "suite.js": "process.exit(require(\"fs\").existsSync(\"bad\") ? 1 : 0);\n", "a.txt": "one\n", ...(gate && { "AGENTS.md": "# Agents\n\n## Learned\n\n- gate: `node suite.js`\n" }) });
  // each ticket's record on the run branch, so no record PR is due here
  fs.mkdirSync(path.join(root, ".proteus", "owned"), { recursive: true });
  for (const k of tickets) put(root, { [path.join(".proteus", "owned", String(k.t))]: `src/t${k.t}.js\n` });
  g(root, "add", "-A");
  g(root, "commit", "-q", "-m", "init");
  g(root, "push", "-q", "origin", "HEAD:main", "HEAD:proteus/r1");
  g(root, "fetch", "-q", "origin");
  g(root, "branch", "-q", "proteus/r1", "origin/proteus/r1");
  const statuses = {}, prs = [];
  for (const k of tickets) {
    const wt = path.join(root, ".worktrees", String(k.t));
    g(root, "worktree", "add", "-q", "-b", `proteus-work/r1/${k.t}`, wt, "origin/proteus/r1");
    put(wt, k.files);
    g(wt, "add", "-A");
    g(wt, "commit", "-q", "-m", `ticket ${k.t}`);
    g(wt, "push", "-q", "origin", `proteus-work/r1/${k.t}`);
    const head = g(wt, "rev-parse", "HEAD");
    statuses[head] = [{ context: "proteus/verdict", state: "success", creator: { login: "verifier-app[bot]" } }];
    prs.push({ later: k.later, number: k.pr, headRefName: `proteus-work/r1/${k.t}`, headRefOid: head, baseRefName: "proteus/r1", body: `Closes #${k.t}`, isDraft: false, statusCheckRollup: [VERDICT, CI] });
  }
  const state = path.join(B, "gh.json");
  fs.writeFileSync(state, JSON.stringify({ origin, issues: tickets.map((k) => issue(k.t)), prs: prs.filter((p) => !p.later), reviews: [], inbox: [], statuses }));
  const cli = (...args) => lib.run(SCRIPT, "", { cwd: root, args, env: { FAKE_GH_NEXT: state, FAKE_GH_MERGE: state, ...logged } });
  const tip = () => g(root, "--git-dir", origin, "rev-parse", "proteus/r1");
  return { root, cli, tip, prs, state, lead: path.join(root, ".git", "proteus-lead") };
}
const RUNL = /^RUN node \S*proteus-run-tree\.js ([0-9a-f]{40}), then in \.worktrees\/_run: node suite\.js$/;
const runSha = (r) => { for (const l of lines(r)) { const m = RUNL.exec(l); if (m) return m[1]; } return ""; };
// a PR made with later: true opens now
const open = (b, n) => { const s = JSON.parse(fs.readFileSync(b.state, "utf8")); s.prs.push(b.prs.find((p) => p.number === n)); fs.writeFileSync(b.state, JSON.stringify(s)); };
// the lead's sandboxed step: _run filled with sha's tree, the suite run there
const suite = (root, sha) => { lib.run(path.join(HOOKS, "proteus-run-tree.js"), "", { cwd: root, args: [sha] }); return lib.run(path.join(root, ".worktrees", "_run", "suite.js"), "", { cwd: path.join(root, ".worktrees", "_run") }).code === 0 ? "pass" : "fail"; };
const record = (lead, name, rec) => { fs.mkdirSync(path.join(lead, "spawns"), { recursive: true }); fs.writeFileSync(path.join(lead, "spawns", `spawn-${name}.json`), JSON.stringify({ name, at: new Date().toISOString(), ...rec })); };

let b = batchRepo("next-merge", [{ t: 5, pr: 50, files: { "b.txt": "five\n" } }, { t: 6, pr: 60, files: { "c.txt": "six\n" } }, { t: 7, pr: 70, files: { "d.txt": "seven\n" }, later: true }]);
r = b.cli("next");
ok("batch: one MERGED line per merged PR, with its head, verdict and verifier", lines(r).includes(`MERGED PR#50 ${b.prs[0].headRefOid.slice(0, 12)} verdict=success by=verifier-app[bot]`) && lines(r).includes(`MERGED PR#60 ${b.prs[1].headRefOid.slice(0, 12)} verdict=success by=verifier-app[bot]`), r.out);
let at = runSha(r);
ok("batch: then one RUN line naming the run branch's new tip and the gate command", at && at === b.tip(), r.out);
ok("batch: no MERGE line and no DECIDE", !lines(r).some((l) => /^(MERGE|DECIDE) /.test(l)), r.out);
ok("batch: no SPAWN worker for a merged ticket whose worktree is still there", !lines(r).some((l) => /^SPAWN worker #(5|6)\b/.test(l)), r.out);
open(b, 70);
r = b.cli("next");
ok("batch: while it waits, the same RUN line and no MERGE or MERGED for a new green PR", runSha(r) === at && !lines(r).some((l) => /^MERGED? /.test(l)) && b.tip() === at, r.out);
record(b.lead, "w5", { type: "proteus-backend-worker", ticket: 5 });
record(b.lead, "v50", { type: "proteus-backend-verifier", pr: 50, head: b.prs[0].headRefOid.slice(0, 12) });
record(b.lead, "w9", { type: "proteus-backend-worker", ticket: 9 });
record(b.lead, "w6", { type: "proteus-backend-worker", ticket: 6 });
// the merge state names PR 60 merged, gh does not: its agents are not stopped (the state is not what says it merged)
const gh = JSON.parse(fs.readFileSync(b.state, "utf8"));
gh.prs.find((p) => p.number === 60).merged = false;
fs.writeFileSync(b.state, JSON.stringify(gh));
r = b.cli("result", "pass", "--at", at);
ok("result pass: STOP the merged tickets' worker and verifier, not another's", lines(r).includes("STOP w5") && lines(r).includes("STOP v50") && !lines(r).includes("STOP w9"), r.out);
ok("result pass: no STOP for a PR gh does not report merged", !lines(r).includes("STOP w6"), r.out);
ok("result pass: the watchdog's --forget as a RUN line", lines(r).some((l) => /^RUN node \S*proteus-watchdog\.js --forget ('v50' 'w5'|'w5' 'v50')$/.test(l)), r.out);
ok("result pass: exit 0, the batch done", r.code === 0 && !fs.existsSync(path.join(b.root, ".git", "proteus", "merge", "r1.json")), `${r.code} ${r.out}`);

b = batchRepo("next-bisect", [{ t: 5, pr: 50, files: { "b.txt": "five\n" } }, { t: 6, pr: 60, files: { bad: "x\n" } }]);
r = b.cli("next");
at = runSha(r);
ok("bisect: the batch's RUN line", at === b.tip() && suite(b.root, at) === "fail", r.out);
r = b.cli("result", "fail", "--at", at);
const step = runSha(r);
ok("result fail: merge.js's bisect step as the next RUN line", step && step !== at && lines(r).filter((l) => l.startsWith("RUN ")).length === 1, r.out);
ok("result fail: no STOP line", !lines(r).some((l) => l.startsWith("STOP ")), r.out);
r = b.cli("next");
ok("bisect: next prints the step again and merges nothing", runSha(r) === step && !lines(r).some((l) => /^MERGED? /.test(l)), r.out);

b = batchRepo("next-nogate", [{ t: 5, pr: 50, files: { "b.txt": "five\n" } }], false);
const tip0 = b.tip();
r = b.cli("next");
ok("no gate: MERGE line and DECIDE suite, nothing merged", lines(r).some((l) => l.startsWith("MERGE PR#50 ")) && lines(r).includes("DECIDE suite: no gate command in ## Learned") && b.tip() === tip0 && !lines(r).some((l) => l.startsWith("MERGED ")), r.out);
r = b.cli("result", "pass", "--at", tip0);
ok("no gate: result prints DECIDE suite", lines(r).includes("DECIDE suite: no gate command in ## Learned"), r.out);
r = b.cli("result", "maybe", "--at", tip0);
ok("result: exit 2 on a verdict that is not pass or fail", r.code === 2 && /pass or fail/.test(r.err), `${r.code} ${r.err}`);
r = b.cli("result", "pass");
ok("result: exit 2 without --at", r.code === 2 && /--at/.test(r.err), `${r.code} ${r.err}`);

// the wave's owned-path records (#281): one commit and one PR for every open ticket with no record, made with git's
// objects alone against a real origin; one record PR at a time, add-only, BLOCKED until it merges
const RB = lib.workdir("next-records"), RO = path.join(RB, "origin.git"), RR = path.join(RB, "root"), RS = path.join(RB, "gh.json");
g(RB, "init", "-q", "--bare", "-b", "main", RO);
g(RB, "clone", "-q", RO, RR);
fs.mkdirSync(path.join(RR, ".proteus", "owned"), { recursive: true });
put(RR, { "a.txt": "one\n", [path.join(".proteus", "owned", "1")]: "src/t1.js\n" });
g(RR, "add", "-A");
g(RR, "commit", "-q", "-m", "init");
g(RR, "push", "-q", "origin", "HEAD:main", "HEAD:proteus/r1");
g(RR, "fetch", "-q", "origin");
g(RR, "branch", "-q", "proteus/r1", "origin/proteus/r1");
const og = (...args) => g(RB, "--git-dir", RO, ...args);
const RLOG = path.join(RB, "spawns.jsonl");
let rs = { origin: RO, issues: [issue(1, { state: "CLOSED" }), issue(2), issue(3, { body: "Owned: src/t3.js lib/**" })], prs: [], reviews: [], inbox: [] };
const rnext = (env = {}) => {
  fs.writeFileSync(RS, JSON.stringify(rs));
  const res = lib.run(SCRIPT, "", { cwd: RR, args: ["next"], env: { FAKE_GH_NEXT: RS, SPAWN_LOG: RLOG, NODE_OPTIONS: logged.NODE_OPTIONS, ...env } });
  rs = JSON.parse(fs.readFileSync(RS, "utf8"));
  return res;
};
const checkout = () => ({ head: fs.readFileSync(path.join(RR, ".git", "HEAD"), "utf8"), index: fs.readFileSync(path.join(RR, ".git", "index")).toString("base64"), status: g(RR, "status", "--porcelain"), refs: g(RR, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/tags") });
const before0 = checkout();
r = rnext();
const made = rs.created || [];
ok("records: one PR for every open ticket with no record, from owned-1 into the run branch", made.length === 1 && made[0].headRefName === "proteus-work/r1/owned-1" && made[0].baseRefName === "proteus/r1", JSON.stringify(made));
ok("records: its body says Tier: full and lists one line per ticket", made[0] && /^Tier: full$/m.test(made[0].body) && /^- #2 src\/t2\.js$/m.test(made[0].body) && /^- #3 src\/t3\.js lib\/\*\*$/m.test(made[0].body) && !/#1\b/.test(made[0].body), made[0] && made[0].body);
ok("records: the commit adds exactly the new records, cut from the run branch's tip",
  og("diff", "--name-status", "proteus/r1", "proteus-work/r1/owned-1") === "A\t.proteus/owned/2\nA\t.proteus/owned/3" && og("rev-parse", "proteus-work/r1/owned-1^") === og("rev-parse", "proteus/r1") && og("rev-list", "--count", "proteus/r1..proteus-work/r1/owned-1") === "1");
ok("records: each record is its ticket's Owned: line, one entry per line", og("show", "proteus-work/r1/owned-1:.proteus/owned/3") === "src/t3.js\nlib/**" && og("show", "proteus-work/r1/owned-1:.proteus/owned/2") === "src/t2.js");
ok("records: the commit message names the tickets", og("log", "-1", "--format=%B", "proteus-work/r1/owned-1") === "chore(proteus): record owned paths for #2, #3");
ok("records: the record PR gets the usual SPAWN verifier line", made[0] && lines(r).includes(`SPAWN verifier PR#100 #? head=${made[0].headRefOid.slice(0, 12)} brief: node ${SCRIPT} brief verifier 100`), r.out);
ok("records: its tickets are BLOCKED pending it, no SPAWN worker", lines(r).includes("BLOCKED #2 owned record pending PR#100") && lines(r).includes("BLOCKED #3 owned record pending PR#100") && !lines(r).some((l) => l.startsWith("SPAWN worker")), r.out);
ok("records: no worktree made, and the main checkout's HEAD, index, status and branches unchanged", !fs.existsSync(path.join(RR, ".worktrees")) && JSON.stringify(checkout()) === JSON.stringify(before0));
const rkids = fs.existsSync(RLOG) ? fs.readFileSync(RLOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const gitKid = (c) => [c.file, ...(c.args || [])].join(" ");
ok("records: no git call with a work tree, an index, a checkout or a worktree", rkids.length > 0 && !rkids.some((c) => c.workTree || c.index || /\b(checkout|switch|worktree|read-tree|update-index|add|commit) /.test(` ${(c.args || []).filter((x) => !x.startsWith("-") && !x.includes("=")).join(" ")} `.replace(/ commit-tree /, " "))), JSON.stringify(rkids.filter((c) => /checkout|worktree|index/.test(gitKid(c)))));
ok("records: one push, of that one ref", rkids.filter((c) => (c.args || []).includes("push")).length === 1 && rkids.some((c) => (c.args || []).includes("push") && c.args[c.args.length - 1] === `${made[0].headRefOid}:refs/heads/proteus-work/r1/owned-1`), JSON.stringify(rkids.filter((c) => (c.args || []).includes("push"))));

// a ticket added while the PR is open waits for the next batch; no second PR
rs.issues.push(issue(4));
r = rnext();
ok("records: no second PR while one is open", rs.created.length === 1 && og("for-each-ref", "--format=%(refname)", "refs/heads/proteus-work/r1/") === "refs/heads/proteus-work/r1/owned-1", r.out);
ok("records: the later ticket waits for the next batch, the PR's still pending", lines(r).includes("BLOCKED #4 owned record waits for the batch after PR#100") && lines(r).includes("BLOCKED #2 owned record pending PR#100"), r.out);

// the PR merges on origin (the local refs stay behind); #2's Owned: line changes after its record
og("update-ref", "refs/heads/proteus/r1", og("rev-parse", "proteus-work/r1/owned-1"));
rs.prs.find((p) => p.number === 100).merged = true;
rs.issues.find((i) => i.number === 2).body = "Owned: src/other.js";
r = rnext();
ok("records: the later ticket goes into the next batch, owned-2, with exactly its record", rs.created.length === 2 && rs.created[1].headRefName === "proteus-work/r1/owned-2" &&
  og("diff", "--name-status", "proteus/r1", "proteus-work/r1/owned-2") === "A\t.proteus/owned/4" && og("log", "-1", "--format=%s", "proteus-work/r1/owned-2") === "chore(proteus): record owned paths for #4", r.out);
ok("records: an existing record is never rewritten, and gives DECIDE", og("show", "proteus/r1:.proteus/owned/2") === "src/t2.js" && og("diff", "--name-only", "proteus/r1", "proteus-work/r1/owned-2") === ".proteus/owned/4" && lines(r).includes("DECIDE #2 owned line differs from record"), r.out);
ok("records: once merged on origin, its tickets are dispatched from origin's tip though the local refs are behind",
  lines(r).some((l) => l.startsWith("SPAWN worker #3 ")) && fs.existsSync(path.join(RR, ".worktrees", "3", ".proteus", "owned", "3")) && g(RR, "rev-parse", "refs/remotes/origin/proteus/r1") !== og("rev-parse", "proteus/r1"), r.out);
ok("records: the new batch's ticket is BLOCKED pending its PR", lines(r).includes("BLOCKED #4 owned record pending PR#101") && !lines(r).some((l) => l.startsWith("SPAWN worker #4")), r.out);
// a record PR closed with its record not on the run branch: the next batch takes the next k; a failed
// gh pr create is BLOCKED, never a SPAWN
rs.prs.find((p) => p.number === 101).merged = true;
r = rnext({ FAKE_GH_PR_CREATE: "fail" });
ok("records: a failed gh pr create is BLOCKED with why, after pushing owned-3", lines(r).some((l) => l.startsWith("BLOCKED #4 owned record: gh pr create for proteus-work/r1/owned-3 failed")) && !lines(r).some((l) => l.startsWith("SPAWN worker #4")), r.out);
// a long wave keeps commit-msg.js's 72 columns
const { recordMessage } = require(SCRIPT);
const MSG = path.join(RB, "msg");
const msgOk = (ns) => { fs.writeFileSync(MSG, recordMessage(ns)); return lib.run(path.join(HOOKS, "commit-msg.js"), "", { cwd: RB, args: [MSG] }).code === 0; };
ok("records: a long wave's message lists every ticket and passes commit-msg.js", msgOk(Array.from({ length: 30 }, (_, i) => 100 + i)) && Array.from({ length: 30 }, (_, i) => 100 + i).every((n) => recordMessage(Array.from({ length: 30 }, (_, i) => 100 + i)).includes(`#${n}`)) && msgOk([2, 3]));

// nothing sandboxed ran: no child of proteus-cli.js (or of the proteus-merge.js code it runs) named them
const children = fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
ok("sandbox: the log saw proteus-cli.js's children", children.length > 0, children.length);
const bad = children.filter((c) => /proteus-run-tree\.js|proteus-watchdog\.js|suite\.js/.test([c.file, ...(c.args || [])].join(" ")));
ok("sandbox: next and result never start run-tree, the suite or the watchdog", bad.length === 0, JSON.stringify(bad));

lib.summary();

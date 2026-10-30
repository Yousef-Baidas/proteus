// proteus-cli.js brief tests: node tests/brief.test.js (needs git). A repo with a proteus/r1 branch holding the owned
// records, worktrees prepared by next and contract commits on their branches, the fake gh (FAKE_GH_NEXT) answering the
// tracker. A full worker brief for a standard and a quick ticket, the verifier brief, every slot of both roles.md blocks
// covered by a filler or a listed conditional, DECIDE on a missing contract, the PROMPT line's spawn tokens, the Codex
// and container lines only when due, and next printing the brief command without running it. No network.
"use strict";
const fs = require("fs");
const path = require("path");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const SCRIPT = path.join(__dirname, "..", "templates", "hooks", "proteus-cli.js");
const HOOKS = path.dirname(SCRIPT);
const cli = require(SCRIPT);
const lib2 = require(path.join(HOOKS, "proteus-lib.js"));
const { spawnTarget } = lib2;
const W = lib.workdir("brief");

const REPO = path.join(W, "repo");
g(W, "init", "-q", "-b", "main", REPO);
const LEARNED = "# Agents\n\n## Learned\n- gate: `npm test`, `npm run lint`\n";
fs.writeFileSync(path.join(REPO, "AGENTS.md"), LEARNED);
fs.writeFileSync(path.join(REPO, "package.json"), "{}\n");
fs.mkdirSync(path.join(REPO, "teams", "backend"), { recursive: true });
fs.writeFileSync(path.join(REPO, "teams", "backend", "PROFILE.md"), "# backend profile\n\nOwns: API.\nSafety: run migrations only against the test database.\n");
g(REPO, "add", "-A");
g(REPO, "commit", "-qm", "init");
g(REPO, "checkout", "-q", "-b", "proteus/r1");
fs.mkdirSync(path.join(REPO, ".proteus", "owned"), { recursive: true });
for (const n of [5, 6, 7]) fs.writeFileSync(path.join(REPO, ".proteus", "owned", String(n)), `src/t${n}.js\ntests/t${n}.test.js\n`);
g(REPO, "add", "-A");
g(REPO, "commit", "-qm", "records");
g(REPO, "checkout", "-q", "main");
g(REPO, "remote", "add", "origin", "https://github.com/o/r.git");
const STATE = path.join(W, "gh.json");
const SHA = (c) => c.repeat(40);
const WT = (n) => path.join(REPO, ".worktrees", String(n));

const ms = { title: "r1/core", number: 1 };
const labels = (...l) => ["proteus", "profile:backend", ...l].map((name) => ({ name }));
const body = (n, extra = "") => `Owned: src/t${n}.js tests/t${n}.test.js\nCheck: \`tests/t${n}.test.js::adds\` returns 3 for 1 and 2${extra}`;
const ISSUES = [
  { number: 5, title: "t5: add", state: "OPEN", milestone: ms, labels: labels("difficulty:standard"), body: body(5) },
  { number: 6, title: "t6: typo", state: "OPEN", milestone: ms, labels: labels("needs-research"), body: body(6, "\nTier: quick") },
  { number: 7, title: "t7: none", state: "OPEN", milestone: ms, labels: labels("difficulty:hard"), body: body(7) },
];
const pr = (n, ticket, sha) => ({ number: n, headRefName: `proteus-work/r1/${ticket}`, headRefOid: sha, body: `Closes #${ticket}`, isDraft: false, statusCheckRollup: [] });
const STATEJSON = { issues: ISSUES, prs: [pr(12, 5, SHA("b"))], reviews: [], inbox: [], debt: [{ number: 40, milestone: ms }, { number: 41, milestone: { title: "r1/later" } }] };
const run = (args, env = {}, state = STATEJSON) => {
  fs.writeFileSync(STATE, JSON.stringify(state));
  return lib.run(SCRIPT, "", { cwd: REPO, args, env: { FAKE_GH_NEXT: STATE, ...env } });
};
const lines = (r) => r.out.trim().split("\n").filter(Boolean);

// next prepares the three worktrees, and prints each one's brief command without running it
const LOG = path.join(W, "spawns.jsonl");
const logged = { SPAWN_LOG: LOG, NODE_OPTIONS: [lib.ENV.NODE_OPTIONS, `--require "${path.join(__dirname, "fixtures", "spawn-log.js").replace(/\\/g, "/")}"`].filter(Boolean).join(" ") };
let r = run(["next"], logged, { ...STATEJSON, prs: [] });
ok("next: the SPAWN worker line names its brief command", lines(r).includes(`SPAWN worker #5 team=backend difficulty=standard worktree=${WT(5)} brief: node ${SCRIPT} brief worker 5`), r.out + r.err);
ok("next: the worktrees are prepared", [5, 6, 7].every((n) => fs.existsSync(WT(n))), r.out + r.err);
r = run(["next", "r1"], logged);
ok("next: the SPAWN verifier line names its brief command", lines(r).includes(`SPAWN verifier PR#12 #5 head=${SHA("b").slice(0, 12)} brief: node ${SCRIPT} brief verifier 12 r1`), r.out);
ok("next: a run it was given is passed on to brief", lines(r).some((l) => l.endsWith(`brief: node ${SCRIPT} brief worker 6 r1`)), r.out);
const kids = fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
ok("next: never runs brief or proteus-scratch.js", kids.length > 0 && !kids.some((c) => (c.args || []).includes("brief") || /proteus-scratch\.js/.test([c.file, ...(c.args || [])].join(" "))), JSON.stringify(kids));
ok("next: writes no brief", !fs.existsSync(path.join(REPO, ".git", "proteus", "scratch", "r1")));

// the contract commits on #5's and #6's branches; #7 has none
const contract = (n, msg) => {
  fs.mkdirSync(path.join(WT(n), "tests"), { recursive: true });
  fs.writeFileSync(path.join(WT(n), "tests", `t${n}.test.js`), "throw new Error('todo');\n");
  g(WT(n), "add", "-A");
  g(WT(n), "-c", "core.hooksPath=/dev/null", "commit", "-qm", msg);
  return g(WT(n), "rev-parse", "HEAD");
};
const C5 = contract(5, "test(api): contract for #5");
const C6 = contract(6, "test: contract for #6");
const scratch = g(REPO, "rev-parse", "--git-common-dir");
const briefFile = (name) => path.join(path.resolve(REPO, scratch), "proteus", "scratch", "r1", name);
const read = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
const real = fs.realpathSync.native(HOOKS);

// a standard ticket, in full
r = run(["brief", "worker", "5"]);
let b = read(briefFile("brief-5.md"));
ok("worker: exits 0 with one PROMPT line naming the brief file", r.code === 0 && lines(r).join("|") === `PROMPT Your brief is ${briefFile("brief-5.md")}; read it first. worker #5 worktree ${WT(5)}`, r.out + r.err);
const COMMON = path.join(REPO, ".git");
ok("worker: the PROMPT line binds the worker to its worktree (lib.briefWorktree)", lib2.realOr(lib2.briefWorktree(lines(r)[0], COMMON) || "") === lib2.realOr(WT(5)), r.out);
ok("worker: the PROMPT line carries the worker's spawn token", JSON.stringify(spawnTarget("proteus-backend-worker", lines(r)[0])) === JSON.stringify({ ticket: 5 }), r.out);
const want5 = [
  `Hooks: ${real}.`,
  "Gates: `npm test`, `npm run lint`.",
  "Team backend: teams/backend/PROFILE.md, teams/backend/CRAFT.md.",
  "Safety: run migrations only against the test database.",
  `Ticket #5 (gh issue view 5 --json body -q .body), worktree ${WT(5)}, branch proteus-work/r1/5, scratch key r1-5.`,
  "PR base proteus/r1, tier standard.",
  `Contract: commit ${C5}; check files: tests/t5.test.js. Check: \`tests/t5.test.js::adds\` returns 3 for 1 and 2.`,
  "You own: src/t5.js tests/t5.test.js. Edit only these, and commit through the hook.",
  "Done → one comment on the ticket: `DONE #5` / files / checks passed with their output lines / evidence links / one-line note.",
];
for (const l of want5) ok(`worker: the brief has "${l.slice(0, 40)}"`, b.split("\n").includes(l), b);
ok("worker: standard difficulty gets the Ponytail lite line, not the Quick one", /^Ponytail lite; inside the contract/m.test(b) && !/Ponytail full/.test(b), b);
ok("worker: no Codex line off Codex, no research line without the label", !/\.agents\/skills|Codex/.test(b) && !/\/research/.test(b), b);
ok("worker: no slice line without a slice: label", !/^Also (read|check) /m.test(b), b);
ok("worker: no slot is left and no Quick alternative", !/<[^<>\n]+>/.test(b) && !/\(Quick:/.test(b), b);
ok("worker: the brief starts with the Hooks line and ends with the report line", b.startsWith("Hooks: ") && b.trimEnd().endsWith("one-line note."), b);

// a link planted where the brief goes is replaced, never written through
const TARGET = path.join(W, "outside.txt");
fs.writeFileSync(TARGET, "keep\n");
fs.rmSync(briefFile("brief-5.md"));
let linked = true;
try { fs.symlinkSync(TARGET, briefFile("brief-5.md")); } catch { linked = false; }
if (linked) {
  r = run(["brief", "worker", "5"]);
  ok("link: the brief replaces a link at its path and leaves the target alone", r.code === 0 && read(TARGET) === "keep\n" && !fs.lstatSync(briefFile("brief-5.md")).isSymbolicLink() && read(briefFile("brief-5.md")).startsWith("Hooks: "), r.out + r.err);
}

// a quick ticket: the Quick line from the tier alone, the research line from its label
r = run(["brief", "worker", "6"]);
b = read(briefFile("brief-6.md"));
ok("quick: exits 0", r.code === 0, r.out + r.err);
ok("quick: the Quick line and its tier", /^Ponytail full, the smallest change/m.test(b) && b.includes("PR base proteus/r1, tier quick.") && !/Ponytail lite/.test(b), b);
ok("quick: the contract without a scope is found", b.includes(`Contract: commit ${C6};`), b);
ok("quick: needs-research adds its line", /^run \/research first; primary sources/m.test(b), b);
ok("quick: no slot is left", !/<[^<>\n]+>/.test(b), b);

// on Codex the skills line, its <name> left for the agent
r = run(["brief", "worker", "5"], { PROTEUS_HARNESS: "codex" });
b = read(briefFile("brief-5.md"));
ok("codex: the Codex line with the team filled and <name> kept", r.code === 0 && b.includes("after PROFILE.md, list teams/backend/.agents/skills/ and read each fitting <name>/SKILL.md yourself"), r.out + r.err + b);

// no contract commit: DECIDE, exit 1, nothing written
r = run(["brief", "worker", "7"]);
ok("contract: none on the branch is DECIDE and exit 1", r.code === 1 && lines(r).join("|") === "DECIDE #7 brief: no source for contract sha", r.out + r.err);
ok("contract: no brief written", !fs.existsSync(briefFile("brief-7.md")));
// no gate line: DECIDE too
fs.writeFileSync(path.join(REPO, "AGENTS.md"), "# Agents\n");
r = run(["brief", "worker", "5"]);
ok("gates: no gate line is DECIDE", r.code === 1 && lines(r).join("|") === "DECIDE #5 brief: no source for gate commands", r.out + r.err);
fs.writeFileSync(path.join(REPO, "AGENTS.md"), LEARNED);
// a ticket with neither difficulty label nor quick tier
r = run(["brief", "worker", "5"], {}, { ...STATEJSON, issues: [{ ...ISSUES[0], labels: labels() }, ...ISSUES.slice(1)] });
ok("difficulty: no label and no quick tier is DECIDE", r.code === 1 && lines(r).join("|") === "DECIDE #5 brief: no source for difficulty", r.out + r.err);

// the verifier
r = run(["brief", "verifier", "12"]);
b = read(briefFile("verify-12.md"));
ok("verifier: exits 0 with the PROMPT line", r.code === 0 && lines(r).join("|") === `PROMPT Your brief is ${briefFile("verify-12.md")}; read it first. verifier PR#12 head=${SHA("b").slice(0, 12)}`, r.out + r.err);
ok("verifier: the PROMPT line carries the PR and head next's spawn matching parses", JSON.stringify(spawnTarget("proteus-backend-verifier", lines(r)[0])) === JSON.stringify({ pr: 12, head: SHA("b").slice(0, 12) }), r.out);
ok("verifier: the PROMPT line names no worktree, so no guard binds the verifier to one", lib2.briefWorktree(lines(r)[0], COMMON) === null, r.out);
for (const l of [`Hooks: ${real}.`, "Team backend, debt issue #40, dupes tool fallow dupes. Caveman lite.", "Safety: run migrations only against the test database.", "Ticket #5, PR #12, scratch key r1-5.", `Then sign it on the head you read: proteus-signoff.js 12 ${SHA("b")} <WORD> (security verifier: --security).`, "MERGE #5"])
  ok(`verifier: the brief has "${l.slice(0, 40)}"`, b.split("\n").includes(l), b);
ok("verifier: the report's own placeholders are kept", b.includes("1. <file:line> wrong") && b.includes("<one paragraph>"), b);
ok("verifier: no isolation line without isolation: container", !/CHECKS:/.test(b), b);
ok("verifier: no slice line without a slice: label", !/^Also (read|check) /m.test(b), b);

// a slice ticket (teams.md): both briefs name every slice team's PROFILE.md
const SLICED = { ...STATEJSON, issues: [{ ...ISSUES[0], labels: labels("difficulty:standard", "slice:frontend,devops") }, ...ISSUES.slice(1)] };
r = run(["brief", "worker", "5"], {}, SLICED);
b = read(briefFile("brief-5.md"));
ok("slice: the worker brief names each slice team's profile", r.code === 0 && b.split("\n").includes("Also read teams/frontend/PROFILE.md, teams/devops/PROFILE.md."), r.out + r.err + b);
r = run(["brief", "verifier", "12"], {}, SLICED);
b = read(briefFile("verify-12.md"));
ok("slice: the verifier brief names each slice team's profile and checklist", r.code === 0 && b.split("\n").includes("Also check teams/frontend/PROFILE.md, teams/devops/PROFILE.md."), r.out + r.err + b);
fs.writeFileSync(path.join(REPO, "AGENTS.md"), `${LEARNED}isolation: container\n`);
r = run(["brief", "verifier", "12"]);
b = read(briefFile("verify-12.md"));
ok("container: the isolation line under isolation: container", r.code === 0 && /^never run the branch's code; reply `CHECKS:`/m.test(b), r.out + r.err + b);
fs.writeFileSync(path.join(REPO, "AGENTS.md"), LEARNED);
r = run(["brief", "verifier", "12"], {}, { ...STATEJSON, debt: [] });
ok("verifier: no open debt issue for the milestone is DECIDE", r.code === 1 && lines(r).join("|") === "DECIDE #5 brief: no source for d", r.out + r.err);
r = run(["brief", "verifier", "99"]);
ok("verifier: a PR not open into the run is DECIDE", r.code === 1 && lines(r).join("|") === "DECIDE PR#99 brief: no source for pr", r.out + r.err);

// usage
ok("usage: an unknown role exits 2", run(["brief", "qa", "5"]).code === 2);
ok("usage: no number exits 2", run(["brief", "worker", "x"]).code === 2);

// every slot of both roles.md blocks has a filler, is kept for the agent, or is a listed conditional
const ROLES = fs.readFileSync(path.join(__dirname, "..", "skills", "proteus", "references", "roles.md"), "utf8");
const uncovered = (block) => {
  const s = cli.slotsOf(block);
  return [...s.inline.filter((x) => !(x in cli.FILL) && !cli.KEPT.includes(x)), ...s.lines.filter((x) => !(x in cli.WHEN))];
};
for (const role of ["Worker", "Verifier"]) {
  const block = cli.roleBlock(ROLES, role);
  ok(`slots: roles.md has a ## ${role} block`, block.split("\n").length > 3, block);
  ok(`slots: every slot in the ${role} block has a source`, uncovered(block).length === 0, uncovered(block).join(", "));
  ok(`slots: a new slot in the ${role} block is caught`, uncovered(`${block}\nAlso <new slot>.\n<rare: a line>`).join() === "new slot,rare");
}
// and at run time: the project's skill copy is read first, and a slot with no filler there is a DECIDE
const LOCAL = path.join(REPO, ".claude", "skills", "proteus", "references", "roles.md");
fs.mkdirSync(path.dirname(LOCAL), { recursive: true });
fs.writeFileSync(LOCAL, ROLES.replace("Hooks: <hooks>.\nGates:", "Hooks: <hooks>.\nAlso <new slot>.\nGates:"));
r = run(["brief", "worker", "5"]);
ok("slots: a slot with no filler in the roles.md read is DECIDE at run time", r.code === 1 && lines(r).join("|") === "DECIDE #5 brief: no source for new slot", r.out + r.err);
fs.writeFileSync(LOCAL, ROLES.replace("Hooks: <hooks>.\nGates:", "Hooks: <hooks>.\n<rare: a line>\nGates:"));
r = run(["brief", "worker", "5"]);
ok("slots: a conditional line with no condition is DECIDE at run time", r.code === 1 && lines(r).join("|") === "DECIDE #5 brief: no source for rare", r.out + r.err);
fs.rmSync(path.join(REPO, ".claude"), { recursive: true, force: true });

lib.summary();

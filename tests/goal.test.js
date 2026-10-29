// proteus-goal.js tests: node tests/goal.test.js (needs git). One goal-loop round against a fake scorecard in a real
// .worktrees/_run (proteus-run-tree.js) and a fake run log (the shared fake gh's FAKE_GH_RUN): NEXT while improving,
// STOP target for min and max, STOP budget, STOP falling, STOP error, the refusal with the sandbox off (sandboxState's
// options injected as tests/canary.test.js does), and the fixture round from tests/fixtures/run-log-goal.md.
"use strict";
const fs = require("fs");
const path = require("path");

const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("goal");
const HOOKS = path.join(__dirname, "..", "templates", "hooks");
const SCRIPT = path.join(HOOKS, "proteus-goal.js");
const goal = require(SCRIPT);

// the sandbox as lib.sandboxState reads it, injected
const ON = { platform: "darwin", settings: [{ sandbox: { enabled: true } }] };
const OFF = { platform: "darwin", settings: [{}] };
const WINDOWS = { platform: "win32", settings: [{ sandbox: { enabled: true } }] };

// the project: a scorecard that prints FAKE_SCORE as its last line ("none": no SCORE line) and exits FAKE_SCORE_EXIT
const REPO = path.join(W, "repo");
fs.mkdirSync(path.join(REPO, "scripts"), { recursive: true });
g(W, "init", "-q", "-b", "main", REPO);
fs.writeFileSync(path.join(REPO, "AGENTS.md"), "## Learned\nscorecard: scripts/score.js\n");
fs.writeFileSync(path.join(REPO, "scripts", "score.js"), [
  "const v = process.env.FAKE_SCORE;",
  "console.log(\"measuring render-ms\");",
  "if (v !== \"none\") console.log(`SCORE ${v}`);",
  "process.exit(+(process.env.FAKE_SCORE_EXIT || 0));",
  "",
].join("\n"));
g(REPO, "add", "-A"); g(REPO, "commit", "-qm", "scorecard");
const TIP = g(REPO, "rev-parse", "HEAD");
const tree = lib.run(path.join(HOOKS, "proteus-run-tree.js"), "", { cwd: REPO, args: [TIP] });
ok("setup: proteus-run-tree.js puts the run's tip in .worktrees/_run", tree.code === 0, tree.out + tree.err);

// the round runs in this process: its gh is the fake on lib.ENV's PATH, its scorecard sees FAKE_SCORE
Object.assign(process.env, lib.ENV);
const LOGS = path.join(W, "run.json");
process.env.FAKE_GH_RUN = LOGS;
const logWith = (...comments) => fs.writeFileSync(LOGS, JSON.stringify({ logs: [
  { number: 3, title: "Run: other" },
  { number: 7, title: "Run: g1", body: "lead's decision log", comments: comments.map((body) => ({ body })) },
] }));
const rounds = (...vs) => vs.map((v, i) => `goal-round: ${i + 1} score ${v}`);
function round(score, extra = [], { sandbox = ON, exit = "0", goalArg = "render-ms min 120" } = {}) {
  process.env.FAKE_SCORE = String(score);
  process.env.FAKE_SCORE_EXIT = exit;
  const r = goal.main(["round", "--run", "g1", "--scorecard", "scripts/score.js", "--goal", goalArg, ...extra], { root: REPO, sandbox });
  return { code: r.code, out: (r.out || []).join("\n"), last: (r.out || []).slice(-1)[0] || "", err: r.err || "" };
}

// ---- --help and usage, spawned
{
  const r = lib.run(SCRIPT, "", { cwd: REPO, args: ["--help"] });
  ok("--help: usage, the five decision lines and the exit codes, exit 0", r.code === 0 && /usage: node proteus-goal\.js round --run <run>/.test(r.out) && /STOP falling <prev> -> <v>/.test(r.out) && /NEXT <k> score <v>/.test(r.out) && /Exit 0 on NEXT, 1 on STOP, 2/.test(r.out), r.err);
  const u = lib.run(SCRIPT, "", { cwd: REPO, args: ["round", "--run", "g1"] });
  ok("usage: --scorecard and --goal missing exits 2", u.code === 2 && /are required/.test(u.err), u.out + u.err);
}
{
  const bad = (args) => goal.main(["round", "--run", "g1", "--scorecard", "scripts/score.js", ...args], { root: REPO, sandbox: ON });
  ok("usage: a goal without min or max exits 2", bad(["--goal", "render-ms lower 120"]).code === 2);
  ok("usage: a budget over 50 exits 2", bad(["--goal", "render-ms min 120", "--budget", "51"]).code === 2);
  ok("usage: a budget of 0 exits 2", bad(["--goal", "render-ms min 120", "--budget", "0"]).code === 2);
  const out = goal.main(["round", "--run", "g1", "--scorecard", "../score.js", "--goal", "render-ms min 120"], { root: REPO, sandbox: ON });
  ok("usage: a scorecard outside the repo exits 2", out.code === 2 && /not a path inside the repo/.test(out.err), out.err);
}

// ---- the sandbox
{
  logWith(...rounds(180));
  let r = round(150, [], { sandbox: OFF });
  ok("sandbox off: refused, exit 2, nothing printed on stdout", r.code === 2 && r.out === "" && /runs only under the sandbox, and it is off/.test(r.err), r.err);
  r = round(150, [], { sandbox: WINDOWS });
  ok("sandbox unavailable (native Windows): refused, exit 2", r.code === 2 && /it is unavailable/.test(r.err), r.err);
}

// ---- decisions
{
  logWith(...rounds(180));
  let r = round(150);
  ok("improving: NEXT with the round number and score, exit 0", r.code === 0 && r.last === "NEXT 2 score 150", r.out);
  ok("improving: the goal-round line for the run log comes first", r.out.split("\n")[0] === "goal-round: 2 score 150", r.out);
  r = round(180);
  ok("an equal score is not falling: NEXT", r.code === 0 && r.last === "NEXT 2 score 180", r.out);

  r = round(120);
  ok("min: the target met exactly gives STOP target, exit 1", r.code === 1 && r.last === "STOP target 120" && r.out.includes("goal-round: 2 score 120"), r.out);
  r = round(110);
  ok("min: below the target gives STOP target", r.code === 1 && r.last === "STOP target 110", r.out);
  logWith(...rounds(40));
  r = round(61, [], { goalArg: "fps max 60" });
  ok("max: above the target gives STOP target", r.code === 1 && r.last === "STOP target 61", r.out);
  r = round(50, [], { goalArg: "fps max 60" });
  ok("max: rising short of the target gives NEXT", r.code === 0 && r.last === "NEXT 2 score 50", r.out);

  logWith(...rounds(180, 150));
  r = round(160);
  ok("min: a higher score than the last round gives STOP falling, exit 1", r.code === 1 && r.last === "STOP falling 150 -> 160" && r.out.includes("goal-round: 3 score 160"), r.out);
  logWith(...rounds(40, 50));
  r = round(45, [], { goalArg: "fps max 60" });
  ok("max: a lower score than the last round gives STOP falling", r.code === 1 && r.last === "STOP falling 50 -> 45", r.out);

  logWith(...rounds(180, 170, 160));
  r = round(150, ["--budget", "3"], { exit: "1" });
  ok("budget: round 4 of 3 gives STOP budget without running the scorecard", r.code === 1 && r.out === "STOP budget", r.out);
  r = round(150, ["--budget", "4"]);
  ok("budget: the last round inside it still gives NEXT", r.code === 0 && r.last === "NEXT 4 score 150", r.out);
  logWith(...rounds(200, 190, 180, 170, 160, 150, 140, 130, 125, 124));
  r = round(122);
  ok("budget: without --budget the default is 10 rounds", r.code === 1 && r.out === "STOP budget", r.out);

  logWith(...rounds(180));
  r = round("none");
  ok("no SCORE line gives STOP error and no goal-round line", r.code === 1 && r.out === "STOP error the scorecard printed no SCORE line", r.out);
  r = round(150, [], { exit: "3" });
  ok("a scorecard that exits non-zero gives STOP error", r.code === 1 && r.out === "STOP error the scorecard exited 3", r.out);
  r = round("fast");
  ok("a SCORE that is not a number gives STOP error", r.code === 1 && r.out.startsWith("STOP error "), r.out);
}

// ---- the run log and _run
{
  fs.writeFileSync(LOGS, JSON.stringify({ logs: [{ number: 3, title: "Run: other" }] }));
  let r = round(150);
  ok("no run log for the run gives STOP error", r.code === 1 && r.out === "STOP error no run log titled \"Run: g1\"", r.out);
  process.env.FAKE_GH = "fail";
  r = round(150);
  delete process.env.FAKE_GH;
  ok("an unreachable tracker gives STOP error", r.code === 1 && r.out.startsWith("STOP error run log unreachable"), r.out);
  logWith(...rounds(180));
  const agents = fs.readFileSync(path.join(REPO, "AGENTS.md"), "utf8");
  fs.writeFileSync(path.join(REPO, "AGENTS.md"), agents + "isolation: container\n");
  r = round(150);
  fs.writeFileSync(path.join(REPO, "AGENTS.md"), agents);
  ok("isolation: container without --worktree gives STOP error naming it", r.code === 1 && /isolation: container needs --worktree/.test(r.out), r.out);
  const missing = goal.main(["round", "--run", "g1", "--scorecard", "scripts/none.js", "--goal", "render-ms min 120"], { root: REPO, sandbox: ON });
  ok("a scorecard not in _run gives STOP error", missing.code === 1 && /scripts\/none\.js is not in \.worktrees\/_run/.test(missing.out.join("\n")), missing.out);
}

// ---- the fixture round: the fake run log plus the scorecard give the goal-round line and NEXT; the line, appended
// to the log as the lead would, makes the next round number 4
{
  const log = fs.readFileSync(path.join(__dirname, "fixtures", "run-log-goal.md"), "utf8");
  logWith(...log.split(/\n(?=## )/));
  let r = round(140);
  ok("fixture: rounds 1 and 2 logged, a score of 140 gives goal-round: 3 score 140 then NEXT 3 score 140", r.code === 0 && r.out === "goal-round: 3 score 140\nNEXT 3 score 140", r.out);
  logWith(...log.split(/\n(?=## )/), `## goal round 3\n\n${r.out.split("\n")[0]}\n- improvement ticket #24`);
  r = round(118);
  ok("fixture: the appended line counts, so round 4 meets the target and stops", r.code === 1 && r.out === "goal-round: 4 score 118\nSTOP target 118", r.out);
}

// ---- parsing helpers
{
  ok("parseRounds: reads goal-round lines anywhere in the text, skipping malformed ones", JSON.stringify(goal.parseRounds("x\ngoal-round: 1 score 10\n- goal-round: 2 score 9\ngoal-round: 3 score abc\ngoal-round: 4 score 8.5\n")) === JSON.stringify([{ k: 1, v: 10 }, { k: 4, v: 8.5 }]));
  ok("scoreOf: the host needs SCORE on the last stdout line", goal.scoreOf("SCORE 3\ndone\n", true).error && goal.scoreOf("x\nSCORE 3\n", true).v === 3);
  ok("scoreOf: the container log takes its last SCORE line, stderr around it", goal.scoreOf("SCORE 3\nwarn: x\nSCORE 2\nnoise\n", false).v === 2);
}

lib.summary();

// Review gate tests: node tests/reviewgate.test.js (needs git). The lead guard refuses to open a proteus-review issue,
// for the lead and its subagents alike, and proteus-verdict.js does not count ACCEPT or AUTO-ACCEPT on one, while the
// milestone has open tickets or the tracker cannot say (#254). The tracker is tests/fakegh.js (FAKE_GH_ISSUES).
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "templates", "hooks");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("reviewgate");
const LG = path.join(SRC, "proteus-lead-guard.js");
const VD = path.join(SRC, "proteus-verdict.js");

const REPO = path.join(W, "repo");
g(W, "init", "-q", "-b", "main", REPO);
fs.writeFileSync(path.join(REPO, "a.txt"), "a\n");
g(REPO, "add", "-A"); g(REPO, "commit", "-qm", "init");
fs.writeFileSync(path.join(lib.HOME, ".claude", "proteus.json"), JSON.stringify({ human: "human" }));

const ISSUES = path.join(W, "issues.json");
const MS = "r1/core";
const ticket = (title, state, labels = ["proteus", "profile:backend"]) => ({ title, state, milestone: MS, labels, comments: [] });
const tracker = (extra = {}) => fs.writeFileSync(ISSUES, JSON.stringify({
  11: ticket("11: api", "CLOSED"),
  12: ticket("12: auth", "CLOSED"),
  20: { title: `Review: ${MS}`, labels: ["proteus-review", "needs-human"], milestone: MS, comments: [] },
  21: { title: "Debt: r1/core", labels: ["proteus-debt"], milestone: MS, comments: [] },
  ...extra,
}));
// the security verifier's WAVE-RED blocker, filed as a ticket in the milestone (enforcement.md §10b)
const RED = { 14: ticket("14: SECURITY src/auth.js:9 token compared with ==", "OPEN", ["proteus", "profile:backend", "security"]) };

const env = (extra = {}) => ({ FAKE_GH_ISSUES: ISSUES, ...extra });
const create = `gh issue create --title "Review: ${MS}" --label proteus-review,needs-human --milestone ${MS} --body-file brief.md`;
const shell = (command, input = {}, extra = {}) =>
  lib.run(LG, { hook_event_name: "PreToolUse", session_id: "s1", cwd: REPO, tool_name: "Bash", tool_input: { command }, ...input }, { cwd: REPO, env: env(extra) });
const guide = { agent_id: "g1", agent_type: "proteus-guide" };

// ---- gate 1: opening the review issue
tracker(RED);
let r = shell(create, guide);
ok("open: an open security WAVE-RED ticket refuses the guide's review issue, naming it",
  r.code === 2 && r.err.includes(`review gate shut: milestone ${MS} has open tickets #14 (WAVE-RED or unmerged)`), r.code + r.err);
r = shell(create);
ok("open: the lead's own review issue is refused too", r.code === 2 && /review gate shut: milestone r1\/core has open tickets #14/.test(r.err), r.code + r.err);
for (const c of [`node .claude/hooks/proteus-gh.js issue create --title x -l proteus-review --milestone=${MS}`, `sh -c '${create}'`, `cd docs && gh issue create -m ${MS} --label needs-human --label proteus-review`]) {
  r = shell(c, guide);
  ok(`open: refused through other spellings: ${c.slice(0, 60)}`, r.code === 2 && /review gate shut/.test(r.err), r.code + r.err);
}
tracker({ 14: ticket("14: auth fix", "OPEN"), 15: ticket("15: page", "OPEN") });
ok("open: every open ticket is named", /open tickets #14, #15 /.test(shell(create, guide).err));

tracker();
r = shell(create, guide);
ok("open: a milestone with every ticket closed lets the review issue open", r.code === 0, r.code + r.err);
tracker({ 30: { ...ticket("30: other run", "OPEN"), milestone: "r0/core" }, 31: { ...ticket("31: x", "OPEN"), milestone: "r1/next" } });
ok("open: open tickets of another milestone do not hold it", shell(create, guide).code === 0);

r = shell(create, guide, { FAKE_GH: "fail" });
ok("open: a tracker failure refuses", r.code === 2 && r.err.includes(`review gate shut: could not read milestone ${MS}`), r.code + r.err);
r = shell(`gh issue create --title "Review: ${MS}" --label proteus-review --body-file brief.md`, guide);
ok("open: a review issue without a milestone refuses", r.code === 2 && /could not read milestone \(none given\)/.test(r.err), r.code + r.err);
tracker(RED);
ok("open: other issues and commands naming the label pass", [`gh issue create --title "Fix" --label proteus --milestone ${MS}`, "gh issue list --label proteus-review --state open", "rg -n 'issue create.*proteus-review' skills"]
  .every((c) => shell(c, guide).code === 0));

// ---- gate 2: the verdict on the review issue
const vc = (login, body) => ({ author: { login }, body });
const verdict = (comments, extra = {}) => {
  const s = JSON.parse(fs.readFileSync(ISSUES, "utf8"));
  s[20].comments = comments;
  fs.writeFileSync(ISSUES, JSON.stringify(s));
  return lib.run(VD, "", { cwd: REPO, args: ["20"], env: env(extra) });
};
tracker(RED);
r = verdict([vc("human", "AUTO-ACCEPT\nall steps matched")]);
ok("verdict: AUTO-ACCEPT is not counted while a ticket is open, and says why",
  r.code === 1 && r.out === "" && r.err.includes(`AUTO-ACCEPT not counted: review gate shut: milestone ${MS} has open tickets #14`), r.code + r.out + r.err);
r = verdict([vc("human", "ACCEPT")]);
ok("verdict: the human's ACCEPT is not counted either", r.code === 1 && r.out === "" && /ACCEPT not counted/.test(r.err), r.code + r.out + r.err);
r = verdict([vc("human", "CHANGES\n- fix the token compare")]);
ok("verdict: CHANGES still counts", r.code === 0 && r.out.startsWith("CHANGES"), r.code + r.out + r.err);
const noMs = JSON.parse(fs.readFileSync(ISSUES, "utf8"));
noMs[20].milestone = null;
fs.writeFileSync(ISSUES, JSON.stringify(noMs));
r = verdict([vc("human", "ACCEPT")]);
ok("verdict: a review issue whose milestone cannot be read is not counted", r.code === 1 && /ACCEPT not counted: review gate shut: could not read milestone/.test(r.err), r.code + r.out + r.err);
tracker();
r = verdict([vc("human", "AUTO-ACCEPT\nall steps matched")]);
ok("verdict: once every ticket is closed, AUTO-ACCEPT counts", r.code === 0 && r.out.startsWith("AUTO-ACCEPT"), r.code + r.out + r.err);
const s = JSON.parse(fs.readFileSync(ISSUES, "utf8"));
s[40] = { title: "Q: which db", labels: ["proteus-question"], comments: [vc("human", "ACCEPT")] };
fs.writeFileSync(ISSUES, JSON.stringify(s));
ok("verdict: an issue that is no review issue reads no milestone", lib.run(VD, "", { cwd: REPO, args: ["40"], env: env() }).code === 0);

lib.summary();

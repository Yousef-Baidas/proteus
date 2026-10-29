// Verdict and security status tests: node tests/verdict.test.js. proteus-signoff.js posts a verifier's verdict as
// a commit status on the PR head it reviewed and refuses a head that moved; proteus-security.js posts
// proteus/security from teams/ROUTING.md's security globs, the PR's changed files and a semgrep report; the
// hooks refuse a hand-posted status and a signoff from anyone but a verifier. The fake gh (FAKE_GH_PR) holds the
// PR and records the statuses posted; never touches the network.
// Exit 0 if every assertion passed, 1 otherwise.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const HOOKS = path.join(ROOT, "templates", "hooks");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("verdict");

const SIGN = path.join(HOOKS, "proteus-signoff.js");
const SEC = path.join(HOOKS, "proteus-security.js");
const HEAD = "a".repeat(40), NEXT = "b".repeat(40);
const PR = path.join(W, "pr.json");
const LOG = path.join(W, "gh.log");
const setPr = (o) => { fs.writeFileSync(PR, JSON.stringify({ head: HEAD, files: [], statuses: {}, ...o })); fs.writeFileSync(LOG, ""); };
const pr = () => JSON.parse(fs.readFileSync(PR, "utf8"));
const posts = () => fs.readFileSync(LOG, "utf8").split("\n").filter((l) => l.startsWith("api -X POST "));
const latest = (sha, context) => ((pr().statuses || {})[sha] || []).find((s) => s.context === context);
const env = { FAKE_GH_PR: PR, FAKE_GH_LOG: LOG };

// ---- proteus-signoff.js
const sign = (...args) => lib.run(SIGN, "", { cwd: W, args, env });
setPr({});
ok("signoff: bad usage exits 2 and posts nothing",
  [[], ["x", HEAD, "MERGE"], ["5", "zz", "MERGE"], ["5", HEAD, "LGTM"], ["5", HEAD, "MERGE", "extra"]].every((a) => sign(...a).code === 2) && !posts().length);
let r = sign("5", HEAD.slice(0, 7), "MERGE");
ok("signoff: MERGE posts proteus/verdict success on the full head sha", r.code === 0
  && JSON.stringify(latest(HEAD, "proteus/verdict")) === JSON.stringify({ state: "success", context: "proteus/verdict", description: "MERGE by the verifier" }), r.out + r.err);
setPr({});
r = sign("5", HEAD, "BACK-TO-WORKER", "--security");
ok("signoff: BACK-TO-WORKER --security posts proteus/security failure", r.code === 0
  && latest(HEAD, "proteus/security").state === "failure" && !latest(HEAD, "proteus/verdict"), r.out + r.err);
setPr({});
ok("signoff: CONTRACT-WRONG is a failure too", sign("5", HEAD, "CONTRACT-WRONG").code === 0 && latest(HEAD, "proteus/verdict").state === "failure");
setPr({ head: NEXT, statuses: { [HEAD]: [{ state: "success", context: "proteus/verdict", description: "MERGE by the verifier" }] } });
r = sign("5", HEAD, "MERGE");
ok("signoff: a head that moved after the review is refused, nothing posted, and the new head has no verdict",
  r.code === 1 && /not the a{12} you reviewed/.test(r.err) && !posts().length && !latest(NEXT, "proteus/verdict"), r.err);
setPr({ fail: "view" });
r = sign("5", HEAD, "MERGE");
ok("signoff: gh pr view failing exits 1, nothing posted", r.code === 1 && /gh pr view 5 failed/.test(r.err) && !posts().length, r.err);
setPr({ fail: "post" });
r = sign("5", HEAD, "MERGE");
ok("signoff: a failed post exits 1 and says the PR has no verdict status", r.code === 1 && /has no verdict status/.test(r.err), r.err);

// ---- proteus-security.js: run from the base's checkout, its teams/ROUTING.md the shipped template
const BASE = path.join(W, "base");
fs.mkdirSync(path.join(BASE, "teams"), { recursive: true });
fs.copyFileSync(path.join(ROOT, "templates", "teams", "ROUTING.md"), path.join(BASE, "teams", "ROUTING.md"));
const sec = (...args) => lib.run(SEC, "", { cwd: BASE, args: ["--ci", "5", HEAD, ...args], env });
const secState = () => latest(HEAD, "proteus/security");

setPr({ files: ["src/app/page.tsx", "README.md"] });
r = sec();
ok("security: no changed path matches a security glob: success, no security path touched",
  r.code === 0 && secState().state === "success" && secState().description === "no security path touched", r.out + r.err);
setPr({ files: ["src/app/page.tsx", "src/auth/session.ts"] });
r = sec();
ok("security: a PR touching a security glob without the security verifier's status fails, naming the path and glob",
  r.code === 0 && secState().state === "failure" && /needs the security verifier: src\/auth\/session\.ts \(\*\*\/auth\/\*\*\)/.test(secState().description), r.out + r.err);
setPr({ files: [".github/workflows/proteus-gates.yml"] });
r = sec();
ok("security: a PR changing a workflow needs the security verifier too", secState().state === "failure" && /\.github\/\*\*/.test(secState().description), r.out);
setPr({ files: ["src/auth/session.ts"], statuses: { [HEAD]: [{ state: "success", context: "proteus/security", description: "MERGE by the security verifier" }] } });
r = sec();
ok("security: the security verifier's success on the head is kept, nothing posted", r.code === 0 && !posts().length && /already signed off/.test(r.out), r.out + r.err);
setPr({ files: ["src/auth/session.ts"], statuses: { [HEAD]: [{ state: "success", context: "proteus/security", description: "no security path touched" }] } });
r = sec();
ok("security: CI's own no-path success does not count as the signoff", secState().state === "failure" && posts().length === 1, r.out);
setPr({ files: ["src/auth/session.ts"], statuses: { [NEXT]: [{ state: "success", context: "proteus/security", description: "MERGE by the security verifier" }] } });
sec();
ok("security: a signoff on an earlier head does not carry over to a new push", secState().state === "failure");

// the whole path: CI fails it, the security verifier signs off the head, a re-run of CI leaves the signoff
setPr({ files: ["src/auth/session.ts"] });
sec();
const before = secState().state;
sign("5", HEAD, "MERGE", "--security");
sec();
ok("security: CI failure, then the security verifier's MERGE, then CI again: success stays",
  before === "failure" && secState().state === "success" && secState().description === "MERGE by the security verifier", JSON.stringify(pr().statuses));

const REPORT = path.join(W, "semgrep.json");
fs.writeFileSync(REPORT, JSON.stringify({ results: [{ path: "src/app/page.tsx", check_id: "x" }, { path: "./src/untouched.ts", check_id: "y" }] }));
setPr({ files: ["src/app/page.tsx"] });
r = sec("--findings", REPORT);
ok("security: a semgrep finding in a changed file triggers the security verifier", secState().state === "failure" && /src\/app\/page\.tsx \(semgrep x\)/.test(secState().description), r.out + r.err);
setPr({ files: ["README.md"] });
r = sec("--findings", REPORT);
ok("security: a finding in a file the PR does not change does not", secState().state === "success", r.out + r.err);
fs.writeFileSync(REPORT, "{not json");
setPr({ files: ["README.md"] });
r = sec("--findings", REPORT);
ok("security: an unreadable semgrep report exits 1, nothing posted", r.code === 1 && /cannot read the findings .*semgrep\.json/.test(r.out) && !posts().length, r.out + r.err);

setPr({ files: ["src/auth/session.ts"], fail: "files" });
r = sec();
ok("security: the file list failing exits 1 with no status posted", r.code === 1 && /cannot list PR #5's files/.test(r.out) && !posts().length, r.out + r.err);
setPr({ files: ["src/auth/session.ts"], fail: "post" });
r = sec();
// the runner shares stop-commands state across stdout and stderr, so both fences go to one stream, in order
ok("security: a failed post exits 1, its fence on stdout after the paths' fence, none on stderr",
  r.code === 1 && (r.out.match(/^::stop-commands::[0-9a-f]{32}$/gm) || []).length === 2 && /security paths touched:[\s\S]*posting proteus\/security=failure .* failed/.test(r.out)
  && !/::stop-commands::/.test(r.err), r.out + r.err);
ok("security: bad usage exits 2", [["--ci", "5"], ["--ci", "x", HEAD], ["--staged", "5", HEAD], ["--ci", "5", HEAD, "--findings"]].every((a) => lib.run(SEC, "", { cwd: BASE, args: a, env }).code === 2));
fs.writeFileSync(path.join(BASE, "teams", "ROUTING.md"), "# Routing\n");
setPr({ files: ["src/auth/session.ts"] });
r = sec();
ok("security: no security block: success that says nothing was checked", r.code === 0 && secState().state === "success" && /no security block/.test(secState().description), r.out + r.err);

// ---- the hooks: a hand-posted status and a non-verifier's signoff are refused
const REPO = path.join(W, "repo");
g(W, "init", "-q", "-b", "main", REPO);
fs.writeFileSync(path.join(REPO, "a.txt"), "a\n");
g(REPO, "add", "-A"); g(REPO, "commit", "-qm", "init");
const LG = path.join(HOOKS, "proteus-lead-guard.js");
const shell = (command, extra = {}) => lib.run(LG, { hook_event_name: "PreToolUse", session_id: "s1", cwd: REPO, tool_name: "Bash", tool_input: { command }, ...extra }, { cwd: REPO });
const as = (type) => ({ agent_id: "a1", agent_type: type });
const SIGNOFF = `node .claude/hooks/proteus-signoff.js 5 ${HEAD} MERGE`;
const posting = [`gh api -X POST repos/o/r/statuses/${HEAD} -f state=success -f context=proteus/verdict`, `gh api repos/{owner}/{repo}/statuses/${HEAD} -f state=success`,
  "gh api --method POST repos/o/r/check-runs -f name=gates -f conclusion=success", `node .claude/hooks/proteus-gh.js api repos/o/r/statuses/${HEAD} -f state=success`, "gh api -X PATCH repos/o/r/check-runs/7 -f conclusion=success"];
for (const who of [{}, as("proteus-worker"), as("proteus-security-verifier")]) {
  const label = who.agent_type || "the lead";
  ok(`guard: ${label} posting a commit status or check run by hand is refused`, posting.every((c) => { const x = shell(c, who); return x.code === 2 && /nobody posts one by hand/.test(x.err); }), posting.map((c) => shell(c, who).code).join(","));
  ok(`guard: ${label} reading statuses and checks passes`, [`gh api repos/o/r/commits/${HEAD}/status`, `gh api repos/o/r/commits/${HEAD}/check-runs --jq '.check_runs[].name'`, "gh pr checks 5 --json name,state"].every((c) => shell(c, who).code === 0));
}
r = shell(SIGNOFF);
ok("guard: the lead running proteus-signoff.js is refused", r.code === 2 && /the lead never posts one/.test(r.err), r.err);
for (const t of ["proteus-worker", "proteus-backend-worker", "proteus-scout", "proteus-guide"]) {
  r = shell(SIGNOFF, as(t));
  ok(`guard: ${t} running proteus-signoff.js is refused`, r.code === 2 && /is not a verifier/.test(r.err), r.err);
}
ok("guard: a verifier's signoff passes", ["proteus-verifier", "proteus-backend-verifier", "proteus-security-verifier"].every((t) => shell(SIGNOFF, as(t)).code === 0));
r = shell(`${SIGNOFF} --security`, as("proteus-backend-verifier"));
ok("guard: --security from a verifier other than the security verifier is refused", r.code === 2 && /security verifier's signoff/.test(r.err), r.err);
ok("guard: --security from the security verifier passes", shell(`${SIGNOFF} --security`, as("proteus-security-verifier")).code === 0);
ok("guard: a subagent its harness does not name passes (the guard cannot tell)", shell(SIGNOFF, { agent_id: "a1" }).code === 0);
r = shell(`cd /tmp && rtk node teams/templates/hooks/proteus-signoff.js 5 ${HEAD} MERGE`, as("proteus-worker"));
ok("guard: the signoff through a wrapper or another path is still a signoff", r.code === 2 && /is not a verifier/.test(r.err), r.err);

lib.summary();

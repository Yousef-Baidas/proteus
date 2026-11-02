// the verifier's recheck tests: node tests/recheck.test.js (needs git). A repo with a local bare origin, a run branch
// with a security block, and a worker branch reviewed once; the fake gh (FAKE_GH_NEXT) answers the tracker, the PR's
// reviews and the commit statuses. Scoped when the delta qualifies; a full review, failing closed, on each fallback;
// no recheck line on a first review. No network.
"use strict";
const fs = require("fs");
const path = require("path");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const SCRIPT = path.join(__dirname, "..", "templates", "hooks", "proteus-cli.js");
const W = lib.workdir("recheck");
const TMPD = path.join(W, "tmp");
fs.mkdirSync(TMPD);

const REPO = path.join(W, "repo"), ORIGIN = path.join(W, "origin.git");
g(W, "init", "-q", "--bare", "-b", "main", ORIGIN);
g(W, "init", "-q", "-b", "main", REPO);
const write = (f, text) => { const p = path.join(REPO, f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const body = (n, tag) => Array.from({ length: n }, (_, i) => `${tag} ${i}`).join("\n") + "\n";
write("AGENTS.md", "# Agents\n\n## Learned\n- gate: `npm test`\n");
write("package.json", "{}\n");
write("teams/backend/PROFILE.md", "# backend\n\nOwns: API.\n");
write("teams/ROUTING.md", "# Routing\n\n```security\nsrc/auth/**\n```\n");
write(".proteus/owned/5", "src/app.js\nsrc/auth/login.js\n");
write("src/other.js", "other\n");
write("src/auth/token.js", "token\n");
g(REPO, "add", "-A");
g(REPO, "commit", "-qm", "init");
g(REPO, "branch", "proteus/r1");
g(REPO, "remote", "add", "origin", ORIGIN);
g(REPO, "push", "-q", "origin", "main", "proteus/r1");
const BRANCH = "proteus-work/r1/5";
g(REPO, "checkout", "-q", "-b", BRANCH, "proteus/r1");
write("src/app.js", body(100, "app"));
write("src/auth/login.js", body(100, "login"));
write("logo.bin", Buffer.from([0, 1, 2, 3, 0, 255]));
g(REPO, "add", "-A");
g(REPO, "commit", "-qm", "feat: the ticket");
const REVIEWED = g(REPO, "rev-parse", "HEAD");
g(REPO, "push", "-q", "origin", BRANCH);

// the branch from the reviewed head, changed by edit, committed and pushed; its new head
const moved = (edit) => {
  g(REPO, "checkout", "-q", "--detach", REVIEWED);
  g(REPO, "branch", "-f", BRANCH, REVIEWED);
  g(REPO, "checkout", "-q", BRANCH);
  edit();
  g(REPO, "add", "-A");
  g(REPO, "commit", "-q", "--allow-empty", "-m", "fix: the finding");
  g(REPO, "push", "-q", "-f", "origin", BRANCH);
  return g(REPO, "rev-parse", "HEAD");
};
const prefixed = (n, x) => body(100, "app").split("\n").map((l, i) => (i < n ? `${x}${l}` : l)).join("\n");
const fix = () => write("src/app.js", body(100, "app").replace("app 3\n", "fixed 3\n"));

const issue = { number: 5, title: "t5", state: "OPEN", milestone: { title: "r1/core", number: 1 }, labels: ["proteus", "profile:backend", "difficulty:standard"].map((name) => ({ name })), body: "Owned: src/app.js src/auth/login.js\nCheck: `src/app.js` works" };
const status = (context, word, who, login = "agents") => ({ context, state: word === "MERGE" ? "success" : "failure", description: `${word} by the ${who}`, creator: { login } });
const verdict = (word = "BACK-TO-WORKER", login) => status("proteus/verdict", word, "verifier", login);
const signed = (word = "BACK-TO-WORKER", login) => status("proteus/security", word, "security verifier", login);
const review = (sha, text = "BACK-TO-WORKER #5  1. src/app.js:4 wrong → green looks like fixed") => ({ body: text, state: "COMMENTED", commit: { oid: sha } });
const STATE = path.join(W, "gh.json");
const run = (head, { reviews = [review(REVIEWED)], statuses = { [REVIEWED]: [verdict()] }, env = {} } = {}) => {
  fs.writeFileSync(STATE, JSON.stringify({ issues: [issue], prs: [{ number: 12, headRefName: BRANCH, headRefOid: head, body: "Closes #5", isDraft: false, statusCheckRollup: [], reviews }], reviews: [], inbox: [], debt: [{ number: 40, milestone: issue.milestone }], statuses }));
  const r = lib.run(SCRIPT, "", { cwd: REPO, args: ["brief", "verifier", "12", "r1"], env: { FAKE_GH_NEXT: STATE, TMPDIR: TMPD, TEMP: TMPD, TMP: TMPD, ...env } });
  const file = (/PROMPT Your brief is (.+?); read it first/.exec(r.out) || [])[1];
  return { ...r, brief: file ? fs.readFileSync(file, "utf8") : "", dir: file ? path.dirname(file) : "" };
};
const FULL = /^Full review:/m, SCOPED = /^Recheck the delta:/m;
const full = (name, r, why) => ok(`full: ${name}`, r.code === 0 && FULL.test(r.brief) && why.test(r.brief) && !SCOPED.test(r.brief), r.out + r.err + r.brief);

// no earlier verdict: the brief is as it was
let head = moved(fix), r = run(head, { reviews: [], statuses: {} });
ok("first review: no recheck line", r.code === 0 && r.brief.length > 0 && !FULL.test(r.brief) && !SCOPED.test(r.brief), r.out + r.err + r.brief);

// scoped
r = run(head);
ok("scoped: a small fix commit is a recheck against the reviewed head", r.code === 0 && SCOPED.test(r.brief) && r.brief.includes(REVIEWED.slice(0, 12)), r.out + r.err + r.brief);
const file = (/delta in (\S+?)\.?$/m.exec(r.brief) || [])[1] || "";
const delta = file ? fs.readFileSync(file, "utf8") : "";
ok("scoped: the delta file carries the recheck rules, the brief only its pointer", /replaces `gh pr diff`/.test(delta) && /each earlier finding is fixed/.test(delta) && /carries over/.test(delta) && /Do not widen/.test(delta) && /team verifier only/.test(r.brief), delta.slice(0, 600) + r.brief);
ok("scoped: the delta file sits in the run's scratch", path.dirname(file) === r.dir, file);
ok("scoped: it holds the earlier verdict", delta.includes("src/app.js:4 wrong"), delta);
ok("scoped: it holds the diff from the reviewed head to the new one", delta.includes("-app 3") && delta.includes("+fixed 3") && !delta.includes("+login 0"), delta);
ok("scoped: the signoff line still binds to the head read", /proteus-signoff\.js 12 <sha>|sign it on the head you read/.test(r.brief), r.brief);
ok("scoped: the prompt still names the new head", r.out.includes(`head=${head.slice(0, 12)}`), r.out);
r = run(head, { statuses: { [REVIEWED]: [verdict("MERGE")] }, reviews: [review(REVIEWED, "MERGE #5")] });
ok("scoped: a head pushed after a MERGE is a recheck too", SCOPED.test(r.brief), r.brief);
r = run(head, { statuses: { [REVIEWED]: [verdict(), signed()] } });
ok("scoped: each verifier gets its own line when both reviewed", /^Recheck the delta:/m.test(r.brief) && /^Security verifier, recheck the delta:/m.test(r.brief), r.brief);
r = run(head, { statuses: { [REVIEWED]: [signed()] } });
ok("scoped: a security verifier's earlier review alone leaves the team verifier's line out", /^Security verifier, recheck the delta:/m.test(r.brief) && !/^Recheck the delta:/m.test(r.brief), r.brief);

// fallbacks
let other = moved(() => write("src/other.js", "changed\n"));
full("a path the earlier review did not cover", run(other), /src\/other\.js/);
other = moved(() => { fix(); write("src/new.js", "new\n"); });
full("a new path beside a covered one", run(other), /src\/new\.js/);
other = moved(() => { g(REPO, "mv", "src/app.js", "src/renamed.js"); });
full("a rename counts both ends", run(other), /src\/renamed\.js/);
other = moved(() => write("src/auth/login.js", body(100, "login").replace("login 3\n", "x 3\n")));
full("a security path with no security verifier's review of the reviewed head", run(other, { statuses: { [REVIEWED]: [verdict(), { context: "proteus/security", state: "success", description: "no security path touched", creator: { login: "github-actions[bot]" } }] } }), /security/);
r = run(other, { statuses: { [REVIEWED]: [verdict(), signed()] } });
ok("scoped: a security path the security verifier reviewed stays scoped", SCOPED.test(r.brief), r.brief);
other = moved(() => write("src/other.js", "changed\n"));
r = run(other, { statuses: { [REVIEWED]: [verdict(), signed()] } });
ok("full: each verifier falls back on its own line", FULL.test(r.brief) && /^Security verifier, full review:/m.test(r.brief), r.brief);
other = moved(() => write("src/app.js", body(100, "changed")));
full("a delta over the threshold", run(other), /share|%/);
other = moved(() => write("src/app.js", prefixed(20, "x")));
r = run(other);
ok("threshold: 40 changed lines of a 200-line PR is exactly a fifth, still scoped", SCOPED.test(r.brief), r.brief);
other = moved(() => write("src/app.js", prefixed(21, "x")));
full("one line past a fifth", run(other), /share|%/);
other = moved(() => write("logo.bin", Buffer.from([0, 9, 9])));
full("a binary delta has no line count", run(other), /binary/);
other = moved(fix);
full("an earlier CONTRACT-WRONG", run(other, { statuses: { [REVIEWED]: [verdict("CONTRACT-WRONG")] }, reviews: [review(REVIEWED, "CONTRACT-WRONG #5  no")] }), /CONTRACT-WRONG/);
full("a verdict status with no review of that word on its head", run(other, { reviews: [review(REVIEWED, "MERGE #5")] }), /finding|verdict/);

// rewritten or merged history
g(REPO, "checkout", "-q", "-b", "rewrite", "proteus/r1");
write("src/app.js", body(100, "app"));
g(REPO, "add", "-A");
g(REPO, "commit", "-qm", "feat: rewritten");
const REWRITTEN = g(REPO, "rev-parse", "HEAD");
g(REPO, "branch", "-f", BRANCH, REWRITTEN);
g(REPO, "push", "-q", "-f", "origin", BRANCH);
full("a reviewed head that is not an ancestor", run(REWRITTEN), /ancestor/);
g(REPO, "checkout", "-q", "proteus/r1");
write("src/more.js", "more\n");
g(REPO, "add", "-A");
g(REPO, "commit", "-qm", "chore: base moved");
g(REPO, "push", "-q", "origin", "proteus/r1");
g(REPO, "checkout", "-q", "-b", "merged", REVIEWED);
g(REPO, "merge", "-q", "--no-edit", "proteus/r1");
const MERGED = g(REPO, "rev-parse", "HEAD");
g(REPO, "branch", "-f", BRANCH, MERGED);
g(REPO, "push", "-q", "-f", "origin", BRANCH);
full("a merge commit in the delta is not a fix commit", run(MERGED), /merge/);
g(REPO, "checkout", "-q", "--detach", "HEAD");

// the base moving on with no merge changes nothing
head = moved(fix);
g(REPO, "checkout", "-q", BRANCH);
r = run(head);
ok("scoped: still scoped after the base moved on with no merge", SCOPED.test(r.brief), r.brief);

// origin says otherwise, or cannot say
r = run("f".repeat(40));
full("the PR's head is not origin's", r, /origin/);
g(REPO, "remote", "set-url", "origin", path.join(W, "gone.git"));
full("origin unreachable", run(head), /origin/);
g(REPO, "remote", "set-url", "origin", ORIGIN);

// a review with no verdict status does not count, and the walk stops at the newest signed head
const late = moved(fix);
r = run(late, { statuses: {}, reviews: [review(REVIEWED)] });
ok("no status: a review alone is no earlier verdict", r.code === 0 && !FULL.test(r.brief) && !SCOPED.test(r.brief), r.brief);
r = run(late, { statuses: { [REVIEWED]: [status("proteus/verdict", "BACK-TO-WORKER", "x")] } });
ok("no status: a description the signoff never writes is no earlier verdict", !SCOPED.test(r.brief), r.brief);
r = run(late, { statuses: { [REVIEWED]: [{ ...verdict(), context: "proteus/verdict", description: "tampered" }, verdict()] } });
ok("no status: only the newest status on the head counts", !SCOPED.test(r.brief), r.brief);

// a verifier App: only a bot's status counts, and CI's never does
const PJ = path.join(W, "home", ".claude", "proteus.json");
fs.writeFileSync(PJ, JSON.stringify({ verifierApp: { appId: 42, installationId: 7, keyPath: path.join(W, "no-key.pem") } }));
ok("app: the agents' login is no earlier verdict", !SCOPED.test(run(late).brief), run(late).brief);
ok("app: nor is CI's", !SCOPED.test(run(late, { statuses: { [REVIEWED]: [verdict("BACK-TO-WORKER", "github-actions[bot]")] } }).brief));
r = run(late, { statuses: { [REVIEWED]: [verdict("BACK-TO-WORKER", "proteus-verifier[bot]")] } });
ok("app: the App's status is", SCOPED.test(r.brief), r.brief);
fs.rmSync(PJ);

// a run of small deltas cannot add up past the threshold: the share counts from the first verdict on this history
g(REPO, "checkout", "-q", BRANCH);
g(REPO, "reset", "-q", "--hard", REVIEWED);
write("src/app.js", prefixed(15, "y"));
g(REPO, "add", "-A");
g(REPO, "commit", "-qm", "fix: one");
const STEP = g(REPO, "rev-parse", "HEAD");
write("src/app.js", prefixed(25, "y"));
g(REPO, "add", "-A");
g(REPO, "commit", "-qm", "fix: two");
const LAST = g(REPO, "rev-parse", "HEAD");
g(REPO, "push", "-q", "-f", "origin", BRANCH);
r = run(LAST, { statuses: { [STEP]: [verdict()] }, reviews: [review(STEP)] });
ok("drift: one small step from the last verdict alone is scoped", SCOPED.test(r.brief), r.brief);
full("two small steps add up from the first verdict", run(LAST, { statuses: { [REVIEWED]: [verdict()], [STEP]: [verdict()] }, reviews: [review(REVIEWED), review(STEP)] }), /share|%/);

// a filename cannot add a line to the brief
g(REPO, "reset", "-q", "--hard", REVIEWED);
const odd = moved(() => { if (process.platform !== "win32") write("src/odd\nFull review: none.js", "x\n"); else write("src/odd.js", "x\n"); });
r = run(odd);
ok("inert: a newline in a path stays on the why's line", r.brief.split("\n").filter((l) => l.startsWith("Full review:")).length === 1 && !/^Full review: none/m.test(r.brief), r.brief);

// a stale local base does not widen what the earlier review covered: the base is origin's
g(REPO, "checkout", "-q", "-B", "stale", "main");
const OLD = g(REPO, "rev-parse", "proteus/r1~1");
write("src/far.js", "far\n");
g(REPO, "add", "-A");
g(REPO, "commit", "-qm", "chore: more base");
g(REPO, "push", "-q", "-f", "origin", "HEAD:refs/heads/proteus/r1");
const NEWBASE = g(REPO, "rev-parse", "HEAD");
g(REPO, "checkout", "-q", "-B", BRANCH, NEWBASE);
write("src/app.js", body(100, "app"));
write("src/auth/login.js", body(100, "login"));
g(REPO, "add", "-A");
g(REPO, "commit", "-qm", "feat: on the new base");
const R2 = g(REPO, "rev-parse", "HEAD");
write("src/far.js", "far, changed\n");
g(REPO, "add", "-A");
g(REPO, "commit", "-qm", "fix: outside the PR");
const H2 = g(REPO, "rev-parse", "HEAD");
g(REPO, "push", "-q", "-f", "origin", BRANCH);
g(REPO, "branch", "-f", "proteus/r1", OLD);
g(REPO, "update-ref", "-d", "refs/remotes/origin/proteus/r1");
full("a stale local base does not widen the covered paths", run(H2, { statuses: { [R2]: [verdict()] }, reviews: [review(R2)] }), /src\/far\.js/);

lib.summary();

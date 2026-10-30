#!/usr/bin/env node
// fake gh for the hook tests: canned JSON by argument pattern; FAKE_GH=fail → exit 1. FAKE_GH_LOGIN is the authenticated
// login (default human), FAKE_GH_COMMENTS the comments of issue 30; with FAKE_GH_COUNTER (a file) its first view has none.
// Under GH_CONFIG_DIR the login is the one `auth login` wrote there (FAKE_GH_BOT_LOGIN, default bot), else none.
// FAKE_GH_STATE (a JSON file) holds repo o/r for --protect: the bot's permission, its invitation, the rulesets;
// FAKE_GH_REPO names another repo to `repo view -q .nameWithOwner` there.
// FAKE_GH_VISIBILITY answers `repo view --json visibility`; FAKE_GH_LOG (a file) gets every call's arguments.
// FAKE_GH_RUN (a JSON file) holds a run's issues, PRs and run logs for the close report.
// FAKE_GH_PERMISSION answers `repo view --json viewerPermission` (install.js --project's and --plugin-setup's guest-mode check).
const a = process.argv.slice(2).join(" ");
if (process.env.FAKE_GH_LOG) require("fs").appendFileSync(process.env.FAKE_GH_LOG, a + "\n");
if (process.env.FAKE_GH === "fail") { process.stderr.write("gh: no remote\n"); process.exit(1); }
// FAKE_GH_LIMIT=N (with FAKE_GH_LIMIT_FILE, a counter file): the first N calls fail like a secondary rate limit, then succeed;
// FAKE_GH_LIMIT_MSG overrides the message ("403" is a plain permission error). An `issue comment` success prints a URL.
if (process.env.FAKE_GH_LIMIT) {
  const fs = require("fs"), f = process.env.FAKE_GH_LIMIT_FILE;
  const n = (parseInt(fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "0", 10) || 0) + 1;
  fs.writeFileSync(f, String(n));
  if (n <= +process.env.FAKE_GH_LIMIT) { process.stderr.write((process.env.FAKE_GH_LIMIT_MSG || "gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)") + "\n"); process.exit(1); }
  if (/^(issue|pr) comment /.test(a)) { process.stdout.write("https://github.com/o/r/issues/1#issuecomment-1\n"); process.exit(0); }
}
const out = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };
if (process.env.FAKE_GH_VISIBILITY && a === "repo view --json visibility -q .visibility") { process.stdout.write(process.env.FAKE_GH_VISIBILITY + "\n"); process.exit(0); }
if (process.env.FAKE_GH_PERMISSION && a === "repo view --json viewerPermission -q .viewerPermission") { process.stdout.write(process.env.FAKE_GH_PERMISSION + "\n"); process.exit(0); }
if (a === "--version" || a === "auth status") { process.stdout.write("gh fake\n"); process.exit(0); }
const CD = process.env.GH_CONFIG_DIR;
if (CD) {
  const fs = require("fs"), path = require("path"), hosts = path.join(CD, "hosts.yml");
  if (a.startsWith("auth login ")) { fs.writeFileSync(hosts, process.env.FAKE_GH_BOT_LOGIN || "bot"); process.exit(0); }
  if (a.startsWith("auth logout ")) { fs.rmSync(hosts, { force: true }); process.exit(0); }
  if (!fs.existsSync(hosts)) { process.stderr.write("gh: not logged in\n"); process.exit(1); }
  if (/^api user --jq \.login$/.test(a)) { process.stdout.write(fs.readFileSync(hosts, "utf8") + "\n"); process.exit(0); }
}
// FAKE_GH_PRS (a JSON file [{number, base, head, title, body}]): `pr list --head <b> --state open --json number -q .[].number`
// prints that head's PR numbers; `pr create --base <b> --head <h> --title <t> --body-file -` adds one, its body from stdin
// (FAKE_GH_PR_CREATE=fail: it fails instead)
if (process.env.FAKE_GH_PR_CREATE === "fail" && a.startsWith("pr create ")) { process.stderr.write("gh: pull request create failed\n"); process.exit(1); }
if (process.env.FAKE_GH_PRS) {
  const fs = require("fs"), file = process.env.FAKE_GH_PRS, prs = JSON.parse(fs.readFileSync(file, "utf8"));
  let m;
  if ((m = /^pr list --head (\S+) --state open --json number -q \.\[\]\.number$/.exec(a))) { process.stdout.write(prs.filter((p) => p.head === m[1]).map((p) => `${p.number}\n`).join("")); process.exit(0); }
  if ((m = /^pr create --base (\S+) --head (\S+) --title (.+) --body-file -$/.exec(a))) {
    const number = 100 + prs.length;
    prs.push({ number, base: m[1], head: m[2], title: m[3], body: fs.readFileSync(0, "utf8") });
    fs.writeFileSync(file, JSON.stringify(prs));
    process.stdout.write(`https://github.com/o/r/pull/${number}\n`);
    process.exit(0);
  }
}
// FAKE_GH_ISSUES (a JSON file {<n>: {title, labels: [name], comments: [{author: {login}, body}], milestone, state}}) answers an
// issue's title, labels, comments and milestone (a title; state defaults to OPEN); `issue comment <n> --body-file -` appends
// stdin as a comment by the current login and prints its URL; `issue list --state all --search <q> in:title` matches titles
// containing <q>, `issue list --label <l> --state open --milestone <m>` an open milestone's issues so labelled, and
// `issue create --title` adds the next number
if (process.env.FAKE_GH_ISSUES) {
  const fs = require("fs"), path = require("path"), file = process.env.FAKE_GH_ISSUES;
  const s = JSON.parse(fs.readFileSync(file, "utf8"));
  const say = (t) => { process.stdout.write(t + "\n"); process.exit(0); };
  let m;
  if ((m = /^issue list --state all --search (.+) in:title --json number,title$/.exec(a))) out(Object.keys(s).filter((n) => (s[n].title || "").includes(m[1])).map((n) => ({ number: +n, title: s[n].title })));
  if ((m = /^issue create --title (.+) --body-file -$/.exec(a))) {
    const n = Math.max(0, ...Object.keys(s).map(Number)) + 1;
    s[n] = { title: m[1], body: fs.readFileSync(0, "utf8"), comments: [] };
    fs.writeFileSync(file, JSON.stringify(s));
    say(`https://github.com/o/r/issues/${n}`);
  }
  if ((m = /^issue view (\d+) --json title -q \.title$/.exec(a)) && s[m[1]]) say(s[m[1]].title || "");
  if ((m = /^issue view (\d+) --json labels -q \.labels\[\]\.name$/.exec(a)) && s[m[1]]) say((s[m[1]].labels || []).join("\n"));
  if ((m = /^issue view (\d+) --json comments$/.exec(a)) && s[m[1]]) out({ comments: s[m[1]].comments || [] });
  const asGh = (n) => ({ number: +n, title: s[n].title || "", state: s[n].state || "OPEN", labels: (s[n].labels || []).map((name) => ({ name })), milestone: s[n].milestone ? { title: s[n].milestone } : null });
  if ((m = /^issue view (\d+) --json comments,labels,milestone$/.exec(a)) && s[m[1]]) { const { labels, milestone } = asGh(m[1]); out({ comments: s[m[1]].comments || [], labels, milestone }); }
  if ((m = /^issue list --label (\S+) --state open --milestone (.+) --json number,title,state,milestone,labels --limit 500$/.exec(a))) {
    out(Object.keys(s).map(asGh).filter((i) => i.state === "OPEN" && i.milestone && i.milestone.title === m[2] && i.labels.some((l) => l.name === m[1])));
  }
  if ((m = /^issue comment (\d+) --body-file -$/.exec(a)) && s[m[1]]) {
    const login = CD ? fs.readFileSync(path.join(CD, "hosts.yml"), "utf8").trim() : process.env.FAKE_GH_LOGIN || "human";
    const c = s[m[1]].comments = s[m[1]].comments || [];
    c.push({ author: { login }, body: fs.readFileSync(0, "utf8") });
    fs.writeFileSync(file, JSON.stringify(s));
    say(`https://github.com/o/r/issues/${m[1]}#issuecomment-${c.length}`);
  }
}
if (process.env.FAKE_GH_STATE && require("fs").existsSync(process.env.FAKE_GH_STATE)) {
  const fs = require("fs"), file = process.env.FAKE_GH_STATE;
  const s = JSON.parse(fs.readFileSync(file, "utf8"));
  const save = () => fs.writeFileSync(file, JSON.stringify(s));
  const body = () => JSON.parse(fs.readFileSync(0, "utf8"));
  let m;
  if (/^repo view --json nameWithOwner,viewerPermission$/.test(a)) out({ nameWithOwner: "o/r", viewerPermission: s.viewer || "ADMIN" });
  if (/^repo view --json nameWithOwner$/.test(a)) out({ nameWithOwner: "o/r" });
  if (/^repo view --json nameWithOwner -q \.nameWithOwner$/.test(a)) { process.stdout.write((process.env.FAKE_GH_REPO || "o/r") + "\n"); process.exit(0); }
  if (/^api repos\/o\/r\/collaborators\/\w+\/permission --jq \.permission$/.test(a)) { process.stdout.write((s.perm || "none") + "\n"); process.exit(0); }
  if (/^api -X PUT repos\/o\/r\/collaborators\/\w+ -f permission=push$/.test(a)) { s.invited = true; save(); out({ id: 5 }); }
  if (a === "api user/repository_invitations") out(CD && s.invited ? [{ id: 5, repository: { full_name: "o/r" } }] : []);
  if (CD && a === "api -X PATCH user/repository_invitations/5") { s.invited = false; s.perm = "write"; save(); process.exit(0); }
  if (a === "api repos/o/r/rulesets") out(s.rulesets || []);
  if (a === "api -X POST repos/o/r/rulesets --input -") { s.rulesets = [...(s.rulesets || []), { id: 9, ...body() }]; save(); out({ id: 9 }); }
  if ((m = /^api -X PUT repos\/o\/r\/rulesets\/(\d+) --input -$/.exec(a))) { s.rulesets = (s.rulesets || []).map((r) => (r.id === +m[1] ? { id: r.id, ...body() } : r)); s.puts = (s.puts || 0) + 1; save(); out({ id: +m[1] }); }
  if (a === "api repos/o/r/rules/branches/proteus%2Fprobe") out((s.rulesets || []).filter((r) => r.conditions.ref_name.include.includes("refs/heads/proteus/*")).flatMap((r) => r.rules));
}
// FAKE_GH_PR (a JSON file {head, branch, base, files, routing, statuses: {<sha>: [...]}, fail}) answers a PR's head, its branch and
// base, its changed files, the base's teams/ROUTING.md (routing, as text) and its commit statuses, and records a posted status
// (newest first, as GitHub lists them, with the GH_TOKEN it was posted under); fail names a call that errors
if (process.env.FAKE_GH_PR) {
  const fs = require("fs"), file = process.env.FAKE_GH_PR;
  const s = JSON.parse(fs.readFileSync(file, "utf8"));
  const R = "(?:o/r|\\{owner\\}/\\{repo\\})";
  const no = (k) => { if (s.fail === k) { process.stderr.write(`gh: ${k} failed (HTTP 500)\n`); process.exit(1); } };
  let m;
  if (/^pr view \d+ --json headRefOid -q \.headRefOid$/.test(a)) { no("view"); process.stdout.write(s.head + "\n"); process.exit(0); }
  if (/^pr view \d+ --json headRefName -q \.headRefName$/.test(a)) { no("branch"); process.stdout.write((s.branch || "") + "\n"); process.exit(0); }
  if (/^pr view \d+ --json baseRefName -q \.baseRefName$/.test(a)) { no("base"); process.stdout.write((s.base || "main") + "\n"); process.exit(0); }
  if (/^repo view --json nameWithOwner -q \.nameWithOwner$/.test(a)) { no("repo"); process.stdout.write("o/r\n"); process.exit(0); }
  if (new RegExp(`^api repos/${R}/contents/teams/ROUTING\\.md\\?ref=[\\w%./-]+ -q \\.content$`).test(a)) {
    if (typeof s.routing !== "string") { process.stderr.write("gh: Not Found (HTTP 404)\n"); process.exit(1); }
    process.stdout.write(Buffer.from(s.routing).toString("base64").replace(/.{60}/g, "$&\n") + "\n");
    process.exit(0);
  }
  if ((m = new RegExp(`^api repos/${R}/commits/([0-9a-f]{40})/statuses$`).exec(a))) { no("statuses"); out((s.statuses || {})[m[1]] || []); }
  if (new RegExp(`^api --paginate repos/${R}/pulls/\\d+/files --jq `).test(a)) { no("files"); process.stdout.write((s.files || []).join("\n") + "\n"); process.exit(0); }
  if ((m = new RegExp(`^api repos/${R}/commits/([0-9a-f]{40})/status$`).exec(a))) {
    const seen = new Set();
    out({ statuses: ((s.statuses || {})[m[1]] || []).filter((x) => !seen.has(x.context) && seen.add(x.context)) });
  }
  if ((m = new RegExp(`^api -X POST repos/${R}/statuses/([0-9a-f]{40}) -f state=(\\w+) -f context=(\\S+) -f description=(.*) --jq \\.state$`).exec(a))) {
    no("post");
    s.statuses = s.statuses || {};
    s.statuses[m[1]] = [{ state: m[2], context: m[3], description: m[4], ...(process.env.GH_TOKEN && { token: process.env.GH_TOKEN }) }, ...(s.statuses[m[1]] || [])];
    fs.writeFileSync(file, JSON.stringify(s));
    process.stdout.write(m[2] + "\n");
    process.exit(0);
  }
}
const iso = (h) => new Date(Date.UTC(2026, 8, 1) + h * 3600e3).toISOString();
// FAKE_GH_RUN (a JSON file {issues, prs, logs}) answers the close report's three list calls, and a run log's body and
// comments (its logs entry's body and comments) for proteus-goal.js
if (process.env.FAKE_GH_RUN) {
  const s = JSON.parse(require("fs").readFileSync(process.env.FAKE_GH_RUN, "utf8"));
  const v = /^issue view (\d+) --json body,comments$/.exec(a), log = v && (s.logs || []).find((l) => l.number === +v[1]);
  if (log) out({ body: log.body || "", comments: log.comments || [] });
  if (a.startsWith("issue list --label proteus-log ")) out(s.logs || []);
  if (a.startsWith("issue list --label proteus --state all ")) out(s.issues || []);
  if (a.startsWith("pr list --base ")) out(s.prs || []);
}
// FAKE_GH_NEXT (a JSON file {issues, prs, reviews, inbox, statuses: {<sha>: [status]}}) answers proteus.js next: the run's
// issues, the open PRs into the run branch, the open review issues, the open needs-human issues and a commit's statuses
if (process.env.FAKE_GH_NEXT) {
  const s = JSON.parse(require("fs").readFileSync(process.env.FAKE_GH_NEXT, "utf8"));
  let m;
  if (a.startsWith("issue list --label proteus --state all --json ")) out(s.issues || []);
  if (/^pr list --base \S+ --state open --json /.test(a)) out(s.prs || []);
  if (a.startsWith("issue list --label proteus-review --state open --json milestone ")) out(s.reviews || []);
  if (a.startsWith("issue list --label needs-human --state open --json ")) out(s.inbox || []);
  if ((m = /^api repos\/\{owner\}\/\{repo\}\/commits\/(\w+)\/statuses$/.exec(a))) out((s.statuses || {})[m[1]] || []);
}
// FAKE_GH_MERGE (a JSON file {origin, issues, prs: [{number, headRefName, baseRefName, body, statusCheckRollup}]}) answers
// proteus-merge.js: the open PRs, the run's issues, and `pr merge` as a real merge commit in the origin repo (git merge-tree);
// a conflicting one fails and its `mergeable` turns CONFLICTING; `pr view --json headRefName,state` is MERGED once merged
if (process.env.FAKE_GH_MERGE) {
  const fs = require("fs"), { spawnSync } = require("child_process"), file = process.env.FAKE_GH_MERGE;
  const s = JSON.parse(fs.readFileSync(file, "utf8"));
  const git = (...args) => spawnSync("git", ["-C", s.origin, ...args], { encoding: "utf8" });
  let m;
  if (/^pr list --base \S+ --state open --json /.test(a)) out(s.prs.filter((p) => !p.merged));
  if (a.startsWith("issue list --label proteus --state all --json number,state,body ")) out(s.issues || []);
  if ((m = /^pr view (\d+) --json mergeable -q \.mergeable$/.exec(a))) { process.stdout.write((s.prs.find((p) => p.number === +m[1]) || {}).mergeable || "MERGEABLE"); process.exit(0); }
  if ((m = /^pr view (\d+) --json headRefName,state$/.exec(a))) {
    const p = s.prs.find((x) => x.number === +m[1]);
    if (!p) { process.stderr.write(`GraphQL: Could not resolve to a PullRequest with the number of ${m[1]}.\n`); process.exit(1); }
    out({ headRefName: p.headRefName, state: p.merged ? "MERGED" : "OPEN" });
  }
  if ((m = /^pr merge (\d+) --merge$/.exec(a))) {
    const p = s.prs.find((x) => x.number === +m[1]);
    const tree = git("merge-tree", "--write-tree", `refs/heads/${p.baseRefName}`, `refs/heads/${p.headRefName}`);
    if (tree.status !== 0) {
      p.mergeable = "CONFLICTING";
      fs.writeFileSync(file, JSON.stringify(s));
      process.stderr.write(`X Pull request o/r#${p.number} is not mergeable: the merge commit cannot be cleanly created.\n`);
      process.exit(1);
    }
    const c = git("commit-tree", tree.stdout.split("\n")[0], "-p", `refs/heads/${p.baseRefName}`, "-p", `refs/heads/${p.headRefName}`, "-m", `Merge pull request #${p.number} from o/${p.headRefName}`).stdout.trim();
    git("update-ref", `refs/heads/${p.baseRefName}`, c);
    git("branch", "-D", p.headRefName);
    p.merged = true;
    fs.writeFileSync(file, JSON.stringify(s));
    process.exit(0);
  }
}
if (/^api user --jq \.login$/.test(a)) { process.stdout.write((process.env.FAKE_GH_LOGIN || "human") + "\n"); process.exit(0); }
if (/issue view 30 --json comments/.test(a)) {
  const fs = require("fs"), c = process.env.FAKE_GH_COUNTER;
  const n = c ? (parseInt(fs.existsSync(c) ? fs.readFileSync(c, "utf8") : "0", 10) || 0) + 1 : 2;
  if (c) fs.writeFileSync(c, String(n));
  out({ comments: n === 1 ? [] : JSON.parse(process.env.FAKE_GH_COMMENTS || "[]") });
}
if (/issue list --label proteus-log/.test(a)) out([{ number: 7, title: "Run: bl1077" }]);
if (/issue view 7 --json comments/.test(a)) out({ comments: Array.from({ length: 15 }, (_, i) => ({ body: `decision ${i + 1}: ` + "x".repeat(i === 14 ? 50 : 300) })) });
if (/issue list --label needs-human/.test(a)) out([
  { number: 21, title: "Q: bl1077: which db", labels: [{ name: "proteus-question" }, { name: "needs-human" }] },
  { number: 23, title: "Q: bl1077: colour", labels: [{ name: "proteus-question" }, { name: "needs-human" }] },
  { number: 22, title: "Review: bl1077/lighting", labels: [{ name: "proteus-review" }, { name: "needs-human" }] },
]);
if (/issue list --label proteus --state all/.test(a)) {
  const ms = { number: 3, title: "bl1077/lighting" };
  out([
    { number: 1, state: "CLOSED", createdAt: iso(0), closedAt: iso(0.5), milestone: ms, labels: [{ name: "proteus" }] },
    { number: 2, state: "CLOSED", createdAt: iso(0), closedAt: iso(0.75), milestone: ms, labels: [{ name: "proteus" }] },
    { number: 3, state: "CLOSED", createdAt: iso(1), closedAt: iso(1.5), milestone: ms, labels: [{ name: "proteus" }] },
    { number: 4, state: "OPEN", createdAt: iso(2), closedAt: null, milestone: ms, labels: [{ name: "proteus" }] },
    { number: 5, state: "OPEN", createdAt: iso(2), closedAt: null, milestone: ms, labels: [{ name: "proteus" }] },
    { number: 6, state: "OPEN", createdAt: iso(2), closedAt: null, milestone: ms, labels: [{ name: "proteus" }] },
    { number: 9, state: "OPEN", createdAt: iso(2), closedAt: null, milestone: ms, labels: [{ name: "proteus-review" }] },
    { number: 7, state: "OPEN", createdAt: iso(0), closedAt: null, milestone: null, labels: [{ name: "proteus-log" }] },
  ]);
}
if (/pr list --base proteus\/bl1077/.test(a)) out([
  { number: 40, headRefName: "proteus/bl1077-4", reviews: [{ body: "MERGE" }], comments: [] },
  { number: 41, headRefName: "proteus/bl1077-5", reviews: [], comments: [{ body: "working" }] },
]);
process.stderr.write("fake gh: unhandled " + a + "\n");
process.exit(1);

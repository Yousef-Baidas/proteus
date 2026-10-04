#!/usr/bin/env node
// fake gh for the hook tests: canned JSON by argument pattern; FAKE_GH=fail → exit 1. FAKE_GH_LOGIN is the authenticated
// login (default human), FAKE_GH_COMMENTS the comments of issue 30; with FAKE_GH_COUNTER (a file) its first view has none.
// Under GH_CONFIG_DIR the login is the one `auth login` wrote there (FAKE_GH_BOT_LOGIN, default bot), else none.
// FAKE_GH_STATE (a JSON file) holds repo o/r for --protect: the bot's permission, its invitation, the rulesets.
// FAKE_GH_VISIBILITY answers `repo view --json visibility`; FAKE_GH_LOG (a file) gets every call's arguments.
// FAKE_GH_RUN (a JSON file) holds a run's issues, PRs and run logs for the close report.
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
if (a === "--version" || a === "auth status") { process.stdout.write("gh fake\n"); process.exit(0); }
const CD = process.env.GH_CONFIG_DIR;
if (CD) {
  const fs = require("fs"), path = require("path"), hosts = path.join(CD, "hosts.yml");
  if (a.startsWith("auth login ")) { fs.writeFileSync(hosts, process.env.FAKE_GH_BOT_LOGIN || "bot"); process.exit(0); }
  if (a.startsWith("auth logout ")) { fs.rmSync(hosts, { force: true }); process.exit(0); }
  if (!fs.existsSync(hosts)) { process.stderr.write("gh: not logged in\n"); process.exit(1); }
  if (/^api user --jq \.login$/.test(a)) { process.stdout.write(fs.readFileSync(hosts, "utf8") + "\n"); process.exit(0); }
}
if (process.env.FAKE_GH_STATE && require("fs").existsSync(process.env.FAKE_GH_STATE)) {
  const fs = require("fs"), file = process.env.FAKE_GH_STATE;
  const s = JSON.parse(fs.readFileSync(file, "utf8"));
  const save = () => fs.writeFileSync(file, JSON.stringify(s));
  const body = () => JSON.parse(fs.readFileSync(0, "utf8"));
  let m;
  if (/^repo view --json nameWithOwner,viewerPermission$/.test(a)) out({ nameWithOwner: "o/r", viewerPermission: s.viewer || "ADMIN" });
  if (/^repo view --json nameWithOwner$/.test(a)) out({ nameWithOwner: "o/r" });
  if (/^repo view --json nameWithOwner -q \.nameWithOwner$/.test(a)) { process.stdout.write("o/r\n"); process.exit(0); }
  if (/^api repos\/o\/r\/collaborators\/\w+\/permission --jq \.permission$/.test(a)) { process.stdout.write((s.perm || "none") + "\n"); process.exit(0); }
  if (/^api -X PUT repos\/o\/r\/collaborators\/\w+ -f permission=push$/.test(a)) { s.invited = true; save(); out({ id: 5 }); }
  if (a === "api user/repository_invitations") out(CD && s.invited ? [{ id: 5, repository: { full_name: "o/r" } }] : []);
  if (CD && a === "api -X PATCH user/repository_invitations/5") { s.invited = false; s.perm = "write"; save(); process.exit(0); }
  if (a === "api repos/o/r/rulesets") out(s.rulesets || []);
  if (a === "api -X POST repos/o/r/rulesets --input -") { s.rulesets = [...(s.rulesets || []), { id: 9, ...body() }]; save(); out({ id: 9 }); }
  if ((m = /^api -X PUT repos\/o\/r\/rulesets\/(\d+) --input -$/.exec(a))) { s.rulesets = (s.rulesets || []).map((r) => (r.id === +m[1] ? { id: r.id, ...body() } : r)); s.puts = (s.puts || 0) + 1; save(); out({ id: +m[1] }); }
  if (a === "api repos/o/r/rules/branches/proteus%2Fprobe") out((s.rulesets || []).filter((r) => r.conditions.ref_name.include.includes("refs/heads/proteus/*")).flatMap((r) => r.rules));
}
const iso = (h) => new Date(Date.UTC(2026, 8, 1) + h * 3600e3).toISOString();
// FAKE_GH_RUN (a JSON file {issues, prs, logs}) answers the close report's three list calls
if (process.env.FAKE_GH_RUN) {
  const s = JSON.parse(require("fs").readFileSync(process.env.FAKE_GH_RUN, "utf8"));
  if (/^issue list --label (proteus|hive)-log /.test(a)) out(s.logs || []);
  if (/^issue list --label (proteus|hive) --state all /.test(a)) out(s.issues || []);
  if (a.startsWith("pr list --base ")) out(s.prs || []);
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

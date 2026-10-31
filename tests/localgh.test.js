// The gh stand-in, proteus-local.js (#310): node tests/localgh.test.js. Each command and flag the repo uses, each filter
// form, the refusals (an unsupported command or filter, a malformed store, a link on the path, a run outside local
// mode), parallel creates, launcher quoting, and lib.gh reaching the stand-in in local mode while unchanged outside it.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const SRC = path.join(__dirname, "..", "templates", "hooks");
const lib = require(path.join(__dirname, "lib.js"));
const { ok } = lib;
const W = lib.workdir("localgh");
const LOCAL = path.join(SRC, "proteus-local.js");
const local = require(LOCAL);

const repo = (name) => {
  const dir = path.join(W, name);
  fs.mkdirSync(dir, { recursive: true });
  lib.g(dir, "init", "-q");
  return dir;
};
const R = repo("main");
const T = path.join(R, ".git", "proteus-local", "tracker");
const gh = (args, { input = "", cwd = R } = {}) => lib.run(LOCAL, input, { cwd, args, env: { CLAUDE_PROJECT_DIR: cwd } });
const sh = (s) => s.split(" ");
const json = (r) => { try { return JSON.parse(r.out); } catch { return null; } };

// ---- outside local mode
let r = gh(["issue", "list"]);
ok("outside local mode: non-zero, names why, never a real gh", r.code === 1 && /not in local mode/.test(r.err) && !r.out, r.err);

// ---- init
r = gh(["--init"]);
ok("--init: exit 0", r.code === 0, r.err);
for (const f of ["mode", "bin/gh", "bin/gh.cmd", "tracker/meta.json", "tracker/labels.json", "tracker/milestones.json"]) ok(`--init made ${f}`, fs.existsSync(path.join(R, ".git", "proteus-local", f)));
ok("--init: idempotent, the store kept", (() => {
  gh(["label", "create", "keep"]);
  const again = gh(["--init"]);
  return again.code === 0 && gh(["label", "list", "--json", "name", "-q", ".[].name"]).out.trim() === "keep";
})());

// ---- auth, repo, api user
r = gh(sh("auth status"));
ok("auth status: succeeds and says local mode", r.code === 0 && /local mode/.test(r.out), r.err);
const NAME = gh(sh("repo view --json nameWithOwner -q .nameWithOwner")).out.trim();
ok("repo view: a stable local name in gh's owner/name form", /^[\w.-]+\/[\w.-]+$/.test(NAME) && NAME === `local/main`, NAME);
ok("repo view: visibility and permission", gh(sh("repo view --json visibility -q .visibility")).out.trim() === "PRIVATE" && gh(sh("repo view --json viewerPermission -q .viewerPermission")).out.trim() === "ADMIN");
ok("repo view: another repo is not reachable", gh(["repo", "view", "o/other"]).code === 1);
ok("api user --jq .login prints the fixed login", gh(["api", "user", "--jq", ".login"]).out === "local\n");
ok("api user: JSON without a filter", json(gh(["api", "user"])).login === "local");

// ---- labels
ok("label create: a new one", gh(["label", "create", "proteus", "--color", "#abcdef", "--description", "the run"]).code === 0);
r = gh(["label", "create", "proteus"]);
ok("label create: a second time fails as gh's does", r.code === 1 && /exists/.test(r.err), r.err);
ok("label create --force: updates", gh(["label", "create", "proteus", "--force", "--description", "new"]).code === 0);
ok("label create: a bad color is refused", gh(["label", "create", "x", "--color", "nope"]).code === 1);
gh(["label", "create", "needs-human"]); gh(["label", "create", "profile:a"]);
r = json(gh(["label", "list", "--json", "name,color,description", "--limit", "100"]));
ok("label list --json: fields and values", r.length === 4 && r.find((l) => l.name === "proteus").color === "abcdef" && r.find((l) => l.name === "proteus").description === "new", JSON.stringify(r));
ok("label list --limit", json(gh(["label", "list", "--json", "name", "--limit", "1"])).length === 1);

// ---- milestones
r = gh(["api", "repos/{owner}/{repo}/milestones", "-f", "title=run/m1", "--jq", ".number"]);
ok("api milestones -f title: creates one, POST implied", r.code === 0 && r.out === "1\n", r.err);
ok("api milestones: a duplicate title fails", gh(["api", "repos/{owner}/{repo}/milestones", "-f", "title=run/m1"]).code === 1);
ok("api milestones: an unknown field is not supported", gh(["api", "repos/{owner}/{repo}/milestones", "-f", "title=x", "-f", "due_on=y"]).code === 1);
gh(["api", `repos/${NAME}/milestones`, "-X", "POST", "-f", "title=run/m2", "-f", "description=d"]);
r = json(gh(["api", "--paginate", "repos/{owner}/{repo}/milestones?state=all"]));
ok("api milestones GET --paginate: both, state lowercase", r.length === 2 && r[1].title === "run/m2" && r[1].description === "d" && r[0].state === "open" && r[0].open_issues === 0, JSON.stringify(r));

// ---- issues
r = gh(["issue", "create", "--title", "t1", "--body", "b1", "--label", "proteus,needs-human", "--milestone", "run/m1"]);
ok("issue create: prints a URL ending /issues/<n>", r.code === 0 && r.out.endsWith("/issues/1\n"), r.out + r.err);
r = gh(["issue", "create", "--title", "t2", "--body-file", "-", "-l", "proteus"], { input: "from stdin\n" });
ok("issue create --body-file -: reads stdin, and numbers rise", r.out.endsWith("/issues/2\n"), r.out + r.err);
const BF = path.join(W, "body with space.md");
fs.writeFileSync(BF, "from file\n");
r = gh(["issue", "create", "-t", "Intake: 2026-01-01", "--body-file", BF]);
ok("issue create --body-file <path>", r.out.endsWith("/issues/3\n"), r.err);
ok("issue create: an unknown label fails, as gh's does", gh(["issue", "create", "--title", "x", "--body", "y", "--label", "nope"]).code === 1);
ok("issue create: an unknown milestone fails", gh(["issue", "create", "--title", "x", "--body", "y", "--milestone", "nope"]).code === 1);
ok("issue create: without a body fails", gh(["issue", "create", "--title", "x"]).code === 1);
ok("issue create: a body too long is refused", gh(["issue", "create", "--title", "x", "--body-file", "-"], { input: "x".repeat(70000) }).code === 1);
r = json(gh(["issue", "view", "1", "--json", "number,title,state,milestone,labels,body,url,author,createdAt,closedAt,comments"]));
ok("issue view --json: gh's shape", r.number === 1 && r.title === "t1" && r.state === "OPEN" && r.body === "b1" && r.closedAt === null && r.milestone.title === "run/m1" && r.milestone.number === 1 && r.labels[0].name === "proteus" && typeof r.labels[0].color === "string" && r.author.login === "local" && Array.isArray(r.comments) && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(r.createdAt), JSON.stringify(r));
ok("issue view: only the fields asked for", Object.keys(json(gh(["issue", "view", "1", "--json", "title"]))).join() === "title");
ok("issue view -q .title", gh(["issue", "view", "1", "--json", "title", "-q", ".title"]).out === "t1\n");
ok("issue view -q .labels[].name", gh(["issue", "view", "1", "--json", "labels", "-q", ".labels[].name"]).out === "proteus\nneeds-human\n");
ok("issue view --json -q .body", gh(["issue", "view", "2", "--json", "body", "-q", ".body"]).out === "from stdin\n\n");
ok("issue view: text without --json", gh(["issue", "view", "1"]).out.startsWith("title:\tt1\n"));
ok("issue view: a missing issue fails", gh(["issue", "view", "99"]).code === 1);
ok("issue view: a bad JSON field fails", gh(["issue", "view", "1", "--json", "nope"]).code === 1);
ok("issue view: --jq without --json fails", gh(["issue", "view", "1", "--jq", ".title"]).code === 1);
ok("issue view: takes a URL", json(gh(["issue", "view", "local://x/issues/2", "--json", "number"])).number === 2);

const list = (...a) => json(gh(["issue", "list", ...a, "--json", "number"])).map((i) => i.number).join();
ok("issue list: open by default, newest first", list() === "3,2,1", list());
ok("issue list --label", list("--label", "proteus") === "2,1");
ok("issue list: two --label are AND", list("--label", "proteus", "--label", "needs-human") === "1");
ok("issue list --milestone", list("--state", "open", "--milestone", "run/m1") === "1");
ok("issue list --limit", list("--limit", "1") === "3");
ok("issue list --search in:title", list("--state", "all", "--search", "Intake: 2026-01-01 in:title") === "3");
ok("issue list --search: no hit", list("--search", "nothing here in:title") === "");
ok("issue list --search: another qualifier is not supported", /not supported/.test(gh(["issue", "list", "--search", "author:x", "--json", "number"]).err));
ok("issue list: a bad --state fails", gh(["issue", "list", "--state", "merged"]).code === 1);
ok("issue list: a missing milestone fails", gh(["issue", "list", "--milestone", "nope"]).code === 1);
ok("issue list: text without --json", gh(["issue", "list"]).out.startsWith("3\tOPEN\tIntake"));

r = gh(["issue", "comment", "1", "--body", "first"]);
ok("issue comment --body: prints the comment URL", r.code === 0 && r.out.endsWith("/issues/1#issuecomment-1\n"), r.out + r.err);
gh(["issue", "comment", "1", "--body-file", "-"], { input: "second" });
r = json(gh(["issue", "view", "1", "--json", "comments"])).comments;
ok("issue view comments: gh's shape, in order", r.length === 2 && r[0].body === "first" && r[1].body === "second" && r[0].author.login === "local" && typeof r[0].createdAt === "string" && typeof r[0].id === "string", JSON.stringify(r));
ok("issue comment: empty is refused", gh(["issue", "comment", "1", "--body", ""]).code === 1);
ok("issue comment: a missing issue fails", gh(["issue", "comment", "99", "--body", "x"]).code === 1);
ok("issue view --comments: text", /first/.test(gh(["issue", "view", "1", "--comments"]).out));
r = gh(["api", "repos/{owner}/{repo}/issues/1/comments", "--jq", ".[].body"]);
ok("api issue comments --jq .[].body", r.out === "first\nsecond\n", r.out + r.err);
ok("api issue comments: REST's shape", json(gh(["api", "--paginate", "repos/{owner}/{repo}/issues/1/comments"]))[0].user.login === "local");
ok("api issue comments: a missing issue is a 404", /404/.test(gh(["api", "repos/{owner}/{repo}/issues/99/comments"]).err));

ok("issue edit --add-label", gh(["issue", "edit", "2", "--add-label", "profile:a"]).code === 0 && list("--label", "profile:a") === "2");
ok("issue edit --remove-label", gh(["issue", "edit", "2", "--remove-label", "profile:a"]).code === 0 && list("--label", "profile:a") === "");
ok("issue edit: an unknown label fails", gh(["issue", "edit", "2", "--add-label", "nope"]).code === 1);
gh(["issue", "edit", "2", "--title", "t2b", "--body", "b2b", "--milestone", "run/m2"]);
r = json(gh(["issue", "view", "2", "--json", "title,body,milestone"]));
ok("issue edit --title --body --milestone", r.title === "t2b" && r.body === "b2b" && r.milestone.title === "run/m2", JSON.stringify(r));
ok("issue edit: nothing to change fails", gh(["issue", "edit", "2"]).code === 1);
ok("issue close", gh(["issue", "close", "2"]).code === 0);
r = json(gh(["issue", "view", "2", "--json", "state,closedAt"]));
ok("issue close: CLOSED with closedAt", r.state === "CLOSED" && typeof r.closedAt === "string");
ok("issue list --state closed and all", list("--state", "closed") === "2" && list("--state", "all") === "3,2,1");
ok("issue reopen", gh(["issue", "reopen", "2"]).code === 0 && json(gh(["issue", "view", "2", "--json", "state,closedAt"])).closedAt === null);
ok("api milestones: counts open issues", json(gh(["api", "repos/{owner}/{repo}/milestones"]))[1].open_issues === 1);

// ---- unsupported
for (const a of [["pr", "list"], ["issue", "transfer", "1"], ["auth", "token"], ["release", "list"], [], ["api", "repos/{owner}/{repo}/pulls"], ["api", "repos/o/other/milestones"], ["api", "-X", "DELETE", "repos/{owner}/{repo}/milestones"]]) {
  r = gh(a);
  ok(`gh ${a.join(" ")}: non-zero, named, no output`, r.code === 1 && /^proteus local mode: gh .* is not supported\n$/.test(r.err) && !r.out, r.code + r.err);
}
r = gh(["issue", "list", "--assignee", "x"]);
ok("an unknown flag: refused and named, never ignored", r.code === 1 && /gh issue list --assignee is not supported/.test(r.err), r.err);
ok("-R to another repo is refused", /not supported/.test(gh(["issue", "create", "-R", "o/other", "--title", "x", "--body", "y"]).err));
ok("-R to this repo works", gh(["issue", "list", "-R", NAME]).code === 0);

// ---- filters
const F = (expr, v) => { try { return local.compile(expr)(v); } catch (e) { return `ERR ${e.message}`; } };
const eq = (name, expr, v, want) => { const got = F(expr, v); ok(`filter ${name}`, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got)); };
const DOC = { a: { b: 1 }, list: [{ n: 1, s: "x" }, { n: 2, s: "y" }], nil: null, t: "text" };
eq("identity", ".", 5, [5]);
eq("path", ".a.b", DOC, [1]);
eq("a missing path is null", ".a.z.y", DOC, [null]);
eq("quoted key", '."a".b', DOC, [1]);
eq("bracket key", '.["a"]', DOC, [{ b: 1 }]);
eq("iterate", ".list[].n", DOC, [1, 2]);
eq("root iterate", ".[]", [1, 2], [1, 2]);
eq("object values", ".a[]", DOC, [1]);
eq("index", ".list[0].s", DOC, ["x"]);
eq("negative index", ".list[-1].n", DOC, [2]);
eq("index past the end", ".list[9]", DOC, [null]);
eq("pipe", ".list | .[1] | .s", DOC, ["y"]);
eq("array construction", "[.list[].n]", DOC, [[1, 2]]);
eq("empty array", "[]", DOC, [[]]);
eq("object fields", "{x: .t, a}", DOC, [{ x: "text", a: { b: 1 } }]);
eq("object string and computed keys", '{"k": 1, (.t): 2}', DOC, [{ k: 1, text: 2 }]);
eq("select ==", '.list[] | select(.s == "y") | .n', DOC, [2]);
eq("select !=", ".list[] | select(.n != 1) | .n", DOC, [2]);
eq("select <", ".list[] | select(.n < 2) | .n", DOC, [1]);
eq("select >=", ".list[] | select(.n >= 2) | .n", DOC, [2]);
eq("and, or, not", ".list[] | select((.n == 1 and .s == \"x\") or (.n == 9)) | .n, (true | not)", DOC, [1, false]);
eq("interpolation", '.list[] | "\\(.n) \\(.s)"', DOC, ["1 x", "2 y"]);
eq("nested interpolation", '"a\\("b\\(.t)")c"', DOC, ["abtextc"]);
eq("string escapes", '"a\\tb\\"\\u0041"', {}, ['a\tb"A']);
eq("alternative", ".nil // 3", DOC, [3]);
eq("alternative keeps a truthy left", ".t // 3", DOC, ["text"]);
eq("alternative with empty", ".x // empty", {}, []);
eq("the PR-files filter from the inventory", ".[] | .filename, (.previous_filename // empty)", [{ filename: "a" }, { filename: "b", previous_filename: "c" }], ["a", "b", "c"]);
eq("[.[].type] from the inventory", "[.[].type]", [{ type: "x" }], [["x"]]);
eq(".[0].conclusion from the inventory", ".[0].conclusion", [{ conclusion: "ok" }], ["ok"]);
eq("length of an array", ".list | length", DOC, [2]);
eq("length of a string and null", "(.t | length), (.nil | length)", DOC, [4, 0]);
eq("map", ".list | map(.n)", DOC, [[1, 2]]);
eq("optional", ".t.x?", DOC, []);
eq("booleans, null, numbers", "true, false, null, 1.5", {}, [true, false, null, 1.5]);
eq("__proto__ is no key", ".__proto__", {}, [null]);
for (const bad of [".a |", "[.a", "foo", "reduce .[] as $x (0; .+$x)", ".a + 1", ".[1:2]", "$x", "if . then 1 else 2 end", '"open', "", "@json", ".a.[0"]) {
  const got = F(bad, DOC);
  if (bad === "") { ok("filter: an empty expression is not supported", typeof got === "string" && /is not supported/.test(got), String(got)); continue; }
  ok(`filter ${bad}: a parse error names the expression`, typeof got === "string" && got.includes("is not supported") && got.includes(JSON.stringify(bad).slice(1, -1)), String(got));
}
ok("filter: a runtime error names the expression", /cannot index/.test(F(".t.x", DOC)) && /"\.t\.x"/.test(F(".t.x", DOC)), F(".t.x", DOC));
ok("render: a string raw, null empty, fraction two places, JSON else", [local.render("x"), local.render(null), local.render(1.5), local.render(2), local.render(true), local.render({ a: 1 }), local.render([1])].join("|") === 'x||1.50|2|true|{"a":1}|[1]');
r = gh(["issue", "list", "--json", "number", "--jq", "reduce x"]);
ok("an unsupported filter on the CLI: non-zero, named, no output", r.code === 1 && /reduce x/.test(r.err) && !r.out, r.err);
r = gh(["api", "user", "--jq", ".nope"]);
ok("a null output prints an empty line, as gh's does", r.code === 0 && r.out === "\n", JSON.stringify(r.out));
r = gh(["api", "repos/{owner}/{repo}/milestones", "-f", "title=never", "--jq", "bad filter"]);
ok("a bad filter on a write: refused before it writes", r.code === 1 && !json(gh(["api", "repos/{owner}/{repo}/milestones"])).some((m) => m.title === "never"), r.err);
r = gh(["issue", "list", "--state", "all", "--limit", "500", "--json", "number,title", "-q", '.[] | select(.number == 1) | "\\(.number) \\(.title)"']);
ok("a filter over a list from the CLI", r.out === "1 t1\n", r.out + r.err);

// ---- parallel runs
(async () => {
  const P = repo("par"), PT = path.join(P, ".git", "proteus-local", "tracker");
  gh(["--init"], { cwd: P });
  const one = (args) => new Promise((res) => {
    const c = spawn(process.execPath, [LOCAL, ...args], { cwd: P, env: { ...lib.ENV, CLAUDE_PROJECT_DIR: P }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "", err = "";
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", (d) => { err += d; });
    c.on("close", (code) => res({ code, out, err }));
  });
  const N = 16;
  const made = await Promise.all(Array.from({ length: N }, (_, i) => one(["issue", "create", "--title", `p${i}`, "--body", "b"])));
  const nums = made.map((m) => (/\/issues\/(\d+)/.exec(m.out) || [])[1]);
  ok("parallel creates: all succeed", made.every((m) => m.code === 0), JSON.stringify(made.filter((m) => m.code).map((m) => m.err)));
  ok("parallel creates: no number used twice", new Set(nums).size === N, nums.join());
  ok("parallel creates: no write lost", json(gh(["issue", "list", "--limit", "100", "--json", "number"], { cwd: P })).length === N);
  const said = await Promise.all(Array.from({ length: 8 }, (_, i) => one(["issue", "comment", "1", "--body", `c${i}`])));
  ok("parallel comments on one issue: none lost", said.every((m) => m.code === 0) && json(gh(["issue", "view", "1", "--json", "comments"], { cwd: P })).comments.length === 8);
  ok("the lock is gone after the runs", !fs.existsSync(path.join(PT, "lock")));

  // ---- the lock
  const lock = path.join(PT, "lock");
  fs.writeFileSync(lock, "crashed");
  const old = new Date(Date.now() - local.LOCK_STALE_MS - 5000);
  fs.utimesSync(lock, old, old);
  r = gh(["issue", "create", "--title", "after", "--body", "b"], { cwd: P });
  ok("a stale lock is broken", r.code === 0 && !fs.existsSync(lock), r.err);
  fs.writeFileSync(lock, "held");
  let ran = false, msg = "";
  try { local.withLock(lock, () => { ran = true; }, 150); } catch (e) { msg = e.message; }
  ok("a fresh lock is not broken: the run stops, names it, and leaves it", !ran && /locked/.test(msg) && fs.readFileSync(lock, "utf8") === "held", msg);
  fs.unlinkSync(lock);

  // ---- never reused
  const metaFile = path.join(PT, "meta.json"), meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
  fs.writeFileSync(metaFile, JSON.stringify({ ...meta, nextNumber: 1 }));
  r = gh(["issue", "create", "--title", "rolled", "--body", "b"], { cwd: P });
  ok("a rolled-back counter reuses no number", new RegExp(`/issues/${meta.nextNumber}\\n$`).test(r.out), r.out + r.err);

  // ---- a malformed store
  const bad = (name, file, text, args) => {
    const before = fs.readFileSync(file);
    fs.writeFileSync(file, text);
    const got = gh(args, { cwd: P });
    ok(`malformed: ${name}: non-zero, names the file, no output`, got.code === 1 && got.err.includes(path.basename(file)) && !got.out, got.err);
    fs.writeFileSync(file, before);
  };
  const I1 = path.join(PT, "issues", "1.json"), issue = JSON.parse(fs.readFileSync(I1, "utf8"));
  const LIST = ["issue", "list", "--json", "number"];
  bad("not JSON", I1, "{", LIST);
  bad("the wrong number", I1, JSON.stringify({ ...issue, number: 2 }), LIST);
  bad("a state outside the set", I1, JSON.stringify({ ...issue, state: "open" }), LIST);
  bad("a title of the wrong type", I1, JSON.stringify({ ...issue, title: 5 }), LIST);
  bad("a bad timestamp", I1, JSON.stringify({ ...issue, createdAt: "yesterday" }), LIST);
  bad("a bad label", I1, JSON.stringify({ ...issue, labels: [1] }), LIST);
  bad("a bad comment", I1, JSON.stringify({ ...issue, comments: [{ id: 0, body: "", createdAt: "x" }] }), LIST);
  bad("an unknown milestone", I1, JSON.stringify({ ...issue, milestone: 77 }), LIST);
  bad("over the size cap", I1, " ".repeat((8 << 20) + 1), LIST);
  bad("bad meta", metaFile, "[]", ["issue", "create", "--title", "x", "--body", "y"]);
  bad("bad labels", path.join(PT, "labels.json"), '[{"name":5}]', ["label", "list"]);
  bad("bad milestones", path.join(PT, "milestones.json"), '{"a":1}', ["api", "repos/{owner}/{repo}/milestones"]);
  ok("a store field outside the schema is dropped on the way out", (() => {
    fs.writeFileSync(I1, JSON.stringify({ ...issue, evil: "x" }));
    const v = local.readIssue(local.open(path.join(P, ".git")), 1);
    fs.writeFileSync(I1, JSON.stringify(issue));
    return !("evil" in v);
  })());

  // ---- links
  const link = (target, at, kind) => { try { fs.symlinkSync(target, at, kind); return true; } catch { return false; } };
  const L = repo("linky"), LC = path.join(L, ".git");
  fs.mkdirSync(path.join(W, "elsewhere", "tracker", "issues"), { recursive: true });
  if (link(path.join(W, "elsewhere"), path.join(LC, "proteus-local"), "dir")) {
    r = gh(["--init"], { cwd: L });
    ok("--init refuses a link at proteus-local", r.code === 1 && /link/.test(r.err), r.err);
    ok("--init wrote nothing through the link", !fs.existsSync(path.join(W, "elsewhere", "mode")));
    fs.unlinkSync(path.join(LC, "proteus-local"));
    fs.mkdirSync(path.join(LC, "proteus-local"));
    fs.writeFileSync(path.join(LC, "proteus-local", "mode"), "1");
    ok("a link at proteus-local is not local mode", (fs.rmSync(path.join(LC, "proteus-local"), { recursive: true }), link(path.join(W, "elsewhere"), path.join(LC, "proteus-local"), "dir")) && (fs.writeFileSync(path.join(W, "elsewhere", "mode"), "1"), /not in local mode/.test(gh(["auth", "status"], { cwd: L }).err)));
    fs.unlinkSync(path.join(LC, "proteus-local"));
    fs.rmSync(path.join(W, "elsewhere", "mode"));

    const L2 = repo("linky2");
    gh(["--init"], { cwd: L2 });
    const L2T = path.join(L2, ".git", "proteus-local", "tracker");
    const moved = `${L2T}.real`;
    fs.renameSync(L2T, moved);
    link(moved, L2T, "dir");
    r = gh(["issue", "list"], { cwd: L2 });
    ok("a link at tracker/ is refused on every run", r.code === 1 && /link/.test(r.err), r.err);
    ok("--init refuses a link at tracker/", gh(["--init"], { cwd: L2 }).code === 1);
    fs.unlinkSync(L2T); fs.renameSync(moved, L2T);
    const I = path.join(L2T, "issues", "1.json");
    gh(["issue", "create", "--title", "x", "--body", "y"], { cwd: L2 });
    fs.renameSync(I, `${I}.real`);
    link(`${I}.real`, I, "file");
    ok("a link at an issue file is not read", gh(["issue", "view", "1"], { cwd: L2 }).code === 1);
    fs.unlinkSync(I); fs.renameSync(`${I}.real`, I);
    const G = path.join(L2, ".git", "proteus-local", "bin", "gh");
    fs.renameSync(G, `${G}.real`);
    link(`${G}.real`, G, "file");
    ok("--init refuses a link at a launcher", gh(["--init"], { cwd: L2 }).code === 1 && fs.lstatSync(G).isSymbolicLink());
    fs.unlinkSync(G); fs.renameSync(`${G}.real`, G);
  } else ok("links: skipped where this OS refuses to make one", true);
  const M = repo("modefile");
  fs.mkdirSync(path.join(M, ".git", "proteus-local", "mode"), { recursive: true });
  r = gh(["auth", "status"], { cwd: M });
  ok("a directory at mode is not local mode", r.code === 1 && /not in local mode/.test(r.err), r.err);

  // ---- launchers
  ok("the POSIX launcher quotes a space and a quote", local.shLauncher("/a b/it's/x.js").includes(`exec node '/a b/it'\\''s/x.js' "$@"`));
  ok("the Windows launcher quotes a space and escapes %", local.cmdLauncher("C:\\a b\\100%\\x.js") === '@node "C:\\a b\\100%%\\x.js" %*\r\n', local.cmdLauncher("C:\\a b\\100%\\x.js"));
  ok("the launchers name this hooks dir's script", fs.readFileSync(path.join(R, ".git", "proteus-local", "bin", "gh"), "utf8").includes(LOCAL.replace(/'/g, "'\\''")));
  const SP = path.join(W, "dir with 'space");
  fs.mkdirSync(path.join(SP, "hooks"), { recursive: true });
  for (const f of fs.readdirSync(SRC).filter((n) => n.endsWith(".js"))) fs.copyFileSync(path.join(SRC, f), path.join(SP, "hooks", f));
  const Q = repo("quoted repo");
  const SPL = path.join(SP, "hooks", "proteus-local.js");
  r = lib.run(SPL, "", { cwd: Q, args: ["--init"], env: { CLAUDE_PROJECT_DIR: Q } });
  ok("--init from a hooks dir with a space and a quote", r.code === 0, r.err);
  const bin = path.join(Q, ".git", "proteus-local", "bin");
  const env = { ...lib.ENV, CLAUDE_PROJECT_DIR: Q };
  const run = process.platform === "win32"
    ? spawnSync("cmd.exe", ["/d", "/c", "gh.cmd", "api", "user", "--jq", ".login"], { cwd: Q, env: { ...env, PATH: `${bin};${env.PATH}` }, encoding: "utf8", windowsHide: true, timeout: 30000 })
    : spawnSync(path.join(bin, "gh"), ["api", "user", "--jq", "\"\\(.login)\""], { cwd: Q, env, encoding: "utf8", timeout: 30000 });
  ok("the launcher runs the stand-in through that path, arguments intact", run.status === 0 && run.stdout.trim() === "local", run.stdout + run.stderr);

  // ---- lib.gh, lib.ghTry, ghHuman, proteus-gh.js
  const probe = path.join(W, "probe.js");
  fs.writeFileSync(probe, `const lib = require(${JSON.stringify(path.join(SRC, "proteus-lib.js"))});
const cwd = process.argv[2];
const env = lib.ghEnv(cwd);
console.log(JSON.stringify({
  gh: lib.gh(["api", "user", "--jq", ".login"], cwd),
  tryGh: lib.ghTry(["auth", "status"], cwd).out,
  human: lib.ghHuman(["api", "user", "--jq", ".login"], cwd).out,
  path: env.PATH || env.Path, envKeys: Object.keys(env).sort(),
  common: lib.localCommon(cwd), argv: lib.ghArgv(["x"], cwd),
}));`);
  const probeIn = (cwd) => JSON.parse(lib.run(probe, "", { cwd, args: [cwd], env: { CLAUDE_PROJECT_DIR: cwd, FAKE_GH_LOGIN: "fake-human" } }).out);
  const on = probeIn(R);
  ok("lib.gh reaches the stand-in in local mode", on.gh === "local", JSON.stringify(on));
  ok("lib.ghTry reaches the stand-in", /local mode/.test(on.tryGh), on.tryGh);
  ok("ghHuman reaches the stand-in", on.human === "local", on.human);
  ok("ghEnv puts the launchers first on PATH", on.path.split(path.delimiter)[0] === path.join(fs.realpathSync(R), ".git", "proteus-local", "bin"), on.path);
  const OFF = repo("plain");
  const off = probeIn(OFF);
  ok("outside local mode lib.gh still reaches the real gh", off.gh === "fake-human", JSON.stringify(off));
  ok("outside local mode ghHuman still reaches the real gh", off.human === "fake-human", off.human);
  ok("outside local mode ghArgv is a bare gh, arguments as given", JSON.stringify(off.argv) === '["gh",["x"]]', JSON.stringify(off.argv));
  ok("outside local mode PATH is untouched", off.path === lib.ENV.PATH, off.path);
  ok("outside local mode the env has the same keys", off.envKeys.join() === on.envKeys.join());
  ok("outside local mode the stand-in is not named", !JSON.stringify(off).includes("proteus-local"), JSON.stringify(off));
  r = lib.run(path.join(SRC, "proteus-gh.js"), "wrapped\n", { cwd: R, args: ["issue", "comment", "1", "--body-file", "-"], env: { CLAUDE_PROJECT_DIR: R } });
  ok("proteus-gh.js reaches the stand-in in local mode", r.code === 0 && /issuecomment-/.test(r.out), r.err);
  ok("proteus-gh.js wrote to the store", /wrapped/.test(fs.readFileSync(path.join(T, "issues", "1.json"), "utf8")));
  ok("in local mode ghArgv runs the stand-in itself, so Windows never skips a .cmd for a real gh", on.argv[0] !== "gh" && on.argv[1][0] === LOCAL && on.argv[1][1] === "x", JSON.stringify(on.argv));
  const winProbe = path.join(W, "win.js");
  fs.writeFileSync(winProbe, `const lib = require(${JSON.stringify(path.join(SRC, "proteus-lib.js"))});
Object.defineProperty(process, "platform", { value: "win32" });
console.log(JSON.stringify(lib.localEnv(process.argv[2], { Path: "x" })));`);
  const win = JSON.parse(lib.run(winProbe, "", { cwd: R, args: [R], env: { CLAUDE_PROJECT_DIR: R } }).out);
  ok("on Windows the launchers go first on the env's own Path key", Object.keys(win).join() === "Path" && win.Path.endsWith(`${path.delimiter}x`) && win.Path.includes("proteus-local"), JSON.stringify(win));
  const LOGF = path.join(W, "fake.log");
  r = lib.run(path.join(SRC, "proteus-gh.js"), "", { cwd: OFF, args: ["issue", "comment", "1", "--body", "x"], env: { CLAUDE_PROJECT_DIR: OFF, FAKE_GH_LOG: LOGF } });
  ok("proteus-gh.js outside local mode runs the real gh", fs.readFileSync(LOGF, "utf8") === "issue comment 1 --body x\n", r.err);

  lib.summary();
})();

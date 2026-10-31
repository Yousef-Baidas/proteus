#!/usr/bin/env node
// The stand-in's PRs, commit statuses, bare origin and local checks (#310), loaded by proteus-local.js, which hands
// this file its store helpers. Never run directly: proteus-local.js takes the entries below.
//   gh pr create|view|list|diff|merge|checks|comment|review|edit, and gh api on commits/<sha>/status(es),
//   statuses/<sha>, pulls/<n>/files and contents/<path>
//   proteus-local.js --pre-receive | --post-receive   origin.git's own hooks; cwd is the bare repo
//   proteus-local.js --run-check <common> <sha>       one check run, foreground
// origin.git is the `origin` remote. tracker/pulls/<n>.json holds a PR, numbered with the issues; tracker/statuses/
// <sha>.json its commit's statuses; checks/<sha>.claim and .log one check run. All of it is agent-reachable and
// read as untrusted, so an approval never rests on it: `pr review` is a plain record that `pr merge` does not read,
// and `pr merge` refuses what the policy holds (Policy.held), which reads the human's verdicts from their record.
// pre-receive exits 1 naming a refused ref, and fails closed outside origin.git; post-receive always exits 0.
// A check runs the default branch's gate commands on a head with the caller's privileges, so nothing here but
// `pr create`, post-receive and `pr checks --rerun` starts one: never a read, and never a Claude hook, which runs
// outside the sandbox. With a sandbox profile a run that can write proteus-lead/ is outside the sandbox: it runs
// nothing and posts a failure naming the rerun.
"use strict";
const fs = require("fs");
const path = require("path");
const { fileURLToPath } = require("url");
const { spawn, spawnSync } = require("child_process");
const lib = require(path.join(__dirname, "proteus-lib.js"));
const Policy = require(path.join(__dirname, "proteus-policy.js"));

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const STATES = ["pending", "success", "failure", "error"];
const PR_STATES = ["OPEN", "CLOSED", "MERGED"];
const REVIEW_STATES = ["COMMENTED", "CHANGES_REQUESTED"];
const FILE_STATUS = { A: "added", M: "modified", D: "removed", R: "renamed", C: "copied", T: "changed" };
const MAX_DESCRIPTION = 140, LOG_CAP = 1 << 20;
const FALLBACK_NAME = "Proteus local", FALLBACK_EMAIL = "local@proteus.invalid";
const WATCH_INTERVAL = 10, GIT_MS = 120000, WORKTREE_MS = 300000, KILL_GRACE_MS = 2000;
const CHECK_MS = 30 * 60000, CLAIM_BEAT_MS = 30000;
// a live runner touches its claim every beat, so this age means it died, or its machine slept
const CLAIM_DEAD_MS = 5 * 60000;
const PR_FIELDS = ["number", "title", "body", "state", "url", "baseRefName", "headRefName", "headRefOid", "isDraft", "reviews", "comments", "statusCheckRollup", "mergeable", "mergeStateStatus"];
const GATES = lib.GATES_CHECK;
const OLD_GIT = "proteus local mode: git merge-tree --write-tree is missing; local PRs need git 2.38 or newer";
const HEAD_MOVED = "GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)";

const has = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const isBranch = (v) => typeof v === "string" && /^[\w.#+/-]+$/.test(v) && !v.startsWith("-") && !v.includes("..") && !v.includes("//") && !v.endsWith("/") && !v.endsWith(".lock");
const isSha = (v) => typeof v === "string" && SHA.test(v);
const shaOrNull = (v) => v === null || isSha(v);
const upper = (v) => String(v).toUpperCase();

// merge-tree's outcome by exit code: 0 clean, 1 conflicts, 129 a git that lacks --write-tree
function treeResult(status, out, err) {
  if (status === 0) return { tree: String(out).trim().split("\n")[0] };
  if (status === 1 || /unrelated histories/.test(String(err))) return { conflict: true };
  if (status === 129) throw new Error(OLD_GIT);
  throw new Error(`proteus local mode: git merge-tree failed: ${String(err).trim().split("\n")[0] || `exit ${status}`}`);
}

function build(core) {
  const { fail, unsupported, flags, onlyHere, limit, jsonFields, emit, emitFields, line, bodyOf, checkTitle, readStoreJSON, malformed, writeJSON, withLock, nextNumber, readMeta, repoUrl, isTime, isCount, isText, isObj, realDir, noLink, mkReal, writeFresh, unlink, sleep, now, LOGIN, MAX_BODY, MAX_FILE, MAX_ENTRIES, REPO, OUT, script, shLauncher } = core;

  // ---- git in the bare repo
  const git = (s, args, o = {}) => lib.gitTry(s.origin, args, { timeout: GIT_MS, ...o });
  const must = (r, what) => (r.ok ? r.out : fail(`proteus local mode: ${what}: ${String(r.err).split("\n")[0]}`));
  const defaultBranch = (bare) => lib.gitIn(bare, ["symbolic-ref", "-q", "--short", "HEAD"]);
  const refOid = (s, branch) => lib.refSha(s.origin, `refs/heads/${branch}`);
  const isCommit = (s, sha) => git(s, ["cat-file", "-t", sha]).out === "commit";

  // the origin values in the repo's own config: url and pushurl, every one
  const originValues = (s) => ["url", "pushurl"].flatMap((k) => lib.gitIn(s.common, ["config", "--file", path.join(s.common, "config"), "--get-all", `remote.origin.${k}`]).split("\n").filter(Boolean));
  const sameRepo = (url, dir) => { try { return real(url.startsWith("file:") ? fileURLToPath(url) : url) === real(dir); } catch { return false; } };
  function checkOrigin(s) {
    for (const url of originValues(s)) if (!sameRepo(url, s.origin)) fail(`proteus local mode: origin is ${url}, not this repo's local origin; it is never rewritten`);
  }
  // git's own refusal stands for the empty case: an unborn HEAD still names its branch
  function firstDefault(s) {
    const tracked = lib.gitIn(s.common, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]).replace(/^origin\//, "");
    return tracked || lib.gitIn(s.common, ["symbolic-ref", "-q", "--short", "HEAD"]) || "main";
  }
  // the bare repo, its hooks and the remote. core.hooksPath is its own, relative to it: a user's or machine's setting
  // cannot move the hooks away, and a moved repo keeps them
  const hookFiles = (s, at = script) => [["pre-receive", "--pre-receive"], ["post-receive", "--post-receive"]].map(([name, flag]) => [path.join(s.origin, "hooks", name), shLauncher(at, flag), 0o755]);
  function initOrigin(s) {
    const files = hookFiles(s);
    mkReal(s.origin);
    mkReal(path.join(s.origin, "hooks"));
    for (const [f] of files) noLink(f);
    if (!has(path.join(s.origin, "HEAD"))) {
      must(lib.gitTry(s.origin, ["init", "--bare", "-q", "--template=", `--object-format=${lib.gitIn(s.common, ["rev-parse", "--show-object-format"]) || "sha1"}`, s.origin], { cwd: s.root }), "git init --bare failed");
      must(git(s, ["symbolic-ref", "HEAD", `refs/heads/${firstDefault(s)}`]), "setting the origin's default branch failed");
    }
    must(git(s, ["config", "core.hooksPath", "hooks"]), "setting the origin's hooks failed");
    for (const [f, text, mode] of files) writeFresh(f, text, mode);
    if (!originValues(s).length) must(lib.gitTry(s.common, ["remote", "add", "origin", s.origin]), "git remote add failed");
  }
  function originHealth(s) {
    const urls = originValues(s), branch = has(path.join(s.origin, "HEAD")) ? defaultBranch(s.origin) : "";
    return { origin: urls.length > 0 && urls.every((u) => sameRepo(u, s.origin)), branch, pushed: !!branch && !!refOid(s, branch), gates: branch ? gateList(s) : [] };
  }

  // ---- statuses
  function readStatuses(s, sha) {
    const file = path.join(s.statuses, `${sha}.json`);
    if (!has(file)) return [];
    const list = readStoreJSON(file, MAX_FILE);
    if (!Array.isArray(list) || list.length > MAX_ENTRIES) malformed(file, "not a list");
    return list.map((c) => {
      if (!isObj(c) || !isCount(c.id) || !STATES.includes(c.state) || !isText(c.context, MAX_DESCRIPTION) || !c.context || !isText(c.description, MAX_DESCRIPTION) || !isText(c.targetUrl, MAX_BODY) || !isTime(c.createdAt)) malformed(file, "a bad status");
      return { id: c.id, state: c.state, context: c.context, description: c.description, targetUrl: c.targetUrl, createdAt: c.createdAt };
    });
  }
  // under the lock
  function addStatus(s, sha, { state, context, description = "", targetUrl = "" }) {
    const list = readStatuses(s, sha);
    const c = { id: list.length + 1, state, context, description: description.slice(0, MAX_DESCRIPTION), targetUrl, createdAt: now() };
    writeJSON(path.join(s.statuses, `${sha}.json`), [...list, c], MAX_FILE);
    return c;
  }
  const latest = (list) => [...new Map(list.map((c) => [c.context, c])).values()].sort((a, b) => (a.context < b.context ? -1 : 1));
  const gatesOf = (list) => latest(list).find((c) => c.context === GATES);
  const claimOf = (s, sha) => path.join(s.checks, `${sha}.claim`);
  const logOf = (s, sha) => path.join(s.checks, `${sha}.log`);
  function deadCheck(s, sha, list) {
    const g = gatesOf(list);
    if (!g || g.state !== "pending") return false;
    let at = Date.parse(g.createdAt);
    try { at = fs.lstatSync(claimOf(s, sha)).mtimeMs; } catch {}
    return Date.now() - at > CLAIM_DEAD_MS;
  }
  // a dead run's pending turns to error on the next read: this posts, and never starts anything
  function statusesOf(s, sha) {
    const list = readStatuses(s, sha);
    if (!deadCheck(s, sha, list)) return list;
    return withLock(s.lock, () => {
      const again = readStatuses(s, sha);
      if (deadCheck(s, sha, again)) addStatus(s, sha, { state: "error", context: GATES, description: "the local check run died" });
      return readStatuses(s, sha);
    });
  }

  // ---- the store
  function readPull(s, n) {
    const file = path.join(s.pulls, `${n}.json`), p = readStoreJSON(file, MAX_FILE);
    if (!isObj(p) || p.number !== n) malformed(file, "its number is not its name");
    if (!isText(p.title, MAX_BODY) || !isText(p.body, MAX_BODY) || !PR_STATES.includes(p.state) || typeof p.isDraft !== "boolean") malformed(file, "a bad title, body, state or draft flag");
    if (!isBranch(p.baseRefName) || !isBranch(p.headRefName)) malformed(file, "a bad branch name");
    if (!shaOrNull(p.headRefOid) || !shaOrNull(p.baseRefOid) || (p.state === "OPEN") !== (p.headRefOid === null)) malformed(file, "a bad commit id");
    if (!isTime(p.createdAt) || !isTime(p.updatedAt) || !(p.closedAt === null || isTime(p.closedAt))) malformed(file, "a bad timestamp");
    if (!Array.isArray(p.comments) || !Array.isArray(p.reviews)) malformed(file, "a bad comment or review list");
    const comments = p.comments.map((c) => {
      if (!isObj(c) || !isCount(c.id) || !isText(c.body, MAX_BODY) || !isTime(c.createdAt)) malformed(file, "a bad comment");
      return { id: c.id, body: c.body, createdAt: c.createdAt };
    });
    const reviews = p.reviews.map((r) => {
      if (!isObj(r) || !isCount(r.id) || !isText(r.body, MAX_BODY) || !REVIEW_STATES.includes(r.state) || !isTime(r.submittedAt) || !isSha(r.commit)) malformed(file, "a bad review");
      return { id: r.id, body: r.body, state: r.state, submittedAt: r.submittedAt, commit: r.commit };
    });
    return { number: n, title: p.title, body: p.body, state: p.state, isDraft: p.isDraft, baseRefName: p.baseRefName, headRefName: p.headRefName, headRefOid: p.headRefOid, baseRefOid: p.baseRefOid, createdAt: p.createdAt, updatedAt: p.updatedAt, closedAt: p.closedAt, comments, reviews };
  }
  const writePull = (s, p) => writeJSON(path.join(s.pulls, `${p.number}.json`), p, MAX_FILE);
  const readPulls = (s) => core.numbersIn(s.pulls).map((n) => readPull(s, n));
  function loadPull(s, n) {
    if (!has(path.join(s.pulls, `${n}.json`))) fail(`GraphQL: Could not resolve to a PullRequest with the number of ${n}. (repository.pullRequest)`);
    return readPull(s, n);
  }
  // an open PR's head is the bare repo's ref, so a push shows at once; an ended PR keeps the commit it ended on
  function headOid(s, p) {
    if (p.state !== "OPEN") return p.headRefOid;
    return refOid(s, p.headRefName) || fail(`proteus local mode: PR #${p.number}'s head ${p.headRefName} is missing from the origin`);
  }
  const baseOid = (s, p) => (p.state === "OPEN" ? refOid(s, p.baseRefName) : p.baseRefOid);
  function mergeTree(s, base, head) {
    const [args, opts] = lib.gitCall(s.origin, ["merge-tree", "--write-tree", base, head], { timeout: GIT_MS, stdio: ["ignore", "pipe", "pipe"] });
    const r = spawnSync("git", args, opts);
    if (r.error) fail(`proteus local mode: git merge-tree failed: ${r.error.message}`);
    try { return treeResult(r.status, r.stdout, r.stderr); } catch (e) { return fail(e.message); }
  }
  function mergeState(s, p) {
    if (p.state !== "OPEN") return { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" };
    const base = baseOid(s, p), head = headOid(s, p);
    if (!base) return { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" };
    if (mergeTree(s, base, head).conflict) return { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" };
    const checks = latest(statusesOf(s, head)), g = checks.find((c) => c.context === GATES);
    const status = p.isDraft ? "DRAFT" : !g || g.state !== "success" ? "BLOCKED" : checks.every((c) => c.state === "success") ? "CLEAN" : "UNSTABLE";
    return { mergeable: "MERGEABLE", mergeStateStatus: status };
  }

  // ---- output shapes
  const prUrl = (s, n) => `${repoUrl(s)}/pull/${n}`;
  const comment = (s, n, c) => ({ id: `IC_local_${c.id}`, author: { login: LOGIN }, authorAssociation: "OWNER", body: c.body, createdAt: c.createdAt, includesCreatedEdit: false, isMinimized: false, minimizedReason: "", reactionGroups: [], url: `${prUrl(s, n)}#issuecomment-${c.id}`, viewerDidAuthor: true });
  const review = (r) => ({ id: `PRR_local_${r.id}`, author: { login: LOGIN }, authorAssociation: "OWNER", body: r.body, submittedAt: r.submittedAt, includesCreatedEdit: false, reactionGroups: [], state: r.state, commit: { oid: r.commit } });
  const rollup = (list) => latest(list).map((c) => ({ __typename: "StatusContext", context: c.context, startedAt: c.createdAt, state: upper(c.state), targetUrl: c.targetUrl }));
  // the costly fields are getters, so a --json that leaves them out runs no git
  function prJSON(s, p) {
    let merge = null;
    const state = () => (merge = merge || mergeState(s, p));
    return {
      number: p.number, title: p.title, body: p.body, state: p.state, url: prUrl(s, p.number), baseRefName: p.baseRefName, headRefName: p.headRefName, isDraft: p.isDraft,
      comments: p.comments.map((c) => comment(s, p.number, c)), reviews: p.reviews.map(review),
      get headRefOid() { return headOid(s, p); },
      get statusCheckRollup() { return rollup(statusesOf(s, headOid(s, p))); },
      get mergeable() { return state().mergeable; },
      get mergeStateStatus() { return state().mergeStateStatus; },
    };
  }
  function prArg(s, o, name) {
    if (o._.length > 1) unsupported(`${name} ${o._[1]}`);
    if (!o._.length) {
      const branch = lib.branchOf(process.cwd());
      const p = branch && readPulls(s).reverse().find((x) => x.state === "OPEN" && x.headRefName === branch);
      return p ? p.number : fail(`no pull requests found for branch "${branch}"`);
    }
    const m = /^#?([1-9]\d{0,14})$/.exec(o._[0]) || /\/pull\/([1-9]\d{0,14})(?:#.*)?$/.exec(o._[0]);
    return m ? Number(m[1]) : unsupported(`${name} ${o._[0]}`);
  }

  // ---- pr create
  function fillFrom(s, base, head, branch) {
    const list = must(git(s, ["log", "--reverse", "--format=%H", `${base}..${head}`]), "git log failed").split("\n").filter(Boolean);
    if (list.length === 1) {
      const [title, ...rest] = must(git(s, ["log", "-1", "--format=%B", list[0]]), "git log failed").split("\n");
      return { title, body: rest.join("\n").trim() };
    }
    return { title: branch.replace(/[-_/]+/g, " "), body: must(git(s, ["log", "--reverse", "--format=- %s", `${base}..${head}`]), "git log failed") };
  }
  function create(s, argv) {
    const o = flags(argv, { ...REPO, "--base|-B": 1, "--head|-H": 1, "--title|-t": 1, "--body|-b": 1, "--body-file|-F": 1, "--fill|-f": 0 }, "pr create");
    onlyHere(s, o, "pr create");
    if (o._.length) unsupported(`pr create ${o._[0]}`);
    const base = o["--base"] === undefined ? defaultBranch(s.origin) : o["--base"], head = o["--head"] === undefined ? lib.branchOf(process.cwd()) : o["--head"];
    const baseSha = isBranch(base) ? refOid(s, base) : "", headSha = isBranch(head) ? refOid(s, head) : "";
    if (!baseSha) fail("pull request create failed: GraphQL: Base ref must be a branch (createPullRequest)");
    if (!headSha) fail("pull request create failed: GraphQL: Head ref must be a branch (createPullRequest)");
    if (git(s, ["merge-base", "--is-ancestor", headSha, baseSha]).ok) fail(`pull request create failed: GraphQL: No commits between ${base} and ${head} (createPullRequest)`);
    let title = o["--title"], body = bodyOf(o);
    if (o["--fill"]) {
      const made = fillFrom(s, baseSha, headSha, head);
      title = title === undefined ? made.title : title;
      body = body === undefined ? made.body : body;
    }
    if (title === undefined) fail("must provide `--title` and `--body` (or `--fill`) when not running interactively");
    checkTitle(title);
    const n = withLock(s.lock, () => {
      const same = readPulls(s).find((p) => p.state === "OPEN" && p.headRefName === head && p.baseRefName === base);
      if (same) fail(`a pull request for branch "${head}" into branch "${base}" already exists:\n${prUrl(s, same.number)}`);
      const meta = readMeta(s), number = nextNumber(s, meta), t = now();
      writeJSON(s.meta, meta);
      writePull(s, { number, title, body: body || "", state: "OPEN", isDraft: false, baseRefName: base, headRefName: head, headRefOid: null, baseRefOid: null, createdAt: t, updatedAt: t, closedAt: null, comments: [], reviews: [] });
      return number;
    });
    line(prUrl(s, n));
    startCheck(s, headSha);
  }

  // ---- pr merge
  const identity = (s) => ["name", "email"].map((k) => lib.gitIn(s.common, ["config", `user.${k}`], 3000, { user: true }));
  // the one direct ref write into the origin, so pre-receive never sees it. update-ref with the old value: a push
  // that got in first wins, and this fails
  function commitMerge(s, ref, oldBase, head, tree, n, title) {
    const [name, email] = identity(s);
    const [args, opts] = lib.gitCall(s.origin, ["commit-tree", tree, "-p", oldBase, "-p", head, "-m", `Merge pull request #${n} from ${ref.headRefName}`, "-m", title], { timeout: GIT_MS, stdio: ["ignore", "pipe", "pipe"] });
    const who = name || FALLBACK_NAME, mail = email || FALLBACK_EMAIL;
    opts.env = { ...opts.env, GIT_AUTHOR_NAME: who, GIT_AUTHOR_EMAIL: mail, GIT_COMMITTER_NAME: who, GIT_COMMITTER_EMAIL: mail };
    const c = spawnSync("git", args, opts), made = String(c.stdout).trim();
    if (c.error || c.status !== 0) fail(`proteus local mode: git commit-tree failed: ${c.error ? c.error.message : String(c.stderr).split("\n")[0]}`);
    if (!git(s, ["update-ref", `refs/heads/${ref.baseRefName}`, made, oldBase]).ok) fail(`proteus local mode: ${ref.baseRefName} moved during the merge; nothing merged`);
    return made;
  }
  // the head this merge may take: refused while the policy holds the PR, so a direct `gh pr merge` skips nothing
  // proteus-merge.js honours. held reads through the stand-in, so never under the lock
  function policyHead(s, n, head) {
    const root = lib.mainRoot(s.common), p = { n };
    const [hold] = Policy.held([p], root, Policy.load({ root }).policy);
    if (hold) fail(Policy.heldLine(hold));
    return p.oid || head;
  }
  function merge(s, argv) {
    const o = flags(argv, { ...REPO, "--merge|-m": 0, "--match-head-commit": 1 }, "pr merge");
    onlyHere(s, o, "pr merge");
    const n = prArg(s, o, "pr merge");
    if (!o["--merge"]) fail("--merge required when not running interactively");
    const first = loadPull(s, n);
    let want = "";
    if (first.state === "OPEN") {
      const at = headOid(s, first);
      statusesOf(s, at); // the lock is not re-entrant, so a dead run turns to error here
      want = policyHead(s, n, at);
    }
    withLock(s.lock, () => {
      const p = loadPull(s, n);
      if (p.state === "MERGED") fail(`Pull request #${n} was already merged`);
      if (p.state === "CLOSED") fail(`Pull request #${n} is closed`);
      if (p.isDraft) fail(`Pull request #${n} is still a draft`);
      const head = headOid(s, p), base = baseOid(s, p);
      if (!base) fail(`proteus local mode: PR #${n}'s base ${p.baseRefName} is missing from the origin`);
      if ((o["--match-head-commit"] !== undefined && o["--match-head-commit"] !== head) || head !== want) fail(HEAD_MOVED);
      // reviews play no part here: they are plain records, and the human's approval belongs to the verdict record
      // what the host's rules ask of this base, so a direct merge skips none of it; proteus/security is held() here
      const checks = latest(readStatuses(s, head));
      for (const context of new Set([GATES, ...lib.requiredChecks(p.baseRefName).filter((c) => c !== "proteus/security")])) {
        const c = checks.find((x) => x.context === context);
        if (!c || c.state !== "success") fail(`Pull request #${n} is not mergeable: required status ${context} is ${c ? c.state : "missing"} on ${head.slice(0, 12)}`);
      }
      const t = mergeTree(s, base, head);
      if (t.conflict) fail(`Pull request #${n} is not mergeable: the merge commit cannot be cleanly created.`);
      commitMerge(s, p, base, head, t.tree, n, p.title);
      const at = now();
      writePull(s, { ...p, state: "MERGED", headRefOid: head, baseRefOid: base, updatedAt: at, closedAt: at });
    });
  }

  // ---- pr view, list, diff and the rest
  function view(s, argv) {
    const o = flags(argv, { ...REPO, ...OUT }, "pr view");
    onlyHere(s, o, "pr view");
    const fields = jsonFields(o, PR_FIELDS), r = prJSON(s, loadPull(s, prArg(s, o, "pr view")));
    if (fields) return emitFields(r, o, fields);
    line(`title:\t${r.title}\nstate:\t${r.state}\nauthor:\t${LOGIN}\nnumber:\t${r.number}\nurl:\t${r.url}\n--\n${r.body}`);
  }
  function list(s, argv) {
    const o = flags(argv, { ...REPO, ...OUT, "--base|-B": 1, "--head|-H": 1, "--state|-s": 1, "--limit|-L": 1 }, "pr list");
    onlyHere(s, o, "pr list");
    if (o._.length) unsupported(`pr list ${o._[0]}`);
    const fields = jsonFields(o, PR_FIELDS), state = o["--state"] === undefined ? "open" : o["--state"], want = limit(o, 30);
    if (!["open", "closed", "merged", "all"].includes(state)) fail(`proteus local mode: invalid --state: ${state}`);
    const inState = { open: ["OPEN"], closed: ["CLOSED", "MERGED"], merged: ["MERGED"], all: PR_STATES }[state];
    const rows = readPulls(s).reverse().filter((p) => inState.includes(p.state) && (o["--base"] === undefined || p.baseRefName === o["--base"]) && (o["--head"] === undefined || p.headRefName === o["--head"])).slice(0, want);
    if (fields) return emitFields(rows.map((p) => prJSON(s, p)), o, fields);
    for (const p of rows) line([p.number, p.title, p.headRefName, p.state, p.updatedAt].join("\t"));
  }
  // from the merge base; an ended PR's base is the commit it ended on, so it still shows what it changed
  function range(s, p) {
    const head = headOid(s, p), base = baseOid(s, p) || fail(`proteus local mode: PR #${p.number}'s base ${p.baseRefName} is missing from the origin`);
    return [must(git(s, ["merge-base", base, head]), `PR #${p.number} has no merge base`), head];
  }
  const DIFF = ["-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-textconv"];
  function diff(s, argv) {
    const o = flags(argv, { ...REPO, "--name-only": 0 }, "pr diff");
    onlyHere(s, o, "pr diff");
    const out = must(git(s, [...DIFF, ...(o["--name-only"] ? ["--name-only"] : []), ...range(s, loadPull(s, prArg(s, o, "pr diff")))]), "git diff failed");
    if (out) line(out);
  }
  function files(s, n) {
    const words = must(git(s, [...DIFF, "--name-status", "-M", "-z", ...range(s, loadPull(s, n))]), "git diff failed").split("\0").filter(Boolean);
    const out = [];
    for (let i = 0; i < words.length; i++) {
      const code = words[i][0], moved = code === "R" || code === "C";
      const from = moved ? words[++i] : undefined, filename = words[++i];
      out.push({ filename, status: FILE_STATUS[code] || "modified", ...(moved && { previous_filename: from }) });
    }
    return out;
  }
  function noteOn(s, n, add) {
    return withLock(s.lock, () => {
      const p = loadPull(s, n), meta = readMeta(s), t = now(), id = meta.nextComment++;
      writeJSON(s.meta, meta);
      const made = add(p, id, t);
      p.updatedAt = t;
      writePull(s, p);
      return made;
    });
  }
  function commentOn(s, argv) {
    const o = flags(argv, { ...REPO, "--body|-b": 1, "--body-file|-F": 1 }, "pr comment");
    onlyHere(s, o, "pr comment");
    const n = prArg(s, o, "pr comment"), body = bodyOf(o);
    if (!body || !body.trim()) fail("proteus local mode: the comment body is empty");
    const c = noteOn(s, n, (p, id, createdAt) => { const made = { id, body, createdAt }; p.comments.push(made); return made; });
    line(`${prUrl(s, n)}#issuecomment-${c.id}`);
  }
  // a plain record: nothing reads it to decide a merge (see merge)
  function reviewOn(s, argv) {
    const o = flags(argv, { ...REPO, "--comment|-c": 0, "--request-changes|-r": 0, "--body|-b": 1, "--body-file|-F": 1 }, "pr review");
    onlyHere(s, o, "pr review");
    const n = prArg(s, o, "pr review"), body = bodyOf(o);
    if (!!o["--comment"] === !!o["--request-changes"]) fail("need exactly one of --comment or --request-changes");
    if (!body || !body.trim()) fail("body cannot be blank for comment review");
    const state = o["--comment"] ? "COMMENTED" : "CHANGES_REQUESTED";
    noteOn(s, n, (p, id, submittedAt) => { p.reviews.push({ id, body, state, submittedAt, commit: headOid(s, p) }); });
  }
  function edit(s, argv) {
    const o = flags(argv, { ...REPO, "--title|-t": 1, "--body|-b": 1, "--body-file|-F": 1 }, "pr edit");
    onlyHere(s, o, "pr edit");
    const n = prArg(s, o, "pr edit"), title = o["--title"] === undefined ? undefined : checkTitle(o["--title"]), body = bodyOf(o);
    if (title === undefined && body === undefined) fail("proteus local mode: pr edit needs a change");
    withLock(s.lock, () => {
      const p = loadPull(s, n);
      writePull(s, { ...p, ...(title !== undefined && { title }), ...(body !== undefined && { body }), updatedAt: now() });
    });
    line(prUrl(s, n));
  }

  // ---- pr checks: gh's exit codes, 0 passed, 1 failed or no checks, 8 still pending; with --json the listing's own 0
  const BUCKET = { success: "pass", pending: "pending", failure: "fail", error: "fail" };
  function checkRows(s, p) {
    const all = statusesOf(s, headOid(s, p));
    return latest(all).map((c) => ({ bucket: BUCKET[c.state], completedAt: c.state === "pending" ? "" : c.createdAt, description: c.description, event: "", link: c.targetUrl, name: c.context, startedAt: all.find((x) => x.context === c.context).createdAt, state: upper(c.state), workflow: "" }));
  }
  const CHECK_FIELDS = ["bucket", "completedAt", "description", "event", "link", "name", "startedAt", "state", "workflow"];
  function checks(s, argv) {
    const o = flags(argv, { ...REPO, ...OUT, "--watch": 0, "--interval|-i": 1, "--rerun": 0 }, "pr checks");
    onlyHere(s, o, "pr checks");
    const n = prArg(s, o, "pr checks"), fields = jsonFields(o, CHECK_FIELDS);
    if (o["--watch"] && fields) fail("cannot use `--watch` with `--json`");
    if (o["--rerun"]) {
      if (o["--watch"] || fields) fail("cannot use `--rerun` with `--watch` or `--json`");
      return rerun(s, loadPull(s, n));
    }
    const interval = o["--interval"] === undefined ? WATCH_INTERVAL : Number(o["--interval"]);
    if (!Number.isFinite(interval) || interval < 0) fail(`proteus local mode: invalid --interval: ${o["--interval"]}`);
    let rows = checkRows(s, loadPull(s, n));
    while (o["--watch"] && rows.some((r) => r.bucket === "pending")) { sleep(interval * 1000); rows = checkRows(s, loadPull(s, n)); }
    if (!rows.length) fail(`no checks reported on the '${loadPull(s, n).headRefName}' branch`);
    if (fields) return emitFields(rows, o, fields);
    for (const r of rows) line([r.name, r.bucket, "0", r.link, r.description].join("\t"));
    return rows.some((r) => r.bucket === "fail") ? 1 : rows.some((r) => r.bucket === "pending") ? 8 : 0;
  }

  // ---- gh api: the status, files and contents paths. True when route was one of them
  const statusAPI = (s, sha, c) => ({ id: c.id, state: c.state, context: c.context, description: c.description, target_url: c.targetUrl, created_at: c.createdAt, updated_at: c.createdAt, creator: { login: LOGIN }, url: `${repoUrl(s)}/statuses/${sha}` });
  function contents(s, file, ref) {
    const name = decodeURIComponent(file);
    if (name.split("/").some((w) => !w || w === "." || w === "..") || !isBranch(ref)) fail("gh: Not Found (HTTP 404)");
    const at = `refs/heads/${ref}:${name}`, sha = git(s, ["rev-parse", "--verify", "-q", at]);
    if (!sha.ok || git(s, ["cat-file", "-t", sha.out]).out !== "blob") fail("gh: Not Found (HTTP 404)");
    const blob = lib.gitRun(s.origin, ["cat-file", "blob", sha.out], { encoding: "buffer", timeout: GIT_MS });
    return { type: "file", encoding: "base64", name: path.posix.basename(name), path: name, sha: sha.out, size: blob.length, content: blob.toString("base64") };
  }
  function api(s, method, route, { params, body, filter, no }) {
    let m;
    const ready = () => openPr(s.common);
    if ((m = /^commits\/([0-9a-f]{40,64})\/statuses$/.exec(route))) {
      if (method !== "GET") no();
      emit(statusesOf(ready(), m[1]).reverse().map((c) => statusAPI(s, m[1], c)), filter);
      return true;
    }
    if ((m = /^commits\/([0-9a-f]{40,64})\/status$/.exec(route))) {
      if (method !== "GET") no();
      const list = latest(statusesOf(ready(), m[1])).map((c) => statusAPI(s, m[1], c));
      const state = list.some((c) => c.state === "failure" || c.state === "error") ? "failure" : !list.length || list.some((c) => c.state === "pending") ? "pending" : "success";
      emit({ state, statuses: list, sha: m[1], total_count: list.length }, filter);
      return true;
    }
    if ((m = /^statuses\/([0-9a-f]{40,64})$/.exec(route))) {
      if (method !== "POST") no();
      for (const k of body.keys()) if (!["state", "context", "description", "target_url"].includes(k)) no();
      const state = body.get("state"), context = body.has("context") ? body.get("context") : "default", description = body.get("description") || "", targetUrl = body.get("target_url") || "";
      const t = ready();
      if (!STATES.includes(state) || !context || context.length > MAX_DESCRIPTION || description.length > MAX_DESCRIPTION || targetUrl.length > MAX_BODY || !isCommit(t, m[1])) fail("gh: Validation Failed (HTTP 422)");
      emit(statusAPI(s, m[1], withLock(t.lock, () => addStatus(t, m[1], { state, context, description, targetUrl }))), filter);
      return true;
    }
    if ((m = /^pulls\/([1-9]\d{0,14})\/files$/.exec(route))) {
      if (method !== "GET") no();
      emit(files(ready(), Number(m[1])), filter);
      return true;
    }
    if ((m = /^contents\/(.+)$/.exec(route))) {
      if (method !== "GET") no();
      const t = ready();
      emit(contents(t, m[1], params.has("ref") ? params.get("ref") : defaultBranch(t.origin)), filter);
      return true;
    }
    return false;
  }

  // ---- checks. This process's own git and token variables never reach a gate command
  function checkEnv() {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/^GIT_/i.test(k) || lib.SANDBOX_TOKENS.includes(k.toUpperCase())) delete env[k];
    return env;
  }
  // one detached run; its claim decides who checks, so a second start ends at once. stdio ignored: a push must not
  // wait on it through git's pipes. A run that never starts leaves pending, which turns to error once it is dead
  function startRunner(s, sha) {
    try {
      const c = spawn(process.execPath, [script, "--run-check", s.common, sha], { detached: true, stdio: "ignore", windowsHide: true, cwd: s.common, env: checkEnv() });
      c.on("error", () => {});
      c.unref();
    } catch {}
  }
  // pending at once, never over a result: a head is checked once
  function startCheck(s, sha) {
    const fresh = withLock(s.lock, () => {
      if (gatesOf(readStatuses(s, sha))) return false;
      addStatus(s, sha, { state: "pending", context: GATES, description: "the local check is starting" });
      return true;
    });
    if (fresh) startRunner(s, sha);
  }
  // the one start over a result. The old claim goes under the lock; a run still pending keeps it, and its turn
  function rerun(s, p) {
    if (p.state !== "OPEN") fail(`proteus local mode: pull request #${p.number} is not open`);
    const sha = headOid(s, p);
    statusesOf(s, sha); // a dead run's pending turns to error first
    const fresh = withLock(s.lock, () => {
      const g = gatesOf(readStatuses(s, sha));
      if (g && g.state === "pending") return false;
      unlink(claimOf(s, sha));
      addStatus(s, sha, { state: "pending", context: GATES, description: "the local check is starting" });
      return true;
    });
    if (fresh) startRunner(s, sha);
    line(fresh ? `started a check for ${sha}` : `a check for ${sha} is already running`);
    return 0;
  }
  // from the default branch in the bare repo, so a branch cannot choose its own gates
  function gateList(s) {
    const r = git(s, ["cat-file", "blob", `refs/heads/${defaultBranch(s.origin)}:AGENTS.md`]);
    return r.ok ? lib.gateCommands(r.out) : [];
  }
  function killTree(c) {
    if (process.platform === "win32") { try { spawnSync("taskkill", ["/pid", String(c.pid), "/T", "/F"], { windowsHide: true, timeout: 10000, stdio: "ignore" }); } catch {} return; }
    try { process.kill(-c.pid, "SIGKILL"); } catch {}
  }
  // one gate command in its own process group, bounded; output into the capped log. A process that outlives the kill
  // and holds the pipe open does not hold the run
  function runGate(command, cwd, env, log, ms) {
    return new Promise((resolve) => {
      const c = spawn(command, { cwd, env, shell: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let timedOut = false, code = null, over = false;
      const done = () => { clearTimeout(timer); clearTimeout(grace); resolve({ code, timedOut }); };
      let grace;
      const timer = setTimeout(() => { timedOut = true; killTree(c); grace = setTimeout(done, KILL_GRACE_MS); }, ms);
      const take = (b) => {
        if (log.left > 0) { const part = b.subarray(0, log.left); fs.writeSync(log.fd, part); log.left -= part.length; }
        if (log.left <= 0 && !over) { over = true; fs.writeSync(log.fd, "\n[log cut at the cap]\n"); }
      };
      c.stdout.on("data", take);
      c.stderr.on("data", take);
      c.on("error", (e) => { fs.writeSync(log.fd, `${e.message}\n`); code = -1; done(); });
      c.on("exit", (n) => { code = n; if (!timedOut) { clearTimeout(timer); grace = setTimeout(done, KILL_GRACE_MS); } });
      c.on("close", done);
    });
  }
  async function runGates(s, sha, list, ms) {
    const parent = path.join(lib.stateDir(s.common), "local-checks");
    fs.mkdirSync(parent, { recursive: true });
    const dir = fs.mkdtempSync(path.join(parent, `${sha.slice(0, 12)}-`)), tree = path.join(dir, "tree");
    const file = logOf(s, sha);
    unlink(file);
    const log = { fd: fs.openSync(file, "wx", 0o600), left: LOG_CAP };
    try {
      must(git(s, ["worktree", "add", "-q", "--detach", tree, sha], { timeout: WORKTREE_MS }), "git worktree add failed");
      const env = checkEnv();
      for (const command of list) {
        fs.writeSync(log.fd, `$ ${command}\n`);
        const r = await runGate(command, tree, env, log, ms);
        if (r.timedOut) return { state: "failure", description: `timed out: ${command}`, targetUrl: file };
        if (r.code !== 0) return { state: "failure", description: `exit ${r.code}: ${command}`, targetUrl: file };
      }
      return { state: "success", description: `${list.length} gate command(s) passed`, targetUrl: file };
    } finally {
      fs.closeSync(log.fd);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      git(s, ["worktree", "prune"]);
    }
  }
  // a result counts only while some PR's head is, or ended on, sha
  const isHead = (s, sha) => readPulls(s).some((p) => (p.state === "OPEN" ? refOid(s, p.headRefName) : p.headRefOid) === sha);
  const outsideSandbox = (s) => !!lib.profileFile(s.common) && lib.leadWritable(s.common);
  function notRun(s, sha) {
    const p = readPulls(s).find((x) => x.state === "OPEN" && refOid(s, x.headRefName) === sha);
    return { state: "failure", description: `not run: outside the sandbox. In a sandboxed session: gh pr checks ${p ? p.number : "<number>"} --rerun` };
  }
  async function runCheck(common, sha, ms = CHECK_MS) {
    if (!lib.localMode(common) || !isSha(sha)) fail("proteus local mode: --run-check needs a local-mode repo and a commit");
    const s = openPr(common), claim = claimOf(s, sha);
    try { fs.writeFileSync(claim, "", { flag: "wx", mode: 0o600 }); } catch (e) { if (e.code === "EEXIST") { statusesOf(s, sha); return false; } throw e; }
    const beat = setInterval(() => { const t = new Date(); try { fs.lutimesSync(claim, t, t); } catch {} }, CLAIM_BEAT_MS);
    let result;
    try {
      const list = gateList(s);
      result = outsideSandbox(s) ? notRun(s, sha) : list.length ? await runGates(s, sha, list, ms) : { state: "failure", description: "no gate command in ## Learned on the default branch" };
    } catch (e) {
      result = { state: "error", description: `the local check failed: ${e.message}` };
    } finally { clearInterval(beat); }
    return withLock(s.lock, () => {
      if (!isHead(s, sha)) return false;
      addStatus(s, sha, { ...result, context: GATES });
      return true;
    });
  }

  // ---- the origin's git hooks: lines of `<old> <new> <ref>` on stdin
  const pushed = (input) => input.split("\n").map((l) => /^([0-9a-f]+) ([0-9a-f]+) refs\/heads\/(\S+)$/.exec(l.trim())).filter(Boolean).map(([, old, sha, name]) => ({ old, sha, name }));
  const zero = (sha) => /^0+$/.test(sha);
  // what the host's rules and the guards refuse, from their one function: an existing default or run branch moves only
  // through `pr merge`. Creating a branch passes, and any other branch may be forced
  function refused(bare, updates) {
    const head = defaultBranch(bare);
    for (const u of updates) {
      const kind = zero(u.old) ? "" : lib.branchKind(u.name, head, bare);
      if (kind) return `proteus local mode: refs/heads/${u.name} is ${kind === "main" ? "the default branch" : "a run branch"}; it changes only through gh pr merge`;
    }
    return "";
  }
  const originHere = (dir) => path.basename(dir) === "origin.git" && path.basename(path.dirname(dir)) === path.basename(lib.localPath("x"));
  function preReceive(bare, input) {
    if (!originHere(bare)) fail(`proteus local mode: ${bare} is not a local origin; push refused`);
    const why = refused(bare, pushed(input));
    if (why) fail(why);
  }
  function postReceive(bare, input) {
    if (!originHere(bare)) return;
    const common = path.dirname(path.dirname(bare));
    if (!lib.localMode(common)) return;
    const s = openPr(common), open = readPulls(s).filter((p) => p.state === "OPEN");
    const shas = pushed(input).filter((u) => !zero(u.sha) && open.some((p) => p.headRefName === u.name)).map((u) => u.sha);
    for (const sha of new Set(shas)) startCheck(s, sha);
  }

  function openPr(common) {
    const s = core.open(common);
    for (const d of [s.pulls, s.statuses, s.checks, s.origin]) realDir(d);
    return s;
  }
  const commands = { create, view, list, diff, merge, checks, comment: commentOn, review: reviewOn, edit };
  function run(common, sub, argv) {
    if (!Object.prototype.hasOwnProperty.call(commands, sub)) unsupported(`pr ${sub === undefined ? "" : sub}`.trim());
    return commands[sub](openPr(common), argv);
  }
  return { run, api, checkOrigin, initOrigin, hookFiles, originHealth, preReceive, postReceive, runCheck, commitMerge };
}

module.exports = build;
module.exports.treeResult = treeResult;

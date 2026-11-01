#!/usr/bin/env node
// Moves a local-mode repo (#310) to an existing, empty repo on a code host: install.js --export <owner/repo> calls run().
// Never run from a hook, a session or an agent: it is the human's own act, and in the sandbox the lead-write test stops
// it. Without yes it only reads, prints the plan and returns. Every refusal comes before anything is written anywhere.
// The order: push, labels, issues, PRs, then the switch: origin first, then the mode marker, so a failure between them
// leaves local mode on and a rerun finishes it. The store and the bare origin stay as an archive.
// Exit contract: run() returns { branch } after the switch, null after a plan, and throws with one plain line on a
// refusal or a failure; install.js prints that line and exits 1. The hooks' fail-open rule does not apply.
// <common>/proteus-lead/local-export.json maps local numbers to host numbers, written after each step, so a rerun
// resumes and nothing posts twice. Every exported body opens with a header line and has its mentions and closing
// keywords broken, so no store text reads as the human's verdict, pings anyone or closes anything. verdicts.jsonl and
// statuses never cross.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const lib = require(path.join(__dirname, "proteus-lib.js"));
const local = require(path.join(__dirname, "proteus-local.js"));

const { fail, pr, LOGIN } = local;
const MAX_MAP = 1 << 24, GH_MS = 120000, PUSH_MS = 3600000;
const ZWSP = "​";
const WRITERS = ["WRITE", "MAINTAIN", "ADMIN"];
const PRIVATE = ["PRIVATE", "INTERNAL"];
const SANDBOX = "--export changes the project's home and publishes its records, so you run it yourself, in your own terminal outside the sandbox; nothing changed";
const EXPORT_WARNING = [
  "Moving this project to a code host means:",
  "- All history and all records go to the host.",
  "- The records were written by agents and are not checked for secrets.",
  "- Everything posts under your account, with the original author and time in the text.",
  "- Human approvals do not carry over.",
].join("\n");

// a keyword next to what it would close. The word is broken only there: the same word in a path or a command a host
// reader parses stays as written
const KEYWORD = /(?<![a-z0-9])(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?![a-z0-9])(?=[^a-z0-9\n]*(?:#|gh-|https?:|[\w.-]+\/[\w.-]+#))/gi;
const MENTION = /(?<![a-z0-9])@(?=[a-z0-9])/gi;
// an invisible character, because a quote or a code span can be closed by the text inside it. An entity would decode
// back into the mention, so & is broken too
function neutral(text) {
  return String(text).replace(/&(?=[#a-z])/gi, `&${ZWSP}`).replace(MENTION, `@${ZWSP}`).replace(KEYWORD, (w) => `${w[0]}${ZWSP}${w.slice(1)}`);
}
const oneLine = (text) => neutral(text).replace(/\s+/g, " ").trim();
const header = (what, number, at) => `Exported ${what} local number ${number}, by ${LOGIN}, at ${at}.`;
// the header is the first line, and every verdict reader stops at the first line
const withHeader = (head, body) => (String(body).trim() ? `${head}\n\n${neutral(body)}` : head);

function fitted(body, name) {
  if (body.length > local.MAX_BODY) fail(`proteus: ${name} is over ${local.MAX_BODY} characters with its export header; shorten it in the store and run this again`);
  return body;
}
function titled(title, name) {
  const t = oneLine(title).slice(0, local.MAX_TITLE);
  return t || fail(`proteus local mode: malformed store: ${name}: an empty title`);
}
const notes = (list, number, name) => list.map((c, i) => fitted(c.state
  ? withHeader(header(`review (${c.state}) on`, number, c.submittedAt), c.body)
  : withHeader(header("comment on", number, c.createdAt), c.body), `${name} comment ${i + 1}`));
function recordOf(p, head, state) {
  const facts = [`Title: ${oneLine(p.title)}`, `Base: ${p.baseRefName}`, `Head: ${p.headRefName}`, `Final commit: ${head || "none"}`, `State: ${state}`];
  return fitted(withHeader(header("pull request", p.number, p.createdAt), [...facts, "", p.body].join("\n")), `pull request ${p.number}`);
}

// what export posts, every field read and checked: a malformed record stops here, before anything is written
function records(s) {
  const milestones = local.readMilestones(s), known = local.readLabels(s), used = new Map();
  const issues = local.readIssues(s).map((i) => {
    const name = `issue ${i.number}`;
    for (const l of i.labels) {
      if (!l.trim() || l.includes(",")) fail(`proteus local mode: malformed store: ${name}: a bad label`);
      used.set(l.toLowerCase(), known.find((k) => k.name.toLowerCase() === l.toLowerCase()) || { name: l, color: "ededed", description: "" });
    }
    const ms = i.milestone === null ? null : milestones.find((m) => m.number === i.milestone) || fail(`proteus local mode: malformed store: ${name}: a milestone the store lacks`);
    const body = [...(ms ? [`Milestone: ${ms.title}`, ""] : []), i.body].join("\n");
    return { key: i.number, name, kind: "issue", title: titled(i.title, name), body: fitted(withHeader(header("issue", i.number, i.createdAt), body), name), labels: i.labels, notes: notes(i.comments, i.number, name), closed: i.state === "CLOSED" };
  });
  const pulls = pr.readPulls(s).map((p) => {
    const name = `pull request ${p.number}`, head = p.state === "OPEN" ? pr.refOid(s, p.headRefName) : p.headRefOid;
    const said = notes([...p.comments, ...p.reviews].sort((a, b) => a.id - b.id), p.number, name);
    const base = p.state === "OPEN" ? pr.refOid(s, p.baseRefName) : "";
    if (head && base && !lib.gitTry(s.origin, ["merge-base", "--is-ancestor", head, base]).ok) {
      return { key: p.number, name, kind: "pr", title: titled(p.title, name), body: fitted(withHeader(header("pull request", p.number, p.createdAt), p.body), name), labels: [], notes: said, closed: false, base: p.baseRefName, head: p.headRefName, draft: p.isDraft, wasOpen: true };
    }
    return { key: p.number, name, kind: "issue", title: titled(`PR record: ${p.title}`, name), body: recordOf(p, head, p.state), labels: [], notes: said, closed: true, wasOpen: p.state === "OPEN" };
  });
  return { issues, pulls, labels: [...used.values()] };
}

function readMap(common) {
  const file = lib.leadPath(common, local.EXPORT_MAP);
  try { fs.lstatSync(file); } catch { return null; }
  const m = lib.readUntrustedJSON(file, null, MAX_MAP);
  const entries = m && m.items && typeof m.items === "object" ? Object.values(m.items) : null;
  const fine = entries && typeof m.target === "string" && typeof m.url === "string" && m.refs && typeof m.refs === "object" && Array.isArray(m.labels)
    && entries.every((e) => e && Number.isSafeInteger(e.host) && e.host > 0 && (e.kind === "issue" || e.kind === "pr") && Number.isSafeInteger(e.notes) && e.notes >= 0);
  return fine ? m : fail(`proteus: ${file} is malformed; nothing changed`);
}
const lines = (text) => String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

// a host call through the real gh only; stops at the first failure, with no retry
function hostCaller(common) {
  const real = local.realGh() || fail("proteus: --export needs the real gh on PATH, and there is none; nothing changed");
  const env = { ...real.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" };
  for (const k of Object.keys(env)) if (["GH_REPO", "GH_CONFIG_DIR"].includes(k.toUpperCase())) delete env[k];
  env.GH_CONFIG_DIR = lib.humanGhDir();
  const cwd = lib.mainRoot(common);
  const call = (args, input) => {
    const r = spawnSync(real.bin, args, { cwd, input, encoding: "utf8", timeout: GH_MS, maxBuffer: 64 << 20, windowsHide: true, env, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    return { ok: r.status === 0, out: String(r.stdout || "").trim(), err: String(r.stderr || (r.error && r.error.message) || `exit ${r.status}`).trim().split("\n")[0] };
  };
  return Object.assign(call, { path: real.path });
}
const need = (r, what) => (r.ok ? r.out : fail(`proteus: ${what}: ${r.err}; nothing changed`));

// what the host holds that this export did not put there: with no map, anything
function foreign(gh, target, map) {
  const branches = lines(need(gh(["api", "--paginate", `repos/${target}/branches`, "--jq", '.[] | .name + " " + .commit.sha']), `cannot list ${target}'s branches`));
  const list = (cmd) => lines(need(gh([cmd, "list", "--repo", target, "--state", "all", "--limit", "1000000", "--json", "number", "--jq", ".[].number"]), `cannot list ${target}'s ${cmd === "pr" ? "pull requests" : "issues"}`));
  const hosted = (kind) => new Set(Object.values(map ? map.items : {}).filter((e) => e.kind === kind).map((e) => String(e.host)));
  const pushed = map ? map.refs : {}, issues = hosted("issue"), pulls = hosted("pr");
  return [
    ...branches.filter((l) => { const [name, sha] = l.split(" "); return pushed[name] !== sha; }).map((l) => `branch ${l.split(" ")[0]}`),
    ...list("issue").filter((n) => !issues.has(n)).map((n) => `issue ${n}`),
    ...list("pr").filter((n) => !pulls.has(n)).map((n) => `pull request ${n}`),
  ];
}

// every refusal; nothing here writes. Returns what the export needs
function preflight(o) {
  const common = lib.localCommon(o.cwd);
  if (!common) fail("proteus: --export moves a repo in local mode, and this one is not; nothing changed");
  if (!lib.leadWritable(common)) fail(`proteus: ${SANDBOX}`);
  if (!/^[\w.-]+\/[\w.-]+$/.test(o.target) || o.target.startsWith("-")) fail(`proteus: --export needs <owner/repo>, not ${JSON.stringify(o.target)}`);
  const s = pr.openPr(common), runs = lib.runBranches(common);
  if (runs.length) fail(`proteus: run ${runs[0]} is open; close it before --export; nothing changed`);
  const pending = pr.pendingChecks(s);
  if (pending.length) fail(`proteus: a local check is pending on ${pending[0].slice(0, 12)}; wait for it before --export; nothing changed`);
  const map = readMap(common);
  if (map && map.target.toLowerCase() !== o.target.toLowerCase()) fail(`proteus: an export to ${map.target} is under way; a different target is refused while its map exists (${lib.leadPath(common, local.EXPORT_MAP)}); nothing changed`);
  const stray = pr.originValues(s).find((v) => !pr.sameRepo(v, s.origin) && !(map && v === map.url));
  if (stray) fail(`proteus: origin is ${stray}, neither this repo's local origin nor the export's target; nothing changed`);
  const data = records(s);
  const gh = hostCaller(common);
  need(gh(["auth", "status"]), "gh is not signed in (run gh auth login yourself)");
  const view = JSON.parse(need(gh(["repo", "view", o.target, "--json", "visibility,viewerPermission,url,sshUrl"]), `${o.target} cannot be read, and export never creates a repo: make it on the host first`) || "{}");
  const visibility = String(view.visibility || "").toUpperCase();
  if (!PRIVATE.includes(visibility) && !o.allowPublic) fail(`proteus: ${o.target} is ${visibility.toLowerCase() || "not known to be private"}: everything, agent-written records included, becomes readable by anyone. Pass --public if you mean that; nothing changed`);
  if (!WRITERS.includes(String(view.viewerPermission).toUpperCase())) fail(`proteus: you have no write permission on ${o.target}; nothing changed`);
  const others = foreign(gh, o.target, map);
  if (others.length) fail(`proteus: ${o.target} is not empty (${others.slice(0, 3).join(", ")}): export goes only into an empty repo, or resumes its own run; nothing changed`);
  const ssh = gh(["config", "get", "git_protocol"]).out === "ssh";
  const url = String((ssh && view.sshUrl) || view.url || "");
  if (!url || url.startsWith("-")) fail(`proteus: gh gave no usable address for ${o.target}; nothing changed`);
  return { common, s, gh, map, data, visibility, url };
}

const refs = (s) => lib.gitIn(s.origin, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/tags"], 30000).split("\n").filter(Boolean);

function plan(o, p, log) {
  const count = (pre) => refs(p.s).filter((r) => r.startsWith(pre)).length;
  const posts = [...p.data.issues, ...p.data.pulls];
  const open = p.data.pulls.filter((x) => x.wasOpen).length;
  log(`Export to ${o.target} (${p.visibility.toLowerCase()}):`);
  log(`  ${count("refs/heads/")} branches, ${count("refs/tags/")} tags`);
  log(`  ${p.data.issues.length} issues, ${posts.reduce((n, x) => n + x.notes.length, 0)} comments`);
  log(`  ${open} open pull requests, ${p.data.pulls.length - open} closed pull requests`);
  log(p.map ? "  resumes the export already under way" : "  the target is empty");
  log("");
  log(EXPORT_WARNING);
  log("");
  log("Nothing changed. Add --yes to carry this out.");
}

function push(p) {
  const heads = lib.gitIn(p.s.origin, ["for-each-ref", "--format=%(refname:lstrip=2) %(objectname)", "refs/heads"], 30000).split("\n").filter(Boolean);
  p.map.refs = { ...p.map.refs, ...Object.fromEntries(heads.map((l) => l.split(" "))) };
  save(p);
  if (!refs(p.s).length) return;
  const r = lib.gitTry(p.s.origin, ["push", "--atomic", p.url, "refs/heads/*:refs/heads/*", "refs/tags/*:refs/tags/*"], { user: true, timeout: PUSH_MS, env: p.gh.path });
  if (!r.ok) stop("the push", r.err.split("\n").pop());
}
const save = (p) => lib.leadJSON(p.common, lib.leadPath(p.common, local.EXPORT_MAP), p.map);
const stop = (what, why) => fail(`proteus: export stopped at ${what}: ${why}. Local mode is still on; fix that and run the same command to resume`);
const hostNumber = (out) => { const m = /\/(\d+)\s*$/.exec(out); return m ? Number(m[1]) : 0; };

function labels(p, target) {
  for (const l of p.data.labels) {
    if (p.map.labels.includes(l.name)) continue;
    const r = p.gh(["label", "create", "--repo", target, "--color", l.color, "--description", neutral(l.description), "--force", "--", l.name]);
    if (!r.ok) stop(`label ${l.name}`, r.err);
    p.map.labels.push(l.name);
    save(p);
  }
}
function created(p, target, x) {
  const flags = x.kind === "pr"
    ? ["pr", "create", "--repo", target, "--base", x.base, "--head", x.head, ...(x.draft ? ["--draft"] : [])]
    : ["issue", "create", "--repo", target, ...x.labels.flatMap((l) => ["--label", l])];
  const r = p.gh([...flags, "--title", x.title, "--body-file", "-"], x.body);
  if (!r.ok) stop(x.name, r.err);
  const host = hostNumber(r.out) || stop(x.name, `gh printed no number: ${r.out}`);
  p.map.items[x.key] = { host, kind: x.kind, notes: 0, closed: false };
  save(p);
}
function item(p, target, x) {
  if (!p.map.items[x.key]) created(p, target, x);
  const e = p.map.items[x.key];
  for (; e.notes < x.notes.length; e.notes++, save(p)) {
    const r = p.gh([x.kind, "comment", String(e.host), "--repo", target, "--body-file", "-"], x.notes[e.notes]);
    if (!r.ok) stop(`${x.name} comment ${e.notes + 1}`, r.err);
  }
  if (!x.closed || e.closed) return;
  const r = p.gh(["issue", "close", String(e.host), "--repo", target]);
  if (!r.ok) stop(`closing ${x.name}`, r.err);
  e.closed = true;
  save(p);
}
// origin first: a failure before the marker goes leaves local mode on, the remote recorded, and a rerun finishes it
function moveOrigin(p) {
  const set = lib.gitTry(p.common, ["config", "--replace-all", "remote.origin.url", p.url]);
  if (!set.ok) stop("setting origin", set.err);
  if (lib.gitIn(p.common, ["config", "--get-all", "remote.origin.pushurl"])) {
    const unset = lib.gitTry(p.common, ["config", "--unset-all", "remote.origin.pushurl"]);
    if (!unset.ok) stop("setting origin", unset.err);
  }
  lib.leadRemove(p.common, lib.leadPath(p.common, "local-mode"));
}

function run(o, log) {
  const p = preflight(o);
  if (!o.yes) { plan(o, p, log); return null; }
  const branch = pr.defaultBranch(p.s.origin);
  p.map = p.map || { target: o.target, url: p.url, refs: {}, labels: [], items: {} };
  p.map.url = p.url;
  push(p);
  labels(p, o.target);
  for (const x of [...p.data.issues, ...p.data.pulls]) item(p, o.target, x);
  moveOrigin(p);
  log(`Exported to ${o.target}. Local and host numbers: ${lib.leadPath(p.common, local.EXPORT_MAP)}`);
  log(`The store and the bare origin stay on disk as an archive: ${lib.localPath(p.common)}`);
  return { branch };
}

module.exports = { run, neutral, EXPORT_WARNING };

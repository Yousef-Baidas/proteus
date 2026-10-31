#!/usr/bin/env node
// The trusted verdict on a review or question issue: the newest comment whose first line opens with ACCEPT, CHANGES or
// ANSWER from the human's login, or AUTO-ACCEPT / AUTO-HOLD from the human's or the agents' login. Every other author is
// ignored, so a passer-by on a public repo cannot accept a milestone, and the keyword must stand alone (ACCEPTED is not ACCEPT).
//   node .claude/hooks/proteus-verdict.js <issue>          print that comment's body, or nothing
//   node .claude/hooks/proteus-verdict.js <issue> --wait   check every PROTEUS_VERDICT_POLL_S seconds (default 30) until one arrives
// The human is "human" in ~/.claude/proteus.json, else the login gh is authenticated as. The agents are the login of their own
// gh config ("agentGh", install.js --agent-login), else that same login: identity=shared, where an agent's ACCEPT counts too
// and the warning on stderr says so.
// ACCEPT or AUTO-ACCEPT on a review issue is not counted while its milestone has open tickets or the tracker cannot
// say (lib.reviewGateShut, #254): stderr says why, and --wait keeps waiting. CHANGES still counts.
// Exits 0 with a verdict printed, 1 without one (gh unreachable included), 2 on bad usage.
//   node .claude/hooks/proteus-verdict.js <issue> --post --body-file <file> --sha <sha256>
// posts the human's verdict: the file's bytes, if their sha256 is still <sha256> and the first line opens with ACCEPT,
// CHANGES or ANSWER, on a proteus-review or proteus-question issue, under the human's own gh login (GH_CONFIG_DIR
// dropped, or "humanGh" in proteus.json), and only when that login is the human. In a session the PreToolUse hook asks
// the human first and denies agents (proteus-lib humanPost); in the human's own terminal it just runs.
// A pull request <n> (not such an issue) takes the policy's merge verdict (#307): the first line is ACCEPT <sha12> for its
// current head, as next's ASK human line prints it, or CHANGES. An ACCEPT for any other head is refused.
// Exits 0 posted, 1 refused or failed (nothing posted), 2 on bad usage.
// In local mode (#310) human verdicts come only from the verdict record (lib.humanVerdicts), never a comment, whoever it
// names; AUTO-ACCEPT and AUTO-HOLD still come from comments, merged by time. --post appends to the record first, then
// writes the comment as a copy for reading. A refused write (the sandbox) passes only for a post with a pending entry,
// which the hook records; else nothing is recorded or posted and it exits 1. A failed comment after a written record
// says so and exits 1.
// Run from any dir but the session's hooks dir (proteus-lead/hooks-root, #277): exit 1, naming that dir.
"use strict";
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const lib = require(path.join(__dirname, "proteus-lib.js"));
lib.hooksRootOnly(__filename); // #277: never a copy but the session's hooks dir
lib.homeOnly(__filename); // #234: never a copy outside the main checkout's hooks dir

const AUTO = /^(AUTO-ACCEPT|AUTO-HOLD)(?=\s|$)/;
const ACCEPTS = /^(ACCEPT|AUTO-ACCEPT)(?=\s|$)/;

// why an accept on this issue does not count yet: on a review issue, the gate's reason; null otherwise
function gateShut(body, view, root) {
  if (!ACCEPTS.test(body.split(/\r?\n/, 1)[0].trim())) return null;
  if (!(view.labels || []).some((l) => /^(proteus|hive)-review$/.test(String((l && l.name) || "")))) return null;
  return lib.reviewGateShut(view.milestone && view.milestone.title, root);
}

// the newest comment a trusted author opened with a verdict keyword; null when there is none
function pick(comments, human, agent) {
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i] || {};
    const who = c.author && c.author.login;
    const body = String(c.body || "").trim();
    const first = body.split(/\r?\n/, 1)[0].trim();
    if (who === human && (lib.isVerdict(body) || AUTO.test(first))) return body; // the guards refuse exactly lib.isVerdict from an agent
    if (who && who === agent && AUTO.test(first)) return body;
  }
  return null;
}

// local mode: the newer of the human's newest record entry and the newest AUTO comment, the human's on a tie. A
// comment's time is the store's, so one dated in the future is no comment
function pickLocal(comments, verdicts) {
  const now = Date.now(), said = verdicts[verdicts.length - 1];
  let auto = null;
  for (const c of comments) {
    const body = String((c && c.body) || "").trim(), at = Date.parse(c && c.createdAt);
    if (AUTO.test(body.split(/\r?\n/, 1)[0].trim()) && at <= now && (!auto || at >= auto.at)) auto = { body, at };
  }
  if (auto && (!said || auto.at > Date.parse(said.at))) return auto.body;
  return said ? said.body.trim() : null;
}

const USAGE = "usage: proteus-verdict.js <issue> [--wait] | <issue> --post --body-file <file> --sha <sha256>";

// --post: { issue, file, sha } from argv, or null on bad usage
function postUsage(args) {
  const o = { issue: "", file: "", sha: "" };
  for (let i = 0; i < args.length; i++) {
    const a = args[i], m = /^(--body-file|--sha)=(.*)$/.exec(a);
    if (/^\d+$/.test(a) && !o.issue) o.issue = a;
    else if (a === "--post") continue;
    else if (m) o[m[1] === "--sha" ? "sha" : "file"] = m[2];
    else if ((a === "--body-file" || a === "--sha") && i + 1 < args.length) o[a === "--sha" ? "sha" : "file"] = args[++i];
    else return null;
  }
  return o.issue && o.file && o.file !== "-" && /^[0-9a-f]{64}$/i.test(o.sha) ? o : null;
}

// why a verdict line cannot go on pull request <n>: it is no open PR, or an ACCEPT not for its current head; null to post
function prVerdict(n, first, root) {
  let v = null;
  try { v = JSON.parse(lib.gh(["pr", "view", n, "--json", "headRefOid,state"], root, 6000, lib.agentGhDir())); } catch {}
  const head = v && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(String(v.headRefOid)) ? String(v.headRefOid).slice(0, 12) : "";
  if (!head || v.state !== "OPEN") return `#${n} is no proteus-review or proteus-question issue and no open pull request (or gh could not read it)`;
  if (/^CHANGES(?=\s|$)/.test(first)) return null;
  if (first === `ACCEPT ${head}`) return null;
  return `on a pull request the first line is ACCEPT ${head} (its current head) or CHANGES, not "${first.slice(0, 80)}"`;
}

function post(args, root) {
  const o = postUsage(args);
  if (!o) { console.error(USAGE); return 2; }
  const no = (why) => { console.error(`proteus-verdict --post: ${why}; nothing posted.`); return 1; };
  let body;
  try { body = fs.readFileSync(path.resolve(o.file)); } catch { return no(`cannot read ${o.file}`); }
  const sha = crypto.createHash("sha256").update(body).digest("hex");
  if (sha !== o.sha.toLowerCase()) return no(`${o.file} has sha256 ${sha}, not ${o.sha}: it changed after it was approved`);
  if (!lib.VERDICT_LINE.test(body.toString("utf8").split(/\r?\n/, 1)[0].trim())) return no("the first line must open with ACCEPT, CHANGES or ANSWER");
  const who = lib.humanLogin(root);
  if (who.error) return no(who.error);
  const issue = lib.reviewIssue(o.issue, root);
  if (!issue) {
    const why = prVerdict(o.issue, body.toString("utf8").split(/\r?\n/, 1)[0].trim(), root);
    if (why) return no(why);
  }
  const common = lib.localCommon(root);
  let recorded = false;
  if (common) {
    const text = body.toString("utf8");
    try { lib.recordVerdict(common, o.issue, issue ? "issue" : "pr", text); recorded = true; } catch (e) {
      const hash = crypto.createHash("sha256").update(text).digest("hex");
      if (!lib.pendingVerdicts(common).some((p) => p.number === Number(o.issue) && p.sha256 === hash)) { console.error(`proteus-verdict --post: the verdict record refused it (${e.message}); nothing recorded, nothing posted.`); return 1; }
    }
  }
  const r = lib.ghHuman([issue ? "issue" : "pr", "comment", o.issue, "--body-file", "-"], root, { input: body });
  if (!r.ok && recorded) { console.error(`proteus-verdict --post: the verdict is recorded, but its comment failed: ${r.err.split(/\r?\n/, 1)[0] || "no output"}`); return 1; }
  if (!r.ok) return no(`gh ${issue ? "issue" : "pr"} comment failed: ${r.err.split(/\r?\n/, 1)[0] || "no output"}`);
  console.log(`posted as ${who.login}: ${r.out.split(/\r?\n/).pop()}`);
  return 0;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--post")) return post(args, path.resolve(lib.projectRoot()));
  const issue = args.find((a) => /^\d+$/.test(a));
  if (!issue) { console.error(USAGE); return 2; }
  const root = path.resolve(lib.projectRoot());
  const local = lib.localCommon(root);
  let human = "", agent = "";
  if (!local) {
    const own = lib.agentGhDir();
    agent = lib.gh(["api", "user", "--jq", ".login"], root, 6000, own);
    // with a login of their own, this process may be running as either one: only the config names the human
    human = String(lib.proteusConfig().human || "").trim() || (own ? "" : agent);
    if (!human) { console.error(`proteus-verdict: no human login (${own ? "agentGh is set but" : "gh not logged in and"} no "human" in ~/.claude/proteus.json; install.js --agent-login writes it)`); return 1; }
    if (human === agent) console.error(`proteus-verdict: identity=shared: agents post as ${human}, so an agent's ACCEPT would count too`);
  }
  const pollMs = lib.envInt("PROTEUS_VERDICT_POLL_S", 30) * 1000;
  let said = "";
  for (;;) {
    // the stand-in's numbers are not gh's: a PR is no issue there
    const view = JSON.parse(lib.gh(["issue", "view", issue, "--json", "comments,labels,milestone"], root) || (local && lib.gh(["pr", "view", issue, "--json", "comments"], root)) || "null");
    const listed = view && Array.isArray(view.comments);
    const v = !listed ? null : local ? pickLocal(view.comments, lib.humanVerdicts(root, issue)) : pick(view.comments, human, agent);
    const shut = v && gateShut(v, view, root);
    if (v && !shut) { console.log(v); return 0; }
    if (shut && shut !== said) console.error(`proteus-verdict: ${v.split(/\r?\n/, 1)[0].trim()} not counted: ${(said = shut)}`);
    if (!args.includes("--wait")) return 1;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pollMs);
  }
}

process.exitCode = main();

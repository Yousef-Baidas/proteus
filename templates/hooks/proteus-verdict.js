#!/usr/bin/env node
// The trusted verdict on a review or question issue: the newest comment whose first line opens with ACCEPT, CHANGES or
// ANSWER from the human's login, or AUTO-ACCEPT / AUTO-HOLD from the human's or the agents' login. Every other author is
// ignored, so a passer-by on a public repo cannot accept a milestone, and the keyword must stand alone (ACCEPTED is not ACCEPT).
//   node .claude/hooks/proteus-verdict.js <issue>          print that comment's body, or nothing
//   node .claude/hooks/proteus-verdict.js <issue> --wait   check every PROTEUS_VERDICT_POLL_S seconds (default 30) until one arrives
// The human is "human" in ~/.claude/proteus.json, else the login gh is authenticated as. The agents are the login of their own
// gh config ("agentGh", install.js --agent-login), else that same login: identity=shared, where an agent's ACCEPT counts too
// and the warning on stderr says so.
// Exits 0 with a verdict printed, 1 without one (gh unreachable included), 2 on bad usage.
//   node .claude/hooks/proteus-verdict.js <issue> --post --body-file <file> --sha <sha256>
// posts the human's verdict: the file's bytes, if their sha256 is still <sha256> and the first line opens with ACCEPT,
// CHANGES or ANSWER, on a proteus-review or proteus-question issue, under the human's own gh login (GH_CONFIG_DIR
// dropped, or "humanGh" in proteus.json), and only when that login is the human. In a session the PreToolUse hook asks
// the human first and denies agents (proteus-lib humanPost); in the human's own terminal it just runs.
// Exits 0 posted, 1 refused or failed (nothing posted), 2 on bad usage.
"use strict";
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const lib = require(path.join(__dirname, "proteus-lib.js"));

const HUMAN_ONLY = /^(ACCEPT|CHANGES|ANSWER)(?=\s|$)/;
const AUTO = /^(AUTO-ACCEPT|AUTO-HOLD)(?=\s|$)/;

// the newest comment a trusted author opened with a verdict keyword; null when there is none
function pick(comments, human, agent) {
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i] || {};
    const who = c.author && c.author.login;
    const body = String(c.body || "").trim();
    const first = body.split(/\r?\n/, 1)[0].trim();
    if (who === human && (HUMAN_ONLY.test(first) || AUTO.test(first))) return body;
    if (who && who === agent && AUTO.test(first)) return body;
  }
  return null;
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
  const labels = lib.gh(["issue", "view", o.issue, "--json", "labels", "-q", ".labels[].name"], root, 6000, lib.agentGhDir()).split(/\r?\n/);
  if (!labels.some((l) => /^(proteus|hive)-(review|question)$/.test(l.trim()))) return no(`#${o.issue} is no proteus-review or proteus-question issue (or gh could not read it)`);
  const r = lib.ghHuman(["issue", "comment", o.issue, "--body-file", "-"], root, { input: body });
  if (!r.ok) return no(`gh issue comment failed: ${r.err.split(/\r?\n/, 1)[0] || "no output"}`);
  console.log(`posted as ${who.login}: ${r.out.split(/\r?\n/).pop()}`);
  return 0;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--post")) return post(args, path.resolve(lib.projectRoot()));
  const issue = args.find((a) => /^\d+$/.test(a));
  if (!issue) { console.error(USAGE); return 2; }
  const root = path.resolve(lib.projectRoot());
  const own = lib.agentGhDir();
  const agent = lib.gh(["api", "user", "--jq", ".login"], root, 6000, own);
  // with a login of their own, this process may be running as either one: only the config names the human
  const human = String(lib.proteusConfig().human || "").trim() || (own ? "" : agent);
  if (!human) { console.error(`proteus-verdict: no human login (${own ? "agentGh is set but" : "gh not logged in and"} no "human" in ~/.claude/proteus.json; install.js --agent-login writes it)`); return 1; }
  if (human === agent) console.error(`proteus-verdict: identity=shared: agents post as ${human}, so an agent's ACCEPT would count too`);
  const pollMs = lib.envInt("PROTEUS_VERDICT_POLL_S", 30) * 1000;
  for (;;) {
    const view = JSON.parse(lib.gh(["issue", "view", issue, "--json", "comments"], root) || "null");
    const v = view && Array.isArray(view.comments) ? pick(view.comments, human, agent) : null;
    if (v) { console.log(v); return 0; }
    if (!args.includes("--wait")) return 1;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pollMs);
  }
}

process.exitCode = main();

#!/usr/bin/env node
// A verifier's verdict as a commit status on the PR head it reviewed, the status the ruleset on proteus/*
// requires (install.js --protect; the per-run protection in enforcement.md §1 names the same contexts):
//   node <hooks>/proteus-signoff.js <pr> <reviewed-sha> MERGE|BACK-TO-WORKER|CONTRACT-WRONG [--security]
// MERGE posts success, the other two failure, on proteus/verdict, or with --security on proteus/security (the
// security verifier's). A status belongs to one commit, so a push after the review leaves the new head without
// one: the PR cannot merge until a verifier reviews that head. The script refuses when the PR head is no longer
// <reviewed-sha>, so a verdict never lands on code the verifier did not read, and refuses MERGE while the PR's head
// branch has an open guard-violation record (proteus-shell-check.js: a shell call changed a guarded path or another
// worktree, and it is not back as it was).
// With a verifier App in proteus.json (install.js --verifier-app) it posts with an installation token of that App
// (lib.appToken; GH_TOKEN on the one gh call, never on disk or argv), and the ruleset counts only the App's two
// statuses, so a status a worker posts with the agents' token does not count. A token that cannot be minted fails
// the signoff: never a quiet fall back to the agents' login. With the App, a MERGE without --security also carries
// CI's no-security-path success over as the App's (securityMirror), and is refused until CI has posted.
// Without an App it posts as the agents' login (lib.agentGhDir, else this process's gh). The hooks refuse a
// hand-posted status (lib.branchDenial) and this script from anyone but a verifier (lib.signoffDenial, the lead
// guard); without the App that is a guard, not a boundary: a worker sharing the agents' token can post a status
// with its own script (#69).
// Exit 0 posted, 1 refused or gh failed (the message says which), 2 bad usage.
// Run from any dir but the session's hooks dir (proteus-lead/hooks-root, #277): exit 1, naming that dir.
"use strict";
const path = require("path");
const lib = require(path.join(__dirname, "proteus-lib.js"));
lib.hooksRootOnly(__filename); // #277: never a copy but the session's hooks dir

const WORDS = { MERGE: "success", "BACK-TO-WORKER": "failure", "CONTRACT-WRONG": "failure" };
const USAGE = "usage: proteus-signoff.js <pr> <reviewed-sha> MERGE|BACK-TO-WORKER|CONTRACT-WRONG [--security]";

async function main(argv) {
  const security = argv.includes("--security");
  const [pr, sha, word, ...rest] = argv.filter((a) => a !== "--security");
  if (!/^\d+$/.test(pr || "") || !/^[0-9a-f]{7,40}$/i.test(sha || "") || !WORDS[word] || rest.length) { console.error(USAGE); return 2; }
  const cwd = process.cwd();
  const as = lib.agentGhDir();
  const run = (args) => lib.gh(args, cwd, 30000, as);
  const head = run(["pr", "view", pr, "--json", "headRefOid", "-q", ".headRefOid"]).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(head)) { console.error(`proteus-signoff: gh pr view ${pr} failed; nothing posted. Check gh auth status and the PR number.`); return 1; }
  if (!head.startsWith(sha.toLowerCase())) {
    console.error(`proteus-signoff: PR #${pr}'s head is ${head.slice(0, 12)}, not the ${sha.slice(0, 12)} you reviewed; nothing posted. Review the new commits (gh pr diff ${pr}) and sign off on the head you read.`);
    return 1;
  }
  if (word === "MERGE") {
    const open = await tampered(cwd, pr, run);
    if (open) { console.error(open); return 1; }
  }
  const context = security ? "proteus/security" : "proteus/verdict";
  const app = lib.verifierApp();
  let repo = process.env.GITHUB_REPOSITORY || "{owner}/{repo}", token = "", mirror = null;
  if (app) {
    if (!process.env.GITHUB_REPOSITORY) repo = run(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { console.error("proteus-signoff: gh repo view failed to name the repo; nothing posted. Retry."); return 1; }
    try { token = await lib.appToken(repo, app); } catch (e) {
      console.error(`proteus-signoff: the verifier App ${app.appId} gave no token (${e.message}); nothing posted. The ruleset counts only the App's status: report this to the lead for the human (install.js --doctor names the fix).`);
      return 1;
    }
    if (word === "MERGE" && !security) {
      mirror = securityMirror(pr, head, repo, run);
      if (mirror.why) { console.error(`proteus-signoff: ${mirror.why}`); return 1; }
    }
  }
  const post = (ctx, state, description) => lib.gh(["api", "-X", "POST", `repos/${repo}/statuses/${head}`, "-f", `state=${state}`, "-f", `context=${ctx}`, "-f", `description=${description}`, "--jq", ".state"], cwd, 30000, as, token);
  const by = security ? "the security verifier" : "the verifier";
  const state = post(context, WORDS[word], `${word} by ${by}`);
  if (state !== WORDS[word]) { console.error(`proteus-signoff: posting ${context} on ${head.slice(0, 12)} failed (gh api returned "${state}"); the PR has no verdict status. Retry, or report the error to the lead.`); return 1; }
  console.log(`proteus-signoff: ${context} = ${state} (${word}) on PR #${pr} at ${head.slice(0, 12)}${app ? ` as App ${app.appId}` : ""}`);
  if (mirror && mirror.note) console.log(`proteus-signoff: ${mirror.note}`);
  if (mirror && mirror.carry) {
    const got = post("proteus/security", "success", CARRIED);
    if (got !== "success") { console.error(`proteus-signoff: carrying CI's proteus/security over to the App failed (gh api returned "${got}"); the verdict is posted, the PR still lacks proteus/security. Run the same signoff again.`); return 1; }
    console.log(`proteus-signoff: proteus/security = success (CI found no security path) carried over as App ${app.appId}`);
  }
  return 0;
}

// With the App, the ruleset counts only the App's proteus/security, so CI's success on a PR that touches no
// security path (proteus-trust.yml posts it as github-actions) no longer satisfies it. The verifier's MERGE carries
// that success over as the App's when the head's newest proteus/security is CI's success and the PR's files match
// no glob of the security block in the base branch's teams/ROUTING.md (read through the API, not the worktree, so a
// status or a ROUTING.md the PR forged does not count). CI's failure stays for the security verifier's --security.
// { carry } or { note } or { why }: why refuses the signoff (CI has not posted, or the API failed).
const CI_LOGIN = "github-actions[bot]";
const CI_SAYS = ["no security path touched", "no security block in teams/ROUTING.md; nothing checked"]; // proteus-security.js
const CARRIED = "no security path touched (CI); carried over by the verifier's MERGE";
function securityMirror(pr, head, repo, run) {
  let list = null;
  try { list = JSON.parse(run(["api", `repos/${repo}/commits/${head}/statuses`])); } catch {}
  if (!Array.isArray(list)) return { why: `cannot read the statuses of ${head.slice(0, 12)}; nothing posted. Retry.` };
  const ci = list.find((x) => x && x.context === "proteus/security"); // newest first
  if (!ci) return { why: `CI has not posted proteus/security on ${head.slice(0, 12)} yet; nothing posted. Wait for proteus-trust (gh pr checks ${pr} --watch), then sign off again.` };
  if (ci.state !== "success" || !ci.creator || ci.creator.login !== CI_LOGIN || !CI_SAYS.includes(ci.description)) return {};
  const base = run(["pr", "view", pr, "--json", "baseRefName", "-q", ".baseRefName"]);
  if (!base) return { why: `gh pr view ${pr} failed to name the base branch; nothing posted. Retry.` };
  const b64 = run(["api", `repos/${repo}/contents/teams/ROUTING.md?ref=${encodeURIComponent(base)}`, "-q", ".content"]);
  const globs = lib.parseSecurity(b64 ? Buffer.from(b64, "base64").toString("utf8") : "") || [];
  if (!globs.length) return ci.description === CI_SAYS[1] ? { carry: true } : { note: `proteus/security not carried over: CI read a security block in ${base}'s teams/ROUTING.md that the API does not show; the security verifier signs off with --security.` };
  const listed = run(["api", "--paginate", `repos/${repo}/pulls/${pr}/files`, "--jq", ".[] | .filename, (.previous_filename // empty)"]);
  if (!listed) return { why: `cannot list PR #${pr}'s files; nothing posted. Retry.` };
  const hits = [...new Set(listed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))].filter((p) => globs.some((g) => lib.tierMatch(g, p)));
  return hits.length ? { note: `proteus/security not carried over: ${hits.slice(0, 3).join(", ")}${hits.length > 3 ? ", ..." : ""} match the security block of ${base}'s teams/ROUTING.md though CI said none; the security verifier signs off with --security.` } : { carry: true };
}

// a MERGE is refused while the PR's head branch has a guard-violation record (proteus-shell-check.js) whose
// paths still differ from their state before, re-checked here (openFor) rather than taken from the record's
// open flag, so a record whose agent has ended stops counting once its paths are back or explained (#182): the PR
// asks for review, not the worktree that holds the change. A record with only a missing snapshot on it clears once
// its agent has ended and its worktree matches the branch's commit; with that worktree gone, only the human clears it
async function tampered(cwd, pr, run) {
  const common = lib.gitCommonDir(lib.gitRoot(cwd) || cwd);
  if (!common) return "";
  let check;
  try { check = require(path.join(__dirname, "proteus-shell-check.js")); } catch { return ""; }
  const fs = require("fs");
  let any = false;
  try { any = fs.readdirSync(check.tamperDir(common)).some((n) => n.endsWith(".json")); } catch {}
  if (!any) return "";
  const branch = run(["pr", "view", pr, "--json", "headRefName", "-q", ".headRefName"]);
  if (!branch) return `proteus-signoff: gh pr view ${pr} failed to name the head branch, and the guard has violation records to check it against; nothing posted. Retry.`;
  const open = await check.openFor(common, branch);
  if (!open.length) return "";
  const slash = (p) => String(p).split(path.sep).join("/");
  // a record with only a missing snapshot, whose ended agent's worktree is gone: nothing is left to re-check (#229)
  const lost = open.filter((r) => r.left.some((i) => i.gone));
  if (lost.length) return `proteus-signoff: ${branch} has an open guard-violation record of an ended agent whose shell call lost the guard's snapshot, and its worktree ${lost.map((r) => slash(r.worktree || "(none)")).join(", ")} is gone, so the guard cannot compare it with the branch's commit; no MERGE is posted. Raise it to the lead for the human, who clears it: read the PR's diff (gh pr diff ${pr}) and check the hooks, gates and CLI settings in every checkout, then delete ${lost.map((r) => slash(r.file)).join(" and ")} and sign off again.`;
  const paths = open.flatMap((r) => r.left.map((i) => i.path || i.worktree || "the guard's snapshot")).map(slash);
  return `proteus-signoff: ${branch} has an open guard-violation record (a shell call changed ${paths.slice(0, 6).join(", ")}${paths.length > 6 ? ", ..." : ""}, which hold Proteus's hooks, gates, git internals or another worktree); no MERGE is posted while they differ from their state before. Send the ticket BACK-TO-WORKER to restore them, or raise it to the lead.`;
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; });

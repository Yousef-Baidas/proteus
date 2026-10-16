#!/usr/bin/env node
// A verifier's verdict as a commit status on the PR head it reviewed, the status the ruleset on proteus/*
// requires (install.js --protect; the per-run protection in enforcement.md §1 names the same contexts):
//   node <hooks>/proteus-signoff.js <pr> <reviewed-sha> MERGE|BACK-TO-WORKER|CONTRACT-WRONG [--security]
// MERGE posts success, the other two failure, on proteus/verdict, or with --security on proteus/security (the
// security verifier's). A status belongs to one commit, so a push after the review leaves the new head without
// one: the PR cannot merge until a verifier reviews that head. The script refuses when the PR head is no longer
// <reviewed-sha>, so a verdict never lands on code the verifier did not read.
// It posts as the agents' login (lib.agentGhDir, else this process's gh). The hooks refuse a hand-posted status
// (lib.branchDenial) and this script from anyone but a verifier (lib.signoffDenial, the lead guard); that is a
// guard, not a boundary: a worker sharing the agents' token can post a status with its own script (#69).
// Exit 0 posted, 1 refused or gh failed (the message says which), 2 bad usage.
"use strict";
const path = require("path");
const lib = require(path.join(__dirname, "proteus-lib.js"));

const WORDS = { MERGE: "success", "BACK-TO-WORKER": "failure", "CONTRACT-WRONG": "failure" };
const USAGE = "usage: proteus-signoff.js <pr> <reviewed-sha> MERGE|BACK-TO-WORKER|CONTRACT-WRONG [--security]";

function main(argv) {
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
  const context = security ? "proteus/security" : "proteus/verdict";
  const repo = process.env.GITHUB_REPOSITORY || "{owner}/{repo}";
  const by = security ? "the security verifier" : "the verifier";
  const state = run(["api", "-X", "POST", `repos/${repo}/statuses/${head}`, "-f", `state=${WORDS[word]}`, "-f", `context=${context}`, "-f", `description=${word} by ${by}`, "--jq", ".state"]);
  if (state !== WORDS[word]) { console.error(`proteus-signoff: posting ${context} on ${head.slice(0, 12)} failed (gh api returned "${state}"); the PR has no verdict status. Retry, or report the error to the lead.`); return 1; }
  console.log(`proteus-signoff: ${context} = ${state} (${word}) on PR #${pr} at ${head.slice(0, 12)}`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));

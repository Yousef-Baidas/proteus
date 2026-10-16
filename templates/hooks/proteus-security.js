#!/usr/bin/env node
// The security trigger, judged by CI instead of the lead: does this PR need the security verifier?
//   node teams/templates/hooks/proteus-security.js --ci <pr> <head-sha> [--findings <semgrep.json>]
// Run from a checkout of the PR's base (proteus-trust.yml, on pull_request_target: the base's workflow and
// this script as the base has them, never the PR's). The globs are the ```security block of the base's
// teams/ROUTING.md (lib.parseSecurity, matched like the tiers block); the PR's paths come from the API
// (repos/<repo>/pulls/<pr>/files, both ends of a rename), so no PR code is checked out or run. --findings adds
// the changed paths a semgrep JSON report (`semgrep --json`, run from the PR head's root) has a result in.
// It posts the commit status proteus/security on <head-sha>, which the ruleset on proteus/* requires:
// - no changed path matches and no finding: success, "no security path touched";
// - one does, and the head already has a proteus/security success from the security verifier's signoff
//   (proteus-signoff.js --security): left alone;
// - one does, and no signoff: failure, naming the first paths. The security verifier's MERGE replaces it.
// No security block: success saying so, the pipeline as before the block existed.
// The repo is env GITHUB_REPOSITORY, else gh's {owner}/{repo}. Exit 0 a status posted or kept, 1 gh failed or
// the report is unreadable, 2 bad usage.
"use strict";
const fs = require("fs");
const path = require("path");
const lib = require(path.join(__dirname, "proteus-lib.js"));

const CONTEXT = "proteus/security";
const NONE = "no security path touched";
const NO_BLOCK = "no security block in teams/ROUTING.md; nothing checked";
const USAGE = "usage: proteus-security.js --ci <pr> <head-sha> [--findings <semgrep.json>]";
const fail = (msg) => { console.error(`proteus-security: ${msg}`); return 1; };

function main(argv) {
  const at = argv.indexOf("--findings");
  const report = at >= 0 ? argv[at + 1] : null;
  const pos = at >= 0 ? [...argv.slice(0, at), ...argv.slice(at + 2)] : argv;
  const [mode, pr, sha, ...rest] = pos;
  if (mode !== "--ci" || !/^\d+$/.test(pr || "") || !/^[0-9a-f]{40}$/i.test(sha || "") || rest.length || (at >= 0 && !report)) { console.error(USAGE); return 2; }
  const cwd = process.cwd();
  const repo = process.env.GITHUB_REPOSITORY || "{owner}/{repo}";
  const gh = (args) => lib.gh(args, cwd, 60000);
  const post = (state, description) => {
    const got = gh(["api", "-X", "POST", `repos/${repo}/statuses/${sha}`, "-f", `state=${state}`, "-f", `context=${CONTEXT}`, "-f", `description=${description.slice(0, 140)}`, "--jq", ".state"]);
    if (got !== state) return fail(`posting ${CONTEXT}=${state} on ${sha.slice(0, 12)} failed (gh api returned "${got}")`);
    console.log(`proteus-security: ${CONTEXT} = ${state}: ${description}`);
    return 0;
  };

  let routing = "";
  try { routing = fs.readFileSync(path.join(cwd, "teams", "ROUTING.md"), "utf8"); } catch {}
  const globs = lib.parseSecurity(routing);
  if (!globs || !globs.length) return post("success", NO_BLOCK);

  const listed = gh(["api", "--paginate", `repos/${repo}/pulls/${pr}/files`, "--jq", ".[] | .filename, (.previous_filename // empty)"]);
  if (!listed) return fail(`cannot list PR #${pr}'s files (gh api repos/${repo}/pulls/${pr}/files); no status posted`);
  const changed = [...new Set(listed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))];

  const hits = [];
  for (const p of changed) {
    const g = globs.find((x) => lib.tierMatch(x, p));
    if (g) hits.push(`${p} (${g})`);
  }
  if (report) {
    let found;
    try { found = JSON.parse(fs.readFileSync(report, "utf8")).results; } catch (e) { return fail(`cannot read the semgrep report ${report}: ${e.message}`); }
    const flagged = new Set((Array.isArray(found) ? found : []).map((r) => String((r && r.path) || "").replace(/\\/g, "/").replace(/^\.\//, "")));
    for (const p of changed) if (flagged.has(p) && !hits.some((h) => h.startsWith(`${p} (`))) hits.push(`${p} (semgrep finding)`);
  }
  if (!hits.length) return post("success", NONE);

  const status = (() => { try { return JSON.parse(gh(["api", `repos/${repo}/commits/${sha}/status`])); } catch { return null; } })();
  const mine = ((status && status.statuses) || []).find((s) => s.context === CONTEXT);
  if (mine && mine.state === "success" && mine.description !== NONE && mine.description !== NO_BLOCK) {
    console.log(`proteus-security: ${hits.length} security path(s) touched, and ${CONTEXT} is already signed off: ${mine.description}`);
    return 0;
  }
  console.log(`proteus-security: security paths touched:\n  ${hits.join("\n  ")}`);
  const more = hits.length > 1 ? ` and ${hits.length - 1} more` : "";
  return post("failure", `needs the security verifier: ${hits[0]}${more}`);
}

process.exitCode = main(process.argv.slice(2));

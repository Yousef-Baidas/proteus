#!/usr/bin/env node
// The security trigger, judged by CI instead of the lead: does this PR need the security verifier?
//   node teams/templates/hooks/proteus-security.js --ci <pr> <head-sha> [--findings <report or dir>]
//   node teams/templates/hooks/proteus-security.js --list <report or dir>
// Run from a checkout of the PR's base (proteus-trust.yml's post job, on pull_request_target: the default branch's workflow
// and this script as the base has them, never the PR's; the scan job's findings arrive as an artifact). The globs are the ```security block of the base's
// teams/ROUTING.md (lib.parseSecurity, matched like the tiers block); the PR's paths come from the API
// (repos/<repo>/pulls/<pr>/files, both ends of a rename), so no PR code is run. --findings adds the scanners'
// findings: a SARIF report, or every .sarif and .json in a directory (proteus-scan.js's output), each a regular file
// read as size-capped JSON and nothing else. Every finding counts
// except those the base's teams/baseline.json records under the gate `security` (lines mode, matched
// exactly, digits included, as proteus-baseline.js records that gate); a semgrep JSON report (`semgrep --json`, from the head's root) counts only
// its findings in a changed file.
// It posts the commit status proteus/security on <head-sha>, which the ruleset on proteus/* requires:
// - no changed path matches and no finding: success, "no security path touched";
// - one does, and the head already has a proteus/security success from the security verifier's signoff
//   (proteus-signoff.js --security): left alone;
// - one does, and no signoff: failure, naming the first paths. The security verifier's MERGE replaces it.
// No security block and no --findings: success saying nothing was checked, the pipeline before either existed.
// --list prints each finding as a line `finding <tool> <rule> <path>` and exits 1 when there is one, so the
// baseline ratchet can record them (enforcement.md §4).
// Every line that holds head text opens with a fixed prefix, proteus-security: (finding, for --list).
// The repo is env GITHUB_REPOSITORY, else gh's {owner}/{repo}. Exit 0 a status posted or kept (--list: no
// finding), 1 gh failed or a report is unreadable (--list: a finding), 2 bad usage.
"use strict";
const fs = require("fs");
const path = require("path");
const lib = require(path.join(__dirname, "proteus-lib.js"));

const CONTEXT = "proteus/security";
const NONE = "no security path touched";
const NO_BLOCK = "no security block in teams/ROUTING.md; nothing checked";
const USAGE = "usage: proteus-security.js --ci <pr> <head-sha> [--findings <report or dir>] | --list <report or dir>";
// every line that can hold head text (a path, a rule id, a report's parse error) prints between ::stop-commands::
// markers (lib.fenced), so the runner runs none of it as a workflow command, and all on stdout: the runner shares
// the stop state across streams, so fences on two streams could interleave
const fail = (msg) => { lib.fenced([`proteus-security: ${inert(msg)}`]); return 1; };
// and, a second layer, head text inside one line that opens with a fixed prefix: a control character becomes ?, so
// a newline in a filename cannot start a line, and the prefix keeps a filename starting with :: off the line's start
// (the runner trims leading spaces)
const inert = (s) => String(s).replace(/\p{Cc}/gu, "?");
// the scan job's artifact is data from a VM that read the head: a report is read only as a regular file under a cap
const MAX_REPORTS = 64;
const MAX_REPORT_BYTES = 64 << 20;

// the findings in a report, or in every .sarif and .json of a directory: [{ tool, rule, path, changedOnly }]
function readFindings(report) {
  const files = fs.statSync(report).isDirectory()
    ? fs.readdirSync(report).filter((f) => /\.(sarif|json)$/i.test(f)).sort().map((f) => path.join(report, f)) : [report];
  if (files.length > MAX_REPORTS) throw new Error(`${files.length} reports, more than ${MAX_REPORTS}`);
  const rel = (p) => {
    let s = String(p || "");
    try { s = decodeURI(s); } catch {}
    return s.replace(/^file:\/\//, "").replace(/\\/g, "/").replace(/^(\.\/)+/, "");
  };
  const found = [];
  for (const f of files) {
    const st = fs.lstatSync(f);
    if (!st.isFile()) throw new Error(`${path.basename(f)} is not a regular file`);
    if (st.size > MAX_REPORT_BYTES) throw new Error(`${path.basename(f)} is ${st.size} bytes, more than ${MAX_REPORT_BYTES}`);
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    if (j && Array.isArray(j.runs)) {
      for (const run of j.runs) for (const r of (run && run.results) || []) {
        const loc = ((r && r.locations) || [])[0];
        found.push({ tool: inert((run.tool && run.tool.driver && run.tool.driver.name) || "sarif"), rule: inert((r && (r.ruleId || (r.rule && r.rule.id))) || "finding"),
          path: inert(rel(loc && loc.physicalLocation && loc.physicalLocation.artifactLocation && loc.physicalLocation.artifactLocation.uri) || "(no file)") });
      }
    } else if (j && Array.isArray(j.results)) {
      for (const r of j.results) found.push({ tool: "semgrep", rule: inert((r && r.check_id) || "finding"), path: inert(rel(r && r.path)), changedOnly: true });
    } else throw new Error(`${path.basename(f)} is neither SARIF nor a semgrep JSON report`);
  }
  return found;
}

const line = (f) => `finding ${f.tool} ${f.rule} ${f.path}`;

// the findings the base's teams/baseline.json does not hold under gates.security, compared as a multiset
function unrecorded(found, cwd) {
  const data = lib.readJSON(path.join(cwd, "teams", "baseline.json"), null);
  const entry = data && data.gates && data.gates.security;
  if (!entry || entry.mode === "count" || !Array.isArray(entry.findings)) return found;
  let ignore = null;
  try { ignore = entry.ignore ? new RegExp(entry.ignore, "g") : null; } catch {}
  const left = new Map();
  for (const x of entry.findings) left.set(x, (left.get(x) || 0) + 1);
  return found.filter((f) => { const k = lib.exactFinding(line(f), ignore), n = left.get(k) || 0; if (n) left.set(k, n - 1); return !n; });
}

function main(argv) {
  if (argv[0] === "--list") {
    if (argv.length !== 2) { console.error(USAGE); return 2; }
    let found;
    try { found = readFindings(argv[1]); } catch (e) { return fail(`cannot read the findings ${argv[1]}: ${e.message}`); }
    if (found.length) lib.fenced(found.map(line));
    return found.length ? 1 : 0;
  }
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
    lib.fenced([`proteus-security: ${CONTEXT} = ${state}: ${description}`]);
    return 0;
  };

  let routing = "";
  try { routing = fs.readFileSync(path.join(cwd, "teams", "ROUTING.md"), "utf8"); } catch {}
  const globs = lib.parseSecurity(routing) || [];
  let found = [];
  if (report) { try { found = readFindings(report); } catch (e) { return fail(`cannot read the findings ${report}: ${e.message}`); } }
  if (!globs.length && !report) return post("success", NO_BLOCK);

  const listed = gh(["api", "--paginate", `repos/${repo}/pulls/${pr}/files`, "--jq", ".[] | .filename, (.previous_filename // empty)"]);
  if (!listed) return fail(`cannot list PR #${pr}'s files (gh api repos/${repo}/pulls/${pr}/files); no status posted`);
  const changed = [...new Set(listed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))];

  const hits = [];
  for (const p of changed) {
    const g = globs.find((x) => lib.tierMatch(x, p));
    if (g) hits.push(`${inert(p)} (${g})`);
  }
  const scoped = found.filter((f) => !f.changedOnly || changed.some((p) => inert(p) === f.path));
  const fresh = unrecorded(scoped, cwd);
  if (scoped.length) console.log(`proteus-security: ${scoped.length} finding(s), ${scoped.length - fresh.length} of them in the baseline`);
  for (const f of fresh) if (!hits.some((h) => h.startsWith(`${f.path} (`))) hits.push(`${f.path} (${f.tool} ${f.rule})`);
  if (!hits.length) return post("success", NONE);

  const status = (() => { try { return JSON.parse(gh(["api", `repos/${repo}/commits/${sha}/status`])); } catch { return null; } })();
  const mine = ((status && status.statuses) || []).find((s) => s.context === CONTEXT);
  if (mine && mine.state === "success" && mine.description !== NONE && mine.description !== NO_BLOCK) {
    lib.fenced([`proteus-security: ${hits.length} security path(s) touched, and ${CONTEXT} is already signed off: ${inert(mine.description)}`]);
    return 0;
  }
  lib.fenced(["proteus-security: security paths touched:", ...hits.map((h) => `proteus-security:   ${h}`)]);
  const more = hits.length > 1 ? ` and ${hits.length - 1} more` : "";
  return post("failure", `needs the security verifier: ${hits[0]}${more}`);
}

process.exitCode = main(process.argv.slice(2));

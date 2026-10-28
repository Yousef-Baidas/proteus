#!/usr/bin/env node
// Change-tier check (SKILL.md rule 3; the tiers block of teams/ROUTING.md, rules in proteus-lib classifyTier).
//   <path>...       the lead, before dispatch: the cheapest tier these planned paths allow, then why. Only file
//                   counts are known yet; line limits are checked after the work.
//   --staged        git pre-commit in a worktree proteus-worktree.js prepared with --tier: everything since the
//                   worktree's base (earlier commits and the staged index) against that tier
//   --ci <base>     CI on a proteus-work/ PR: what changed since <base> against the declared tier: direct on a
//                   proteus-work/direct/<batch> branch (env GITHUB_HEAD_REF), else the PR body's "Tier:" line
//                   (env PR_BODY), else standard
// The checks read the rules as of the base, so a change cannot loosen its own ceiling.
// Exit 1: the change outgrew its tier, and the message names the one it needs; 2: usage or a bad tiers block.
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const lib = require(path.join(__dirname, "proteus-lib.js"));

const ROUTING = lib.ROUTING_FILE;
const git = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] });
const atRef = (ref) => { try { return git(["show", `${ref}:${ROUTING}`]); } catch { return ""; } };
// numstat, NUL-separated so any path comes back as written: "added\tdeleted\tpath"; a binary counts "-", here 0
const changed = (args) => git(["diff", "--numstat", "--no-renames", "-z", ...args]).split("\0").filter(Boolean).map((rec) => {
  const [a, d, ...p] = rec.split("\t");
  return { path: p.join("\t"), lines: (Number(a) || 0) + (Number(d) || 0) };
});

function block(text) {
  const b = lib.parseTiers(text);
  if (b && b.errors.length) {
    console.error(`proteus-tier: ${ROUTING}: ${b.errors.join("; ")}`);
    process.exit(2);
  }
  return b;
}
function judge(declared, rules, changes, fix) {
  const result = lib.classifyTier(rules, changes);
  const why = lib.tierOverrun(declared, result);
  if (why) {
    console.error(`proteus-tier: ${why}${fix ? fix(result.tier) : ""}`);
    process.exit(1);
  }
}
// a word the shell passes as written (an owned glob like teams/** would expand unquoted)
const shq = (s) => (/^[\w./:@%+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);

const HELP = `usage: node proteus-tier.js <planned path>... | --staged | --ci <base-ref>
Classifies a change by the tiers block in ${ROUTING} (no block: standard), cheapest first: ${lib.TIERS.join(", ")}.
  <planned path>...   the lead, before step 1: prints the cheapest tier these paths allow, then why. Only
                      file counts are known yet; line limits are checked after the work.
  --staged [<proteus-worktree.js>]
                      the pre-commit hook in a worktree prepared with --tier: everything since its base;
                      a change that needs full names the lead's re-run of that script at full
  --ci <base-ref>     CI on a proteus-work/ PR: the change since <base-ref> against the declared tier
                      (direct on proteus-work/direct/<batch>, else the PR body's "Tier:" line, else standard)
Paths decide, not extensions. Multi-team or taste-driven work is full whatever the paths say.
Exit 1: the change outgrew its tier (the message names the one it needs); 2: usage or a bad tiers block.`;
const args = process.argv.slice(2);
if (args[0] === "--help" || args[0] === "-h") { console.log(HELP); process.exit(0); }
if (args[0] === "--staged") {
  const root = git(["rev-parse", "--show-toplevel"]).trim();
  let list = "";
  try { list = fs.readFileSync(lib.ownedFile(root), "utf8"); } catch {}
  const m = lib.TIER_LINE.exec(list);
  if (!m) process.exit(0); // not prepared with --tier
  // full work in a worktree prepared lower: the lead re-prepares it at full with the same owned paths (#177)
  const fix = (need) => {
    if (need !== "full") return "";
    const owned = list.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    const script = (args[1] || path.join(__dirname, "proteus-worktree.js")).replace(/\\/g, "/");
    return `\nTo re-prepare this worktree at full: node ${[script, root.replace(/\\/g, "/"), "--tier", "full", ...owned].map(shq).join(" ")}`;
  };
  judge({ tier: m[1], human: Boolean(m[2]) }, block(lib.routingText(root, m[3])), changed(["--cached", m[3]]), fix);
} else if (args[0] === "--ci" && args[1]) {
  const head = process.env.GITHUB_HEAD_REF || "";
  const line = /^Tier:[ \t]*(.+)$/im.exec(process.env.PR_BODY || "");
  const declared = head.startsWith("proteus-work/direct/") ? { tier: "direct", human: false }
    : (line && lib.parseDeclared(line[1])) || { tier: "standard", human: false };
  if (line && !lib.parseDeclared(line[1])) {
    console.error(`proteus-tier: the PR body's "Tier: ${line[1].trim()}" is not one of ${lib.TIERS.join(", ")}`);
    process.exit(2);
  }
  judge(declared, block(atRef(args[1])), changed([`${args[1]}...HEAD`]));
  console.log(`proteus-tier: fits ${declared.tier}${declared.human ? " (human)" : ""}`);
} else if (args.length && !args[0].startsWith("-")) {
  let root = process.cwd();
  try { root = git(["rev-parse", "--show-toplevel"]).trim(); } catch {}
  const r = lib.plannedTier(block(lib.routingText(root)), args);
  console.log(`${r.tier}\n  ${r.why.join("\n  ")}`);
} else {
  console.error(HELP.split("\n")[0] + "\n(--help explains each mode)");
  process.exit(2);
}

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

const ROUTING = "teams/ROUTING.md";
const git = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] });
const atRef = (ref) => { try { return git(["show", `${ref}:${ROUTING}`]); } catch { return ""; } };
// guest mode keeps teams/ outside git (proteus-lib docRoot), so there is no committed copy to read
const guestRouting = (root) => { const d = lib.guestDir(root); try { return d ? fs.readFileSync(path.join(d, ROUTING), "utf8") : ""; } catch { return ""; } };
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
function judge(declared, rules, changes) {
  const why = lib.tierOverrun(declared, lib.classifyTier(rules, changes));
  if (why) {
    console.error(`proteus-tier: ${why}`);
    process.exit(1);
  }
}

const args = process.argv.slice(2);
if (args[0] === "--staged") {
  const root = git(["rev-parse", "--show-toplevel"]).trim();
  let list = "";
  try { list = fs.readFileSync(lib.ownedFile(root), "utf8"); } catch {}
  const m = lib.TIER_LINE.exec(list);
  if (!m) process.exit(0); // not prepared with --tier
  judge({ tier: m[1], human: Boolean(m[2]) }, block(atRef(m[3]) || guestRouting(root)), changed(["--cached", m[3]]));
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
  let text = "";
  try { text = fs.readFileSync(path.join(lib.docRoot(root), ROUTING), "utf8"); } catch {}
  const r = lib.classifyTier(block(text), args.map((p) => ({ path: p.replace(/\\/g, "/").replace(/^\.\//, ""), lines: 0 })));
  console.log(`${r.tier}\n  ${r.why.join("\n  ")}`);
} else {
  console.error("usage: node proteus-tier.js <planned path>... | --staged | --ci <base-ref>");
  process.exit(2);
}

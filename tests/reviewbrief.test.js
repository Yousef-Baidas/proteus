// Review brief (#194): the guide's brief sections and its Quality ledger, read from agents/proteus-guide.md, match
// the fixture review issue in tests/fixtures/review-issue.md: sections in the guide's order, under 60 lines, a
// Quality section of at most eight linked number lines in the ledger's order, and the grader holds on a red one.
// Reads files only. Exit 0 if every assertion passed, 1 otherwise.
"use strict";
const fs = require("fs");
const path = require("path");
const { ok, summary } = require(path.join(__dirname, "lib.js"));

const ROOT = path.join(__dirname, "..");
const guide = fs.readFileSync(path.join(ROOT, "agents", "proteus-guide.md"), "utf8").replace(/\r\n/g, "\n");
const issue = fs.readFileSync(path.join(__dirname, "fixtures", "review-issue.md"), "utf8").replace(/\r\n/g, "\n");

// the numbered list right after the line starting `lead`, as bold names in order
function list(lead) {
  const lines = guide.split("\n");
  const at = lines.findIndex((l) => l.startsWith(lead));
  const names = [];
  for (let i = at + 1; i < lines.length; i++) {
    const m = /^\d+\. \*\*([^*]+)\*\*/.exec(lines[i]);
    if (m) names.push(m[1]);
    else if (names.length && !lines[i].trim()) break;
  }
  return at < 0 ? [] : names;
}

const sections = list("Brief, under 60 lines");
const ledger = list("Quality ledger, in this order");
ok("guide: brief sections in order, Quality after Deferred and before Evidence",
  sections.join("|") === "What changed|Verify it|Look hardest at|Conventions|Deferred|Quality|Evidence|Verdict line", sections);
ok("guide: Quality is at most eight lines", /\*\*Quality\*\* — the ledger below: at most eight lines/.test(guide));
ok("guide: the ledger lists gates, mutation, deep review, security, rework, baseline, debt in order",
  ledger.join("|") === "Gates|Mutation|Deep review|Security|Rework|Baseline|Debt", ledger);
ok("guide: an unreadable source is red, an inapplicable line is n/a", /`unread`, which is red/.test(guide) && /reads `n\/a`/.test(guide));
ok("guide: the grader holds on any red Quality line", /no red Quality line → comment `AUTO-ACCEPT`/.test(guide) && /else `AUTO-HOLD`/.test(guide));

const lines = issue.replace(/\n$/, "").split("\n");
const heads = lines.filter((l) => l.startsWith("## ")).map((l) => l.slice(3));
ok("fixture: under 60 lines", lines.length < 60, lines.length);
ok("fixture: sections in the guide's order", heads.join("|") === sections.slice(0, -1).join("|"), heads);
ok("fixture: ends in the verdict line", lines[lines.length - 1] === "Second terminal: PROTEUS=0 claude → /proteus-review. Or comment ACCEPT / CHANGES here.");

const q = issue.split("## Quality\n")[1].split("\n## ")[0].trim().split("\n");
ok("fixture: Quality has at most eight lines", q.length <= 8, q.length);
const LINE = /^- ([A-Z][a-z ]+): ([^—]*\d[^—]*) — (https:\/\/\S+)( \(red\))?$/;
ok("fixture: every Quality line is `- <name>: <numbers> — <link>`", q.every((l) => LINE.test(l)), q.filter((l) => !LINE.test(l)));
ok("fixture: Quality lines follow the ledger's order", q.map((l) => (LINE.exec(l) || [])[1]).join("|") === ledger.join("|"));
ok("fixture: shows a red line, the mutation survivors", q.filter((l) => l.endsWith("(red)")).map((l) => LINE.exec(l)[1]).join() === "Mutation");

summary();

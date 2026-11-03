// The rulings rule (#368): node tests/rulings.test.js. Proteus stays human-driven: the lead's rulings settle only
// implementation details inside the human's decisions, and a choice planning did not cover goes back to the human
// as a planning question. Checks the skill's text states that boundary, and that the rulings log and the milestone
// review carry them. Reads the repo only.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, summary } = lib;

const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8").replace(/\r\n/g, "\n").replace(/\s+/g, " ");
const skill = read("skills", "proteus", "SKILL.md");
const flow = read("skills", "proteus", "references", "flow.md");
const tracker = read("skills", "proteus", "references", "tracker.md");
const review = read("skills", "proteus", "references", "review.md");
const guide = read("agents", "proteus-guide.md");

ok("skill: a ruling only settles an implementation detail inside a decision the human already made",
  /A ruling only settles an implementation detail inside a decision the human already made/.test(skill));
ok("skill: a design, scope or trade-off choice planning missed is a planning question, parking only the work it affects",
  /misses a design, scope or trade-off choice \(a planning question, parking only the work it affects; `flow.md`\)/.test(skill));
ok("skill: the build asks only the four cases", /After planning, ask only before an irreversible, security-sensitive or outside-the-repo action, or when the plan breaks/.test(skill));
ok("skill: planning asks about scope, design, dependencies, repo additions and how the human runs it",
  /\(e\) constraints on tools, data, budget, dependencies, files added to the repo, and how the human runs it/.test(skill));
ok("flow: the ruling bullet keeps the same boundary", /\*\*Ruling\*\* \(an implementation detail inside a decision the human made; a new design, scope or trade-off choice is a planning question instead\)/.test(flow));
ok("tracker: one rulings thread per run, each `what — why — cost if wrong`", /RULING <what> — <why> — <cost if wrong>/.test(tracker));
ok("review: the milestone brief has how to try it and the rulings since the last review", /RULING` comments since the last review/.test(review) && /How to try it/.test(guide) && /\*\*Rulings\*\*/.test(guide));
ok("review: no PR into the run branch waits for the human", /No PR into `proteus\/<run>` waits for the human/.test(review) && !/ASK human PR#/.test(review + flow));
ok("skill: a new dependency is never a ruling", /A ruling only settles an implementation detail inside a decision the human already made, never a new dependency/.test(skill));
ok("skill: rule 7 keeps every new dependency the human's", /\*\*The human holds the gates\.\*\*[^\n]*its skills lists after bootstrap, and every new dependency\./.test(read("skills", "proteus", "SKILL.md").replace(/ (?=\d+\. \*\*)/g, "\n")));
summary();

// --doctor times `lefthook run pre-commit` (#207) and warns above the budget. PROTEUS_LEFTHOOK names a fake lefthook
// (a .js file, so the test is OS-neutral) and PROTEUS_PRECOMMIT_BUDGET_MS shrinks the limit so nothing sleeps for seconds.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("precommit");
const INSTALL = path.join(ROOT, "install.js");

const R = path.join(W, "repo");
g(W, "init", "-q", "-b", "main", R);
lib.run(INSTALL, "", { cwd: R, args: ["--project"] });
const row = (env) => (lib.run(INSTALL, "", { cwd: R, args: ["--doctor"], env }).out.match(/^\w+\s+(?:pre-commit (?:took|time)).*$/m) || [""])[0];
const fake = (name, ms) => {
  const f = path.join(W, `${name}.js`);
  fs.writeFileSync(f, `if (process.argv.slice(2).join(" ") !== "run pre-commit") process.exit(2);\nsetTimeout(() => {}, ${ms});\n`);
  return f;
};

ok("no lefthook config: the row says skipped", /^ok\s+pre-commit time: skipped \(no lefthook config\)/.test(row({ PROTEUS_LEFTHOOK: fake("fast", 0) })), row({}));
fs.writeFileSync(path.join(R, "lefthook.yml"), "pre-commit:\n  commands: {}\n");
ok("lefthook absent: the row says skipped", /^ok\s+pre-commit time: skipped \(lefthook not found\)/.test(row({ PROTEUS_LEFTHOOK: path.join(W, "nope", "lefthook") })), row({ PROTEUS_LEFTHOOK: path.join(W, "nope", "lefthook") }));
const budget = { PROTEUS_PRECOMMIT_BUDGET_MS: "3000" };
const fast = row({ ...budget, PROTEUS_LEFTHOOK: fake("fast", 0) });
ok("fast pre-commit: reports the time, no warning", /^ok\s+pre-commit took \d+\.\ds$/.test(fast), fast);
const slow = row({ PROTEUS_PRECOMMIT_BUDGET_MS: "300", PROTEUS_LEFTHOOK: fake("slow", 1500) });
ok("slow pre-commit: WARN names pre-push and CI", /^WARN\s+pre-commit took \d+\.\ds — move slow checks to pre-push or CI$/.test(slow), slow);

lib.summary();

// length budget tests: node tests/budget.test.js. Proteus's own skill text is read by every session, so it gets
// a byte budget (#205): SKILL.md 12 KB, each references/*.md 32 KB, each agents/*.md 10 KB, and 280 KB in total.
// Sizes count LF line endings, so a CRLF checkout on Windows measures the same. A file over its budget is named
// with its size and budget, and the total is printed either way.
"use strict";
const fs = require("fs");
const path = require("path");
const lib = require(path.join(__dirname, "lib.js"));
const { ok } = lib;

const ROOT = path.resolve(__dirname, "..");
const SKILL = path.join(ROOT, "skills", "proteus");
const TOTAL = 280 * 1024;

const md = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort().map((f) => path.join(dir, f));
const files = [
  [path.join(SKILL, "SKILL.md"), 12 * 1024],
  ...md(path.join(SKILL, "references")).map((f) => [f, 32 * 1024]),
  ...md(path.join(ROOT, "agents")).map((f) => [f, 10 * 1024]),
];
const size = (f) => Buffer.byteLength(fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n"), "utf8");

ok("budget: finds the skill, references and agents", files.length > 3 && files.every(([f]) => fs.existsSync(f)));
let total = 0;
for (const [f, budget] of files) {
  const n = size(f);
  total += n;
  const rel = path.relative(ROOT, f).split(path.sep).join("/");
  ok(`budget: ${rel} fits ${budget} bytes`, n <= budget, `${rel}: ${n} bytes, budget ${budget}`);
}
console.log(`budget: total ${total} bytes, budget ${TOTAL}`);
ok(`budget: the total fits ${TOTAL} bytes`, total <= TOTAL, `total ${total} bytes, budget ${TOTAL}`);

// CRLF counts the same as LF
const tmp = path.join(lib.workdir("budget"), "crlf.md");
fs.writeFileSync(tmp, "a\r\nb\r\n");
ok("budget: CRLF is measured as LF", size(tmp) === 4, String(size(tmp)));

lib.summary();

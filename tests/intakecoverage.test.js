// proteus-intake-coverage.js tests: node tests/intakecoverage.test.js. The intake draft's coverage table maps every
// finding in the notes (rendered by proteus-intake.js) to exactly one outcome; a shipped finding is drafted nowhere.
"use strict";
const fs = require("fs");
const path = require("path");

const lib = require(path.join(__dirname, "lib.js"));
const { ok } = lib;
const W = lib.workdir("intakecoverage");
const HOOKS = path.join(__dirname, "..", "templates", "hooks");
const SCRIPT = path.join(HOOKS, "proteus-intake-coverage.js");
const { render, findingId } = require(path.join(HOOKS, "proteus-intake.js"));
let k = 0;
const file = (text) => { const f = path.join(W, `f${++k}.md`); fs.writeFileSync(f, text); return f; };
const cover = (notes, draft) => lib.run(SCRIPT, "", { cwd: W, args: [file(notes), file(draft)] });

// the notes file: two notes as the intake issue's comments, concatenated in comment order
const A = "https://youtu.be/aaaaaaaaaaa", B = "https://youtu.be/bbbbbbbbbbb";
const sum = ["One.", "Two.", "Three."];
const NOTES = render({ url: A, title: "Sandboxes", channel: "Chan A", length: "10:00", summary: sum, findings: [
  { at: "02:40", themes: [1], text: "Run each agent in a microVM." },
  { at: "02:40", themes: [2], text: "A worker's hooks are copied into its worktree." },
] }) + render({ url: B, title: "Memory", channel: "Chan B", length: "1:29", summary: sum, findings: [
  { at: "00:05", themes: [1], text: "Turn auto memory off." },
] }) + render({ url: "https://youtu.be/ccccccccccc", failed: "Video unavailable" });
const [a1, a2, b1] = [findingId(A, 1), findingId(A, 2), findingId(B, 1)];
const draft = (rows, d1 = [a1, b1]) => `## Draft 1: Sandbox each worker
**Problem.** Agents run on the host.
**Change.** Run each worker in a microVM.
**Acceptance.** A worker cannot read the host's home.
**Refs.** \`enforcement.md\`
**Supporting notes.** ${d1.join(", ")}
**Estimate.** M. **Depends on:** none.

## Coverage
| Finding | Outcome |
|---|---|
${rows.map(([id, o]) => `| ${id} | ${o} |`).join("\n")}
`;
const EXACT = [[a1, "issue 1"], [a2, "shipped templates/hooks/proteus-worktree.js"], [b1, "issue 1"]];

let r = lib.run(SCRIPT, "", { args: ["--help"] });
ok("--help: usage, the notes command and the four outcomes, exit 0", r.code === 0 && /usage: node proteus-intake-coverage\.js/.test(r.out) && /issues\/<n>\/comments/.test(r.out) && /rejected <reason>/.test(r.out), r.err);
ok("no arguments: usage, exit 2", lib.run(SCRIPT, "", { args: [] }).code === 2);
ok("a missing file: exit 2", lib.run(SCRIPT, "", { args: [path.join(W, "none.md"), path.join(W, "none2.md")] }).code === 2);
ok("fixture: the two findings at the same timestamp get distinct ids", a1 !== a2 && /^[0-9a-f]{6}-F1$/.test(a1) && a2 === a1.replace(/F1$/, "F2"), `${a1} ${a2}`);

r = cover(NOTES, draft(EXACT));
ok("exact coverage: exit 0, the findings counted", r.code === 0 && /3 findings, each mapped once/.test(r.out), r.out + r.err);

r = cover(NOTES, draft([[a1, "issue 1"], [b1, "issue 1"]]));
ok("an unmapped finding: exit 1, that finding named", r.code === 1 && r.err.includes(`${a2}: unmapped`) && !r.err.includes(`${a1}:`), r.err);

r = cover(NOTES, draft([...EXACT, [a2, "candidate"]]));
ok("a finding mapped twice: exit 1, named with both outcomes", r.code === 1 && r.err.includes(`${a2}: mapped 2 times`) && /candidate/.test(r.err), r.err);

r = cover(NOTES, draft(EXACT, [a1, a2, b1]));
ok("already shipped: a shipped finding cited by a drafted issue fails", r.code === 1 && r.err.includes(`${a2}: cited by draft 1 but its row is "shipped templates/hooks/proteus-worktree.js"`), r.err);
const shippedOk = cover(NOTES, draft(EXACT));
ok("already shipped: mapped to shipped <file> and in no drafted issue passes", shippedOk.code === 0 && !draft(EXACT).split("## Coverage")[0].includes(a2), shippedOk.err);

r = cover(NOTES, draft([[a1, "issue 1"], [a2, "deferred"], [b1, "issue 2"], ["ffffff-F9", "candidate"], [a2.replace(/F2$/, "F3"), "rejected not a finding"]]));
ok("bad rows: an unknown outcome, a missing draft and unknown ids are each named, exit 1",
  r.code === 1 && r.err.includes(`${a2}: outcome "deferred"`) && r.err.includes(`${b1}: issue 2 is not a drafted issue`) &&
  r.err.includes("ffffff-F9: in the coverage table but not a finding") && r.err.includes(`${b1}: cited by draft 1`), r.err);

r = cover(NOTES, draft([[a1, "rejected the owner's sandbox is out of scope"], [a2, "candidate"], [b1, "issue 1"]], [b1]));
ok("candidate and rejected <reason> are outcomes", r.code === 0, r.err);

const pre = NOTES.replace(`- ${b1} 00:05`, "- 00:05");
r = cover(pre, draft(EXACT));
ok("a note posted before finding ids: exit 2, delete it and --post again, naming the source", r.code === 2 && /note predates finding ids; delete that note comment and run --post again: /.test(r.err) && r.err.includes(B), r.err);

lib.summary();

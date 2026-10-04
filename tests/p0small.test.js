// P0 small fixes: commit-msg trailer matching, lead guard image names, lesson hit log, lesson regex safety,
// lead write list. Temp repo only; no network.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "templates", "hooks");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, run } = lib;
const W = lib.workdir("p0small");

// commit-msg: AI attribution trailers only
const CM = path.join(SRC, "commit-msg.js");
let n = 0;
const msg = (m) => { const f = path.join(W, `msg${n++}`); fs.writeFileSync(f, m); return run(CM, "", { args: [f] }).code; };
const head = "fix(x): do a thing\n\nwhy\n";
ok("commit-msg: Co-Authored-By naming Claude rejected", msg(head + "\nCo-Authored-By: Claude <noreply@anthropic.com>\n") === 1);
ok("commit-msg: Generated with trailer rejected", msg(head + "\nGenerated with [Claude Code](https://claude.com/claude-code)\n") === 1);
ok("commit-msg: robot emoji trailer rejected", msg(head + "\n🤖 Generated with [Claude Code](https://x)\n\nCo-Authored-By: Claude <a@b.c>\n") === 1);
ok("commit-msg: AI Signed-off-by name rejected", msg(head + "\nSigned-off-by: Claude <c@x.com>\n") === 1);
ok("commit-msg: human Signed-off-by on an .ai domain passes", msg(head + "\nSigned-off-by: Ada Lovelace <ada@acme.ai>\n") === 0);
ok("commit-msg: human Co-Authored-By passes", msg(head + "\nCo-Authored-By: Ada Lovelace <ada@acme.ai>\n") === 0);
ok("commit-msg: body prose starting Generated with passes", msg("fix(x): do a thing\n\nGenerated with the old tool, now replaced.\n\nSecond paragraph.\n") === 0);
ok("commit-msg: body mentions of AI outside the trailer pass", msg("fix(x): do a thing\n\nCo-Authored-By lines are not parsed here.\nthe ai module is renamed.\n\nSigned-off-by: Ada <a@b.ai>\n") === 0);

lib.summary();

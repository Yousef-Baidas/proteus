// proteus-skillpath.js: finds a plugin's SKILL.md without a hardcoded cache path. node tests/skillpath.test.js
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const lib = require(path.join(__dirname, "lib.js"));
const { ok } = lib;
const W = lib.workdir("skillpath");
const SP = path.join(ROOT, "templates", "hooks", "proteus-skillpath.js");

const skill = (...p) => { const d = path.join(W, ...p); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, "SKILL.md"), "---\nname: x\n---\n"); return path.join(d, "SKILL.md"); };
const cache = path.join(W, "home", ".claude", "plugins", "cache");
const a = skill("home", ".claude", "plugins", "cache", "mkt", "mattpocock-skills", "1.0", "skills", "engineering", "improve-codebase-architecture");
const extra = skill("extra", "other-skill");
fs.mkdirSync(path.join(cache, "mkt", "node_modules", "improve-codebase-architecture"), { recursive: true });
fs.writeFileSync(path.join(cache, "mkt", "node_modules", "improve-codebase-architecture", "SKILL.md"), "x");
const env = { HOME: path.join(W, "home"), USERPROFILE: path.join(W, "home"), PROTEUS_HARNESS: "claude", PROTEUS_SKILL_DIRS: path.join(W, "extra") };

let r = lib.run(SP, "", { args: ["improve-codebase-architecture"], env });
ok("skillpath: finds a plugin skill in the cache, skips node_modules", r.code === 0 && r.out.trim() === a, r.out + r.err);
r = lib.run(SP, "", { args: ["other-skill"], env });
ok("skillpath: PROTEUS_SKILL_DIRS adds roots", r.code === 0 && r.out.trim() === extra, r.out + r.err);
r = lib.run(SP, "", { args: ["nope"], env });
ok("skillpath: unknown skill exits 1 with a hint", r.code === 1 && /PROTEUS_SKILL_DIRS/.test(r.err), r.err);
r = lib.run(SP, "", { args: ["../x"], env });
ok("skillpath: a path-like name is refused", r.code === 2, r.err);
r = lib.run(SP, "", { args: ["improve-codebase-architecture"], env: { ...env, PROTEUS_HARNESS: "codex", HOME: path.join(W, "nohome"), USERPROFILE: path.join(W, "nohome"), CODEX_HOME: path.join(W, "nohome", ".codex"), PROTEUS_SKILL_DIRS: path.join(cache, "..", "cache") } });
ok("skillpath: codex adapter + env dir still resolves", r.code === 0 && r.out.trim() === a, r.out + r.err);
lib.summary();

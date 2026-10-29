// <hooks> is defined once (#217): node tests/hooksdir.test.js. Under a plugin install the hooks are not in
// .claude/hooks, so no skill file but harnesses.md may spell that path out; the rest point to it.
"use strict";
const fs = require("fs");
const path = require("path");
const lib = require(path.join(__dirname, "lib.js"));
const { ok } = lib;

const DIR = path.join(__dirname, "..", "skills");
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const hits = walk(DIR).filter((f) => f.endsWith(".md") && fs.readFileSync(f, "utf8").includes(".claude/hooks")).map((f) => path.relative(DIR, f).split(path.sep).join("/"));
ok(".claude/hooks is named only in proteus/references/harnesses.md", hits.join(",") === "proteus/references/harnesses.md", hits.join(","));
const def = fs.readFileSync(path.join(DIR, "proteus", "references", "harnesses.md"), "utf8").split("\n").find((l) => l.startsWith("| `<hooks>`")) || "";
ok("harnesses.md defines <hooks> as the dir holding proteus-lib.js", def.includes("proteus-lib.js") && def.includes("plugin"), def);
lib.summary();

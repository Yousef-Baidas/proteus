// changelog fragment tests: node tests/changelog.test.js. scripts/changelog.js prints the merged notes of
// changelog.d/*.md in Keep a Changelog order and, with --release X.Y.Z, folds them and any Unreleased bullets
// into a new CHANGELOG.md section and deletes the fragments; README.md is skipped, a malformed fragment or a
// bad version is refused before anything is written.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const SCRIPT = path.resolve(__dirname, "..", "scripts", "changelog.js");
const lib = require(path.join(__dirname, "lib.js"));
const { ok } = lib;
const W = lib.workdir("changelog");

const HEAD = "# Changelog\n\nintro\n\n## [Unreleased]\n";
const OLD = "\n## [1.0.0] - 2026-01-01\n\n### Added\n\n- first\n";
let n = 0;
// a fresh root with CHANGELOG.md = HEAD + unreleased + OLD and the given fragments
function root(unreleased, frags) {
  const r = path.join(W, `r${n++}`);
  fs.mkdirSync(path.join(r, "changelog.d"), { recursive: true });
  fs.writeFileSync(path.join(r, "CHANGELOG.md"), HEAD + unreleased + OLD);
  for (const [f, t] of Object.entries(frags)) fs.writeFileSync(path.join(r, "changelog.d", f), t);
  return r;
}
const run = (r, ...args) => spawnSync(process.execPath, [SCRIPT, "--root", r, ...args], { encoding: "utf8" });
const read = (r, f) => fs.readFileSync(path.join(r, f), "utf8");
const frags = (r) => fs.readdirSync(path.join(r, "changelog.d")).sort();

const A = "### Added\n\n- a1\n  continued\n";
const B = "### Fixed\n\n- b-fix\n\n### Added\n\n- b-add\n";

// print: Keep a Changelog order, fragments by filename, README.md skipped
let r = root("", { "b.md": B, "a.md": A, "README.md": "### Bogus\n\nnot a fragment\n" });
let p = run(r);
ok("print: exits 0", p.status === 0, p.stderr);
ok("print: sections in order, bullets by filename, continuation kept, README skipped",
  p.stdout === "### Added\n\n- a1\n  continued\n- b-add\n\n### Fixed\n\n- b-fix\n", JSON.stringify(p.stdout));
ok("print: changes nothing", frags(r).length === 3 && read(r, "CHANGELOG.md") === HEAD + OLD);

// release: existing Unreleased bullets plus fragments land in a new section right after Unreleased
r = root("\n### Changed\n\n- kept\n", { "a.md": A, "b.md": B, "README.md": "# about\n" });
p = run(r, "--release", "1.1.0", "--date", "2026-02-03");
ok("release: exits 0", p.status === 0, p.stderr);
ok("release: new section after an empty Unreleased, before 1.0.0, with every bullet",
  read(r, "CHANGELOG.md") === HEAD + "\n## [1.1.0] - 2026-02-03\n\n### Added\n\n- a1\n  continued\n- b-add\n\n### Changed\n\n- kept\n\n### Fixed\n\n- b-fix\n" + OLD,
  read(r, "CHANGELOG.md"));
ok("release: folded fragments deleted, README.md stays", frags(r).join() === "README.md", frags(r));
ok("release: a second run has nothing to fold and refuses", run(r, "--release", "1.2.0").status === 1);

// a major release's "### Upgrading to X.Y.Z" steps come first
r = root("", { "a.md": A, "u.md": "### Fixed\n\n- u-fix\n\n### Upgrading to 2.0.0\n\n- step\n" });
p = run(r);
ok("upgrading: accepted and printed before the other sections", p.status === 0 && p.stdout === "### Upgrading to 2.0.0\n\n- step\n\n### Added\n\n- a1\n  continued\n\n### Fixed\n\n- u-fix\n", JSON.stringify(p.stdout) + p.stderr);

// refusals leave everything as it was
r = root("", { "a.md": A, "bad.md": "just prose\n" });
p = run(r, "--release", "1.1.0");
ok("malformed fragment: refused with its name and line", p.status === 1 && /changelog\.d\/bad\.md:1: expected/.test(p.stderr), p.stderr);
ok("malformed fragment: nothing written or deleted", read(r, "CHANGELOG.md") === HEAD + OLD && frags(r).length === 2);
ok("malformed fragment: print refuses too", run(r).status === 1);
for (const [why, text, re] of [["unknown section", "### Misc\n\n- x\n", /unknown section "Misc"/], ["bullet before a section", "- x\n", /bullet before any/], ["empty section", "### Added\n", /no bullets/], ["no sections", "\n", /no "### <section>"/]]) {
  r = root("", { "x.md": text });
  p = run(r);
  ok(`malformed fragment: ${why}`, p.status === 1 && re.test(p.stderr), p.stderr);
}

for (const v of ["1.2", "v1.2.3", "1.2.3-rc1", "x"]) {
  r = root("", { "a.md": A });
  p = run(r, "--release", v);
  ok(`bad version ${v}: refused, nothing changed`, p.status === 1 && /not X\.Y\.Z/.test(p.stderr) && read(r, "CHANGELOG.md") === HEAD + OLD && frags(r).length === 1, p.stderr);
}
r = root("", { "a.md": A });
ok("bad date: refused", run(r, "--release", "1.1.0", "--date", "2026-13-40").status === 1);
ok("existing version: refused", run(r, "--release", "1.0.0").status === 1 && frags(r).length === 1);
p = run(r, "--release", "1.1.0");
ok("default date is today", p.status === 0 && /^## \[1\.1\.0\] - \d{4}-\d{2}-\d{2}$/m.test(read(r, "CHANGELOG.md")), p.stderr);

lib.summary();

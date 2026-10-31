// Audience profile tests (#308): node tests/profile.test.js. proteus-profile.js keeps one profile per project in
// <git-common-dir>/proteus/profile.json: show, set, know, forget, terms and path from any cwd in the repo; it
// validates values and terms, caps and dedups the terms, re-validates every field on read (a garbage, oversized or
// linked file reads as unset, invalid terms are dropped), writes never through a link, and needs a repo.
// Exit 0 if every assertion passed, 1 otherwise.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(ROOT, "templates", "hooks", "proteus-profile.js");
const P = require(SCRIPT);
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("profile");

let n = 0;
// a fresh git repo with a subdir
const repo = () => {
  const d = path.join(W, `repo${++n}`);
  fs.mkdirSync(path.join(d, "sub", "deeper"), { recursive: true });
  g(d, "init", "-q");
  return d;
};
const cli = (cwd, ...args) => lib.run(SCRIPT, "", { cwd, args });
const FILE = (d) => path.join(d, ".git", "proteus", "profile.json");
const stored = (d) => JSON.parse(fs.readFileSync(FILE(d), "utf8"));

// show and set
let R = repo();
let r = cli(R, "show");
ok("show: no file prints exactly 'audience unset'", r.code === 0 && r.out === "audience unset\n", r.out + r.err);
r = cli(R, "set", "familiarity=new");
ok("set: familiarity alone fills learning with the skipped default", r.code === 0 && stored(R).familiarity === "new" && stored(R).learning === "asked" && /^\d{4}-\d{2}-\d{2}$/.test(stored(R).updated), r.out + r.err);
r = cli(R, "set", "learning=along");
ok("set: learning alone keeps familiarity", r.code === 0 && stored(R).familiarity === "new" && stored(R).learning === "along", r.out + r.err);
r = cli(R, "set", "familiarity=fluent", "learning=off");
ok("set: both keys at once", r.code === 0 && stored(R).familiarity === "fluent" && stored(R).learning === "off", r.out + r.err);
r = cli(path.join(R, "sub", "deeper"), "show");
ok("show: one line from a subdir, with the count of known terms", r.code === 0 && r.out === "audience familiarity=fluent learning=off known=0\n", r.out + r.err);
let before = fs.readFileSync(FILE(R), "utf8");
r = cli(R, "set", "familiarity=expert");
ok("set: an invalid familiarity exits 1, names the allowed values and writes nothing", r.code === 1 && /familiarity must be one of new, some, fluent/.test(r.err) && fs.readFileSync(FILE(R), "utf8") === before, r.err);
r = cli(R, "set", "learning=sometimes");
ok("set: an invalid learning exits 1 and names the allowed values", r.code === 1 && /learning must be one of along, asked, off/.test(r.err), r.err);
r = cli(R, "set", "colour=blue");
ok("set: an unknown key exits 1 and names the settings", r.code === 1 && /unknown setting "colour"; the settings are familiarity, learning/.test(r.err), r.err);
r = cli(R, "set");
ok("set: no key is bad usage", r.code === 2 && /familiarity=<new\|some\|fluent>/.test(r.err), r.err);

// know, forget, terms
R = repo();
r = cli(R, "know", "placeholder-a");
ok("know: refused before any profile exists, so it never stands in for the gauging", r.code === 1 && /no profile yet; run set first/.test(r.err) && !fs.existsSync(FILE(R)), r.err);
cli(R, "set", "familiarity=some", "learning=along");
r = cli(path.join(R, "sub"), "know", "Placeholder-A", "placeholder-b");
ok("know: adds terms from a subdir and prints the show line", r.code === 0 && r.out === "audience familiarity=some learning=along known=2\n", r.out + r.err);
r = cli(R, "know", "PLACEHOLDER-A");
ok("know: a term known in another case is not added twice", r.code === 0 && stored(R).known.length === 2 && stored(R).known.filter((t) => t.toLowerCase() === "placeholder-a").length === 1, JSON.stringify(stored(R)));
r = cli(R, "terms");
ok("terms: one per line, the re-known term newest", r.code === 0 && r.out === "placeholder-b\nPLACEHOLDER-A\n", r.out);
r = cli(R, "forget", "placeholder-a", "not-there");
ok("forget: removes case-insensitively and ignores an unknown term", r.code === 0 && cli(R, "terms").out === "placeholder-b\n", r.out + r.err);
before = fs.readFileSync(FILE(R), "utf8");
r = cli(R, "know", "x".repeat(61));
ok("know: a term over 60 characters exits 1 and writes nothing", r.code === 1 && /at most 60 characters/.test(r.err) && fs.readFileSync(FILE(R), "utf8") === before, r.err);
r = cli(R, "know", "fine", "bad\u0007term");
ok("know: a term with a control character exits 1 and writes none of the terms", r.code === 1 && /control characters/.test(r.err) && fs.readFileSync(FILE(R), "utf8") === before, r.err);
r = cli(R, "know", "   ");
ok("know: an empty term exits 1", r.code === 1 && /must not be empty/.test(r.err), r.err);
ok("know: a term of exactly 60 characters is kept", cli(R, "know", "y".repeat(60)).code === 0 && stored(R).known.includes("y".repeat(60)));
r = cli(R, "know");
ok("know: no term is bad usage", r.code === 2, r.err);

// the cap: the oldest go first
R = repo();
cli(R, "set", "familiarity=some");
const many = Array.from({ length: 305 }, (_, i) => `term-${i}`);
r = cli(R, "know", ...many);
const kept = stored(R).known;
ok("know: at most 300 terms, the oldest dropped first", r.code === 0 && kept.length === 300 && kept[0] === "term-5" && kept[299] === "term-304" && /known=300/.test(r.out), `${kept.length} ${kept[0]} ${kept[299]}`);

// a garbage, oversized or partly invalid file
R = repo();
fs.mkdirSync(path.join(R, ".git", "proteus"), { recursive: true });
fs.writeFileSync(FILE(R), "{ not json");
r = cli(R, "show");
ok("show: a garbage file reads as unset, in one line, no stack trace", r.code === 0 && r.out === "audience unset\n" && !r.err, r.out + r.err);
ok("autostart's short form: unset for a garbage file", P.short(path.join(R, ".git")) === "unset");
r = cli(R, "know", "placeholder");
ok("know: refused over a garbage file", r.code === 1 && /no profile yet; run set first/.test(r.err) && !/\n\s+at /.test(r.err), r.err);
fs.writeFileSync(FILE(R), JSON.stringify({ familiarity: "new", learning: "off", known: ["ok-term"], pad: "x".repeat(70000) }));
ok("show: a file over 64 KiB reads as unset", cli(R, "show").out === "audience unset\n");
fs.writeFileSync(FILE(R), JSON.stringify({ familiarity: "expert", learning: "along", known: [] }));
ok("show: an invalid familiarity reads as unset", cli(R, "show").out === "audience unset\n");
fs.writeFileSync(FILE(R), JSON.stringify({ familiarity: "new", learning: 3, known: [] }));
ok("show: an invalid learning reads as unset", cli(R, "show").out === "audience unset\n");
fs.writeFileSync(FILE(R), JSON.stringify(["new", "off"]));
ok("show: a JSON list reads as unset", cli(R, "show").out === "audience unset\n");
fs.writeFileSync(FILE(R), JSON.stringify({ familiarity: "new", learning: "off", known: ["good", 7, "", "bad\u0007", "z".repeat(61), null, "Good", "fine"], updated: "<script>" }));
r = cli(R, "terms");
ok("terms: invalid entries are dropped and the rest deduplicated", r.code === 0 && r.out === "Good\nfine\n", r.out + r.err);
ok("show: the sanitised profile counts only the valid terms", cli(R, "show").out === "audience familiarity=new learning=off known=2\n");
ok("read: an invalid updated is dropped", P.read(path.join(R, ".git")).profile.updated === "");
fs.writeFileSync(FILE(R), JSON.stringify({ familiarity: "new", learning: "off", known: "x" }));
ok("show: known that is not a list keeps the profile with no terms", cli(R, "show").out === "audience familiarity=new learning=off known=0\n");
fs.writeFileSync(FILE(R), "[]");
r = cli(R, "set", "learning=off");
ok("set: starts a fresh profile over an unset file", r.code === 0 && JSON.stringify(stored(R).known) === "[]" && stored(R).familiarity === "some" && stored(R).learning === "off", r.out + r.err);
ok("set: leaves no temp file behind", fs.readdirSync(path.join(R, ".git", "proteus")).join(",") === "profile.json", fs.readdirSync(path.join(R, ".git", "proteus")).join(","));

// path and help
R = repo();
r = cli(path.join(R, "sub"), "path");
ok("path: the file under <git-common-dir>/proteus", r.code === 0 && r.out === FILE(R) + "\n", r.out + r.err);
r = cli(R, "--help");
ok("--help: usage on stdout, exit 0", r.code === 0 && r.out.startsWith("usage: node proteus-profile.js show"), r.out + r.err);
r = cli(R, "bogus");
ok("an unknown command is bad usage", r.code === 2 && /usage:/.test(r.err), r.err);

// a linked worktree shares the main checkout's profile
R = repo();
g(R, "commit", "-q", "--allow-empty", "-m", "init");
const WT = path.join(W, `wt${n}`);
g(R, "worktree", "add", "-q", "-b", "x", WT);
cli(R, "set", "familiarity=fluent", "learning=along");
ok("show: from a linked worktree reads the main checkout's profile", cli(WT, "show").out === "audience familiarity=fluent learning=along known=0\n", cli(WT, "show").out + cli(WT, "show").err);

// outside any repo
const OUT = path.join(W, "outside");
fs.mkdirSync(OUT);
r = cli(OUT, "show");
ok("show: outside a repo says unset and why, exit 0", r.code === 0 && r.out === "audience unset (not inside a git repository)\n", r.out + r.err);
for (const c of [["set", "familiarity=new"], ["know", "placeholder"], ["forget", "placeholder"], ["terms"], ["path"]]) {
  r = cli(OUT, ...c);
  ok(`${c[0]}: outside a repo exits 1 with one line and writes nothing`, r.code === 1 && r.err === "proteus-profile: not inside a git repository\n" && !r.out && fs.readdirSync(OUT).length === 0, r.out + r.err);
}

// links: never read through, never written through
if (process.platform !== "win32") {
  R = repo();
  const elsewhere = path.join(W, `elsewhere${n}`);
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, path.join(R, ".git", "proteus"));
  r = cli(R, "set", "familiarity=new");
  ok("set: a linked proteus dir is refused in one line, nothing written through it", r.code === 1 && /^proteus-profile: cannot write .*is not a directory/.test(r.err) && fs.readdirSync(elsewhere).length === 0 && !/\n\s+at /.test(r.err), r.err);
  R = repo();
  fs.mkdirSync(path.join(R, ".git", "proteus"));
  const target = path.join(W, `target${n}.json`);
  fs.writeFileSync(target, JSON.stringify({ familiarity: "fluent", learning: "off", known: [] }));
  fs.symlinkSync(target, FILE(R));
  ok("show: a linked profile.json is not followed: unset", cli(R, "show").out === "audience unset\n");
  r = cli(R, "set", "familiarity=new");
  ok("set: replaces a linked profile.json with a file, the link's target untouched", r.code === 0 && !fs.lstatSync(FILE(R)).isSymbolicLink() && stored(R).familiarity === "new" && JSON.parse(fs.readFileSync(target, "utf8")).familiarity === "fluent", r.out + r.err);
}

lib.summary();

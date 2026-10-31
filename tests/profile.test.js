// Audience profile tests (#308): node tests/profile.test.js. proteus-profile.js keeps one profile per project in
// <git-common-dir>/proteus-lead/profile.json: show, set, know, forget, terms and path from any cwd in the repo; it
// validates values and terms, caps and dedups the terms, reads a malformed file as unset, and needs a repo.
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
const FILE = (d) => path.join(d, ".git", "proteus-lead", "profile.json");
const stored = (d) => JSON.parse(fs.readFileSync(FILE(d), "utf8"));
const oneLine = (r) => r.out.split("\n").filter(Boolean).length === 1;

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

// a malformed file
R = repo();
fs.mkdirSync(path.join(R, ".git", "proteus-lead"), { recursive: true });
fs.writeFileSync(FILE(R), "{ not json");
r = cli(R, "show");
ok("show: a malformed file reports unset with the reason, in one line, no stack trace", r.code === 0 && r.out === "audience unset (unreadable: not valid JSON)\n" && !r.err, r.out + r.err);
ok("autostart's short form: unset for a malformed file", P.short(path.join(R, ".git")) === "unset");
r = cli(R, "know", "placeholder");
ok("know: refused over a malformed file, naming why", r.code === 1 && /unreadable \(not valid JSON\); run set first/.test(r.err) && !/\n\s+at /.test(r.err), r.err);
fs.writeFileSync(FILE(R), JSON.stringify({ familiarity: "expert", learning: "along", known: [] }));
r = cli(R, "show");
ok("show: an invalid value reads as unset and names the field", r.out === "audience unset (unreadable: familiarity must be one of new, some, fluent)\n" && oneLine(r), r.out);
fs.writeFileSync(FILE(R), JSON.stringify({ familiarity: "new", learning: "off", known: "x" }));
ok("show: known that is not a list reads as unset", /^audience unset \(unreadable: known must be a list of terms\)\n$/.test(cli(R, "show").out));
r = cli(R, "set", "learning=off");
ok("set: starts a fresh profile over a malformed file", r.code === 0 && JSON.stringify(stored(R).known) === "[]" && stored(R).familiarity === "some" && stored(R).learning === "off", r.out + r.err);

// path and help
R = repo();
r = cli(path.join(R, "sub"), "path");
ok("path: the file under <git-common-dir>/proteus-lead", r.code === 0 && r.out === FILE(R) + "\n", r.out + r.err);
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
ok("show: outside a repo says unset and why, exit 0", r.code === 0 && r.out === "audience unset (unreadable: not inside a git repository)\n", r.out + r.err);
for (const c of [["set", "familiarity=new"], ["know", "placeholder"], ["forget", "placeholder"], ["terms"], ["path"]]) {
  r = cli(OUT, ...c);
  ok(`${c[0]}: outside a repo exits 1 with one line and writes nothing`, r.code === 1 && r.err === "proteus-profile: not inside a git repository\n" && !r.out && fs.readdirSync(OUT).length === 0, r.out + r.err);
}

// a refused write: the lead dir is a link
if (process.platform !== "win32") {
  R = repo();
  const elsewhere = path.join(W, `elsewhere${n}`);
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, path.join(R, ".git", "proteus-lead"));
  r = cli(R, "set", "familiarity=new");
  ok("set: a linked proteus-lead is refused in one line, nothing written through it", r.code === 1 && /^proteus-profile: cannot write .*lead state refused/.test(r.err) && fs.readdirSync(elsewhere).length === 0 && !/\n\s+at /.test(r.err), r.err);
}

lib.summary();

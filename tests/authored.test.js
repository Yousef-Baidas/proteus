// Authored skill and commit pin tests: node tests/authored.test.js. link-skills.js links teams/<team>/skills/<name>/
// like a found skill (lock "source": "authored", counted toward CAP), refuses a team where one shares a name with a
// listed skill, scans each with proteus-skill-scan.js and blocks a finding until --relock pins it to that content;
// a skills.txt line's @<sha> is parsed, passed to `npx skills add` and kept in the lock (#10). Temp HOME and repo.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("authored");
const LS = path.join(ROOT, "templates", "teams", "link-skills.js");
const L = require(LS);

// installed skills in the temp HOME, where findSrc looks
const SK = path.join(lib.HOME, ".agents", "skills");
const skill = (name, size = 10) => { fs.mkdirSync(path.join(SK, name), { recursive: true }); fs.writeFileSync(path.join(SK, name, "SKILL.md"), "x".repeat(size)); };
for (const n of ["s1", "s2", "s3", "s4", "big"]) skill(n, n === "big" ? 30000 : 10);

// a fake npx records its arguments and installs a 10-byte skill
const NPXLOG = path.join(W, "npx.log");
const NPX = `const fs = require("fs"), path = require("path"), a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(NPXLOG)}, a.join(" ") + "\\n");
const n = a[a.indexOf("--skill") + 1], d = path.join(${JSON.stringify(SK)}, n);
fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, "SKILL.md"), "y".repeat(10));`;
if (process.platform === "win32") {
  fs.writeFileSync(path.join(W, "npx.js"), NPX);
  fs.writeFileSync(path.join(lib.BIN, "npx.cmd"), `@"${process.execPath}" "${path.join(W, "npx.js")}" %*\r\n`);
} else lib.fakeCli(lib.BIN, "npx", NPX);
const npxCalls = () => { try { return fs.readFileSync(NPXLOG, "utf8").trim().split("\n").filter(Boolean); } catch { return []; } };

// a SKILL.md the scanner passes clean, and one it flags (no license)
const CLEAN = "---\nname: craft\ndescription: house rules\nlicense: MIT\n---\n# Craft\n\nKeep it tidy.\n";
const FLAGGED = "---\nname: craft\ndescription: house rules\n---\n# Craft\n\nKeep it tidy.\n";

// a fresh repo: teams/<team>/<file> lines as given, and authored skills as { name: SKILL.md text }
let k = 0;
function repo(teams) {
  const R = path.join(W, `r${k++}`);
  g(W, "init", "-q", "-b", "main", R);
  for (const [t, files] of Object.entries(teams)) {
    fs.mkdirSync(path.join(R, "teams", t), { recursive: true });
    for (const [f, v] of Object.entries(files)) {
      if (f === "skills") for (const [n, text] of Object.entries(v)) author(R, t, n, text);
      else fs.writeFileSync(path.join(R, "teams", t, f), v.map((n) => (n.includes(" ") ? n : `o/r ${n}`) + "\n").join(""));
    }
  }
  return R;
}
function author(R, t, n, text) {
  fs.mkdirSync(path.join(R, "teams", t, "skills", n), { recursive: true });
  fs.writeFileSync(path.join(R, "teams", t, "skills", n, "SKILL.md"), text);
}
const linkSkills = (R, args = [], script = LS) => lib.run(script, "", { cwd: R, args });
const linkedIn = (R, t) => { try { return fs.readdirSync(path.join(R, "teams", t, ".claude", "skills")).sort(); } catch { return []; } };
const lockOf = (R) => { try { return JSON.parse(fs.readFileSync(path.join(R, "teams", "skills-lock.json"), "utf8")).skills; } catch { return {}; } };

// linked and locked like a found skill
let R = repo({ a: { "skills.txt": ["s1"], skills: { craft: CLEAN } } });
let r = linkSkills(R);
const at = path.join(R, "teams", "a", ".claude", "skills", "craft");
ok("authored: a clean authored skill is linked beside the found one and the run exits 0",
  r.code === 0 && linkedIn(R, "a").join() === "craft,s1" && L.samePath(L.real(at), path.join(R, "teams", "a", "skills", "craft")), r.out + r.err);
ok("authored: it links into the Codex dir too", fs.readdirSync(path.join(R, "teams", "a", ".agents", "skills")).sort().join() === "craft,s1");
let lock = lockOf(R);
ok("authored: the lock entry has source authored and the content hash, and no scan for a clean skill",
  lock.craft && lock.craft.source === "authored" && lock.craft.hash === L.hashDir(path.join(R, "teams", "a", "skills", "craft")) && !("scan" in lock.craft), JSON.stringify(lock));

// a team with only authored skills (no list file) is linked too
R = repo({ a: { skills: { craft: CLEAN } } });
r = linkSkills(R);
ok("authored: a team with no skills.txt links its authored skills", r.code === 0 && linkedIn(R, "a").join() === "craft", r.out + r.err);

// counts toward both caps
R = repo({ a: { "skills.txt": ["s1", "s2", "s3", "s4"], skills: { craft: CLEAN } } });
r = linkSkills(R);
ok("cap: 4 skills.txt skills plus one authored skill is 5 and refused, nothing linked, exit 3",
  r.code === 3 && /^cap: a 5 skills, \d+ bytes \(max 4, 40960\)$/m.test(r.err) && !linkedIn(R, "a").length, r.out + r.err);
R = repo({ a: { "skills.txt": ["big"], skills: { craft: CLEAN + "z".repeat(12000) } } });
r = linkSkills(R);
ok("cap: an authored SKILL.md's bytes count toward the 40960", r.code === 3 && /^cap: a 2 skills, 42\d\d\d bytes /m.test(r.err) && !linkedIn(R, "a").length, r.out + r.err);

// a duplicate name refuses the team; another team still links
R = repo({ a: { "skills.txt": ["s1", "s2"], skills: { s2: CLEAN } }, b: { "skills.txt": ["s1"] } });
r = linkSkills(R);
ok("dup: an authored skill named like a listed one prints dup: <team> <name>, links nothing there, exits 3",
  r.code === 3 && /^dup: a s2$/m.test(r.err) && !linkedIn(R, "a").length && linkedIn(R, "b").join() === "s1", r.out + r.err);
R = repo({ a: { "required.txt": ["s1"], skills: { s1: CLEAN } } });
ok("dup: a name in required.txt counts as well", /^dup: a s1$/m.test(linkSkills(R).err) && !linkedIn(R, "a").length);

// a scan finding blocks the team until --relock pins the acceptance to the content
R = repo({ a: { "skills.txt": ["s1"], skills: { craft: FLAGGED } }, b: { "skills.txt": ["s2"] } });
r = linkSkills(R);
ok("scan: a finding prints scan: <team>/<name> FINDINGS <n>, links nothing for the team, exits 3",
  r.code === 3 && /^scan: a\/craft FINDINGS 1 /m.test(r.err) && !linkedIn(R, "a").length && linkedIn(R, "b").join() === "s2" && !lockOf(R).craft, r.out + r.err);
r = linkSkills(R, ["--relock"]);
const sha = L.hashDir(path.join(R, "teams", "a", "skills", "craft"));
lock = lockOf(R);
ok("scan: --relock links it and writes scan: <sha256> of the current content",
  r.code === 0 && linkedIn(R, "a").join() === "craft,s1" && lock.craft && lock.craft.scan === sha && lock.craft.hash === sha, r.out + r.err + JSON.stringify(lock));
r = linkSkills(R);
ok("scan: once accepted, a plain run links it and keeps the acceptance", r.code === 0 && linkedIn(R, "a").join() === "craft,s1" && lockOf(R).craft.scan === sha, r.out + r.err);
fs.appendFileSync(path.join(R, "teams", "a", "skills", "craft", "SKILL.md"), "One more rule.\n");
r = linkSkills(R);
ok("scan: a content change after --relock blocks it again", r.code === 3 && /^scan: a\/craft FINDINGS 1 /m.test(r.err) && lockOf(R).craft.scan === sha, r.out + r.err);
// an acceptance recorded for a found skill of that name does not count
R = repo({ a: { skills: { craft: FLAGGED } } });
fs.writeFileSync(path.join(R, "teams", "skills-lock.json"), JSON.stringify({ version: 1, skills: { craft: { source: "o/r", hash: "x", scan: L.hashDir(path.join(R, "teams", "a", "skills", "craft")) } } }));
ok("scan: a matching scan on a non-authored lock entry is not an acceptance", linkSkills(R).code === 3);

// no scanner beside the script: every authored skill is refused
R = repo({ a: { skills: { craft: CLEAN } } });
for (const f of ["link-skills.js"]) fs.copyFileSync(LS, path.join(R, "teams", f));
fs.copyFileSync(path.join(ROOT, "templates", "hooks", "proteus-confine.js"), path.join(R, "teams", "proteus-confine.js"));
r = linkSkills(R, [], path.join(R, "teams", "link-skills.js"));
ok("scan: with no proteus-skill-scan.js to run, the authored skill is refused", r.code === 3 && /^scan: a\/craft FAILED \(no proteus-skill-scan\.js\)$/m.test(r.err) && !linkedIn(R, "a").length, r.out + r.err);

// @<sha> on a skills.txt line
const S1 = "0123456789abcdef0123456789abcdef01234567", S2 = "89ABCDEF0123456789abcdef0123456789abcdef";
const list = path.join(W, "list.txt");
fs.writeFileSync(list, `o/r one @${S1}\no/r two@${S2}\no/r three\n# o/r four @${S1}\n`);
ok("sha: readList splits a trailing @<sha>, as its own word or on the name, lowercased",
  JSON.stringify(L.readList(list)) === JSON.stringify([["o/r", "one", S1], ["o/r", "two", S2.toLowerCase()], ["o/r", "three", ""]]), JSON.stringify(L.readList(list)));
R = repo({ a: { "skills.txt": [`o/r s1 @${S1}`, "o/r fresh@" + S1, "o/r s2"] } });
r = linkSkills(R, ["--install"]);
lock = lockOf(R);
ok("sha: --install passes <owner/repo>#<sha> to npx skills add", npxCalls().length === 1 && npxCalls()[0].includes(`add o/r#${S1} --skill fresh `), npxCalls().join("|"));
ok("sha: the lock stores the sha beside the hash, and none for an unpinned line",
  r.code === 0 && lock.s1.sha === S1 && lock.fresh.sha === S1 && lock.s1.hash === L.hashDir(path.join(SK, "s1")) && !("sha" in lock.s2), r.out + r.err + JSON.stringify(lock));

lib.summary();

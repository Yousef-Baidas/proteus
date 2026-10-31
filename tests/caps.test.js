// Skill cap tests: node tests/caps.test.js. link-skills.js links at most CAP.skills skills.txt skills and
// CAP.bytes of their combined SKILL.md text per team (#10); a team over either links nothing, gets no
// `npx skills add`, and the run exits 3 while other teams link. Temp HOME and repo; npx is a fake.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("caps");
const LS = path.join(ROOT, "templates", "teams", "link-skills.js");
const { CAP } = require(LS);

ok("cap: one exported constant holds 4 skills and 40960 bytes", CAP && CAP.skills === 4 && CAP.bytes === 40960, JSON.stringify(CAP));

// installed skills in the temp HOME, where findSrc looks; a SKILL.md of exactly `size` bytes
const SK = path.join(lib.HOME, ".agents", "skills");
const skill = (name, size = 10) => { fs.mkdirSync(path.join(SK, name), { recursive: true }); fs.writeFileSync(path.join(SK, name, "SKILL.md"), "x".repeat(size)); };

// a fake npx records its arguments; `skills add <src> --skill <name>` installs a 30000-byte skill
const NPXLOG = path.join(W, "npx.log");
const NPX = `const fs = require("fs"), path = require("path"), a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(NPXLOG)}, a.join(" ") + "\\n");
const n = a[a.indexOf("--skill") + 1], d = path.join(${JSON.stringify(SK)}, n);
fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, "SKILL.md"), "y".repeat(30000));`;
if (process.platform === "win32") {
  fs.writeFileSync(path.join(W, "npx.js"), NPX);
  fs.writeFileSync(path.join(lib.BIN, "npx.cmd"), `@"${process.execPath}" "${path.join(W, "npx.js")}" %*\r\n`);
} else lib.fakeCli(lib.BIN, "npx", NPX);
const npxCalls = () => { try { return fs.readFileSync(NPXLOG, "utf8").trim().split("\n").filter(Boolean); } catch { return []; } };

// a fresh repo with teams/<team>/skills.txt (and required.txt) per entry
let k = 0;
function repo(teams) {
  const R = path.join(W, `r${k++}`);
  g(W, "init", "-q", "-b", "main", R);
  for (const [t, files] of Object.entries(teams)) {
    fs.mkdirSync(path.join(R, "teams", t), { recursive: true });
    for (const [f, names] of Object.entries(files)) fs.writeFileSync(path.join(R, "teams", t, f), names.map((n) => `o/r ${n}\n`).join(""));
  }
  return R;
}
const linkSkills = (R, args = []) => lib.run(LS, "", { cwd: R, args });
const linkedIn = (R, t) => { try { return fs.readdirSync(path.join(R, "teams", t, ".claude", "skills")).sort(); } catch { return []; } };

// the shipped starting sets fit the cap, so a fresh install links them
const T = path.join(ROOT, "templates", "teams");
const over = fs.readdirSync(T).filter((t) => fs.existsSync(path.join(T, t, "skills.txt")) && require(LS).readList(path.join(T, t, "skills.txt")).length > CAP.skills);
ok("shipped: every templates/teams/*/skills.txt lists at most 4 skills", !over.length, over.join());

for (const n of ["s1", "s2", "s3", "s4", "s5", "req"]) skill(n);

let R = repo({ a: { "skills.txt": ["s1", "s2", "s3", "s4"] } });
let r = linkSkills(R);
ok("count: a team with exactly 4 skills links all of them and exits 0", r.code === 0 && linkedIn(R, "a").length === 4 && !/cap:/.test(r.err), r.out + r.err);

R = repo({ a: { "skills.txt": ["s1", "s2", "s3", "s4", "s5"] } });
r = linkSkills(R);
ok("count: a team with 5 skills is refused with the cap line, links nothing, exits 3",
  r.code === 3 && /^cap: a 5 skills, 50 bytes \(max 4, 40960\)$/m.test(r.err) && !linkedIn(R, "a").length, r.out + r.err);

skill("big1", 20480); skill("big2", 20480); skill("big3", 20481);
R = repo({ a: { "skills.txt": ["big1", "big2"] } });
r = linkSkills(R);
ok("bytes: SKILL.md text totalling exactly 40960 bytes passes", r.code === 0 && linkedIn(R, "a").length === 2, r.out + r.err);
R = repo({ a: { "skills.txt": ["big1", "big3"] } });
r = linkSkills(R);
ok("bytes: 40961 bytes is refused, nothing linked, exit 3",
  r.code === 3 && /^cap: a 2 skills, 40961 bytes \(max 4, 40960\)$/m.test(r.err) && !linkedIn(R, "a").length, r.out + r.err);

// only SKILL.md counts, not the rest of the skill's files
fs.writeFileSync(path.join(SK, "big1", "notes.md"), "z".repeat(50000));
R = repo({ a: { "skills.txt": ["big1", "big2"] } });
ok("bytes: files beside SKILL.md do not count", linkSkills(R).code === 0 && linkedIn(R, "a").length === 2);

skill("reqbig", 50000);
R = repo({ a: { "skills.txt": ["s1", "s2", "s3", "s4"], "required.txt": ["req", "reqbig"] } });
r = linkSkills(R);
ok("required: required.txt skills count toward neither cap and are linked too", r.code === 0 && linkedIn(R, "a").length === 6 && !/cap:/.test(r.err), r.out + r.err);

R = repo({ a: { "skills.txt": ["s1", "s2", "s3", "s4", "s5"] }, b: { "skills.txt": ["s1", "s2"] } });
r = linkSkills(R);
ok("other teams: one team over its cap does not stop another linking; the run still exits 3",
  r.code === 3 && /cap: a /.test(r.err) && !linkedIn(R, "a").length && linkedIn(R, "b").join() === "s1,s2" && /teams\/b -> 2 skills linked/.test(r.out), r.out + r.err);
const lock = JSON.parse(fs.readFileSync(path.join(R, "teams", "skills-lock.json"), "utf8"));
ok("other teams: the lock pins only what was linked", Object.keys(lock.skills).sort().join() === "s1,s2", JSON.stringify(lock));

// a skill not on this machine counts toward the 4, not the bytes, and is still reported missing
R = repo({ a: { "skills.txt": ["s1", "s2", "s3", "s4", "gone"] } });
r = linkSkills(R);
ok("missing: an absent skill counts toward the 4 and is listed as missing",
  r.code === 3 && /^cap: a 5 skills, 40 bytes /m.test(r.err) && /a: npx skills add o\/r --skill gone/.test(r.out), r.out + r.err);

// --install: no npx call for a team over its cap; a team under it installs as before
R = repo({ a: { "skills.txt": ["s1", "s2", "s3", "s4", "new1"] }, b: { "skills.txt": ["s1", "new2"] } });
r = linkSkills(R, ["--install"]);
ok("install: a capped team gets no npx skills add; the other team's missing skill is installed and linked",
  r.code === 3 && npxCalls().length === 1 && /skills add o\/r --skill new2 /.test(npxCalls()[0]) && linkedIn(R, "b").join() === "new2,s1" && !linkedIn(R, "a").length, npxCalls().join("|") + r.out + r.err);

// bytes are checked again after an install, before any link: two 30000-byte installs make 60000
R = repo({ c: { "skills.txt": ["new3", "new4"] } });
r = linkSkills(R, ["--install"]);
ok("install: skills that install over the byte cap are refused before linking",
  r.code === 3 && /^cap: c 2 skills, 60000 bytes /m.test(r.err) && !linkedIn(R, "c").length, r.out + r.err);

lib.summary();

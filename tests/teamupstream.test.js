// Team file upstream (#97): node tests/teamupstream.test.js (needs git). ROUTING.md, PROFILE.md and
// skills.txt are the repo's once copied, so --project never overwrites them. teams/.proteus-base.json
// records the shipped text each came from; when a release changes one the repo has edited, --project
// and --update put the new text beside it as <file>.upstream (and the old as <file>.base), git-excluded,
// print the git merge-file line, and --doctor lists what is pending. Runs a copy of this checkout as the
// Proteus home (a git repo with a local bare remote) and a fake HOME; never the network or ~/.claude.
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("teamupstream");

// the Proteus home: this checkout's files (uncommitted ones too), committed, with a bare remote for --update
const PH = path.join(W, "proteus"), BARE = path.join(W, "proteus.git");
g(W, "init", "-q", "--bare", "-b", "main", BARE);
g(W, "init", "-q", "-b", "main", PH);
for (const f of execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean)) {
  const s = path.join(ROOT, f);
  if (!fs.existsSync(s) || !fs.statSync(s).isFile()) continue;
  fs.mkdirSync(path.dirname(path.join(PH, f)), { recursive: true });
  fs.copyFileSync(s, path.join(PH, f));
}
g(PH, "add", "-A"); g(PH, "commit", "-qm", "chore: snapshot");
g(PH, "remote", "add", "origin", BARE); g(PH, "push", "-q", "-u", "origin", "main");
const INST = path.join(PH, "install.js");
const SHIP = (rel) => path.join(PH, "templates", "teams", ...rel.split("/"));

const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
const both = (r) => `${r.out}${r.err}`;
const lf = (s) => (s === null ? null : s.replace(/\r\n/g, "\n"));
const repo = (name) => {
  const d = path.join(W, name);
  g(W, "init", "-q", "-b", "main", d);
  fs.writeFileSync(path.join(d, "README.md"), "# app\n");
  g(d, "add", "-A"); g(d, "commit", "-qm", "init");
  return d;
};
const inst = (cwd, args = ["--project"], env = {}) => lib.run(INST, "", { cwd, args, env });
const shipEdit = (rel, line, msg) => { fs.appendFileSync(SHIP(rel), `\n${line}\n`); g(PH, "commit", "-qam", msg); };
const exclude = (d) => read(path.join(d, ".git", "info", "exclude")) || "";

const PR = repo("app");
const T = (...p) => path.join(PR, "teams", ...p);
const record = () => JSON.parse(read(T(".proteus-base.json")) || "{}");

// a first --project copies the files and records what they came from
let r = inst(PR);
let rec = record();
ok("record: --project writes teams/.proteus-base.json with each copied team file", r.code === 0 &&
  ["ROUTING.md", "backend/PROFILE.md", "backend/skills.txt", "qa/PROFILE.md"].every((k) => rec[k] && /^[0-9a-f]{64}$/.test(rec[k].sha256)), both(r) + JSON.stringify(rec));
ok("record: it is committed with teams/, not excluded", g(PR, "status", "--porcelain", "-uall").includes("teams/.proteus-base.json"), g(PR, "status", "--porcelain", "-uall"));
r = inst(PR);
ok("record: a re-run with nothing shipped changes prints no upstream line", r.code === 0 && !/upstream ->/.test(r.out) && JSON.stringify(record()) === JSON.stringify(rec), both(r));

// a copy with no record gets the current hash, silently
const noRec = { ...rec };
delete noRec["ROUTING.md"];
fs.writeFileSync(T(".proteus-base.json"), JSON.stringify(noRec));
fs.appendFileSync(T("ROUTING.md"), "\nlocal routing line\n");
r = inst(PR);
ok("record: a copy with no record is recorded, no notice, no .upstream", r.code === 0 && record()["ROUTING.md"] && record()["ROUTING.md"].sha256 === rec["ROUTING.md"].sha256 &&
  !/upstream ->/.test(r.out) && !fs.existsSync(T("ROUTING.md.upstream")), both(r));
g(PR, "add", "-A"); g(PR, "commit", "-qm", "chore: proteus");

// the repo edits backend/PROFILE.md at the top; a release changes the shipped one at the bottom
const oldShipped = lf(read(SHIP("backend/PROFILE.md")));
const prof = lf(read(T("backend", "PROFILE.md")));
fs.writeFileSync(T("backend", "PROFILE.md"), `LOCAL-EDIT line.\n${prof}`);
const edited = read(T("backend", "PROFILE.md"));
shipEdit("backend/PROFILE.md", "SHIPPED-V2 line.", "feat: backend profile v2");
// and changes qa/skills.txt the same way the repo already has
const qa = lf(read(SHIP("qa/skills.txt")));
fs.writeFileSync(T("qa", "skills.txt"), `${qa}\nsame-change\n`);
fs.writeFileSync(SHIP("qa/skills.txt"), `${qa}\nsame-change\n`); g(PH, "commit", "-qam", "feat: qa skills");
r = inst(PR, ["--update"]);
const up = T("backend", "PROFILE.md.upstream"), base = T("backend", "PROFILE.md.base");
ok("upstream: --update writes the new shipped text beside the edited copy, leaves the copy", r.code === 0 && lf(read(up)) === lf(read(SHIP("backend/PROFILE.md"))) &&
  read(T("backend", "PROFILE.md")) === edited, both(r));
ok("upstream: the old shipped text is written as .base", lf(read(base)) === oldShipped, read(base));
ok("upstream: one line names the file and the git merge-file command, \"/\" paths",
  (r.out.match(/upstream ->/g) || []).length === 1 &&
  r.out.includes("upstream -> teams/backend/PROFILE.md.upstream: this release changed the shipped backend/PROFILE.md; merge it: git merge-file teams/backend/PROFILE.md teams/backend/PROFILE.md.base teams/backend/PROFILE.md.upstream"), both(r));
ok("upstream: .upstream and .base are git-excluded", /^teams\/backend\/PROFILE\.md\.upstream$/m.test(exclude(PR)) && /^teams\/backend\/PROFILE\.md\.base$/m.test(exclude(PR)) &&
  !/\.upstream|\.base/.test(g(PR, "status", "--porcelain", "-uall")), g(PR, "status", "--porcelain", "-uall"));
ok("upstream: the record moves to the new shipped text", record()["backend/PROFILE.md"].sha256 !== rec["backend/PROFILE.md"].sha256 &&
  record()["qa/skills.txt"].sha256 !== rec["qa/skills.txt"].sha256, JSON.stringify(record()));
ok("upstream: a copy that already has the new text gets no .upstream", !fs.existsSync(T("qa", "skills.txt.upstream")));
// the printed command merges cleanly
const m = spawnSync("git", ["merge-file", "teams/backend/PROFILE.md", "teams/backend/PROFILE.md.base", "teams/backend/PROFILE.md.upstream"], { cwd: PR, encoding: "utf8" });
const merged = read(T("backend", "PROFILE.md"));
ok("upstream: the git merge-file line keeps the local edit and takes the shipped one", m.status === 0 && merged.includes("LOCAL-EDIT line.") && merged.includes("SHIPPED-V2 line."), `${m.status} ${m.stderr}`);
fs.writeFileSync(T("backend", "PROFILE.md"), edited);

// doctor lists the pending file
const doc = () => inst(PR, ["--doctor"]);
r = doc();
ok("doctor: WARN lists the pending .upstream", /WARN\s+shipped team file changes not merged: teams\/backend\/PROFILE\.md\.upstream/.test(r.out) && /git merge-file/.test(r.out), r.out);

// a second release before the merge: .upstream moves on, .base stays the text the copy came from
shipEdit("backend/PROFILE.md", "SHIPPED-V3 line.", "feat: backend profile v3");
r = inst(PR);
ok("pending: a newer release updates .upstream and keeps the original .base", r.code === 0 && lf(read(up)).includes("SHIPPED-V3 line.") && lf(read(base)) === oldShipped &&
  /merge it: git merge-file/.test(r.out), both(r));
fs.rmSync(up); fs.rmSync(base);
r = doc();
ok("doctor: ok once merged and deleted", /ok\s+no pending teams\/\*\.upstream/.test(r.out), r.out);
r = inst(PR);
ok("pending: nothing reappears after the merge", !/upstream ->/.test(r.out) && !fs.existsSync(up), both(r));

// a record this checkout never shipped (a teammate's newer release) is left alone
const newer = { ...record(), "backend/skills.txt": { sha256: "f".repeat(64) } };
fs.writeFileSync(T(".proteus-base.json"), JSON.stringify(newer));
r = inst(PR);
ok("newer: a record from a release this checkout lacks is kept, no older text offered", r.code === 0 && record()["backend/skills.txt"].sha256 === "f".repeat(64) &&
  !fs.existsSync(T("backend", "skills.txt.upstream")), both(r));

// no git history in the Proteus home: no .base, a by-hand merge line
const noBase = { ...record(), "backend/skills.txt": rec["backend/skills.txt"] };
fs.writeFileSync(T(".proteus-base.json"), JSON.stringify(noBase));
shipEdit("backend/skills.txt", "# v2", "feat: backend skills v2");
fs.appendFileSync(T("backend", "skills.txt"), "\n# local\n");
fs.renameSync(path.join(PH, ".git"), path.join(PH, ".git-off"));
try { r = inst(PR, ["--project"], { GIT_CEILING_DIRECTORIES: W }); } finally { fs.renameSync(path.join(PH, ".git-off"), path.join(PH, ".git")); }
ok("no base: .upstream written, no .base, the line says merge by hand", fs.existsSync(T("backend", "skills.txt.upstream")) && !fs.existsSync(T("backend", "skills.txt.base")) &&
  r.out.includes("upstream -> teams/backend/skills.txt.upstream: this release changed the shipped backend/skills.txt; merge it into teams/backend/skills.txt by hand"), both(r));

// guest mode: teams/ and the record live in the guest dir; .upstream goes there, named by absolute path
const GR = repo("guestapp"), GD = path.join(W, "guestdir");
r = inst(GR, ["--project", "--guest", GD]);
const GT = (...p) => path.join(GD, "teams", ...p);
ok("guest: the record is in the guest dir, none in the repo", r.code === 0 && fs.existsSync(GT(".proteus-base.json")) && !fs.existsSync(path.join(GR, "teams")), both(r));
fs.appendFileSync(GT("devops", "PROFILE.md"), "\nguest edit\n");
shipEdit("devops/PROFILE.md", "SHIPPED-DEVOPS line.", "feat: devops profile");
r = inst(GR, ["--project"]);
ok("guest: .upstream and .base beside the guest copy, the line names their full paths", fs.existsSync(GT("devops", "PROFILE.md.upstream")) && fs.existsSync(GT("devops", "PROFILE.md.base")) &&
  r.out.includes(`git merge-file ${GT("devops", "PROFILE.md")} ${GT("devops", "PROFILE.md.base")} ${GT("devops", "PROFILE.md.upstream")}`), both(r));
ok("guest: the repo's info/exclude gets no .upstream line", !/\.upstream/.test(exclude(GR)), exclude(GR));
r = inst(GR, ["--doctor"]);
ok("guest: doctor lists the guest dir's pending file", /shipped team file changes not merged: teams\/devops\/PROFILE\.md\.upstream/.test(r.out), r.out);

lib.summary();

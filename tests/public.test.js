// Public-repo note tests: node tests/public.test.js (needs git). On a public GitHub repo the autostart
// says once per repo that everything Proteus posts is public; gh is asked at most once a day until then.
// Temp repo and fake gh; never touches the network.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "templates", "hooks");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("public");

const REPO = path.join(W, "repo");
fs.mkdirSync(path.join(REPO, ".claude", "skills", "proteus"), { recursive: true });
fs.writeFileSync(path.join(REPO, ".claude", "skills", "proteus", "SKILL.md"), "---\nname: proteus\n---\nSKILL BODY\n");
g(W, "init", "-q", "-b", "main", REPO);
const SEEN = path.join(REPO, ".git", "proteus", "visibility.json");
const LOG = path.join(W, "gh.log");
const asked = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8") : "").split("\n").filter((l) => l.startsWith("repo view --json visibility")).length;
const start = (vis, source = "startup") => lib.run(path.join(SRC, "proteus-autostart.js"), { hook_event_name: "SessionStart", source, session_id: "s1", cwd: REPO }, { cwd: REPO, env: vis === "fail" ? { FAKE_GH_LOG: LOG, FAKE_GH: "fail" } : { FAKE_GH_LOG: LOG, FAKE_GH_VISIBILITY: vis } });
const noted = (r) => /this repo is public on GitHub/.test(r.out);
const age = (ms) => { const s = JSON.parse(fs.readFileSync(SEEN, "utf8")); s.at = Date.now() - ms; fs.writeFileSync(SEEN, JSON.stringify(s)); };

// private: no note, one gh call, cached for a day
let r = start("PRIVATE");
ok("private: no note, the hook exits 0", r.code === 0 && !noted(r) && /SKILL BODY/.test(r.out), r.err);
ok("private: visibility cached in .git/proteus/visibility.json", JSON.parse(fs.readFileSync(SEEN, "utf8")).visibility === "PRIVATE" && asked() === 1);
r = start("PUBLIC");
ok("cache: within a day gh is not asked again", !noted(r) && asked() === 1, String(asked()));

// a failed gh (no remote, offline) says nothing and waits for the next day
age(25 * 3600e3);
r = start("fail");
ok("gh failure: no note, no error, retried a day later", r.code === 0 && !noted(r) && r.err === "" && asked() === 2 && JSON.parse(fs.readFileSync(SEEN, "utf8")).visibility === "");

// public: the note shows once, then never again and gh is never asked again
age(25 * 3600e3);
r = start("PUBLIC");
ok("public: the note shows at session start", noted(r) && /run log, issues, contracts, review briefs, evidence branches and questions/.test(r.out) && /Shown once per repo/.test(r.out), r.out.slice(0, 1500));
ok("public: the note comes before the skill body", r.out.indexOf("this repo is public") < r.out.indexOf("SKILL BODY"));
ok("public: recorded as warned", typeof JSON.parse(fs.readFileSync(SEEN, "utf8")).warned === "string");
const n = asked();
age(48 * 3600e3);
ok("public: a later session start, even after a day, shows nothing and asks gh nothing", ["startup", "compact", "resume", "clear"].every((s) => !noted(start("PUBLIC", s))) && asked() === n, String(asked()));

// a fresh repo on a resumed session: the note rides on the one-line resume output too
fs.rmSync(SEEN);
r = start("PUBLIC", "resume");
ok("resume: the note follows the resume line", /session resumed/.test(r.out) && noted(r), r.out);

// a subagent never asks
fs.rmSync(SEEN);
r = lib.run(path.join(SRC, "proteus-autostart.js"), { hook_event_name: "SessionStart", source: "startup", agent_id: "a1", cwd: REPO }, { cwd: REPO, env: { FAKE_GH_VISIBILITY: "PUBLIC" } });
ok("subagent: silent, nothing recorded", r.out === "" && !fs.existsSync(SEEN));

lib.summary();

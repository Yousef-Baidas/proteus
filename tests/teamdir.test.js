// Team folders (#367): node tests/teamdir.test.js. A repo with no teams/<team>/ reads the team's files from
// Proteus (templates/teams); one with its own teams/<team>/PROFILE.md (an eject) reads its own; a skills.txt alone
// overrides only the list. lib.teamDir/teamFile/teamRef/teamNames and proteus-cli.js team agree. Temp dirs only.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const lib = require(path.join(__dirname, "lib.js"));
const { ok } = lib;
const W = lib.workdir("teamdir");
const HL = require(path.join(ROOT, "templates", "hooks", "proteus-lib.js"));
const CLI = path.join(ROOT, "templates", "hooks", "proteus-cli.js");
const SHIPPED = path.join(ROOT, "templates", "teams");
const slash = (p) => p.split(path.sep).join("/");
const repo = (name) => { const d = path.join(W, name); fs.mkdirSync(d, { recursive: true }); return d; };

// no teams/ at all: every resolver points at the shipped folder
const BARE = repo("bare");
ok("shipped: teamDir is Proteus's folder when the repo has none", HL.teamDir(BARE, "backend") === path.join(SHIPPED, "backend"), HL.teamDir(BARE, "backend"));
ok("shipped: teamFile reads the shipped PROFILE.md", HL.teamFile(BARE, "backend", "PROFILE.md") === path.join(SHIPPED, "backend", "PROFILE.md"));
ok("shipped: teamRef is the absolute \"/\" path", HL.teamRef(BARE, "backend") === slash(path.join(SHIPPED, "backend")), HL.teamRef(BARE, "backend"));
ok("shipped: no ROUTING.md routes no team", HL.teamNames(BARE).length === 0, HL.teamNames(BARE).join());
let r = lib.run(CLI, "", { cwd: BARE, args: ["team", "backend"] });
ok("shipped: proteus-cli.js team prints the shipped folder", r.code === 0 && slash(r.out.trim()) === slash(path.join(SHIPPED, "backend")), r.out + r.err);
r = lib.run(CLI, "", { cwd: BARE, args: ["team"] });
ok("cli: team with no name is a usage error", r.code === 2, r.out + r.err);

// a ROUTING.md naming backend: backend, plus qa and security (never routed), from Proteus
const ROUTED = repo("routed");
fs.mkdirSync(path.join(ROUTED, "teams"));
fs.writeFileSync(path.join(ROUTED, "teams", "ROUTING.md"), "| Path | Team |\n|------|------|\n| `src/**` | backend |\n");
ok("routed: teamNames is the routed team and the never-routed ones", HL.teamNames(ROUTED).join() === "backend,qa,security", HL.teamNames(ROUTED).join());

// an eject: the repo's own PROFILE.md wins, the relative path is given, and an unknown team of its own is listed
const EJ = repo("eject");
fs.mkdirSync(path.join(EJ, "teams", "backend"), { recursive: true });
fs.writeFileSync(path.join(EJ, "teams", "backend", "PROFILE.md"), "# own\n");
fs.mkdirSync(path.join(EJ, "teams", "data"), { recursive: true });
fs.writeFileSync(path.join(EJ, "teams", "data", "PROFILE.md"), "# data\n");
ok("eject: teamDir is the repo's folder", HL.teamDir(EJ, "backend") === path.join(EJ, "teams", "backend"), HL.teamDir(EJ, "backend"));
ok("eject: teamRef is the relative teams/<team>", HL.teamRef(EJ, "backend") === "teams/backend", HL.teamRef(EJ, "backend"));
ok("eject: every file of an ejected team is read from the repo, none from Proteus", HL.teamFile(EJ, "backend", "skills.txt") === path.join(EJ, "teams", "backend", "skills.txt"));
ok("eject: teamNames lists the repo's own teams", HL.teamNames(EJ).join() === "backend,data", HL.teamNames(EJ).join());
r = lib.run(CLI, "", { cwd: EJ, args: ["team", "backend"] });
ok("eject: proteus-cli.js team prints the repo's folder", r.code === 0 && slash(r.out.trim()) === slash(fs.realpathSync(path.join(EJ, "teams", "backend"))) ||
  slash(r.out.trim()) === slash(path.join(EJ, "teams", "backend")), r.out + r.err);

// a skills.txt alone: the list is the repo's, the folder stays Proteus's
const LIST = repo("list");
fs.mkdirSync(path.join(LIST, "teams", "qa"), { recursive: true });
fs.writeFileSync(path.join(LIST, "teams", "qa", "skills.txt"), "# mine\n");
ok("list: a skills.txt alone overrides only the list", HL.teamFile(LIST, "qa", "skills.txt") === path.join(LIST, "teams", "qa", "skills.txt") &&
  HL.teamDir(LIST, "qa") === path.join(SHIPPED, "qa"), HL.teamDir(LIST, "qa"));


lib.summary();

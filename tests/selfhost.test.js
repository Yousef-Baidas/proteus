// Self-host contract (#4): `node install.js --project` run inside a clone of this checkout sets Proteus up on its own source.
// Clones the checkout (PROTEUS_SELFHOST_SRC overrides the repo cloned, for tests only) under os.tmpdir(), commits its uncommitted
// edits to tracked files there, then installs with a temp HOME and fake gh and claude; untracked files are not carried over.
// Never the network, the real ~/.claude, ~/.codex or ~/.pi, or a write to the checkout itself.
// Exit 0 if every assertion passed, 1 otherwise.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, summary } = lib;

const SRC = process.env.PROTEUS_SELFHOST_SRC || path.join(__dirname, "..");
const W = lib.workdir("selfhost");
const CLONE = path.join(W, "clone");
const CTX = "context-mode@context-mode";

// fake claude: records the context-mode plugin the way the real CLI does, in the temp HOME
lib.fakeCli(lib.BIN, "claude", `const fs = require("fs"), path = require("path"), os = require("os");
const a = process.argv.slice(2).join(" ");
const d = path.join(os.homedir(), ".claude"), rd = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {}; } };
fs.mkdirSync(path.join(d, "plugins"), { recursive: true });
if (a === "plugin marketplace add mksglu/context-mode") fs.writeFileSync(path.join(d, "plugins", "known_marketplaces.json"), JSON.stringify({ "context-mode": {} }));
if (a === "plugin install ${CTX} --scope user") fs.writeFileSync(path.join(d, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "${CTX}": [{ scope: "user" }] } }));
if (a === "plugin install ${CTX} --scope user" || a === "plugin enable ${CTX} --scope user") {
  const s = rd(path.join(d, "settings.json")); s.enabledPlugins = { ...s.enabledPlugins, "${CTX}": true }; fs.writeFileSync(path.join(d, "settings.json"), JSON.stringify(s));
}
`);

const git = (args, cwd = CLONE, input) => spawnSync("git", args, { cwd, env: lib.ENV, encoding: "utf8", input, maxBuffer: 1 << 28 });

const clone = git(["clone", "--quiet", SRC, CLONE], W);
ok("the checkout clones into a temp dir", clone.status === 0, clone.stderr);

// uncommitted edits to tracked files (git mv included) count too, committed in the clone; the checkout is only read
const diff = git(["diff", "HEAD", "--binary"], SRC);
if (diff.stdout) {
  const apply = git(["apply", "--index"], CLONE, diff.stdout);
  const commit = apply.status === 0 && git(["commit", "--quiet", "--no-verify", "-m", "uncommitted changes"]);
  ok("the checkout's uncommitted changes apply to the clone", apply.status === 0 && commit.status === 0, `${apply.stderr}${commit && commit.stderr}`);
}

const r = lib.run(path.join(CLONE, "install.js"), "", { cwd: CLONE, args: ["--project"] });
ok("install.js --project in the checkout exits 0", r.code === 0, `${r.code} ${r.err}${r.out}`);

// tracked files only: untracked (??) is what the install adds, modified or deleted is what it must not do
const st = git(["status", "--porcelain"]);
const dirty = (st.stdout || "").split("\n").filter((l) => l && !l.startsWith("??") && /[MD]/.test(l.slice(0, 2)));
ok("no tracked file is modified or deleted", st.status === 0 && !dirty.length, dirty.join("\n") || st.stderr);

ok("teams/ROUTING.md exists in the checkout", fs.existsSync(path.join(CLONE, "teams", "ROUTING.md")));
ok(".claude/hooks/proteus-autostart.js exists in the checkout", fs.existsSync(path.join(CLONE, ".claude", "hooks", "proteus-autostart.js")));
ok("teams/templates is ignored by git", git(["check-ignore", "-q", "teams/templates"]).status === 0);
ok("no nested roster copy at teams/templates/teams", !fs.existsSync(path.join(CLONE, "teams", "templates", "teams")));
// self-host runs the checkout's own templates/teams/link-skills.*: a copy in teams/ would be a second, drifting source (#17)
const linkCopies = ["link-skills.js", "link-skills.sh", "link-skills.ps1"].filter((f) => fs.existsSync(path.join(CLONE, "teams", f)));
ok("no teams/link-skills.{js,sh,ps1} copy in the checkout", !linkCopies.length, linkCopies.join(", "));

// the move itself (#4 amendment): git tracks the shipped roster under templates/teams and nothing under teams/
const shipped = (git(["ls-files", "templates/teams"]).stdout || "").split("\n").filter(Boolean);
const want = ["ROUTING.md", ...["backend", "devops", "frontend", "qa", "security"].map((t) => `${t}/PROFILE.md`)].map((f) => `templates/teams/${f}`);
ok("git ls-files templates/teams lists ROUTING.md and each team's PROFILE.md", want.every((f) => shipped.includes(f)), want.filter((f) => !shipped.includes(f)).join(", "));
const own = git(["ls-files", "teams"]);
ok("git ls-files teams is empty", own.status === 0 && !own.stdout.trim(), own.stdout || own.stderr);

summary();

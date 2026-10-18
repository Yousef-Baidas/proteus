// Teams by evidence (#156): proteus-teamfit.js's signal per shipped team, and install.js using it. --project and
// --plugin-setup copy only the teams a first install has evidence for, write ROUTING.md without the rest's rows and
// name each left out; a refresh never adds a team (the lang-learn roster); --doctor warns about a team that fits
// nothing. node tests/teamfit.test.js (needs git). Temp repos and a fake HOME; never the network or the real ~/.claude.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("teamfit");
const INSTALL = path.join(ROOT, "install.js");
const TF = require(path.join(ROOT, "templates", "hooks", "proteus-teamfit.js"));
const exists = (...p) => fs.existsSync(path.join(...p));
const read = (...p) => { try { return fs.readFileSync(path.join(...p), "utf8"); } catch { return ""; } };
const both = (r) => `${r.out}${r.err}`;

let n = 0;
// a repo with files {rel: text} committed (or only added when commit is false)
function repo(files, { remote = false, commit = true } = {}) {
  const d = path.join(W, `r${++n}`);
  g(W, "init", "-q", "-b", "main", d);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(d, ...rel.split("/"))), { recursive: true });
    fs.writeFileSync(path.join(d, ...rel.split("/")), text);
  }
  if (remote) g(d, "remote", "add", "origin", "https://example.invalid/r.git");
  if (Object.keys(files).length) g(d, "add", "-A");
  if (commit && Object.keys(files).length) g(d, "commit", "-q", "-m", "init");
  return d;
}
const fits = (files, opt) => { const a = TF.assess(repo(files, opt)); return { a, t: a.teams }; };
const pkg = (deps, extra = {}) => JSON.stringify({ name: "x", ...extra, dependencies: deps });
const many = (n, f) => Object.fromEntries(Array.from({ length: n }, (_, i) => f(i)));

// ---- frontend
let x = fits({ "package.json": pkg({ react: "18" }), "src/main.ts": "x\n" });
ok("frontend: a UI framework in the root package.json fits", x.t.frontend.fits && /react in package\.json/.test(x.t.frontend.reason), JSON.stringify(x.a));
x = fits({ "package.json": JSON.stringify({ name: "mono", private: true, workspaces: ["apps/*"] }), "apps/web/package.json": pkg({ vue: "3" }), "apps/web/src/main.ts": "x\n" });
ok("frontend: a monorepo's UI in a workspace member (apps/web) with no root dependency fits", x.t.frontend.fits && /apps\/web\/package\.json/.test(x.t.frontend.reason), JSON.stringify(x.a));
x = fits({ "pnpm-workspace.yaml": "packages:\n  - packages/*\n", "package.json": pkg({}), "packages/ui/package.json": pkg({ svelte: "5" }), "packages/ui/index.js": "x\n" });
ok("frontend: a pnpm workspace member's svelte fits", x.t.frontend.fits, JSON.stringify(x.a));
x = fits({ "src/App.vue": "<template/>\n", "src/main.js": "x\n" });
ok("frontend: a tracked .vue file fits with no manifest", x.t.frontend.fits && /UI file/.test(x.t.frontend.reason), JSON.stringify(x.a));
x = fits({ "pyproject.toml": "[project]\nname='a'\ndependencies = [\"click\"]\n", "a/cli.py": "x\n" });
ok("frontend: a Python CLI does not fit, and says why", !x.t.frontend.fits && x.t.frontend.reason === "no UI dependency or UI files", JSON.stringify(x.a));
// server-rendered templates inside a backend
const django = (k) => ({ "requirements.txt": "Django>=4.2\n", "manage.py": "x\n", "app/views.py": "x\n", ...many(k, (i) => [`app/templates/p${i}.html`, "<p>\n"]) });
x = fits(django(TF.UI_TEMPLATE_LIMIT));
ok(`frontend: ${TF.UI_TEMPLATE_LIMIT} Django templates (not more than the limit) do not fit; backend does`,
  !x.t.frontend.fits && new RegExp(`${TF.UI_TEMPLATE_LIMIT} server-rendered templates, not more than ${TF.UI_TEMPLATE_LIMIT}`).test(x.t.frontend.reason) && x.t.backend.fits, JSON.stringify(x.a));
x = fits(django(TF.UI_TEMPLATE_LIMIT + 1));
ok("frontend: more templates than the limit fit, and the reason names the limit", x.t.frontend.fits && new RegExp(`more than ${TF.UI_TEMPLATE_LIMIT}`).test(x.t.frontend.reason), JSON.stringify(x.a));
x = fits({ "Gemfile": "gem 'rails', '~> 7'\n", "app/models/u.rb": "x\n", "app/views/mail/welcome.html.erb": "x\n" });
ok("frontend: one Rails mail view adds no frontend; rails is backend", !x.t.frontend.fits && x.t.backend.fits, JSON.stringify(x.a));
// docs sites
x = fits({ "package.json": pkg({ "@docusaurus/core": "3", react: "18" }), "src/pages/index.js": "x\n", "src/css/custom.css": "a{}\n", "docusaurus.config.js": "x\n" });
ok("frontend: a Docusaurus docs site does not fit (react and its css are the site's)", !x.t.frontend.fits && /docs site/.test(x.t.frontend.reason), JSON.stringify(x.a));
x = fits({ "mkdocs.yml": "site_name: a\n", "docs/index.md": "# a\n", "docs/extra.css": "a{}\n", "overrides/main.html": "x\n", "tool.py": "x\n" });
ok("frontend: an MkDocs site (docs/ and theme overrides) does not fit", !x.t.frontend.fits, JSON.stringify(x.a));
x = fits({ "install.js": "x\n", "docs/index.html": "x\n", "docs/site.css": "a{}\n", ...many(8, (i) => [`docs/p${i}.html`, "x\n"]) });
ok("frontend: a plain docs/ site does not fit", !x.t.frontend.fits, JSON.stringify(x.a));
// generated and vendored files
x = fits({ "main.go": "x\n", "vendor/lib/style.css": "a{}\n", "dist/app.jsx": "x\n", "build/index.html": "x\n", "web/app.min.css": "a{}\n",
  "node_modules/react/package.json": pkg({ react: "18" }), "test/fixtures/ui/package.json": pkg({ react: "18" }), "tests/App.tsx": "x\n", "examples/demo/App.vue": "x\n" });
ok("frontend: vendored, generated, minified, test and example files are ignored", !x.t.frontend.fits, JSON.stringify(x.a));
// native UI
x = fits({ "App.xcodeproj/project.pbxproj": "buildSettings = {\n\tSDKROOT = iphoneos;\n};\n", "App/ContentView.swift": "import SwiftUI\n" });
ok("frontend: an iOS Xcode project (SwiftUI) fits", x.t.frontend.fits && /project\.pbxproj/.test(x.t.frontend.reason), JSON.stringify(x.a));
x = fits({ "Package.swift": "x\n", "Sources/App/Main.storyboard": "x\n", "Sources/App/main.swift": "import UIKit\n" });
ok("frontend: a UIKit storyboard fits", x.t.frontend.fits, JSON.stringify(x.a));
x = fits({ "Package.swift": "x\n", "Sources/Tool/main.swift": "import Foundation\n" });
ok("frontend: a Swift package with no UI target does not fit", !x.t.frontend.fits, JSON.stringify(x.a));
x = fits({ "pubspec.yaml": "name: a\ndependencies:\n  flutter:\n    sdk: flutter\n", "lib/main.dart": "x\n" });
ok("frontend: a Flutter app fits", x.t.frontend.fits && /pubspec\.yaml/.test(x.t.frontend.reason), JSON.stringify(x.a));
x = fits({ "package.json": pkg({ "react-native": "0.74" }), "index.js": "x\n" });
ok("frontend: a React Native app fits", x.t.frontend.fits && /react-native/.test(x.t.frontend.reason), JSON.stringify(x.a));
x = fits({ "app/build.gradle.kts": "plugins { id(\"com.android.application\") }\nbuildFeatures { compose = true }\n", "app/src/main/kotlin/A.kt": "x\n" });
ok("frontend: an Android Compose app fits", x.t.frontend.fits, JSON.stringify(x.a));

// ---- backend, one per manifest family, and the layout
for (const [what, files] of [
  ["express in package.json", { "package.json": pkg({ express: "4" }), "index.js": "x\n" }],
  ["fastapi in pyproject.toml", { "pyproject.toml": "[project]\ndependencies = [\"fastapi>=0.110\"]\n", "app.py": "x\n" }],
  ["gin in go.mod", { "go.mod": "module a\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n)\n", "main.go": "x\n" }],
  ["axum in Cargo.toml", { "Cargo.toml": "[package]\nname = \"a\"\n\n[dependencies]\naxum = \"0.7\"\n", "src/main.rs": "x\n" }],
  ["spring-boot in pom.xml", { "pom.xml": "<project><dependencies><dependency><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>\n", "src/main/java/A.java": "x\n" }],
  ["laravel in composer.json", { "composer.json": JSON.stringify({ require: { "laravel/framework": "^11" } }), "app/A.php": "x\n" }],
  ["ASP.NET Core in a .csproj", { "Api/Api.csproj": "<Project Sdk=\"Microsoft.NET.Sdk.Web\"></Project>\n", "Api/Program.cs": "x\n" }],
  ["phoenix in mix.exs", { "mix.exs": "defp deps do\n  [{:phoenix, \"~> 1.7\"}]\nend\n", "lib/a.ex": "x\n" }],
  ["a migrations/ layout", { "db/migrations/001_init.sql": "x\n", "main.c": "x\n" }],
]) {
  x = fits(files);
  ok(`backend: ${what} fits`, x.t.backend.fits, JSON.stringify(x.a));
}
x = fits({ "Cargo.toml": "[package]\nname = \"a\"\n\n[dependencies]\nclap = \"4\"\n", "src/main.rs": "x\n" });
ok("backend: a Rust CLI does not fit, and says why", !x.t.backend.fits && /no server framework/.test(x.t.backend.reason), JSON.stringify(x.a));

// ---- devops, security, qa
x = fits({ "main.py": "x\n" }, { remote: true });
ok("devops: a repo with a git remote fits", x.t.devops.fits && /git remote origin/.test(x.t.devops.reason), JSON.stringify(x.a));
x = fits({ "main.py": "x\n", ".github/workflows/ci.yml": "on: push\n" });
ok("devops: CI config fits with no remote", x.t.devops.fits, JSON.stringify(x.a));
x = fits({ "main.py": "x\n", "Dockerfile": "FROM x\n" });
ok("devops: a Dockerfile fits with no remote", x.t.devops.fits, JSON.stringify(x.a));
x = fits({ "main.py": "x\n" });
ok("devops: code with no remote, CI, containers or infrastructure does not fit", !x.t.devops.fits && /no git remote/.test(x.t.devops.reason), JSON.stringify(x.a));
ok("security and qa always fit", x.t.security.fits && x.t.qa.fits);

// ---- greenfield, staged files, the cap
x = fits({ "README.md": "# a\n" }, { remote: true });
ok("greenfield: no code yet gets security, qa and devops only", x.a.greenfield && x.t.devops.fits && x.t.security.fits && x.t.qa.fits && !x.t.frontend.fits && !x.t.backend.fits && /scaffold/.test(x.t.frontend.reason), JSON.stringify(x.a));
x = fits({}, {});
ok("greenfield: an empty repo (no commit) is greenfield", x.a.greenfield && x.t.devops.fits, JSON.stringify(x.a));
x = fits({ "package.json": pkg({ react: "18" }) }, { commit: false });
ok("files added but not committed yet count", x.t.frontend.fits, JSON.stringify(x.a));
x = TF.assess(repo({ "main.py": "x\n" }), { capMs: 0 });
ok("cap: past it every team is kept and the reason says so", x.capped && Object.values(x.teams).every((t) => t.fits && /cap/.test(t.reason)), JSON.stringify(x));

// ---- install.js --project: first install by evidence
const project = (cwd, env = {}) => lib.run(INSTALL, "", { cwd, args: ["--project"], env });
const plugin = (cwd, args = []) => lib.run(INSTALL, "", { cwd, args: ["--plugin-setup", ...args] });
const teamsIn = (d) => ["frontend", "backend", "devops", "security", "qa"].filter((t) => exists(d, "teams", t));
const CLI = repo({ "pyproject.toml": "[project]\nname='a'\ndependencies = [\"click\"]\n", "a/cli.py": "x\n" }, { remote: true });
let r = project(CLI);
ok("--project: a Python CLI with a remote gets devops, qa and security", r.code === 0 && teamsIn(CLI).join() === "devops,security,qa", both(r).slice(-1500));
ok("--project: ROUTING.md has no frontend or backend rows; the devops rows stay",
  !/\|\s*(frontend|backend)\s*\|\s*$/m.test(read(CLI, "teams", "ROUTING.md")) && /\|\s*devops\s*\|\s*$/m.test(read(CLI, "teams", "ROUTING.md")) && /the team that owns the path/.test(read(CLI, "teams", "ROUTING.md")), read(CLI, "teams", "ROUTING.md").slice(0, 900));
ok("--project: one line per team left out, with the reason",
  /^left out frontend: no UI dependency or UI files$/m.test(r.out) && /^left out backend: no server framework/m.test(r.out) && !/left out (devops|qa|security)/.test(r.out), r.out);
r = project(CLI);
ok("--project: a second run (a refresh) adds nothing and rewrites no row", r.code === 0 && teamsIn(CLI).join() === "devops,security,qa" && /^left out frontend: not in this repo's roster, and a refresh never adds a team$/m.test(r.out), both(r).slice(-1500));
const CAP = repo({ "main.py": "x\n" });
r = project(CAP, { PROTEUS_TEAMFIT_CAP_MS: "0" });
ok("--project: past the scan's cap every team is copied and the output says so", r.code === 0 && teamsIn(CAP).length === 5 && /^teams    : every shipped team kept: the evidence scan passed its 0 ms cap$/m.test(r.out), both(r).slice(-1500));

// ---- --plugin-setup: greenfield, dry run
const GF = repo({ "README.md": "# a\n" });
r = plugin(GF, ["--dry-run"]);
ok("--plugin-setup --dry-run: names the teams it would copy and leave out, writes no teams/",
  r.code === 0 && !exists(GF, "teams") && /teams devops, qa, security\)/.test(r.out) && /^would leave out: left out frontend: no code yet/m.test(r.out), both(r).slice(-1500));
r = plugin(GF);
ok("--plugin-setup: greenfield gets security, qa and devops", r.code === 0 && teamsIn(GF).join() === "devops,security,qa" && /^left out backend: no code yet/m.test(r.out), both(r).slice(-1500));

// ---- the lang-learn regression: a committed scout roster without frontend keeps it out
const roster = {
  "package.json": pkg({ react: "18", express: "4" }), "src/App.tsx": "x\n",
  "teams/ROUTING.md": "# Routing\n\n| Deliverable or path | Team |\n|---|---|\n| iOS app, `ios/**` | ios |\n| API, `server/**` | backend |\n| CI, `.github/**` | devops |\n| design docs | architect |\n",
  "teams/ios/PROFILE.md": "# ios\n", "teams/backend/PROFILE.md": "# backend\n", "teams/devops/PROFILE.md": "# devops\n", "teams/architect/PROFILE.md": "# architect\n",
};
for (const [how, fn] of [["--plugin-setup", plugin], ["--project", project]]) {
  const LL = repo(roster, { remote: true });
  const before = read(LL, "teams", "ROUTING.md");
  r = fn(LL);
  ok(`lang-learn: ${how} on a scout roster without frontend adds no frontend (nor security or qa), though the repo has UI`,
    r.code === 0 && !exists(LL, "teams", "frontend") && !exists(LL, "teams", "security") && !exists(LL, "teams", "qa") && teamsIn(LL).join() === "backend,devops", both(r).slice(-1500));
  ok(`lang-learn: ${how} keeps the roster's ROUTING.md and PROFILE.md, refreshes its shipped teams' required.txt, names frontend as left out`,
    read(LL, "teams", "ROUTING.md") === before && read(LL, "teams", "backend", "PROFILE.md") === "# backend\n" && exists(LL, "teams", "devops", "required.txt") &&
    /^left out frontend: not in this repo's roster/m.test(r.out), r.out.slice(-1500));
}

// ---- --doctor: a shipped team that fits nothing
const OLD = repo({ "package.json": pkg({ react: "18" }), "index.js": "x\n" }, { remote: true });
project(OLD);
ok("doctor setup: the UI repo got frontend", exists(OLD, "teams", "frontend"));
fs.writeFileSync(path.join(OLD, "package.json"), pkg({ commander: "12" }));
g(OLD, "commit", "-qam", "no ui");
const doctor = (cwd) => lib.run(INSTALL, "", { cwd, args: ["--doctor"] });
r = doctor(OLD);
const tf = (r.out.split(/\r?\n/).find((l) => /fits nothing here/.test(l)) || "");
ok("--doctor: warns that frontend fits nothing here, with the reason", tf.replace(/^WARN\s+/, "WARN ").startsWith("WARN team frontend fits nothing here (no UI dependency or UI files, no ROUTING row matches a tracked file)"), r.out.slice(-3000));
ok("--doctor: the warning gives the exact removal command, and removes nothing",
  r.out.includes("git rm -r -q --ignore-unmatch -- teams/frontend; ") && (process.platform === "win32" ? r.out.includes('cmd /c rmdir /s /q "teams\\frontend"') : r.out.includes('rm -rf "teams/frontend"')) && exists(OLD, "teams", "frontend"), r.out.slice(-3000));
fs.mkdirSync(path.join(OLD, "src", "components"), { recursive: true });
fs.writeFileSync(path.join(OLD, "src", "components", "a.js"), "x\n");
g(OLD, "add", "-A"); g(OLD, "commit", "-qm", "components");
r = doctor(OLD);
ok("--doctor: no warning once a frontend ROUTING row matches a tracked file", !/fits nothing here/.test(r.out) && /shipped teams fit this repo/.test(r.out), r.out.slice(-3000));

lib.summary();

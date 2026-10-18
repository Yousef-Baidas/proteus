// proteus-teamfit.js: which shipped software teams a repo has evidence for (#156). A library for install.js
// (--project, --plugin-setup, --doctor), no CLI, no exit code. It reads only `git ls-files` with pathspecs and
// the manifests that lists: no directory walk, no network. Past CAP_MS (PROTEUS_TEAMFIT_CAP_MS overrides), or
// when git fails, assess() keeps every team and says why. Never throws. The signals are the table in
// skills/proteus/references/teams.md; keep the two in step.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const CAP_MS = 5000;
// server-rendered templates count as UI only past this many, so an email template adds no team
const UI_TEMPLATE_LIMIT = 5;
// a manifest bigger than this is skipped, not read
const MANIFEST_MAX_BYTES = 1 << 20;

// generated, vendored, docs, test and fixture dirs, and the repo's teams/ (Proteus's own copy): never evidence
const IGNORED_DIRS = ["node_modules", "vendor", "third_party", "dist", "build", "out", "coverage", "target", "Pods",
  ".next", ".nuxt", ".svelte-kit", "docs", "doc", "test", "tests", "__tests__", "spec", "fixtures", "__fixtures__",
  "testdata", "example", "examples"];
const EXCLUDE = [...IGNORED_DIRS.map((d) => `**/${d}/**`), "teams/**", "**/*.min.*"];

// what git ls-files lists, by kind; globs as in a git pathspec (`**/` is any dir, the root included)
const KINDS = {
  manifest: ["**/package.json", "**/composer.json", "**/pyproject.toml", "**/requirements*.txt", "**/Pipfile", "**/go.mod",
    "**/Cargo.toml", "**/Gemfile", "**/pom.xml", "**/build.gradle", "**/build.gradle.kts", "**/*.csproj", "**/*.fsproj",
    "**/mix.exs", "**/pubspec.yaml", "**/*.xcodeproj/project.pbxproj", "**/mkdocs.yml"],
  uiFile: ["**/*.tsx", "**/*.jsx", "**/*.vue", "**/*.svelte", "**/*.astro", "**/*.razor", "**/*.css", "**/*.scss", "**/*.sass", "**/*.less"],
  uiTemplate: ["**/*.html", "**/*.htm", "**/*.html.*", "**/*.haml", "**/*.slim", "**/*.blade.php", "**/*.gohtml", "**/*.hbs",
    "**/*.ejs", "**/*.pug", "**/*.njk", "**/*.twig", "**/*.heex", "**/*.cshtml", "**/*.jinja", "**/*.jinja2"],
  uiNative: ["**/*.storyboard", "**/*.xib", "**/*.xcassets/Contents.json"],
  serverLayout: ["**/migrations/**", "**/migrate/**", "**/handlers/**", "**/controllers/**", "**/server/**", "api/**",
    "**/pages/api/**", "**/app/api/**", "**/*.proto", "**/openapi.yaml", "**/openapi.yml", "**/openapi.json",
    "**/schema.prisma", "**/alembic.ini", "**/manage.py"],
  ops: [".github/workflows/*", ".gitlab-ci.yml", ".circleci/**", "azure-pipelines.yml", "Jenkinsfile", ".buildkite/**",
    "bitbucket-pipelines.yml", ".drone.yml", ".woodpecker.yml", ".woodpecker/**", "**/Dockerfile", "**/*.Dockerfile",
    "**/Containerfile", "**/docker-compose*.yml", "**/docker-compose*.yaml", "**/compose.yml", "**/compose.yaml",
    "**/*.tf", "infra/**", "terraform/**", "k8s/**", "kubernetes/**", "helm/**", "**/Chart.yaml", "Pulumi.yaml",
    "fly.toml", "vercel.json", "netlify.toml", "render.yaml", "Procfile"],
  code: ["js", "mjs", "cjs", "ts", "mts", "cts", "py", "go", "rs", "rb", "java", "kt", "kts", "swift", "m", "dart", "php",
    "cs", "fs", "ex", "exs", "c", "cc", "cpp", "h", "hpp", "scala", "clj", "lua", "sh", "zig", "nim", "ml", "hs"].map((e) => `**/*.${e}`),
};

// dependency names per manifest family: a string matches one dependency by name, a RegExp the manifest's text
const UI_DEPS = {
  npm: ["react", "react-dom", "vue", "svelte", "@sveltejs/kit", "solid-js", "@angular/core", "next", "nuxt", "astro",
    "@remix-run/react", "@builder.io/qwik", "preact", "lit", "react-native", "expo", "electron", "@tauri-apps/api", "@ionic/core"],
  cargo: ["leptos", "yew", "dioxus", "tauri", "egui", "eframe", "iced", "slint"],
  dart: [/sdk:\s*flutter\b/],
  jvm: [/androidx\.compose|org\.jetbrains\.compose|compose\s*=?\s*true|com\.android\.application/i],
  xcode: [/SDKROOT = (iphoneos|appletvos|watchos|xros)\b|ENABLE_PREVIEWS = YES/],
  dotnet: [/Sdk\.BlazorWebAssembly|Components\.WebAssembly|<UseMaui>\s*true|<UseWPF>\s*true|<UseWindowsForms>\s*true/i],
};
const SERVER_DEPS = {
  npm: ["express", "fastify", "koa", "@nestjs/core", "@hapi/hapi", "hono", "elysia", "@trpc/server", "@apollo/server",
    "apollo-server", "graphql-yoga", "prisma", "@prisma/client", "typeorm", "sequelize", "drizzle-orm", "knex", "mongoose",
    "kysely", "@mikro-orm/core", "socket.io", "pg", "mysql2", "better-sqlite3", "mongodb"],
  php: ["laravel/framework", "laravel/lumen-framework", "symfony/framework-bundle", "symfony/http-kernel", "slim/slim",
    "doctrine/orm", "cakephp/cakephp", "yiisoft/yii2"],
  py: ["django", "flask", "fastapi", "starlette", "aiohttp", "tornado", "sanic", "litestar", "quart", "falcon", "pyramid",
    "sqlalchemy", "sqlmodel", "alembic", "peewee", "tortoise-orm", "celery", "psycopg", "psycopg2", "psycopg2-binary",
    "asyncpg", "pymongo"],
  go: ["github.com/gin-gonic/gin", "github.com/labstack/echo", "github.com/gofiber/fiber", "github.com/go-chi/chi",
    "github.com/gorilla/mux", "gorm.io/gorm", "entgo.io/ent", "github.com/jmoiron/sqlx", "github.com/jackc/pgx",
    "github.com/golang-migrate/migrate", "connectrpc.com/connect", "google.golang.org/grpc", "github.com/uptrace/bun"],
  cargo: ["axum", "actix-web", "rocket", "warp", "poem", "tide", "diesel", "sqlx", "sea-orm", "tonic", "tokio-postgres"],
  ruby: ["rails", "sinatra", "hanami", "roda", "grape", "activerecord", "sequel"],
  jvm: [/spring-boot|org\.springframework|quarkus|micronaut|io\.ktor|ktor-server|dropwizard|hibernate|flyway|liquibase|jooq|vertx|javalin/i],
  dotnet: [/Microsoft\.NET\.Sdk\.Web|Microsoft\.AspNetCore|EntityFrameworkCore|Dapper/i],
  elixir: [/\{:(phoenix|ecto|ecto_sql|plug_cowboy|bandit)\b/],
};
// a package.json depending on one of these is a docs site: its UI dependencies and the UI files under it are not evidence
const DOCS_DEPS = ["@docusaurus/core", "vitepress", "vuepress", "@vuepress/core", "nextra", "@astrojs/starlight", "docsify", "docsify-cli"];

const NOT_ROUTED = "always copied: it verifies and is never routed to";

function globRe(g) {
  let s = "";
  for (let i = 0; i < g.length; i++) {
    if (g.startsWith("**/", i)) { s += "(?:.*/)?"; i += 2; }
    else if (g.startsWith("**", i)) { s += ".*"; i += 1; }
    else if (g[i] === "*") s += "[^/]*";
    else s += g[i].replace(/[.+^${}()|[\]\\?]/g, "\\$&");
  }
  return new RegExp(`^${s}$`, "i");
}
const KIND_RE = Object.fromEntries(Object.entries(KINDS).map(([k, gs]) => [k, gs.map(globRe)]));

function family(file) {
  const b = path.posix.basename(file).toLowerCase();
  if (b === "package.json") return "npm";
  if (b === "composer.json") return "php";
  if (b === "pyproject.toml" || b === "pipfile" || /^requirements.*\.txt$/.test(b)) return "py";
  if (b === "go.mod") return "go";
  if (b === "cargo.toml") return "cargo";
  if (b === "gemfile") return "ruby";
  if (b === "pom.xml" || b.startsWith("build.gradle")) return "jvm";
  if (b.endsWith(".csproj") || b.endsWith(".fsproj")) return "dotnet";
  if (b === "mix.exs") return "elixir";
  if (b === "pubspec.yaml") return "dart";
  if (b === "project.pbxproj") return "xcode";
  if (b === "mkdocs.yml") return "mkdocs";
  return "";
}

// a dependency named in a text manifest: the name between separators, never inside a longer name
const named = (text, name) => new RegExp(`(^|[\\s"'\\[{(,:])${name.replace(/[.+^${}()|[\]\\?*/-]/g, "\\$&")}($|[\\s"'<>=!~;,()\\[\\]{}/@])`, "im").test(text);

// the first dependency of list a manifest names, or ""
function depIn(m, list) {
  for (const d of list || []) {
    if (d instanceof RegExp) { const x = d.exec(m.text); if (x) return x[0].trim(); continue; }
    if (m.names ? m.names.has(d) : named(m.text, d)) return d;
  }
  return "";
}

function readManifest(root, file) {
  const fam = family(file), p = path.join(root, ...file.split("/"));
  try { if (fs.statSync(p).size > MANIFEST_MAX_BYTES) return null; } catch { return null; }
  let text = "";
  try { text = fs.readFileSync(p, "utf8"); } catch { return null; }
  const m = { file, dir: path.posix.dirname(file) === "." ? "" : path.posix.dirname(file), fam, text, names: null };
  if (fam === "npm" || fam === "php") {
    let j = null;
    try { j = JSON.parse(text); } catch {}
    const keys = fam === "npm" ? ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] : ["require", "require-dev"];
    m.names = new Set(keys.flatMap((k) => (j && j[k] && typeof j[k] === "object" ? Object.keys(j[k]) : [])));
  }
  return m;
}

const under = (file, dir) => dir === "" || file.startsWith(`${dir}/`);

// the repo's evidence: listed files by kind, parsed manifests, whether it has a remote, whether it has no code yet.
// { capped: true, why } when the cap passes or git fails
function evidence(root, opt = {}) {
  const env = Number(process.env.PROTEUS_TEAMFIT_CAP_MS);
  const cap = opt.capMs !== undefined ? opt.capMs : Number.isFinite(env) && process.env.PROTEUS_TEAMFIT_CAP_MS !== "" ? env : CAP_MS;
  const deadline = Date.now() + cap;
  const left = () => deadline - Date.now();
  const over = { capped: true, why: `the evidence scan passed its ${cap} ms cap` };
  if (left() <= 0) return over;
  const specs = [...new Set(Object.values(KINDS).flat())].map((g) => `:(glob,icase)${g}`)
    .concat(EXCLUDE.map((g) => `:(glob,icase,exclude)${g}`));
  const r = spawnSync("git", ["-c", "core.quotepath=off", "ls-files", "-z", "--", ...specs],
    { cwd: root, encoding: "utf8", timeout: Math.max(1, left()), maxBuffer: 1 << 28, windowsHide: true });
  if (r.error && r.error.code === "ETIMEDOUT") return over;
  if (r.error || r.status !== 0) return { capped: true, why: `git ls-files failed here (${r.error ? r.error.message : (r.stderr || "").trim().split("\n")[0]})` };
  const files = r.stdout.split("\0").filter(Boolean);
  const by = Object.fromEntries(Object.keys(KINDS).map((k) => [k, files.filter((f) => KIND_RE[k].some((re) => re.test(f)))]));
  const manifests = [];
  for (const f of by.manifest) {
    if (left() <= 0) return over;
    const m = readManifest(root, f);
    if (m) manifests.push(m);
  }
  // docs sites: a package that depends on a docs generator, and an mkdocs project's theme overrides
  const docsDirs = manifests.flatMap((m) => (m.fam === "npm" && depIn(m, DOCS_DEPS) ? [m.dir] : []));
  const docsFiles = (f) => docsDirs.some((d) => under(f, d)) || manifests.some((m) => m.fam === "mkdocs" && under(f, m.dir ? `${m.dir}/overrides` : "overrides"));
  if (left() <= 0) return over;
  const rem = spawnSync("git", ["remote"], { cwd: root, encoding: "utf8", timeout: Math.max(1, left()), windowsHide: true });
  if (rem.error && rem.error.code === "ETIMEDOUT") return over;
  const remotes = rem.status === 0 ? rem.stdout.split(/\r?\n/).filter(Boolean) : [];
  const code = by.code.length + by.uiFile.length + by.uiTemplate.length + manifests.filter((m) => m.fam !== "mkdocs").length;
  return {
    capped: false, files, manifests, remotes, greenfield: !code,
    docsDirs, docsManifests: manifests.filter((m) => docsDirs.includes(m.dir) && m.fam === "npm"),
    uiFiles: by.uiFile.filter((f) => !docsFiles(f)), uiTemplates: by.uiTemplate.filter((f) => !docsFiles(f)),
    uiNative: by.uiNative, serverLayout: by.serverLayout, ops: by.ops,
  };
}

const GREENFIELD = "no code yet; the scaffold ticket adds it if the chosen stack needs it";

// one function per shipped team: (evidence) -> { fits, reason }
function frontend(ev) {
  if (ev.greenfield) return { fits: false, reason: GREENFIELD };
  for (const m of ev.manifests) {
    if (m.fam === "npm" && ev.docsDirs.includes(m.dir)) continue;
    const d = depIn(m, UI_DEPS[m.fam]);
    if (d) return { fits: true, reason: `${d} in ${m.file}` };
  }
  if (ev.uiNative.length) return { fits: true, reason: `native UI files (${ev.uiNative[0]})` };
  if (ev.uiFiles.length) return { fits: true, reason: `${ev.uiFiles.length} UI file${ev.uiFiles.length > 1 ? "s" : ""} (${ev.uiFiles[0]})` };
  const t = ev.uiTemplates.length;
  if (t > UI_TEMPLATE_LIMIT) return { fits: true, reason: `${t} server-rendered templates (more than ${UI_TEMPLATE_LIMIT})` };
  const docs = ev.docsManifests.length ? `; the docs site in ${ev.docsManifests[0].file} is not counted` : "";
  return { fits: false, reason: `no UI dependency or UI files${t ? `; ${t} server-rendered template${t > 1 ? "s" : ""}, not more than ${UI_TEMPLATE_LIMIT}` : ""}${docs}` };
}
function backend(ev) {
  if (ev.greenfield) return { fits: false, reason: GREENFIELD };
  for (const m of ev.manifests) {
    const d = depIn(m, SERVER_DEPS[m.fam]);
    if (d) return { fits: true, reason: `${d} in ${m.file}` };
  }
  if (ev.serverLayout.length) return { fits: true, reason: `server layout (${ev.serverLayout[0]})` };
  return { fits: false, reason: "no server framework, ORM, migrations or handlers/API layout" };
}
function devops(ev) {
  if (ev.greenfield) return { fits: true, reason: "no code yet: it owns the scaffold" };
  if (ev.remotes.length) return { fits: true, reason: `git remote ${ev.remotes[0]}` };
  if (ev.ops.length) return { fits: true, reason: `CI, container or infrastructure file (${ev.ops[0]})` };
  return { fits: false, reason: "no git remote, CI, container or infrastructure files" };
}
const security = () => ({ fits: true, reason: NOT_ROUTED });
const qa = () => ({ fits: true, reason: NOT_ROUTED });

const FIT = { frontend, backend, devops, security, qa };

// { capped, why, teams: { <team>: { fits, reason } } }; capped keeps every team
function assess(root, opt = {}) {
  let ev;
  try { ev = evidence(root, opt); } catch (e) { ev = { capped: true, why: `the evidence scan failed (${e.message})` }; }
  if (ev.capped) return { capped: true, why: ev.why, teams: Object.fromEntries(Object.keys(FIT).map((t) => [t, { fits: true, reason: `kept: ${ev.why}` }])) };
  return { capped: false, why: "", greenfield: ev.greenfield, teams: Object.fromEntries(Object.entries(FIT).map(([t, f]) => [t, f(ev)])) };
}

module.exports = { CAP_MS, UI_TEMPLATE_LIMIT, MANIFEST_MAX_BYTES, IGNORED_DIRS, KINDS, UI_DEPS, SERVER_DEPS, DOCS_DEPS, evidence, assess, frontend, backend, devops, security, qa };

// Known shipped blobs (#154): node tests/knownblobs.test.js (needs git and the full history of main).
// scripts/known-blobs.json must list every version scripts/known-blobs.js computes from git log that this branch's
// own commits (merge-base(HEAD, origin/main)..HEAD) superseded, so a PR that changes a shipped file under agents/ or
// templates/ regenerates it; versions superseded elsewhere (two PRs merged together) only warn, and the next
// changelog.js --release regenerates the list (#164). With no origin/main, or in a shallow clone, every one fails.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const lib = require(path.join(__dirname, "lib.js"));
const { ok } = lib;
const kb = require(path.join(ROOT, "scripts", "known-blobs.js"));

const shallow = spawnSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
ok("history: the clone is not shallow (known-blobs needs every commit)", shallow === "false", shallow);
const have = fs.readFileSync(kb.FILE, "utf8").replace(/\r\n/g, "\n");
const j = JSON.parse(have);
let a = null, err = "";
try { a = kb.audit(ROOT, j); } catch (e) { err = e.message; }
const show = (l) => l.map(([p, id]) => `${p} ${id.slice(0, 12)}`).join(", ");
if (a && a.other.length) console.log(`warning: known-blobs.json lacks ${a.other.length} version(s) superseded outside this branch (${show(a.other)}); the next release regenerates it`);
ok(`known-blobs.json has every version this branch superseded${a && a.strict ? " (strict: no origin/main or shallow)" : ""} (else run: node scripts/known-blobs.js)`,
  a !== null && !a.own.length && !a.extra.length, err || (a && `lacks: ${show(a.own)}; not in history: ${show(a.extra)}`));

// the own-versus-other split, on a temp repo: main took another PR that changed b.md, this branch changed a.md
{
  const T = lib.tempdir("kb");
  const g = (...args) => { const r = spawnSync("git", args, { cwd: T, encoding: "utf8", windowsHide: true }); if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`); return r.stdout.trim(); };
  const put = (f, t) => { fs.mkdirSync(path.dirname(path.join(T, f)), { recursive: true }); fs.writeFileSync(path.join(T, f), t); };
  const id = (f) => g("rev-parse", `HEAD:${f}`);
  g("init", "-q"); g("config", "user.email", "t@example.com"); g("config", "user.name", "t"); g("config", "commit.gpgsign", "false"); g("config", "core.autocrlf", "false");
  put("templates/a.md", "a1\n"); put("templates/b.md", "b1\n");
  g("add", "-A"); g("commit", "-qm", "one");
  const a1 = id("templates/a.md"), b1 = id("templates/b.md"), base = g("rev-parse", "HEAD");
  put("templates/b.md", "b2\n"); g("commit", "-qam", "other pr");
  g("update-ref", "refs/remotes/origin/main", "HEAD");
  g("checkout", "-qb", "mine", base); g("merge", "-q", "--no-edit", "--no-ff", "origin/main");
  put("templates/a.md", "a2\n"); g("commit", "-qam", "this pr");
  let r = kb.audit(T, { blobs: {}, texts: {} });
  ok("audit: a version this branch superseded fails, one main superseded only warns",
    !r.strict && JSON.stringify(r.own) === JSON.stringify([["templates/a.md", a1]]) && JSON.stringify(r.other) === JSON.stringify([["templates/b.md", b1]]), JSON.stringify(r));
  r = kb.audit(T, { blobs: { "templates/a.md": [a1] }, texts: {} });
  ok("audit: with that version listed, the branch passes and main's lag warns", !r.own.length && !r.extra.length && r.other.length === 1, JSON.stringify(r));
  r = kb.audit(T, { blobs: { "templates/a.md": [a1, "f".repeat(40)] }, texts: {} });
  ok("audit: a listed id that is no past version fails", r.extra.length === 1 && r.extra[0][1] === "f".repeat(40), JSON.stringify(r));
  g("update-ref", "-d", "refs/remotes/origin/main");
  r = kb.audit(T, { blobs: {}, texts: {} });
  ok("audit: with no origin/main every missing version fails, as before", r.strict && r.own.length === 2 && !r.other.length, JSON.stringify(r));
  fs.rmSync(T, { recursive: true, force: true });
}
ok("it lists hook and agent paths, ids as sha1 hex", Object.keys(j.blobs).some((p) => p.startsWith("templates/hooks/")) && Object.keys(j.blobs).some((p) => p.startsWith("agents/")) &&
  Object.values(j.blobs).every((ids) => ids.length && ids.every((id) => /^[0-9a-f]{40}$/.test(id))));
ok("it keeps the past team file texts setup uses as .base", Object.keys(j.texts).includes("templates/teams/ROUTING.md") &&
  Object.entries(j.texts).every(([p, t]) => Object.keys(t).every((id) => j.blobs[p].includes(id))));
lib.summary();

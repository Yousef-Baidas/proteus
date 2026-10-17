// The plugin's release check (#136, D6): node tests/releasecheck.test.js (needs git; the signed cases also need
// ssh-keygen and skip without it). Under the plugin the autostart moves no checkout; it checks that the installed
// commit is a release tag the trusted key signed, against a bare clone in CLAUDE_PLUGIN_DATA that fetches tags at
// most once a day. Local bare remote, no network.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "templates", "hooks");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("releasecheck");
const { HOME } = lib;

// the plugin as the plugin manager installs it
const PLUG = path.join(W, "cache", "proteus", "1.0.0");
fs.mkdirSync(path.join(PLUG, "templates"), { recursive: true });
fs.cpSync(SRC, path.join(PLUG, "templates", "hooks"), { recursive: true });
fs.cpSync(path.join(ROOT, "skills"), path.join(PLUG, "skills"), { recursive: true });
const ENTRY = path.join(PLUG, "templates", "hooks", "proteus-plugin.js");
const DATA = path.join(W, "data");
const STATE = path.join(DATA, "release-check.json");
const RELEASES = path.join(DATA, "releases.git");

// the maintainer's repo and its bare remote, the plugin's marketplace
const BARE = path.join(W, "remote.git"), MAINT = path.join(W, "maint");
g(W, "init", "-q", "--bare", "-b", "main", BARE);
g(W, "clone", "-q", BARE, MAINT);
const commit = (file) => {
  fs.writeFileSync(path.join(MAINT, file), file + "\n");
  g(MAINT, "add", "-A"); g(MAINT, "commit", "-qm", file);
  return g(MAINT, "rev-parse", "HEAD");
};
const push = () => g(MAINT, "push", "-q", "origin", "HEAD:main", "--tags");

const PLUGINS = path.join(HOME, ".claude", "plugins");
fs.mkdirSync(PLUGINS, { recursive: true });
const market = (url) => fs.writeFileSync(path.join(PLUGINS, "known_marketplaces.json"), JSON.stringify({ proteus: { source: { source: "git", url }, installLocation: path.join(PLUGINS, "marketplaces", "proteus") } }));
const install = (sha) => fs.writeFileSync(path.join(PLUGINS, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: {
  "other@x": [{ scope: "user", installPath: path.join(W, "other"), gitCommitSha: "0".repeat(40) }],
  "proteus@proteus": [{ scope: "user", installPath: PLUG, version: "1.0.0", gitCommitSha: sha }],
} }));
market(BARE);

const repo = (name, gated) => {
  const d = path.join(W, name);
  fs.mkdirSync(path.join(d, ".claude"), { recursive: true });
  g(d, "init", "-q", "-b", "main");
  if (gated) fs.writeFileSync(path.join(d, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "proteus@proteus": true } }));
  return d;
};
const ON = repo("on", true), OFF = repo("off", false);
const start = (cwd, data = DATA) => lib.run(ENTRY, { hook_event_name: "SessionStart", source: "startup", session_id: "r1", cwd },
  { cwd, args: ["proteus-autostart.js"], env: { CLAUDE_PLUGIN_ROOT: PLUG, CLAUDE_PLUGIN_DATA: data } });
const state = () => JSON.parse(fs.readFileSync(STATE, "utf8"));
const stale = () => fs.writeFileSync(STATE, JSON.stringify({ ...state(), fetched: Date.now() - 25 * 3600e3 }));
const warning = (out) => out.split("\n").filter((l) => l.startsWith("proteus: WARNING: the installed plugin commit"));
const quiet = (out) => out.split("\n").filter((l) => l.startsWith("proteus: release check"));
const tagsIn = () => g(RELEASES, "tag", "-l").split("\n").filter(Boolean);

// gated out: nothing runs, so no output and no data dir
commit("a.txt");
install(g(MAINT, "rev-parse", "HEAD"));
let r = start(OFF, path.join(W, "data-off"));
ok("gated-out repo: no output, nothing fetched or written", r.code === 0 && !r.out && !fs.existsSync(path.join(W, "data-off")), r.out + r.err);

const signer = lib.sshSigner(path.join(W, "keys"));
const stranger = lib.sshSigner(path.join(W, "keys"), "stranger");
if (!signer || !stranger) console.log("skip: signed-tag cases (ssh-keygen missing or cannot sign here)");
else {
  // the user trusts the maintainer's key the README way
  fs.mkdirSync(path.join(HOME, ".config", "proteus"), { recursive: true });
  fs.copyFileSync(signer.allowed, path.join(HOME, ".config", "proteus", "allowed_signers"));
  const A = g(MAINT, "rev-parse", "HEAD"); signer.tag(MAINT, "v1.0.0");
  const B = commit("b.txt"); g(MAINT, "tag", "-a", "v1.1.0", "-m", "v1.1.0");
  const C = commit("c.txt"); stranger.tag(MAINT, "v1.2.0");
  const D = commit("d.txt");
  push();

  install(A);
  r = start(ON);
  ok("verified tag: silent, the result cached", r.code === 0 && /proteus autostart/.test(r.out) && !warning(r.out).length && !quiet(r.out).length &&
    state().sha === A && state().result.tag === "v1.0.0" && tagsIn().includes("v1.2.0"), r.out.slice(0, 1500) + r.err);

  install(B);
  r = start(ON);
  const w = warning(r.out);
  ok("unsigned tag: one loud line with the sha, the reason, the newest verified tag and the pin command",
    w.length === 1 && w[0].includes(B.slice(0, 12)) && /\(git verify-tag v1\.1\.0: no signature found\)/.test(w[0]) &&
    w[0].includes(`Newest verified release: v1.0.0; to pin to it, run claude plugin marketplace add ${BARE}#v1.0.0 && claude plugin install proteus@proteus && claude plugin update proteus@proteus`) && !quiet(r.out).length, r.out.slice(0, 1500));

  // the user settings name the marketplace (claude plugin marketplace add writes it): re-adding at a tag fails
  // until that entry goes, so the pin command removes it first
  const userSettings = path.join(HOME, ".claude", "settings.json");
  fs.writeFileSync(userSettings, JSON.stringify({ extraKnownMarketplaces: { proteus: { source: { source: "git", url: BARE } } } }));
  install(C);
  r = start(ON);
  ok("tag signed by the wrong key: one loud line naming the verify-tag failure", warning(r.out).length === 1 && /\(git verify-tag v1\.2\.0: /.test(warning(r.out)[0]) && /Newest verified release: v1\.0\.0/.test(r.out), r.out.slice(0, 1500));
  ok("pin command: removes the user settings' marketplace entry before re-adding it at the tag",
    warning(r.out)[0].includes(`run claude plugin marketplace remove proteus --scope user && claude plugin marketplace add ${BARE}#v1.0.0 && claude plugin install proteus@proteus && claude plugin update proteus@proteus`), r.out.slice(0, 1500));
  fs.rmSync(userSettings);

  install(D);
  r = start(ON);
  ok("sha on no tag: one loud line, never a block", r.code === 0 && warning(r.out).length === 1 && warning(r.out)[0].includes(`${D.slice(0, 12)} is not a verified Proteus release (no release tag points at it)`) && /proteus autostart/.test(r.out), r.out.slice(0, 1500));

  // the maintainer releases D; within 24 h of the last fetch the clone does not see it
  signer.tag(MAINT, "v1.3.0"); push();
  const fetched = state().fetched;
  r = start(ON);
  ok("24 h throttle: no fetch, the cached result stands", warning(r.out).length === 1 && !tagsIn().includes("v1.3.0") && state().fetched === fetched, r.out.slice(0, 1500));
  stale();
  r = start(ON);
  ok("past 24 h: fetches, verifies, silent", !warning(r.out).length && !quiet(r.out).length && tagsIn().includes("v1.3.0") && state().result.tag === "v1.3.0" && state().fetched > fetched, r.out.slice(0, 1500));

  // offline: the fetch fails; one quiet line and the cached result
  market(path.join(W, "gone.git"));
  stale();
  r = start(ON);
  ok("offline with a cached result: one quiet line, no warning", r.code === 0 && quiet(r.out).length === 1 && /could not fetch tags from .*gone\.git .*; using the last result$/.test(quiet(r.out)[0]) &&
    !warning(r.out).length && state().result.tag === "v1.3.0", r.out.slice(0, 1500));
  install(B);
  stale();
  r = start(ON);
  ok("offline, a new sha: checks the tags fetched before", quiet(r.out).length === 1 && quiet(r.out)[0].endsWith("checking the tags fetched before") && warning(r.out).length === 1 && /Newest verified release: v1\.3\.0/.test(r.out), r.out.slice(0, 1500));
  market(BARE);

  // a v1 checkout with autoUpdate: the plugin never moves it; the installer path still fast-forwards it
  const HSRC = path.join(W, "proteus");
  g(W, "clone", "-q", BARE, HSRC);
  g(HSRC, "checkout", "-q", "v1.0.0");
  g(HSRC, "checkout", "-q", "-b", "main-local");
  g(HSRC, "config", "gpg.ssh.allowedSignersFile", signer.allowed);
  fs.writeFileSync(path.join(HOME, ".claude", "proteus.json"), JSON.stringify({ home: HSRC, autoUpdate: true, lastFetch: Date.now(), toured: "" }));
  install(D);
  r = start(ON);
  ok("plugin: the checkout auto-update is off", g(HSRC, "rev-parse", "HEAD") === A && !/updat/.test(r.out.split("\n").filter((l) => l.startsWith("proteus:")).join("\n")) && !/proteus-update=/.test(r.out), r.out.slice(0, 1500));

  fs.mkdirSync(path.join(ON, ".claude", "skills", "proteus"), { recursive: true });
  fs.writeFileSync(path.join(ON, ".claude", "skills", "proteus", "SKILL.md"), "---\nname: proteus\n---\nSKILL BODY\n");
  const DATA2 = path.join(W, "data-installer");
  r = lib.run(path.join(SRC, "proteus-autostart.js"), { hook_event_name: "SessionStart", source: "startup", session_id: "r2", cwd: ON }, { cwd: ON, env: { CLAUDE_PLUGIN_DATA: DATA2 } });
  ok("installer mode unchanged: fast-forwards to the verified tag, no release check", g(HSRC, "rev-parse", "HEAD") === D && /proteus: updated to v1\.3\.0/.test(r.out) &&
    !warning(r.out).length && !quiet(r.out).length && !fs.existsSync(DATA2), r.out.slice(0, 1500) + r.err);
}

lib.summary();

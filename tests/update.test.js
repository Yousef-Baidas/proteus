// Release updates: node tests/update.test.js (needs git; the signed cases also need ssh-keygen and skip without it).
// The autostart with autoUpdate on moves the Proteus checkout only to the newest vX.Y.Z tag past HEAD, only by
// fast-forward, and only once `git verify-tag` accepts it; otherwise one note says why. Local bare remote, no network.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "templates", "hooks");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("update");
const { HOME } = lib;

// the maintainer's clone pushes to a bare remote; the user's Proteus checkout is a clone of it at v1.0.0
const BARE = path.join(W, "remote.git"), MAINT = path.join(W, "maint"), HSRC = path.join(W, "proteus");
g(W, "init", "-q", "--bare", "-b", "main", BARE);
g(W, "clone", "-q", BARE, MAINT);
fs.mkdirSync(path.join(MAINT, "agents"));
fs.writeFileSync(path.join(MAINT, "agents", "proteus-worker.md"), "worker v1\n");
fs.mkdirSync(path.join(MAINT, "templates"));
fs.cpSync(SRC, path.join(MAINT, "templates", "hooks"), { recursive: true });
const CHANGELOG = [
  "# Changelog", "", "## [Unreleased]", "- not yet", "",
  "## [1.3.0] - 2026-10-03", "- feat: three", "- feat: three, more", "",
  "## [1.2.0] - 2026-10-02", "- fix: two", "",
  "## [1.1.0] - 2026-10-01", "- feat: one", "### Fixed", "- a fix", "",
  "## [1.0.0] - 2026-09-30", "- first release", "",
].join("\n");
fs.writeFileSync(path.join(MAINT, "CHANGELOG.md"), "# Changelog\n\n## [1.0.0] - 2026-09-30\n- first release\n");
g(MAINT, "add", "-A"); g(MAINT, "commit", "-qm", "init"); g(MAINT, "tag", "-a", "v1.0.0", "-m", "v1.0.0");
g(MAINT, "push", "-q", "-u", "origin", "HEAD:main"); g(MAINT, "push", "-q", "origin", "v1.0.0");
g(W, "clone", "-q", BARE, HSRC);
const release = (msg, file, text, tagger) => {
  fs.writeFileSync(path.join(MAINT, file), text);
  g(MAINT, "add", "-A"); g(MAINT, "commit", "-qm", msg);
  tagger();
  g(MAINT, "push", "-q", "origin", "HEAD:main", "--tags");
  g(HSRC, "fetch", "-q", "--tags");
};

// a Proteus project to start sessions in
const REPO = path.join(W, "repo");
g(W, "init", "-q", "-b", "main", REPO);
fs.mkdirSync(path.join(REPO, ".claude", "skills", "proteus"), { recursive: true });
fs.writeFileSync(path.join(REPO, ".claude", "skills", "proteus", "SKILL.md"), "---\nname: proteus\n---\nSKILL BODY\n");
g(REPO, "add", "-A"); g(REPO, "commit", "-qm", "init");

const CFG = path.join(HOME, ".claude", "proteus.json");
const setCfg = (o = {}) => fs.writeFileSync(CFG, JSON.stringify({ home: HSRC, autoUpdate: true, lastFetch: Date.now(), toured: "", ...o }));
const cfg = () => JSON.parse(fs.readFileSync(CFG, "utf8"));
const start = () => lib.run(path.join(SRC, "proteus-autostart.js"), { hook_event_name: "SessionStart", source: "startup", session_id: "u1", cwd: REPO }, { cwd: REPO });
const head = () => g(HSRC, "rev-parse", "HEAD");
const stateLine = (out) => out.split("\n").find((l) => l.startsWith("proteus-state")) || "";
const worker = () => { try { return fs.readFileSync(path.join(HOME, ".claude", "agents", "proteus-worker.md"), "utf8"); } catch { return ""; } };

setCfg();
let r = start();
const v100 = head();
ok("no newer release: no update field, no update note", !/proteus-update=/.test(stateLine(r.out)) && !/proteus: (not )?updat/.test(r.out) && !("behind" in cfg()), r.out.slice(0, 800));

// an unsigned annotated tag is not applied
release("feat: one", "a.txt", "a\n", () => g(MAINT, "tag", "-a", "v1.1.0", "-m", "v1.1.0"));
r = start();
ok("unsigned tag: no update, one note with the reason and the manual way", head() === v100 &&
  /^proteus: not updating to v1\.1\.0: git verify-tag v1\.1\.0: no signature found\. To trust the maintainer's key see "Releases" in .*README\.md; or review the tag, then git -C ".*" merge --ff-only v1\.1\.0 and node ".*install\.js" --update$/m.test(r.out) &&
  /proteus-update=v1\.1\.0 \(node .*install\.js --update\)/.test(stateLine(r.out)) && cfg().behind === 1, r.out.slice(0, 1500));
setCfg({ autoUpdate: false });
r = start();
ok("autoUpdate off: the release shows on the state line, no note, nothing moves", head() === v100 && /proteus-update=v1\.1\.0/.test(stateLine(r.out)) && !/not updating/.test(r.out), r.out.slice(0, 800));
setCfg();

// a lightweight tag carries no signature
release("fix: two", "b.txt", "b\n", () => g(MAINT, "tag", "v1.2.0"));
r = start();
ok("lightweight tag: no update, says so", head() === v100 && /proteus: not updating to v1\.2\.0: v1\.2\.0 is a lightweight tag/.test(r.out) && cfg().behind === 2, r.out.slice(0, 1500));

const signer = lib.sshSigner(path.join(W, "keys"));
const stranger = lib.sshSigner(path.join(W, "keys"), "stranger");
if (!signer || !stranger) console.log("skip: signed-tag cases (ssh-keygen missing or cannot sign here)");
else {
  release("feat: three", "CHANGELOG.md", CHANGELOG, () => { fs.writeFileSync(path.join(MAINT, "agents", "proteus-worker.md"), "worker v2\n"); g(MAINT, "commit", "-qam", "worker v2"); signer.tag(MAINT, "v1.3.0"); });
  r = start();
  ok("signed tag, no allowed signers configured: no update", head() === v100 && /proteus: not updating to v1\.3\.0: git verify-tag v1\.3\.0: .*allowedSignersFile/.test(r.out), r.out.slice(0, 1500));
  g(HSRC, "config", "gpg.ssh.allowedSignersFile", stranger.allowed);
  r = start();
  ok("signed by a key the user does not trust: no update", head() === v100 && /proteus: not updating to v1\.3\.0: git verify-tag v1\.3\.0: /.test(r.out) && worker() === "worker v1\n", r.out.slice(0, 1500));
  g(HSRC, "config", "gpg.ssh.allowedSignersFile", signer.allowed);
  // the signed v1.3.0 tag object published again under a newer name
  g(HSRC, "tag", "v9.0.0", "refs/tags/v1.3.0");
  r = start();
  ok("a signed tag under another name: no update", head() === v100 && /proteus: not updating to v9\.0\.0: v9\.0\.0 points at a tag object made for another name/.test(r.out), r.out.slice(0, 1500));
  g(HSRC, "tag", "-d", "v9.0.0");
  fs.writeFileSync(path.join(HSRC, "CHANGELOG.md"), "local edit\n");
  r = start();
  ok("trusted signature, dirty checkout: nothing moves", head() === v100 && !/not updating|updated to/.test(r.out), r.out.slice(0, 1500));
  g(HSRC, "checkout", "-q", "--", ".");
  r = start();
  const L = r.out.split("\n");
  const at = L.findIndex((l) => l.startsWith("proteus: updated to v1.3.0"));
  ok("trusted signature: fast-forwarded to the tag, the changelog since v1.0.0 capped in the note", head() === g(HSRC, "rev-parse", "v1.3.0^{commit}") &&
    new RegExp(`^proteus: updated to v1\\.3\\.0 \\(${g(HSRC, "rev-parse", "--short", "HEAD")}\\) from v1\\.0\\.0, signature verified; CHANGELOG\\.md:$`).test(L[at] || "") &&
    L.slice(at + 1, at + 9).join("\n") === ["## [1.3.0] - 2026-10-03", "- feat: three", "- feat: three, more", "## [1.2.0] - 2026-10-02", "- fix: two", "## [1.1.0] - 2026-10-01", "- feat: one", "… 2 more lines in CHANGELOG.md"].map((l) => `  ${l}`).join("\n") &&
    !/Unreleased|first release/.test(r.out), r.out.slice(0, 1500));
  ok("trusted signature: hooks and agents re-synced, update cleared", worker() === "worker v2\n" && /proteus: synced \d+ files from/.test(r.out) && !/proteus-update=/.test(stateLine(r.out)) && !("behind" in cfg()), r.out.slice(0, 1500));
  r = start();
  ok("next start at the release: quiet", !/not updating|updated to|proteus-update=/.test(r.out), r.out.slice(0, 800));

  // a local commit in the checkout: the next release is no fast-forward from it
  fs.writeFileSync(path.join(HSRC, "local.txt"), "mine\n"); g(HSRC, "add", "-A"); g(HSRC, "commit", "-qm", "local");
  const mine = head();
  release("feat: four", "d.txt", "d\n", () => signer.tag(MAINT, "v1.4.0"));
  r = start();
  ok("signed release that does not contain HEAD: no update", head() === mine && /proteus: not updating to v1\.4\.0: v1\.4\.0 does not contain this checkout's HEAD/.test(r.out), r.out.slice(0, 1500));
}

lib.summary();

// Journal reading edges from #104: tailLines refusing a link or a FIFO, and the compaction recall never reading a
// journal through a linked state dir. Temp dirs only; no network.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "templates", "hooks");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("migrationedges");
const L = require(path.join(SRC, "proteus-lib.js"));
const posix = process.platform !== "win32";

(async () => {
  // ---- reading a journal: tailLines(regular) never follows a link or opens a FIFO
  if (posix) {
    const dir = path.join(W, "tail");
    fs.mkdirSync(dir, { recursive: true });
    const real = path.join(dir, "real.jsonl"), link = path.join(dir, "link.jsonl");
    fs.writeFileSync(real, '{"prompt":"x"}\n');
    fs.symlinkSync(real, link);
    ok("tailLines regular: a regular file is read", L.tailLines(real, 1024, true).length === 1);
    ok("tailLines regular: a link is not followed", L.tailLines(link, 1024, true).length === 0 && L.tailLines(link, 1024).length === 1);
    if (spawnSync("mkfifo", [path.join(dir, "pipe")]).status === 0) ok("tailLines regular: a FIFO is refused without blocking", L.tailLines(path.join(dir, "pipe"), 1024, true).length === 0);
  }

  // ---- compaction recall: a state dir that is a link is not read through
  if (posix) {
    const repo = path.join(W, "said");
    fs.mkdirSync(path.join(repo, ".claude", "skills", "proteus"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".claude", "skills", "proteus", "SKILL.md"), "---\nname: proteus\n---\nBODY\n");
    g(W, "init", "-q", "-b", "main", repo);
    const elsewhere = path.join(W, "elsewhere");
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.writeFileSync(path.join(elsewhere, "journal.jsonl"), JSON.stringify({ prompt: "from the linked dir" }) + "\n");
    fs.symlinkSync(elsewhere, path.join(repo, ".git", "proteus"));
    const r = lib.run(path.join(SRC, "proteus-autostart.js"), { hook_event_name: "SessionStart", source: "compact", session_id: "s1", cwd: repo }, { cwd: repo, env: { FAKE_GH: "fail" } });
    ok("recall: a journal in a linked state dir is not read", r.out.includes("BODY") && !r.out.includes("from the linked dir"), r.out.slice(0, 400) + r.err);
  }

  lib.summary();
})();

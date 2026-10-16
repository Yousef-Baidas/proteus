// Migration edges from #104: moveEntry naming a FIFO, socket or device it refuses, mergeLog capping the merged
// log (oldest lines dropped, a marker line says so; the cap is passed in, so no 8 MB file), and the compaction
// recall never reading a journal through a link. Temp dirs only; no network.
"use strict";
const fs = require("fs");
const net = require("net");
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
  // ---- moveEntry: a FIFO and a socket are refused by kind; a folder holding a link and a link still move
  {
    const repo = path.join(W, "mig");
    fs.mkdirSync(repo, { recursive: true });
    g(W, "init", "-q", "-b", "main", repo);
    const common = path.join(repo, ".git"), old = L.legacyStateDir(common), cur = L.stateDir(common);
    fs.mkdirSync(path.join(old, "dir"), { recursive: true });
    fs.writeFileSync(path.join(old, "dir", "a.txt"), "a\n");
    const outside = path.join(W, "outside.txt");
    fs.writeFileSync(outside, "outside\n");
    let links = false;
    try { fs.symlinkSync(outside, path.join(old, "dir", "in-link")); fs.symlinkSync(outside, path.join(old, "top-link")); links = true; } catch {}
    const fifo = posix && spawnSync("mkfifo", [path.join(old, "pipe")]).status === 0;
    let srv = null;
    if (posix) {
      srv = net.createServer();
      // a relative path: macOS caps a socket path at 104 bytes, and its temp dirs are long
      const was = process.cwd();
      process.chdir(old);
      try { await new Promise((res) => { srv.once("error", () => { srv = null; res(); }); srv.listen("sock", res); }); } finally { process.chdir(was); }
      try { if (srv && !fs.lstatSync(path.join(old, "sock")).isSocket()) throw new Error(); } catch { if (srv) srv.close(); srv = null; }
    }
    const res = L.migrateState(common, false);
    ok("migrate edges: a folder still moves whole", res.moved.includes("dir") && fs.readFileSync(path.join(cur, "dir", "a.txt"), "utf8") === "a\n", JSON.stringify(res));
    if (links) {
      ok("migrate edges: a link inside a moved folder stays a link", fs.lstatSync(path.join(cur, "dir", "in-link")).isSymbolicLink(), JSON.stringify(res));
      ok("migrate edges: a link is recreated, not followed", res.moved.includes("top-link") && fs.lstatSync(path.join(cur, "top-link")).isSymbolicLink() && fs.readFileSync(outside, "utf8") === "outside\n", JSON.stringify(res));
    }
    if (fifo) ok("migrate edges: a FIFO is refused by name and stays put", res.failed.some((f) => f.startsWith("pipe (a FIFO, never moved")) && fs.lstatSync(path.join(old, "pipe")).isFIFO() && !fs.existsSync(path.join(cur, "pipe")), JSON.stringify(res));
    if (srv) {
      ok("migrate edges: a socket is refused by name and stays put", res.failed.some((f) => f.startsWith("sock (a socket, never moved")) && fs.lstatSync(path.join(old, "sock")).isSocket() && !fs.existsSync(path.join(cur, "sock")), JSON.stringify(res));
      await new Promise((r) => srv.close(r));
    }
  }

  // ---- mergeLog: the merged log is capped; the oldest lines go first and a marker line says so
  {
    const dir = path.join(W, "merge");
    fs.mkdirSync(dir, { recursive: true });
    const s = path.join(dir, "old.jsonl"), d = path.join(dir, "cur.jsonl");
    const line = (p, i) => JSON.stringify({ prompt: `${p}${String(i).padStart(3, "0")}` });
    const put = (f, p, n) => fs.writeFileSync(f, Array.from({ length: n }, (_, i) => line(p, i) + "\n").join(""));
    const rows = () => fs.readFileSync(d, "utf8").split("\n").filter(Boolean);

    put(s, "old", 3); put(d, "new", 2);
    L.mergeLog(s, d, 4096);
    ok("mergeLog: under the cap every line merges, no marker", JSON.stringify(rows()) === JSON.stringify([line("old", 0), line("old", 1), line("old", 2), line("new", 0), line("new", 1)]) && !fs.existsSync(s), rows().join(" | "));

    put(s, "old", 40); put(d, "new", 5);
    const max = 600;
    L.mergeLog(s, d, max);
    const got = rows(), size = fs.statSync(d).size;
    const mark = (() => { try { return JSON.parse(got[0]); } catch { return {}; } })();
    ok("mergeLog: past the cap the result fits in it", size <= max, `${size} > ${max}`);
    ok("mergeLog: past the cap the first line is a marker naming the cap", typeof mark.merge_truncated === "string" && String(mark.note).includes(String(max)), got[0]);
    ok("mergeLog: past the cap the newest lines stay, in order, the current file's last", JSON.stringify(got.slice(-6)) === JSON.stringify([line("old", 39), ...[0, 1, 2, 3, 4].map((i) => line("new", i))]), got.join(" | "));
    ok("mergeLog: past the cap the oldest lines are the ones dropped", !got.includes(line("old", 0)) && got.length > 2, got.join(" | "));
    ok("mergeLog: the legacy log goes once merged", !fs.existsSync(s));

    // a legacy log far past the cap is read only from its end
    fs.writeFileSync(s, "x".repeat(5000) + "\n" + line("old", 7) + "\n");
    put(d, "new", 1);
    L.mergeLog(s, d, 200);
    const tail = rows();
    ok("mergeLog: a source past the cap is read from its end, with the marker", tail.length === 3 && JSON.parse(tail[0]).merge_truncated && tail[1] === line("old", 7) && tail[2] === line("new", 0), tail.join(" | "));

    // a line appended to the current file meanwhile is not lost: the pass aborts, both stay
    put(s, "old", 1); put(d, "new", 1);
    const was = fs.readFileSync(d, "utf8");
    const write = fs.writeFileSync;
    fs.writeFileSync = (f, ...a) => { const r = write(f, ...a); if (String(f).endsWith(".merge.tmp")) fs.appendFileSync(d, line("late", 0) + "\n"); return r; };
    let code = "";
    try { L.mergeLog(s, d, 4096); } catch (e) { code = e.code; } finally { fs.writeFileSync = write; }
    ok("mergeLog: an append during the merge aborts it, both files kept", code === "EAGAIN" && fs.existsSync(s) && fs.readFileSync(d, "utf8") === was + line("late", 0) + "\n" && !fs.readdirSync(dir).some((f) => f.endsWith(".tmp")), code);
  }

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

  // ---- compaction recall: a legacy state dir that is a link is not read through
  if (posix) {
    const repo = path.join(W, "said");
    fs.mkdirSync(path.join(repo, ".claude", "skills", "proteus"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".claude", "skills", "proteus", "SKILL.md"), "---\nname: proteus\n---\nBODY\n");
    g(W, "init", "-q", "-b", "main", repo);
    const elsewhere = path.join(W, "elsewhere");
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.writeFileSync(path.join(elsewhere, "journal.jsonl"), JSON.stringify({ prompt: "from the linked dir" }) + "\n");
    fs.mkdirSync(path.join(repo, ".git", "proteus"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git", "proteus", "journal.jsonl"), JSON.stringify({ prompt: "from the real file" }) + "\n");
    fs.symlinkSync(elsewhere, path.join(repo, ".git", "hive"));
    const r = lib.run(path.join(SRC, "proteus-autostart.js"), { hook_event_name: "SessionStart", source: "compact", session_id: "s1", cwd: repo }, { cwd: repo, env: { FAKE_GH: "fail" } });
    ok("recall: a journal in a linked state dir is not read", r.out.includes("from the real file") && !r.out.includes("from the linked dir"), r.out.slice(0, 400) + r.err);
  }

  lib.summary();
})();

#!/usr/bin/env node
// Container entrypoint (#80): runs inside the image proteus-container.js builds, never on the host. Clones
// /in/in.bundle into /work/repo on its one branch, runs `claude -p --permission-mode bypassPermissions --output-format
// json` there with /in/prompt.md on stdin and writes its stdout to /out/result.json, commits anything left
// uncommitted as "wip: uncommitted worker changes", and bundles the branch's new commits to /out/out.bundle.
// The host reads only that bundle, through its pinned git; the clone's config and hooks never leave the container.
// /in/run.json { model, ticket }: --model for claude; with a ticket, PROTEUS_REPORT=/out/report.md and one appended
// system-prompt line asking for the final report there (the host pushes, opens the PR and posts it). /in/agent.md: its
// body goes to --append-system-prompt and its disallowedTools to --disallowedTools; its model: is ignored. /in/hooks:
// the clone's core.hooksPath (read-only), with its owned list copied to .claude/proteus-owned and git-excluded there.
// PROTEUS_CONTAINER_TEST_ROOT maps /in, /out and /work to <root>/in, <root>/out and <root>/work, for tests only: the
// runner passes no env into the container but the credential's name.
// Always exits 0 once /out/status.json ({ exit, error, unchanged }) is written.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = process.env.PROTEUS_CONTAINER_TEST_ROOT;
const at = (d) => (ROOT ? path.join(ROOT, d) : `/${d}`);
const IN = at("in"), OUT = at("out"), WORK = at("work"), REPO = path.join(WORK, "repo");
// the worker owns the clone's config and hooks; this script's own git calls run neither
const SAFE = ["-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`, "-c", "core.fsmonitor=false"];
const read = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };

function git(args, cwd = REPO) {
  const r = spawnSync("git", [...SAFE, ...args], { cwd, encoding: "utf8", windowsHide: true, timeout: 600000, maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0) throw new Error(`git ${args[0]}: ${String(r.stderr || (r.error && r.error.message) || "").trim().split("\n").pop()}`);
  return r.stdout.trim();
}

// an agent file's prompt body and its disallowedTools (a block or inline list)
function agentOf(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text.replace(/^\uFEFF/, ""));
  if (!m) return { body: text.trim(), tools: [] };
  const lines = m[1].split(/\r?\n/), i = lines.findIndex((l) => /^disallowedTools:/.test(l));
  const tools = [];
  if (i >= 0) {
    const inline = lines[i].replace(/^disallowedTools:\s*/, "").replace(/^\[|\]$/g, "").trim();
    if (inline) tools.push(...inline.split(","));
    for (const l of lines.slice(i + 1)) { const b = /^\s+-\s*(.+?)\s*$/.exec(l); if (!b) break; tools.push(b[1]); }
  }
  return { body: m[2].trim(), tools: tools.map((t) => t.trim().replace(/^(["'])(.*)\1$/, "$2")).filter(Boolean) };
}

function main() {
  const status = { exit: null, error: null, unchanged: false };
  try {
    const bundle = path.join(IN, "in.bundle");
    const heads = git(["bundle", "list-heads", bundle], WORK).split("\n").map((l) => /^([0-9a-f]{40,64}) refs\/heads\/(\S+)$/.exec(l.trim())).filter(Boolean);
    if (heads.length !== 1) throw new Error(`in.bundle holds ${heads.length} branches, not one`);
    const [, base, branch] = heads[0];
    git(["clone", "-q", "--branch", branch, bundle, REPO], WORK);
    try { git(["config", "user.email"]); } catch { git(["config", "user.name", "Proteus worker"]); git(["config", "user.email", "proteus-worker@localhost"]); }

    const hooks = path.join(IN, "hooks"), owned = read(path.join(hooks, "proteus-owned"));
    if (owned !== null) {
      fs.mkdirSync(path.join(REPO, ".claude"), { recursive: true });
      fs.writeFileSync(path.join(REPO, ".claude", "proteus-owned"), owned);
      fs.mkdirSync(path.join(REPO, ".git", "info"), { recursive: true });
      fs.appendFileSync(path.join(REPO, ".git", "info", "exclude"), "\n/.claude/proteus-owned\n");
      git(["config", "core.hooksPath", hooks.replace(/\\/g, "/")]);
    }

    let run = {};
    try { run = JSON.parse(read(path.join(IN, "run.json")) || "{}") || {}; } catch {}
    const args = ["-p", "--permission-mode", "bypassPermissions", "--output-format", "json"], sys = [], env = { ...process.env };
    if (typeof run.model === "string" && run.model) args.push("--model", run.model);
    const agent = read(path.join(IN, "agent.md")), a = agent === null ? null : agentOf(agent);
    if (a && a.body) sys.push(a.body);
    if (/^[1-9]\d*$/.test(String(run.ticket || ""))) {
      env.PROTEUS_REPORT = path.join(OUT, "report.md");
      sys.push(`Write your final report (the DONE, BLOCKED, RED, NEEDS or CONTRACT-UNCLEAR comment body, first line \`<STATUS> #${run.ticket} ...\`) to ${env.PROTEUS_REPORT} ($PROTEUS_REPORT), not to GitHub: you have no GitHub access here; the host pushes your branch, opens the PR and posts the report.`);
    }
    if (sys.length) args.push("--append-system-prompt", sys.join("\n\n"));
    if (a && a.tools.length) args.push("--disallowedTools", a.tools.join(","));
    const c = spawnSync("claude", args,
      { cwd: REPO, env, input: fs.readFileSync(path.join(IN, "prompt.md")), windowsHide: true, maxBuffer: 256 << 20, stdio: ["pipe", "pipe", "inherit"] });
    status.exit = c.status;
    if (c.error) status.error = `claude: ${c.error.message}`;
    fs.writeFileSync(path.join(OUT, "result.json"), c.stdout || "");

    git(["add", "-A"]);
    if (spawnSync("git", [...SAFE, "diff", "--cached", "--quiet"], { cwd: REPO, windowsHide: true, timeout: 600000 }).status === 1) git(["commit", "-q", "-m", "wip: uncommitted worker changes"]);
    const tip = git(["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
    if (tip === base) status.unchanged = true;
    else git(["bundle", "create", "-q", path.join(OUT, "out.bundle"), `refs/heads/${branch}`, `^${base}`]);
  } catch (e) {
    status.error = [status.error, e.message].filter(Boolean).join("; ");
  }
  try { fs.writeFileSync(path.join(OUT, "status.json"), JSON.stringify(status) + "\n"); } catch {}
  return 0;
}

if (require.main === module) process.exitCode = main();

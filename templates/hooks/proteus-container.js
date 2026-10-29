#!/usr/bin/env node
// Container runner (#80): one Claude Code worker session in a container that never sees the host's .git.
//   node <hooks>/proteus-container.js run --worktree <dir> --prompt-file <file> [--model <id>] [--agent <name>]
//        [--ticket <n> --base <branch>] [--image <name>] [--runtime docker|podman]
//        [--memory 4g] [--cpus 2] [--pids 512] [--network <name>] [--timeout <min>] [--queue-timeout <min>]
//   node <hooks>/proteus-container.js check --worktree <dir> --ref <sha> [--image <name>] [--runtime docker|podman]
//        [--memory 4g] [--cpus 2] [--pids 512] [--network <name>] [--timeout <min>] [--queue-timeout <min>] -- <command...>
//   node <hooks>/proteus-container.js build [--image <name>] [--runtime docker|podman]
//   node <hooks>/proteus-container.js doctor [--image <name>] [--runtime docker|podman]
// run: bundles the worktree's branch (lib's pinned git on the trusted common dir, #215) into a fresh 0700 dir under
// <common>/proteus/scratch, then starts the image with only that bundle and the prompt read-only at /in and an empty
// /out: every capability dropped, no new privileges, a read-only root, tmpfs /tmp, /work and home, the node user,
// pids, memory and cpu caps, and the credential passed by name, never by value. GH_TOKEN and GITHUB_TOKEN never reach
// the runtime. proteus-container-entry.js clones the bundle, runs `claude -p` with bypassPermissions and bundles the
// branch's new commits to /out. Back on the host only that bundle is read, through the pinned git: verified, fetched
// with no tags and one fixed refspec into refs/proteus-container/<id>, and the branch moved there with update-ref
// only when its old tip is an ancestor and every changed path is owned (.claude/proteus-owned, as read before the
// run, matched by lib.ownedMatch as proteus-owned-check.js --staged; a .git*, .claude, .codex or .agents segment at
// any depth only when an owned entry names that segment). A clean worktree's files follow (read-tree -m -u old new);
// a dirty one is left, with the command that brings them along.
// result.json and status.json stay in the scratch dir; the bundles are removed.
// --worktree is a linked worktree, never the main checkout.
// --model and --agent (its file from the project's .claude/agents, the user's, then the plugin's agents/, copied to
// in/agent.md) reach claude through in/run.json; an unknown agent dies before the container starts. in/hooks holds
// the worktree's commit checks (pre-commit, commit-msg, the scripts they call, the owned list) for the clone.
// --ticket <n> --base <branch> publish after a good import: out/report.md (a regular UTF-8 file of at most 64 KiB whose
// first line is `<STATUS> #<n>`, else RED), the branch pushed by its one refspec, a PR on DONE whose Closes, Owned: and
// Tier: lines come first from the host, and the report posted on the ticket, gh as the agents. The last stdout line
// is then `<STATUS> #<n> sent` (exit 0) or `RED #<n> container: <reason>` (exit 1), whatever was thrown.
// check: runs <command...> on <sha> (a commit reachable from the worktree's branch) in the same hardened container,
// with no credential env at all and --network none unless given. The verdict is the runtime's exit status, which is
// the entry's, which is the command's (124 on its timeout, 125 when the entry failed first): the last line is
// `CHECK <sha12> exit <n>` or `CHECK <sha12> timed out`. out/check.log (stdout and stderr, at most 1 MiB each) is data
// the code under test can write; its path is printed only when it lstat's as a regular file under its cap.
// out/status.json is informational and never read. Nothing is imported or pushed and no git ref is created.
// Exit 0 when the command exited 0, else 1; 2 usage.
// The cap: run and check each hold a slot while their container runs, <common>/proteus-lead/containers/slot-<i> for i
// in 1..N (AGENTS.md `containers: <n>`, default 2, clamped to 1..8), made exclusively through lib.leadCreate and holding
// the pid and start time. A slot whose pid is dead is reclaimed. With none free, it polls every 5 s up to
// --queue-timeout (default 30 min), then dies. The slot goes in finally, and on SIGINT and SIGTERM.
// build: builds templates/container/Dockerfile with the entrypoint. doctor: runtime, rootless, image, credential.
// Exit 0 imported, nothing to import, published, built or doctor clean; 1 refused or failed (reason on stderr); 2 usage.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const lib = require(path.join(__dirname, "proteus-lib.js"));

const ENTRY = "proteus-container-entry.js";
const IMAGE = "proteus-worker";
const CREDS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"];
// dropped from the runtime's env, so no -e can hand one to the container
const GH_ENV = ["GH_TOKEN", "GITHUB_TOKEN"];
const FALLBACK = "run this worker without the container, in its worktree as usual (docs/container.md)";
const REPORT_MAX = 64 << 10;
const STATUSES = ["DONE", "BLOCKED", "RED", "NEEDS", "CONTRACT-UNCLEAR"];
// check's cap: each of the command's streams in check.log, plus a truncation note each
const STREAM_MAX = 1 << 20;
const LOG_MAX = 2 * STREAM_MAX + 4096;
// the entry's exit when the command ran past --timeout, and when the entry failed before running it
const TIMED_OUT = 124, ENTRY_FAILED = 125;
const MAX_SLOTS = 8, POLL_MS = 5000;
const USAGE = "usage: node proteus-container.js run --worktree <dir> --prompt-file <file> [options] | check --worktree <dir> --ref <sha> [options] -- <command...> | build [--image <name>] | doctor";
const HELP = `${USAGE}
Runs one Claude Code worker session in a container that never sees the host's .git:
  run      bundle the worktree's branch, run claude -p (bypassPermissions) on it in the container, and
           fast-forward the branch to what comes back when every changed path is owned
  check    run <command...> on --ref's commit in the container, with no credential and no network; prints
           check.log's path and the last line "CHECK <sha12> exit <n>" (or "timed out"); imports nothing
  build    build the image (templates/container/Dockerfile: node:22-slim, git, Claude Code)
  doctor   the runtime, whether it is rootless, the image, the credential env var
Options:
  --worktree <dir>     the worker's worktree; its .claude/proteus-owned lists what the result may change
  --prompt-file <file> the worker's prompt
  --model <id>         claude --model; required with --ticket
  --agent <name>       the agent whose prompt and disallowedTools the session gets (its model: is ignored)
  --ticket <n> --base <branch>
                       publish: push the branch, open its PR into <branch> on DONE, post out/report.md on #<n>;
                       the last line is "<STATUS> #<n> sent" (exit 0) or "RED #<n> container: <reason>" (exit 1)
  --image <name>       default ${IMAGE}; a project's own image built FROM it adds toolchains
  --runtime <name>     docker or podman; default podman when found (rootless), else docker
  --memory 4g  --cpus 2  --pids 512   the container's caps
  --ref <sha>          check: the commit to check out (detached); reachable from the worktree's branch
  --network <name>     the container's network; default the runtime's (open egress), none for check
  --timeout <min>      wall clock before the container is killed; default 60
  --queue-timeout <min> how long to wait for a free slot (AGENTS.md containers: <n>, default 2); default 30
Credential: CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY in the env, passed by name. No GitHub token.
Exit 0 imported or nothing to import (and published, with --ticket); 1 refused or failed; 2 usage.
check: exit 0 when the command exited 0, 1 otherwise, 2 usage.`;

const FLAGS = { "--worktree": "worktree", "--prompt-file": "prompt", "--image": "image", "--runtime": "runtime", "--memory": "memory", "--cpus": "cpus", "--pids": "pids", "--network": "network", "--timeout": "timeout", "--queue-timeout": "queue",
  "--model": "model", "--agent": "agent", "--ticket": "ticket", "--base": "base", "--ref": "ref" };
const CAPS = ["image", "runtime", "memory", "cpus", "pids", "network", "timeout", "queue"];
const ALLOWED = { run: [...CAPS, "worktree", "prompt", "model", "agent", "ticket", "base"], check: [...CAPS, "worktree", "ref"], build: ["image", "runtime"], doctor: ["image", "runtime"] };
const CHECKS = {
  runtime: [/^(?:docker|podman)$/, "docker or podman"],
  image: [/^[A-Za-z0-9][\w./:@-]*$/, "an image name"],
  memory: [/^[1-9]\d*[bkmg]?$/i, "a size such as 4g"],
  cpus: [/^(?:\d+(?:\.\d+)?)$/, "a number such as 2"],
  pids: [/^[1-9]\d*$/, "a whole number"],
  network: [/^[A-Za-z0-9][\w.-]*$/, "a network name"],
  timeout: [/^(?:\d+(?:\.\d+)?)$/, "minutes"],
  queue: [/^(?:\d+(?:\.\d+)?)$/, "minutes"],
  model: [/^[A-Za-z0-9][\w.:@/[\]-]*$/, "a model id"],
  agent: [/^(?:proteus:)?[A-Za-z0-9][\w-]*$/, "an agent name"],
  ticket: [/^[1-9]\d*$/, "an issue number"],
  base: [/^(?!.*\.\.)\w[\w./-]*$/, "a branch name"],
  ref: [/^[0-9a-f]{7,64}$/i, "a commit sha"],
};
// a segment git or a host agent session acts on, at any depth: a .git* name (.gitattributes, .gitmodules, a nested
// .git) or an agent config dir (.claude, .codex, .agents: host sessions load nested skills and hooks from them)
const SPECIAL_SEG = (s) => /^\.git/i.test(s) || /^\.(?:claude|codex|agents)$/i.test(s);
const specials = (rel) => String(rel).replace(/\\/g, "/").split("/").filter(SPECIAL_SEG);
const SPECIAL = (rel) => specials(rel).length > 0;
// an owned entry lets a special path through only when it matches the path and names each of its special segments
const specialOwned = (e, rel) => lib.ownedMatch(e, rel) && specials(rel).every((p) => specials(e).some((s) => lib.ownedMatch(s, p)));
// what reaches the lead's output from a file the container wrote or a path it named: no control character
const plain = (s) => String(s).replace(/\p{Cc}/gu, "");

class Stop extends Error { constructor(msg, code) { super(msg); this.code = code; } }
const die = (msg, code = 1) => { throw new Stop(msg, code); };

function parse(argv) {
  const [cmd, ...args] = argv;
  if (!Object.keys(ALLOWED).includes(cmd)) die(`${USAGE}\n(--help explains each command)`, 2);
  const o = { cmd, image: IMAGE, memory: "4g", cpus: "2", pids: "512", timeout: "60", queue: "30" };
  // check's command is everything after --, passed as argv
  const dash = args.indexOf("--"), rest = dash < 0 ? args : args.slice(0, dash);
  if (dash >= 0) o.command = args.slice(dash + 1);
  for (let i = 0; i < rest.length; i += 2) {
    const k = FLAGS[rest[i]];
    if (!k || rest[i + 1] === undefined) die(`${USAGE}\n${rest[i]}: unknown or missing its value`, 2);
    if (!ALLOWED[cmd].includes(k)) die(`${USAGE}\n${rest[i]} is not a ${cmd} option`, 2);
    o[k] = rest[i + 1];
  }
  if (cmd === "check" && (!o.worktree || !o.ref || !o.command || !o.command.length)) die(`${USAGE}\ncheck needs --worktree, --ref and a command after --`, 2);
  if (cmd !== "check" && o.command) die(`${USAGE}\n-- <command...> is for check only`, 2);
  for (const [k, [re, what]] of Object.entries(CHECKS)) if (o[k] !== undefined && !re.test(o[k])) die(`--${k} ${o[k]}: not ${what}`, 2);
  if (!(+o.cpus > 0) || !(+o.timeout > 0)) die("--cpus and --timeout must be above 0", 2);
  if (cmd === "run" && (!o.worktree || !o.prompt)) die(`${USAGE}\nrun needs --worktree and --prompt-file`, 2);
  if (!o.ticket !== !o.base) die("--ticket and --base go together", 2);
  if (o.ticket && !o.model) die("--ticket needs --model", 2);
  return o;
}

// name's executable on env's PATH (PATHEXT on win32), else null
function which(name, env = process.env) {
  const win = process.platform === "win32";
  const dirs = String(env.PATH || env.Path || "").split(win ? ";" : ":").filter(Boolean);
  const exts = win ? String(env.PATHEXT || ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
  for (const d of dirs) for (const x of exts) {
    const p = path.join(d, name + x);
    try { if (fs.statSync(p).isFile() && (win || (fs.accessSync(p, fs.constants.X_OK), true))) return p; } catch {}
  }
  return null;
}
// { name, bin }: want when given, else podman (rootless) before docker; null when none is found
function findRuntime(want, env = process.env) {
  for (const name of want ? [want] : ["podman", "docker"]) { const bin = which(name, env); if (bin) return { name, bin }; }
  return null;
}
function needRuntime(want) {
  return findRuntime(want) || die(`${want ? `${want} is` : "no container runtime (podman or docker) is"} not on PATH; ${FALLBACK}`);
}

// the runtime's env: the caller's, less any GitHub token (the host pushes; the container never can); check drops the
// credentials too
function childEnv(env = process.env, drop = GH_ENV) {
  const out = { ...env };
  for (const k of Object.keys(out)) if (drop.includes(k.toUpperCase())) delete out[k];
  return out;
}
const credential = (env = process.env) => CREDS.find((k) => env[k]) || "";

// `<runtime> run` argv. o: name, image, memory, cpus, pids, network, cred (a NAME, or "" for none), in, out (host dirs)
function runArgs(rt, o) {
  const mount = (src, dst, ro) => {
    // --mount splits on commas, and a quote starts csv quoting
    if (/[,"]/.test(src)) die(`${plain(src)}: a comma or quote in this path breaks --mount; use a checkout path without one`);
    return ["--mount", `type=bind,source=${src},target=${dst}${ro ? ",readonly" : ""}`];
  };
  const tmpfs = (dst) => ["--tmpfs", `${dst}:rw,exec,nosuid,nodev,mode=1777`];
  return ["run", "--rm", "--name", o.name,
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only",
    ...tmpfs("/tmp"), ...tmpfs("/work"), ...tmpfs("/home/node"),
    "--pids-limit", o.pids, "--memory", o.memory, "--cpus", o.cpus,
    "--user", "node", ...(rt.name === "podman" ? ["--userns", "keep-id"] : []),
    ...(o.network ? ["--network", o.network] : []),
    ...mount(o.in, "/in", true), ...mount(o.out, "/out", false),
    ...(o.cred ? ["-e", o.cred] : []), o.image];
}

// a regular file the container wrote, never through a link; null otherwise
function regular(file, max = 0) {
  try { const st = fs.lstatSync(file); return st.isFile() && (!max || st.size <= max) ? st : null; } catch { return null; }
}

// a fresh 0700 dir under <common>/proteus/scratch (lib.scratchDir) holding in/ (the bundle and run's prompt, readable
// by the container's user) and out/ (writable by it: the 0700 parent keeps every other host user out)
function prepare(common, prompt = "") {
  const root = lib.scratchDir(common);
  fs.mkdirSync(root, { recursive: true });
  for (const d of [lib.stateDir(common), root]) if (!fs.lstatSync(d).isDirectory()) die(`${d} is not a real directory (a link); nothing written through it`);
  const dir = fs.mkdtempSync(path.join(root, "container-"));
  const inDir = path.join(dir, "in"), outDir = path.join(dir, "out");
  fs.mkdirSync(inDir);
  fs.mkdirSync(outDir);
  if (prompt) { fs.copyFileSync(prompt, path.join(inDir, "prompt.md")); fs.chmodSync(path.join(inDir, "prompt.md"), 0o644); }
  fs.chmodSync(dir, 0o700);
  fs.chmodSync(inDir, 0o755);
  fs.chmodSync(outDir, 0o777);
  return { dir, id: path.basename(dir).slice("container-".length), inDir, outDir };
}
// the plugin's agents/: beside this file's templates/ (checkout, plugin); from a copy elsewhere (install.js --sandbox's
// bin), the proteus@proteus install's (lib.installedEntry: this project's, else the user-scope one); [] when none
function pluginAgents(lead) {
  if (path.basename(path.dirname(__dirname)) === "templates") return [path.join(__dirname, "..", "..", "agents")];
  const e = lib.installedEntry(lead, process.env.CLAUDE_PLUGIN_ROOT || "");
  return e && typeof e.installPath === "string" && e.installPath ? [path.join(path.resolve(e.installPath), "agents")] : [];
}
// the agent's file as the lead's Agent tool finds it: the project's .claude/agents, the user's, then the plugin's;
// dies when none has it
function agentFile(co, name) {
  const lead = lib.mainRoot(co.common) || co.root, n = lib.agentName(name);
  const dirs = [path.join(lead, ".claude", "agents"), path.join(lib.claudeDir(), "agents"), ...pluginAgents(lead)];
  return dirs.map((d) => path.join(d, `${n}.md`)).find((f) => regular(f, 1 << 20)) || die(`--agent ${name}: no ${n}.md in ${dirs.join(", ")}`);
}

// in/hooks for the container's clone: the worktree's commit checks (proteus-worktree.js installs the same pair), the
// scripts they call (this file's siblings) and the owned list as read before the run. The entry points the clone's
// core.hooksPath here, read-only; the host's import re-checks everything whatever ran inside.
const HOOK = (body) => `#!/bin/sh\nd=$(dirname "$0")\nexport PROTEUS_HARNESS=claude\n${body}`;
function copyHooks(inDir, owned) {
  const dir = path.join(inDir, "hooks");
  fs.mkdirSync(dir);
  for (const f of fs.readdirSync(__dirname)) if (/\.js$|^package\.json$/.test(f) && regular(path.join(__dirname, f))) fs.copyFileSync(path.join(__dirname, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, "pre-commit"), HOOK(`node "$d/proteus-owned-check.js" --staged || exit 1\nnode "$d/proteus-tier.js" --staged "$d/proteus-worktree.js" || exit 1\n`));
  fs.writeFileSync(path.join(dir, "commit-msg"), HOOK(`exec node "$d/commit-msg.js" "$1"\n`));
  fs.writeFileSync(path.join(dir, "proteus-owned"), owned);
  for (const f of fs.readdirSync(dir)) fs.chmodSync(path.join(dir, f), /^(pre-commit|commit-msg)$/.test(f) ? 0o755 : 0o644);
  fs.chmodSync(dir, 0o755);
}

function dropBundles(s) {
  for (const f of [path.join(s.inDir, "in.bundle"), path.join(s.outDir, "out.bundle")]) try { fs.rmSync(f, { force: true }); } catch {}
}

// --worktree: a linked worktree of this project's repo, never the main checkout, on a branch; dies otherwise
function workerCheckout(worktree) {
  const wt = path.resolve(worktree);
  const co = lib.checkoutOf(wt);
  if (!co || !lib.samePath(co.root, lib.realOr(wt))) die(`${wt} is not a worktree of this project's repo (run from the project, naming the worktree's root)`);
  if (co.gitDir === co.common) die(`${wt} is the main checkout; the runner takes a worker's linked worktree (proteus-worktree.js makes one)`);
  const branch = lib.branchOf(wt), base = lib.headOf(wt);
  if (!branch || !/^[\w][\w./-]*$/.test(branch) || !base) die(`${wt} has no branch checked out (or an unusual branch name)`);
  return { wt, co, branch, base };
}

// the cap: AGENTS.md `containers: <n>`, how many run or check containers at once; default 2, clamped to 1..8
function slotCount(root) {
  const n = parseInt(lib.agentsLine(root, "containers") || "", 10);
  return Number.isFinite(n) ? Math.min(MAX_SLOTS, Math.max(1, n)) : 2;
}
// EPERM: alive, another user's (process.kill(pid, 0) checks the same way on Windows)
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
// a free slot under <common>/proteus-lead/containers, made exclusively (lib.leadCreate: never through a link); a slot
// whose pid is dead is reclaimed. Polls every 5 s until --queue-timeout, then dies. Returns the release, which also
// runs on exit and on SIGINT and SIGTERM (Node runs those once the runtime's synchronous run returns).
function takeSlot(co, queue) {
  const n = slotCount(lib.mainRoot(co.common) || co.root), dir = lib.leadPath(co.common, "containers");
  const end = Date.now() + Math.round(+queue * 60000), mine = JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + "\n";
  for (let told = false; ; told = true) {
    for (let i = 1; i <= n; i++) {
      const f = path.join(dir, `slot-${i}`);
      if (lib.leadCreate(co.common, f, mine)) return release(co.common, f);
      // an unreadable or half-written slot is held: only a pid known dead frees it
      const held = lib.readUntrustedJSON(f, {}, 4096);
      if (Number.isInteger(held.pid) && held.pid > 0 && !alive(held.pid)) {
        lib.leadRemove(co.common, f);
        if (lib.leadCreate(co.common, f, mine)) return release(co.common, f);
      }
    }
    if (Date.now() >= end) die(`no free container slot after ${queue} min: ${n} in use (${dir}). Wait for one to finish, raise \`containers: <n>\` in AGENTS.md (at most ${MAX_SLOTS}), or pass a longer --queue-timeout`);
    if (!told) console.log(`container: all ${n} slots in use; waiting up to ${queue} min for one`);
    sleep(Math.min(POLL_MS, end - Date.now()));
  }
}
function release(common, f) {
  let done = false;
  const free = () => { if (!done) { done = true; try { lib.leadRemove(common, f); } catch {} } };
  process.once("exit", free);
  for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => { free(); process.exit(128 + os.constants.signals[sig]); });
  return free;
}

function runCmd(o) {
  const { wt, co, branch, base } = workerCheckout(o.worktree);
  // read once, before the run: the import checks against this copy, whatever happens to the file meanwhile
  let owned;
  try { owned = fs.readFileSync(lib.ownedFile(wt), "utf8"); }
  catch { die(`${wt} has no readable ${path.relative(wt, lib.ownedFile(wt))}, so nothing the container returns could be checked; run proteus-worktree.js on it first`); }
  const entries = owned.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const tier = lib.TIER_LINE.exec(owned);
  if (!regular(path.resolve(o.prompt))) die(`${o.prompt}: not a regular file`);
  const agent = o.agent ? agentFile(co, o.agent) : "";
  const rt = needRuntime(o.runtime);
  const cred = credential();
  if (!cred) die(`neither ${CREDS.join(" nor ")} is set; set one in the env (it reaches the container by name only), or ${FALLBACK}`);

  const g = (args, x = {}) => lib.gitTry(co.common, args, { timeout: 600000, ...x });
  const free = takeSlot(co, o.queue);
  const s = prepare(co.common, path.resolve(o.prompt));
  try {
    copyHooks(s.inDir, owned);
    const put = (f, write) => { write(path.join(s.inDir, f)); fs.chmodSync(path.join(s.inDir, f), 0o644); };
    put("run.json", (f) => fs.writeFileSync(f, JSON.stringify({ model: o.model, ticket: o.ticket }) + "\n"));
    if (agent) put("agent.md", (f) => fs.copyFileSync(agent, f));
    const inBundle = path.join(s.inDir, "in.bundle");
    let r = g(["bundle", "create", inBundle, `refs/heads/${branch}`]);
    if (!r.ok) die(`cannot bundle ${branch}: ${r.err}`);
    fs.chmodSync(inBundle, 0o644);
    const name = `proteus-${s.id}`;
    console.log(`container: ${rt.name} running ${o.image} on ${branch} at ${base.slice(0, 12)} (${name}, timeout ${o.timeout} min)`);
    const run = lib.spawnArgv(rt.bin, runArgs(rt, { ...o, name, cred, in: s.inDir, out: s.outDir }),
      { env: childEnv(), stdio: ["ignore", "inherit", "inherit"], timeout: Math.round(+o.timeout * 60000) });
    if (run.error && run.error.code === "ETIMEDOUT") {
      lib.spawnArgv(rt.bin, ["kill", name], { env: childEnv(), stdio: "ignore", timeout: 60000 });
      die(`timed out after ${o.timeout} min; killed ${name}. Nothing imported; ${branch} is unchanged`);
    }
    if (run.error) die(`${rt.name} did not start: ${run.error.message}`);
    if (run.status !== 0) die(`${rt.name} run exited ${run.status}${run.signal ? ` (${run.signal})` : ""}; nothing imported. Is the image built (\`node ${path.basename(__filename)} doctor\`)?`);
    const moved = importResult(co, wt, branch, base, s, g, entries);
    if (!o.ticket) return 0;
    return publish(o, wt, branch, s, g, { entries, tier: tier ? `${tier[1]}${tier[2] ? " (human)" : ""}` : "standard" }, moved);
  } finally {
    dropBundles(s);
    free();
  }
}

function importResult(co, wt, branch, base, s, g, entries) {
  const status = regular(path.join(s.outDir, "status.json"), 1 << 20) ? lib.readJSON(path.join(s.outDir, "status.json"), {}) : {};
  console.log(`container: worker exited ${plain(status.exit)}${status.error ? `, error: ${plain(status.error).slice(0, 300)}` : ""}; result.json and status.json in ${s.outDir}`);
  const bundle = path.join(s.outDir, "out.bundle");
  if (!fs.existsSync(bundle) && status.unchanged === true) { console.log(`container: no new commits; ${branch} is unchanged`); return false; }
  if (!regular(bundle)) die("no out.bundle (or not a regular file); nothing imported");
  let r = g(["bundle", "verify", "-q", bundle]);
  if (!r.ok) die(`out.bundle does not verify: ${plain(r.err)}`);
  const ref = `refs/proteus-container/${s.id}`;
  r = g(["-c", "fetch.fsckObjects=true", "fetch", "-q", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", bundle, `refs/heads/${branch}:${ref}`]);
  if (!r.ok) die(`cannot fetch ${branch} from out.bundle: ${plain(r.err)}`);
  const sha = g(["rev-parse", "--verify", "-q", `${ref}^{commit}`]).out;
  const keep = `; the result stays at ${ref}`;
  if (!sha) die(`${ref} is not a commit${keep}`);
  if (sha === base) { g(["update-ref", "-d", ref]); console.log(`container: no new commits; ${branch} is unchanged`); return false; }
  if (!g(["merge-base", "--is-ancestor", base, sha]).ok) die(`refused: ${sha.slice(0, 12)} does not descend from ${branch}'s ${base.slice(0, 12)} (rewritten history)${keep}`);
  r = g(["diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", base, sha]);
  if (!r.ok) die(`cannot diff ${base.slice(0, 12)}..${sha.slice(0, 12)}: ${plain(r.err)}${keep}`);
  const paths = r.out.split("\0").filter(Boolean);
  const list = path.relative(wt, lib.ownedFile(wt)).split(path.sep).join("/");
  const bad = paths.map((p) => {
    if (lib.isOwnedList(wt, p)) return `${p} is the owned-path list itself, which only the lead writes`;
    if (lib.isOwnedRecord(p)) return `${p} is a ticket's owned-path record, which only the lead writes`;
    if (!entries.some((e) => lib.ownedMatch(e, p))) return `${p} is not in ${list}`;
    return SPECIAL(p) && !entries.some((e) => specialOwned(e, p)) ? `${p} is a .git*, .claude, .codex or .agents path no owned entry names` : "";
  }).filter(Boolean);
  if (bad.length) die(`refused: the result changes paths outside ${branch}'s owned list:\n  ${bad.map(plain).join("\n  ")}\n${keep.slice(2)}`);
  const clean = (lib.treeChanges(wt) || [null]).length === 0;
  r = g(["update-ref", "-m", `proteus-container ${s.id}`, `refs/heads/${branch}`, sha, base]);
  if (!r.ok) die(`cannot move ${branch} to ${sha.slice(0, 12)} (did it move meanwhile?): ${plain(r.err)}${keep}`);
  g(["update-ref", "-d", ref]);
  console.log(`container: ${branch} ${base.slice(0, 12)} -> ${sha.slice(0, 12)}`);
  console.log(plain(g(["diff", "--no-ext-diff", "--no-renames", "--stat", base, sha]).out));
  const follow = `git -C "${wt}" read-tree -m -u ${base} ${sha}`;
  if (!clean) { console.log(`container: ${wt} has local changes, so its files were left at ${base.slice(0, 12)}; bring them along with: ${follow}`); return true; }
  r = g(["read-tree", "-m", "-u", base, sha], { cwd: co.root, workTree: co.root, index: co.index });
  console.log(r.ok ? `container: ${wt}'s files updated` : `container: could not update ${wt}'s files (${plain(r.err)}); run: ${follow}`);
  return true;
}

// out/report.md as the host publishes it: { status, text }. Anything but a regular UTF-8 file of at most 64 KiB whose
// first line is `<STATUS> #<ticket>` becomes RED, with what was there quoted below; a link or an oversized file is
// never read. Control characters but newline and tab are dropped: the text is data, posted from a file.
function readReport(file, ticket) {
  const red = (why, was = "") => ({ status: "RED", text: `RED #${ticket} container: no valid report\n\n${why}\n${was
    ? `\n${was.split("\n").slice(0, 20).map((l) => `> ${l.slice(0, 200)}`).join("\n")}\n` : ""}` });
  // lstat, never through a link: the container has exited, so nothing in it can swap the file before the read
  let st = null, text;
  try { st = fs.lstatSync(file); } catch {}
  if (!st) return red("The worker wrote no report.md.");
  if (!st.isFile()) return red("report.md is not a regular file (a link, say); it was not read.");
  if (st.size > REPORT_MAX) return red(`report.md is ${st.size} bytes, over the ${REPORT_MAX >> 10} KiB cap; it was not read.`);
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(file)); } catch { return red("report.md could not be read as UTF-8 text."); }
  text = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").replace(/[^\P{Cc}\n\t]/gu, "").trim();
  const m = new RegExp(`^(${STATUSES.join("|")}) #${ticket}\\b`).exec(text);
  return m ? { status: m[1], text: text + "\n" } : red("Its first line is not `<STATUS> #" + ticket + " ...` (" + STATUSES.join(", ") + ").", text);
}

// gh as the agents (lib.agentGhDir, as proteus-signoff.js posts), else this process's login
const ghRead = (args, cwd) => lib.ghTry(args, cwd, 60000, lib.agentGhDir());
function ghEnv() {
  const env = { ...process.env, GH_PROMPT_DISABLED: "1" }, as = lib.agentGhDir();
  if (as) env.GH_CONFIG_DIR = as;
  return env;
}
// gh writes through proteus-gh.js (its backoff), the body on stdin
function ghWrite(args, input, cwd, what) {
  const r = lib.spawnArgv(process.execPath, [path.join(__dirname, "proteus-gh.js"), ...args], { cwd, input, stdio: ["pipe", "pipe", "pipe"], env: ghEnv(), timeout: 900000 });
  if (r.error || r.status !== 0) die(`cannot ${what}: ${plain(r.stderr || (r.error && r.error.message) || `exit ${r.status}`).slice(0, 300)}`);
}

// a closing keyword before an issue reference (#n, owner/repo#n, a URL), as GitHub and ticketOf read one
const CLOSING = /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?=:?[ \t]+(?:(?:[\w.-]+\/[\w.-]+)?#\d|https?:\/\/))/gi;
// the PR body: the host's Closes, Owned: and Tier: lines first (the last two from the list read before the run), and
// the report's own such lines and closing keywords defused (CI and ticketOf read the first match, GitHub every one)
const prBody = (n, owned, text) => `Closes #${n}\nOwned: ${owned.entries.join(" ")}\nTier: ${owned.tier}\n\n${text
  .replace(/^(owned|tier)(?=[ \t]*:)/gim, "\\$1").replace(CLOSING, "$1\\")}`;

// --ticket: the host publishes what the worker reported, since the container has no GitHub access. A moved branch is
// pushed by its one refspec; on DONE with no open PR one is opened (prBody); then the report is posted on the ticket,
// with a line saying so when the PR could not be opened (then RED, exit 1). gh runs as the agents (ghEnv).
function publish(o, wt, branch, s, g, owned, moved) {
  const n = o.ticket, rep = readReport(path.join(s.outDir, "report.md"), n);
  if (moved) {
    const r = g(["push", "origin", `refs/heads/${branch}:refs/heads/${branch}`], { user: true, cwd: wt, timeout: 300000 });
    if (!r.ok) die(`cannot push ${branch}: ${plain(r.err).slice(0, 300)}`);
  }
  let prFailed = "";
  if (rep.status === "DONE") {
    let r = ghRead(["pr", "list", "--head", branch, "--state", "open", "--json", "number", "-q", ".[].number"], wt);
    if (!r.ok) die(`cannot list ${branch}'s open PRs: ${plain(r.err).slice(0, 300)}`);
    if (!r.out) {
      r = ghRead(["issue", "view", n, "--json", "title", "-q", ".title"], wt);
      const title = plain(r.out).trim().slice(0, 256);
      if (!r.ok || !title) die(`cannot read #${n}'s title: ${plain(r.err).slice(0, 300)}`);
      try { ghWrite(["pr", "create", "--base", o.base, "--head", branch, "--title", title, "--body-file", "-"], prBody(n, owned, rep.text), wt, `open ${branch}'s PR`); }
      catch (e) { if (!(e instanceof Stop)) throw e; prFailed = e.message; }
    }
  }
  ghWrite(["issue", "comment", n, "--body-file", "-"], prFailed ? `${rep.text}\nOpening the PR failed: ${prFailed}\n` : rep.text, wt, `post the report on #${n}`);
  if (prFailed) { console.error(`proteus-container: ${prFailed}`); die("pr create failed"); }
  console.log(`${rep.status} #${n} sent`);
  return 0;
}

// check: <command...> on --ref's commit in the container, with no credential and --network none unless given. The
// verdict is the runtime's exit status, never a file: anything the command leaves behind, even outside its process
// group, dies with the entry (PID 1) but could have rewritten /out first. check.log is shown as data when it is a
// regular file under its cap; nothing is imported and no ref is made. The entry stops the command at --timeout
// (exit 124); the host kills the container a little later.
function checkCmd(o) {
  const { co, branch } = workerCheckout(o.worktree);
  const g = (args, x = {}) => lib.gitTry(co.common, args, { timeout: 600000, ...x });
  const sha = g(["rev-parse", "--verify", "-q", `${o.ref}^{commit}`]).out;
  if (!sha) die(`--ref ${o.ref}: no such commit`);
  const short = sha.slice(0, 12);
  if (!g(["merge-base", "--is-ancestor", sha, `refs/heads/${branch}`]).ok) die(`refused: ${short} is not reachable from ${branch}`);
  const rt = needRuntime(o.runtime);
  const ms = Math.round(+o.timeout * 60000), network = o.network || "none";
  const free = takeSlot(co, o.queue);
  const s = prepare(co.common);
  try {
    fs.writeFileSync(path.join(s.inDir, "run.json"), JSON.stringify({ mode: "check", ref: sha, command: o.command, timeout: ms }) + "\n");
    fs.chmodSync(path.join(s.inDir, "run.json"), 0o644);
    const inBundle = path.join(s.inDir, "in.bundle");
    const r = g(["bundle", "create", inBundle, `refs/heads/${branch}`]);
    if (!r.ok) die(`cannot bundle ${branch}: ${r.err}`);
    fs.chmodSync(inBundle, 0o644);
    const name = `proteus-${s.id}`;
    console.log(`check: ${rt.name} running ${o.image} on ${short} (${name}, network ${network}, timeout ${o.timeout} min)`);
    // the container's own output is shown only as a hint when the entry failed (125)
    const run = lib.spawnArgv(rt.bin, runArgs(rt, { ...o, network, name, cred: "", in: s.inDir, out: s.outDir }),
      { env: childEnv(process.env, [...GH_ENV, ...CREDS]), stdio: ["ignore", "ignore", "pipe"], timeout: ms + Math.min(60000, ms / 10 + 5000) });
    const timedOut = () => { console.log(`CHECK ${short} timed out`); return 1; };
    if (run.error && run.error.code === "ETIMEDOUT") {
      lib.spawnArgv(rt.bin, ["kill", name], { env: childEnv(), stdio: "ignore", timeout: 60000 });
      return timedOut();
    }
    if (run.error) die(`${rt.name} did not start: ${run.error.message}`);
    const code = run.status === null ? 128 + ((run.signal && os.constants.signals[run.signal]) || 0) : run.status;
    if (code === ENTRY_FAILED) console.error(`proteus-container: ${rt.name} or the entry failed before the command ran: ${plain(run.stderr || "").trim().slice(-300)}. Is the image built (\`node ${path.basename(__filename)} doctor\`)?`);
    const log = path.join(s.outDir, "check.log");
    if (regular(log, LOG_MAX)) console.log(`check: log at ${log}`);
    else console.error(`proteus-container: check.log is missing, not a regular file (a link or a FIFO, say), or over ${LOG_MAX} bytes; not shown`);
    if (code === TIMED_OUT) return timedOut();
    console.log(`CHECK ${short} exit ${code}`);
    return code === 0 ? 0 : 1;
  } finally {
    dropBundles(s);
    free();
  }
}

// templates/container/Dockerfile: beside this file's templates/ (checkout, plugin), else the project's teams/ copy
function dockerfile() {
  const lead = lib.mainRoot(lib.gitCommonDir(process.cwd()) || "") || lib.repoRoot();
  const c = [path.join(__dirname, "..", "container", "Dockerfile"), ...(lead ? [path.join(lib.docRoot(lead), "teams", "templates", "container", "Dockerfile")] : [])];
  return c.find((f) => regular(f)) || die(`no Dockerfile at ${c.join(" or ")}`);
}
function buildCmd(o) {
  const rt = needRuntime(o.runtime);
  const ctx = fs.mkdtempSync(path.join(os.tmpdir(), "proteus-image-"));
  try {
    fs.copyFileSync(dockerfile(), path.join(ctx, "Dockerfile"));
    fs.copyFileSync(path.join(__dirname, ENTRY), path.join(ctx, ENTRY));
    const r = lib.spawnArgv(rt.bin, ["build", "-t", o.image, ctx], { env: childEnv(), stdio: ["ignore", "inherit", "inherit"], timeout: 1800000 });
    if (r.error || r.status !== 0) die(`${rt.name} build failed${r.error ? `: ${r.error.message}` : ` (exit ${r.status})`}`);
    console.log(`container: built ${o.image} with ${rt.name}`);
    return 0;
  } finally {
    fs.rmSync(ctx, { recursive: true, force: true });
  }
}

function doctorCmd(o) {
  const rows = [];
  const rt = findRuntime(o.runtime);
  rows.push(rt ? ["ok", `runtime ${rt.name} (${rt.bin})`] : ["FIX", `runtime: ${o.runtime || "podman or docker"} not on PATH; install one, or ${FALLBACK}`]);
  if (rt) {
    const info = rt.name === "docker" ? lib.spawnArgv(rt.bin, ["info", "--format", "{{.SecurityOptions}}"], { env: childEnv(), stdio: ["ignore", "pipe", "ignore"], timeout: 30000 }) : null;
    const rootless = rt.name === "podman" || /rootless/.test((info && info.stdout) || "");
    rows.push(rootless ? ["ok", `rootless ${rt.name}`] : ["warn", "rootful docker: a container escape is root on this host; prefer podman or rootless Docker"]);
    const img = lib.spawnArgv(rt.bin, ["image", "inspect", o.image], { env: childEnv(), stdio: "ignore", timeout: 30000 });
    rows.push(img.status === 0 ? ["ok", `image ${o.image}`] : ["FIX", `image ${o.image} not found; node ${path.basename(__filename)} build`]);
  }
  const cred = credential();
  rows.push(cred ? ["ok", `credential ${cred} set`] : ["FIX", `credential: set ${CREDS.join(" or ")} in the lead's env (\`claude setup-token\` prints a CLAUDE_CODE_OAUTH_TOKEN)`]);
  for (const [st, what] of rows) console.log(`${st.padEnd(4)}  ${what}`);
  return rows.some(([st]) => st === "FIX") ? 1 : 0;
}

function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) { console.log(HELP); return 0; }
  let o = {};
  try {
    o = parse(argv);
    return { run: runCmd, check: checkCmd, build: buildCmd, doctor: doctorCmd }[o.cmd](o);
  } catch (e) {
    const stop = e instanceof Stop;
    if (!stop && !o.ticket) throw e;
    const msg = stop ? e.message : String((e && e.message) || e);
    console.error(`proteus-container: ${stop ? msg : String((e && e.stack) || msg)}`);
    // the lead reads the last line as the worker's result, whatever was thrown
    if (o.ticket) console.log(`RED #${o.ticket} container: ${plain(msg.split("\n")[0]).slice(0, 300)}`);
    return stop ? e.code : 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { main, parse, slotCount, which, findRuntime, runArgs, childEnv, credential, SPECIAL, readReport };

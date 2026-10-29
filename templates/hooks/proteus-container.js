#!/usr/bin/env node
// Container runner (#80): one Claude Code worker session in a container that never sees the host's .git.
//   node <hooks>/proteus-container.js run --worktree <dir> --prompt-file <file> [--image <name>] [--runtime docker|podman]
//        [--memory 4g] [--cpus 2] [--pids 512] [--network <name>] [--timeout <min>]
//   node <hooks>/proteus-container.js build [--image <name>] [--runtime docker|podman]
//   node <hooks>/proteus-container.js doctor [--image <name>] [--runtime docker|podman]
// run: bundles the worktree's branch (lib's pinned git on the trusted common dir, #215) into a fresh 0700 dir under
// <common>/proteus/scratch, then starts the image with only that bundle and the prompt read-only at /in and an empty
// /out: every capability dropped, no new privileges, a read-only root, tmpfs /tmp, /work and home, the node user,
// pids, memory and cpu caps, and the credential passed by name, never by value. GH_TOKEN and GITHUB_TOKEN never reach
// the runtime. proteus-container-entry.js clones the bundle, runs `claude -p` with bypassPermissions and bundles the
// branch's new commits to /out. Back on the host only that bundle is read, through the pinned git: verified, fetched
// with no tags and one fixed refspec into refs/proteus-container/<id>, and the branch moved there with update-ref
// only when its old tip is an ancestor and every changed path is owned (.claude/proteus-owned through lib.ownedDenial,
// as proteus-owned-check.js --staged; a .git* path such as .gitattributes only when an owned entry names it). A clean
// worktree's files follow (read-tree -m -u old new); a dirty one is left, with the command that brings them along.
// result.json and status.json stay in the scratch dir; the bundles are removed.
// build: builds templates/container/Dockerfile with the entrypoint. doctor: runtime, rootless, image, credential.
// Exit 0 imported, nothing to import, built or doctor clean; 1 refused or failed (reason on stderr); 2 usage.
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
const USAGE = "usage: node proteus-container.js run --worktree <dir> --prompt-file <file> [options] | build [--image <name>] | doctor";
const HELP = `${USAGE}
Runs one Claude Code worker session in a container that never sees the host's .git:
  run      bundle the worktree's branch, run claude -p (bypassPermissions) on it in the container, and
           fast-forward the branch to what comes back when every changed path is owned
  build    build the image (templates/container/Dockerfile: node:22-slim, git, Claude Code)
  doctor   the runtime, whether it is rootless, the image, the credential env var
Options:
  --worktree <dir>     the worker's worktree; its .claude/proteus-owned lists what the result may change
  --prompt-file <file> the worker's prompt
  --image <name>       default ${IMAGE}; a project's own image built FROM it adds toolchains
  --runtime <name>     docker or podman; default podman when found (rootless), else docker
  --memory 4g  --cpus 2  --pids 512   the container's caps
  --network <name>     the container's network; default the runtime's (open egress)
  --timeout <min>      wall clock before the container is killed; default 60
Credential: CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY in the env, passed by name. No GitHub token.
Exit 0 imported or nothing to import; 1 refused or failed; 2 usage.`;

const FLAGS = { "--worktree": "worktree", "--prompt-file": "prompt", "--image": "image", "--runtime": "runtime", "--memory": "memory", "--cpus": "cpus", "--pids": "pids", "--network": "network", "--timeout": "timeout" };
const ONLY_RUN = ["worktree", "prompt", "memory", "cpus", "pids", "network", "timeout"];
const CHECKS = {
  runtime: [/^(?:docker|podman)$/, "docker or podman"],
  image: [/^[A-Za-z0-9][\w./:@-]*$/, "an image name"],
  memory: [/^[1-9]\d*[bkmg]?$/i, "a size such as 4g"],
  cpus: [/^(?:\d+(?:\.\d+)?)$/, "a number such as 2"],
  pids: [/^[1-9]\d*$/, "a whole number"],
  network: [/^[A-Za-z0-9][\w.-]*$/, "a network name"],
  timeout: [/^(?:\d+(?:\.\d+)?)$/, "minutes"],
};
// a .git* name anywhere in a path: .gitattributes, .gitmodules, .gitignore, a nested .git
const SPECIAL = (rel) => rel.split("/").some((s) => /^\.git/i.test(s));
// what reaches the lead's output from a file the container wrote or a path it named: no control character
const plain = (s) => String(s).replace(/\p{Cc}/gu, "");

class Stop extends Error { constructor(msg, code) { super(msg); this.code = code; } }
const die = (msg, code = 1) => { throw new Stop(msg, code); };

function parse(argv) {
  const [cmd, ...rest] = argv;
  if (!["run", "build", "doctor"].includes(cmd)) die(`${USAGE}\n(--help explains each command)`, 2);
  const o = { cmd, image: IMAGE, memory: "4g", cpus: "2", pids: "512", timeout: "60" };
  for (let i = 0; i < rest.length; i += 2) {
    const k = FLAGS[rest[i]];
    if (!k || rest[i + 1] === undefined) die(`${USAGE}\n${rest[i]}: unknown or missing its value`, 2);
    if (cmd !== "run" && ONLY_RUN.includes(k)) die(`${USAGE}\n${rest[i]} is for run only`, 2);
    o[k] = rest[i + 1];
  }
  for (const [k, [re, what]] of Object.entries(CHECKS)) if (o[k] !== undefined && !re.test(o[k])) die(`--${k} ${o[k]}: not ${what}`, 2);
  if (!(+o.cpus > 0) || !(+o.timeout > 0)) die("--cpus and --timeout must be above 0", 2);
  if (cmd === "run" && (!o.worktree || !o.prompt)) die(`${USAGE}\nrun needs --worktree and --prompt-file`, 2);
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

// the runtime's env: the caller's, less any GitHub token (the host pushes; the container never can)
function childEnv(env = process.env) {
  const out = { ...env };
  for (const k of Object.keys(out)) if (GH_ENV.includes(k.toUpperCase())) delete out[k];
  return out;
}
const credential = (env = process.env) => CREDS.find((k) => env[k]) || "";

// `<runtime> run` argv. o: name, image, memory, cpus, pids, network, cred (a NAME), in, out (host dirs)
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
    "-e", o.cred, o.image];
}

// a regular file the container wrote, never through a link; null otherwise
function regular(file, max = 0) {
  try { const st = fs.lstatSync(file); return st.isFile() && (!max || st.size <= max) ? st : null; } catch { return null; }
}

// a fresh 0700 dir under <common>/proteus/scratch (lib.scratchDir) holding in/ (the bundle and the prompt, readable
// by the container's user) and out/ (writable by it: the 0700 parent keeps every other host user out)
function prepare(common, prompt) {
  const root = lib.scratchDir(common);
  fs.mkdirSync(root, { recursive: true });
  for (const d of [lib.stateDir(common), root]) if (!fs.lstatSync(d).isDirectory()) die(`${d} is not a real directory (a link); nothing written through it`);
  const dir = fs.mkdtempSync(path.join(root, "container-"));
  const inDir = path.join(dir, "in"), outDir = path.join(dir, "out");
  fs.mkdirSync(inDir);
  fs.mkdirSync(outDir);
  fs.copyFileSync(prompt, path.join(inDir, "prompt.md"));
  fs.chmodSync(dir, 0o700);
  fs.chmodSync(inDir, 0o755);
  fs.chmodSync(path.join(inDir, "prompt.md"), 0o644);
  fs.chmodSync(outDir, 0o777);
  return { dir, id: path.basename(dir).slice("container-".length), inDir, outDir };
}
function dropBundles(s) {
  for (const f of [path.join(s.inDir, "in.bundle"), path.join(s.outDir, "out.bundle")]) try { fs.rmSync(f, { force: true }); } catch {}
}

function runCmd(o) {
  const wt = path.resolve(o.worktree);
  const co = lib.checkoutOf(wt);
  if (!co || !lib.samePath(co.root, lib.realOr(wt))) die(`${wt} is not a worktree of this project's repo (run from the project, naming the worktree's root)`);
  const branch = lib.branchOf(wt), base = lib.headOf(wt);
  if (!branch || !/^[\w][\w./-]*$/.test(branch) || !base) die(`${wt} has no branch checked out (or an unusual branch name)`);
  if (!fs.existsSync(lib.ownedFile(wt))) die(`${wt} has no ${path.relative(wt, lib.ownedFile(wt))}, so nothing the container returns could be checked; run proteus-worktree.js on it first`);
  if (!regular(path.resolve(o.prompt))) die(`${o.prompt}: not a regular file`);
  const rt = needRuntime(o.runtime);
  const cred = credential();
  if (!cred) die(`neither ${CREDS.join(" nor ")} is set; set one in the env (it reaches the container by name only), or ${FALLBACK}`);

  const g = (args, x = {}) => lib.gitTry(co.common, args, { timeout: 600000, ...x });
  const s = prepare(co.common, path.resolve(o.prompt));
  try {
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
    return importResult(co, wt, branch, base, s, g);
  } finally {
    dropBundles(s);
  }
}

function importResult(co, wt, branch, base, s, g) {
  const status = regular(path.join(s.outDir, "status.json"), 1 << 20) ? lib.readJSON(path.join(s.outDir, "status.json"), {}) : {};
  console.log(`container: worker exited ${plain(status.exit)}${status.error ? `, error: ${plain(status.error).slice(0, 300)}` : ""}; result.json and status.json in ${s.outDir}`);
  const bundle = path.join(s.outDir, "out.bundle");
  if (!fs.existsSync(bundle) && status.unchanged === true) { console.log(`container: no new commits; ${branch} is unchanged`); return 0; }
  if (!regular(bundle)) die("no out.bundle (or not a regular file); nothing imported");
  let r = g(["bundle", "verify", "-q", bundle]);
  if (!r.ok) die(`out.bundle does not verify: ${plain(r.err)}`);
  const ref = `refs/proteus-container/${s.id}`;
  r = g(["-c", "fetch.fsckObjects=true", "fetch", "-q", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", bundle, `refs/heads/${branch}:${ref}`]);
  if (!r.ok) die(`cannot fetch ${branch} from out.bundle: ${plain(r.err)}`);
  const sha = g(["rev-parse", "--verify", "-q", `${ref}^{commit}`]).out;
  const keep = `; the result stays at ${ref}`;
  if (!sha) die(`${ref} is not a commit${keep}`);
  if (sha === base) { g(["update-ref", "-d", ref]); console.log(`container: no new commits; ${branch} is unchanged`); return 0; }
  if (!g(["merge-base", "--is-ancestor", base, sha]).ok) die(`refused: ${sha.slice(0, 12)} does not descend from ${branch}'s ${base.slice(0, 12)} (rewritten history)${keep}`);
  r = g(["diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", base, sha]);
  if (!r.ok) die(`cannot diff ${base.slice(0, 12)}..${sha.slice(0, 12)}: ${plain(r.err)}${keep}`);
  const paths = r.out.split("\0").filter(Boolean);
  let entries = [];
  try { entries = fs.readFileSync(lib.ownedFile(wt), "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")); } catch {}
  const bad = paths.map((p) => {
    const no = lib.ownedDenial(wt, p);
    if (no) return no.replace(/ Comment "NEEDS.*$/, "");
    return SPECIAL(p) && !entries.some((e) => SPECIAL(e) && lib.ownedMatch(e, p)) ? `${p} is a .git* path no owned entry names` : "";
  }).filter(Boolean);
  if (bad.length) die(`refused: the result changes paths outside ${branch}'s owned list:\n  ${bad.map(plain).join("\n  ")}\n${keep.slice(2)}`);
  const clean = (lib.treeChanges(wt) || [null]).length === 0;
  r = g(["update-ref", "-m", `proteus-container ${s.id}`, `refs/heads/${branch}`, sha, base]);
  if (!r.ok) die(`cannot move ${branch} to ${sha.slice(0, 12)} (did it move meanwhile?): ${plain(r.err)}${keep}`);
  g(["update-ref", "-d", ref]);
  console.log(`container: ${branch} ${base.slice(0, 12)} -> ${sha.slice(0, 12)}`);
  console.log(plain(g(["diff", "--no-ext-diff", "--no-renames", "--stat", base, sha]).out));
  const follow = `git -C "${wt}" read-tree -m -u ${base} ${sha}`;
  if (!clean) { console.log(`container: ${wt} has local changes, so its files were left at ${base.slice(0, 12)}; bring them along with: ${follow}`); return 0; }
  r = g(["read-tree", "-m", "-u", base, sha], { cwd: co.root, workTree: co.root, index: co.index });
  console.log(r.ok ? `container: ${wt}'s files updated` : `container: could not update ${wt}'s files (${plain(r.err)}); run: ${follow}`);
  return 0;
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
  rows.push(cred ? ["ok", `credential ${cred} set`] : ["FIX", `credential: set ${CREDS.join(" or ")}`]);
  for (const [st, what] of rows) console.log(`${st.padEnd(4)}  ${what}`);
  return rows.some(([st]) => st === "FIX") ? 1 : 0;
}

function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) { console.log(HELP); return 0; }
  try {
    const o = parse(argv);
    return o.cmd === "run" ? runCmd(o) : o.cmd === "build" ? buildCmd(o) : doctorCmd(o);
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    console.error(`proteus-container: ${e.message}`);
    return e.code;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { parse, which, findRuntime, runArgs, childEnv, credential, SPECIAL };

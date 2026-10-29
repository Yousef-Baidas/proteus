// The verifier App (#81): node tests/verifierapp.test.js (needs git). lib.appJwt and lib.appToken against a local
// fake GitHub API (PROTEUS_GH_API, a child process so the hooks run synchronously against it), proteus-signoff.js
// posting under the App's token and never falling back to the agents' login, the guards keeping the key and
// GH_TOKEN out of the agents' reach, and install.js --verifier-app, --protect and --doctor. Never touches the network.
// Exit 0 if every assertion passed, 1 otherwise.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const HOOKS = path.join(ROOT, "templates", "hooks");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g, run } = lib;
const W = lib.workdir("verifierapp");
const HOME = lib.HOME;
const PJ = path.join(HOME, ".claude", "proteus.json");
const slash = (p) => p.split(path.sep).join("/");
const POSIX = process.platform !== "win32";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const KEYS = path.join(HOME, "keys");
fs.mkdirSync(KEYS);
const KEY = path.join(KEYS, "verifier-app.pem");
fs.writeFileSync(KEY, privateKey.export({ type: "pkcs1", format: "pem" }), { mode: 0o600 });
const PUB = path.join(W, "pub.pem");
fs.writeFileSync(PUB, publicKey.export({ type: "spki", format: "pem" }));
const TOKEN = "ghs_faketoken0123456789";
const setApp = (extra = {}) => fs.writeFileSync(PJ, JSON.stringify({ home: ROOT, verifierApp: { appId: 42, installationId: 77, keyPath: KEY }, ...extra }));

// the fake API: verifies the JWT against PUB, answers the installation and the token from API_STATE, logs to API_LOG
const API_STATE = path.join(W, "api.json"), API_LOG = path.join(W, "api.log");
const setApi = (o = {}) => { fs.writeFileSync(API_STATE, JSON.stringify({ installed: true, tokenStatus: 201, ...o })); fs.writeFileSync(API_LOG, ""); };
const apiLog = () => fs.readFileSync(API_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const SERVER = `
const http = require("http"), fs = require("fs"), crypto = require("crypto");
const [state, log, pub] = process.argv.slice(1);
const jwtOk = (h) => {
  const m = /^Bearer ([\\w-]+)\\.([\\w-]+)\\.([\\w-]+)$/.exec(h || "");
  if (!m) return false;
  const p = JSON.parse(Buffer.from(m[2], "base64url").toString());
  return crypto.verify("RSA-SHA256", Buffer.from(m[1] + "." + m[2]), fs.readFileSync(pub, "utf8"), Buffer.from(m[3], "base64url")) && p.iss === "42" && p.exp - p.iat === 600;
};
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const s = JSON.parse(fs.readFileSync(state, "utf8"));
    fs.appendFileSync(log, JSON.stringify({ method: req.method, url: req.url, jwt: jwtOk(req.headers.authorization), body: body ? JSON.parse(body) : null }) + "\\n");
    const send = (code, o) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (!jwtOk(req.headers.authorization)) return send(401, { message: "A JSON web token could not be decoded" });
    if (req.method === "GET" && req.url === "/repos/o/r/installation") return s.installed ? send(200, { id: 77 }) : send(404, { message: "Not Found" });
    if (req.method === "POST" && req.url === "/app/installations/77/access_tokens") return s.tokenStatus === 201 ? send(201, { token: "${TOKEN}" }) : send(s.tokenStatus, { message: "Resource not accessible by integration" });
    send(404, { message: "Not Found" });
  });
}).listen(0, "127.0.0.1", function () { console.log(this.address().port); });
`;
const DEAD = "http://127.0.0.1:9"; // discard port: nothing answers

(async () => {
  const server = spawn(process.execPath, ["-e", SERVER, API_STATE, API_LOG, PUB], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((res) => server.stdout.once("data", (d) => res(String(d).trim())));
  const API = `http://127.0.0.1:${port}`;
  try { tests(API); } finally { server.kill(); }
  lib.summary();
})();

function tests(API) {
  setApi();
  const node = (code, env = {}) => run("-", code, { cwd: W, env: { PROTEUS_GH_API: API, ...env } });
  const L = JSON.stringify(path.join(HOOKS, "proteus-lib.js"));

  // ---- lib: the JWT, the token
  let r = node(`const l = require(${L}); const t = l.appJwt(42, require("fs").readFileSync(${JSON.stringify(KEY)}, "utf8"), 1000);
    const [h, p] = t.split(".").slice(0, 2).map((x) => JSON.parse(Buffer.from(x, "base64url")));
    console.log(JSON.stringify({ h, p, ok: require("crypto").verify("RSA-SHA256", Buffer.from(t.split(".").slice(0, 2).join(".")), require("fs").readFileSync(${JSON.stringify(PUB)}, "utf8"), Buffer.from(t.split(".")[2], "base64url")) }))`);
  const jwt = JSON.parse(r.out || "{}");
  ok("lib: appJwt is RS256, iat a minute back, exp 9 minutes on, iss the App id, and verifies with the public key",
    jwt.ok === true && jwt.h.alg === "RS256" && jwt.p.iat === 940 && jwt.p.exp === 1540 && jwt.p.iss === "42", r.out + r.err);
  setApp();
  r = node(`require(${L}).appToken("o/r").then((t) => console.log(t === ${JSON.stringify(TOKEN)} ? "tok" : "bad"), (e) => console.log("err " + e.message))`);
  const mint = apiLog()[0] || {};
  ok("lib: appToken mints an installation token for the one repo with statuses: write", r.out.trim() === "tok" && mint.jwt
    && mint.url === "/app/installations/77/access_tokens" && JSON.stringify(mint.body) === JSON.stringify({ repositories: ["r"], permissions: { statuses: "write" } }), r.out + r.err + JSON.stringify(mint));
  setApi({ tokenStatus: 403 });
  r = node(`require(${L}).appToken("o/r").then(() => console.log("tok"), (e) => console.log(JSON.stringify({ m: e.message, n: !!e.network, s: e.status })))`);
  let e = JSON.parse(r.out || "{}");
  ok("lib: a refused token is a one-line reason with the HTTP status, not a network failure", e.s === 403 && !e.n && /HTTP 403 Resource not accessible/.test(e.m) && !/\n/.test(e.m), r.out + r.err);
  r = node(`require(${L}).appToken("o/r").then(() => console.log("tok"), (e) => console.log(JSON.stringify({ m: e.message, n: !!e.network })))`, { PROTEUS_GH_API: DEAD });
  e = JSON.parse(r.out || "{}");
  ok("lib: GitHub out of reach is marked network", e.n === true && /GitHub not reached/.test(e.m), r.out + r.err);
  setApp({ verifierApp: { appId: 42, installationId: 77, keyPath: path.join(KEYS, "missing.pem") } });
  r = node(`require(${L}).appToken("o/r").then(() => console.log("tok"), (e) => console.log(e.message))`);
  ok("lib: a missing key names the path", /cannot read the App key .*missing\.pem/.test(r.out), r.out + r.err);
  fs.writeFileSync(PJ, JSON.stringify({ verifierApp: { appId: "~", keyPath: KEY } }));
  ok("lib: verifierApp with no numeric appId is none", node(`console.log(require(${L}).verifierApp())`).out.trim() === "null");
  fs.writeFileSync(PJ, JSON.stringify({ verifierApp: { appId: 42, installationId: 77, keyPath: "~/keys/verifier-app.pem" } }));
  ok("lib: a keyPath with ~ resolves under the home", node(`console.log(require(${L}).verifierApp().keyPath)`).out.trim() === KEY);

  // ---- proteus-signoff.js under the App
  const SIGN = path.join(HOOKS, "proteus-signoff.js");
  const HEAD = "a".repeat(40);
  const PR = path.join(W, "pr.json"), LOG = path.join(W, "gh.log");
  const ROUTING = "# Routing\n\n## Security\n\n```security\nsrc/auth/**\n.github/**\n```\n";
  const CI = (state, description, login = "github-actions[bot]") => ({ [HEAD]: [{ state, context: "proteus/security", description, creator: { login } }] });
  const setPr = (o) => { fs.writeFileSync(PR, JSON.stringify({ head: HEAD, files: ["src/app/page.tsx"], routing: ROUTING, statuses: {}, ...o })); fs.writeFileSync(LOG, ""); setApi(); };
  const st = () => (JSON.parse(fs.readFileSync(PR, "utf8")).statuses || {})[HEAD] || [];
  const latest = (c) => st().find((x) => x.context === c);
  const posts = () => fs.readFileSync(LOG, "utf8").split("\n").filter((l) => l.startsWith("api -X POST "));
  const sign = (args, env = {}) => run(SIGN, "", { cwd: W, args, env: { FAKE_GH_PR: PR, FAKE_GH_LOG: LOG, PROTEUS_GH_API: API, ...env } });
  const quiet = (x) => !`${x.out}${x.err}${fs.readFileSync(LOG, "utf8")}`.includes(TOKEN);
  setApp();
  ok("lib: the parser reads the test's security block", node(`console.log(JSON.stringify(require(${L}).parseSecurity(${JSON.stringify(ROUTING)})))`).out.trim() === '["src/auth/**",".github/**"]');

  setPr({});
  r = sign(["5", HEAD, "MERGE", "--security"]);
  ok("signoff: with the App, --security posts under the App's token", r.code === 0 && latest("proteus/security").state === "success" && latest("proteus/security").token === TOKEN && /as App 42/.test(r.out), r.out + r.err);
  ok("signoff: the token is in no argument, no output and no log", quiet(r));
  setPr({ statuses: CI("success", "no security path touched") });
  r = sign(["5", HEAD, "MERGE"]);
  ok("signoff: a MERGE carries CI's no-path success over as the App's, both under the token",
    r.code === 0 && latest("proteus/verdict").token === TOKEN && latest("proteus/security").token === TOKEN && /carried over/.test(latest("proteus/security").description) && quiet(r), r.out + r.err + JSON.stringify(st()));
  setPr({});
  r = sign(["5", HEAD, "MERGE"]);
  ok("signoff: a MERGE before CI posted proteus/security is refused, nothing posted", r.code === 1 && /CI has not posted proteus\/security/.test(r.err) && !posts().length, r.err);
  setPr({ statuses: CI("failure", "needs the security verifier: src/auth/a.ts (src/auth/**)") });
  r = sign(["5", HEAD, "MERGE"]);
  ok("signoff: CI's failure stays; the MERGE posts the verdict only", r.code === 0 && posts().length === 1 && latest("proteus/verdict").token === TOKEN && latest("proteus/security").state === "failure", r.out + r.err);
  setPr({ statuses: CI("success", "no security path touched", "bot") });
  r = sign(["5", HEAD, "MERGE"]);
  ok("signoff: a no-path success from another login than CI's is not carried over", r.code === 0 && posts().length === 1 && !latest("proteus/security").token, r.out + r.err);
  setPr({ files: ["src/auth/session.ts"], statuses: CI("success", "no security path touched") });
  r = sign(["5", HEAD, "MERGE"]);
  ok("signoff: CI's no-path success on a PR whose files match the base's security block is not carried over, and says so",
    r.code === 0 && posts().length === 1 && /not carried over: src\/auth\/session\.ts/.test(r.out), r.out + r.err);
  setPr({ routing: "# Routing\n", statuses: CI("success", "no security block in teams/ROUTING.md; nothing checked") });
  r = sign(["5", HEAD, "MERGE"]);
  ok("signoff: no security block in the base: CI's success is carried over", r.code === 0 && posts().length === 2 && latest("proteus/security").token === TOKEN, r.out + r.err);
  setPr({ routing: undefined, statuses: CI("success", "no security path touched") });
  r = sign(["5", HEAD, "MERGE"]);
  ok("signoff: the base's ROUTING.md unreadable while CI read a block: not carried over", r.code === 0 && posts().length === 1 && /not carried over/.test(r.out), r.out + r.err);

  setPr({});
  setApi({ tokenStatus: 403 });
  r = sign(["5", HEAD, "MERGE", "--security"]);
  ok("signoff: no token mints: exit 1, one line, nothing posted, no fall back to the agents' login",
    r.code === 1 && r.err.trim().split("\n").length === 1 && /App 42 gave no token \(.*HTTP 403.*\); nothing posted/.test(r.err) && !posts().length, r.out + r.err);
  r = sign(["5", HEAD, "MERGE", "--security"], { PROTEUS_GH_API: DEAD });
  ok("signoff: GitHub out of reach fails the same way", r.code === 1 && /gave no token .*not reached/.test(r.err) && !posts().length, r.err);
  fs.writeFileSync(PJ, JSON.stringify({ home: ROOT }));
  setPr({});
  r = sign(["5", HEAD, "MERGE"]);
  ok("signoff: no App: posts as before, no token, no API call", r.code === 0 && posts().length === 1 && !("token" in latest("proteus/verdict")) && !apiLog().length, r.out + r.err);

  // ---- the guards
  setApp();
  const BARE = path.join(W, "remote.git"), REPO = path.join(W, "repo");
  g(W, "init", "-q", "--bare", "-b", "main", BARE);
  g(W, "init", "-q", "-b", "main", REPO);
  fs.mkdirSync(path.join(REPO, "src"));
  fs.writeFileSync(path.join(REPO, "src", "a.js"), "a\n");
  g(REPO, "add", "-A"); g(REPO, "commit", "-qm", "init");
  g(REPO, "remote", "add", "origin", BARE);
  g(REPO, "push", "-q", "-u", "origin", "main");
  const WT = path.join(REPO, ".worktrees", "r1-1");
  g(REPO, "worktree", "add", "-q", "-b", "proteus-work/r1/1", WT, "main");
  run(path.join(HOOKS, "proteus-worktree.js"), "", { cwd: REPO, args: [WT, "src/**"] });
  const WG = path.join(WT, ".claude", "hooks", "proteus-worker-guard.js"), LG = path.join(HOOKS, "proteus-lead-guard.js");
  const ev = (cwd, tool_name, tool_input, extra = {}) => ({ hook_event_name: "PreToolUse", session_id: "s1", cwd, tool_name, tool_input, ...extra });
  const wg = (tool, input, extra) => run(WG, ev(WT, tool, input, extra), { cwd: WT });
  const lg = (tool, input, extra) => run(LG, ev(REPO, tool, input, extra), { cwd: REPO });
  const sub = { agent_id: "a1", agent_type: "proteus-backend-worker" };
  const KEYMSG = /verifier App's private key/, TOKMSG = /never set GH_TOKEN or GITHUB_TOKEN/;
  const names = [`cat ${JSON.stringify(slash(KEY))}`, "cat ~/keys/verifier-app.pem", "cp ../keys/verifier-app.pem x", "node -e \"require('fs').readFileSync('verifier-app.pem')\""];
  const tokens = ["GH_TOKEN=x gh api user", "env GITHUB_TOKEN=x gh pr list", "export GH_TOKEN=x", "set -gx GH_TOKEN x", "$env:GITHUB_TOKEN = 'x'", "sh -c 'GH_TOKEN=x gh api user'", "GH_ENTERPRISE_TOKEN=x gh api user"];
  const fine = ["gh pr view 5", "echo $GH_TOKEN", "set -e GH_TOKEN", "gh auth status", "cat src/a.js"];
  const bad = (f, cmds, re) => cmds.map((c) => { const x = f("Bash", { command: c }); return x.code === 2 && re.test(x.err) ? "" : `${c} => ${x.code} ${x.err}`; }).filter(Boolean);
  const good = (f, cmds) => cmds.map((c) => { const x = f("Bash", { command: c }); return x.code === 0 ? "" : `${c} => ${x.code} ${x.err}`; }).filter(Boolean);
  let b = [...bad(wg, names, KEYMSG), ...bad(wg, tokens, TOKMSG)];
  ok("worker guard: a shell command naming the key, or setting GH_TOKEN / GITHUB_TOKEN, is refused", !b.length, b.join("\n"));
  b = good(wg, fine);
  ok("worker guard: reading GH_TOKEN, erasing it, gh as it is, and other files pass", !b.length, b.join("\n"));
  ok("worker guard: Read and Edit of the key are refused, wherever they name it from",
    [["Read", { file_path: KEY }], ["Edit", { file_path: path.join(WT, "..", "..", "..", "home", "keys", "verifier-app.pem"), old_string: "a", new_string: "b" }], ["Write", { file_path: KEY, content: "x" }]]
      .every(([t, i]) => { const x = wg(t, i); return x.code === 2 && KEYMSG.test(x.err); }));
  ok("worker guard: Read of another file passes", wg("Read", { file_path: path.join(WT, "src", "a.js") }).code === 0);
  const SIGNOFF = `node .claude/hooks/proteus-signoff.js 5 ${HEAD} MERGE`;
  r = wg("Bash", { command: SIGNOFF });
  ok("worker guard: proteus-signoff.js from a worker's session the harness does not name is refused", r.code === 2 && /is not a verifier/.test(r.err), r.err);
  ok("worker guard: a verifier type still signs off there", wg("Bash", { command: SIGNOFF }, { agent_type: "proteus-verifier" }).code === 0);

  b = [...bad((t, i) => lg(t, i, sub), names, KEYMSG), ...bad((t, i) => lg(t, i, sub), tokens, TOKMSG), ...bad(lg, names, KEYMSG), ...bad(lg, tokens, TOKMSG)];
  ok("lead guard: the same commands are refused from a subagent and from the lead", !b.length, b.join("\n"));
  // #219: a subagent's Monitor that only reads still gets its Bash call's checks
  r = lg("Monitor", { command: `tail -f ${JSON.stringify(slash(KEY))}` }, sub);
  ok("lead guard: a subagent's read-only Monitor naming the key is refused as its Bash call is", r.code === 2 && KEYMSG.test(r.err), r.err);
  ok("lead guard: the lead's and a subagent's Read of the key are refused",
    [lg("Read", { file_path: KEY }), lg("Read", { file_path: KEY }, sub)].every((x) => x.code === 2 && KEYMSG.test(x.err)));
  if (POSIX) {
    const LINK = path.join(W, "innocent.txt");
    fs.symlinkSync(KEY, LINK);
    ok("lead guard: a link to the key is the key", lg("Read", { file_path: LINK }).code === 2);
  }
  ok("lead guard: the lead reading other files and gh as it is pass", lg("Read", { file_path: path.join(REPO, "src", "a.js") }).code === 0 && good(lg, ["gh pr view 5"]).length === 0);
  // an unnamed subagent whose brief names a worker's worktree is a worker
  const SESS = path.join(W, "sess");
  fs.mkdirSync(SESS);
  const brief = (text) => { const f = path.join(SESS, "a9.jsonl"); fs.writeFileSync(f, JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n"); return { agent_id: "a9", agent_transcript_path: f }; };
  r = lg("Bash", { command: SIGNOFF }, brief(`Ticket #3, worktree ${WT}, branch proteus-work/r1/1.`));
  ok("lead guard: proteus-signoff.js from an unnamed agent whose brief names a worktree is refused", r.code === 2 && /is not a verifier/.test(r.err), r.err);
  ok("lead guard: an unnamed agent whose brief names none still passes", lg("Bash", { command: SIGNOFF }, brief("Verify PR #5 for ticket #3.")).code === 0);
  fs.writeFileSync(PJ, JSON.stringify({ home: ROOT }));
  ok("guards: with no App, naming a .pem passes", wg("Bash", { command: "cat ~/keys/verifier-app.pem" }).code === 0 && lg("Read", { file_path: KEY }).code === 0);
  ok("guards: with no App, setting GH_TOKEN is still refused", wg("Bash", { command: "GH_TOKEN=x gh api user" }).code === 2);

  // ---- proteus-shell-check.js fingerprints the key
  setApp();
  r = node(`const c = require(${JSON.stringify(path.join(HOOKS, "proteus-shell-check.js"))}); const f = c.fingerprint(${JSON.stringify(path.join(REPO, ".git"))});
    console.log(JSON.stringify(Object.keys(f.entries).filter((k) => /verifier-app/.test(k))))`);
  ok("shell-check: the key is among the fingerprinted paths", /verifier-app\.pem/.test(r.out), r.out + r.err);

  // ---- install.js
  const IN = path.join(ROOT, "install.js");
  const STATE = path.join(W, "gh-state.json");
  const inst = (args, env = {}) => run(IN, "", { cwd: REPO, args, env: { USERPROFILE: HOME, FAKE_GH_STATE: STATE, PROTEUS_GH_API: API, ...env } });
  fs.writeFileSync(STATE, JSON.stringify({}));
  fs.writeFileSync(PJ, JSON.stringify({ home: ROOT }));
  setApi();
  ok("install --verifier-app: refuses other flags and bad usage",
    inst(["--verifier-app", "42", KEY, "--project"]).code === 2 && inst(["--verifier-app", "x", KEY]).code === 1 && inst(["--verifier-app", "42", path.join(KEYS, "no.pem")]).code === 1);
  setApi({ installed: false });
  r = inst(["--verifier-app", "42", KEY]);
  ok("install --verifier-app: an App not installed on the repo is named, nothing recorded", r.code === 1 && /not installed on o\/r/.test(r.err) && !JSON.parse(fs.readFileSync(PJ, "utf8")).verifierApp, r.out + r.err);
  setApi();
  r = inst(["--verifier-app", "42", "~/keys/verifier-app.pem"]);
  let cfg = JSON.parse(fs.readFileSync(PJ, "utf8"));
  ok("install --verifier-app: finds the installation, mints a token, records the App and keeps other keys",
    r.code === 0 && JSON.stringify(cfg.verifierApp) === JSON.stringify({ appId: 42, installations: { o: 77 }, keyPath: KEY }) && cfg.home === ROOT
      && apiLog().map((x) => `${x.method} ${x.url}`).join() === "GET /repos/o/r/installation,POST /app/installations/77/access_tokens" && !`${r.out}${r.err}`.includes(TOKEN), r.out + r.err);
  if (POSIX) {
    fs.chmodSync(KEY, 0o644);
    r = inst(["--verifier-app", "42", KEY]);
    ok("install --verifier-app: a key others can read is warned about", r.code === 0 && /readable by others \(mode 644\)/.test(r.err), r.err);
  }
  const INREPO = path.join(REPO, "app.pem");
  fs.copyFileSync(KEY, INREPO);
  r = inst(["--verifier-app", "42", INREPO]);
  ok("install --verifier-app: a key inside a git checkout is warned about", /sits in the git checkout/.test(r.err), r.err);
  fs.rmSync(INREPO);
  if (POSIX) fs.chmodSync(KEY, 0o600);
  setApp();

  r = inst(["--protect"]);
  const sts = JSON.parse(fs.readFileSync(STATE, "utf8"));
  const req = ((sts.rulesets || [{ rules: [] }])[0].rules.find((x) => x.type === "required_status_checks") || { parameters: {} }).parameters.required_status_checks || [];
  ok("install --protect: with the App, verdict and security are pinned to its id, gates is not",
    r.code === 0 && JSON.stringify(req) === JSON.stringify([{ context: "gates" }, { context: "proteus/verdict", integration_id: 42 }, { context: "proteus/security", integration_id: 42 }]) && /count only from the verifier App 42/.test(r.out), r.out + r.err + JSON.stringify(req));

  fs.mkdirSync(path.join(REPO, "teams"), { recursive: true });
  const rows = (x, re) => x.out.split("\n").filter((l) => re.test(l)).join("|");
  r = inst(["--doctor"]);
  ok("doctor: the App's key readable and a token minting are ok rows", /^ok\s+verifier App 42: key .* readable$/m.test(r.out) && /^ok\s+verifier App 42: a token mints for o\/r$/m.test(r.out), rows(r, /verifier App/) || r.out.slice(0, 600));
  ok("doctor: the pinned ruleset is ok", /^ok\s+proteus\/\* ruleset: .*\(the verdicts from App 42\)/m.test(r.out), rows(r, /ruleset/));
  const pinned = JSON.parse(fs.readFileSync(STATE, "utf8"));
  const loose = JSON.parse(JSON.stringify(pinned));
  for (const x of loose.rulesets[0].rules) if (x.type === "required_status_checks") x.parameters.required_status_checks = [{ context: "gates" }, { context: "proteus/verdict" }, { context: "proteus/security" }];
  fs.writeFileSync(STATE, JSON.stringify(loose));
  r = inst(["--doctor"]);
  ok("doctor: a ruleset not pinned to the App is a WARN with --protect as the fix", /^WARN\s+proteus\/\* ruleset on o\/r takes proteus\/verdict, proteus\/security from any login, .* — .*--protect/m.test(r.out), rows(r, /ruleset/));
  fs.writeFileSync(STATE, JSON.stringify(pinned));
  r = inst(["--doctor"], { PROTEUS_GH_API: DEAD });
  ok("doctor: GitHub out of reach is a WARN, not a FIX", /^WARN\s+verifier App 42: no token for o\/r \(.*not reached/m.test(r.out), rows(r, /verifier App/));
  setApi({ tokenStatus: 403 });
  r = inst(["--doctor"]);
  ok("doctor: a token GitHub refuses is a FIX", /^FIX\s+verifier App 42: no token for o\/r \(.*HTTP 403/m.test(r.out), rows(r, /verifier App/));
  setApi();
  setApp({ verifierApp: { appId: 42, installationId: 77, keyPath: path.join(KEYS, "gone.pem") } });
  r = inst(["--doctor"]);
  ok("doctor: an unreadable key is a FIX", /^FIX\s+verifier App 42: key .*gone\.pem is not readable/m.test(r.out), rows(r, /verifier App/));
  fs.writeFileSync(PJ, JSON.stringify({ home: ROOT }));
  r = inst(["--doctor"]);
  ok("doctor: no App, no App rows", !/verifier App/.test(r.out), rows(r, /verifier App/));
  const help = run(IN, "", { args: ["--help"] });
  ok("install --help names --verifier-app", /--verifier-app <appId> <keyPath>/.test(help.out), help.out.slice(0, 300));
}

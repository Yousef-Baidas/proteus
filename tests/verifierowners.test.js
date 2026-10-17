// The verifier App across repo owners: node tests/verifierowners.test.js (needs git). An App installation belongs to
// one account or org, so proteus.json keeps one per owner (verifierApp.installations), still reads the lone
// installationId of an older config, and lib.appToken, proteus-signoff.js, install.js --verifier-app, --protect and
// --doctor pick by the repo's owner. Against a local fake GitHub API; never touches the network.
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
const W = lib.workdir("verifierowners");
const HOME = lib.HOME;
const PJ = path.join(HOME, ".claude", "proteus.json");

const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const KEY = path.join(HOME, "keys", "verifier-app.pem");
fs.mkdirSync(path.dirname(KEY));
fs.writeFileSync(KEY, privateKey.export({ type: "pkcs1", format: "pem" }), { mode: 0o600 });
const TOKEN = "ghs_ownertoken0123456789";
const setApp = (app) => fs.writeFileSync(PJ, JSON.stringify({ home: ROOT, verifierApp: { appId: 42, keyPath: KEY, ...app } }));
const cfg = () => JSON.parse(fs.readFileSync(PJ, "utf8")).verifierApp;

// two owners, as GitHub has them: installation 77 is o's (repo r), 88 is p's (repo s). A token request names repos
// by name only, inside the installation's own account, so 77 asked for s is a 422, as on GitHub.
const API_LOG = path.join(W, "api.log");
const apiLog = () => fs.readFileSync(API_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const SERVER = `
const http = require("http"), fs = require("fs");
const log = process.argv[1];
const inst = { 77: { login: "o", repos: ["r"] }, 88: { login: "p", repos: ["s"] } };
const byRepo = { "o/r": 77, "p/s": 88 };
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const b = body ? JSON.parse(body) : null;
    fs.appendFileSync(log, JSON.stringify({ method: req.method, url: req.url, body: b }) + "\\n");
    const send = (code, o) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    let m;
    if (req.method === "GET" && (m = /^\\/repos\\/([\\w-]+\\/[\\w-]+)\\/installation$/.exec(req.url))) return byRepo[m[1]] ? send(200, { id: byRepo[m[1]] }) : send(404, { message: "Not Found" });
    if (req.method === "GET" && (m = /^\\/app\\/installations\\/(\\d+)$/.exec(req.url))) return inst[m[1]] ? send(200, { id: +m[1], account: { login: inst[m[1]].login } }) : send(404, { message: "Not Found" });
    if (req.method === "POST" && (m = /^\\/app\\/installations\\/(\\d+)\\/access_tokens$/.exec(req.url))) {
      if (!inst[m[1]]) return send(404, { message: "Not Found" });
      if (!b.repositories.every((x) => inst[m[1]].repos.includes(x))) return send(422, { message: "There is at least one repository that does not exist or is not accessible to the parent installation." });
      return send(201, { token: "${TOKEN}" });
    }
    send(404, { message: "Not Found" });
  });
}).listen(0, "127.0.0.1", function () { console.log(this.address().port); });
`;

(async () => {
  fs.writeFileSync(API_LOG, "");
  const server = spawn(process.execPath, ["-e", SERVER, API_LOG], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((res) => server.stdout.once("data", (d) => res(String(d).trim())));
  try { tests(`http://127.0.0.1:${port}`); } finally { server.kill(); }
  lib.summary();
})();

function tests(API) {
  const L = JSON.stringify(path.join(HOOKS, "proteus-lib.js"));
  const node = (code) => run("-", code, { cwd: W, env: { PROTEUS_GH_API: API } });
  const token = (repo) => { fs.writeFileSync(API_LOG, ""); return node(`require(${L}).appToken(${JSON.stringify(repo)}).then((t) => console.log(t === ${JSON.stringify(TOKEN)} ? "tok" : "bad"), (e) => console.log("err " + e.message))`).out.trim(); };
  const minted = () => (apiLog().find((x) => x.method === "POST") || {}).url;

  // ---- lib
  setApp({ installations: { O: 77, p: 88 } });
  let r = node(`console.log(JSON.stringify(require(${L}).verifierApp().installations))`);
  ok("lib: verifierApp reads installations by owner, lower-cased", r.out.trim() === '{"o":77,"p":88}', r.out + r.err);
  ok("lib: appToken uses the repo owner's installation", token("o/r") === "tok" && minted() === "/app/installations/77/access_tokens");
  ok("lib: and the other owner's for its repo, whatever the owner's case", token("P/s") === "tok" && minted() === "/app/installations/88/access_tokens");
  let t = token("q/x");
  ok("lib: an owner with no installation fails before GitHub, naming --verifier-app and the owner",
    /^err the App has no installation recorded for q: .*install\.js --verifier-app in a repo of q$/.test(t) && !apiLog().length, t);
  setApp({ installationId: 77 });
  ok("lib: an older config's lone installationId still serves its owner", token("o/r") === "tok" && minted() === "/app/installations/77/access_tokens");
  t = token("p/s");
  ok("lib: the lone id tried for another owner's repo fails with GitHub's reason and names --verifier-app",
    /^err POST \/app\/installations\/77\/access_tokens: HTTP 422 .*; if the App is not installed for p, .*--verifier-app in a repo of p$/.test(t), t);

  // ---- proteus-signoff.js in a repo whose owner has none
  setApp({ installations: { o: 77 } });
  const HEAD = "a".repeat(40);
  const PR = path.join(W, "pr.json"), LOG = path.join(W, "gh.log");
  fs.writeFileSync(PR, JSON.stringify({ head: HEAD, files: [], statuses: {} }));
  fs.writeFileSync(LOG, "");
  r = run(path.join(HOOKS, "proteus-signoff.js"), "", { cwd: W, args: ["5", HEAD, "MERGE", "--security"], env: { FAKE_GH_PR: PR, FAKE_GH_LOG: LOG, PROTEUS_GH_API: API, GITHUB_REPOSITORY: "q/x" } });
  ok("signoff: a repo whose owner has no installation fails loudly, names --verifier-app, posts nothing",
    r.code === 1 && /verifier App 42 gave no token \(the App has no installation recorded for q: .*--verifier-app/.test(r.err)
      && !fs.readFileSync(LOG, "utf8").split("\n").some((l) => l.startsWith("api -X POST ")), r.out + r.err);

  // ---- install.js
  const REPO = path.join(W, "repo");
  g(W, "init", "-q", "-b", "main", REPO);
  fs.writeFileSync(path.join(REPO, "a.txt"), "a\n");
  g(REPO, "add", "-A"); g(REPO, "commit", "-qm", "init");
  fs.mkdirSync(path.join(REPO, "teams"));
  const STATE = path.join(W, "gh-state.json");
  fs.writeFileSync(STATE, "{}");
  const inst = (args, repo = "o/r") => run(path.join(ROOT, "install.js"), "", { cwd: REPO, args, env: { USERPROFILE: HOME, FAKE_GH_STATE: STATE, FAKE_GH_REPO: repo, PROTEUS_GH_API: API } });
  fs.writeFileSync(PJ, JSON.stringify({ home: ROOT }));
  r = inst(["--verifier-app", "42", KEY]);
  ok("install --verifier-app: records the owner's installation in installations", r.code === 0 && JSON.stringify(cfg()) === JSON.stringify({ appId: 42, installations: { o: 77 }, keyPath: KEY }), r.out + r.err);
  r = inst(["--verifier-app", "42", KEY], "p/s");
  ok("install --verifier-app: run in another owner's repo adds that owner and keeps the first",
    r.code === 0 && JSON.stringify(cfg().installations) === '{"o":77,"p":88}' && /installation 88 for p; also o/.test(r.out), r.out + r.err);
  setApp({ installationId: 77 });
  r = inst(["--verifier-app", "42", KEY], "p/s");
  ok("install --verifier-app: an older lone installationId moves into the map under its account",
    r.code === 0 && JSON.stringify(cfg()) === JSON.stringify({ appId: 42, installations: { o: 77, p: 88 }, keyPath: KEY }), r.out + r.err + JSON.stringify(cfg()));
  setApp({ installationId: 77 });
  r = inst(["--verifier-app", "42", KEY]);
  ok("install --verifier-app: re-run in the lone id's own owner folds it in", r.code === 0 && JSON.stringify(cfg()) === JSON.stringify({ appId: 42, installations: { o: 77 }, keyPath: KEY }), r.out + r.err);
  setApp({ appId: 9, installations: { p: 88 } });
  r = inst(["--verifier-app", "42", KEY]);
  ok("install --verifier-app: another App replaces the old one's installations", r.code === 0 && JSON.stringify(cfg().installations) === '{"o":77}', r.out + r.err);

  setApp({ installations: { p: 88 } });
  r = inst(["--protect"]);
  ok("install --protect: in a repo whose owner has no installation it warns and names --verifier-app", r.code === 1 && /has no installation recorded for o, .*--verifier-app 42/.test(r.err), r.out + r.err);
  const rows = (x) => x.out.split("\n").filter((l) => /verifier App/.test(l)).join("|");
  setApp({ installations: { o: 77, p: 88 } });
  r = inst(["--doctor"], "p/s");
  ok("doctor: checks the token for the current repo's owner", /^ok\s+verifier App 42: a token mints for p\/s$/m.test(r.out), rows(r));
  setApp({ installations: { o: 77 } });
  r = inst(["--doctor"], "p/s");
  ok("doctor: a repo whose owner has none is a FIX naming --verifier-app", /^FIX\s+verifier App 42: no token for p\/s \(the App has no installation recorded for p.*--verifier-app/m.test(r.out), rows(r));
}

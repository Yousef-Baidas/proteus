// Local-model tests: node tests/local.test.js (needs git). proteus-delegate.js --tier local against a fake
// OpenAI-compatible server on 127.0.0.1 (its own process, so the synchronous runs here can reach it), which logs each
// request and answers by the mode file. Then next's optional local security check, which may only add the security
// verifier to a SPAWN line. No real model, no other network.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;

const HOOKS = path.join(__dirname, "..", "templates", "hooks");
const DELEGATE = path.join(HOOKS, "proteus-delegate.js");
const CLI = path.join(HOOKS, "proteus-cli.js");
const W = lib.workdir("local");
const TMPD = path.join(W, "tmp");
fs.mkdirSync(TMPD);
const TENV = { TMPDIR: TMPD, TEMP: TMPD, TMP: TMPD };
const CONFIG = path.join(lib.HOME, ".claude", "proteus.json");
const MODE = path.join(W, "mode.txt");
const LOG = path.join(W, "requests.jsonl");
const PORT = path.join(W, "port.txt");
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// ---- the fake local server
const SERVER = path.join(W, "server.js");
fs.writeFileSync(SERVER, `
const http = require("http"), fs = require("fs");
const [mode, log, port] = process.argv.slice(2);
const s = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => { body += d; });
  req.on("end", () => {
    fs.appendFileSync(log, JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }) + "\\n");
    const m = fs.existsSync(mode) ? fs.readFileSync(mode, "utf8").trim() : "yes";
    if (m === "hang") return;
    if (m === "500") { res.writeHead(500); return res.end("boom"); }
    if (m === "redirect") { res.writeHead(302, { location: "http://127.0.0.1:1/v1/chat/completions" }); return res.end(); }
    if (m === "junk") { res.writeHead(200); return res.end("not json"); }
    const content = { yes: "YES", no: "NO", maybe: "Maybe yes", ctrl: "a\\u001b[31mred\\u0007\\nline\\tend" }[m] || m;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: "local-test-model", choices: [{ index: 0, message: { role: "assistant", content } }] }));
  });
});
s.listen(0, "127.0.0.1", () => fs.writeFileSync(port, String(s.address().port)));
`);
const server = spawn(process.execPath, [SERVER, MODE, LOG, PORT], { stdio: "ignore", windowsHide: true });
process.on("exit", () => { try { server.kill(); } catch {} });
for (let i = 0; i < 100 && !fs.existsSync(PORT); i++) sleep(50);
const port = fs.existsSync(PORT) ? fs.readFileSync(PORT, "utf8").trim() : "";
ok("server: the fake local server is listening", /^\d+$/.test(port), port);
const BASE = `http://127.0.0.1:${port}`;

const mode = (m) => fs.writeFileSync(MODE, m);
const requests = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const resetLog = () => fs.rmSync(LOG, { force: true });
const config = (local) => fs.writeFileSync(CONFIG, JSON.stringify(local === undefined ? {} : { local }));

const REPO = path.join(W, "repo");
g(W, "init", "-q", "-b", "main", REPO);
fs.writeFileSync(path.join(REPO, "a.txt"), "a\n");
g(REPO, "add", "-A");
g(REPO, "commit", "-qm", "init");
const COMMON = path.join(REPO, ".git");
const PROMPT = path.join(W, "prompt.txt");
fs.writeFileSync(PROMPT, "pick one: A or B\n");

const go = (args, env = {}) => {
  const r = lib.run(DELEGATE, "", { cwd: REPO, env, args });
  let j = null;
  try { j = JSON.parse(r.out.trim()); } catch {}
  return { ...r, j };
};
const base = ["--tier", "local", "--prompt-file", PROMPT];

// ---- off by default
config(undefined);
resetLog();
let r = go(base);
ok("off: no local config is ok:false, exit 1, naming the config, and no request", r.code === 1 && r.j && r.j.ok === false && /local/.test(r.j.result) && r.j.tier === "local" && r.j.costUsd === 0 && requests().length === 0, r.out + r.err);
config({ endpoint: `http://user:pw@127.0.0.1:${port}`, model: "m" });
r = go(base);
ok("config: an endpoint carrying credentials is refused, no request", r.code === 1 && r.j && /credentials/.test(r.j.result) && requests().length === 0, r.out + r.err);
config({ endpoint: "file:///etc/passwd", model: "m" });
r = go(base);
ok("config: an endpoint that is not http(s) is refused", r.code === 1 && r.j && /http/.test(r.j.result) && requests().length === 0, r.out + r.err);
config({ endpoint: BASE });
r = go(base);
ok("config: no model is refused", r.code === 1 && r.j && /model/.test(r.j.result) && requests().length === 0, r.out + r.err);

// ---- a good call
config({ endpoint: BASE, model: "tiny" });
mode("yes");
resetLog();
r = go(base);
let q = requests()[0] || { headers: {}, body: "{}" };
let body = JSON.parse(q.body || "{}");
ok("call: exit 0 and one JSON line { ok, result, costUsd 0, model, tier local, depth }", r.code === 0 && r.j && r.j.ok === true && r.j.result === "YES" && r.j.costUsd === 0 && r.j.model === "local-test-model" && r.j.tier === "local" && r.j.depth === 0 && r.out.trim().split("\n").length === 1, r.out + r.err);
ok("call: one POST to /v1/chat/completions with the model and the prompt as the one user message", requests().length === 1 && q.method === "POST" && q.url === "/v1/chat/completions" && body.model === "tiny" && body.messages.length === 1 && body.messages[0].role === "user" && body.messages[0].content === "pick one: A or B\n", JSON.stringify(q));
ok("call: no tools and no credentials are sent", !("tools" in body) && !q.headers.authorization, JSON.stringify(q));
ok("call: --budget is not needed for local, and --tools is ignored", (resetLog(), go([...base, "--tools", "Bash"]).code === 0) && !("tools" in JSON.parse(requests()[0].body)));
config({ endpoint: `${BASE}/v1/`, model: "tiny" });
resetLog();
r = go(base);
ok("call: a base BASE ending in /v1 still calls /v1/chat/completions", r.code === 0 && (requests()[0] || {}).url === "/v1/chat/completions", JSON.stringify(requests()));

// ---- the key: only from the env var the config names
config({ endpoint: BASE, model: "tiny", keyEnv: "LOCAL_TEST_KEY", key: "never-sent" });
resetLog();
r = go(base, { LOCAL_TEST_KEY: "k-from-env" });
q = requests()[0] || { headers: {}, body: "" };
ok("key: the bearer comes from the named env var, nothing else from the file is sent", r.code === 0 && q.headers.authorization === "Bearer k-from-env" && !/never-sent/.test(JSON.stringify(q)), JSON.stringify(q));
resetLog();
go(base);
ok("key: an unset env var sends no authorization", !(requests()[0] || { headers: {} }).headers.authorization);
config({ endpoint: BASE, model: "tiny" });

// ---- schema
const SCHEMA = path.join(W, "schema.json");
fs.writeFileSync(SCHEMA, '{ "type": "object" }');
resetLog();
go([...base, "--schema", SCHEMA]);
body = JSON.parse((requests()[0] || { body: "{}" }).body);
ok("schema: carried as response_format json_schema", body.response_format && body.response_format.type === "json_schema" && body.response_format.json_schema.schema.type === "object", JSON.stringify(body));

// ---- failures fall back: ok:false, exit 1
for (const [m, re] of [["500", /HTTP 500/], ["junk", /not a chat completion/], ["redirect", /unreachable/]]) {
  mode(m);
  r = go(base);
  ok(`failure: ${m} is ok:false, exit 1`, r.code === 1 && r.j && r.j.ok === false && re.test(r.j.result) && r.j.costUsd === 0, r.out + r.err);
}
mode("hang");
r = go(base, { PROTEUS_DELEGATE_TIMEOUT_MS: "300" });
ok("failure: a hung server times out, ok:false, exit 1", r.code === 1 && r.j && /timed out/.test(r.j.result), r.out + r.err);
config({ endpoint: "http://127.0.0.1:1", model: "tiny" });
r = go(base);
ok("failure: an unreachable endpoint is ok:false, exit 1", r.code === 1 && r.j && /unreachable/.test(r.j.result), r.out + r.err);
config({ endpoint: BASE, model: "tiny" });
mode("ctrl");
r = go(base);
ok("result: control characters are stripped, newlines and tabs kept", r.code === 0 && r.j.result === "a[31mred\nline\tend", JSON.stringify(r.j));

// ---- depth, harness, ledger
mode("yes");
resetLog();
r = go(base, { PROTEUS_DELEGATE_DEPTH: "3" });
ok("depth: 3 is refused and nothing is sent", r.code === 1 && /depth/.test(r.j.result) && requests().length === 0, r.out);
r = go(base, { PROTEUS_HARNESS: "codex" });
ok("harness: on Codex the local call works the same", r.code === 0 && r.j.ok === true && r.j.tier === "local", r.out + r.err);
const LEDGER = path.join(COMMON, "proteus", "scratch", "r7", "delegate-ledger.jsonl");
go([...base, "--run", "r7"]);
mode("500");
go([...base, "--run", "r7"]);
const rows = fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
ok("ledger: local calls record tier local and costUsd 0, failed ones too", rows.length === 2 && rows.every((x) => x.tier === "local" && x.costUsd === 0) && rows[0].ok === true && rows[1].ok === false, JSON.stringify(rows));

// ---- next: the local security check only adds the security verifier
g(REPO, "checkout", "-q", "-b", "proteus/r1");
fs.mkdirSync(path.join(REPO, ".proteus", "owned"), { recursive: true });
for (let n = 1; n <= 3; n++) fs.writeFileSync(path.join(REPO, ".proteus", "owned", String(n)), `src/t${n}.js\n`);
g(REPO, "add", "-A");
g(REPO, "commit", "-qm", "records");
g(REPO, "checkout", "-q", "main");
g(REPO, "remote", "add", "origin", "https://github.com/o/r.git");
const STATE = path.join(W, "gh.json");
const ms = { title: "r1/core", number: 1 };
const issue = (n) => ({ number: n, title: `ticket ${n}`, state: "OPEN", milestone: ms, labels: [{ name: "proteus" }, { name: "profile:backend" }, { name: "difficulty:standard" }], body: `Owned: src/t${n}.js` });
const SHA = (c) => c.repeat(40);
const pr = (n, ticket, sha, checks = []) => ({ number: n, headRefName: `proteus-work/r1/${ticket}`, headRefOid: sha, body: `Closes #${ticket}`, isDraft: false, statusCheckRollup: checks, diff: `diff --git a/src/t${ticket}.js b/src/t${ticket}.js\n+change ${sha.slice(0, 4)}\n` });
const RED = { __typename: "StatusContext", context: "proteus/security", state: "FAILURE" };
const VERDICT = { __typename: "StatusContext", context: "proteus/verdict", state: "SUCCESS" };
const next = (prs) => {
  fs.writeFileSync(STATE, JSON.stringify({ issues: [issue(1), issue(2), issue(3)], prs, reviews: [], inbox: [] }));
  return lib.run(CLI, "", { cwd: REPO, args: ["next", "r1"], env: { FAKE_GH_NEXT: STATE, ...TENV } });
};
const spawnLine = (r, n) => r.out.split("\n").find((l) => l.startsWith(`SPAWN verifier PR#${n} `)) || "";
const CACHE = path.join(COMMON, "proteus", "scratch", "r1", "local-security.json");

config(undefined);
resetLog();
r = next([pr(13, 2, SHA("b"))]);
const plainLine = spawnLine(r, 13);
ok("next off: the SPAWN line is as before, no request and no cache", r.code === 0 && plainLine === `SPAWN verifier PR#13 #2 head=${SHA("b").slice(0, 12)} brief: node ${CLI} brief verifier 13 r1` && requests().length === 0 && !fs.existsSync(CACHE), r.out + r.err);

config({ endpoint: BASE, model: "tiny" });
mode("yes");
resetLog();
r = next([pr(13, 2, SHA("b"))]);
ok("next: a YES adds security=local to the SPAWN line", spawnLine(r, 13) === `SPAWN verifier PR#13 #2 head=${SHA("b").slice(0, 12)} security=local brief: node ${CLI} brief verifier 13 r1`, r.out + r.err);
const sent = JSON.parse((requests()[0] || { body: "{}" }).body);
ok("next: the local model saw the PR's diff with the one-word question", requests().length === 1 && /YES or NO/.test(sent.messages[0].content) && /\+change bbbb/.test(sent.messages[0].content), JSON.stringify(sent));
r = next([pr(13, 2, SHA("b"))]);
ok("next: once per head, the second call asks nothing and keeps the flag", requests().length === 1 && / security=local /.test(spawnLine(r, 13)), r.out);
r = next([pr(13, 2, SHA("c"))]);
ok("next: a new head asks again", requests().length === 2 && / security=local /.test(spawnLine(r, 13)), r.out);
r = lib.run(CLI, "", { cwd: REPO, args: ["next", "r1", "--json"], env: { FAKE_GH_NEXT: STATE, ...TENV } });
ok("next --json: the action carries security: local", /"security": "local"/.test(r.out), r.out);

for (const [m, why] of [["no", "a NO"], ["maybe", "an answer that is not YES"], ["500", "a failed call"]]) {
  mode(m);
  r = next([pr(14, 3, SHA(m === "no" ? "d" : m === "maybe" ? "e" : "f"))]);
  ok(`next: ${why} changes nothing`, r.code === 0 && spawnLine(r, 14) && !/security=/.test(spawnLine(r, 14)), r.out + r.err);
}
mode("yes");
resetLog();
r = next([pr(15, 1, SHA("1"), [RED])]);
ok("next: a PR CI already marked for the security verifier is not asked about", requests().length === 0 && !/security=/.test(spawnLine(r, 15)), r.out);
r = next([pr(16, 1, SHA("2"), [VERDICT])]);
ok("next: a PR with a verdict gets no SPAWN line and no local call", requests().length === 0 && !spawnLine(r, 16), r.out);
config({ endpoint: "http://127.0.0.1:1", model: "tiny" });
r = next([pr(17, 1, SHA("3"))]);
ok("next: an unreachable local model changes nothing", r.code === 0 && spawnLine(r, 17) && !/security=/.test(spawnLine(r, 17)), r.out + r.err);

server.kill();
lib.summary();

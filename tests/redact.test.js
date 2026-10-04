// Journal redaction tests: node tests/redact.test.js (needs git). The lead's journal keeps the human's
// messages with secrets replaced by [redacted], and the compaction recall never re-injects one.
// Temp repo; never touches the network.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "templates", "hooks");
const lib = require(path.join(__dirname, "lib.js"));
const { ok, g } = lib;
const W = lib.workdir("redact");
const { redact } = require(path.join(SRC, "proteus-lib.js"));

// test secrets are assembled at run time so this file itself trips no secret scanner
const x = (n, c = "a") => c.repeat(n);
const SECRETS = {
  "GitHub classic": "ghp_" + x(36, "A1"),
  "GitHub OAuth": "gho_" + x(36),
  "GitHub user-to-server": "ghu_" + x(36),
  "GitHub server-to-server": "ghs_" + x(36),
  "GitHub refresh": "ghr_" + x(36),
  "GitHub fine-grained": "github_pat_" + x(22, "B") + "_" + x(59, "c"),
  Anthropic: "sk-ant-api03-" + x(40, "Zz9-"),
  OpenAI: "sk-proj-" + x(40, "Q"),
  AWS: "AKIA" + x(16, "Z"),
  Slack: "xoxb-" + "1234567890-" + x(24, "s"),
  JWT: "eyJ" + x(20, "h") + "." + x(30, "p") + "." + x(30, "g"),
};
for (const [kind, s] of Object.entries(SECRETS)) {
  const out = redact(`use ${s} for this`);
  ok(`redact: ${kind}`, out === "use [redacted] for this", out);
}

const KEY = "-----BEGIN RSA PRIVATE KEY-----\n" + x(64, "M") + "\n" + x(64, "N") + "\n-----END RSA PRIVATE KEY-----";
ok("redact: a private key block, end marker and all", redact(`key:\n${KEY}\nthanks`) === "key:\n[redacted]\nthanks", redact(`key:\n${KEY}\nthanks`));
ok("redact: an unterminated private key block runs to the end", redact("x -----BEGIN OPENSSH PRIVATE KEY-----\nabc\ndef") === "x [redacted]");
ok("redact: Authorization headers, any scheme", redact('curl -H "Authorization: Bearer abc.def-123" x') === 'curl -H "Authorization: [redacted]" x' &&
  redact("authorization=token 0123456789") === "authorization=[redacted]", redact('curl -H "Authorization: Bearer abc.def-123" x'));
ok("redact: a bare long Bearer token", redact("send Bearer " + x(30, "t") + " please") === "send Bearer [redacted] please");
ok("redact: password, secret, token and api_key assignments",
  redact("password=hunter2 DB_PASSWORD: s3cr3t client_secret = 'abc' GITHUB_TOKEN=xyz api_key=k1 apiKey: k2") ===
  "password=[redacted] DB_PASSWORD: [redacted] client_secret = '[redacted]' GITHUB_TOKEN=[redacted] api_key=[redacted] apiKey: [redacted]",
  redact("password=hunter2 DB_PASSWORD: s3cr3t client_secret = 'abc' GITHUB_TOKEN=xyz api_key=k1 apiKey: k2"));
ok("redact: JSON and query-string assignments", redact('{"token": "abc123", "n": 1}') === '{"token": "[redacted]", "n": 1}' && redact("/cb?api_key=abc&page=2") === "/cb?api_key=[redacted]&page=2", redact('{"token": "abc123", "n": 1}'));
const PLAIN = "Fix the login page: tokens expire after max_tokens=4000, see task-list and risk-free sk-8 notes; the secret sauce is tests. https://github.com/o/r/pull/12";
ok("redact: ordinary text unchanged (max_tokens, task-, risk-, short sk-)", redact(PLAIN) === PLAIN, redact(PLAIN));

// linear time: long adversarial inputs finish fast
const t0 = Date.now();
for (const s of ["a".repeat(200000), "a-".repeat(100000), "password".repeat(25000), "-----BEGIN PRIVATE KEY-----".repeat(5000), "eyJ" + "a".repeat(200000), ("token " + " ".repeat(4)).repeat(20000), "Authorization: ".repeat(20000)]) redact(s);
ok("redact: adversarial 200 kB inputs take well under a second in total", Date.now() - t0 < 1000, `${Date.now() - t0} ms`);

// the hook: journal on disk holds the redacted prompt; the compaction recall shows no secret
const REPO = path.join(W, "repo");
fs.mkdirSync(path.join(REPO, ".claude", "skills", "proteus"), { recursive: true });
fs.writeFileSync(path.join(REPO, ".claude", "skills", "proteus", "SKILL.md"), "---\nname: proteus\n---\nSKILL BODY\n");
g(W, "init", "-q", "-b", "main", REPO);
const JOURNAL = path.join(REPO, ".git", "proteus", "journal.jsonl");
const say = (prompt) => lib.run(path.join(SRC, "proteus-journal.js"), { hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: REPO, prompt }, { cwd: REPO });
const GH = SECRETS["GitHub classic"];
let r = say(`here is my token ${GH}, deploy with AWS ${SECRETS.AWS}`);
const rec = fs.readFileSync(JOURNAL, "utf8").trim().split("\n").map((l) => JSON.parse(l));
ok("journal: the hook exits 0", r.code === 0, r.err);
ok("journal: the stored prompt is redacted, the rest verbatim", rec.length === 1 && rec[0].prompt === "here is my token [redacted], deploy with AWS [redacted]", JSON.stringify(rec));
ok("journal: no secret bytes anywhere in the file", !fs.readFileSync(JOURNAL, "utf8").includes(GH.slice(4)));

// a journal written before redaction: the recall redacts on the way out
fs.appendFileSync(JOURNAL, JSON.stringify({ ts: "2026-01-01T00:00:00Z", session_id: "old", prompt: `old one: ${SECRETS.Anthropic}` }) + "\n");
r = lib.run(path.join(SRC, "proteus-autostart.js"), { hook_event_name: "SessionStart", source: "compact", session_id: "s1", cwd: REPO }, { cwd: REPO, env: { FAKE_GH: "fail" } });
ok("recall: after compaction the human's words come back redacted", /human said/.test(r.out) && r.out.includes("- old one: [redacted]") && r.out.includes("here is my token [redacted]") && !r.out.includes(SECRETS.Anthropic) && !r.out.includes(GH), r.out.slice(0, 1200));

lib.summary();

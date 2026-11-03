// The human's verdicts in local mode (#310): node tests/localverdict.test.js. The record decides and no store comment
// does; both ways into it (the dialog's pending entry and the human's terminal); held, proteus-verdict.js and `pr merge`
// reading it on a security change into the default branch; a damaged record; no PR into a run branch waiting for the
// human (#368), a security one for the security verifier; and outside local mode, comments still decide.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SRC = path.join(__dirname, "..", "templates", "hooks");
const lib = require(path.join(__dirname, "lib.js"));
const { ok } = lib;
const W = lib.workdir("localverdict");
const hooksLib = require(path.join(SRC, "proteus-lib.js"));
const HELD = path.join(W, "held.js");
fs.writeFileSync(HELD, `const path = require("path"), [hooks, n] = process.argv.slice(2);
console.log(JSON.stringify(require(path.join(hooks, "proteus-policy.js")).held([{ n: Number(n) }], process.cwd())));
`);
const ROUTING = "# Routing\n\n```security\n**/auth/**\n```\n";

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const asked = (r) => { try { return JSON.parse(r.out).hookSpecificOutput.permissionDecision === "ask"; } catch { return false; } };
let tu = 0;

function repo(name, routing = "") {
  const dir = path.join(W, name);
  fs.mkdirSync(dir, { recursive: true });
  lib.g(dir, "init", "-q", "-b", "main");
  lib.g(dir, "config", "user.name", "Repo Person");
  lib.g(dir, "config", "user.email", "repo@example.com");
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "# Agents\n\n## Learned\n- gate: `node gate.js`\n");
  fs.writeFileSync(path.join(dir, "gate.js"), "\n");
  if (routing) { fs.mkdirSync(path.join(dir, "teams")); fs.writeFileSync(path.join(dir, "teams", "ROUTING.md"), routing); }
  lib.g(dir, "add", ".");
  lib.g(dir, "commit", "-q", "-m", "init");
  const hooks = path.join(dir, ".claude", "hooks");
  fs.cpSync(SRC, hooks, { recursive: true });
  const H = (s) => path.join(hooks, s);
  const r = { dir, hooks, H, common: path.join(dir, ".git"), lead: path.join(dir, ".git", "proteus-lead"), n: 0 };
  r.env = { CLAUDE_PROJECT_DIR: dir };
  r.gh = (args, input = "") => lib.run(H("proteus-local.js"), input, { cwd: dir, args, env: r.env });
  const made = r.gh(["--init"]);
  if (made.code !== 0) throw new Error(made.err);
  lib.g(dir, "push", "-q", "origin", "main");
  fs.mkdirSync(r.lead, { recursive: true });
  fs.writeFileSync(path.join(r.lead, "hooks-root"), hooks);
  r.record = path.join(r.lead, "verdicts.jsonl");
  r.pending = path.join(r.lead, "verdict-pending");
  // an open PR whose head is green
  r.open = (file = `f${++r.n}.txt`) => {
    const branch = `b-${file.replace(/\W/g, "-")}`;
    lib.g(dir, "checkout", "-q", "-b", branch, "main");
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), "x\n");
    lib.g(dir, "add", file);
    lib.g(dir, "commit", "-q", "-m", `feat: ${file}`);
    const sha = lib.g(dir, "rev-parse", "HEAD");
    lib.g(dir, "push", "-q", "origin", `${sha}:refs/heads/hold-${branch}`);
    r.status(sha, "pending");
    lib.g(dir, "push", "-q", "origin", `${branch}:${branch}`);
    lib.g(dir, "checkout", "-q", "main");
    const out = r.gh(["pr", "create", "--base", "main", "--head", branch, "--title", `t ${branch}`, "--body", "b"]);
    r.status(sha, "success");
    return { sha, short: sha.slice(0, 12), branch, n: Number(/\/pull\/(\d+)$/.exec(out.out.trim())[1]) };
  };
  r.status = (sha, state) => r.gh(["api", "-X", "POST", `repos/{owner}/{repo}/statuses/${sha}`, "-f", `state=${state}`, "-f", "context=gates", "-f", "description=d"]);
  r.push = (p) => {
    lib.g(dir, "checkout", "-q", p.branch);
    fs.appendFileSync(path.join(dir, "moved.txt"), "y\n");
    lib.g(dir, "add", "moved.txt");
    lib.g(dir, "commit", "-q", "-m", "feat: more");
    const sha = lib.g(dir, "rev-parse", "HEAD");
    lib.g(dir, "push", "-q", "origin", `${sha}:refs/heads/hold-m-${sha}`);
    r.status(sha, "pending");
    lib.g(dir, "push", "-q", "origin", `${p.branch}:${p.branch}`);
    lib.g(dir, "checkout", "-q", "main");
    r.status(sha, "success");
    return sha;
  };
  r.policy = (o) => {
    fs.mkdirSync(path.join(dir, "teams"), { recursive: true });
    fs.writeFileSync(path.join(dir, "teams", "policy.json"), JSON.stringify({ version: 1, ...o }));
  };
  r.state = (p) => r.gh(["pr", "view", String(p.n), "--json", "state", "-q", ".state"]).out.trim();
  r.merge = (p) => r.gh(["pr", "merge", String(p.n), "--merge"]);
  // in a process of its own, as lib.gh finds the stand-in from the hooks it runs from
  r.held = (p) => JSON.parse(lib.run(HELD, "", { cwd: dir, args: [hooks, String(p.n)], env: r.env }).out);
  r.comment = (n, body, kind = "pr") => r.gh([kind, "comment", String(n), "--body-file", "-"], body);
  r.verdict = (n, ...a) => lib.run(H("proteus-verdict.js"), "", { cwd: dir, args: [String(n), ...a], env: r.env });
  r.body = (text, name = `v${++r.n}.md`) => { const f = path.join(dir, name); fs.writeFileSync(f, text); return f; };
  // the --post call for text: command line, file
  r.cmd = (n, text) => { const f = r.body(text); return { file: f, command: `node ${JSON.stringify(H("proteus-verdict.js").replace(/\\/g, "/"))} ${n} --post --body-file ${JSON.stringify(f.replace(/\\/g, "/"))} --sha ${sha256(text)}` }; };
  r.event = (name, command, who = {}) => ({ hook_event_name: name, session_id: "s1", cwd: dir, tool_name: "Bash", tool_input: { command }, tool_use_id: `toolu_${tu}`, permission_mode: "default", ...who });
  r.ask = (command, who = {}) => { tu++; return lib.run(H("proteus-lead-guard.js"), r.event("PreToolUse", command, who), { cwd: dir, env: { ...r.env, PROTEUS: "0" } }); };
  r.after = (command, who = {}, name = "PostToolUse") => lib.run(H("proteus-verdict-record.js"), r.event(name, command, who), { cwd: dir, env: { ...r.env, PROTEUS: "0" } });
  r.terminal = (n, text) => { const c = r.cmd(n, text); return r.verdict(n, "--post", "--body-file", c.file, "--sha", sha256(text)); };
  r.lines = () => hooksLib.verdictRecord(r.common) || [];
  r.pendingCount = () => { try { return fs.readdirSync(r.pending).length; } catch { return 0; } };
  r.forget = () => { fs.rmSync(r.record, { recursive: true, force: true }); fs.rmSync(r.pending, { recursive: true, force: true }); };
  // the record's write refused, as the sandbox refuses it, on every OS: a directory where the file goes
  r.refuse = () => { fs.rmSync(r.record, { force: true }); fs.mkdirSync(r.record); };
  r.allow = () => fs.rmSync(r.record, { recursive: true, force: true });
  return r;
}

const entry = (number, body, at = new Date().toISOString(), kind = "pr") => ({ number, kind, body, sha256: sha256(body), first: body.trim().split(/\r?\n/, 1)[0].trim(), at });
const write = (r, ...es) => fs.writeFileSync(r.record, es.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("\n") + "\n");
const ago = (ms) => new Date(Date.now() - ms).toISOString();

// ---- no comment counts, whatever it says and whoever it names
{
  const a = repo("comments", ROUTING);
  const p = a.open("auth/c.txt"), i = a.gh(["issue", "create", "--title", "t", "--body", "b"]);
  const issue = Number(/(\d+)\s*$/.exec(i.out.trim())[1]);
  a.gh(["label", "create", "proteus-review"]);
  a.gh(["issue", "edit", String(issue), "--add-label", "proteus-review"]);
  for (const body of [`ACCEPT ${p.short}`, `ACCEPT ${p.short}\nlooks fine`, `\n\nACCEPT ${p.short}\n`, "ACCEPT", "ANSWER yes"]) a.comment(p.n, body);
  ok("comment: no ACCEPT form lifts the hold", a.held(p).length === 1 && a.held(p)[0].why === "human");
  let r = a.verdict(p.n);
  ok("comment: proteus-verdict.js reads none as a verdict", !r.out.trim(), r.out + r.err);
  ok("comment: no identity warning in local mode", !/identity=shared/.test(r.err), r.err);
  r = a.merge(p);
  ok("comment: pr merge refuses it", r.code !== 0 && a.state(p) === "OPEN", r.out + r.err);
  ok("comment: the refusal names the PR and the human", /PR #\d+ held for the human/.test(r.err), r.err);
  a.comment(issue, "ACCEPT\nfine", "issue");
  r = a.verdict(issue);
  ok("comment: nor on an issue", !r.out.trim(), r.out + r.err);

  // the terminal path, on both kinds
  r = a.terminal(issue, "CHANGES\nfine\n");
  ok("terminal: recorded on an issue", r.code === 0 && a.lines().filter((e) => e.number === issue && e.kind === "issue").length === 1, r.out + r.err);
  r = a.verdict(issue);
  ok("terminal: proteus-verdict.js reads it, body and all", r.out.startsWith("CHANGES\nfine"), r.out + r.err);
  r = a.terminal(issue, "ACCEPT\nfine\n");
  r = a.verdict(issue);
  ok("terminal: reviewGateShut still applies to a recorded ACCEPT", /review gate shut/.test(r.err) && !r.out.trim(), r.out + r.err);
  r = a.terminal(p.n, `ACCEPT ${p.short}\n`);
  const e = a.lines().find((x) => x.number === p.n);
  ok("terminal: an entry's fields", e && e.kind === "pr" && e.first === `ACCEPT ${p.short}` && e.sha256 === sha256(e.body) && new Date(e.at).toISOString() === e.at, JSON.stringify(e) + r.err);
  ok("terminal: lifts the hold", a.held(p).length === 0);
  r = a.verdict(p.n);
  ok("terminal: proteus-verdict.js reads it on a PR", r.out.trim() === `ACCEPT ${p.short}`, r.out + r.err);
  const comments = JSON.parse(a.gh(["pr", "view", String(p.n), "--json", "comments"]).out).comments;
  ok("terminal: still writes the comment, for reading", comments.some((c) => c.body.trim() === `ACCEPT ${p.short}`));
  r = a.terminal(p.n, `ACCEPT ${p.short}\n`);
  ok("terminal: the same post twice is one verdict", r.code === 0 && a.lines().filter((x) => x.number === p.n).length === 1, r.err);
  r = a.merge(p);
  ok("terminal: pr merge takes the accepted head", r.code === 0 && a.state(p) === "MERGED", r.out + r.err);
}

// ---- the dialog's pending entry
{
  const a = repo("pending");
  const p = a.open();
  const text = `ACCEPT ${p.short}\nwhy\n`;
  let c = a.cmd(p.n, text);
  let r = a.ask(c.command);
  ok("pending: the post asks", asked(r), r.out + r.err);
  ok("pending: nothing recorded yet", a.lines().length === 0 && a.pendingCount() === 1);
  r = a.after("node something-else.js");
  ok("pending: a different command records nothing", a.lines().length === 0 && a.pendingCount() === 1, r.err);
  a.after(c.command, {}, "PostToolUseFailure");
  ok("pending: a failed tool records nothing", a.lines().length === 0);
  a.after(c.command, { error: "exit 1" });
  ok("pending: an errored event records nothing", a.lines().length === 0);
  a.after(c.command, { agent_id: "a1", agent_type: "proteus-worker" });
  ok("pending: an agent's event records nothing", a.lines().length === 0);
  a.after(c.command, { teammate_name: "t1" });
  ok("pending: a teammate's event records nothing", a.lines().length === 0);
  a.after(c.command, { session_id: "other" });
  ok("pending: another session's event records nothing", a.lines().length === 0);
  a.after(c.command, { tool_use_id: "toolu_other" });
  ok("pending: another call's event records nothing", a.lines().length === 0);
  // the file changes after the dialog: the record keeps what the human saw
  fs.writeFileSync(c.file, "ACCEPT\nsomething else\n");
  a.after(c.command);
  ok("pending: the matching call records once, the body from the entry", a.lines().length === 1 && a.lines()[0].body === text, JSON.stringify(a.lines()));
  ok("pending: the entry is gone", a.pendingCount() === 0);
  a.after(c.command);
  ok("pending: a replay records nothing", a.lines().length === 1);

  a.forget();
  c = a.cmd(p.n, text);
  a.after(c.command);
  ok("pending: no entry, no record", a.lines().length === 0);

  // expired
  a.ask(c.command);
  const f = path.join(a.pending, fs.readdirSync(a.pending)[0]);
  const stale = { ...JSON.parse(fs.readFileSync(f, "utf8")), at: ago(2 * 3600e3) };
  fs.writeFileSync(f, JSON.stringify(stale));
  a.after(c.command);
  ok("pending: an expired entry records nothing", a.lines().length === 0);
  const next = a.cmd(p.n, `CHANGES\nfix\n`);
  a.ask(next.command);
  ok("pending: the next post clears what went stale", a.pendingCount() === 1 && !fs.existsSync(f));
  a.after(next.command);
  ok("pending: a CHANGES records the same way", a.lines().length === 1 && a.lines()[0].first === "CHANGES");

  // a forged entry fails the same checks a record line does
  a.forget();
  c = a.cmd(p.n, text);
  a.ask(c.command);
  const g = path.join(a.pending, fs.readdirSync(a.pending)[0]);
  fs.writeFileSync(g, JSON.stringify({ ...JSON.parse(fs.readFileSync(g, "utf8")), body: "ACCEPT other\n" }));
  a.after(c.command);
  ok("pending: an entry whose body does not fit its sha records nothing", a.lines().length === 0);

  // both ways at once count once: an unsandboxed post, then the hook
  a.forget();
  c = a.cmd(p.n, text);
  a.ask(c.command);
  r = a.verdict(p.n, "--post", "--body-file", c.file, "--sha", sha256(text));
  a.after(c.command);
  ok("pending: the script's write and the hook's are one verdict", r.code === 0 && a.lines().length === 1 && a.pendingCount() === 0, r.err);

  // sandboxed: the record refused, a pending entry for this exact post
  a.forget();
  c = a.cmd(p.n, text);
  a.ask(c.command);
  a.refuse();
  r = a.verdict(p.n, "--post", "--body-file", c.file, "--sha", sha256(text));
  ok("refused with a pending entry: silent, the comment goes out", r.code === 0 && !r.err.trim(), r.err);
  a.allow();
  a.after(c.command);
  ok("refused with a pending entry: the hook records it", a.lines().length === 1);

  // no entry for this post: nothing recorded, nothing posted
  a.forget();
  const before = JSON.parse(a.gh(["pr", "view", String(p.n), "--json", "comments"]).out).comments.length;
  a.refuse();
  c = a.cmd(p.n, text);
  r = a.verdict(p.n, "--post", "--body-file", c.file, "--sha", sha256(text));
  ok("refused without one: says so, exit 1", r.code === 1 && /nothing recorded/.test(r.err), r.code + r.err);
  ok("refused without one: no comment either", JSON.parse(a.gh(["pr", "view", String(p.n), "--json", "comments"]).out).comments.length === before);
  const other = a.cmd(p.n, `CHANGES\nother\n`);
  a.allow();
  a.ask(other.command);
  a.refuse();
  r = a.verdict(p.n, "--post", "--body-file", c.file, "--sha", sha256(text));
  ok("refused: another post's entry does not pass this one", r.code === 1 && /nothing recorded/.test(r.err), r.err);
  a.allow();
  a.forget();

  // the hook cannot write: the model hears it
  c = a.cmd(p.n, text);
  a.ask(c.command);
  a.refuse();
  r = a.after(c.command);
  ok("hook: a refused write is reported", /not recorded/.test(r.out + r.err), r.out + r.err);
  a.allow();
  a.forget();

  // a failed comment still leaves the record, and says so
  const standIn = a.H("proteus-local.js"), real = fs.readFileSync(standIn, "utf8");
  fs.writeFileSync(standIn, `if (process.argv.includes("comment")) { console.error("store refused"); process.exit(1); }\n${real.replace(/^#!.*\n/, "")}`);
  c = a.cmd(p.n, text);
  r = a.verdict(p.n, "--post", "--body-file", c.file, "--sha", sha256(text));
  fs.writeFileSync(standIn, real);
  ok("comment failed: recorded, says so, exit 1", r.code === 1 && /recorded, but its comment failed: store refused/.test(r.err) && a.lines().length === 1, r.code + r.err);
  a.forget();

  // an agent and a teammate are refused before any entry is written
  a.forget();
  c = a.cmd(p.n, text);
  r = a.ask(c.command, { agent_id: "a1", agent_type: "proteus-worker" });
  ok("agent: denied, no entry", !asked(r) && a.pendingCount() === 0, r.out + r.err);
  r = a.ask(c.command, { teammate_name: "t1" });
  ok("teammate: denied, no entry", !asked(r) && a.pendingCount() === 0, r.out + r.err);

  // no way to ask: the terminal gets it, and nothing is pending
  r = lib.run(a.H("proteus-lead-guard.js"), a.event("PreToolUse", c.command), { cwd: a.dir, env: { ...a.env, PROTEUS: "0", PROTEUS_HARNESS: "codex", CODEX_HOME: path.join(W, "codex-home") } });
  ok("no dialog: denied, the terminal named, no entry", !asked(r) && /own terminal, where it records/.test(r.out + r.err) && a.pendingCount() === 0, r.out + r.err);
}

// ---- reading
{
  const a = repo("reading", ROUTING);
  const p = a.open("auth/r.txt");
  write(a, entry(p.n, "ACCEPT 000000000000\n"));
  ok("read: ACCEPT of an old head holds", a.held(p).length === 1);
  write(a, entry(p.n, `ACCEPT ${p.short}\n`, ago(2000)), entry(p.n, "CHANGES\nno\n", ago(1000)));
  ok("read: CHANGES after ACCEPT holds", a.held(p).length === 1);
  write(a, entry(p.n, "CHANGES\nno\n", ago(1000)), entry(p.n, `ACCEPT ${p.short}\n`, ago(2000)));
  ok("read: file order decides, not the time", a.held(p).length === 0);
  write(a, entry(p.n + 1, `ACCEPT ${p.short}\n`));
  ok("read: another number's verdict is not this one's", a.held(p).length === 1);

  // AUTO comments merge by time
  fs.rmSync(a.record);
  a.comment(p.n, "AUTO-HOLD needs a look");
  let r = a.verdict(p.n);
  ok("auto: read from the store", r.out.startsWith("AUTO-HOLD"), r.out + r.err);
  write(a, entry(p.n, "CHANGES\nolder\n", ago(3600e3)));
  r = a.verdict(p.n);
  ok("auto: newer than the human's", r.out.startsWith("AUTO-HOLD"), r.out);
  write(a, entry(p.n, "CHANGES\nnewer\n", new Date(Date.now() + 1000).toISOString()));
  r = a.verdict(p.n);
  ok("auto: older than the human's", r.out.startsWith("CHANGES\nnewer"), r.out);

  // a damaged record
  const good = entry(p.n, `ACCEPT ${p.short}\n`);
  for (const [name, bad] of [
    ["malformed line", "{not json"], ["array", "[1]"], ["wrong sha", { ...good, sha256: "0".repeat(64) }],
    ["string number", { ...good, number: String(p.n) }], ["unknown kind", { ...good, kind: "x" }], ["forged first line", { ...good, first: "ACCEPT other" }],
    ["bad time", { ...good, at: "yesterday" }], ["not a verdict", entry(p.n, "hello\n")], ["oversized body", entry(p.n, `ACCEPT ${p.short}\n${"x".repeat(1 << 17)}`)],
  ]) {
    write(a, bad);
    ok(`record: ${name} counts for nothing`, a.held(p).length === 1 && hooksLib.verdictRecord(a.common).length === 0);
    write(a, bad, good);
    ok(`record: past ${name}, the rest still reads`, a.held(p).length === 0);
  }
  fs.writeFileSync(a.record, "x".repeat((1 << 24) + 1));
  ok("record: over the size cap reads as unreadable", hooksLib.verdictRecord(a.common) === null && a.held(p).length === 1);
  r = a.terminal(p.n, `ACCEPT ${p.short}\n`);
  ok("record: over the cap, nothing is appended", r.code === 1 && /nothing recorded/.test(r.err), r.err);
  fs.rmSync(a.record);
  const elsewhere = path.join(W, "elsewhere.jsonl");
  fs.writeFileSync(elsewhere, JSON.stringify(good) + "\n");
  let linked = true;
  try { fs.symlinkSync(elsewhere, a.record); } catch { linked = false; }
  if (linked) {
    ok("record: a link reads as unreadable", hooksLib.verdictRecord(a.common) === null && a.held(p).length === 1);
    fs.rmSync(a.record);
  }
  const big = `ACCEPT ${p.short}\n${"x".repeat(1 << 17)}`;
  r = a.terminal(p.n, big);
  ok("record: a body over the cap is refused", r.code === 1 && a.lines().length === 0, r.code + r.err);
}

// ---- pr merge: no PR waits for the human but a security change into the default branch (#368)
{
  const a = repo("merge");
  a.policy({ merge: "human", ask: "every", rules: [{ id: "keep-out", effect: "ask", tool: "edit", paths: ["src/hard/**"], why: "w" }] });
  let p = a.open("src/hard/a.txt"), r = a.merge(p);
  ok("merge: a retired merge human or ask every, or an ask rule, holds no green PR", r.code === 0 && a.state(p) === "MERGED", r.out + r.err);

  // a security path, held for the human into the default branch. The block is the base's, as proteus-security.js reads it
  ok("security: no ROUTING.md on the base, no hold", a.held(a.open("src/auth/key.txt")).length === 0);
  const s = repo("security", ROUTING);
  const accept = (q) => write(s, ...s.lines(), entry(q.n, `ACCEPT ${q.short}\n`));
  const none = s.open("src/open.txt");
  ok("security: a path outside the block is not held", s.held(none).length === 0);
  let q = s.open("src/auth/key.txt");
  let h = s.held(q);
  ok("security: a path in the block is held for the human into the default branch", h.length === 1 && h[0].why === "human" && h[0].sha === q.short, JSON.stringify(h));
  r = s.merge(q);
  ok("security: pr merge refuses it, saying why", r.code !== 0 && /held for the human/.test(r.err) && /security block/.test(r.err) && /ACCEPT <sha12>/.test(r.err) && s.state(q) === "OPEN", r.err);
  write(s, entry(q.n, "ACCEPT 000000000000\n"));
  ok("security: an old head's ACCEPT holds", s.held(q).length === 1);
  accept(q);
  const stale = { ...q, sha: s.push(q) };
  r = s.merge(stale);
  ok("security: head moved past the ACCEPT holds", r.code !== 0 && s.state(q) === "OPEN", r.out + r.err);
  q = s.open("src/auth/key2.txt");
  accept(q);
  r = s.merge(q);
  ok("security: the recorded ACCEPT merges it", r.code === 0 && s.state(q) === "MERGED", r.out + r.err);
  lib.g(s.dir, "fetch", "-q", "origin");
  lib.g(s.dir, "merge", "-q", "--ff-only", "origin/main");
  // a rename out of the block counts by its old end
  lib.g(s.dir, "checkout", "-q", "-b", "b-move", "main");
  lib.g(s.dir, "mv", "src/auth/key2.txt", "src/plain.txt");
  lib.g(s.dir, "commit", "-q", "-m", "refactor: move");
  const moved = lib.g(s.dir, "rev-parse", "HEAD");
  lib.g(s.dir, "push", "-q", "origin", `${moved}:refs/heads/hold-move`);
  s.status(moved, "pending");
  lib.g(s.dir, "push", "-q", "origin", "b-move:b-move");
  lib.g(s.dir, "checkout", "-q", "main");
  const mo = { n: Number(/\/pull\/(\d+)$/.exec(s.gh(["pr", "create", "--base", "main", "--head", "b-move", "--title", "t", "--body", "b"]).out.trim())[1]) };
  s.status(moved, "success");
  ok("security: a rename out of the block is held", (s.held(mo)[0] || {}).why === "human", JSON.stringify(s.held(mo)));
  // a PR cannot rewrite the block it is judged by
  q = s.open("src/auth/two.txt");
  ok("security: held before the worktree's block is emptied", s.held(q).length === 1);
  fs.writeFileSync(path.join(s.dir, "teams", "ROUTING.md"), "# Routing\n");
  ok("security: the block is read from the base, not the worktree", s.held(q).length === 1);
  lib.g(s.dir, "checkout", "-q", "teams/ROUTING.md");
  // the definition cannot be read: a stand-in that fails that one call
  const standIn = s.H("proteus-local.js"), real = fs.readFileSync(standIn, "utf8");
  fs.writeFileSync(standIn, `if (process.argv.some((x) => x.includes("contents/teams"))) { console.error("gh: boom (HTTP 500)"); process.exit(1); }\n${real.replace(/^#!.*\n/, "")}`);
  h = s.held(none);
  r = s.merge(none);
  fs.writeFileSync(standIn, real);
  ok("security: an unreadable block holds", h.length === 1 && h[0].why === "unread-human", JSON.stringify(h));
  ok("security: pr merge refuses on it", r.code !== 0 && /could not read/.test(r.err) && s.state(none) === "OPEN", r.err);

  // into a run branch a security change waits for the security verifier's signoff, never the human's ACCEPT
  const runBranch = (x, name) => {
    lib.g(path.join(x.common, "proteus-local", "origin.git"), "branch", `proteus/${name}`, "refs/heads/main");
    lib.g(x.dir, "fetch", "-q", "origin");
  };
  const runPr = (x, name, t, file) => {
    lib.g(x.dir, "checkout", "-q", "-b", `proteus/${name}-${t}`, `origin/proteus/${name}`);
    fs.mkdirSync(path.dirname(path.join(x.dir, file)), { recursive: true });
    fs.writeFileSync(path.join(x.dir, file), "x\n");
    lib.g(x.dir, "add", file);
    lib.g(x.dir, "commit", "-q", "-m", `feat: ${t}`);
    const sha = lib.g(x.dir, "rev-parse", "HEAD");
    lib.g(x.dir, "push", "-q", "origin", `${sha}:refs/heads/hold-${name}-${t}`);
    x.status(sha, "pending");
    lib.g(x.dir, "push", "-q", "origin", `proteus/${name}-${t}:proteus/${name}-${t}`);
    lib.g(x.dir, "checkout", "-q", "main");
    const made = x.gh(["pr", "create", "--base", `proteus/${name}`, "--head", `proteus/${name}-${t}`, "--title", t, "--body", "b"]);
    x.status(sha, "success");
    return { n: Number(/\/pull\/(\d+)$/.exec(made.out.trim())[1]), sha, short: sha.slice(0, 12) };
  };
  const signoff = (x, n, head, ...more) => lib.run(x.H("proteus-signoff.js"), "", { cwd: x.dir, args: [String(n), head, "MERGE", ...more], env: x.env });
  runBranch(s, "rs");
  q = runPr(s, "rs", "t1", "src/auth/run.txt");
  signoff(s, q.n, q.sha);
  h = s.held(q);
  ok("security, run branch: held for the security verifier, not the human", h.length === 1 && h[0].why === "security", JSON.stringify(h));
  accept(q);
  r = s.merge(q);
  ok("security, run branch: the human's ACCEPT does not lift it", r.code !== 0 && !/held for the human/.test(r.err) && /security verifier's MERGE/.test(r.err) && s.state(q) === "OPEN", r.err);
  r = signoff(s, q.n, q.sha, "--security");
  ok("security, run branch: the security verifier's signoff posts", r.code === 0, r.out + r.err);
  r = s.merge(q);
  ok("security, run branch: then it merges", r.code === 0 && s.state(q) === "MERGED", r.out + r.err);

  // green, next, merge: proteus-merge.js merges a signed-off PR into the run branch with no verdict from the human
  runBranch(a, "rr");
  const rr = runPr(a, "rr", "t1", "t1.txt");
  r = a.terminal(rr.n, `ACCEPT ${rr.short}\n`);
  r = a.merge(rr);
  ok("e2e: no proteus/verdict, a direct pr merge refused even with the ACCEPT", r.code !== 0 && /required status proteus\/verdict is missing/.test(r.err) && a.state(rr) === "OPEN", r.err);
  a.forget();
  // a verifier App configured, its API a closed port and its key missing: any reach for it fails the signoff
  const home = path.join(W, "app-home");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "proteus.json"), JSON.stringify({ verifierApp: { appId: 1, installationId: 2, keyPath: path.join(home, "no-key.pem") } }));
  r = lib.run(a.H("proteus-signoff.js"), "", { cwd: a.dir, args: [String(rr.n), rr.sha, "MERGE"], env: { ...a.env, ...lib.homeEnv(home), PROTEUS_GH_API: "http://127.0.0.1:1" } });
  ok("e2e: with an App configured, local signoff reaches no network and posts", r.code === 0 && /proteus\/verdict = success/.test(r.out) && !/as App/.test(r.out), r.out + r.err);
  r = lib.run(a.H("proteus-cli.js"), "", { cwd: a.dir, args: ["next", "rr"], env: a.env });
  ok("e2e: next merges it, asking the human nothing", a.state(rr) === "MERGED" && !/^ASK human/m.test(r.out), r.out + r.err);
  const msg = lib.g(path.join(a.common, "proteus-local", "origin.git"), "log", "-1", "--format=%B", "proteus/rr");
  ok("e2e: the merge commit carries its evidence", msg.includes(`Reviewed merge of PR #${rr.n} at ${rr.short}: `) && /proteus\/verdict/.test(msg), msg);
  const at = JSON.parse(fs.readFileSync(path.join(a.common, "proteus", "merge", "rr.json"), "utf8")).at;
  r = lib.run(a.H("proteus-merge.js"), "", { cwd: a.dir, args: ["rr", "--suite", "node gate.js", "--result", "pass", "--at", at], env: a.env });
  ok("e2e: the batch's suite result ends it", r.code === 0, r.out + r.err);
}

// ---- dependency consent (#367): a PR adding or upgrading a dependency waits for the human, whatever the modes say
{
  const a = repo("deps");
  const off = { merge: "lead", ask: "never", rules: [] };
  const write2 = (file, text) => { fs.mkdirSync(path.dirname(path.join(a.dir, file)), { recursive: true }); fs.writeFileSync(path.join(a.dir, file), text); };
  // a base branch with a manifest (main changes only through a merge); each PR branches from it
  lib.g(a.dir, "checkout", "-q", "-b", "base", "main");
  write2("package.json", '{\n  "dependencies": {\n    "left-pad": "1.0.0"\n  }\n}\n');
  lib.g(a.dir, "add", "package.json"); lib.g(a.dir, "commit", "-q", "-m", "chore: manifest"); lib.g(a.dir, "push", "-q", "origin", "base:base");
  lib.g(a.dir, "checkout", "-q", "main");
  const pr = (files) => {
    const branch = `dep-${++a.n}`;
    lib.g(a.dir, "checkout", "-q", "-b", branch, "base");
    for (const [f, t] of Object.entries(files)) write2(f, t);
    lib.g(a.dir, "add", "--", ...Object.keys(files)); lib.g(a.dir, "commit", "-q", "-m", `feat: ${branch}`);
    lib.g(a.dir, "push", "-q", "origin", `${branch}:${branch}`);
    lib.g(a.dir, "checkout", "-q", "main");
    const made = a.gh(["pr", "create", "--base", "base", "--head", branch, "--title", `feat: ${branch}`, "--body", "b"]);
    const m = /\/pull\/(\d+)$/.exec(made.out.trim());
    if (!m) throw new Error(made.out + made.err);
    return { n: Number(m[1]) };
  };
  const added = '{\n  "dependencies": {\n    "left-pad": "1.0.0",\n    "express": "4.19.0"\n  }\n}\n';
  let p = pr({ "package.json": added });
  let h = a.held(p, off);
  ok("deps: an added dependency without approval is held, ask never too", h.length === 1 && h[0].why === "deps", JSON.stringify(h));
  write(a, entry(p.n, "ACCEPT\nDEPENDENCY lodash\n"));
  ok("deps: an approval for another dependency holds it", a.held(p, off).length === 1);
  write(a, entry(p.n, "ACCEPT\nDEPENDENCY express\n"));
  ok("deps: the human's approval for it lets it through", a.held(p, off).length === 0, JSON.stringify(a.held(p, off)));
  p = pr({ "package.json": '{\n  "dependencies": {\n    "left-pad": "1.3.0"\n  }\n}\n' });
  ok("deps: an upgrade is held too", (a.held(p, off)[0] || {}).why === "deps");
  p = pr({ "package.json": added, "package-lock.json": '{\n  "packages": {\n    "node_modules/express": {},\n    "node_modules/body-parser": {}\n  }\n}\n' });
  ok("deps: the manifest and its lockfile, unapproved, are held", a.held(p, off).length === 1);
  write(a, entry(p.n, "ACCEPT\nDEPENDENCY express\n"));
  ok("deps: lockfile churn from an approved dependency passes", a.held(p, off).length === 0, JSON.stringify(a.held(p, off)));
  p = pr({ "yarn.lock": "body-parser@1:\n  version 1.20.0\n" });
  ok("deps: a lockfile change with no approval is held", (a.held(p, off)[0] || {}).why === "deps");
  p = pr({ "src/app.js": "x\n", "docs/requirements.md": "express\n" });
  ok("deps: a PR touching no manifest or lockfile is not held", a.held(p, off).length === 0);
  p = pr({ "go.mod": "module m\n\nrequire github.com/x/y v1.2.0\n" });
  ok("deps: another ecosystem's manifest, by file name", (a.held(p, off)[0] || {}).why === "deps");
  const sha = lib.g(a.dir, "rev-parse", `origin/dep-${a.n}`).slice(0, 12);
  write(a, entry(p.n, `ACCEPT ${sha}\n`));
  ok("deps: the human's ACCEPT of its head lets it through", a.held(p, off).length === 0, JSON.stringify(a.held(p, off)));
  // the model cannot write the record: a store comment is no approval
  p = pr({ "Cargo.toml": "[dependencies]\nserde = \"1\"\n" });
  a.comment(p.n, "ACCEPT\nDEPENDENCY serde\n");
  ok("deps: a comment in the store approves nothing", a.held(p, off).length === 1);
}

// ---- the stand-in's rule targets are the installer's
{
  ok("rules: a run branch needs them, the default branch does not", hooksLib.requiredChecks("proteus/rr").length === hooksLib.REQUIRED_CHECKS.length && hooksLib.requiredChecks("main").length === 0);
}

// ---- outside local mode: comments decide, byte for byte
{
  const dir = path.join(W, "hosted");
  fs.mkdirSync(dir);
  lib.g(dir, "init", "-q");
  fs.mkdirSync(path.join(dir, ".git", "proteus-lead"), { recursive: true });
  const body = "ACCEPT abc\n";
  fs.writeFileSync(path.join(dir, ".git", "proteus-lead", "verdicts.jsonl"), JSON.stringify(entry(7, body)) + "\n");
  const comments = [
    { author: { login: "hu" }, body: "CHANGES\nno", createdAt: "2026-01-01T00:00:00Z" },
    { author: { login: "bot" }, body: "ACCEPT xyz", createdAt: "2026-01-02T00:00:00Z" },
    { author: { login: "hu" }, body: "not a verdict", createdAt: "2026-01-03T00:00:00Z" },
  ];
  const v = hooksLib.humanVerdicts(dir, 7, comments, "hu");
  ok("hosted: the human's comments, not the record", v.length === 1 && v[0].first === "CHANGES" && v[0].at === "2026-01-01T00:00:00Z", JSON.stringify(v));
}

lib.summary();

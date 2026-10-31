// The human's verdicts in local mode (#310): node tests/localverdict.test.js. The record decides and no store comment
// does; both ways into it (the dialog's pending entry and the human's terminal); held, proteus-verdict.js and `pr merge`
// reading it; a damaged record; and outside local mode, comments still decide.
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
fs.writeFileSync(HELD, `const path = require("path"), [hooks, n, policy] = process.argv.slice(2);
console.log(JSON.stringify(require(path.join(hooks, "proteus-policy.js")).held([{ n: Number(n) }], process.cwd(), JSON.parse(policy))));
`);

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
  r.held = (p, policy = { merge: "lead", ask: "every", rules: [] }) => JSON.parse(lib.run(HELD, "", { cwd: dir, args: [hooks, String(p.n), JSON.stringify(policy)], env: r.env }).out);
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
  const a = repo("comments");
  const p = a.open(), i = a.gh(["issue", "create", "--title", "t", "--body", "b"]);
  const issue = Number(/(\d+)\s*$/.exec(i.out.trim())[1]);
  a.gh(["label", "create", "proteus-review"]);
  a.gh(["issue", "edit", String(issue), "--add-label", "proteus-review"]);
  a.policy({ merge: "lead", ask: "every", rules: [] });
  for (const body of [`ACCEPT ${p.short}`, `ACCEPT ${p.short}\nlooks fine`, `\n\nACCEPT ${p.short}\n`, "ACCEPT", "ANSWER yes"]) a.comment(p.n, body);
  ok("comment: no ACCEPT form lifts the hold", a.held(p).length === 1 && a.held(p)[0].why === "every");
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
  const a = repo("reading");
  const p = a.open();
  const every = { merge: "lead", ask: "every", rules: [] };
  write(a, entry(p.n, "ACCEPT 000000000000\n"));
  ok("read: ACCEPT of an old head holds", a.held(p, every).length === 1);
  write(a, entry(p.n, `ACCEPT ${p.short}\n`, ago(2000)), entry(p.n, "CHANGES\nno\n", ago(1000)));
  ok("read: CHANGES after ACCEPT holds", a.held(p, every).length === 1);
  write(a, entry(p.n, "CHANGES\nno\n", ago(1000)), entry(p.n, `ACCEPT ${p.short}\n`, ago(2000)));
  ok("read: file order decides, not the time", a.held(p, every).length === 0);
  write(a, entry(p.n + 1, `ACCEPT ${p.short}\n`));
  ok("read: another number's verdict is not this one's", a.held(p, every).length === 1);

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
    ok(`record: ${name} counts for nothing`, a.held(p, every).length === 1 && hooksLib.verdictRecord(a.common).length === 0);
    write(a, bad, good);
    ok(`record: past ${name}, the rest still reads`, a.held(p, every).length === 0);
  }
  fs.writeFileSync(a.record, "x".repeat((1 << 24) + 1));
  ok("record: over the size cap reads as unreadable", hooksLib.verdictRecord(a.common) === null && a.held(p, every).length === 1);
  r = a.terminal(p.n, `ACCEPT ${p.short}\n`);
  ok("record: over the cap, nothing is appended", r.code === 1 && /nothing recorded/.test(r.err), r.err);
  fs.rmSync(a.record);
  const elsewhere = path.join(W, "elsewhere.jsonl");
  fs.writeFileSync(elsewhere, JSON.stringify(good) + "\n");
  let linked = true;
  try { fs.symlinkSync(elsewhere, a.record); } catch { linked = false; }
  if (linked) {
    ok("record: a link reads as unreadable", hooksLib.verdictRecord(a.common) === null && a.held(p, every).length === 1);
    fs.rmSync(a.record);
  }
  const big = `ACCEPT ${p.short}\n${"x".repeat(1 << 17)}`;
  r = a.terminal(p.n, big);
  ok("record: a body over the cap is refused", r.code === 1 && a.lines().length === 0, r.code + r.err);
}

// ---- pr merge, each policy mode
{
  const a = repo("merge");
  const accept = (p) => write(a, ...a.lines(), entry(p.n, `ACCEPT ${p.short}\n`));
  a.policy({ merge: "lead", ask: "never", rules: [] });
  let p = a.open(), r = a.merge(p);
  ok("merge: ask never merges a green PR", r.code === 0 && a.state(p) === "MERGED", r.out + r.err);

  a.policy({ merge: "lead", ask: "every", rules: [] });
  p = a.open();
  r = a.merge(p);
  ok("merge: ask every holds without a verdict", r.code !== 0 && /held for the human/.test(r.err) && a.state(p) === "OPEN", r.err);
  write(a, entry(p.n, "ACCEPT 000000000000\n"));
  r = a.merge(p);
  ok("merge: an old head's ACCEPT holds", r.code !== 0 && a.state(p) === "OPEN", r.err);
  accept(p);
  const stale = p;
  a.push(p);
  r = a.merge(stale);
  ok("merge: head moved past the ACCEPT holds", r.code !== 0 && a.state(p) === "OPEN", r.out + r.err);
  p = a.open();
  accept(p);
  r = a.merge(p);
  ok("merge: ask every merges the accepted head", r.code === 0 && a.state(p) === "MERGED", r.out + r.err);

  const rule = [{ id: "keep-out", effect: "ask", tool: "edit", paths: ["src/hard/**"], why: "w" }];
  a.policy({ merge: "lead", ask: "risky", rules: rule });
  p = a.open("src/easy/a.txt");
  r = a.merge(p);
  ok("merge: ask risky takes what no rule covers", r.code === 0 && a.state(p) === "MERGED", r.out + r.err);
  p = a.open("src/hard/a.txt");
  r = a.merge(p);
  ok("merge: ask risky holds what a rule covers", r.code !== 0 && /keep-out/.test(r.err) && a.state(p) === "OPEN", r.err);
  accept(p);
  r = a.merge(p);
  ok("merge: ask risky merges it once accepted", r.code === 0 && a.state(p) === "MERGED", r.out + r.err);

  a.policy({ merge: "human", ask: "never", rules: [] });
  p = a.open();
  r = a.merge(p);
  ok("merge: merge human holds with no record", r.code !== 0 && /held for the human/.test(r.err) && /ACCEPT <sha12>/.test(r.err) && a.state(p) === "OPEN", r.err);
  write(a, ...a.lines(), entry(p.n, "ACCEPT 000000000000\n"));
  r = a.merge(p);
  ok("merge: merge human holds an old head's record", r.code !== 0 && a.state(p) === "OPEN", r.err);
  accept(p);
  a.push(p);
  r = a.merge(p);
  ok("merge: merge human holds once the head moved", r.code !== 0 && a.state(p) === "OPEN", r.err);
  p = a.open();
  accept(p);
  r = a.merge(p);
  ok("merge: merge human merges the recorded head", r.code === 0 && a.state(p) === "MERGED", r.out + r.err);

  // a security path, whatever the modes say. The block is the base's, as proteus-security.js reads it
  const off = { merge: "lead", ask: "never", rules: [] };
  ok("security: no ROUTING.md on the base, no hold", a.held(a.open("src/auth/key.txt"), off).length === 0);
  const s = repo("security", "# Routing\n\n```security\n**/auth/**\n```\n");
  s.policy(off);
  const none = s.open("src/open.txt");
  ok("security: a path outside the block is not held", s.held(none, off).length === 0);
  let q = s.open("src/auth/key.txt");
  let h = s.held(q, off);
  ok("security: a path in the block is held with ask never", h.length === 1 && h[0].why === "security" && h[0].sha === q.short, JSON.stringify(h));
  ok("security: held under ask every too", s.held(q, { merge: "lead", ask: "every", rules: [] })[0].why === "security");
  r = s.merge(q);
  ok("security: pr merge refuses it, saying why", r.code !== 0 && /held for the human/.test(r.err) && /security block/.test(r.err) && s.state(q) === "OPEN", r.err);
  write(s, entry(q.n, "ACCEPT 000000000000\n"));
  ok("security: an old head's ACCEPT holds", s.held(q, off).length === 1);
  write(s, entry(q.n, `ACCEPT ${q.short}\n`));
  r = s.merge(q);
  ok("security: the recorded ACCEPT merges it", r.code === 0 && s.state(q) === "MERGED", r.out + r.err);
  lib.g(s.dir, "fetch", "-q", "origin");
  lib.g(s.dir, "merge", "-q", "--ff-only", "origin/main");
  // a rename out of the block counts by its old end
  lib.g(s.dir, "checkout", "-q", "-b", "b-move", "main");
  lib.g(s.dir, "mv", "src/auth/key.txt", "src/plain.txt");
  lib.g(s.dir, "commit", "-q", "-m", "refactor: move");
  const moved = lib.g(s.dir, "rev-parse", "HEAD");
  lib.g(s.dir, "push", "-q", "origin", `${moved}:refs/heads/hold-move`);
  s.status(moved, "pending");
  lib.g(s.dir, "push", "-q", "origin", "b-move:b-move");
  lib.g(s.dir, "checkout", "-q", "main");
  const mo = { n: Number(/\/pull\/(\d+)$/.exec(s.gh(["pr", "create", "--base", "main", "--head", "b-move", "--title", "t", "--body", "b"]).out.trim())[1]) };
  s.status(moved, "success");
  ok("security: a rename out of the block is held", (s.held(mo, off)[0] || {}).why === "security", JSON.stringify(s.held(mo, off)));
  // a PR cannot rewrite the block it is judged by
  q = s.open("src/auth/two.txt");
  ok("security: held before the worktree's block is emptied", s.held(q, off).length === 1);
  fs.writeFileSync(path.join(s.dir, "teams", "ROUTING.md"), "# Routing\n");
  ok("security: the block is read from the base, not the worktree", s.held(q, off).length === 1);
  lib.g(s.dir, "checkout", "-q", "teams/ROUTING.md");
  // the definition cannot be read: a stand-in that fails that one call
  const standIn = s.H("proteus-local.js"), real = fs.readFileSync(standIn, "utf8");
  fs.writeFileSync(standIn, `if (process.argv.some((x) => x.includes("contents/teams"))) { console.error("gh: boom (HTTP 500)"); process.exit(1); }\n${real.replace(/^#!.*\n/, "")}`);
  h = s.held(none, off);
  r = s.merge(none);
  fs.writeFileSync(standIn, real);
  ok("security: an unreadable block holds", h.length === 1 && h[0].why === "unread-security", JSON.stringify(h));
  ok("security: pr merge refuses on it", r.code !== 0 && /could not read/.test(r.err) && s.state(none) === "OPEN", r.err);

  // green, next, merge: through proteus-merge.js with a recorded verdict
  a.policy({ merge: "lead", ask: "every", rules: [] });
  const origin = path.join(a.common, "proteus-local", "origin.git");
  lib.g(origin, "branch", "proteus/rr", "refs/heads/main");
  lib.g(a.dir, "fetch", "-q", "origin");
  lib.g(a.dir, "branch", "proteus/rr", "origin/proteus/rr");
  lib.g(a.dir, "checkout", "-q", "-b", "proteus/rr-t1", "origin/proteus/rr");
  fs.writeFileSync(path.join(a.dir, "t1.txt"), "x\n");
  lib.g(a.dir, "add", "t1.txt");
  lib.g(a.dir, "commit", "-q", "-m", "feat: t1");
  const sha = lib.g(a.dir, "rev-parse", "HEAD");
  lib.g(a.dir, "push", "-q", "origin", `${sha}:refs/heads/hold-rr`);
  a.status(sha, "pending");
  lib.g(a.dir, "push", "-q", "origin", "proteus/rr-t1:proteus/rr-t1");
  lib.g(a.dir, "checkout", "-q", "main");
  const made = a.gh(["pr", "create", "--base", "proteus/rr", "--head", "proteus/rr-t1", "--title", "t", "--body", "b"]);
  const rr = { n: Number(/\/pull\/(\d+)$/.exec(made.out.trim())[1]), short: sha.slice(0, 12) };
  a.status(sha, "success");
  r = a.terminal(rr.n, `ACCEPT ${rr.short}\n`);
  r = a.merge(rr);
  ok("e2e: no proteus/verdict, a direct pr merge refused even with the ACCEPT", r.code !== 0 && /required status proteus\/verdict is missing/.test(r.err) && a.state(rr) === "OPEN", r.err);
  a.forget();
  r = lib.run(a.H("proteus-signoff.js"), "", { cwd: a.dir, args: [String(rr.n), sha, "MERGE"], env: a.env });
  ok("e2e: signoff posts proteus/verdict in local mode", r.code === 0 && /proteus\/verdict = success/.test(r.out), r.out + r.err);
  const run = () => lib.run(a.H("proteus-merge.js"), "", { cwd: a.dir, args: ["rr", "--suite", "node gate.js"], env: a.env });
  r = lib.run(a.H("proteus-cli.js"), "", { cwd: a.dir, args: ["next", "rr"], env: a.env });
  ok("e2e: next asks for the head's ACCEPT", new RegExp(`ASK human PR#${rr.n} .*reply: ACCEPT ${rr.short}`).test(r.out), r.out + r.err);
  r = run();
  ok("e2e: a green PR holds without the human's verdict", a.state(rr) === "OPEN" && /held for the human/.test(r.out + r.err), r.out + r.err);
  a.comment(rr.n, `ACCEPT ${rr.short}`);
  r = run();
  ok("e2e: an agent's comment changes nothing", a.state(rr) === "OPEN", r.out + r.err);
  a.terminal(rr.n, `ACCEPT ${rr.short}\n`);
  r = run();
  ok("e2e: the recorded verdict merges it", a.state(rr) === "MERGED", r.out + r.err);
}

// ---- signoff never reaches for the App in local mode
{
  const src = fs.readFileSync(path.join(SRC, "proteus-signoff.js"), "utf8");
  ok("signoff: the App is off in local mode", /lib\.localCommon\(cwd\) \? null : lib\.verifierApp\(\)/.test(src));
}

// ---- the stand-in's rule targets are the installer's
{
  const m = /ref_name: \{ include: (\[[^\]]*\])/.exec(fs.readFileSync(path.join(__dirname, "..", "install.js"), "utf8"));
  ok("rules: lib.REQUIRED_REFS is what install.js --protect binds", m && m[1] === JSON.stringify(hooksLib.REQUIRED_REFS), m && m[1]);
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

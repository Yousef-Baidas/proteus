// Claude Code adapter: maps Claude Code's hook JSON to the Proteus event (see proteus-harness.js),
// answers in Claude Code's hook protocol, reads its JSONL transcripts, and registers the hooks
// in .claude/settings.local.json.
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { tailLines } = require(path.join(__dirname, "proteus-lib.js"));

const name = "claude";
// the default model ladder, lowest first; solo models run once per project
const models = { ladder: ["haiku", "sonnet", "opus", "fable"], floor: "sonnet", solo: ["fable"] };
const bypass = "PROTEUS=0 claude";

const KINDS = {
  SessionStart: "session-start",
  UserPromptSubmit: "prompt",
  PreToolUse: "pre-tool",
  PostToolUse: "post-tool",
  PostToolUseFailure: "tool-failed",
  Stop: "stop",
  SubagentStop: "subagent-stop",
  TeammateIdle: "idle",
};
const TOOLS = { Edit: "edit", Write: "edit", MultiEdit: "edit", NotebookEdit: "edit", Read: "read", Bash: "shell", Monitor: "monitor", Agent: "spawn", Task: "spawn" };

const projectRoot = (raw) => process.env.CLAUDE_PROJECT_DIR || (raw && raw.cwd) || process.cwd();

function event(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const ti = r.tool_input && typeof r.tool_input === "object" ? r.tool_input : {};
  const m = r.model;
  return {
    kind: KINDS[r.hook_event_name] || "",
    session: r.session_id || "",
    cwd: r.cwd || "",
    root: projectRoot(r),
    source: r.source || "",
    agent: r.agent_id || "",
    agentType: r.agent_type || "",
    teammate: r.teammate_name || "",
    model: typeof m === "string" ? m : m && typeof m === "object" ? m.id || m.display_name || "" : "",
    tool: TOOLS[r.tool_name] || "",
    toolName: r.tool_name || "",
    toolUseId: r.tool_use_id || "",
    path: ti.file_path || ti.notebook_path || "",
    paths: ti.file_path || ti.notebook_path ? [ti.file_path || ti.notebook_path] : [],
    command: typeof ti.command === "string" ? ti.command : "",
    background: ti.run_in_background === true,
    spawnModel: typeof ti.model === "string" ? ti.model : "",
    spawnType: typeof ti.subagent_type === "string" ? ti.subagent_type : "",
    prompt: typeof r.prompt === "string" ? r.prompt : "",
    // a prompt from anything but the human: task notifications, loop wakeups, peer messages
    fromHuman: !r.source || r.source === "user" || r.source === "sdk",
    output: outputText(r.tool_response),
    error: typeof r.error === "string" ? r.error : "",
    stopActive: r.stop_hook_active === true,
    busy: Array.isArray(r.background_tasks) && r.background_tasks.length > 0,
    raw: r,
  };
}

function outputText(res) {
  return typeof res === "string" ? res : res && typeof res === "object" ? [res.stdout, res.stderr].filter((x) => typeof x === "string").join("\n") : "";
}

// ---- answers

// refuse the tool call: exit 2, stderr reaches the model as the tool's error.
// json: a PreToolUse permission decision instead, the reason shown as given (exit 0).
function deny(why, { json = false } = {}) {
  if (json) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: why } }));
    return;
  }
  try { fs.writeSync(2, `proteus: ${why}\n`); } catch {} // sync: process.exit drops async pipe writes
  process.exit(2);
}

// add text to the model's context for this event (kind: the hook's own event when the JSON
// names none); a session start's plain stdout is its context
function context(ev, text, kind = ev.kind) {
  if (kind === "session-start") { process.stdout.write(text.endsWith("\n") ? text : text + "\n"); return; }
  const hookEventName = ev.raw.hook_event_name || Object.keys(KINDS).find((k) => KINDS[k] === kind);
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: text } }) + "\n");
}

// an agent that tried to stop keeps working, with the reason as its next instruction
function keepGoing(ev, reason) {
  if (ev.kind === "idle") deny(reason); // exit 2 keeps the teammate working
  process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n");
}

// ---- transcripts: JSONL, one entry per line; main-thread entries lack isSidechain

// newest-first iteration over main-thread transcript entries
function* entriesBackward(lines, sidechain = false) {
  for (let i = lines.length - 1; i >= 0; i--) {
    let e;
    try { e = JSON.parse(lines[i]); } catch { continue; }
    if (!e || typeof e !== "object" || (e.isSidechain === true && !sidechain)) continue;
    yield e;
  }
}

const usageSum = (u) => (u && typeof u === "object"
  ? (+u.input_tokens || 0) + (+u.cache_read_input_tokens || 0) + (+u.cache_creation_input_tokens || 0) : 0);

// context size in tokens: stdin usage if the event carries it, else the newest assistant
// usage in the transcript; 0 after a compaction boundary with no reply since, or on any doubt
function contextTokens(ev) {
  const direct = usageSum(ev.raw.usage);
  if (direct > 0) return direct;
  for (const e of entriesBackward(tailLines(ev.raw.transcript_path))) {
    if (e.subtype === "compact_boundary" || e.isCompactSummary) return 0;
    const m = e.message;
    if (!m || (e.type !== "assistant" && m.role !== "assistant")) continue;
    const n = usageSum(m.usage);
    if (n > 0) return n;
  }
  return 0;
}

const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b && b.type === "text").map((b) => b.text).join("\n") : "");

// text of the newest assistant message that has any; a subagent's own transcript
// (agent_transcript_path, every entry a sidechain) wins over the session's
function lastAssistantText(ev) {
  if (typeof ev.raw.last_assistant_message === "string") return ev.raw.last_assistant_message;
  const own = ev.raw.agent_transcript_path;
  for (const e of entriesBackward(tailLines(own || ev.raw.transcript_path), !!own)) {
    const m = e.message;
    if (!m || (e.type !== "assistant" && m.role !== "assistant")) continue;
    const text = textOf(m.content);
    if (text.trim()) return text;
  }
  return "";
}

// newest prompt the human typed, from the transcript tail; null when none is found.
// Newer transcripts tag it origin.kind "human"; older ones are told apart by their prefix.
const NOT_HUMAN = /^\s*(<task-notification|<local-command|<cross-session-message|\[Request interrupted|Another Claude session)/;
function lastHumanPrompt(ev) {
  // image tool results make lines huge, so look further back and parse only candidate lines
  const lines = tailLines(ev.raw.transcript_path, 4 * 1024 * 1024)
    .filter((l) => l.includes("compact_boundary") || (l.includes('"type":"user"') && !l.includes('"toolUseResult"')));
  for (const e of entriesBackward(lines)) {
    if (e.subtype === "compact_boundary") return null;
    if (e.type !== "user" || e.isMeta || e.isCompactSummary || e.toolUseResult !== undefined || !e.message) continue;
    const text = textOf(e.message.content);
    if (!text.trim()) continue;
    if (e.origin ? e.origin.kind !== "human" : NOT_HUMAN.test(text)) continue;
    return text;
  }
  return null;
}

// the session's model: the event's (SessionStart carries it), else the newest main-thread reply's
function sessionModel(ev) {
  if (ev.model) return ev.model;
  for (const e of entriesBackward(tailLines(ev.raw.transcript_path))) {
    const id = e.message && (e.type === "assistant" || e.message.role === "assistant") && e.message.model;
    if (typeof id === "string" && id && !id.startsWith("<")) return id;
  }
  return "";
}

// ---- install: where things live, and the hook registrations

const home = path.join(os.homedir(), ".claude");
const skillDirs = (root) => [path.join(root, ".claude", "skills", "proteus"), path.join(home, "skills", "proteus")];
const agentsDir = path.join(home, "agents");
const hooksDir = (root) => path.join(root, ".claude", "hooks");
// loaded once a worker reads a file in the team folder
const teamSkills = (team) => path.join(team, ".claude", "skills");
// every template file lands in hooksDir (existing repos' gates name .claude/hooks/commit-msg.js)
const skipHooks = [];
// a shipped agent as this CLI keeps it: {name, text}, or null to skip it
const agentFile = (file, text) => ({ name: path.basename(file), text });
const leadSettings = (root) => path.join(root, ".claude", "settings.local.json");

// the required context-mode plugin: installed and enabled at user scope (two small file reads)
function contextModeOn() {
  const id = "context-mode@context-mode";
  const read = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")) || {}; } catch { return {}; } };
  const inst = read(path.join(home, "plugins", "installed_plugins.json"));
  const s = read(path.join(home, "settings.json"));
  return !!(inst.plugins && Array.isArray(inst.plugins[id]) && inst.plugins[id].length && s.enabledPlugins && s.enabledPlugins[id] === true);
}

// The lead's hook set in .claude/settings.local.json. Only adds; never removes a user hook.
const LEAD_GUARD_MATCHER = "Edit|Write|MultiEdit|NotebookEdit|Agent|Task|Bash|Monitor|Read";
const OLD_GUARD_MATCHERS = ["Edit|Write|MultiEdit|NotebookEdit|Agent|Task", "Edit|Write|MultiEdit|NotebookEdit|Agent|Task|Bash|Monitor"];
// [event, script, matcher, timeout s]; the autostart may pull and query gh
const LEAD_HOOKS = [
  ["SessionStart", "proteus-autostart.js", undefined, 60],
  ["UserPromptSubmit", "proteus-journal.js"],
  ["UserPromptSubmit", "proteus-lessons.js"],
  ["PreToolUse", "proteus-lead-guard.js", LEAD_GUARD_MATCHER],
  ["PreToolUse", "proteus-lessons.js", "Bash|Edit|Write|Read"],
  ["PostToolUse", "proteus-lessons.js", "Bash"],
  ["PreToolUse", "proteus-scratch.js", "Bash"],
  ["PostToolUse", "proteus-scratch.js", "Bash"],
  ["PostToolUseFailure", "proteus-scratch.js", "Bash"],
  ["SubagentStop", "proteus-stall.js"],
  ["TeammateIdle", "proteus-stall.js"],
];

// returns {file, changed} or {file, error} (invalid JSON is never overwritten)
function registerLead(root) {
  const file = leadSettings(root);
  let raw = null;
  try { raw = fs.readFileSync(file, "utf8"); } catch {}
  let s = {};
  if (raw !== null && raw.trim()) {
    try { s = JSON.parse(raw); } catch (e) { return { file, error: `${file} is not valid JSON (${e.message})` }; }
    if (!s || typeof s !== "object" || Array.isArray(s)) return { file, error: `${file} is not a JSON object` };
  }
  const before = JSON.stringify(s);
  s.hooks = s.hooks && typeof s.hooks === "object" ? s.hooks : {};
  const cmd = (f) => `node "$CLAUDE_PROJECT_DIR/.claude/hooks/${f}"`;
  const names = (entry) => JSON.stringify((entry && entry.hooks) || []);
  for (const [ev, script, matcher, timeout] of LEAD_HOOKS) {
    const list = (s.hooks[ev] = Array.isArray(s.hooks[ev]) ? s.hooks[ev] : []);
    const have = list.filter((e) => names(e).includes(script));
    if (have.length) {
      for (const e of have) if (script === "proteus-lead-guard.js" && OLD_GUARD_MATCHERS.includes(e.matcher)) e.matcher = matcher;
      continue;
    }
    const entry = { hooks: [{ type: "command", command: cmd(script), ...(timeout && { timeout }) }] };
    if (matcher) entry.matcher = matcher;
    list.push(entry);
  }
  // statusLine commands are not documented to get $CLAUDE_PROJECT_DIR: absolute path, forward
  // slashes (this file is machine-local). Only when the project sets no statusLine of its own.
  if (!("statusLine" in s)) {
    const script = path.resolve(path.dirname(file), "hooks", "proteus-statusline.js").split(path.sep).join("/");
    s.statusLine = { type: "command", command: `node "${script}"` };
  }
  if (JSON.stringify(s) === before) return { file, changed: false };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
  return { file, changed: true };
}

// a worker's worktree: its hooks, registered by the worktree settings template beside this file
const WORKER_HOOKS = ["proteus-lib.js", "proteus-harness.js", "proteus-harness-claude.js", "proteus-owned-paths.js", "proteus-owned-check.js", "proteus-tier.js", "proteus-worker-guard.js", "proteus-stall.js", "proteus-lessons.js", "proteus-scratch.js", "proteus-gh.js"];
const WORKER_EXCLUDE = ["/.claude/proteus-owned", "/.claude/settings.local.json", "/.claude/hooks/proteus-*.js"];
function prepareWorker(wt, src) {
  const dir = hooksDir(wt);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of WORKER_HOOKS) fs.copyFileSync(path.join(src, f), path.join(dir, f));
  fs.copyFileSync(path.join(src, "worktree-settings.local.json"), path.join(wt, ".claude", "settings.local.json"));
  return WORKER_EXCLUDE;
}
// the file a worker's worktree lists its owned paths in
const ownedFile = (wt) => path.join(wt, ".claude", "proteus-owned");

// vars for every later Bash call of this session, subagents' included: export lines in the file SessionStart
// hooks get as CLAUDE_ENV_FILE. Values go single-quoted with forward slashes (Git Bash on Windows reads them too).
// An empty value writes nothing. Returns { error } when it cannot.
function exportEnv(root, vars) {
  const set = Object.entries(vars).filter(([, v]) => v);
  if (!set.length) return {};
  const file = process.env.CLAUDE_ENV_FILE;
  if (!file) return { error: "no CLAUDE_ENV_FILE (Claude Code gives it to SessionStart hooks only)" };
  const lines = [];
  for (const [k, v] of set) {
    const val = String(v).replace(/\\/g, "/");
    if (val.includes("'")) return { error: `${k} holds a quote` };
    lines.push(`export ${k}='${val}'\n`);
  }
  fs.appendFileSync(file, lines.join(""));
  return {};
}

module.exports = {
  name, bypass, models, projectRoot, event, deny, context, keepGoing,
  contextTokens, lastAssistantText, lastHumanPrompt, sessionModel,
  home, skillDirs, agentsDir, hooksDir, teamSkills, skipHooks, agentFile, contextModeOn, registerLead, prepareWorker, ownedFile, LEAD_HOOKS, exportEnv,
};

// OpenAI Codex CLI adapter (0.159): maps Codex's hook JSON to the Proteus event (see proteus-harness.js),
// reads its rollout transcripts, and registers the hooks in .codex/hooks.json. Codex's hook
// answers copy Claude Code's (exit 2 + stderr, permissionDecision, additionalContext, decision
// "block"), so those come from the Claude adapter.
//
// Gaps against Claude Code, each a rule the hooks cannot enforce here:
//   - a shell call's background mode (yield_time_ms) is not in the hook input: background=false
//   - no failed-tool event, no teammate idle event, no running-task list on SubagentStop
//   - no scriptable status line
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { tailLines, legacyWorktreeDir, legacyWorktrees, git } = require(path.join(__dirname, "proteus-lib.js"));
const claude = require(path.join(__dirname, "proteus-harness-claude.js"));

const name = "codex";
// no default ladder: single-model mode (the lead's model) until models.ladder names the rungs
const models = null;
const bypass = "PROTEUS=0 codex";

const KINDS = {
  SessionStart: "session-start",
  UserPromptSubmit: "prompt",
  PreToolUse: "pre-tool",
  PostToolUse: "post-tool",
  Stop: "stop",
  SubagentStop: "subagent-stop",
};
// tool_name is always the canonical name; Edit, Write and Agent are matcher aliases only.
// Multi-agent v2 prefixes its tools with a namespace ("collaborationspawn_agent" by default, and
// configurable), so a spawn is any name ending in spawn_agent.
const TOOLS = { apply_patch: "edit", Bash: "shell", view_image: "read" };
const toolKind = (name) => TOOLS[name] || (String(name || "").endsWith("spawn_agent") ? "spawn" : "");

// hooks get no project-dir variable; a hook installed in <root>/.codex/hooks knows its root
const installedRoot = () => (path.basename(path.dirname(__dirname)) === ".codex" ? path.dirname(path.dirname(__dirname)) : "");
const projectRoot = (raw) => process.env.PROTEUS_PROJECT_DIR || installedRoot() || (raw && raw.cwd) || process.cwd();

// every file a patch touches: "*** Add File: p", "*** Update File: p", "*** Delete File: p", "*** Move to: p"
const PATCH_FILE = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+?)\s*$/gm;
function patchPaths(text, cwd) {
  const out = [];
  for (const m of String(text).matchAll(PATCH_FILE)) out.push(cwd ? path.resolve(cwd, m[1]) : m[1]);
  return out;
}
// the model may also run apply_patch through the shell; that is still an edit
const SHELL_PATCH = /^\s*apply_patch\b[\s\S]*\*\*\* Begin Patch/;

function event(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const ti = r.tool_input && typeof r.tool_input === "object" ? r.tool_input : {};
  const cmd = typeof ti.command === "string" ? ti.command : "";
  let tool = toolKind(r.tool_name);
  if (tool === "shell" && SHELL_PATCH.test(cmd)) tool = "edit";
  const img = ti.path || ti.file_path || ti.image_path || "";
  const paths = tool === "edit" ? patchPaths(cmd, r.cwd) : tool === "read" && img ? [r.cwd ? path.resolve(r.cwd, img) : img] : [];
  return {
    kind: KINDS[r.hook_event_name] || "",
    session: r.session_id || "",
    cwd: r.cwd || "",
    root: projectRoot(r),
    source: r.source || "",
    agent: r.agent_id || "",
    agentType: r.agent_type || "",
    teammate: "",
    model: typeof r.model === "string" ? r.model : "",
    tool,
    toolName: r.tool_name || "",
    toolUseId: r.tool_use_id || "",
    path: paths[0] || "",
    paths,
    command: tool === "shell" ? cmd : "",
    background: false,
    spawnModel: typeof ti.model === "string" ? ti.model : "",
    prompt: typeof r.prompt === "string" ? r.prompt : "",
    fromHuman: true, // UserPromptSubmit fires for submitted user input only
    output: outputText(r.tool_response),
    error: "",
    stopActive: r.stop_hook_active === true,
    busy: false,
    raw: r,
  };
}

// Bash: one merged string; other tools: the model-facing output, a string or content items
function outputText(res) {
  if (typeof res === "string") return res;
  if (Array.isArray(res)) return res.map((c) => (c && typeof c.text === "string" ? c.text : "")).filter(Boolean).join("\n");
  return res && typeof res === "object" && typeof res.output === "string" ? res.output : "";
}

const { deny, context, keepGoing } = claude;

// ---- rollouts: JSONL, {timestamp, type, payload}; each subagent has its own file

function* entriesBackward(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    let e;
    try { e = JSON.parse(lines[i]); } catch { continue; }
    if (e && typeof e === "object" && e.payload && typeof e.payload === "object") yield e;
  }
}

// context size: the newest token_count's last_token_usage (after a compaction, Codex's estimate)
function contextTokens(ev) {
  const lines = tailLines(ev.raw.transcript_path).filter((l) => l.includes('"token_count"'));
  for (const e of entriesBackward(lines)) {
    const info = e.type === "event_msg" && e.payload.type === "token_count" && e.payload.info;
    const n = info && info.last_token_usage && +info.last_token_usage.total_tokens;
    if (n > 0) return n;
  }
  return 0;
}

const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c)
  ? c.filter((b) => b && (b.type === "output_text" || b.type === "input_text" || b.type === "text") && typeof b.text === "string").map((b) => b.text).join("\n") : "");
const message = (e, role) => e.type === "response_item" && e.payload.type === "message" && e.payload.role === role;

function lastAssistantText(ev) {
  if (typeof ev.raw.last_assistant_message === "string") return ev.raw.last_assistant_message;
  for (const e of entriesBackward(tailLines(ev.raw.agent_transcript_path || ev.raw.transcript_path))) {
    if (e.type === "event_msg" && e.payload.type === "task_complete" && typeof e.payload.last_agent_message === "string") return e.payload.last_agent_message;
    if (!message(e, "assistant")) continue;
    const text = textOf(e.payload.content);
    if (text.trim()) return text;
  }
  return "";
}

// user-role text Codex injects itself: instructions, environment, skills, notifications
const INJECTED = /^\s*(# AGENTS\.md instructions|<(environment_context|environments_state|external_|skill|skills_instructions|user_shell_command|turn_aborted|subagent_notification|git_attribution|hook_prompt|agent_message_board|user_instructions))/;
function humanText(e) {
  const p = e.payload;
  if (e.type === "event_msg" && p.type === "user_message") return typeof p.message === "string" ? p.message : "";
  if (e.type === "event_msg" && p.type === "item_completed" && p.item && p.item.type === "UserMessage") return textOf(p.item.content);
  if (!message(e, "user")) return null;
  const kinds = p.internal_chat_message_metadata_passthrough && p.internal_chat_message_metadata_passthrough.content_item_kinds;
  if (Array.isArray(kinds) && kinds.length && !kinds.every((k) => String(k).startsWith("user."))) return "";
  const text = textOf(p.content);
  return INJECTED.test(text) ? "" : text;
}
// newest prompt the human typed; null when none is found or a compaction came since
function lastHumanPrompt(ev) {
  const lines = tailLines(ev.raw.transcript_path, 4 * 1024 * 1024)
    .filter((l) => l.includes('"compacted"') || l.includes('"user_message"') || l.includes('"UserMessage"') || l.includes('"role":"user"'));
  for (const e of entriesBackward(lines)) {
    if (e.type === "compacted") return null;
    const text = humanText(e);
    if (text && text.trim()) return text;
  }
  return null;
}

// every hook but SessionEnd carries the model; turn_context records it per turn
function sessionModel(ev) {
  if (ev.model) return ev.model;
  for (const e of entriesBackward(tailLines(ev.raw.transcript_path).filter((l) => l.includes('"turn_context"')))) {
    if (e.type === "turn_context" && typeof e.payload.model === "string" && e.payload.model) return e.payload.model;
  }
  return "";
}

// ---- install

const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const skillDirs = (root) => [path.join(root, ".agents", "skills", "proteus"), path.join(os.homedir(), ".agents", "skills", "proteus")];
const agentsDir = path.join(home, "agents");
const hooksDir = (root) => path.join(root, ".codex", "hooks");
// never loaded by a spawned worker (it keeps the lead's cwd): the worker reads the SKILL.md files
const teamSkills = (team) => path.join(team, ".agents", "skills");
// Claude Code only: the status line, a worker's settings.local.json, and the commit-msg check,
// which the gates run from the committed teams/templates/hooks/ on every CLI
const skipHooks = ["proteus-statusline.js", "worktree-settings.local.json", "commit-msg.js"];

// an agent file in Codex's TOML. Never a model: a role's model overrides the spawn's, and the
// ladder picks the model per spawn. Tool limits do not carry over (roles cannot set them).
function agentFile(file, text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const field = (k) => { const f = new RegExp(`^${k}:\\s*(.*)$`, "m").exec(m[1]); return f ? f[1].trim().replace(/^(["'])(.*)\1$/, "$2") : ""; };
  const agent = field("name") || path.basename(file, ".md");
  const q = (s) => JSON.stringify(s); // a JSON string is a TOML basic string
  return {
    name: `${agent}.toml`,
    text: [`# generated by proteus from ${path.basename(file)}; edits are overwritten`, `name = ${q(agent)}`, `description = ${q(field("description") || agent)}`,
      `developer_instructions = ${q(m[2].trim())}`, ""].join("\n"),
  };
}

// config.toml as {"a\0b": {key: raw value}} per [a.b] table ("" is the root); enough for the
// few keys read here, not a TOML parser
function tomlTables(text) {
  const out = { "": {} };
  let cur = out[""];
  for (const l of String(text).split(/\r?\n/)) {
    if (/^\s*\[\[/.test(l)) { cur = {}; continue; } // an array of tables: nothing read here
    const h = /^\s*\[\s*([^[\]]+?)\s*\]\s*(#.*)?$/.exec(l);
    if (h) {
      const k = [...h[1].matchAll(/\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(?:\.|$)/g)].map((m) => m[2] ?? m[3] ?? m[1]).join("\0");
      cur = out[k] = out[k] || {};
      continue;
    }
    const kv = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.*?)\s*(#.*)?$/.exec(l);
    if (kv) cur[kv[1]] = kv[2];
  }
  return out;
}
// The required context-mode, either as an MCP server ([mcp_servers.context-mode]) or as a plugin:
// [plugins."context-mode@<marketplace>"] (enabled unless enabled = false) with a version installed
// in $CODEX_HOME/plugins/cache/<marketplace>/context-mode/<version>/, and [features] plugins on.
function contextModeOn() {
  let t;
  try { t = tomlTables(fs.readFileSync(path.join(home, "config.toml"), "utf8")); } catch { return false; }
  const off = (tbl) => tbl.enabled === "false";
  const mcp = t["mcp_servers\0context-mode"];
  if (mcp && !off(mcp)) return true;
  if (t.features && t.features.plugins === "false") return false;
  return Object.keys(t).some((k) => {
    const m = /^plugins\0context-mode@([^\0]+)$/.exec(k);
    if (!m || off(t[k])) return false;
    const dir = path.join(home, "plugins", "cache", m[1], "context-mode");
    try { return fs.readdirSync(dir, { withFileTypes: true }).some((e) => e.isDirectory() && /^[A-Za-z0-9._+-]+$/.test(e.name)); } catch { return false; }
  });
}

// [event, script, matcher, timeout s]; a matcher of only names and | is an exact-name list,
// anything else is an unanchored regex (the guard's catches every namespace's spawn_agent)
const LEAD_HOOKS = [
  ["SessionStart", "proteus-autostart.js", undefined, 60],
  ["UserPromptSubmit", "proteus-journal.js"],
  ["UserPromptSubmit", "proteus-lessons.js"],
  ["PreToolUse", "proteus-lead-guard.js", "^(apply_patch|Bash|view_image|[a-z_]*spawn_agent)$"],
  ["PreToolUse", "proteus-lessons.js", "Bash|apply_patch|view_image"],
  ["PostToolUse", "proteus-lessons.js", "Bash"],
  ["PreToolUse", "proteus-scratch.js", "Bash"],
  ["PostToolUse", "proteus-scratch.js", "Bash"],
  ["SubagentStop", "proteus-stall.js"],
];

// The sandbox keeps .git (a worktree's gitdir too) read-only and the network off, so the git
// writes and gh calls Proteus makes run outside it by rule. Everything else stays sandboxed;
// reset, clean and other history rewrites still ask.
const RULES = `# generated by proteus; edits are overwritten. Commands that run outside the sandbox.
prefix_rule(pattern=["git", ["add", "commit", "push", "fetch", "pull", "merge", "rebase", "checkout", "switch", "branch", "worktree", "tag", "stash", "restore", "cherry-pick", "revert", "rm", "mv"]], decision="allow", justification="proteus: workers commit in linked worktrees; the lead merges and pushes")
prefix_rule(pattern=["gh"], decision="allow", justification="proteus: the tracker is GitHub issues and PRs")
prefix_rule(pattern=["node", [".codex/hooks/proteus-worktree.js", ".codex/hooks/proteus-status.js", ".codex/hooks/proteus-inbox.js", ".codex/hooks/proteus-scratch.js", ".codex/hooks/proteus-verdict.js"]], decision="allow", justification="proteus: the lead's own scripts")
`;

// .codex/hooks.json (only adds; never removes a user hook) and .codex/rules/proteus.rules.
// Codex skips a new or changed hook until the human trusts it in /hooks, once per command.
function registerLead(root) {
  const file = path.join(root, ".codex", "hooks.json");
  let raw = null;
  try { raw = fs.readFileSync(file, "utf8"); } catch {}
  let s = {};
  if (raw !== null && raw.trim()) {
    try { s = JSON.parse(raw); } catch (e) { return { file, error: `${file} is not valid JSON (${e.message})` }; }
    if (!s || typeof s !== "object" || Array.isArray(s)) return { file, error: `${file} is not a JSON object` };
  }
  const before = JSON.stringify(s);
  s.hooks = s.hooks && typeof s.hooks === "object" ? s.hooks : {};
  // hooks run from the turn's cwd through the user's login shell: an absolute, quoted path
  const cmd = (f) => `node "${path.resolve(hooksDir(root), f).split(path.sep).join("/")}"`;
  for (const [ev, script, matcher, timeout] of LEAD_HOOKS) {
    const list = (s.hooks[ev] = Array.isArray(s.hooks[ev]) ? s.hooks[ev] : []);
    if (list.some((e) => JSON.stringify((e && e.hooks) || []).includes(script) && (e.matcher || undefined) === matcher)) continue;
    const entry = { hooks: [{ type: "command", command: cmd(script), ...(timeout && { timeout }) }] };
    if (matcher) entry.matcher = matcher;
    list.push(entry);
  }
  let changed = JSON.stringify(s) !== before;
  if (changed) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
  }
  const rules = path.join(root, ".codex", "rules", "proteus.rules");
  let old = null;
  try { old = fs.readFileSync(rules, "utf8"); } catch {}
  if (old !== RULES) {
    fs.mkdirSync(path.dirname(rules), { recursive: true });
    fs.writeFileSync(rules, RULES);
    changed = true;
  }
  return { file, changed };
}

// Worker worktrees live in ../<repo>-proteus/, outside the project, where workspace-write rejects a
// worker's apply_patch. The project's .codex/config.toml adds that folder to writable_roots; a
// textual merge (no TOML parser here) that refuses any shape it cannot edit safely. The legacy
// worktree folder a run from before the rename used stays listed while git still has a worktree
// registered in it (legacy: {dir, worktrees}), and goes once none is (stale: that dir).
// Returns {file, dir, created, changed, missing, legacy, stale} or {file, dir, error}; write=false only checks.
function sandboxRoots(root, write = true) {
  const abs = path.resolve(root);
  const dir = path.join(path.dirname(abs), `${path.basename(abs)}-proteus`);
  const file = path.join(abs, ".codex", "config.toml");
  const entry = JSON.stringify(dir); // a JSON string is a TOML basic string
  const table = `[sandbox_workspace_write]\nwritable_roots = [${entry}]\n`;
  const refuse = (why) => ({ file, dir, error: `${file} ${why}; add ${dir} to writable_roots under [sandbox_workspace_write] yourself` });
  let text = null;
  try { text = fs.readFileSync(file, "utf8"); } catch {}
  const done = (next, created) => {
    if (!write) return { file, dir, missing: true };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, next);
    // bwrap drops a writable root that does not exist yet
    fs.mkdirSync(dir, { recursive: true });
    return { file, dir, created, changed: true };
  };
  if (text === null) return done(table, true);
  // a multi-line string could hold a line that looks like a header
  if (/"""|'''/.test(text)) return refuse("has a multi-line string");
  const lines = text.split("\n");
  const heads = [];
  lines.forEach((l, i) => { if (/^\s*\[\s*sandbox_workspace_write\s*\]\s*(#.*)?\r?$/.test(l)) heads.push(i); });
  if (heads.length > 1) return refuse("has [sandbox_workspace_write] twice");
  // dotted keys or an inline table set the same table from elsewhere
  if (lines.some((l, i) => !heads.includes(i) && /^\s*(\[\s*)?["']?sandbox_workspace_write["']?\s*[.=]/.test(l) && !/^\s*\[\s*sandbox_workspace_write\s*\.\s*\w/.test(l)))
    return refuse("sets sandbox_workspace_write in a form this installer does not edit");
  // keep the file's own line endings (a CRLF file stays CRLF)
  const le = /\r\n/.test(text) ? "\r\n" : "\n";
  if (!heads.length) return done(`${text}${text && !text.endsWith("\n") ? le : ""}${text.trim() ? le : ""}${table.replace(/\n/g, le)}`, false);
  let end = heads[0] + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  const k = lines.slice(heads[0] + 1, end).findIndex((l) => /^\s*["']?writable_roots["']?\s*=/.test(l));
  if (k < 0) return done([...lines.slice(0, heads[0] + 1), `writable_roots = [${entry}]${le === "\r\n" ? "\r" : ""}`, ...lines.slice(heads[0] + 1)].join("\n"), false);
  // scan the array: strings, commas, whitespace and comments only
  const start = lines.slice(0, heads[0] + 1 + k).reduce((n, l) => n + l.length + 1, 0);
  let i = text.indexOf("=", start) + 1;
  while (/[ \t]/.test(text[i] || "")) i++;
  if (text[i] !== "[") return refuse("sets writable_roots to something other than an array");
  // values and commas as tokens with their offsets; comments and whitespace are skipped, never edited
  const vals = [], toks = [];
  for (i++; i < text.length; i++) {
    const c = text[i];
    if (/\s/.test(c)) continue;
    if (c === "#") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c === "]") break;
    if (c === ",") { toks.push({ comma: true, start: i, end: i + 1 }); continue; }
    const m = c === '"' ? /^"((?:[^"\\\n]|\\.)*)"/.exec(text.slice(i)) : c === "'" ? /^'([^'\n]*)'/.exec(text.slice(i)) : null;
    if (!m) return refuse("has a writable_roots value this installer cannot read");
    let v = m[1];
    if (c === '"') { try { v = JSON.parse(`"${v}"`); } catch {} }
    const x = { v, start: i, end: i + m[0].length };
    vals.push(x); toks.push(x); i += m[0].length - 1;
  }
  if (text[i] !== "]") return refuse("has an unterminated writable_roots array");
  const old = legacyWorktreeDir(abs);
  const isOld = (x) => path.resolve(x.v) === old;
  const live = vals.some(isOld) ? legacyWorktrees(abs) : [];
  const legacy = live.length ? { dir: old, worktrees: live } : null;
  const drop = live.length ? [] : vals.filter(isOld);
  const stale = drop.length ? old : null;
  const has = vals.some((x) => path.resolve(x.v) === dir);
  if (has && !stale) {
    if (write) fs.mkdirSync(dir, { recursive: true });
    return { file, dir, created: false, changed: false, legacy };
  }
  if (!write) return { file, dir, missing: !has, stale, legacy };
  // each stale entry goes with one comma token beside it (the next, else the one before), so the rest stays
  // comma-separated and a comment between them stays put; ours goes in before the ], after a comma when the
  // last token left is a value. Tokens, not text: a `#` or `,` inside a string is never read as syntax.
  const gone = new Set();
  for (const x of drop) {
    const j = toks.indexOf(x), after = toks[j + 1], before = toks[j - 1];
    gone.add(x);
    if (after && after.comma && !gone.has(after)) gone.add(after);
    else if (before && before.comma && !gone.has(before)) gone.add(before);
  }
  const left = toks.filter((t) => !gone.has(t));
  let next = text;
  if (!has) next = `${next.slice(0, i)}${left.length && !left[left.length - 1].comma ? ", " : ""}${entry}${next.slice(i)}`;
  for (const t of [...gone].sort((a, b) => b.start - a.start)) {
    const pad = /^[ \t]*/.exec(next.slice(t.end))[0].length; // the blanks after it go too
    next = next.slice(0, t.start) + next.slice(t.end + pad);
  }
  fs.writeFileSync(file, next);
  fs.mkdirSync(dir, { recursive: true });
  return { file, dir, created: false, changed: true, legacy, stale };
}

// Subagents run in the lead's session under its hooks, which enforce owned paths; the copies
// here are the backup for a codex session opened inside the worktree.
const WORKER_HOOKS = ["proteus-lib.js", "proteus-harness.js", "proteus-harness-claude.js", "proteus-harness-codex.js", "proteus-owned-paths.js", "proteus-worker-guard.js", "proteus-stall.js", "proteus-lessons.js", "proteus-scratch.js", "proteus-gh.js"];
const WORKER_EXCLUDE = ["/.codex/proteus-owned", "/.codex/hooks/proteus-*.js"];
function prepareWorker(wt, src) {
  const dir = hooksDir(wt);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of WORKER_HOOKS) fs.copyFileSync(path.join(src, f), path.join(dir, f));
  return WORKER_EXCLUDE;
}
// under .codex, which the sandbox keeps read-only for the worker itself
const ownedFile = (wt) => path.join(wt, ".codex", "proteus-owned");

// vars for the agents' shell commands: Codex has no env file, so they go under [shell_environment_policy.set] in the
// project's .codex/config.toml, which applies to every Codex session in the project. An empty value drops the key.
// Edits only the file install.js --project made (untracked: a path on this machine is never committed) and only
// where it can read it safely; returns { file, changed } or { file, error }.
function exportEnv(root, vars) {
  const file = path.join(path.resolve(root), ".codex", "config.toml");
  const refuse = (why) => ({ file, error: `${file} ${why}; set ${Object.keys(vars).join(", ")} under [shell_environment_policy.set] in $CODEX_HOME/config.toml yourself` });
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return Object.values(vars).some(Boolean) ? refuse("is missing (install.js --project --harness codex makes it)") : { file, changed: false }; }
  if (git(["ls-files", "--", ".codex/config.toml"], root)) return refuse("is tracked by git, and a path on this machine does not belong in it");
  if (/"""|'''/.test(text)) return refuse("has a multi-line string");
  const t = tomlTables(text);
  const le = /\r\n/.test(text) ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  // an inline table or a dotted key holds the same setting where a line edit cannot see it
  let table = "";
  const dotted = lines.some((l) => {
    const h = /^\s*\[\s*([^[\]]+?)\s*\]/.exec(l);
    if (h) { table = h[1].replace(/\s+/g, ""); return false; }
    return (table === "" && /^\s*shell_environment_policy\s*\./.test(l)) || (table === "shell_environment_policy" && /^\s*set\s*\./.test(l));
  });
  if ((t.shell_environment_policy && "set" in t.shell_environment_policy) || "shell_environment_policy" in t[""] || dotted)
    return refuse("sets shell_environment_policy.set in a form this installer does not edit");
  const heads = lines.flatMap((l, i) => (/^\s*\[\s*shell_environment_policy\s*\.\s*set\s*\]\s*(#.*)?$/.test(l) ? [i] : []));
  if (heads.length > 1) return refuse("has [shell_environment_policy.set] twice");
  let changed = false;
  for (const [k, v] of Object.entries(vars)) {
    const line = `${k} = ${JSON.stringify(String(v))}`; // a JSON string is a TOML basic string
    let h = lines.findIndex((l) => /^\s*\[\s*shell_environment_policy\s*\.\s*set\s*\]/.test(l));
    if (h < 0) {
      if (!v) continue;
      while (lines.length && lines[lines.length - 1] === "") lines.pop();
      lines.push(...(lines.length ? [""] : []), "[shell_environment_policy.set]", line, "");
      changed = true;
      continue;
    }
    let end = h + 1;
    while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
    const at = lines.slice(h + 1, end).findIndex((l) => new RegExp(`^\\s*["']?${k}["']?\\s*=`).test(l));
    if (at >= 0 && v && lines[h + 1 + at] === line) continue;
    if (at >= 0) lines.splice(h + 1 + at, 1, ...(v ? [line] : []));
    else if (v) lines.splice(h + 1, 0, line);
    else continue;
    changed = true;
  }
  if (!changed) return { file, changed: false };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join(le));
  return { file, changed: true };
}

module.exports = {
  name, bypass, models, projectRoot, event, deny, context, keepGoing,
  contextTokens, lastAssistantText, lastHumanPrompt, sessionModel,
  home, skillDirs, agentsDir, hooksDir, teamSkills, skipHooks, agentFile, contextModeOn, registerLead, prepareWorker, ownedFile, LEAD_HOOKS,
  patchPaths, RULES, sandboxRoots, exportEnv,
};

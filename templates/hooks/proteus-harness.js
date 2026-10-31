// The harness adapter for this process: everything that differs between coding-agent CLIs.
// PROTEUS_HARNESS names it; else the CLI whose folder these hooks are installed in (<root>/.codex/hooks
// is codex: install.js put them there, and unlike env it is not inherited); elsewhere (a plugin cache) the
// CLI's own env: Claude Code sets CLAUDE_PROJECT_DIR for every hook, Codex never does but copies its
// CLAUDE_PLUGIN_ROOT for a plugin's hooks; else claude. An adapter is proteus-harness-<name>.js beside this file.
// The hooks never read a CLI's hook JSON themselves: they get one Proteus event and answer through
// the adapter, so a new CLI is one new adapter file, not a change to every hook.
//
// Hive event (adapter.event(raw)); a field the CLI does not report is "" or false:
//   kind         session-start | prompt | pre-tool | post-tool | tool-failed | stop | subagent-stop | idle
//   session, cwd, root (the project dir), source (session-start: startup|resume|clear|compact|fork)
//   agent, agentType, teammate   set inside a subagent or teammate; "" on the main thread
//   permissionMode   the session's permission mode (default, acceptEdits, auto, plan, dontAsk, bypassPermissions)
//   model        the session's model when the event carries it
//   tool         edit | read | shell | monitor | spawn | "" (anything else); toolName is the CLI's own
//   path, command, background, spawnModel, spawnType, spawnName, toolUseId   from the tool call (spawnType: the agent
//                spawned; spawnName: the name the spawn gives it, which Claude Code then reports as its agentType)
//   workdir      the shell tool's own working dir (relative to cwd) when the CLI's shell takes one
//   paths        every file the call touches (one patch can edit several); path is the first
//   prompt, fromHuman   a submitted prompt, and whether the human typed it
//   output, error       a finished tool call's stdout+stderr and error text
//   stopActive, busy    the stop was already blocked once; background work is still running
//   raw          the CLI's own JSON, for the adapter's transcript readers only
//
// Adapter contract (see proteus-harness-claude.js for the reference):
//   answers      deny(why, {json}) · context(ev, text, kind) · keepGoing(ev, reason)
//                ask(why) (PreToolUse: the human decides in a permission dialog) · noAsk(ev) (why no such
//                dialog can reach the human here, "" when it can; the caller denies instead of asking)
//                postRecords (a post-tool hook, proteus-verdict-record.js, records a verdict after its dialog; false
//                sends a local-mode verdict to the human's own terminal)
//                postBlock(ev, reason) (after the tool ran: the reason reaches the model as feedback to act on)
//   transcript   contextTokens(ev) · lastAssistantText(ev) · lastHumanPrompt(ev) · sessionModel(ev)
//                briefText(ev) (a subagent's brief, the lead's spawn prompt; "" when the CLI cannot show it)
//   window       modelWindow(model, ev) (the model's nominal context window) · contextCap(ev, model) (the
//                cap the human configured); each 0 when unknown, and both optional
//   models       the default ladder {ladder, floor, solo, aliases, tiers}, or null for single-model mode
//   spawnEffort  the spawn tool's per-spawn effort parameter, "" when it has none
//   install      name · bypass · projectRoot(raw) · home · skillDirs(root) · agentsDir · agentFile(file, text)
//                skillRoots() (dirs holding other plugins' and installed skills, searched by proteus-skillpath.js)
//                hooksDir(root) · teamSkills(teamDir) (where link-skills.js links a team's skills for this CLI)
//                skipHooks (template files this CLI never uses: not copied into hooksDir)
//                contextModeOn() · registerLead(root) · prepareWorker(wt, src) · ownedFile(wt)
//                allowDir(root, dir, write) (guest mode: the session may read and write dir, outside the project)
//                exportEnv(root, vars) (env for the agents' shell commands; SessionStart only on claude)
"use strict";
const path = require("path");

const INSTALLED = { ".codex": "codex" };
const env = process.env;
const fromEnv = env.CLAUDE_PROJECT_DIR ? "claude" : env.CLAUDE_PLUGIN_ROOT ? "codex" : "";
const want = String(env.PROTEUS_HARNESS || INSTALLED[path.basename(path.dirname(__dirname))] || fromEnv || "claude").toLowerCase().replace(/[^a-z0-9-]/g, "");
let adapter;
try { adapter = require(path.join(__dirname, `proteus-harness-${want}.js`)); } catch { adapter = require(path.join(__dirname, "proteus-harness-claude.js")); }

module.exports = adapter;

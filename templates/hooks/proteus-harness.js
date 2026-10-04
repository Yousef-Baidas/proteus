// The harness adapter for this process: everything that differs between coding-agent CLIs.
// PROTEUS_HARNESS names it; else the CLI whose folder these hooks are installed in (<root>/.codex/hooks
// is codex), else claude. An adapter is proteus-harness-<name>.js beside this file.
// The hooks never read a CLI's hook JSON themselves: they get one Proteus event and answer through
// the adapter, so a new CLI is one new adapter file, not a change to every hook.
//
// Hive event (adapter.event(raw)); a field the CLI does not report is "" or false:
//   kind         session-start | prompt | pre-tool | post-tool | tool-failed | stop | subagent-stop | idle
//   session, cwd, root (the project dir), source (session-start: startup|resume|clear|compact|fork)
//   agent, agentType, teammate   set inside a subagent or teammate; "" on the main thread
//   model        the session's model when the event carries it
//   tool         edit | read | shell | monitor | spawn | "" (anything else); toolName is the CLI's own
//   path, command, background, spawnModel, toolUseId   from the tool call
//   paths        every file the call touches (one patch can edit several); path is the first
//   prompt, fromHuman   a submitted prompt, and whether the human typed it
//   output, error       a finished tool call's stdout+stderr and error text
//   stopActive, busy    the stop was already blocked once; background work is still running
//   raw          the CLI's own JSON, for the adapter's transcript readers only
//
// Adapter contract (see proteus-harness-claude.js for the reference):
//   answers      deny(why, {json}) · context(ev, text, kind) · keepGoing(ev, reason)
//   transcript   contextTokens(ev) · lastAssistantText(ev) · lastHumanPrompt(ev) · sessionModel(ev)
//   models       the default ladder {ladder, floor, solo}, or null for single-model mode
//   install      name · bypass · projectRoot(raw) · home · skillDirs(root) · agentsDir · agentFile(file, text)
//                hooksDir(root) · teamSkills(teamDir) (where link-skills.js links a team's skills for this CLI)
//                skipHooks (template files this CLI never uses: not copied into hooksDir)
//                contextModeOn() · registerLead(root) · prepareWorker(wt, src) · ownedFile(wt)
//                exportEnv(root, vars) (env for the agents' shell commands; SessionStart only on claude)
"use strict";
const path = require("path");

const INSTALLED = { ".codex": "codex" };
const want = String(process.env.PROTEUS_HARNESS || INSTALLED[path.basename(path.dirname(__dirname))] || "claude").toLowerCase().replace(/[^a-z0-9-]/g, "");
let adapter;
try { adapter = require(path.join(__dirname, `proteus-harness-${want}.js`)); } catch { adapter = require(path.join(__dirname, "proteus-harness-claude.js")); }

module.exports = adapter;

#!/usr/bin/env node
// Writes hooks/hooks.json, the Claude Code plugin's hooks, from the Claude adapter's LEAD_HOOKS (pluginHooks()),
// so the plugin and install.js register the same events, matchers and timeouts. tests/pluginlayout.test.js fails
// when the file differs. Usage: node scripts/plugin-hooks.js. Exit 0 once written.
"use strict";
const fs = require("fs");
const path = require("path");

const ad = require(path.join(__dirname, "..", "templates", "hooks", "proteus-harness-claude.js"));
const file = path.join(__dirname, "..", "hooks", "hooks.json");
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(ad.pluginHooks(), null, 2) + "\n");
console.log(`wrote ${path.relative(process.cwd(), file)}`);

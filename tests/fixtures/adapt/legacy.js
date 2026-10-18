// Adaptability fixture (#170) for tests/adapt.test.js: an Express shop whose test suite is already red on main.
// build(dir, { g, write }) makes the git repo in dir; regress(dir, { g, write }) adds one more failing test, a
// regression the baseline ratchet must catch. Expectations in legacy.json. No exit code: a module, not a CLI.
"use strict";

const TEST = (extra) => `"use strict";
const { total } = require("../src/cart.js");
const cases = [
  ["total of no items is 0", () => total([]) === 0],
  ["total adds 20% tax", () => total([{ price: 10 }]) === 12],
${extra}];
let bad = 0;
cases.forEach(([name, f], i) => { const pass = f(); if (!pass) bad++; console.log(\`\${pass ? "ok" : "not ok"} \${i + 1} - \${name}\`); });
process.exitCode = bad ? 1 : 0;
`;

function build(dir, { g, write }) {
  write(dir, {
    "package.json": JSON.stringify({ name: "shop", version: "0.3.0", private: true, scripts: { start: "node src/server.js", test: "node test/run.js" }, dependencies: { express: "4.19.2" } }, null, 2) + "\n",
    "src/server.js": "\"use strict\";\nconst express = require(\"express\");\nconst { total } = require(\"./cart.js\");\nconst app = express();\napp.use(express.json());\napp.post(\"/total\", (req, res) => res.json({ total: total(req.body.items || []) }));\napp.listen(process.env.PORT || 3000);\n",
    // the bug the red suite reports: tax was never added
    "src/cart.js": "\"use strict\";\nexports.total = (items) => items.reduce((s, i) => s + i.price, 0);\n",
    "test/run.js": TEST(""),
    "README.md": "# shop\n\nA small checkout API. `npm test` has failed since the tax change.\n",
  });
  g(dir, "add", "-A");
  g(dir, "commit", "-q", "-m", "shop: checkout api");
  g(dir, "remote", "add", "origin", "https://example.invalid/acme/shop.git");
}

function regress(dir, { write }) {
  write(dir, { "test/run.js": TEST("  [\"total ignores a missing price\", () => total([{}]) === 0],\n") });
}

module.exports = { build, regress };

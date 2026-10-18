// Adaptability fixture (#170) for tests/adapt.test.js: a Docusaurus docs site and nothing else (its React and CSS
// are the site's, not an app's). build(dir, { g, write }) makes the git repo in dir. Expectations in
// docs-site.json. No exit code: a module, not a CLI.
"use strict";

function build(dir, { g, write }) {
  write(dir, {
    "package.json": JSON.stringify({ name: "acme-docs", private: true, scripts: { start: "docusaurus start", build: "docusaurus build" },
      dependencies: { "@docusaurus/core": "3.4.0", "@docusaurus/preset-classic": "3.4.0", react: "18.3.1", "react-dom": "18.3.1" } }, null, 2) + "\n",
    "docusaurus.config.js": "module.exports = { title: \"Acme\", url: \"https://docs.example.invalid\", baseUrl: \"/\", presets: [[\"classic\", {}]] };\n",
    "sidebars.js": "module.exports = { docs: [\"intro\", \"guides/install\"] };\n",
    "docs/intro.md": "# Introduction\n\nAcme in five minutes.\n",
    "docs/guides/install.md": "# Install\n\nRun the installer.\n",
    "src/pages/index.js": "import React from \"react\";\nexport default function Home() { return <main>Acme docs</main>; }\n",
    "src/css/custom.css": ":root { --ifm-color-primary: #2e8555; }\n",
    "static/img/logo.svg": "<svg xmlns=\"http://www.w3.org/2000/svg\"/>\n",
    "README.md": "# acme-docs\n\n`npm start` serves the site.\n",
  });
  g(dir, "add", "-A");
  g(dir, "commit", "-q", "-m", "docs site");
  g(dir, "remote", "add", "origin", "https://example.invalid/acme/docs.git");
}

module.exports = { build };

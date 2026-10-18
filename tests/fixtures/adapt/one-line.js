// Adaptability fixture (#170) for tests/adapt.test.js: a mature small Python library (releases tagged, CI, tests,
// changelog) where the work order is a one-line fix. build(dir, { g, write }) makes the git repo in dir with its
// history. Expectations in one-line.json. No exit code: a module, not a CLI.
"use strict";

const CORE = (strip) => `import re

_SEP = re.compile(r"[^a-z0-9]+")


def slugify(text):
    """Lower-case text and join its words with hyphens."""
    return _SEP.sub("-", text.lower())${strip}
`;

function build(dir, { g, write }) {
  write(dir, {
    "pyproject.toml": "[project]\nname = \"slugkit\"\nversion = \"1.4.0\"\nrequires-python = \">=3.9\"\ndependencies = []\n\n[project.optional-dependencies]\ntest = [\"pytest\"]\n",
    "src/slugkit/__init__.py": "from .core import slugify\n\n__all__ = [\"slugify\"]\n",
    "src/slugkit/core.py": CORE(".strip(\"-\")"),
    "tests/test_core.py": "from slugkit import slugify\n\n\ndef test_words():\n    assert slugify(\"Hello World\") == \"hello-world\"\n",
    ".github/workflows/ci.yml": "on: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: pip install -e .[test] && pytest\n",
    "CHANGELOG.md": "# Changelog\n\n## 1.4.0\n\n- Strip leading and trailing hyphens.\n",
    "LICENSE": "MIT\n",
    "README.md": "# slugkit\n\n`slugify(\"Hello World\")` gives `hello-world`.\n",
  });
  g(dir, "add", "-A");
  g(dir, "commit", "-q", "-m", "slugkit 1.4.0");
  g(dir, "tag", "v1.4.0");
  // the bug the work order fixes, one line: a release that dropped the strip
  write(dir, { "src/slugkit/core.py": CORE(""), "pyproject.toml": "[project]\nname = \"slugkit\"\nversion = \"1.4.1\"\nrequires-python = \">=3.9\"\ndependencies = []\n\n[project.optional-dependencies]\ntest = [\"pytest\"]\n" });
  g(dir, "commit", "-q", "-am", "slugkit 1.4.1: faster separator");
  g(dir, "tag", "v1.4.1");
  g(dir, "remote", "add", "origin", "https://example.invalid/acme/slugkit.git");
}

module.exports = { build };

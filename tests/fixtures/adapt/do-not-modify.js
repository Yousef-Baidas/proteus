// Adaptability fixture (#170) for tests/adapt.test.js: a Go module the human may read but not push to. Proteus has
// no in-repo marker that makes a repo read-only for agents; the signal it does recognise is gh reporting READ
// access with no teams/ of its own (install.js guest mode), so do-not-modify.json sets FAKE_GH_PERMISSION=READ.
// build(dir, { g, write }) makes the git repo in dir. No exit code: a module, not a CLI.
"use strict";

function build(dir, { g, write }) {
  write(dir, {
    "go.mod": "module example.invalid/upstream/units\n\ngo 1.22\n",
    "units.go": "package units\n\n// Bytes formats n as a human-readable size.\nfunc Bytes(n int64) string {\n\treturn format(n, 1024, \"B\")\n}\n",
    "format.go": "package units\n\nimport \"fmt\"\n\nfunc format(n, base int64, unit string) string {\n\treturn fmt.Sprintf(\"%d %s\", n, unit)\n}\n",
    "units_test.go": "package units\n\nimport \"testing\"\n\nfunc TestBytes(t *testing.T) {\n\tif Bytes(1) != \"1 B\" {\n\t\tt.Fatal(Bytes(1))\n\t}\n}\n",
    "README.md": "# units\n\nUpstream library, vendored read-only: report bugs upstream, do not change it here.\n",
  });
  g(dir, "add", "-A");
  g(dir, "commit", "-q", "-m", "units v1.2.0");
  g(dir, "remote", "add", "origin", "https://example.invalid/upstream/units.git");
}

module.exports = { build };

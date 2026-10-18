// Adaptability fixture (#170) for tests/adapt.test.js: a game-art repo, binary assets (a .blend, a .psd, PNGs)
// beside one small export script, no remote and no CI. build(dir, { g, write }) makes the git repo in dir.
// Expectations in binary.json. No exit code: a module, not a CLI.
"use strict";

// a file that starts with the format's real magic bytes and then holds bytes no text diff can read
const blob = (magic, n) => Buffer.concat([Buffer.from(magic, "latin1"), Buffer.from(Array.from({ length: n }, (_, i) => (i * 37 + 11) % 256))]);

function build(dir, { g, write }) {
  write(dir, {
    "assets/hero.blend": blob("BLENDER-v300", 2048),
    "assets/hero.png": blob("\x89PNG\r\n\x1a\n", 512),
    "assets/tiles/grass.png": blob("\x89PNG\r\n\x1a\n", 256),
    "art/cover.psd": blob("8BPS\x00\x01", 1024),
    "tools/export.py": "import sys\n\n\ndef main(path):\n    print(f\"exporting {path}\")\n\n\nif __name__ == \"__main__\":\n    main(sys.argv[1])\n",
    ".gitattributes": "*.blend binary\n*.psd binary\n*.png binary\n",
    "README.md": "# hero art\n\nSource art for the hero sprite. `python tools/export.py assets/hero.blend` exports the PNGs.\n",
  });
  g(dir, "add", "-A");
  g(dir, "commit", "-q", "-m", "hero art and the export script");
}

module.exports = { build };

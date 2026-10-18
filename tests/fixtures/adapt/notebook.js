// Adaptability fixture (#170) for tests/adapt.test.js: data analysis in Jupyter notebooks with a requirements.txt
// and a CSV, no package and no scripts. build(dir, { g, write }) makes the git repo in dir. Expectations in
// notebook.json. No exit code: a module, not a CLI.
"use strict";

const notebook = (cells) => JSON.stringify({
  cells: cells.map(([type, src]) => ({ cell_type: type, metadata: {}, source: [src], ...(type === "code" ? { execution_count: null, outputs: [] } : {}) })),
  metadata: { kernelspec: { display_name: "Python 3", language: "python", name: "python3" } }, nbformat: 4, nbformat_minor: 5,
}, null, 1) + "\n";

function build(dir, { g, write }) {
  write(dir, {
    "requirements.txt": "numpy==1.26.4\npandas==2.2.2\nmatplotlib==3.9.0\njupyterlab==4.2.1\n",
    "notebooks/explore.ipynb": notebook([["markdown", "# Sales by region"], ["code", "import pandas as pd\ndf = pd.read_csv(\"../data/sales.csv\")\ndf.groupby(\"region\").sum()"]]),
    "notebooks/forecast.ipynb": notebook([["code", "import numpy as np\nnp.polyfit([1, 2, 3], [2, 4, 7], 1)"]]),
    "data/sales.csv": "region,amount\nnorth,10\nsouth,7\n",
    "README.md": "# sales analysis\n\n`pip install -r requirements.txt`, then `jupyter lab`.\n",
  });
  g(dir, "add", "-A");
  g(dir, "commit", "-q", "-m", "sales notebooks");
  g(dir, "remote", "add", "origin", "https://example.invalid/acme/sales.git");
}

module.exports = { build };

#!/usr/bin/env python3
"""Build a shareable copy of the calculator with the current actual data embedded.

Usage: build_share.py <dump_dir> <out_html>
  dump_dir holds one JSON file per document (production.json, sales.json,
  expenses.json, daily.json), as the artifact database exports them.
"""
import json, sys, os, datetime, re
src = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "index.html")
dump, out = sys.argv[1], sys.argv[2]
docs = {}
for t in ("production", "sales", "expenses", "daily"):
    f = os.path.join(dump, t + ".json")
    if os.path.exists(f):
        with open(f, encoding="utf-8") as fh:
            d = json.load(fh)
        docs[t] = {"rows": d.get("rows", []), "fileName": d.get("fileName", ""), "updatedAt": d.get("updatedAt", "")}
seed = {"exportedAt": datetime.date.today().isoformat(), "docs": docs}
html = open(src, encoding="utf-8").read()
payload = json.dumps(seed, ensure_ascii=False).replace("</", "<\\/")
html, n = re.subn(r'<script id="seedData" type="application/json">.*?</script>',
                  '<script id="seedData" type="application/json">' + payload + '</script>', html, count=1, flags=re.S)
assert n == 1, "seed slot not found"
os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
open(out, "w", encoding="utf-8").write(html)
print(out, len(html), "bytes;", {t: len(v["rows"]) for t, v in docs.items()})

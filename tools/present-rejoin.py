#!/usr/bin/env python3
"""Recompute the presented-frame fields of a tools/tv-present-bench.sh output directory from its kept raw dumps
(<dir>/raw/<label>-<scenario>-<round>.{gfx,lat}.txt), after present-parse.py / present-join.py changed.
    python tools/present-rejoin.py <dir>"""
import sys, os, json, glob, importlib.util

here = os.path.dirname(os.path.abspath(__file__))


def mod(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), os.path.join(here, name + ".py"))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


pp, pj = mod("present-parse"), mod("present-join")
d = sys.argv[1]
for f in sorted(glob.glob(os.path.join(d, "*.jsonl"))):
    out = []
    for line in open(f, encoding="utf-8"):
        if not line.strip().startswith("{"):
            continue
        r = json.loads(line)
        base = os.path.join(d, "raw", f"{r['label']}-{r['scenario']}-{r['run']}")
        if os.path.exists(base + ".lat.txt"):
            for k in ("q2l_p50", "q2l_p90", "deep_pct", "deep2_pct", "replaced"):
                r.pop(k, None)
            period, rows = pp.parse(open(base + ".lat.txt", encoding="utf-8", errors="replace").read())
            r.update(pp.measure(period, rows))
            r.update(pj.measure(pj.join(base + ".gfx.txt", base + ".lat.txt")))
        out.append(json.dumps(r))
    with open(f, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(out) + "\n")

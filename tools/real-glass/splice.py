# lab helper: replace the "Real glass" section of glass.css with a draft file
import sys
p = "public/css/glass.css"
s = open(p, encoding="utf-8").read()
i = s.index("/* ---------- Real glass: refraction")
s = s[:i] + open(sys.argv[1], encoding="utf-8").read()
open(p, "w", encoding="utf-8", newline="\n").write(s)

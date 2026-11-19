# lab helper: exact replacements in a file, pairs read from a JSON file
#   python patch.py <file> <pairs.json>     [[old, new], …]
import sys, json
p = sys.argv[1]
s = open(p, encoding="utf-8").read()
for a, b in json.load(open(sys.argv[2], encoding="utf-8")):
    assert a in s, a[:60]
    s = s.replace(a, b)
open(p, "w", encoding="utf-8", newline="\n").write(s)

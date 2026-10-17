#!/usr/bin/env python3
"""Held-key focus moves from a logcat dump (render switch `keyrate`, docs/qa/native-deep/DEVICE-PLAN.md).

Needs a QA build with `Q trace on` and `Q focuslog on` (AuroraQa): the activity logs every key-down
it gets (`[key] <eventTime> KEYCODE_…`), every D-pad release (`[keyup] <eventTime> KEYCODE_… repeats=N`)
and every focus gain (`[focus] <uptime> gain tag=…`), all on the uptime clock.

    adb logcat -d -s AuroraAnim:D AuroraRender:I > hold.txt
    python tools/tv-bench/keyrate-parse.py hold.txt [more.txt …]

Per hold (a key-down with repeatCount 0 of a D-pad key … its key-up), one JSON line:
  moves         focus gains from the press to the release (+ the overshoot)
  overshoot     focus gains AFTER the release's own time: moves the viewer did not make
  late_ms       how long after the release the last of them came
  max_in_frame  the most focus gains inside any 16.7 ms window (a picture that jumps cards)
  held_ms_mean / held_ms_sd   the intervals between gains from the 2nd on (steadiness)
  gate          the gate's own line for the hold, if it ran: moves / hardware repeats / interval
A final line sums the holds (`"total": true`).
"""
import json, re, statistics, sys

KEY = re.compile(r"\[key\] (\d+) (KEYCODE_DPAD_\w+)")
UP = re.compile(r"\[keyup\] (\d+) (KEYCODE_DPAD_\w+)")
GAIN = re.compile(r"\[focus\] (\d+) gain")
GATE = re.compile(r"\[keyrate\] (KEYCODE_DPAD_\w+) moves=(\d+) repeats=(\d+) interval=(\d+)")
FRAME_MS = 1000 / 59.94


def holds(lines):
    events = []
    for ln in lines:
        m = UP.search(ln)
        if m:
            events.append(("up", int(m.group(1)), m.group(2)))
            continue
        m = KEY.search(ln)
        if m:
            events.append(("down", int(m.group(1)), m.group(2)))
            continue
        m = GAIN.search(ln)
        if m:
            events.append(("gain", int(m.group(1)), None))
            continue
        m = GATE.search(ln)
        if m:
            events.append(("gate", 0, m.groups()))
    out = []
    cur = None
    for kind, t, what in events:
        if kind == "down":
            if cur is None or (cur["up"] is not None):
                if cur is not None:
                    out.append(cur)
                cur = {"key": what, "down": t, "up": None, "gains": [], "gate": None, "downs": 1}
            else:
                cur["downs"] += 1
        elif kind == "up" and cur is not None and cur["up"] is None:
            cur["up"] = t
        elif kind == "gain" and cur is not None:
            cur["gains"].append(t)
        elif kind == "gate" and cur is not None:
            cur["gate"] = {"moves": int(what[1]), "repeats": int(what[2]), "interval": int(what[3])}
    if cur is not None:
        out.append(cur)
    return out


def summarize(h):
    g = sorted(h["gains"])
    up = h["up"] if h["up"] is not None else (g[-1] if g else h["down"])
    after = [t for t in g if t > up]
    best = 0
    j = 0
    for i in range(len(g)):
        while g[i] - g[j] > FRAME_MS:
            j += 1
        best = max(best, i - j + 1)
    iv = [b - a for a, b in zip(g[1:], g[2:])]
    return {
        "key": h["key"].replace("KEYCODE_DPAD_", ""),
        "held_ms": up - h["down"],
        "moves": len(g),
        "overshoot": len(after),
        "late_ms": (after[-1] - up) if after else 0,
        "max_in_frame": best,
        "held_ms_mean": round(statistics.mean(iv), 1) if iv else None,
        "held_ms_sd": round(statistics.pstdev(iv), 1) if len(iv) > 1 else None,
        "gate": h["gate"],
    }


def main():
    rows = []
    for path in sys.argv[1:]:
        with open(path, encoding="utf8", errors="replace") as f:
            for h in holds(f.read().splitlines()):
                r = summarize(h)
                if r["held_ms"] < 350:
                    continue  # a tap, not a hold
                r["file"] = path
                rows.append(r)
                print(json.dumps(r))
    if rows:
        print(json.dumps({
            "total": True,
            "holds": len(rows),
            "moves": sum(r["moves"] for r in rows),
            "overshoot": sum(r["overshoot"] for r in rows),
            "max_in_frame": max(r["max_in_frame"] for r in rows),
            "late_ms_max": max(r["late_ms"] for r in rows),
            "held_ms_sd_median": statistics.median([r["held_ms_sd"] for r in rows if r["held_ms_sd"] is not None] or [0]),
        }))


if __name__ == "__main__":
    main()

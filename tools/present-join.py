#!/usr/bin/env python3
"""From a frame's vsync to the screen: joins `dumpsys gfxinfo <pkg> framestats` (the app's last 120 frames) with
polled `dumpsys SurfaceFlinger --latency <layer>` (when each buffer was shown).

    python tools/present-join.py <gfx-dump.txt> <latency-polls.txt>        -> one JSON object on stdout

A frame and its buffer are matched on time: the buffer's timestamp is taken inside eglSwapBuffers
(SwapBuffers <= queued <= SwapBuffersCompleted, same clock).

  joined           frames matched (of the gfxinfo dump's)
  v2s_p50 / p90    ms from the frame's intended vsync to the vsync it was shown on
  on_time_ms       what that is for a frame that goes straight through on this TV: app work duration + SurfaceFlinger
                   work duration (18.68 + 12.68 ms from `dumpsys SurfaceFlinger`), i.e. two refreshes after its vsync
  late1_pct        share of frames shown at least one refresh later than that (waiting somewhere in the pipeline)
  late2_pct        at least two refreshes later
  late_p50         the typical frame's lateness in refreshes (0, 1, 2)
"""
import sys, json, statistics as st, bisect, importlib.util, os

ON_TIME_MS = 18.683333 + 12.683333
PERIOD_MS = 16.683333


def load_gfx(path):
    hdr = None
    rows = []
    for line in open(path, encoding="utf-8", errors="replace"):
        line = line.strip()
        if line.startswith("Flags,"):
            hdr = [h for h in line.split(",") if h]
            continue
        if hdr and line and line[0].isdigit():
            v = line.split(",")
            try:
                rows.append({hdr[i]: int(v[i]) for i in range(len(hdr))})
            except Exception:
                pass
    return [r for r in rows if r.get("SwapBuffers", 0) > 0 and r.get("IntendedVsync", 0) > 0]


def join(gfx_path, lat_path):
    spec = importlib.util.spec_from_file_location("pp", os.path.join(os.path.dirname(os.path.abspath(__file__)), "present-parse.py"))
    pp = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(pp)
    _, lat = pp.parse(open(lat_path, encoding="utf-8", errors="replace").read())
    lat = sorted(lat)  # by queued time
    qs = [q for q, _, _ in lat]
    out = []
    for r in load_gfx(gfx_path):
        a = r["SwapBuffers"]
        b = max(r.get("SwapBuffersCompleted", 0), a) + 2_000_000
        i = bisect.bisect_left(qs, a - 200_000)
        if i < len(qs) and qs[i] <= b:
            out.append((r, lat[i]))
    return out


def measure(pairs):
    out = {"joined": len(pairs), "on_time_ms": round(ON_TIME_MS, 1)}
    if len(pairs) < 5:
        return out
    v2s = sorted((l[1] - r["IntendedVsync"]) / 1e6 for r, l in pairs)
    late = sorted(round((v - ON_TIME_MS) / PERIOD_MS) for v in v2s)
    out["v2s_p50"] = round(st.median(v2s), 1)
    out["v2s_p90"] = round(v2s[int(len(v2s) * 0.9)], 1)
    out["late1_pct"] = round(100 * sum(1 for v in late if v >= 1) / len(late), 1)
    out["late2_pct"] = round(100 * sum(1 for v in late if v >= 2) / len(late), 1)
    out["late_p50"] = late[len(late) // 2]
    return out


if __name__ == "__main__":
    print(json.dumps(measure(join(sys.argv[1], sys.argv[2]))))

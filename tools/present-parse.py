#!/usr/bin/env python3
"""What the viewer got: presented frames, from polled `dumpsys SurfaceFlinger --latency <layer>` dumps.

    python tools/present-parse.py <latency-polls.txt> [key=value ...]     -> one JSON object on stdout

Each dump: the refresh period, then up to 127 lines `queued  latched  ready` (ns) for the layer's last frames.
On this TV the HWC gives SurfaceFlinger no present fences, so the middle column is the vsync SurfaceFlinger
showed the buffer on by its own vsync clock (exact periods), not a measured photon time; "queued" is the
buffer's timestamp, set when the app queued it; "ready" is when the GPU finished it.
Dumps overlap; rows are merged on the queued time.

  pres_frames      buffers SurfaceFlinger showed
  pres_fps         frames per second WHILE SOMETHING MOVES: a motion is a run of frames with no gap > 6 refreshes;
                   fps = refresh rate x (refreshes with a new frame) / (refreshes of motion)
  missed           refreshes inside a motion that showed the previous frame again (a visible repeat)
  missed_per_1000  per 1000 refreshes of motion
  gaps_3plus       how many of the gaps were 2..5 refreshes long (a long frame, or a short pause between two motions)
  q2s_p50/p90      ms from queueBuffer to the vsync SurfaceFlinger showed the buffer on. NOT the depth of the
                   pipeline: a stuffed pipeline holds its extra frames BEFORE queueBuffer (the RenderThread waiting
                   in dequeueBuffer, the UI thread waiting for the RenderThread) - see tools/present-join.py
"""
import sys, json, statistics as st


def parse(text):
    period = 16683333
    rows = {}
    for block in text.replace("\r", "").split("==="):
        lines = [l.split() for l in block.strip().split("\n") if l.strip()]
        if not lines:
            continue
        if len(lines[0]) == 1 and lines[0][0].isdigit():
            period = int(lines[0][0])
            lines = lines[1:]
        for l in lines:
            if len(l) != 3:
                continue
            try:
                q, p, r = (int(x) for x in l)
            except ValueError:
                continue
            if q <= 0 or p <= 0 or p > (1 << 62):  # not presented yet
                continue
            rows[q] = (q, p, r)
    return period, sorted(rows.values(), key=lambda x: x[1])


def measure(period, rows):
    out = {"pres_frames": len(rows)}
    if len(rows) < 3:
        return out
    # Walk the frames in the order they reached the screen. `steps` = refreshes between two frames: 1 = the
    # next refresh, 2 = one refresh showed the old frame again. The refresh a pass is booked on jitters by one
    # now and then (a "2" followed by a "0"); summing steps over a motion and subtracting the frames cancels
    # that, so `missed` counts refreshes that really had no new frame.
    missed = 0
    moving = 0
    motions = 1
    worst = 0
    seg_steps = 0
    seg_frames = 0
    longs = 0

    def close():
        nonlocal missed, moving
        if seg_frames:
            missed += max(0, seg_steps - seg_frames)
            moving += max(seg_steps, seg_frames)

    for (_, a, _), (_, b, _) in zip(rows, rows[1:]):
        steps = round((b - a) / period)
        if steps <= 6:
            seg_steps += steps
            seg_frames += 1
            worst = max(worst, steps - 1)
            if steps >= 3:
                longs += 1
        else:
            close()
            seg_steps = seg_frames = 0
            motions += 1
    close()
    out["motions"] = motions
    out["moving_vsyncs"] = moving
    out["missed"] = missed
    out["gaps_3plus"] = longs
    out["worst_gap_vsyncs"] = worst
    out["missed_per_1000"] = round(1000 * missed / moving, 1) if moving else None
    rate = 1e9 / period
    out["pres_fps"] = round(rate * (moving - missed) / moving, 2) if moving else None
    q2s = sorted((p - q) / 1e6 for q, p, _ in rows)
    out["q2s_p50"] = round(st.median(q2s), 1)
    out["q2s_p90"] = round(q2s[int(len(q2s) * 0.9)], 1)
    return out


if __name__ == "__main__":
    period, rows = parse(open(sys.argv[1], encoding="utf-8", errors="replace").read())
    out = measure(period, rows)
    for a in sys.argv[2:]:
        k, _, v = a.partition("=")
        out[k] = int(v) if v.isdigit() else v
    print(json.dumps(out))

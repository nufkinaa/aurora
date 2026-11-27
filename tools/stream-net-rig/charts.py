"""Charts for docs/qa/streaming-efficiency/REPORT.md, drawn from the rig's own numbers.

    python tools/stream-net-rig/charts.py

Reads docs/qa/streaming-efficiency/data/*.json(l) and writes PNGs beside the report.
Palette: the dataviz reference instance (slot 1 blue, slot 2 orange), light surface.
"""
import json
import os
import re

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
DOC = os.path.join(HERE, "..", "..", "docs", "qa", "streaming-efficiency")
DATA = os.path.join(DOC, "data")
SURFACE = "#fcfcfb"
INK = "#0b0b0b"
INK2 = "#52514e"
GRID = "#e4e3df"
S1 = "#2a78d6"  # blue
S2 = "#eb6834"  # orange
S3 = "#1baf7a"  # aqua

plt.rcParams.update({
    "figure.facecolor": SURFACE, "axes.facecolor": SURFACE, "savefig.facecolor": SURFACE,
    "axes.edgecolor": GRID, "axes.labelcolor": INK2, "xtick.color": INK2, "ytick.color": INK2,
    "text.color": INK, "font.size": 10, "axes.spines.top": False, "axes.spines.right": False,
    "axes.grid": True, "grid.color": GRID, "grid.linewidth": 0.6, "axes.axisbelow": True,
})


def save(fig, name):
    fig.tight_layout()
    fig.savefig(os.path.join(DOC, name), dpi=144)
    plt.close(fig)
    print("wrote", name)


def tcp_chart():
    p = os.path.join(DATA, "tcp-bench.json")
    if not os.path.exists(p):
        return
    d = json.load(open(p, encoding="utf-8"))
    fig, axes = plt.subplots(1, 2, figsize=(9, 3.4), sharey=False)
    for ax, rate in zip(axes, (5000, 20000)):
        for cc, color in (("cubic", S2), ("bbr", S1)):
            rows = sorted([r for r in d["bulk"] if r["rate"] == rate and r["cc"] == cc], key=lambda r: r["loss"])
            xs = [r["loss"] for r in rows]
            ys = [r["mbit"] for r in rows]
            ax.plot(xs, ys, color=color, linewidth=2, marker="o", markersize=6, markeredgecolor=SURFACE, markeredgewidth=1.5)
            ax.annotate(f"{'BBR' if cc == 'bbr' else 'CUBIC (today)'}", (xs[-1], ys[-1]), textcoords="offset points", xytext=(-4, 8 if cc == "bbr" else -14), ha="right", color=INK2)
        ax.set_title(f"{rate // 1000} Mbit/s line, 70 ms round trip", color=INK, fontsize=10, loc="left")
        ax.set_xlabel("packets lost (%)")
        ax.set_ylim(0, rate / 1000 * 1.12)
        ax.set_xticks([0, 0.5, 1, 2])
    axes[0].set_ylabel("one connection carries (Mbit/s)")
    fig.suptitle("Real Linux TCP over a shaped link: what one connection gets", x=0.01, ha="left", fontsize=11, color=INK)
    save(fig, "tcp-cubic-vs-bbr.png")


def peaks_chart():
    p = os.path.join(DATA, "library-peaks.txt")
    if not os.path.exists(p):
        return
    rows = []
    for line in open(p, encoding="utf-8"):
        m = re.search(r"avg\s+(\d+) \| peak 2s (\d+) 6s (\d+) 10s (\d+) 30s (\d+) 60s (\d+)", line)
        if m:
            rows.append([int(x) for x in m.groups()])
    rows.sort(key=lambda r: r[4])
    fig, ax = plt.subplots(figsize=(9, 3.4))
    xs = range(len(rows))
    ax.bar([x - 0.2 for x in xs], [r[0] / 1000 for r in rows], width=0.38, color=S1, label="average")
    ax.bar([x + 0.2 for x in xs], [r[4] / 1000 for r in rows], width=0.38, color=S2, label="busiest 30 seconds")
    ax.set_xticks([])
    ax.set_xlabel(f"the household's {len(rows)} films (first 30 minutes of each), sorted by their busiest 30 s")
    ax.set_ylabel("Mbit/s")
    ax.legend(frameon=False, loc="upper left")
    ax.set_title("A film that averages 2.5 Mbit/s needs about 5 Mbit/s to play straight through", loc="left", fontsize=11)
    save(fig, "library-peaks.png")


def load_runs(label):
    p = os.path.join(DATA, f"{label}.jsonl")
    if not os.path.exists(p):
        return []
    return [json.loads(x) for x in open(p, encoding="utf-8") if x.strip()]


def stall_chart(before, after, name, title, profiles, titles):
    a = load_runs(before)
    b = load_runs(after)
    if not a or not b:
        return
    def cell(rows, prof, t):
        rs = [r for r in rows if r.get("profile") == prof and r.get("title") == t and r.get("ok")]
        if not rs:
            return None
        v = sorted(r["stallMs"] / 1000 for r in rs)
        return v[len(v) // 2]
    labels, xa, xb = [], [], []
    for prof in profiles:
        for t in titles:
            va, vb = cell(a, prof, t), cell(b, prof, t)
            if va is None or vb is None:
                continue
            labels.append(f"{prof}\n{t}")
            xa.append(va)
            xb.append(vb)
    if not labels:
        return
    fig, ax = plt.subplots(figsize=(max(6, len(labels) * 0.75), 3.6))
    xs = range(len(labels))
    ax.bar([x - 0.2 for x in xs], xa, width=0.38, color=S2, label="today")
    ax.bar([x + 0.2 for x in xs], xb, width=0.38, color=S1, label="with the change")
    ax.set_xticks(list(xs))
    ax.set_xticklabels(labels, fontsize=8)
    ax.set_ylabel("seconds stalled in 150 s")
    ax.legend(frameon=False)
    ax.set_title(title, loc="left", fontsize=11)
    save(fig, name)


def timeline_chart(label_a, label_b, prof, t, name, title):
    def row(label):
        rs = [r for r in load_runs(label) if r.get("profile") == prof and r.get("title") == t and r.get("ok")]
        return rs[0] if rs else None
    ra, rb = row(label_a), row(label_b)
    if not ra or not rb:
        return
    fig, axes = plt.subplots(2, 1, figsize=(9, 4.6), sharex=True)
    for r, color, lab in ((ra, S2, "today"), (rb, S1, "with the change")):
        tl = r["timeline"]
        xs = [p[0] for p in tl]
        axes[0].step(xs, [p[2] for p in tl], where="post", color=color, linewidth=2, label=lab)
        axes[1].step(xs, [p[1] for p in tl], where="post", color=color, linewidth=2, label=lab)
        for p in tl:
            if p[3]:
                axes[0].axvspan(p[0], p[0] + 5, color=color, alpha=0.12, linewidth=0)
    sched = r.get("prof", {}).get("schedule") or []
    for ax in axes:
        for s, d in sched:
            ax.axvline(s, color=INK2, linewidth=0.8, linestyle="--")
    axes[0].set_ylabel("film in hand (s)")
    axes[1].set_ylabel("picture height")
    axes[1].set_xlabel("seconds after Play (dashed: the line changes speed; shaded: frozen)")
    axes[0].legend(frameon=False, loc="upper right")
    axes[0].set_title(title, loc="left", fontsize=11)
    save(fig, name)


if __name__ == "__main__":
    os.makedirs(DOC, exist_ok=True)
    tcp_chart()
    peaks_chart()
    import sys
    for spec in sys.argv[1:]:
        # stall:<before>:<after>:<file.png>  or  timeline:<before>:<after>:<profile>:<title>:<file.png>
        parts = spec.split(":")
        if parts[0] == "stall":
            stall_chart(parts[1], parts[2], parts[3], "Time stalled, same line, same film", ["8M", "5M", "3M", "1.5M", "3M-L1", "20M-L1", "drop"], ["direct", "jit", "hevc"])
        elif parts[0] == "timeline":
            timeline_chart(parts[1], parts[2], parts[3], parts[4], parts[5], f"{parts[4]} film, line {parts[3]}")

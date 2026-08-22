# Convert embedded BITMAP subtitles (dvd_subtitle / hdmv_pgs) to a synced .srt
# using ffmpeg to render each subtitle image and Tesseract to OCR the text.
#
# Usage:
#   python tools/bitmap-subs-to-srt.py "E:\path\to\video.mp4" [track_index] [lang]
#
# Writes "<video name>.srt" next to the video (won't overwrite an existing one).
# Timings come from the embedded track itself, so the result is perfectly
# synced to that exact video file.

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor

FPS = 2  # frames per second sampled from the rendered subtitle overlay

def find_tesseract():
    exe = shutil.which("tesseract")
    if exe:
        return exe
    default = r"C:\Program Files\Tesseract-OCR\tesseract.exe"
    if os.path.exists(default):
        return default
    sys.exit("tesseract not found - install it (winget install UB-Mannheim.TesseractOCR)")

def probe(video, track):
    # Subtitle stream geometry (the canvas the bitmaps are positioned on)
    out = subprocess.run(
        ["ffprobe", "-v", "quiet", "-select_streams", f"s:{track}",
         "-show_entries", "stream=width,height,codec_name", "-of", "json", video],
        capture_output=True, text=True, check=True).stdout
    streams = json.loads(out)["streams"]
    if not streams:
        sys.exit(f"no subtitle stream s:{track} in {video}")
    st = streams[0]
    w, h = int(st.get("width") or 720), int(st.get("height") or 480)

    # One packet per subtitle event, with exact pts + duration
    out = subprocess.run(
        ["ffprobe", "-v", "quiet", "-select_streams", f"s:{track}",
         "-show_packets", "-of", "json", video],
        capture_output=True, text=True, check=True).stdout
    packets = json.loads(out)["packets"]

    events = []
    for i, p in enumerate(packets):
        if "pts_time" not in p:
            continue
        start = float(p["pts_time"])
        dur = float(p.get("duration_time") or 4.0)
        end = start + min(dur, 7.0)
        if i + 1 < len(packets) and "pts_time" in packets[i + 1]:
            end = min(end, float(packets[i + 1]["pts_time"]) - 0.05)
        if end > start:
            events.append([start, end])
    return w, h, events

def render_and_grab_frames(video, track, w, h, events, tmpdir):
    """Render subs on a black canvas (negated -> dark text on white), stream
    raw grayscale frames, and save one frame per subtitle event as PGM."""
    last_end = events[-1][1] + 2
    # frame index to grab for each event: shortly after the sub appears
    wanted = {}
    for n, (start, end) in enumerate(events):
        t = start + min((end - start) / 2, 0.4)
        wanted.setdefault(int(t * FPS), []).append(n)

    filter_graph = (
        f"color=c=black:s={w}x{h}:r={FPS}[bg];"
        f"[bg][0:s:{track}]overlay=shortest=1[ov];"
        f"[ov]negate,format=gray[out]"
    )
    proc = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-i", video,
         "-filter_complex", filter_graph, "-map", "[out]",
         "-t", str(last_end), "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        stdout=subprocess.PIPE)

    frame_size = w * h
    saved = {}
    idx = 0
    max_idx = max(wanted)
    while idx <= max_idx:
        frame = proc.stdout.read(frame_size)
        if len(frame) < frame_size:
            break
        if idx in wanted:
            for n in wanted[idx]:
                path = crop_and_save_pgm(frame, w, h, os.path.join(tmpdir, f"ev{n:04d}.pgm"))
                if path:
                    saved[n] = path
        idx += 1
    proc.stdout.close()
    proc.wait()
    return saved

def crop_and_save_pgm(frame, w, h, path):
    """Crop to the text bounding box (dark pixels on white) and save as PGM.
    Returns None if the frame is blank (e.g. a 'clear subtitle' packet)."""
    rows = [y for y in range(h) if min(frame[y * w:(y + 1) * w]) < 100]
    if len(rows) < 3:
        return None
    y0, y1 = max(rows[0] - 20, 0), min(rows[-1] + 20, h - 1)

    cols = [x for x in range(0, w, 4) if min(frame[y0 * w + x:(y1 + 1) * w:w]) < 100]
    if not cols:
        return None
    x0, x1 = max(cols[0] - 24, 0), min(cols[-1] + 24, w - 1)

    cw, ch = x1 - x0 + 1, y1 - y0 + 1
    body = b"".join(frame[y * w + x0:y * w + x0 + cw] for y in range(y0, y1 + 1))
    with open(path, "wb") as f:
        f.write(b"P5\n%d %d\n255\n" % (cw, ch) + body)
    return path

def ocr_image(tesseract, path, lang):
    out = subprocess.run(
        [tesseract, path, "stdout", "--psm", "6", "-l", lang],
        capture_output=True, text=True, encoding="utf-8", errors="replace")
    return clean_text(out.stdout or "")

def clean_text(text):
    lines = []
    for line in text.splitlines():
        line = line.replace("|", "I").replace("‘", "'").replace("’", "'")
        line = re.sub(r"\s+", " ", line).strip()
        line = re.sub(r"^[~_\-=.,'\"]+$", "", line)  # junk-only lines
        if line:
            lines.append(line)
    return "\n".join(lines)

def fmt_time(t):
    ms = int(round(t * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"

def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__ or "usage: bitmap-subs-to-srt.py <video> [track] [lang]")
    video = sys.argv[1]
    track = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    lang = sys.argv[3] if len(sys.argv) > 3 else "eng"

    srt_path = os.path.splitext(video)[0] + ".srt"
    if os.path.exists(srt_path):
        sys.exit(f"refusing to overwrite existing {srt_path}")

    tesseract = find_tesseract()
    w, h, events = probe(video, track)
    print(f"{len(events)} subtitle events, canvas {w}x{h}")

    with tempfile.TemporaryDirectory() as tmpdir:
        print("rendering subtitle bitmaps (one ffmpeg pass)...")
        saved = render_and_grab_frames(video, track, w, h, events, tmpdir)
        print(f"{len(saved)} events have visible text, running OCR...")

        with ThreadPoolExecutor(max_workers=6) as pool:
            texts = dict(zip(saved.keys(), pool.map(
                lambda p: ocr_image(tesseract, p, lang), saved.values())))

    entries = []
    for n, (start, end) in enumerate(events):
        text = texts.get(n, "")
        if text:
            entries.append((start, end, text))

    with open(srt_path, "w", encoding="utf-8") as f:
        for i, (start, end, text) in enumerate(entries, 1):
            f.write(f"{i}\n{fmt_time(start)} --> {fmt_time(end)}\n{text}\n\n")

    print(f"wrote {len(entries)} cues -> {srt_path}")

if __name__ == "__main__":
    main()

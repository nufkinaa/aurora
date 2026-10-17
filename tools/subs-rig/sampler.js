// The page side of the subtitle timing rig. `measure` is handed to
// page.evaluate(): it watches the <video> for `frames` presented frames and,
// for each, reads the frame's own source time from its bars (see media.js),
// finds the cue that belongs to that moment ("T<floor(t)>") on the track
// labelled `label`, and records how far that cue is scheduled from where it
// should be.
//
//   err  = cue.startTime − (mediaTime − (t − i))      seconds
//          > 0: the subtitle comes LATE    < 0: it comes EARLY
//   file = what the subtitle file itself said, minus i (the server's
//          extraction/conversion error, before the player touched the cue)
//
// The bars resolve 0.1 s and a frame lasts 0.04 s, so |err| up to ~0.1 is
// the instrument, not the player.
const measure = async ({ label, frames = 30, timeoutMs = 20000 }) => {
  const v = document.querySelector(".player video");
  if (!v) return { error: "no video" };
  const track = [...v.textTracks].find((t) => t.label === label);
  if (!track) return { error: `no track "${label}" (have ${[...v.textTracks].map((t) => t.label).join(", ")})` };
  if (!v.requestVideoFrameCallback) return { error: "no requestVideoFrameCallback" };
  const W = 192;
  const H = 108;
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const g = cv.getContext("2d", { willReadFrequently: true });
  const readBars = () => {
    g.drawImage(v, 0, 0, W, H);
    const row = g.getImageData(0, Math.floor(H / 4), W, 1).data;
    const ref = g.getImageData(0, Math.floor((H * 3) / 4), W, 1).data;
    // the lower half is flat grey: a frame that is not grey there is not one
    // of ours (a poster, a black frame while loading)
    const grey = ref[Math.floor(W / 2) * 4];
    if (grey < 90 || grey > 170) return null;
    let n = 0;
    for (let k = 0; k < 12; k++) {
      const x = Math.floor(((k + 0.5) * W) / 12);
      if (row[x * 4] > 128) n |= 1 << k;
    }
    return n / 10;
  };
  const samples = [];
  await new Promise((resolve) => {
    const t0 = performance.now();
    const step = (_now, meta) => {
      if (samples.length >= frames || performance.now() - t0 > timeoutMs) return resolve();
      try {
        const t = readBars();
        if (t != null && !v.paused && !v.seeking) {
          const i = Math.floor(t + 1e-6);
          let cue = null;
          if (track.cues) for (const c of track.cues) if (c.text === `T${i}`) { cue = c; break; }
          if (cue && i >= 1) {
            samples.push({
              t, m: meta.mediaTime,
              err: cue.startTime - (meta.mediaTime - (t - i)),
              file: (cue._t0 !== undefined ? cue._t0 : cue.startTime) - i,
            });
          }
        }
      } catch {}
      v.requestVideoFrameCallback(step);
    };
    v.requestVideoFrameCallback(step);
  });
  if (!samples.length) return { error: "no samples (no cues loaded, or the picture never matched)", cues: track.cues ? track.cues.length : null, mode: track.mode };
  const sorted = (k) => samples.map((s) => s[k]).sort((a, b) => a - b);
  const med = (a) => a[Math.floor(a.length / 2)];
  const e = sorted("err");
  const f = sorted("file");
  const r3 = (x) => Math.round(x * 1000) / 1000;
  return {
    n: samples.length,
    err: r3(med(e)), errMin: r3(e[0]), errMax: r3(e[e.length - 1]),
    file: r3(med(f)),
    at: r3(samples[0].t), mediaAt: r3(samples[0].m),
  };
};

module.exports = { measure };

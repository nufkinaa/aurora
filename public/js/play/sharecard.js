// Aurora Play — painting a card to share: the pieces a share card is drawn
// with on a <canvas> (no libraries), and handing the picture over.
//
//   wrapLines(measure, text, maxWidth, maxLines)  pure: the words of `text` in
//       lines no wider than maxWidth (measure(str) -> px); the last line ends
//       in "…" when it does not all fit. A word wider than a line is cut.
//   fitSize(measure, text, maxWidth, maxPx, minPx)  pure: the largest font
//       size in maxPx..minPx at which `text` fits one line (measure(str, px))
//   roundRect(ctx, x, y, w, h, r)                 a rounded-rectangle path
//   loadImage(url, ms)       -> Promise<HTMLImageElement|null> (null when it
//       does not load in time — a card is never held up by a picture)
//   drawCover(ctx, img, x, y, w, h, r)  the picture filling the box like
//       object-fit: cover, with rounded corners
//   paintStars(ctx, w, h, { seed, count, color })   a still starfield
//   toBlob(canvas, type, quality) -> Promise<Blob|null>
//   shareOrSave(canvas, { filename, title, text }) -> "shared" | "saved" |
//       "cancelled" | "failed": the Web Share sheet with the picture where the
//       browser can share files, else the picture downloaded
//
// The card a feature paints is its own (screens/wrapped.js paints Wrapped's).

export const wrapLines = (measure, text, maxWidth, maxLines = 2) => {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  // a word too wide for a line on its own is cut to fit, with an ellipsis
  const cut = (w) => {
    let s = w;
    while (s.length > 1 && measure(s + "…") > maxWidth) s = s.slice(0, -1);
    return s + "…";
  };
  const lines = [];
  let i = 0;
  while (i < words.length && lines.length < maxLines) {
    let line = measure(words[i]) <= maxWidth ? words[i] : cut(words[i]);
    i++;
    while (i < words.length && !line.endsWith("…") && measure(`${line} ${words[i]}`) <= maxWidth) line += ` ${words[i++]}`;
    lines.push(line);
  }
  // words left over: the last line says so
  if (i < words.length && lines.length) {
    let last = lines[lines.length - 1].replace(/…$/, "");
    while (last.length > 1 && measure(last + "…") > maxWidth) last = last.slice(0, -1).trimEnd();
    lines[lines.length - 1] = last + "…";
  }
  return lines;
};

export const fitSize = (measure, text, maxWidth, maxPx, minPx) => {
  for (let px = maxPx; px > minPx; px -= 2) if (measure(text, px) <= maxWidth) return px;
  return minPx;
};

export const roundRect = (ctx, x, y, w, h, r) => {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
};

export const loadImage = (url, ms = 4000) =>
  new Promise((resolve) => {
    if (!url) return resolve(null);
    const img = new Image();
    let done = false;
    const end = (v) => { if (!done) { done = true; resolve(v); } };
    const t = setTimeout(() => end(null), ms);
    img.decoding = "async";
    img.onload = () => { clearTimeout(t); end(img.naturalWidth ? img : null); };
    img.onerror = () => { clearTimeout(t); end(null); };
    img.src = url;
  });

export const drawCover = (ctx, img, x, y, w, h, r = 0) => {
  if (!img) return;
  const s = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  const iw = img.naturalWidth * s;
  const ih = img.naturalHeight * s;
  ctx.save();
  roundRect(ctx, x, y, w, h, r);
  ctx.clip();
  ctx.drawImage(img, x + (w - iw) / 2, y + (h - ih) / 2, iw, ih);
  ctx.restore();
};

const rand = (seed) => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export const paintStars = (ctx, w, h, { seed = 3, count = 160, color = "255,255,255" } = {}) => {
  const r = rand(seed);
  for (let i = 0; i < count; i++) {
    const x = r() * w;
    const y = r() * h;
    const big = r() > 0.94;
    const a = 0.25 + r() * 0.6;
    ctx.fillStyle = `rgba(${color},${a.toFixed(2)})`;
    ctx.beginPath();
    ctx.arc(x, y, big ? 1.6 + r() * 1.4 : 0.5 + r() * 0.9, 0, Math.PI * 2);
    ctx.fill();
  }
};

export const toBlob = (canvas, type = "image/png", quality) =>
  new Promise((resolve) => {
    try { canvas.toBlob((b) => resolve(b), type, quality); } catch { resolve(null); }
  });

export const shareOrSave = async (canvas, { filename = "aurora.png", title = "", text = "" } = {}) => {
  const blob = await toBlob(canvas);
  if (!blob) return "failed";
  try {
    const file = new File([blob], filename, { type: blob.type || "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
      try {
        await navigator.share({ files: [file], title, text });
        return "shared";
      } catch (e) {
        if (e && e.name === "AbortError") return "cancelled";
        // (some browsers refuse files after all: fall through to the download)
      }
    }
  } catch {}
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return "saved";
  } catch {
    return "failed";
  }
};

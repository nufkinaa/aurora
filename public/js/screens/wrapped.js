// Aurora Wrapped — your viewing, told as a story in the night sky, and lovingly
// roasted. Year-round (elia's spec: "playful and insulting"), and honest about
// its window: it says "since <date>" because the session store is a ring
// buffer. The design and its reasons: docs/play/wrapped.md.
//
// The page at #/wrapped is "All the numbers" — every stat, plainly, as text.
// On arrival the STORY plays over it (js/play/story.js): chapters with the
// segments of progress on top, each one skipped when its data is missing
// (wrappedrules.js chaptersFor). Closing the story (X, Esc, the summary's
// "All the numbers") shows the page underneath; Back leaves.
// Reduced motion: the page first, with "Play the story" — which then plays
// still (final states, no auto-advance, moved by hand).
// Nothing watched yet: a teaser of the story instead (the face-down card).
// Kids profiles: the same story, kinder words, no roasts.
//
// The words and rules are pure, in ../wrappedrules.js. The share card is
// painted here on a canvas (paintShareCard): the profile's own name and
// stats, nothing else.
import { el as uiEl, artUrl, haptic, toast } from "../ui.js";
import { api } from "../api.js";
import { state, isKids } from "../state.js";
import { navigate } from "../router.js";
import { loadPlayCss, room } from "../play/room.js";
import { createStory } from "../play/story.js";
import { odometer } from "../play/count.js";
import { tilt } from "../play/tilt.js";
import { meteorBurst } from "../play/burst.js";
import { pressAll } from "../play/press.js";
import { reduced, cssVars } from "../play/motion.js";
import { wrapLines, fitSize, roundRect, loadImage, drawCover, paintStars, shareOrSave } from "../play/sharecard.js";
import * as R from "../wrappedrules.js";

const SVGNS = "http://www.w3.org/2000/svg";
const STAR = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M12 2.5l2.2 6.6 6.9.1-5.6 4.1 2.1 6.7L12 16l-5.6 4 2.1-6.7L2.9 9.2l6.9-.1z" fill="currentColor"/></svg>';
const PLAY_FONT = 'ui-rounded, "SF Pro Rounded", "Segoe UI Variable Display", "Segoe UI", system-ui, -apple-system, Roboto, sans-serif';
const coarse = () => { try { return matchMedia("(pointer: coarse)").matches; } catch { return false; } };

// ---------- small pieces ----------
// ui.js el() sets a style object with Object.assign, which drops custom
// properties (--d, --k, --hue …): here a style object becomes a style string.
const el = (tag, attrs, ...kids) => uiEl(tag, attrs && attrs.style && typeof attrs.style === "object" ? { ...attrs, style: cssVars(attrs.style) } : attrs, ...kids);
const d = (ms) => ({ "--d": String(ms) }); // an entrance delay for [data-in]
const sinceText = (w) => {
  try { return new Date(w.since).toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" }); } catch { return ""; }
};
const sinceMonth = (w) => {
  try { return new Date(w.since).toLocaleDateString([], { month: "long", year: "numeric" }); } catch { return ""; }
};
const shortDay = (iso) => {
  try { return new Date(`${iso}T12:00:00`).toLocaleDateString([], { month: "long", day: "numeric" }); } catch { return iso; }
};
const hashHue = (s) => {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.codePointAt(0)) % 360;
  return h;
};
// a title's picture, or a drawn stand-in with its name (never an empty box)
const posterArt = (t, { w = 300, cls = "" } = {}) => {
  const box = el("div", { class: `wr-poster ${cls}`.trim(), style: { "--hue": String(hashHue(t.name)) } });
  const fallback = () => {
    box.classList.add("is-drawn");
    box.append(el("span", { class: "wr-poster-name", dir: "auto" }, t.name));
  };
  if (t.poster) {
    const img = el("img", { src: artUrl(t.poster, w), alt: "", decoding: "async", draggable: "false" });
    img.addEventListener("error", () => { img.remove(); fallback(); }, { once: true });
    box.append(img);
  } else fallback();
  return box;
};
const glyph = (type, { cls = "" } = {}) => {
  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("class", `wr-glyph ${cls}`.trim());
  svg.setAttribute("aria-hidden", "true");
  let inner = "";
  type.lines.forEach(([a, b], i) => {
    const [x1, y1] = type.stars[a];
    const [x2, y2] = type.stars[b];
    inner += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" style="--k:${i}"/>`;
  });
  type.stars.forEach(([x, y], i) => { inner += `<circle cx="${x}" cy="${y}" r="${i === 0 ? 3.4 : 2.4}" style="--k:${i}"/>`; });
  svg.innerHTML = inner;
  return svg;
};

// ---------- the collectible (the viewer type) ----------
const typeCard = (ctx, { faceDown = false } = {}) => {
  const t = ctx.type;
  const front = el("div", { class: "play-face wr-cf" },
    el("div", { class: "wr-cf-frame" },
      el("div", { class: "wr-cf-top" }, el("span", {}, `No. ${String(t.no).padStart(2, "0")}`), el("span", {}, "Aurora Wrapped")),
      el("div", { class: "wr-cf-art" }, glyph(t), el("i", { class: "wr-cf-aurora" })),
      el("div", { class: "wr-cf-name" }, t.name),
      t.because ? el("div", { class: "wr-cf-because" }, t.because) : null,
      el("div", { class: "wr-cf-foot" }, el("span", { dir: "auto" }, ctx.name), el("span", {}, sinceMonth(ctx.w))),
    ),
    el("div", { class: "play-foil" }),
    el("div", { class: "play-glare" }),
  );
  const back = el("div", { class: "play-face play-face--back wr-cb" },
    el("div", { class: "wr-cb-ring", html: STAR }),
    el("div", { class: "wr-cb-word" }, "Aurora Wrapped"),
    faceDown ? el("div", { class: "wr-cb-q" }, "?") : null,
  );
  const inner = el("div", { class: "play-tilt" }, front, back);
  const card = el("div", { class: "play-collectible wr-type-card", style: { "--hue": String(t.hue) } }, el("div", { class: "wr-flip" }, inner));
  return { card, inner };
};

// ---------- the week, the dial, the genres (story + page) ----------
const weekBars = (w, { compact = false } = {}) => {
  const v = w.byWeekday || [];
  const max = Math.max(1, ...v);
  const top = v.indexOf(Math.max(...v));
  return el("div", { class: "wr-week", role: "img", "aria-label": `Most of it on ${R.DAYS[top]}s` },
    ...R.DAYS.map((name, i) => el("div", { class: `wr-week-col${i === top ? " is-top" : ""}`, style: { "--v": Math.max(0.035, (v[i] || 0) / max).toFixed(3), "--k": String(i) } },
      el("div", { class: "wr-week-track" }, el("i", { class: "wr-week-bar" })),
      el("span", { class: "wr-week-day", title: name }, compact ? name.slice(0, 1) : name.slice(0, 3)),
    )));
};
const dial = (w) => {
  const b = w.byHour || [];
  const max = Math.max(1, ...b);
  const prime = R.primeHour(w);
  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("viewBox", "0 0 220 220");
  svg.setAttribute("class", "wr-dial-svg");
  svg.setAttribute("aria-hidden", "true");
  let s = '<circle cx="110" cy="110" r="104" class="wr-dial-face"/><circle cx="110" cy="110" r="50" class="wr-dial-hub"/>';
  for (let h = 0; h < 24; h++) {
    const len = 4 + 34 * ((b[h] || 0) / max); // (from the hub out to at most r=92: the hour labels sit beyond)
    s += `<g transform="rotate(${h * 15} 110 110)"><rect x="106.5" y="${110 - 54 - len}" width="7" height="${len}" rx="3.5" class="wr-spoke${h === prime ? " is-prime" : ""}" style="--k:${h}"/></g>`;
  }
  s += '<text x="110" y="15" class="wr-dial-tick">12a</text><text x="208" y="114" class="wr-dial-tick" text-anchor="end">6a</text><text x="110" y="214" class="wr-dial-tick">12p</text><text x="12" y="114" class="wr-dial-tick" text-anchor="start">6p</text>';
  svg.innerHTML = s;
  return el("div", { class: "wr-dial", role: "img", "aria-label": prime == null ? "" : `Prime time: ${R.hourLabel(prime)}` },
    svg,
    el("div", { class: "wr-dial-mid" }, el("b", {}, prime == null ? "–" : R.hourLabel(prime)), el("span", {}, "prime time")));
};
const genreBars = (w) => {
  const g = R.genreShares(w).slice(0, 5);
  const max = g.length ? g[0].share : 1;
  return el("div", { class: "wr-genres" },
    ...g.map((x, i) => {
      const f = x.share / max;
      // the race: the leader starts slow and surges; the others lead early
      const mid = i === 0 ? f * 0.42 : Math.min(0.92, f * 1.18);
      return el("div", { class: `wr-genre${i === 0 ? " is-top" : ""}`, style: { "--f": f.toFixed(3), "--mid": mid.toFixed(3), "--k": String(i) } },
        el("span", { class: "wr-genre-name" }, x.name),
        el("div", { class: "wr-genre-track" }, el("i", { class: "wr-genre-bar" })),
        el("span", { class: "wr-genre-pct play-num" }, `${Math.round(x.share * 100)}%`));
    }));
};

// The sky of nights: every night a star on a calendar (a canvas, painted
// once), and the best streak's nights rising out of it into a constellation
// (elements, so they move by transform: each star starts where its night
// sits on the calendar — --fx/--fy — and flies to its place; then the lines
// are drawn between them, one by one).
const skyChart = (w, { still = false, wide = true } = {}) => {
  const lay = R.skyLayout(w, wide);
  const box = el("div", { class: `wr-sky${wide ? " is-wide" : " is-tall"}`, style: { "--weeks": String(Math.max(1, lay.weeks)) } });
  const canvas = el("canvas", { class: "wr-sky-stars", "aria-hidden": "true" });
  const lines = el("div", { class: "wr-sky-lines", "aria-hidden": "true" });
  box.append(canvas, lines);
  const maxM = Math.max(1, ...lay.stars.map((s) => s.m));
  const n = lay.con.length;
  const stars = [];
  const segs = [];
  lay.con.forEach((c, k) => {
    const m = lay.stars[c.i].m;
    const star = el("i", { class: `wr-star${k === lay.brightest ? " is-brightest" : ""}`, style: { left: `${c.x * 100}%`, top: `${c.y * 100}%`, "--k": String(k), "--z": (0.65 + 0.85 * Math.sqrt(m / maxM)).toFixed(2) } });
    stars.push({ star, c });
    lines.append(star);
    if (k > 0) {
      const seg = el("b", { class: "wr-link", style: { "--k": String(k), "--n": String(n) } });
      segs.push({ seg, a: lay.con[k - 1], b: c });
      lines.prepend(seg);
    }
  });
  if (lay.brightest != null) {
    const c = lay.con[lay.brightest];
    const day = new Date(`${w.nightsFrom}T12:00:00`);
    day.setDate(day.getDate() + w.nights[c.i][0]);
    const label = el("span", { class: `wr-sky-label${c.y < 0.3 ? " is-below" : ""}${c.x > 0.75 ? " is-left" : c.x < 0.25 ? " is-right" : ""}${c.x > 0.5 ? " is-flip" : ""}`, style: { left: `${c.x * 100}%`, top: `${c.y * 100}%`, "--n": String(n) } },
      el("b", {}, "Brightest night"), ` ${shortDay(day.toLocaleDateString("sv"))} · ${R.fmtH(lay.stars[c.i].m * 60)}`);
    lines.append(label);
  }
  // sizes in px: the canvas, the flights and the links
  const place = () => {
    const r = box.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    const c = canvas.getContext("2d");
    if (c) {
      c.scale(dpr, dpr);
      for (const s of lay.stars) {
        const k = Math.sqrt(s.m / maxM);
        c.fillStyle = s.streak ? `rgba(255,214,140,${(0.4 + 0.4 * k).toFixed(2)})` : `rgba(190,215,255,${(0.42 + 0.48 * k).toFixed(2)})`;
        c.beginPath();
        c.arc(s.x * r.width, s.y * r.height, 1.2 + 2.2 * k, 0, Math.PI * 2);
        c.fill();
      }
    }
    for (const { star, c: cc } of stars) {
      const s = lay.stars[cc.i];
      star.style.setProperty("--fx", `${((s.x - cc.x) * r.width).toFixed(1)}px`);
      star.style.setProperty("--fy", `${((s.y - cc.y) * r.height).toFixed(1)}px`);
    }
    for (const { seg, a, b } of segs) {
      const dx = (b.x - a.x) * r.width;
      const dy = (b.y - a.y) * r.height;
      seg.style.left = `${a.x * 100}%`;
      seg.style.top = `${a.y * 100}%`;
      seg.style.width = `${Math.hypot(dx, dy).toFixed(1)}px`;
      seg.style.setProperty("--a", `${Math.atan2(dy, dx).toFixed(4)}rad`);
    }
  };
  let ro = null;
  const start = () => {
    place();
    if (typeof ResizeObserver === "function") { ro = new ResizeObserver(() => place()); ro.observe(box); }
  };
  const stop = () => { if (ro) ro.disconnect(); ro = null; };
  if (still) box.classList.add("is-still");
  return { box, start, stop, lay };
};

// ---------- the share card (1080×1920, a canvas) ----------
// Only the profile's own name and its stats: no other profile, no device,
// no address. Pictures are the top title's poster (same origin) or none.
const paintShareCard = async (ctx) => {
  const { w, type, name } = ctx;
  const W = 1080, H = 1920;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const c = canvas.getContext("2d");
  if (!c) return null;
  const font = (wt, px) => `${wt} ${px}px ${PLAY_FONT}`;
  const measureAt = (wt) => (s, px) => { c.font = font(wt, px); return c.measureText(s).width; };
  const spaced = (text, x, y, px, wt, color, spacing) => {
    c.font = font(wt, px);
    c.fillStyle = color;
    let cx = x;
    for (const ch of text) { c.fillText(ch, cx, y); cx += c.measureText(ch).width + spacing; }
  };
  // the sky
  const bg = c.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#15103b");
  bg.addColorStop(0.5, "#070818");
  bg.addColorStop(1, "#03141c");
  c.fillStyle = bg;
  c.fillRect(0, 0, W, H);
  const blob = (x, y, rx, ry, color) => {
    c.save();
    c.translate(x, y);
    c.scale(rx / ry, 1);
    const g = c.createRadialGradient(0, 0, 0, 0, 0, ry);
    g.addColorStop(0, color);
    g.addColorStop(1, "rgba(0,0,0,0)");
    c.fillStyle = g;
    c.beginPath();
    c.arc(0, 0, ry, 0, Math.PI * 2);
    c.fill();
    c.restore();
  };
  blob(300, 260, 900, 300, "rgba(92,245,184,0.20)");
  blob(860, 620, 760, 280, "rgba(160,131,255,0.20)");
  blob(540, 1820, 900, 260, "rgba(58,211,230,0.14)");
  paintStars(c, W, H, { seed: 7, count: 300 });
  c.textBaseline = "alphabetic";
  const X = 96;
  // who and since when
  spaced("AURORA WRAPPED", X, 168, 34, 800, "#5cf5b8", 7);
  c.font = font(900, fitSize(measureAt(900), name, W - 2 * X, 104, 56));
  c.fillStyle = "#f7f5ff";
  c.fillText(name, X, 284);
  c.font = font(600, 38);
  c.fillStyle = "rgba(232,228,255,0.66)";
  c.fillText(`since ${sinceMonth(w)}`, X, 340);
  // the big number
  const felt = R.hoursFelt(w.totalSec);
  const gold = c.createLinearGradient(0, 400, 0, 700);
  gold.addColorStop(0, "#fff2c2");
  gold.addColorStop(0.45, "#ffd166");
  gold.addColorStop(1, "#f0a23a");
  const bigPx = fitSize(measureAt(900), felt.value, W - 2 * X, 330, 160);
  c.font = font(900, bigPx);
  c.fillStyle = gold;
  c.fillText(felt.value, X - 8, 650);
  c.font = font(800, 50);
  c.fillStyle = "#f7f5ff";
  c.fillText(`${felt.unit} watched`, X, 730);
  // the viewer type
  const panel = (y, h) => {
    roundRect(c, X - 24, y, W - 2 * X + 48, h, 44);
    c.fillStyle = "rgba(255,255,255,0.07)";
    c.fill();
    c.strokeStyle = "rgba(255,255,255,0.14)";
    c.lineWidth = 2;
    c.stroke();
  };
  // (measured first: a two-line name and a two-line verdict make it taller)
  const tx = X + 300, tw = W - X - tx;
  const nameLines = wrapLines((s) => { c.font = font(900, 64); return c.measureText(s).width; }, type.name, tw, 2);
  c.font = font(600, 32);
  const verdictLines = wrapLines((s) => c.measureText(s).width, type.verdict, tw, 2);
  const typeH = Math.max(300, 126 + nameLines.length * 70 + verdictLines.length * 42 + 34);
  panel(800, typeH);
  // its constellation, gold
  const gs = 250, gx = X + 10, gy = 800 + (typeH - gs) / 2;
  c.strokeStyle = "rgba(255,209,102,0.7)";
  c.lineWidth = 3;
  for (const [a, b] of type.lines) {
    c.beginPath();
    c.moveTo(gx + type.stars[a][0] / 100 * gs, gy + type.stars[a][1] / 100 * gs);
    c.lineTo(gx + type.stars[b][0] / 100 * gs, gy + type.stars[b][1] / 100 * gs);
    c.stroke();
  }
  for (const [x, y] of type.stars) {
    c.fillStyle = "#fff2c2";
    c.beginPath();
    c.arc(gx + x / 100 * gs, gy + y / 100 * gs, 8, 0, Math.PI * 2);
    c.fill();
  }
  spaced("VIEWER TYPE", tx, 890, 28, 800, "#ffd166", 5);
  c.fillStyle = "#f7f5ff";
  nameLines.forEach((l, i) => { c.font = font(900, 64); c.fillText(l, tx, 966 + i * 70); });
  c.font = font(600, 32);
  c.fillStyle = "rgba(232,228,255,0.72)";
  verdictLines.forEach((l, i) => c.fillText(l, tx, 966 + nameLines.length * 70 + 8 + i * 42));
  // number one
  const top = w.topTitles && w.topTitles[0];
  let y = 800 + typeH + 40;
  if (top) {
    panel(y, 330);
    const img = top.poster ? await loadImage(artUrl(top.poster, 400), 3500) : null;
    const px = X + 4, py = y + 30, pw = 180, ph = 270;
    if (img) drawCover(c, img, px, py, pw, ph, 22);
    else {
      roundRect(c, px, py, pw, ph, 22);
      const pg = c.createLinearGradient(px, py, px + pw, py + ph);
      pg.addColorStop(0, `hsl(${hashHue(top.name)} 60% 34%)`);
      pg.addColorStop(1, `hsl(${(hashHue(top.name) + 60) % 360} 70% 14%)`);
      c.fillStyle = pg;
      c.fill();
      c.font = font(900, 96);
      c.fillStyle = "rgba(255,255,255,0.85)";
      c.fillText([...top.name][0] || "?", px + 52, py + 170);
    }
    const ttx = X + 220, ttw = W - X - ttx + 4;
    spaced("NUMBER ONE", ttx, y + 92, 28, 800, "#5cf5b8", 5);
    c.font = font(900, 60);
    c.fillStyle = "#f7f5ff";
    const tl = wrapLines((s) => { c.font = font(900, 60); return c.measureText(s).width; }, top.name, ttw, 2);
    tl.forEach((l, i) => { c.font = font(900, 60); c.fillText(l, ttx, y + 164 + i * 66); });
    c.font = font(800, 40);
    c.fillStyle = "#ffd166";
    c.fillText(R.fmtH(top.sec), ttx, y + 164 + tl.length * 66 + 12);
    y += 370;
  }
  // three stats
  const genre = w.topGenres && w.topGenres[0] ? w.topGenres[0].name : null;
  const tiles = [
    genre ? ["TOP GENRE", genre] : ["TITLES", String(w.distinctTitles || 0)],
    ["BEST STREAK", `${w.bestStreak || 1} ${(w.bestStreak || 1) === 1 ? "night" : "nights"}`],
    ["YOUR NIGHT", R.DAYS[w.topWeekday] || "–"],
  ];
  const gap = 20, tileW = (W - 2 * X + 48 - 2 * gap) / 3, tileH = 190;
  tiles.forEach(([label, value], i) => {
    const x0 = X - 24 + i * (tileW + gap);
    roundRect(c, x0, y, tileW, tileH, 36);
    c.fillStyle = "rgba(255,255,255,0.07)";
    c.fill();
    spaced(label, x0 + 30, y + 64, 22, 800, "rgba(232,228,255,0.6)", 3);
    c.font = font(900, fitSize(measureAt(900), value, tileW - 60, 54, 30));
    c.fillStyle = "#f7f5ff";
    c.fillText(value, x0 + 30, y + 136);
  });
  // the mark
  c.fillStyle = "#ffd166";
  c.beginPath();
  const sx = X + 14, sy = H - 112;
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 7 : 17;
    const a = -Math.PI / 2 + i * Math.PI / 5;
    c[i ? "lineTo" : "moveTo"](sx + Math.cos(a) * r, sy + Math.sin(a) * r);
  }
  c.closePath();
  c.fill();
  c.font = font(800, 40);
  c.fillStyle = "#f7f5ff";
  c.fillText("Aurora", X + 46, H - 98);
  c.font = font(600, 30);
  c.fillStyle = "rgba(232,228,255,0.55)";
  c.textAlign = "right";
  c.fillText("my year in the night sky", W - X, H - 100);
  c.textAlign = "left";
  return canvas;
};

const canShareFiles = () => {
  try {
    return !!(navigator.canShare && navigator.share && navigator.canShare({ files: [new File([new Blob(["x"], { type: "image/png" })], "x.png", { type: "image/png" })] }));
  } catch { return false; }
};
const shareCard = async (ctx) => {
  const canvas = await ctx.card();
  if (!canvas) return toast("Couldn't draw the picture", "⚠️");
  const r = await shareOrSave(canvas, { filename: `aurora-wrapped-${ctx.name.replace(/[^\p{L}\p{N}]+/gu, "-").toLowerCase() || "me"}.png`, title: "My Aurora Wrapped", text: `My Aurora Wrapped: ${R.fmtH(ctx.w.totalSec)}, and I'm ${ctx.type.name}.` });
  if (r === "saved") toast("The picture is in your downloads", "✨");
  else if (r === "failed") toast("Couldn't save the picture", "⚠️");
};

// ---------- the story's chapters ----------
const chapterBuilders = (ctx) => {
  const { w, name, kids } = ctx;
  const B = {};

  B.opening = {
    label: "Opening", ms: 6200,
    say: `${name}, your Aurora Wrapped. Since ${sinceText(w)}.`,
    build: (stage) => {
      stage.append(el("div", { class: "wr-ch wr-open" },
        el("i", { class: "wr-meteor", "aria-hidden": "true" }),
        el("span", { class: "play-eyebrow", "data-in": "", html: `${STAR}<span>Aurora Wrapped</span>` }),
        el("h1", { class: "wr-open-title", "data-in": "", style: d(140) }, el("span", { class: "wr-open-name play-gold-text", dir: "auto" }, `${name},`), el("br"), "your sky is ready."),
        el("p", { class: "play-lede", "data-in": "", style: d(380) }, `Every night you pressed play since ${sinceText(w)} left a star. We counted them all.`),
        el("div", { class: "wr-chips", "data-in": "", style: d(620) },
          el("span", { class: "play-chip" }, `${w.activeDays} ${w.activeDays === 1 ? "night" : "nights"}`),
          el("span", { class: "play-chip" }, `${w.plays} ${w.plays === 1 ? "sitting" : "sittings"}`),
          el("span", { class: "play-chip" }, `${w.distinctTitles} ${w.distinctTitles === 1 ? "title" : "titles"}`)),
        el("div", { class: "wr-hint", "data-in": "fade", style: d(1600) }, coarse() ? "Tap to begin" : "Press → or click to begin"),
      ));
    },
  };

  B.hours = {
    label: "Your hours", ms: 7600,
    say: (() => { const f = R.hoursFelt(w.totalSec); return `${f.value} ${f.unit} watched. ${f.lines.join(" ")}`; })(),
    build: (stage, api) => {
      const f = R.hoursFelt(w.totalSec);
      const odo = odometer(f.value, { ms: 2300, laps: 2 });
      odo.el.classList.add("play-gold-text");
      stage.append(el("div", { class: "wr-ch wr-hours" },
        el("span", { class: "play-eyebrow", "data-in": "" }, kids ? "Story time" : "Time well spent (allegedly)"),
        el("div", { class: "wr-big", "data-in": "pop", style: d(80) }, odo.el),
        el("div", { class: "wr-unit", "data-in": "", style: d(1700) }, `${f.unit} watched`),
        ...f.lines.map((l, i) => el("p", { class: `play-lede wr-felt${i ? " is-second" : ""}`, "data-in": "", style: d(2300 + i * 650) }, l)),
      ));
      if (api.still) odo.settle();
      return { enter: () => { if (!api.still) api.at(200, () => odo.start()); } };
    },
  };

  B.top = {
    label: "Your number one", ms: 8400,
    say: (() => { const t = w.topTitles[0]; return `Your number one: ${t.name}, ${R.fmtH(t.sec)}.`; })(),
    build: (stage) => {
      const five = w.topTitles.slice(0, 5);
      const win = five[0];
      // the hand: the winner hides second from the left
      const order = five.length > 1 ? [five[1], win, ...five.slice(2)] : [win];
      const n = order.length;
      const hand = el("div", { class: `wr-fan n${n}`, "aria-hidden": "true", "data-in": "fade" },
        ...order.map((t, k) => {
          const off = k - (n - 1) / 2;
          return el("div", { class: `wr-fan-card${t === win ? " is-win" : ""}`, style: { "--k": String(k), "--r": `${off * 9}deg`, "--x": `calc(${off * 46}% * var(--spread))`, "--s": String(k % 2 ? 1 : -1), "--ox": `calc(${off * 64}% * var(--spread))` } },
            el("div", { class: "wr-fan-flip" },
              el("div", { class: "wr-fan-face" }, posterArt(t, { w: 260 })),
              el("div", { class: "wr-fan-face wr-fan-back" }, el("i", { html: STAR }))));
        }));
      const pctAll = Math.round(R.share(win.sec, w.totalSec) * 100);
      stage.append(el("div", { class: "wr-ch wr-top" },
        el("span", { class: "play-eyebrow", "data-in": "" }, "Your number one"),
        hand,
        el("div", { class: "wr-top-text" },
          el("h2", { class: "play-h1 wr-top-name", dir: "auto", "data-in": "", style: d(3300) }, win.name),
          el("p", { class: "play-lede", "data-in": "", style: d(3600) },
            el("b", { class: "play-gold-text" }, R.fmtH(win.sec)), ` — ${pctAll}% of everything you watched${win.show ? ", one episode at a time" : ""}.`)),
      ));
    },
  };

  B.podium = {
    label: "The podium", ms: 7800,
    say: `The podium: ${w.topTitles.slice(0, 3).map((t, i) => `${i + 1}, ${t.name}`).join("; ")}.`,
    build: (stage) => {
      const t = w.topTitles;
      const step = (rank, item, delay) => el("div", { class: `wr-step wr-step--${rank}` },
        el("div", { class: "wr-step-top", "data-in": "drop", style: d(delay) },
          posterArt(item, { w: 260 }),
          el("div", { class: "wr-step-name", dir: "auto" }, item.name),
          el("div", { class: "wr-step-h play-num" }, R.fmtH(item.sec))),
        el("div", { class: "wr-step-block", "data-in": "grow", style: d(rank * 90) }, el("span", {}, String(rank))));
      stage.append(el("div", { class: "wr-ch wr-podium" },
        el("span", { class: "play-eyebrow", "data-in": "" }, "The podium"),
        el("div", { class: "wr-steps" }, step(2, t[1], 1300), step(1, t[0], 2100), step(3, t[2], 700)),
        t.length > 3 ? el("ol", { class: "wr-rest", start: "4", "data-in": "", style: d(2800) },
          ...t.slice(3, 5).map((x) => el("li", {}, el("span", { class: "wr-rest-name", dir: "auto" }, x.name), el("span", { class: "play-num" }, R.fmtH(x.sec))))) : null,
      ));
    },
  };

  B.genres = {
    label: "Your genre DNA", ms: 7400,
    say: `Your genres: ${R.genreShares(w).slice(0, 5).map((g) => `${g.name} ${Math.round(g.share * 100)}%`).join(", ")}.`,
    build: (stage) => {
      const g = R.genreShares(w);
      stage.append(el("div", { class: "wr-ch wr-dna" },
        el("span", { class: "play-eyebrow", "data-in": "" }, "Your genre DNA"),
        el("h2", { class: "play-h1", "data-in": "", style: d(120) }, "Mostly ", el("span", { class: "wr-nobr" }, g[0].name), g[1] ? el("span", { class: "wr-soft" }, ", with a ", el("span", { class: "wr-nobr" }, g[1].name), " streak.") : "."),
        el("div", { class: "wr-dna-bars", "data-in": "fade", style: d(300) }, genreBars(w)),
      ));
    },
  };

  B.night = {
    label: "Your night", ms: 8600,
    say: `Most of it on ${R.DAYS[w.topWeekday]}s, prime time ${R.hourLabel(R.primeHour(w))}.`,
    build: (stage) => {
      const prime = R.primeHour(w);
      const late = w.lateNightSessions || 0;
      stage.append(el("div", { class: "wr-ch wr-night" },
        el("span", { class: "play-eyebrow", "data-in": "" }, "When you really watch"),
        el("h2", { class: "play-h1", "data-in": "", style: d(120) }, `${R.DAYS[w.topWeekday]}s, `, el("span", { class: "play-gold-text" }, `${R.hourLabel(prime)}.`)),
        el("div", { class: "wr-night-viz" },
          el("div", { class: "wr-night-week", "data-in": "fade", style: d(350) }, weekBars(w)),
          el("div", { class: "wr-night-dial", "data-in": "pop", style: d(1100) }, dial(w))),
        el("p", { class: "play-lede", "data-in": "", style: d(2600) },
          late ? (kids ? `${late} late-night adventures. Shh — we won't tell.` : `${late} ${late === 1 ? "sitting" : "sittings"} started after midnight. We saw that.`) : "In bed before midnight. Mostly. Allegedly."),
      ));
    },
  };

  B.streak = {
    label: "Your streak", ms: 9400,
    say: `Your longest streak: ${w.bestStreak} nights in a row, ${shortDay(w.streak.from)} to ${shortDay(w.streak.to)}.`,
    build: (stage, api) => {
      const wide = stage.clientWidth >= stage.clientHeight * 0.9;
      const sky = skyChart(w, { still: api.still, wide });
      const odo = odometer(String(w.bestStreak), { ms: 1600, laps: 1 });
      odo.el.classList.add("play-gold-text");
      stage.append(el("div", { class: `wr-ch wr-streak${wide ? " is-wide" : ""}` },
        el("div", { class: "wr-streak-head" },
          el("span", { class: "play-eyebrow", "data-in": "" }, "Your longest streak"),
          el("h2", { class: "play-h1", "data-in": "", style: d(100) }, odo.el, " nights in a row"),
          el("p", { class: "play-lede", "data-in": "", style: d(400) }, `${shortDay(w.streak.from)} to ${shortDay(w.streak.to)}. Every star is a night you watched; these ones held hands.`)),
        el("div", { class: "wr-sky-wrap", "data-in": "fade", style: d(200) }, sky.box),
      ));
      if (api.still) odo.settle();
      return {
        enter: () => { sky.start(); if (!api.still) api.at(300, () => odo.start()); },
        leave: () => sky.stop(),
      };
    },
  };

  B.longest = {
    label: "Your longest sitting", ms: 6800,
    say: `Your longest sitting: ${R.clock(w.longestSession.watchedSec)} of ${w.longestSession.title}.`,
    build: (stage, api) => {
      const s = w.longestSession;
      const h = s.watchedSec / 3600;
      const scale = Math.max(2, Math.ceil(h));
      const odo = odometer(R.clock(s.watchedSec), { ms: 2000, laps: 1 });
      odo.el.classList.add("play-gold-text");
      const quip = kids ? "What a story marathon!" : h >= 3 ? "Your couch would like a word." : h >= 1.5 ? "Respectable. Popcorn-refill-level commitment." : "Short and sweet. Like a good trailer.";
      const ticks = Array.from({ length: scale + 1 }, (_, i) => el("span", { style: { left: `${(i / scale) * 100}%` } }, `${i}h`));
      const top = (w.topTitles || []).find((t) => t.name === s.title);
      stage.append(el("div", { class: "wr-ch wr-long" },
        el("span", { class: "play-eyebrow", "data-in": "" }, "Your longest sitting"),
        el("div", { class: "wr-long-row" },
          top ? el("div", { "data-in": "pop", style: d(200) }, posterArt(top, { w: 260, cls: "wr-long-poster" })) : null,
          el("div", { class: "wr-long-text" },
            el("div", { class: "wr-big wr-big--clock", "data-in": "", style: d(60) }, odo.el),
            el("div", { class: "wr-unit", "data-in": "", style: d(900) }, "hours, in one go"),
            el("p", { class: "play-lede", "data-in": "", style: d(1200) }, "of ", el("b", { dir: "auto" }, `“${s.title}”`), "."))),
        el("div", { class: "wr-long-ribbon", "data-in": "fade", style: d(500) },
          el("div", { class: "play-ribbon" }, el("i", { style: { "--p": String(h / scale) } })),
          el("div", { class: "wr-ticks", "aria-hidden": "true" }, ...ticks)),
        el("p", { class: "wr-quip", "data-in": "", style: d(2600) }, quip),
      ));
      if (api.still) odo.settle();
      return { enter: () => { if (!api.still) api.at(150, () => odo.start()); } };
    },
  };

  B.type = {
    label: "Your viewer type", ms: 10500,
    say: `You are ${ctx.type.name}. ${ctx.type.verdict}`,
    build: (stage, api) => {
      const { card, inner } = typeCard(ctx);
      if (api.still) card.classList.add("is-revealed");
      stage.append(el("div", { class: "wr-ch wr-type" },
        el("span", { class: "play-eyebrow", "data-in": "" }, "Your viewer type"),
        el("p", { class: "wr-type-pre", "data-in": "", style: d(150) }, "Based on everything you watched, you are…"),
        el("div", { class: "wr-type-stage", "data-no-tap": "", "data-in": "fade" }, card),
        el("div", { class: "wr-type-text" },
          el("h2", { class: "play-sr" }, ctx.type.name),
          el("p", { class: "play-h2 wr-type-verdict", "data-in": "", style: d(2750) }, `“${ctx.type.verdict}”`)),
      ));
      let untilt = () => {};
      return {
        enter: () => {
          if (api.still) { untilt = tilt(inner); return; }
          api.at(2350, () => {
            card.classList.add("is-revealed");
            try { if (coarse()) haptic(18); } catch {}
            meteorBurst(stage, { x: 0.5, y: 0.42, count: 46 });
          });
          api.at(3300, () => { untilt = tilt(inner); });
        },
        leave: () => untilt(),
      };
    },
  };

  const words = R.interventionFor(w, name, { kids });
  // The intervention, one at a time: each line slams down on top of the
  // last, which is pushed back into a pile (a deck: it fits any screen). A
  // still story shows the plain list.
  B.roasts = {
    label: kids ? "The highlights" : "The intervention",
    ms: 1600 + words.length * 2700 + 1800,
    say: words.join(" "),
    build: (stage, api) => {
      api.at(200, () => ctx.card());
      const items = words.map((r, i) => el("li", { class: "wr-roast", "data-depth": api.still ? "0" : "", style: { "--i": String(i) } },
        el("span", { class: "wr-roast-q", "aria-hidden": "true" }, "“"),
        el("span", { class: "wr-roast-text" }, r),
        el("span", { class: "wr-roast-n play-num", "aria-hidden": "true" }, `${i + 1}/${words.length}`)));
      stage.append(el("div", { class: "wr-ch wr-roast-ch" },
        el("span", { class: "play-eyebrow", "data-in": "" }, kids ? "The highlights" : "The intervention"),
        el("h2", { class: "play-h1", "data-in": "", style: d(120) }, kids ? `Look at you go, ${name}!` : `We need to talk, ${name}.`),
        el("ol", { class: `wr-roasts${api.still ? "" : " is-deck"}` }, ...items),
      ));
      if (api.still) return null;
      return {
        enter: () => {
          words.forEach((_, k) => api.at(1300 + k * 2700, () => {
            items.forEach((li, i) => { if (i <= k) li.setAttribute("data-depth", String(Math.min(3, k - i))); });
            try { if (coarse()) haptic(10); } catch {}
          }));
        },
      };
    },
  };

  B.finale = {
    label: "Your summary", hold: true, ms: 0,
    say: "That's a wrap. Your summary card, ready to share.",
    build: (stage, api) => {
      const holder = el("div", { class: "wr-share-holder", "data-in": "pop", style: d(150) }, el("div", { class: "wr-share-wait" }));
      const shareLabel = canShareFiles() ? "Share" : "Save the picture";
      stage.append(el("div", { class: "wr-ch wr-finale" },
        holder,
        el("div", { class: "wr-finale-side" },
          el("span", { class: "play-eyebrow", "data-in": "", style: d(300) }, "That's a wrap"),
          el("h2", { class: "play-h1", "data-in": "", style: d(400) }, "Your year in the sky, ", el("span", { class: "play-gold-text" }, "in one picture.")),
          el("div", { class: "wr-finale-actions", "data-in": "", style: d(650) },
            el("button", { class: "focusable play-btn play-btn--gold play-press", type: "button", "data-ui": "wrapped.share", onclick: () => shareCard(ctx) }, shareLabel),
            el("button", { class: "focusable play-btn play-press", type: "button", "data-ui": "wrapped.replay", onclick: () => api.story.go(0, -1) }, "Replay"),
            el("button", { class: "focusable play-btn play-btn--quiet play-press", type: "button", "data-ui": "wrapped.all", onclick: () => ctx.closeStory() }, "All the numbers")),
        ),
      ));
      pressAll(stage);
      ctx.card().then((canvas) => {
        if (!canvas || api.signal.aborted) return;
        canvas.className = "wr-share-canvas";
        canvas.setAttribute("role", "img");
        canvas.setAttribute("aria-label", `Your Aurora Wrapped card: ${R.fmtH(w.totalSec)} watched, ${ctx.type.name}.`);
        holder.replaceChildren(canvas);
      });
    },
  };

  return B;
};

// ---------- the page: All the numbers ----------
const tile = (cls, ...kids) => el("section", { class: `play-card wr-tile ${cls}` }, ...kids);
const tileHead = (eyebrow) => el("h2", { class: "play-eyebrow wr-tile-head" }, eyebrow);

const renderPage = (screen, ctx) => {
  const { w, name, kids } = ctx;
  const f = R.hoursFelt(w.totalSec);
  const page = el("div", { class: "wr-page" });
  const { card, inner } = typeCard(ctx);
  card.classList.add("is-revealed");
  const words = R.interventionFor(w, name, { kids });
  const g = R.genreShares(w);
  const hasNight = Array.isArray(w.byHour) && w.byHour.some(Boolean);
  const sky = w.streak && Array.isArray(w.nights) && w.nights.length > 1 ? skyChart(w, { still: true, wide: true }) : null;

  page.append(
    el("header", { class: "wr-page-head" },
      el("span", { class: "play-eyebrow", html: `${STAR}<span>Aurora Wrapped</span>` }),
      el("h1", { class: "play-h1" }, "All the numbers"),
      el("p", { class: "play-lede" }, el("span", { dir: "auto" }, name), ` · since ${sinceText(w)} · ${w.plays} ${w.plays === 1 ? "sitting" : "sittings"} over ${w.activeDays} ${w.activeDays === 1 ? "night" : "nights"}`),
      el("div", { class: "wr-page-actions" },
        el("button", { class: "focusable play-btn play-btn--gold play-press", type: "button", "data-ui": "wrapped.story", onclick: () => ctx.openStory() },
          el("span", { html: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" fill="currentColor"/></svg>' }), "Play the story"),
        el("button", { class: "focusable play-btn play-press", type: "button", "data-ui": "wrapped.share", onclick: () => shareCard(ctx) }, canShareFiles() ? "Share the picture" : "Save the picture"))),
    el("div", { class: "wr-grid" },
      tile("wr-t-hours",
        tileHead("Time watched"),
        el("div", { class: "wr-t-big play-gold-text play-num" }, f.value),
        el("div", { class: "wr-t-unit" }, `${f.unit} watched`),
        ...f.lines.map((l) => el("p", { class: "play-small" }, l)),
        el("div", { class: "wr-chips" },
          el("span", { class: "play-chip" }, `${w.plays} ${w.plays === 1 ? "sitting" : "sittings"}`),
          el("span", { class: "play-chip" }, `${w.activeDays} ${w.activeDays === 1 ? "night" : "nights"}`),
          el("span", { class: "play-chip" }, `${w.distinctTitles} ${w.distinctTitles === 1 ? "title" : "titles"}`))),
      tile("wr-t-type",
        tileHead("Your viewer type"),
        el("div", { class: "wr-t-card" }, card),
        el("h3", { class: "play-h2" }, ctx.type.name),
        el("p", { class: "play-small" }, ctx.type.verdict)),
      w.topTitles && w.topTitles.length ? tile("wr-t-top",
        tileHead("Your top five"),
        el("ol", { class: "wr-toplist" }, ...w.topTitles.slice(0, 5).map((t, i) => el("li", {},
          el("span", { class: "wr-toplist-rank play-num" }, String(i + 1)),
          posterArt(t, { w: 120, cls: "wr-toplist-poster" }),
          el("span", { class: "wr-toplist-name", dir: "auto" }, t.name),
          el("span", { class: "wr-toplist-h play-num" }, R.fmtH(t.sec)))))) : null,
      g.length ? tile("wr-t-genres", tileHead("Your genre DNA"), genreBars(w)) : null,
      hasNight ? tile("wr-t-night",
        tileHead("When you really watch"),
        el("p", { class: "wr-t-line" }, `${R.DAYS[w.topWeekday]}s, ${R.hourLabel(R.primeHour(w))}`),
        el("div", { class: "wr-t-nightviz" }, weekBars(w, { compact: true }), dial(w)),
        el("p", { class: "play-small" }, `${w.lateNightSessions || 0} ${(w.lateNightSessions || 0) === 1 ? "sitting" : "sittings"} started after midnight.`))
        : tile("wr-t-night", tileHead("Your night"), el("p", { class: "wr-t-line" }, `${R.DAYS[w.topWeekday]}s`)),
      tile("wr-t-streak",
        tileHead("Longest streak"),
        el("p", { class: "wr-t-line" }, el("span", { class: "play-gold-text" }, String(w.bestStreak || 1)), ` ${(w.bestStreak || 1) === 1 ? "night" : "nights in a row"}`),
        w.streak && w.bestStreak > 1 ? el("p", { class: "play-small" }, `${shortDay(w.streak.from)} to ${shortDay(w.streak.to)}`) : null,
        w.biggestDay ? el("p", { class: "play-small" }, `Biggest day: ${shortDay(w.biggestDay.day)}, ${R.fmtH(w.biggestDay.sec)}`) : null,
        sky ? sky.box : null),
      w.longestSession ? tile("wr-t-long",
        tileHead("Longest sitting"),
        el("p", { class: "wr-t-line play-num" }, R.clock(w.longestSession.watchedSec), el("span", { class: "wr-soft" }, " h:mm")),
        el("p", { class: "play-small", dir: "auto" }, `“${w.longestSession.title}”`)) : null,
      w.byDevice && w.byDevice.length ? tile("wr-t-dev",
        tileHead("Where you watch"),
        el("ul", { class: "wr-devlist" }, ...w.byDevice.map((x) => {
          const total = w.byDevice.reduce((n, y) => n + y.sec, 0);
          const label = x.name === "Mobile" ? "Phone" : x.name === "?" ? "Somewhere" : x.name;
          return el("li", {}, el("span", {}, label), el("div", { class: "play-ribbon" }, el("i", { style: { "--p": String(R.share(x.sec, total)) } })), el("span", { class: "play-num" }, `${Math.round(R.share(x.sec, total) * 100)}%`));
        }))) : null,
      tile("wr-t-roasts",
        tileHead(kids ? "The highlights" : "The intervention"),
        el("ul", { class: "wr-roastlist" }, ...words.map((r) => el("li", {}, r)))),
    ),
    el("div", { class: "wr-page-foot" },
      el("button", { class: "focusable play-btn play-press", type: "button", "data-ui": "wrapped.browse", onclick: () => navigate("#/") }, "Back to browsing")),
  );
  screen.append(page);
  pressAll(page);
  const undo = [tilt(inner)];
  if (sky) requestAnimationFrame(() => sky.start());
  return () => { undo.forEach((u) => u()); if (sky) sky.stop(); };
};

// ---------- nothing watched yet: the teaser ----------
const renderTeaser = (screen, name) => {
  const back = el("div", { class: "play-face play-face--back wr-cb" },
    el("div", { class: "wr-cb-ring", html: STAR }),
    el("div", { class: "wr-cb-word" }, "Aurora Wrapped"),
    el("div", { class: "wr-cb-q" }, "?"));
  const inner = el("div", { class: "play-tilt wr-teaser-tilt" }, back);
  const card = el("div", { class: "play-collectible wr-type-card wr-teaser-card" }, el("div", { class: "wr-flip" }, inner));
  const locked = ["Your hours", "Your number one", "Your genre DNA", "Your streak", "Your viewer type", "The intervention"];
  const page = el("div", { class: "wr-page wr-teaser" },
    el("div", { class: "wr-teaser-text" },
      el("span", { class: "play-eyebrow", html: `${STAR}<span>Aurora Wrapped</span>` }),
      el("h1", { class: "play-h1" }, "Your sky is still dark, ", el("span", { class: "play-gold-text", dir: "auto" }, `${name}.`)),
      el("p", { class: "play-lede" }, "Every night you watch lights a star. Watch a few things and we'll draw your constellation, count your hours — and tell you exactly what kind of viewer you are. Politely or not."),
      el("ul", { class: "wr-locked", "aria-label": "Chapters waiting for you" }, ...locked.map((c) => el("li", { class: "play-chip" }, el("span", { class: "wr-lock", "aria-hidden": "true" }), c))),
      el("button", { class: "focusable play-btn play-btn--gold play-press", type: "button", "data-ui": "wrapped.browse", onclick: () => navigate("#/") }, "Find something to watch")),
    el("div", { class: "wr-teaser-art", "aria-hidden": "true" }, card),
  );
  screen.append(page);
  pressAll(page);
  return tilt(inner);
};

// ---------- the screen ----------
export const renderWrapped = async (root) => {
  const screen = el("div", { class: "screen wr play-surface" });
  root.append(screen);
  const cleanups = [];
  const cleanup = () => { while (cleanups.length) { try { cleanups.pop()(); } catch {} } };
  if (!state.profile) {
    await loadPlayCss();
    screen.append(el("div", { class: "wr-page wr-msg" }, el("span", { class: "play-eyebrow" }, "Aurora Wrapped"), el("p", { class: "play-lede" }, "Pick a profile first.")));
    return cleanup;
  }
  const profile = state.profile;
  let w;
  try {
    [w] = await Promise.all([api.wrapped(profile.id), loadPlayCss()]);
  } catch {
    await loadPlayCss();
    screen.append(el("div", { class: "wr-page wr-msg" },
      el("span", { class: "play-eyebrow" }, "Aurora Wrapped"),
      el("p", { class: "play-lede" }, "Couldn't load your stats."),
      el("button", { class: "focusable play-btn play-press", type: "button", "data-ui": "wrapped.retry", onclick: () => navigate("#/wrapped") }, "Try again")));
    return cleanup;
  }
  const bg = room({ seed: 21 });
  bg.el.classList.add("wr-room");
  screen.prepend(bg.el);
  cleanups.push(bg.destroy);

  const name = profile.name;
  if (!w || w.empty) {
    cleanups.push(renderTeaser(screen, name));
    return cleanup;
  }

  const kids = isKids();
  const ctx = { w, name, kids, type: R.viewerType(w, { kids }) };
  let cardPromise = null;
  ctx.card = () => (cardPromise || (cardPromise = paintShareCard(ctx).catch(() => null)));

  let story = null;
  let storyRoom = null;
  const closeStory = () => {
    if (!story) return;
    story.destroy();
    story = null;
    if (storyRoom) storyRoom.destroy();
    storyRoom = null;
    const h = screen.querySelector(".wr-page h1");
    try { if (h) { h.setAttribute("tabindex", "-1"); h.focus({ preventScroll: true }); } } catch {}
  };
  const openStory = (start = 0) => {
    if (story) return;
    const B = chapterBuilders(ctx);
    const ids = R.chaptersFor(w);
    const chapters = ids.map((id) => ({ id, ...B[id] }));
    storyRoom = room({ seed: 5 });
    story = createStory({
      host: document.body, // (not inside .screen: its entrance transform would hold a fixed overlay)
      label: "Aurora Wrapped",
      chapters,
      start,
      still: reduced(),
      top: el("span", { class: "play-chip wr-story-chip" }, el("span", { class: "wr-story-dot", html: STAR }), el("span", { dir: "auto" }, name)),
      onExit: () => ctx.closeStory(),
      onSkip: () => story && story.go(chapters.length - 1, 1),
      onEnd: () => ctx.closeStory(),
    });
    story.el.classList.add("wr-story");
    story.el.prepend(storyRoom.el);
    // (the share card is painted at the intervention — a calm chapter whose
    // motion is all on the compositor — so it is ready by the finale without
    // a long task landing in the middle of the deal or the reveal)
    // the top five's pictures, fetched now: they are dealt in the third chapter
    for (const t of (w.topTitles || []).slice(0, 5)) if (t.poster) { const i = new Image(); i.decoding = "async"; i.src = artUrl(t.poster, 260); }
  };
  ctx.openStory = () => openStory(0);
  ctx.closeStory = closeStory;
  cleanups.push(() => closeStory());

  // The page is drawn when it is to be seen: under a playing story it would
  // be a full first layout (posters, the sky, the card — measured at ~0.5 s
  // on a throttled phone) in the middle of the opening, for a page nobody can
  // see yet. Until then the screen holds its name, for screen readers and
  // the route's own check. Reduced motion: the page at once.
  let undoPage = null;
  const holder = el("div", { class: "wr-holder" }, el("h1", { class: "play-eyebrow play-sr" }, "Aurora Wrapped"));
  screen.append(holder);
  const drawPage = () => {
    if (undoPage || !screen.isConnected) return;
    holder.remove();
    undoPage = renderPage(screen, ctx);
  };
  cleanups.push(() => { if (undoPage) undoPage(); });
  const close = ctx.closeStory;
  ctx.closeStory = () => { drawPage(); close(); };
  if (!reduced()) openStory(0);
  else drawPage();
  return cleanup;
};

// Aurora Play — a small constellation: one star for each thing counted
// (Taste: a title loved this sitting).
//
//   constellation(n, seed, { w, h })  (pure) -> { points: [{ x, y, r }],
//       lines: [[i, j]] }: n stars (1..12) wandering left to right across the
//       box, each joined to the next, with one side branch from seven up.
//       The same seed draws the same sky.
//   constellationSvg(n, seed)  -> an <svg class="pg-const"> of it, aria-hidden;
//       its stars and lines carry --d (ms) so CSS brings them in one by one.
//   seedOf(text)  -> a number from a string (ids), for the seed.
const rng = (seed) => {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export const seedOf = (text) => {
  let h = 2166136261;
  for (const ch of String(text || "")) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0;
  return h || 1;
};

export const MAX_STARS = 12;

export const constellation = (n, seed = 1, { w = 320, h = 110 } = {}) => {
  const count = Math.max(0, Math.min(MAX_STARS, Math.floor(Number(n) || 0)));
  if (!count) return { points: [], lines: [] };
  const rand = rng(seed);
  const padX = 18, padY = 16;
  const main = count >= 7 ? count - 1 : count; // from seven up, one star hangs off the line
  const step = main > 1 ? (w - padX * 2) / (main - 1) : 0;
  const points = [];
  let y = padY + rand() * (h - padY * 2);
  for (let i = 0; i < main; i++) {
    // each star steps up or down from the one before: a wandering line, never flat
    const span = (h - padY * 2) * (0.28 + rand() * 0.34);
    const dir = y > h * 0.62 ? -1 : y < h * 0.38 ? 1 : rand() < 0.5 ? -1 : 1;
    if (i) y = Math.max(padY, Math.min(h - padY, y + dir * span));
    const x = main > 1 ? padX + i * step + (i && i < main - 1 ? (rand() - 0.5) * step * 0.36 : 0) : w / 2;
    points.push({ x: +x.toFixed(1), y: +(main > 1 ? y : h / 2).toFixed(1), r: +(2.4 + rand() * 2.4).toFixed(1) });
  }
  const lines = [];
  for (let i = 1; i < main; i++) lines.push([i - 1, i]);
  if (main < count) {
    const at = 1 + Math.floor(rand() * (main - 2));
    const from = points[at];
    const up = from.y > h / 2;
    const y2 = up ? Math.max(padY - 6, from.y - 34 - rand() * 14) : Math.min(h - padY + 6, from.y + 34 + rand() * 14);
    points.push({ x: +(from.x + (rand() - 0.5) * 26).toFixed(1), y: +y2.toFixed(1), r: +(2.2 + rand() * 1.6).toFixed(1) });
    lines.push([at, points.length - 1]);
  }
  return { points, lines };
};

const NS = "http://www.w3.org/2000/svg";
const node = (name, attrs = {}) => {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
};

export const constellationSvg = (n, seed = 1, { step = 70 } = {}) => {
  const w = 320, h = 110;
  const { points, lines } = constellation(n, seed, { w, h });
  const svg = node("svg", { viewBox: `0 0 ${w} ${h}`, class: "pg-const", "aria-hidden": "true", focusable: "false" });
  for (const [a, b] of lines) {
    const l = node("line", { x1: points[a].x, y1: points[a].y, x2: points[b].x, y2: points[b].y, class: "pg-const-line" });
    l.style.setProperty("--d", `${Math.round((Math.max(a, b) + 0.5) * step)}ms`);
    svg.append(l);
  }
  points.forEach((p, i) => {
    const g = node("g", { transform: `translate(${p.x} ${p.y})` });
    const pop = node("g", { class: "pg-const-star" });
    pop.style.setProperty("--d", `${i * step}ms`);
    pop.append(node("circle", { r: (p.r * 2.6).toFixed(1), class: "pg-const-halo" }), node("circle", { r: p.r, class: "pg-const-core" }));
    g.append(pop);
    svg.append(g);
  });
  return svg;
};

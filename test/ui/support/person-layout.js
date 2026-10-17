// The person sheet's no-overlap check (person.test.js and the layout sweep
// behind docs/qa/person-layout): run IN THE PAGE (page.evaluate(overlapReport))
// with the sheet open. It answers a list of problems, empty when:
//   · nothing in the sheet is drawn outside the sheet (left/right, and the
//     header above/below), and nothing makes the sheet's body scroll sideways;
//   · the header's parts (face, name block, IMDb, close) do not touch;
//   · the photo strip, the biography, the "press a title" line and the title
//     sections follow one another without overlapping;
//   · title cards (and their posters) do not overlap each other; inside a
//     card the poster, the words and the Details button do not overlap, and
//     the + mark, the flag, the watch bar and a poster-less tile's title stay
//     apart, on the poster;
//   · the header (and its close button) is not covered by anything;
//   · the enlarged-photo viewer (when open) fits the sheet, its buttons and
//     the counter do not touch, and the photo stays clear of the close button.
// Measured as laid out: a card's hover lift and focus scale (transforms, by
// design) are switched off for the measurement.
const overlapReport = () => {
  // a focused card is lifted on purpose (a transform): measure the layout
  const still = document.createElement("style");
  still.textContent = ".person-wrap .pt-card { transform: none !important; transition: none !important; }";
  document.head.append(still);
  try {
    return measure();
  } finally {
    still.remove();
  }
  function measure() {
  const out = [];
  const wrap = document.querySelector(".person-wrap");
  const sheet = wrap && wrap.querySelector(".person-sheet");
  if (!sheet) return ["no person sheet is open"];
  const S = sheet.getBoundingClientRect();
  const E = 0.5;
  const visible = (n) => {
    if (!n || !n.isConnected) return false;
    const cs = getComputedStyle(n);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    const r = n.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const box = (n) => n.getBoundingClientRect();
  const name = (n) => {
    if (!n) return "?";
    const t = n.closest(".pt") && n.closest(".pt").querySelector(".pt-title");
    return `${n.tagName.toLowerCase()}.${[...n.classList].join(".")}${t ? ` ["${t.textContent.slice(0, 24)}"]` : ""}`;
  };
  const hit = (a, b) => {
    const A = box(a), B = box(b);
    const w = Math.min(A.right, B.right) - Math.max(A.left, B.left);
    const h = Math.min(A.bottom, B.bottom) - Math.max(A.top, B.top);
    return w > 1 && h > 1 ? `${Math.round(w)}×${Math.round(h)}` : null;
  };
  const apart = (list, what) => {
    const v = list.filter(visible);
    for (let i = 0; i < v.length; i++)
      for (let j = i + 1; j < v.length; j++) {
        const o = hit(v[i], v[j]);
        if (o) out.push(`${what}: ${name(v[i])} overlaps ${name(v[j])} by ${o}`);
      }
  };
  const inside = (n, R, what) => {
    if (!visible(n)) return;
    const r = box(n);
    if (r.left < R.left - E || r.right > R.right + E) out.push(`${what}: ${name(n)} spills sideways (${Math.round(r.left)}..${Math.round(r.right)} vs ${Math.round(R.left)}..${Math.round(R.right)})`);
  };

  // the sheet itself is on screen
  if (S.left < -E || S.right > innerWidth + E || S.top < -E || S.bottom > innerHeight + E)
    out.push(`the sheet is outside the window (${Math.round(S.left)},${Math.round(S.top)} ${Math.round(S.width)}×${Math.round(S.height)} in ${innerWidth}×${innerHeight})`);

  // the header
  const head = sheet.querySelector(".person-head");
  const H = box(head);
  if (H.top < S.top - E || H.bottom > S.bottom + E) out.push("the header is outside the sheet");
  const headParts = [".person-face", ".person-id", ".person-imdb", ".person-close"].map((s) => head.querySelector(s));
  apart(headParts, "header");
  for (const n of [...headParts, head.querySelector(".person-name"), head.querySelector(".person-sub")]) inside(n, S, "header");
  for (const n of headParts.filter(visible)) {
    const r = box(n);
    if (r.top < S.top - E || r.bottom > S.bottom + E) out.push(`header: ${name(n)} is cut off at the top or bottom`);
  }
  // the name and the line under it stay inside their block (they ellipsize)
  const idBox = head.querySelector(".person-id");
  for (const s of [".person-name", ".person-sub"]) {
    const n = head.querySelector(s);
    if (visible(n) && visible(idBox) && (box(n).right > box(idBox).right + E)) out.push(`header: ${s} runs past its block`);
  }
  // the close button is what a press on it reaches (nothing covers it)
  const closeBtn = head.querySelector(".person-close");
  if (visible(closeBtn) && !sheet.querySelector(".person-viewer")) {
    const r = box(closeBtn);
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!at || !closeBtn.contains(at)) out.push(`the close button is covered by ${name(at)}`);
  }

  // the body: no sideways scroll, every block in order
  const body = sheet.querySelector(".person-body");
  if (body.scrollWidth > body.clientWidth + 1) out.push(`the body scrolls sideways (${body.scrollWidth} > ${body.clientWidth})`);
  const B = box(body);
  if (B.top < H.bottom - E) out.push(`the body starts under the header (${Math.round(B.top)} < ${Math.round(H.bottom)})`);
  const blocks = [".person-photos", ".person-bio", ".person-how", ...[...body.querySelectorAll(".person-titles > *")].map((n, i) => n)]
    .map((s) => (typeof s === "string" ? body.querySelector(s) : s))
    .filter((n) => visible(n) && !(n.classList.contains("person-how") && !n.textContent.trim()));
  apart(blocks, "body");
  for (let i = 1; i < blocks.length; i++)
    if (box(blocks[i]).top < box(blocks[i - 1]).bottom - 1) out.push(`body: ${name(blocks[i])} starts above the end of ${name(blocks[i - 1])}`);
  for (const n of blocks) inside(n, S, "body");
  // the photos: inside the strip's own height, not one on another
  const photos = [...body.querySelectorAll(".person-photos > .person-photo")].filter(visible);
  apart(photos, "photos");
  const strip = body.querySelector(".person-photos");
  if (visible(strip))
    for (const p of photos) if (box(p).top < box(strip).top - E || box(p).bottom > box(strip).bottom + E) out.push(`photos: ${name(p)} is cut by the strip`);
  // the titles
  const cards = [...body.querySelectorAll(".person-grid > .pt")].filter(visible);
  apart(cards, "titles");
  apart(cards.map((c) => c.querySelector(".pt-card")), "posters");
  for (const c of cards) {
    const parts = [c.querySelector(".pt-card"), c.querySelector(".pt-text"), c.querySelector(".pt-more")];
    apart(parts, "card");
    const C = box(c);
    for (const p of parts.filter(visible)) {
      const r = box(p);
      if (r.left < C.left - E || r.right > C.right + E) out.push(`card: ${name(p)} is wider than its cell`);
    }
    inside(c, S, "titles");
    // the corner marks stay on the poster
    const poster = c.querySelector(".pt-card");
    for (const m of [c.querySelector(".pt-mark"), c.querySelector(".pt-flag")].filter(visible)) {
      const r = box(m), P = box(poster);
      if (r.left < P.left - E || r.right > P.right + E || r.top < P.top - E || r.bottom > P.bottom + E) out.push(`card: ${name(m)} sticks out of the poster`);
    }
    // the + mark, the flag (In library / Watched) and the watch bar: apart
    // (and a poster-less tile's title, too)
    apart([c.querySelector(".pt-mark"), c.querySelector(".pt-flag"), c.querySelector(".card-progress"), c.querySelector(".card-fallback > span")], "card marks");
  }
  // section headings over their grid
  for (const s of body.querySelectorAll(".person-section")) apart([s.querySelector("h3"), s.querySelector(".person-grid")], "section");

  // the enlarged photo
  const viewer = sheet.querySelector(".person-viewer");
  if (visible(viewer)) {
    const V = box(viewer);
    if (V.left < S.left - E || V.right > S.right + E || V.top < S.top - E || V.bottom > S.bottom + E) out.push("viewer: outside the sheet");
    const ctl = [viewer.querySelector(".person-viewer-close"), viewer.querySelector(".person-viewer-nav.prev"), viewer.querySelector(".person-viewer-nav.next"), viewer.querySelector(".person-viewer-count")];
    apart(ctl, "viewer");
    for (const n of ctl.filter(visible)) {
      const r = box(n);
      if (r.left < V.left - E || r.right > V.right + E || r.top < V.top - E || r.bottom > V.bottom + E) out.push(`viewer: ${name(n)} is outside the viewer`);
    }
    // the photo on screen: whole, and clear of the close button and the counter
    const track = viewer.querySelector(".person-viewer-track");
    const T = box(track);
    const shown = [...viewer.querySelectorAll(".person-viewer-slide img")].find((i) => { const r = box(i); return r.left >= T.left - 2 && r.right <= T.right + 2; });
    if (!shown) out.push("viewer: no photo is wholly on screen");
    else {
      const r = box(shown);
      if (r.width < 40 || r.height < 60) out.push(`viewer: the photo is ${Math.round(r.width)}×${Math.round(r.height)}`);
      if (r.top < V.top - E || r.bottom > V.bottom + E) out.push("viewer: the photo is cut at the top or bottom");
      for (const n of [viewer.querySelector(".person-viewer-close"), viewer.querySelector(".person-viewer-count")].filter(visible)) {
        const o = hit(shown, n);
        if (o) out.push(`viewer: the photo is under ${name(n)} by ${o}`);
      }
    }
  }
  // the page under the sheet does not scroll sideways because of it
  if (document.documentElement.scrollWidth > innerWidth + 1) out.push(`the page scrolls sideways (${document.documentElement.scrollWidth} > ${innerWidth})`);
  return out;
  }
};


// The hardest person to lay out, made from the server's own answer for a
// person (route.fetch() of /api/person): a very long name, twenty photos, a
// long biography, sixty titles with long (and unbreakable) names, long roles,
// no posters, some watched, some part-watched, some in the library.
const LONG_NAME = "Maximiliana Alexandrovna Konstantinopoulou-Wolfeschlegelsteinhausen";
const crowded = (d) => ({
  ...d,
  name: LONG_NAME,
  bio: String(d.bio || "A filmmaker. ").repeat(6),
  photos: Array.from({ length: 20 }, (_, i) => ({ url: `https://image.tmdb.org/t/p/h632/crowd${i}.jpg`, thumb: `/img/ext?u=crowd${i}&w=360`, full: `/img/ext?u=original-crowd${i}&w=960` })),
  credits: Array.from({ length: 60 }, (_, i) => {
    const base = d.credits[i % d.credits.length];
    return {
      ...base,
      key: `m:${1000 + i}`,
      title: i % 3 === 0 ? `The Extraordinarily Long and Winding Title of a Film That Never Seems to End, Part ${i}` : i % 3 === 1 ? `Supercalifragilisticexpialidociouslylongwordtitle${i}` : `Short ${i}`,
      role: i % 2 ? "Director · Writer · Executive Producer of Everything" : base.role,
      poster: null,
      imdbId: `tt79${String(i).padStart(5, "0")}`,
      inLibrary: i % 4 === 0 ? base.inLibrary : null,
      inList: i % 6 === 0,
      watched: i % 5 === 0,
      ...(i % 7 === 0 ? { progress: 0.4 } : {}),
    };
  }),
});

module.exports = { overlapReport, crowded, LONG_NAME };

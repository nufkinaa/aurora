// HTML-escaped text from outside catalogues, made plain.
//
// Cinemeta (and a few other sources) hand back names and synopses with HTML
// entities in them — "Josh O&apos;Connor". A browser decodes those for free
// only when the text goes in as HTML; every place that shows them here puts
// them in as TEXT (the website's textContent, the TV's <Text>), so the swipe
// deck's line read "… with Josh O&apos;Connor" on both (2026-10-18). Decoded
// once, where the text enters, so no screen has to remember to.
const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };

const plainText = (s) => {
  if (typeof s !== "string" || s.indexOf("&") < 0) return s;
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    const v = NAMED[e.toLowerCase()];
    return v === undefined ? m : v;
  });
};

module.exports = { plainText };

// What is put BEHIND the glass for a photograph or a measurement, and how the
// words on it are found. Everything here runs in the page (installed by
// lib.openPage as window.__ga) and is the same on both sides of a comparison.
"use strict";

const HELPERS = () => {
  const ga = (window.__ga = {});

  // ---- pictures made on the spot -----------------------------------------
  // "white": a white poster (the worst thing a bar can float over);
  // "cream" / "snow" / "lemon": bright posters with something drawn on them.
  ga.poster = (kind = "white", w = 400, h = 600) => {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const x = c.getContext("2d");
    const base = { white: "#ffffff", cream: "#fff3d6", snow: "#eaf4ff", lemon: "#fff27a" }[kind] || kind;
    x.fillStyle = base; x.fillRect(0, 0, w, h);
    if (kind !== "white" && base !== kind) {
      const g = x.createRadialGradient(w * 0.7, h * 0.3, 10, w * 0.7, h * 0.3, w * 0.9);
      g.addColorStop(0, "#ffffff"); g.addColorStop(1, "rgba(255,255,255,0)");
      x.fillStyle = g; x.fillRect(0, 0, w, h);
      x.fillStyle = kind === "snow" ? "#9ec9ff" : kind === "lemon" ? "#ffb347" : "#ffc9a3";
      x.beginPath(); x.arc(w * 0.3, h * 0.72, w * 0.26, 0, 7); x.fill();
    }
    x.fillStyle = kind === "white" ? "#d9d9de" : "rgba(40,40,60,0.55)";
    x.font = `800 ${Math.round(w / 9)}px system-ui, sans-serif`;
    x.fillText(kind === "white" ? "WHITE NIGHTS" : "DAYLIGHT", w * 0.08, h * 0.16);
    return c.toDataURL("image/png");
  };

  const lock = (img, url) => {
    img.removeAttribute("srcset"); img.removeAttribute("sizes"); img.removeAttribute("loading");
    img.src = url;
    // the app may come back to give the picture a sharper copy: it stays ours
    try {
      Object.defineProperty(img, "src", { get: () => url, set: () => {}, configurable: true });
      Object.defineProperty(img, "srcset", { get: () => "", set: () => {}, configurable: true });
      const sa = img.setAttribute.bind(img);
      img.setAttribute = (k, v) => { if (k !== "src" && k !== "srcset") sa(k, v); };
    } catch {}
    return img.decode ? img.decode().catch(() => {}) : Promise.resolve();
  };

  // Scroll a shelf of posters under `barSel` and make its posters bright ones.
  // frac: where on the poster's height the bar's middle falls (0 top … 1 foot).
  ga.brightRow = async (barSel, { frac = 0.45, kinds = ["white", "cream", "snow", "white", "lemon", "white"], nth = 0 } = {}) => {
    const bar = document.querySelector(barSel).getBoundingClientRect();
    const rows = [...document.querySelectorAll(".row")].filter((r) => r.querySelector(".card img") && r.getBoundingClientRect().top + scrollY > innerHeight * 0.75);
    const row = rows[nth] || rows[0];
    if (!row) return false;
    const card = row.querySelector(".card img");
    const cr = card.getBoundingClientRect();
    const y = cr.top + scrollY + cr.height * frac - (bar.top + bar.height / 2);
    scrollTo(0, Math.max(0, Math.round(y)));
    await new Promise((r) => setTimeout(r, 400));
    const imgs = [...row.querySelectorAll(".card img")].filter((i) => i.getBoundingClientRect().width > 40);
    await Promise.all(imgs.map((img, i) => lock(img, ga.poster(kinds[i % kinds.length]))));
    // the nav reads what is behind it on scroll: tell it something moved
    scrollBy(0, 1); scrollBy(0, -1);
    return true;
  };

  // The hero's / a title page's own picture, turned white (its fades stay).
  ga.whiteArt = async () => {
    const url = ga.poster("white", 320, 180);
    let n = 0;
    for (const e of document.querySelectorAll(".hero, .hero *, .detail-hero, .detail-hero *, .detail-backdrop, .detail-backdrop *, .backdrop, .backdrop *")) {
      if (e.tagName === "IMG" && e.getBoundingClientRect().width > 200) { await lock(e, url); n++; continue; }
      const bi = getComputedStyle(e).backgroundImage;
      if (bi && bi.includes("url(") && e.getBoundingClientRect().width > 200) {
        e.style.setProperty("background-image", bi.replace(/url\([^)]*\)/g, `url("${url}")`), "important");
        n++;
      }
    }
    scrollBy(0, 1); scrollBy(0, -1);
    return n;
  };

  // ---- a plain backdrop --------------------------------------------------
  // kind: white | black | mid | text | poster — a sheet laid under the chrome
  //       (over the page, under everything that floats);
  //       sky | skybright — the page's own content hidden, so the sky is what
  //       is behind; skybright paints the sky as one bright band.
  ga.backdrop = async (kind, { keepContent = false } = {}) => {
    document.getElementById("ga-bd")?.remove();
    document.getElementById("ga-bd-style")?.remove();
    const repaintSky = (stops) => {
      window.__gaSky = stops;
      for (const c of document.querySelectorAll("canvas")) if (c.__paintStill) c.__paintStill();
    };
    repaintSky(kind === "skybright" ? ["#8cffbe", "#8cffbe"] : null);
    if (kind === "sky" || kind === "skybright") {
      if (!keepContent) {
        const st = document.createElement("style");
        st.id = "ga-bd-style";
        st.textContent = "#view, #app > main, main#view { visibility: hidden !important; }";
        document.head.append(st);
      }
    } else if (kind) {
      const d = document.createElement("div");
      d.id = "ga-bd";
      d.style.cssText = "position:fixed;inset:0;z-index:99;overflow:hidden;";
      if (kind === "white") d.style.background = "#ffffff";
      else if (kind === "black") d.style.background = "#000000";
      else if (kind === "mid") d.style.background = "#939393";
      else if (kind === "text") {
        d.style.background = "#000000";
        d.style.color = "#ffffff";
        d.style.font = "700 19px/1.18 system-ui, sans-serif";
        d.style.padding = "3px 6px";
        d.textContent = "White words pass under the glass — every title, every line of a synopsis, a chat. ".repeat(260);
      } else if (kind === "poster") {
        const img = new Image();
        img.src = ga.poster("cream", 400, 600);
        img.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;";
        d.append(img);
        await img.decode().catch(() => {});
      }
      document.body.append(d);
    }
    scrollBy(0, 1); scrollBy(0, -1);
    window.dispatchEvent(new Event("scroll"));
    await new Promise((r) => setTimeout(r, 650));
  };

  // ---- the words on a surface ---------------------------------------------
  const parse = (css) => {
    let m = /^rgba?\(([^)]+)\)$/.exec(css);
    if (m) { const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
    m = /^color\(srgb ([^)]+)\)$/.exec(css);
    if (m) { const p = m[1].split(/[\s/]+/).filter(Boolean).map(Number); return [p[0] * 255, p[1] * 255, p[2] * 255, p.length > 3 ? p[3] : 1]; }
    return null;
  };
  const opacityOf = (e) => { let o = 1; for (let n = e; n && n.nodeType === 1; n = n.parentElement) o *= Number(getComputedStyle(n).opacity); return o; };
  const shown = (e) => { const c = getComputedStyle(e); return c.visibility !== "hidden" && c.display !== "none"; };

  // Something else lies over this spot (a bar over a row that scrolled under
  // it): the word cannot be seen there, so it is not measured there.
  const covered = (root, r) => {
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx >= innerWidth || cy >= innerHeight) return true;
    const e = document.elementFromPoint(cx, cy);
    return !!e && !(root.contains(e) || e.contains(root));
  };
  // A filled button (white, or the accent) is paint, not glass: its words are
  // not this material's to answer for.
  const painted = (p) => !!p.closest(".btn-primary, .btn-accent, .btn-danger, .switch, .toggle, .pref-switch, [role='switch'], input, select, textarea, .avatar, .badge, .disc-tag");

  // Every run of letters and every line-drawn icon inside the elements that
  // match `sel`: where it is and what colour it is drawn in.
  ga.labels = (sel, { max = 40 } = {}) => {
    const out = [];
    const roots = [...document.querySelectorAll(sel)];
    for (const root of roots) {
      const rr = root.getBoundingClientRect();
      if (!rr.width || rr.bottom < 0 || rr.top > innerHeight) continue;
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const t = n.nodeValue.trim();
        if (!/[A-Za-z0-9֐-׿]/.test(t)) continue;
        const p = n.parentElement;
        if (!p || !shown(p) || p.closest("svg") || painted(p)) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        const col = parse(getComputedStyle(p).color);
        if (!col) continue;
        col[3] *= opacityOf(p);
        if (col[3] < 0.05) continue;
        for (const r of range.getClientRects()) {
          if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
          if (covered(root, r)) continue;
          const fs = parseFloat(getComputedStyle(p).fontSize);
          // the glyphs' band: a little inside the line box
          const inset = Math.max(0, (r.height - fs) / 2);
          out.push({ text: t.slice(0, 28), kind: "text", rect: [r.left, r.top + inset, r.width, r.height - 2 * inset], color: col, size: fs, weight: getComputedStyle(p).fontWeight, on: !!p.closest(".active, .on, .open, [aria-selected='true'], [aria-current]") });
          if (out.length >= max) return out;
        }
      }
      for (const s of root.matches("svg") ? [root] : root.querySelectorAll("svg")) {
        if (!shown(s) || painted(s)) continue;
        const r = s.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) continue;
        if (covered(root, r)) continue;
        const cs = getComputedStyle(s);
        const col = parse(cs.stroke !== "none" ? cs.stroke : cs.fill) || parse(cs.color);
        if (!col) continue;
        col[3] *= opacityOf(s);
        if (col[3] < 0.05) continue;
        out.push({ text: "(icon)", kind: "icon", rect: [r.left, r.top, r.width, r.height], color: col, on: !!s.closest(".active, .on, .open") });
        if (out.length >= max) return out;
      }
    }
    return out;
  };

  // The words taken off (their surfaces stay), for the photograph of what is
  // behind them; and put back.
  ga.hideLabels = (sel) => {
    document.querySelectorAll(sel).forEach((e) => e.setAttribute("data-ga-root", ""));
    const st = document.createElement("style");
    st.id = "ga-hide";
    st.textContent = "[data-ga-root], [data-ga-root] * { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; caret-color: transparent !important; }" +
      " [data-ga-root] svg, svg[data-ga-root], [data-ga-root] img, [data-ga-root] .nav-new-dot, [data-ga-root] .logo-mark, [data-ga-root] i { opacity: 0 !important; }" +
      " .nav-gear.has-new::after, .nav-more.has-new::after { opacity: 0 !important; }" +
      " [data-ga-root]::placeholder, [data-ga-root] *::placeholder { color: transparent !important; }";
    document.head.append(st);
  };
  ga.showLabels = () => {
    document.getElementById("ga-hide")?.remove();
    document.querySelectorAll("[data-ga-root]").forEach((e) => e.removeAttribute("data-ga-root"));
  };
};

module.exports = { HELPERS };

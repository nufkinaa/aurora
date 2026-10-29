// /install — the product page's few moving parts (public/install.html).
// Everything on the page is already there without this file; it adds:
//   - the addresses as this browser reached the server (the HTML has the
//     server's guess, from the request's Host)
//   - the QR code for /download, drawn here (js/qr.js — no outside service)
//   - the What's new tabs
//   - "This device" on the card for the device the page is open on
//   - Copy buttons, and Install app where the browser offers it
//   - the glass look's sky, started once the page is idle (js/aurora-sky.js)
import { qrSvg } from "./qr.js";

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
document.documentElement.classList.add("js");

// ---------- the addresses ----------
const host = location.host;
for (const el of $$("code, .ios-url")) {
  // only the ones the server filled in with its own guess at the address
  const t = el.textContent;
  const m = /^([A-Za-z0-9.:\-[\]]+|this-server)(\/[\w/-]*)?$/.exec(t);
  if (m && m[1] !== host && (m[1] === "this-server" || /[.:]/.test(m[1]))) el.textContent = host + (m[2] || "");
}

// ---------- the QR for /download ----------
const qr = $("#qr");
if (qr) {
  const url = `${location.origin}${qr.dataset.path || "/download"}`;
  try {
    qr.innerHTML = qrSvg(url, { label: `QR code for ${url}` });
  } catch {
    qr.hidden = true;
  }
}

// ---------- What's new: tabs ----------
{
  const tabs = $$(".tabs .tab");
  const select = (tab, focus) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      const panel = document.getElementById(t.getAttribute("aria-controls"));
      if (panel) panel.hidden = !on;
    }
    if (focus) tab.focus();
  };
  tabs.forEach((t, i) => {
    t.addEventListener("click", () => select(t, false));
    t.addEventListener("keydown", (e) => {
      const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (e.key === "Home") { e.preventDefault(); select(tabs[0], true); }
      else if (e.key === "End") { e.preventDefault(); select(tabs[tabs.length - 1], true); }
      else if (d) { e.preventDefault(); select(tabs[(i + d + tabs.length) % tabs.length], true); }
    });
  });
  // the app this device would want first
  const ua = navigator.userAgent;
  const first = /Android/i.test(ua) && !/Mobile/i.test(ua) && /TV|AFT|BRAVIA|Chromecast|GoogleTV/i.test(ua) ? "tab-tv"
    : /iPhone|iPad|Macintosh|Windows|Linux|CrOS/i.test(ua) && !/Android/i.test(ua) ? "tab-web" : "tab-tv";
  if (tabs.length) select(document.getElementById(first) || tabs[0], false);
}

// ---------- "This device" ----------
{
  const ua = navigator.userAgent;
  const touchMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1; // an iPad asking for the desktop site
  const which =
    /Android/i.test(ua) && /TV|AFT|BRAVIA|Chromecast|GoogleTV|SMART-TV/i.test(ua) ? "tv"
      : /Android/i.test(ua) ? "android"
        : /iPhone|iPad|iPod/i.test(ua) || touchMac ? "ios"
          : /Windows|Macintosh|Linux|CrOS/i.test(ua) ? "computer" : null;
  const card = which && document.getElementById(which);
  if (card) {
    card.classList.add("here");
    const badge = $(".here-badge", card);
    if (badge) badge.hidden = false;
    // on a phone, its own way in comes first
    if (which === "ios" || which === "android") card.style.order = "-1";
  }
}

// ---------- Copy ----------
for (const btn of $$("[data-copy]")) {
  btn.addEventListener("click", async () => {
    const src = document.getElementById(btn.dataset.copy);
    const text = src ? src.textContent.trim() : "";
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch {}
    if (!ok) {
      // (no clipboard on a plain-http LAN address: select it, so a long press copies)
      try { const r = document.createRange(); r.selectNodeContents(src); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } catch {}
    }
    const was = btn.textContent;
    btn.textContent = ok ? "Copied" : "Selected";
    setTimeout(() => { btn.textContent = was; }, 1600);
  });
}

// ---------- Install app (where the browser offers it) ----------
{
  const btn = $(".install-pwa");
  let offer = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    offer = e;
    if (btn) btn.hidden = false;
  });
  if (btn) btn.addEventListener("click", async () => {
    if (!offer) return;
    offer.prompt();
    try { await offer.userChoice; } catch {}
    offer = null;
    btn.hidden = true;
  });
}

// ---------- the sky ----------
// The app's own painter, as the glass look runs it (main.js): only once the
// page is idle — never in the way of the first paint — and not in the
// classic look. It stops by itself when the tab hides; reduced motion and
// weak devices get one still frame (aurora-sky.js).
if (document.documentElement.dataset.look !== "legacy") {
  (window.requestIdleCallback || ((fn) => setTimeout(fn, 900)))(() => {
    import("./aurora-sky.js").then((m) => {
      const canvas = $("#sky");
      if (!canvas) return;
      m.initAuroraSky(canvas, { pace: 0.8 });
      canvas.classList.add("on");
    }).catch(() => {});
  }, { timeout: 2500 });
}

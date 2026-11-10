// "What do we watch tonight?" on the website (#/group, #/group/:code).
//
// A few people decide together: one starts a session (usually on the TV —
// a code and a QR code on the big screen — or here), the others join on their
// phones by scanning or typing the code, everyone swipes yes / maybe / no on
// their own device at the same time, and the pick shows on the big screen
// with a short why. One press plays it; "Something else" shows the next.
//
// The server decides everything (src/lib/grouppick.js, src/routes/group.js);
// this page draws the session it is handed and sends what the person did.
// The live socket says "it changed" (group_update) and the page asks again; a
// slow poll stands in when the socket is down. The words are groupwords.js,
// shared to the letter with the TV and the phone app.
//
// A browser on a big screen can be the room's screen too ("Only show the
// code and the result here"): it then shows the code, how far everyone has
// got, and the pick — and plays it when someone presses Play on a phone.
//
// The look is Aurora Play ("Party night", docs/play/group.md): the room on
// the night sky, people as seats, the deck of js/play/deck.js, and the reveal
// as the one reward. Only the look and the motion live here; the rules, the
// words (groupwords.js) and the server's answers are as they were.
import { el, posterImg, artUrl, toast, haptic, debounce } from "../ui.js";
import { api } from "../api.js";
import { state } from "../state.js";
import { navigate, untilLeave } from "../router.js";
import { send, onMessage } from "../ws.js";
import { pushScope, popScope, currentScope } from "../focus.js";
import { uiHit } from "../telemetry.js"; // [analytics]
import { qrSvg } from "../qr.js";
import * as G from "../groupwords.js";
import { mountPlay, star } from "../play/stage.js";
import { pullOf, setPull, depthOf, slam, SLAM_MS } from "../play/deck.js";
import { pressable } from "../play/press.js";
import { meteorBurst } from "../play/burst.js";
import { tallyOf, isTie, tieJumps } from "../play/tally.js";

const W = G.WORDS;
// the words only this page says (the show around the result, the hand's count)
const SHOW = {
  votesIn: "The votes are in…",
  tie: "A tie — the stars decide",
  tieLine: "It was a tie — the stars decided",
  skip: "Skip",
  card: (n, of) => `Card ${n} of ${of}`,
};
const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const DEVICE_KEY = "aurora-group-device";
const deviceId = (() => {
  let id = null;
  try { id = localStorage.getItem(DEVICE_KEY); } catch {}
  if (!id || !/^[\w-]{6,40}$/.test(id)) {
    id = `web${Math.random().toString(36).slice(2, 12)}`;
    try { localStorage.setItem(DEVICE_KEY, id); } catch {}
  }
  return id;
})();
// a big, pointer-driven screen is likely the room's screen
const bigScreen = () => window.innerWidth >= 1200 && matchMedia("(hover: hover)").matches;

const DIST_X = 110;
const DIST_Y = 100;
const FLING = 0.55;
const VERDICT_GLYPH = { no: "✕", maybe: "?", yes: "✓" };
const VERDICT_UI = { yes: "group.yes", maybe: "group.maybe", no: "group.no" }; // the answers' data-ui ids (spelled out for the usage stats' list)

// ---------- small pieces ----------
const fk = (node, key) => { node.dataset.fk = key; return node; };
// the page's buttons are play buttons (the sheets over it keep the site's)
const KEY = "play-btn focusable"; // a quiet glass key
const KEY_GO = "play-btn play-btn--aurora focusable"; // the step forward
const KEY_WIN = "play-btn play-btn--gold focusable"; // the prize (Play on the result)
const TOOL = "pg-tool focusable"; // small tools: Undo, Add, Leave…
const btn = (attrs, label, onclick) => {
  const b = el("button", { class: KEY, ...attrs, onclick }, label);
  pressable(b);
  return b;
};
const avatarOf = (m) => m.avatarImage
  ? el("img", { class: "gp-avatar", src: m.avatarImage, alt: "" })
  : el("span", { class: "gp-avatar gp-avatar-emoji", "aria-hidden": "true" }, m.avatar || (m.name || "?").slice(0, 1).toUpperCase());
// A person in the room is a seat: the face, the name under it, what there is
// to say about them. `fresh` pops it in (someone just arrived); `ribbon` adds
// how far through the deck they are (while everyone swipes).
const seat = (m, { phase, deck = [] }, { fresh = false, i = 0, ribbon = false, had = null } = {}) => {
  const voting = ribbon && phase === "swiping" && m.role === "voter";
  const part = m.done ? 1 : deck.length ? Math.max(0, Math.min(1, (m.answered || 0) / deck.length)) : 0;
  // the ribbon glides from where it stood at the last paint (`had`: profile -> { part, done })
  const was = had && had.get(m.profileId);
  const fill = el("i", { style: `--p:${(was && voting ? was.part : part).toFixed(3)}` });
  // (it glides to where the person stands by then — a newer answer may have come in)
  if (voting && was && was.part !== part) requestAnimationFrame(() => requestAnimationFrame(() => {
    const now = had.get(m.profileId);
    fill.style.setProperty("--p", (now ? now.part : part).toFixed(3));
  }));
  const justDone = voting && m.done && !!was && !was.done;
  if (voting && had) had.set(m.profileId, { part, done: !!m.done });
  const count = voting && !m.done ? el("span", { class: "gp-badge dim" }, `${m.answered}/${deck.length}`) : null;
  const node = el("div", { class: `gp-person pg-seat${m.away ? " away" : ""}${m.done ? " done" : ""}${fresh ? " is-new" : ""}`, style: `--i:${i}` },
    el("span", { class: "pg-seat-face" },
      avatarOf(m),
      m.host ? el("span", { class: "pg-seat-star", "aria-hidden": "true" }, star()) : "",
      voting && m.done ? el("span", { class: `pg-seat-tick${justDone ? " is-new" : ""}`, "aria-hidden": "true" }, "✓") : ""),
    el("span", { class: "gp-person-name", dir: "auto" }, m.name),
    voting ? el("span", { class: "pg-seat-ribbon", "aria-hidden": "true" }, fill) : "",
    el("span", { class: "pg-seat-notes" },
      m.host && el("span", { class: "gp-badge" }, W.hostBadge),
      m.role === "screen" && el("span", { class: "gp-badge" }, W.screenBadge),
      m.away && el("span", { class: "gp-badge dim" }, W.awayBadge),
      voting && (m.done ? el("span", { class: "gp-badge ok" }, W.doneBadge) : count)));
  if (voting) { node._fill = fill; node._count = count; }
  return node;
};
// words that have not changed are left alone (the page is not measured again for them)
const setText = (n, t) => { if (n && n.textContent !== t) n.textContent = t; };
// One more answer from a seat that is already on the page: its ribbon moves
// on and its count changes — nothing is built again.
const moveSeat = (node, m, { deck = [] }, had) => {
  if (!node || !node._fill) return;
  const part = m.done ? 1 : deck.length ? Math.max(0, Math.min(1, (m.answered || 0) / deck.length)) : 0;
  const was = had && had.get(m.profileId);
  if (had) had.set(m.profileId, { part, done: !!m.done });
  if (!was || was.part !== part) node._fill.style.setProperty("--p", part.toFixed(3));
  setText(node._count, `${m.answered}/${deck.length}`);
};
// the tally of a pick as stars: gold for a yes, an outline for a maybe, a dot for the rest
const tallyRow = (pick) => {
  const marks = tallyOf(pick);
  if (!marks.length) return "";
  return el("div", { class: "pg-tally", "aria-hidden": "true" }, ...marks.map((kind, i) =>
    el("span", { class: `pg-tmark ${kind}`, style: `--i:${i}` }, kind === "no" ? "" : star())));
};

// The four little drawings of the first-time explanation. Calm line art in
// the page's own colours (currentColor + the accent).
const ART = {
  tv: `<svg viewBox="0 0 160 110" aria-hidden="true"><rect x="12" y="10" width="136" height="80" rx="10" fill="none" stroke="currentColor" stroke-width="3"/><rect x="60" y="94" width="40" height="6" rx="3" fill="currentColor" opacity=".5"/><text x="52" y="58" font-size="22" font-weight="800" fill="var(--accent)" letter-spacing="3" text-anchor="middle">AB2C</text><g fill="currentColor" opacity=".85"><rect x="100" y="30" width="30" height="30" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><rect x="105" y="35" width="8" height="8"/><rect x="117" y="35" width="8" height="8"/><rect x="105" y="47" width="8" height="8"/><rect x="118" y="48" width="4" height="4"/></g></svg>`,
  phones: `<svg viewBox="0 0 160 110" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="3"><rect x="30" y="14" width="44" height="82" rx="9"/><rect x="86" y="14" width="44" height="82" rx="9"/></g><rect x="38" y="26" width="28" height="40" rx="4" fill="var(--accent)" opacity=".75"/><rect x="94" y="26" width="28" height="40" rx="4" fill="var(--accent)" opacity=".75"/><g fill="currentColor" opacity=".6"><circle cx="52" cy="80" r="4"/><circle cx="108" cy="80" r="4"/></g></svg>`,
  swipe: `<svg viewBox="0 0 160 110" aria-hidden="true"><g transform="rotate(10 80 50)"><rect x="56" y="8" width="48" height="68" rx="7" fill="var(--accent)" opacity=".8"/></g><g font-size="16" font-weight="800" text-anchor="middle"><circle cx="44" cy="94" r="12" fill="none" stroke="#ff7b8a" stroke-width="2.5"/><text x="44" y="100" fill="#ff7b8a">✕</text><circle cx="80" cy="94" r="10" fill="none" stroke="currentColor" stroke-width="2.5"/><text x="80" y="99" fill="currentColor" font-size="13">?</text><circle cx="116" cy="94" r="12" fill="none" stroke="#6ee7a8" stroke-width="2.5"/><text x="116" y="100" fill="#6ee7a8">✓</text></g></svg>`,
  result: `<svg viewBox="0 0 160 110" aria-hidden="true"><rect x="12" y="10" width="136" height="80" rx="10" fill="none" stroke="currentColor" stroke-width="3"/><rect x="26" y="20" width="40" height="60" rx="5" fill="var(--accent)" opacity=".8"/><path d="M46 36l4 8 9 1-7 6 2 9-8-5-8 5 2-9-7-6 9-1z" fill="#fff"/><rect x="76" y="30" width="56" height="8" rx="4" fill="currentColor" opacity=".8"/><rect x="76" y="46" width="40" height="14" rx="7" fill="#6ee7a8" opacity=".85"/><rect x="76" y="66" width="30" height="8" rx="4" fill="currentColor" opacity=".4"/></svg>`,
};

// A sheet over the page (the site's look-notice pattern): focus stays in it,
// Back closes it.
const openSheet = (cls, label, children, { onClose } = {}) => {
  const box = el("div", { class: `look-notice sheet gp-sheet ${cls}`, role: "dialog", "aria-label": label }, ...children);
  const wrap = el("div", { class: "look-notice-wrap ui-overlay", onclick: (e) => e.target === wrap && close() }, box);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener("ui-back", onBack);
    popScope(wrap);
    wrap.classList.add("leaving");
    setTimeout(() => wrap.remove(), 220);
    if (onClose) onClose();
  };
  const onBack = (e) => { e.preventDefault(); close(); };
  document.addEventListener("ui-back", onBack);
  document.body.append(wrap);
  pushScope(wrap);
  untilLeave(close);
  return { box, close };
};

// ---------- the first-time explanation ----------
export const showTutorial = (pid, { onDone } = {}) => new Promise((resolve) => {
  let i = 0;
  const pic = el("div", { class: "gp-tut-art" });
  const title = el("h2", { class: "gp-tut-title" });
  const body = el("p", { class: "gp-tut-body" });
  const dots = el("div", { class: "gp-tut-dots", "aria-hidden": "true" }, ...G.TUTORIAL.map(() => el("span")));
  const step = el("div", { class: "gp-tut-step", "aria-live": "polite" }, pic, title, body);
  const nextBtn = el("button", { "data-ui": "group.tutorial.next", class: "btn btn-primary focusable", onclick: () => go(i + 1) }, W.next);
  const skipBtn = el("button", { "data-ui": "group.tutorial.skip", class: "btn focusable", onclick: () => finish() }, W.skip);
  const finish = () => {
    sheet.close();
  };
  const sheet = openSheet("gp-tutorial", W.howItWorks, [
    el("div", { class: "look-notice-title gp-tut-kicker" }, W.feature),
    step, dots,
    el("div", { class: "look-notice-actions" }, skipBtn, nextBtn),
  ], {
    onClose: () => {
      if (pid) api.group.tutorialSeen(pid).catch(() => {});
      if (onDone) onDone();
      resolve();
    },
  });
  const go = (n) => {
    if (n >= G.TUTORIAL.length) return finish();
    i = n;
    const t = G.TUTORIAL[i];
    step.classList.remove("in");
    pic.innerHTML = ART[t.art] || "";
    title.textContent = t.title;
    body.textContent = t.body;
    [...dots.children].forEach((d, k) => d.classList.toggle("on", k === i));
    nextBtn.textContent = i === G.TUTORIAL.length - 1 ? W.letsGo : W.next;
    skipBtn.classList.toggle("hidden", i === G.TUTORIAL.length - 1);
    if (!calm()) requestAnimationFrame(() => step.classList.add("in"));
    else step.classList.add("in");
  };
  go(0);
  setTimeout(() => nextBtn.focus({ preventScroll: true }), 40);
});

// ---------- following a session ----------
const followSession = (pid, code, onSession, onLost) => {
  let had = null;
  let at = Date.now();
  let stopped = false;
  let timer = null;
  let inFlight = false;
  let again = false;
  const take = (s) => {
    if (stopped || !G.newer(had, s)) return;
    had = s;
    at = Date.now();
    onSession(s);
  };
  const live = () => state.ws && state.ws.readyState === WebSocket.OPEN;
  const schedule = () => {
    clearTimeout(timer);
    if (stopped) return;
    const over = had && (had.phase === "ended" || had.phase === "chosen");
    timer = setTimeout(ask, over ? 30000 : live() ? 15000 : 4000);
  };
  const ask = async () => {
    if (stopped) return;
    if (inFlight) { again = true; return; }
    inFlight = true;
    try {
      const r = await api.group.get(pid, code, deviceId);
      take(r.session);
    } catch (e) {
      if (!stopped && (e.status === 404 || e.status === 403)) onLost(e);
    } finally {
      inFlight = false;
      if (again) { again = false; ask(); } else schedule();
    }
  };
  const watch = () => send({ type: "group_watch", code, device: deviceId, profileId: pid, token: state.token || undefined });
  const offs = [
    onMessage("group_update", (d) => { if (d.code === code && (!had || d.rev > had.rev)) ask(); }),
    onMessage("welcome", () => { watch(); ask(); }),
  ];
  const onVis = () => { if (document.visibilityState === "visible") ask(); };
  document.addEventListener("visibilitychange", onVis);
  watch();
  ask();
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    offs.forEach((off) => off());
    document.removeEventListener("visibilitychange", onVis);
    send({ type: "group_unwatch" });
  };
  untilLeave(stop);
  return { take, refresh: ask, stop, receivedAt: () => at, current: () => had };
};

// ---------- the page ----------
export const renderGroup = async (root, params = {}) => {
  const screen = el("div", { class: "screen gp page-pad pg-group" });
  root.append(screen);
  if (!state.profile) {
    screen.append(el("div", { class: "empty" }, el("div", { class: "glyph" }, "👤"), "Pick a profile first."));
    return;
  }
  const pid = state.profile.id;
  const body = el("div", { class: "gp-body" });
  screen.append(body);
  // the night sky behind the party; the page shows once its styles are in
  const play = mountPlay(screen, { seed: 47 });
  const timers = new Set(); // the page's own short waits (pops, the show): none outlives the screen
  const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };
  const never = (t) => { clearTimeout(t); timers.delete(t); };
  untilLeave(() => { play.destroy(); for (const t of timers) clearTimeout(t); timers.clear(); });
  // The room the page keeps under itself for a phone's tab bar is the
  // stylesheet's (#app's bottom padding). The swipe stage and the show stand
  // clear of the bar by that much; no height of the bar is written here.
  const app = document.getElementById("app");
  // (the window's size is read here and when it changes — never between two
  // changes to the page, where asking for it makes the page measure itself)
  let vw = window.innerWidth;
  let vh = window.innerHeight;
  const fit = () => {
    vw = window.innerWidth;
    vh = window.innerHeight;
    const pad = app ? parseFloat(getComputedStyle(app).paddingBottom) || 0 : 0;
    screen.style.setProperty("--pg-reserve", `${pad}px`);
  };
  fit();
  window.addEventListener("resize", fit);
  untilLeave(() => window.removeEventListener("resize", fit));
  // (a very wide screen draws the cards big: their pictures are asked for sharper)
  const wide = () => vw >= 1800 && vh >= 1000;
  let options = null;
  try { options = await api.group.options(pid); } catch {
    body.append(el("div", { class: "empty" }, "Couldn't reach Aurora — try again in a moment."));
    return;
  }
  const code = G.tidyCode(params.code || "");
  if (!options.tutorialSeen) await showTutorial(pid);
  await play.ready; // (the first paint takes the focus: it has to be on show)
  if (!screen.isConnected) return;
  if (code) return joinAndRun(code);
  paintChooser();

  // ---------- no session yet: join one, or start one here ----------
  function paintChooser(message = "") {
    delete screen.dataset.step;
    body.replaceChildren();
    const head = el("div", { class: "gp-head" },
      el("div", { class: "play-eyebrow" }, star(), W.entry),
      el("h1", { class: "play-h1" }, W.feature),
      el("p", { class: "gp-lead" }, W.entryLine),
      el("button", { "data-ui": "group.howto", class: "gp-link focusable", onclick: () => showTutorial(null) }, W.howItWorks));
    // join
    const input = el("input", {
      class: "focusable gp-code-input", type: "text", maxlength: "4", placeholder: "CODE",
      autocapitalize: "characters", autocomplete: "off", autocorrect: "off", spellcheck: "false", enterkeyhint: "go",
      "aria-label": W.codeLabel,
    });
    const err = el("div", { class: "pw-error gp-error hidden", role: "alert" });
    const fail = (m) => { err.textContent = m; err.classList.remove("hidden"); };
    const doJoin = () => {
      const c = G.tidyCode(input.value);
      if (!G.codeOk(c)) { input.focus(); return fail(W.codeWrong); }
      navigate(`#/group/${c}`);
    };
    const joinBtn = btn({ "data-ui": "group.join", class: KEY }, W.join, doJoin);
    input.addEventListener("input", () => {
      input.value = G.tidyCode(input.value);
      err.classList.add("hidden");
      joinBtn.classList.toggle("play-btn--aurora", G.codeOk(input.value)); // (four good letters: the key lights)
    });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") doJoin(); });
    const join = el("section", { class: "gp-panel gp-join" },
      el("h2", {}, W.joinCode),
      el("p", { class: "gp-dim" }, W.codeHelp),
      el("div", { class: "gp-code-row" }, input, joinBtn),
      err);
    // start
    const pick = { kind: "movie", mood: "any", length: "any", limitSec: (options.limits || [180])[1] || 180 };
    let asScreen = bigScreen();
    const chips = (label, list, key, fmt = (x) => x.label) => {
      const row = el("div", { class: "gp-chips", role: "radiogroup", "aria-label": label });
      const paint = () => {
        row.replaceChildren(...list.map((o) => {
          const v = o.id != null ? o.id : o;
          return el("button", {
            "data-ui": "group.option", class: `gp-chip pg-chip focusable${pick[key] === v ? " on" : ""}`, role: "radio",
            "aria-checked": String(pick[key] === v), "data-fk": `pick-${key}-${v}`,
            onclick: () => { pick[key] = v; paint(); row.querySelector(`[data-fk="pick-${key}-${v}"]`)?.focus({ preventScroll: true }); },
          }, fmt(o));
        }));
      };
      paint();
      return el("div", { class: "gp-field" }, el("div", { class: "gp-field-label" }, label), row);
    };
    const screenToggle = el("label", { class: "gp-toggle" },
      el("input", { type: "checkbox", "data-ui": "group.screen", class: "focusable", ...(asScreen ? { checked: "" } : {}), onchange: (e) => { asScreen = e.target.checked; } }),
      el("span", {}, W.justShow));
    let starting = false;
    const startBtn = btn({ "data-ui": "group.start", class: `${KEY_GO} gp-big` }, W.startHere, async () => {
      if (starting) return;
      starting = true;
      startBtn.disabled = true;
      try {
        const r = await api.group.create(pid, { settings: pick, device: deviceId, role: asScreen ? "screen" : "voter", app: "web" });
        history.replaceState(null, "", `#/group/${r.session.code}`);
        run(r.session);
      } catch (e) {
        toast(e.message || "Couldn't start it", "⚠️");
        starting = false;
        startBtn.disabled = false;
      }
    });
    const start = el("section", { class: "gp-panel gp-start" },
      el("h2", {}, W.startHere),
      chips(W.kind, options.kinds, "kind"),
      chips(W.mood, options.moods, "mood"),
      chips(W.length, options.lengths, "length"),
      chips(W.time, options.limits, "limitSec", (s) => G.limitLabel(s)),
      screenToggle,
      startBtn);
    body.append(head, message ? el("p", { class: "gp-note", role: "status" }, message) : "", el("div", { class: `gp-two${bigScreen() ? " start-first" : ""}` }, ...(bigScreen() ? [start, join] : [join, start])));
  }

  async function joinAndRun(c) {
    body.replaceChildren(el("div", { class: "gp-wait" }, el("div", { class: "pg-dots", role: "status", "aria-label": "Joining" }, star(), star(), star())));
    try {
      const r = await api.group.join(pid, { code: c, device: deviceId, role: "voter", app: "web" });
      run(r.session);
    } catch (e) {
      history.replaceState(null, "", "#/group");
      paintChooser(e.message || W.ended);
    }
  }

  // ---------- a session ----------
  function run(first) {
    const code = first.code;
    let s = first;
    let view = null; // { step, update(s) }
    let pressedPlay = false;
    let autoPlayed = false;
    // key -> the verdict this page sent that the server has not said back yet
    // (null: taken back with Undo). A copy of the session that left the server
    // before the vote — or the Undo — landed must not undo what was just done.
    const local = new Map();
    const answeredLocally = (x, key) => (local.has(key) ? local.get(key) != null : !!x.mine[key]);
    const answeredHere = []; // [{ key, verdict }] for Undo
    const act = async (what, extra = {}) => {
      try {
        const r = await api.group.act(pid, code, what, { device: deviceId, ...extra });
        if (r && r.session) follow.take(r.session);
        else follow.refresh();
        return r;
      } catch (e) {
        toast(e.message || "Couldn't do that", "⚠️");
        follow.refresh();
        return null;
      }
    };
    const follow = followSession(pid, code, (next) => { s = next; paint(); }, (e) => {
      s = { ...s, phase: "ended", ended: { reason: e.status === 404 ? W.ended : e.message || W.ended } };
      paint();
    });
    // the time left: its words, and the ribbon that drains (rose for the last 20 seconds)
    const paintTime = (within = screen) => {
      const since = Date.now() - follow.receivedAt();
      const words = G.timeLeft(s, since);
      for (const n of within.querySelectorAll(".gp-time")) setText(n, words);
      for (const n of within.querySelectorAll(".gp-timebar-fill")) {
        const total = (s.limitSec || 180) * 1000;
        const left = G.secondsLeft(s, since) * 1000;
        n.style.transform = `scaleX(${Math.max(0, Math.min(1, left / total))})`;
        n.parentNode.classList.toggle("is-low", left > 0 && left <= 20000);
      }
    };
    const tick = setInterval(() => {
      if (!screen.isConnected) return clearInterval(tick);
      paintTime();
    }, 1000);
    untilLeave(() => clearInterval(tick));

    const seen = new Set(); // who has had their seat's entrance (nobody pops in twice)
    const farAlong = new Map(); // profile -> how far their ribbon stood at the last paint
    let sawVote = false; // this page was there when the votes came in (the reveal is for it)
    let show = null; // the reveal's curtain, while it plays: { stop() }

    function paint() {
      const step = G.stepOf(withLocal(s));
      if (view && view.step === step && view.update) return view.update(s);
      const focusKey = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.fk : null;
      if (show) show.stop();
      sawVote = !!view && (view.step === "swipe" || view.step === "waiting");
      view = VIEWS[step]();
      screen.dataset.step = step; // (the sheet gives each step its room)
      body.replaceChildren(view.node);
      window.scrollTo(0, 0); // a new step starts at its top (the last one may have been scrolled)
      if (view.update) view.update(s);
      paintTime(body); // (the ribbon starts where the clock is, not full)
      const back = focusKey && body.querySelector(`[data-fk="${focusKey}"]`);
      const first = back || body.querySelector("[data-autofocus]") || null;
      if (first) first.focus({ preventScroll: true });
    }
    const withLocal = (x) => {
      if (!local.size) return x;
      const mine = { ...x.mine };
      for (const [k, v] of local) { if (v == null) delete mine[k]; else mine[k] = v; }
      return { ...x, mine };
    };
    const isScreen = () => s.you && s.you.role === "screen";
    const isHost = () => !!(s.you && s.you.host);

    // the code, big, with the QR code a phone camera reads
    const codeBlock = () => {
      const url = G.joinUrl(location.origin, code);
      const qr = el("div", { class: "gp-qr", "aria-label": `QR code for ${url}` });
      try { qr.innerHTML = qrSvg(url, { label: `Join ${code}` }); } catch {}
      return el("div", { class: "gp-codeblock" },
        el("div", { class: "gp-code-kicker" }, W.joinTitle),
        // (each letter on its own tile; read as one code)
        el("div", { class: "gp-code", role: "img", "aria-label": `Code ${code.split("").join(" ")}` }, ...code.split("").map((ch) => el("span", { class: "pg-tile" }, ch))),
        qr,
        el("p", { class: "gp-dim gp-code-line" }, W.joinLine),
        el("p", { class: "gp-host" }, G.hostOf(location.origin)));
    };

    const leaveRow = () => el("div", { class: "gp-leave-row" },
      fk(btn({ "data-ui": "group.leave", class: TOOL }, W.leave, async () => {
        await act("leave");
        navigate("#/group");
      }), "leave"),
      isHost() && fk(btn({ "data-ui": "group.end", class: `${TOOL} danger` }, W.endAll, async () => {
        await act("end");
      }), "end"),
      fk(el("button", { "data-ui": "group.howto", class: "gp-link focusable", onclick: () => showTutorial(null) }, W.howItWorks), "howto"));

    // "Add a title": a key in the lobby, a small tool while waiting, an icon beside the deck on a phone
    const addButton = (look = "key") => fk(btn({ "data-ui": "group.add", class: `${look === "key" ? KEY : TOOL} gp-add`, "aria-label": W.addTitle }, [el("span", { class: "pg-tool-glyph", "aria-hidden": "true" }, "＋"), el("span", { class: look === "icon" ? "gp-tool-label" : "" }, W.addTitle)], () => openSearch()), "add");

    // ---------- search inside the session ----------
    const openSearch = () => {
      const input = el("input", { class: "focusable gp-search-input", type: "search", placeholder: W.searchPlaceholder, autocomplete: "off", "aria-label": W.searchPlaceholder, enterkeyhint: "search" });
      const list = el("div", { class: "gp-results", role: "list" });
      let seq = 0;
      const look = debounce(async () => {
        const q = input.value.trim();
        const my = ++seq;
        if (!q) { list.replaceChildren(); return; }
        let r = null;
        try { r = await api.group.search(pid, code, q, deviceId); } catch { r = { results: [] }; }
        if (my !== seq) return;
        list.replaceChildren(...(r.results.length ? r.results.map(hit) : [el("p", { class: "gp-dim" }, "Nothing found")]));
      }, 220);
      const hit = (h) => {
        const state2 = el("span", { class: "gp-hit-state" }, h.inDeck ? W.inDeck : "＋");
        const b = el("button", { class: `gp-hit focusable${h.inDeck ? " in" : ""}`, role: "listitem", onclick: async () => {
          if (b.classList.contains("in")) return;
          b.classList.add("in");
          state2.textContent = "…";
          try {
            const r = await api.group.act(pid, code, "add", { device: deviceId, title: { id: h.id, imdbId: h.imdbId, type: h.type, title: h.title, year: h.year, poster: h.poster } });
            state2.textContent = r.already ? W.inDeck : W.added;
            haptic(10);
            follow.refresh();
          } catch (e) {
            b.classList.remove("in");
            state2.textContent = "＋";
            toast(e.message || "Couldn't add it", "⚠️");
          }
        } },
          posterImg(h.poster, h.title, "gp-hit-poster", "gp-hit-poster gp-hit-fallback", { w: 92 }),
          el("span", { class: "gp-hit-text" },
            el("span", { class: "gp-hit-title" }, h.title),
            el("span", { class: "gp-hit-meta" }, [h.year, h.type === "show" ? "Series" : "Film"].filter(Boolean).join(" · "), h.lib ? el("span", { class: "gp-badge ok" }, W.libBadge) : "")),
          state2);
        return b;
      };
      input.addEventListener("input", look);
      const sheet = openSheet("gp-search", W.addTitle, [
        el("div", { class: "look-notice-title" }, W.addTitle),
        el("p", { class: "look-notice-text" }, W.addLine),
        input, list,
        el("div", { class: "look-notice-actions" }, el("button", { class: "btn btn-primary focusable", onclick: () => sheet.close() }, "Done")),
      ]);
      setTimeout(() => input.focus({ preventScroll: true }), 40);
    };

    // ---------- the steps ----------
    const VIEWS = {
      lobby: () => {
        const node = el("div", { class: "gp-lobby is-fresh" }); // (fresh: the code's tiles drop in, once)
        later(() => node.classList.remove("is-fresh"), 1200);
        return {
          step: "lobby", node,
          update: (x) => {
            const host = isHost();
            const settings = el("div", { class: "gp-settings" });
            const set = (key, list, fmt = (o) => o.label) => {
              const row = el("div", { class: "gp-chips" }, ...list.map((o) => {
                const v = o.id != null ? o.id : o;
                const on = x.settings[key] === v;
                if (!host) return on ? el("span", { class: "gp-chip pg-chip on static" }, fmt(o)) : null;
                return fk(el("button", { "data-ui": "group.option", class: `gp-chip pg-chip focusable${on ? " on" : ""}`, onclick: () => act("settings", { settings: { [key]: v } }) }, fmt(o)), `set-${key}-${v}`);
              }).filter(Boolean));
              settings.append(el("div", { class: "gp-field" }, el("div", { class: "gp-field-label" }, ({ kind: W.kind, mood: W.mood, length: W.length, limitSec: W.time })[key]), row));
            };
            if (host) {
              set("kind", options.kinds);
              set("mood", options.moods);
              set("length", options.lengths);
              set("limitSec", options.limits, (o) => G.limitLabel(o));
            } else {
              const label = (list, v) => ((list || []).find((o) => o.id === v) || {}).label || "";
              settings.append(el("p", { class: "gp-dim gp-settings-line" }, [label(options.kinds, x.settings.kind), label(options.moods, x.settings.mood), label(options.lengths, x.settings.length), G.limitLabel(x.settings.limitSec)].filter(Boolean).join(" · ")));
            }
            const people = G.peopleOf(x);
            const voterHere = x.you && x.you.role === "voter";
            const dealBtn = host && fk(btn({ "data-ui": "group.deal", class: `${KEY_GO} gp-big`, ...(x.voters ? { "data-autofocus": "" } : { disabled: "" }) }, W.startSwiping, () => act("start")), "deal");
            // seats: whoever is new since the last paint pops in, one after the other
            let arriving = 0;
            const seats = people.map((m) => {
              const fresh = !seen.has(m.profileId);
              seen.add(m.profileId);
              return seat(m, x, { fresh, i: fresh ? arriving++ : 0 });
            });
            // (and a chair or two left free: there is room for more)
            for (let k = Math.max(0, Math.min(2, 5 - people.length)); k > 0; k--) seats.push(el("div", { class: "pg-seat pg-seat--free", "aria-hidden": "true" }, el("span", { class: "pg-seat-face" }, "+")));
            const side = el("div", { class: "gp-panel gp-room" },
              el("div", { class: "gp-joined", "aria-live": "polite" }, G.joinedLine(x)),
              el("div", { class: "gp-people pg-seats" }, ...seats),
              x.added.length ? el("div", { class: "gp-added" },
                el("div", { class: "gp-field-label" }, W.addedSoFar),
                ...x.added.map((a) => el("div", { class: "gp-added-item" }, el("span", {}, a.title), el("span", { class: "gp-dim" }, G.addedLine(a.by))))) : "",
              settings,
              // (a phone is a phone: only a big screen, or one that already is the screen, is offered the switch)
              bigScreen() || !voterHere ? el("label", { class: "gp-toggle" },
                fk(el("input", { type: "checkbox", "data-ui": "group.screen", class: "focusable", ...(voterHere ? {} : { checked: "" }), onchange: (e) => act("role", { role: e.target.checked ? "screen" : "voter" }) }), "screen"),
                el("span", {}, W.justShow)) : "",
              el("div", { class: "gp-actions" },
                addButton(),
                host ? dealBtn : el("p", { class: "gp-dim" }, W.onlyHost)),
              host && !x.voters ? el("p", { class: "gp-dim" }, W.needSomeone) : "",
              leaveRow());
            const focusKey = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.fk : null;
            const big = isScreen() || host;
            if (!big) side.prepend(el("div", { class: "gp-code-pill" }, `${W.joinTitle}: `, el("strong", {}, code)));
            node.replaceChildren(el("div", { class: `gp-lobby-grid${isScreen() ? " screen" : ""}${big ? "" : " compact"}` }, big ? codeBlock() : "", side));
            const back = focusKey && node.querySelector(`[data-fk="${focusKey}"]`);
            if (back) back.focus({ preventScroll: true });
          },
        };
      },

      swipe: () => swipeView(),

      waiting: () => {
        const node = el("div", { class: `gp-waiting${isScreen() ? " screen" : ""}` });
        // Every answer in the room arrives here. An answer changes a line of
        // words, one ribbon and one count, so only those are touched; the view
        // is built again only when who is here (or who is done) changes.
        let shape = "";
        let title = null;
        let progress = null;
        const seats = new Map(); // profile -> its seat on the page
        return {
          step: "waiting", node,
          update: (x) => {
            const host = isHost();
            const voters = G.peopleOf(x).filter((m) => m.role === "voter");
            const now = JSON.stringify([isScreen(), host, !!(x.you && x.you.role === "voter"), x.phase, (x.deck || []).length,
              voters.map((m) => [m.profileId, m.name, m.avatar, m.avatarImage, !!m.host, !!m.away, !!m.done])]);
            if (now === shape && node.firstChild) {
              setText(title, isScreen() ? G.progressLine(x) || W.waiting : W.doneWaiting);
              setText(progress, G.progressLine(x));
              for (const m of voters) moveSeat(seats.get(m.profileId), m, x, farAlong);
              paintTime(node);
              return;
            }
            shape = now;
            const focusKey = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.fk : null;
            title = el("h1", { class: "gp-wait-title play-h2" }, isScreen() ? G.progressLine(x) || W.waiting : W.doneWaiting);
            progress = !isScreen() ? el("div", { class: "gp-progress" }, G.progressLine(x)) : null;
            seats.clear();
            for (const m of voters) seats.set(m.profileId, seat(m, x, { ribbon: true, had: farAlong }));
            node.replaceChildren(
              el("div", { class: "gp-kicker play-eyebrow" }, star(), W.feature),
              title,
              el("div", { class: "gp-timebar", "aria-hidden": "true" }, el("span", { class: "gp-timebar-fill" })),
              el("div", { class: "gp-time", "aria-live": "off" }, G.timeLeft(x, Date.now() - follow.receivedAt())),
              progress || "",
              // the room's votes coming in: every seat with its own ribbon
              el("div", { class: "gp-people big pg-seats" }, ...voters.map((m) => seats.get(m.profileId))),
              host && el("div", { class: "gp-actions" },
                fk(btn({ "data-ui": "group.extend", class: KEY }, W.oneMore, () => act("extend")), "extend"),
                fk(btn({ "data-ui": "group.finish", class: KEY_GO, "data-autofocus": "" }, W.showNow, () => act("finish")), "finish")),
              isScreen() ? el("div", { class: "gp-code-small" }, `${W.joinTitle}: `, el("strong", {}, code), ` · ${G.hostOf(location.origin)}`) : "",
              x.you && x.you.role === "voter" ? el("div", { class: "gp-actions" }, addButton("tool")) : "",
              leaveRow());
            paintTime(node);
            const back = focusKey && node.querySelector(`[data-fk="${focusKey}"]`);
            if (back) back.focus({ preventScroll: true });
          },
        };
      },

      result: () => {
        const node = el("div", { class: `gp-result pg-prize${isScreen() ? " screen" : ""}` });
        const reveal = sawVote && !calm(); // this page watched the votes come in: it gets the show
        let drawn = ""; // what is on the page (an update that changes nothing leaves it be)
        let lastKey = null;
        let shown = false;
        return {
          step: "result", node,
          update: (x) => {
            const pick = G.currentPick(x);
            const host = isHost();
            const r = x.result;
            const sig = JSON.stringify([pick ? pick.key : null, r ? r.index : 0, r && r.picks ? r.picks.length : 0, pick ? pick.why : "", G.playLabel(x), host, isScreen()]);
            if (sig === drawn) return;
            drawn = sig;
            const focusKey = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.fk : null;
            if (!pick) {
              node.replaceChildren(el("div", { class: "gp-nomatch" },
                el("div", { class: "gp-kicker play-eyebrow" }, star(), W.feature),
                el("h1", { class: "play-h2" }, W.noMatch),
                el("p", { class: "gp-lead" }, W.noMatchLine),
                el("div", { class: "gp-actions" },
                  host ? fk(btn({ "data-ui": "group.again", class: `${KEY_GO} gp-big`, "data-autofocus": "" }, W.again, () => act("again")), "again") : el("p", { class: "gp-dim" }, W.onlyHost)),
                leaveRow()));
            } else {
              const c = pick.card;
              const flip = lastKey != null && lastKey !== pick.key; // "Something else": the card turns over, no ceremony
              lastKey = pick.key;
              node.replaceChildren(
                el("div", { class: `gp-result-card${flip ? " is-flip" : ""}` },
                  el("div", { class: "pg-prize-poster" }, posterImg(c.poster, c.title, "gp-result-poster", "gp-result-poster gp-poster-fallback", { w: wide() ? 780 : 480, eager: true })),
                  el("div", { class: "gp-result-info" },
                    el("div", { class: "gp-kicker pg-prize-kicker" }, star(), el("span", {}, W.resultTitle, r.picks.length > 1 ? el("span", { class: "gp-dim" }, ` · ${r.index + 1} / ${r.picks.length}`) : "")),
                    el("h1", { class: "gp-result-title", dir: "auto" }, c.title),
                    el("div", { class: "gp-meta" }, G.cardMeta(c), c.lib ? el("span", { class: "gp-badge ok" }, W.libBadge) : ""),
                    el("div", { class: "pg-votes" },
                      tallyRow(pick),
                      el("div", { class: "gp-why" }, el("span", { "aria-hidden": "true" }, "✓ "), pick.why)),
                    r.index === 0 && isTie(r) ? el("p", { class: "pg-tie-line" }, SHOW.tieLine) : "",
                    c.line ? el("p", { class: "gp-line", dir: "auto" }, c.line) : "",
                    c.seenBy && c.seenBy.length ? el("p", { class: "gp-dim" }, G.seenLine(c.seenBy)) : "",
                    el("div", { class: "gp-actions" },
                      fk(btn({ "data-ui": "group.play", class: `${KEY_WIN} gp-big`, "data-autofocus": "" }, `▶ ${G.playLabel(x)}`, async () => {
                        pressedPlay = true;
                        await act("choose", { key: pick.key });
                      }), "play"),
                      fk(btn({ "data-ui": "group.next", class: KEY }, G.hasNextPick(x) ? W.somethingElse : r.picks.length > 1 ? W.firstPick : W.somethingElse, () => {
                        if (G.hasNextPick(x)) act("pick", { index: r.index + 1 });
                        else if (r.picks.length > 1) act("pick", { index: 0 });
                        else if (host) act("again");
                        else toast("That was the only one everybody could agree on", "🎬");
                      }), "next"),
                      host && fk(btn({ "data-ui": "group.again", class: KEY }, W.again, () => act("again")), "again")),
                    leaveRow())));
              if (reveal && !shown && r.index === 0) {
                shown = true;
                startShow(node, x);
                return;
              }
            }
            const back = focusKey && node.querySelector(`[data-fk="${focusKey}"]`);
            if (back) back.focus({ preventScroll: true });
          },
        };
      },

      chosen: () => {
        const node = el("div", { class: "gp-chosen" });
        return {
          step: "chosen", node,
          update: (x) => {
            const ch = x.chosen;
            const c = ch && ch.card;
            const here = c && G.playsHere(x, pressedPlay);
            const scr = G.screenOf(x);
            node.replaceChildren(
              el("div", { class: "gp-kicker pg-prize-kicker" }, star(), W.resultTitle),
              el("h1", { class: "play-h1" }, W.enjoy),
              c ? el("p", { class: "gp-lead pg-chosen-title", dir: "auto" }, c.title) : "",
              ch ? el("p", { class: "gp-dim" }, `${ch.by} ${W.pressedPlay}`) : "",
              !here && scr ? el("p", { class: "gp-dim" }, scr.app === "tv" ? W.startingOnTv : W.startingOnScreen) : "",
              el("div", { class: "gp-actions" }, btn({ class: KEY_GO, "data-autofocus": "" }, "Done", () => navigate("#/"))));
            if (here && !autoPlayed) {
              autoPlayed = true;
              setTimeout(() => playCard(c), 600);
            }
          },
        };
      },

      ended: () => {
        const node = el("div", { class: "gp-ended" });
        return {
          step: "ended", node,
          update: (x) => node.replaceChildren(
            el("h1", { class: "play-h2" }, W.ended),
            el("p", { class: "gp-lead" }, (x.ended && x.ended.reason) || ""),
            el("div", { class: "gp-actions" },
              btn({ class: KEY_GO, "data-autofocus": "" }, W.startHere, () => { history.replaceState(null, "", "#/group"); follow.stop(); paintChooser(); }),
              btn({ class: KEY }, "Home", () => navigate("#/")))),
        };
      },
    };

    // ---------- the reveal ----------
    // The result is on the page already (and stays as it is); for a page that
    // watched the votes come in, a curtain plays over it first: "The votes are
    // in…", a tie-break when the first two were level, then the curtain lifts
    // as the poster drops and the one meteor burst goes off. Any press skips
    // it. The order the server sent is the result — the show only tells it.
    const startShow = (node, x) => {
      const r = x.result;
      const tie = isTie(r) && !!r.picks[1].card;
      const swap = tie && (Number(r.at) || 0) % 2 === 1; // (the winner is not always on the same side)
      const pair = tie ? (swap ? [r.picks[1], r.picks[0]] : [r.picks[0], r.picks[1]]) : [];
      const winner = swap ? 1 : 0;
      const words = el("p", { class: "pg-show-words", role: "status" }, SHOW.votesIn);
      const duelCards = pair.map((p) => el("div", { class: "pg-duel-card" }, posterImg(p.card.poster, p.card.title, "pg-duel-poster", "pg-duel-poster gp-poster-fallback", { w: 360, eager: true })));
      const skip = el("button", { class: "pg-show-skip focusable", onclick: (e) => { e.stopPropagation(); end(false); } }, SHOW.skip);
      const curtain = el("div", { class: "pg-show", "data-beat": "votes", onclick: () => end(false) },
        el("div", { class: "pg-show-in" },
          words,
          el("div", { class: "pg-show-stars", "aria-hidden": "true" }, star(), star(), star()),
          tie ? el("div", { class: "pg-duel", "aria-hidden": "true" }, ...duelCards) : ""),
        skip);
      const waits = [];
      const at = (ms, fn) => waits.push(later(fn, ms));
      let over = false;
      function end(lifted) {
        if (over) return;
        over = true;
        waits.forEach(never);
        document.removeEventListener("ui-back", onBack);
        show = null;
        node.inert = false;
        node.classList.remove("is-curtained");
        curtain.classList.add("is-leaving");
        later(() => curtain.remove(), lifted ? 340 : 180);
        const first = node.querySelector("[data-autofocus]");
        if (first && node.isConnected && currentScope().contains(node)) first.focus({ preventScroll: true });
      }
      const onBack = (e) => { e.preventDefault(); end(false); };
      document.addEventListener("ui-back", onBack);
      untilLeave(() => document.removeEventListener("ui-back", onBack));
      node.inert = true; // (nothing under the curtain can be pressed or read out early)
      node.classList.add("is-curtained"); // (…or seen: the sky stays, the result waits)
      body.append(curtain);
      skip.focus({ preventScroll: true });
      show = { stop: () => end(false) };
      let t = 1500;
      if (tie) {
        const jumps = tieJumps(winner);
        at(t, () => { curtain.dataset.beat = "tie"; words.textContent = SHOW.tie; });
        for (const j of jumps) at(t + 460 + j.at, () => { duelCards.forEach((d, k) => d.classList.toggle("lit", k === j.i)); haptic(4); });
        const landed = t + 460 + jumps[jumps.length - 1].at;
        at(landed + 140, () => duelCards[winner].classList.add("won"));
        t = landed + 820;
      }
      at(t, () => {
        end(true);
        node.classList.add("is-reveal");
        later(() => node.classList.remove("is-reveal"), 2400);
        later(() => {
          const target = node.querySelector(".pg-prize-poster");
          if (!target || !target.isConnected) return;
          const a = target.getBoundingClientRect();
          const b = screen.getBoundingClientRect();
          haptic(18);
          meteorBurst(screen, { x: (a.left + a.width / 2 - b.left) / (b.width || 1), y: (a.top + a.height / 2 - b.top) / (b.height || 1), count: 46, seed: (Number(r.at) || 1) % 9973 });
        }, 440);
      });
    };

    // ---------- swiping ----------
    function swipeView() {
      const node = el("div", { class: "gp-swipe" });
      const time = el("span", { class: "gp-time" });
      const progress = el("span", { class: "gp-progress" });
      const undoBtn = fk(btn({ "data-ui": "group.undo", class: TOOL, disabled: "", "aria-label": W.undo }, [el("span", { class: "pg-tool-glyph", "aria-hidden": "true" }, "↶"), el("span", { class: "gp-tool-label" }, W.undo)], () => undo()), "undo");
      // which card of the hand this is (the count is of this person's own hand)
      const hand = el("div", { class: "pg-hand" });
      const head = el("div", { class: "gp-swipe-head" },
        el("div", { class: "gp-swipe-titles" }, el("div", { class: "gp-kicker play-eyebrow" }, star(), W.feature), hand, el("div", { class: "gp-swipe-sub" }, time, " · ", progress)),
        el("div", { class: "gp-swipe-tools" }, undoBtn, addButton("icon")));
      // the clock as a ribbon, and beside it the room: who is still at it, who is done
      const minis = el("div", { class: "pg-minis", "aria-hidden": "true" });
      const bar = el("div", { class: "pg-timerow" }, el("div", { class: "gp-timebar", "aria-hidden": "true" }, el("span", { class: "gp-timebar-fill" })), minis);
      const deck = el("div", { class: "ts-deck gp-deck pg-deck" },
        el("i", { class: "pg-ghost pg-ghost--2", "aria-hidden": "true" }),
        el("i", { class: "pg-ghost pg-ghost--1", "aria-hidden": "true" }));
      const stage = el("div", { class: "ts-stage gp-stage" }, deck);
      const answerBtn = (verdict) => {
        const b = el("button", {
          "data-ui": VERDICT_UI[verdict], class: `ts-answer gp-answer pg-key ${verdict} focusable`, "aria-label": W[verdict],
          onclick: () => answer(verdict),
        }, el("span", { class: "ts-answer-glyph", "aria-hidden": "true" }, VERDICT_GLYPH[verdict]), el("span", { class: "ts-answer-label" }, W[verdict]));
        pressable(b, { tick: false }); // (the answer has its own tick)
        return b;
      };
      const answers = el("div", { class: "ts-answers gp-answers" }, answerBtn("no"), answerBtn("maybe"), answerBtn("yes"));
      const hint = el("p", { class: "ts-hint" }, "← No · → Yes · ↓ Maybe · Z undo");
      node.append(head, bar, stage, answers, hint);
      let minisAre = null; // (drawn again only when a face, or its state, changes)
      const paintMinis = (x) => {
        const people = G.peopleOf(x).filter((m) => m.role === "voter").slice(0, 8);
        const are = people.map((m) => [m.profileId, m.done ? 1 : 0, m.away ? 1 : 0, m.avatarImage || m.avatar || m.name || ""].join("|")).join("\n");
        if (are === minisAre) return;
        minisAre = are;
        minis.replaceChildren(...people.map((m) => el("span", { class: `pg-mini${m.done ? " done" : ""}${m.away ? " away" : ""}` }, avatarOf(m))));
      };

      let queue = [];
      const nodes = new Map();
      const known = new Set();
      const takeDeck = (x) => {
        for (const c of x.deck) {
          if (known.has(c.key)) continue;
          known.add(c.key);
          if (!answeredLocally(x, c.key)) queue.push(c);
        }
        // a card answered elsewhere (this person's other device) leaves the queue
        queue = queue.filter((c) => !answeredLocally(x, c.key));
      };
      const makeCard = (c) => {
        const meta = G.cardMeta(c);
        const notes = [G.addedLine(c.addedBy), G.seenLine(c.seenBy)].filter(Boolean).join(" · ");
        const n = el("div", { class: "ts-card gp-card", tabindex: "-1", role: "group", "aria-label": `${c.title}${c.year ? ` (${c.year})` : ""}` },
          posterImg(c.poster, c.title, "ts-poster", "ts-poster-fallback", { w: wide() ? 620 : 360, eager: true }),
          el("span", { class: "ts-stamp love", "aria-hidden": "true" }, W.yes.toUpperCase()),
          el("span", { class: "ts-stamp nope", "aria-hidden": "true" }, W.no.toUpperCase()),
          el("span", { class: "ts-stamp skip", "aria-hidden": "true" }, W.maybe.toUpperCase()),
          c.lib ? el("span", { class: "gp-card-badge" }, W.libBadge) : "",
          el("div", { class: "ts-info" },
            el("div", { class: "ts-title" }, c.title),
            meta && el("div", { class: "ts-meta" }, meta),
            c.line && el("div", { class: "ts-line" }, c.line),
            notes && el("div", { class: "gp-card-note" }, notes)));
        return n;
      };
      let total = 0; // the hand: every card of the deck this person has to answer
      const warmed = new Set(); // the cards whose picture was asked for ahead of their turn
      const paintDeck = () => {
        const none = !answeredHere.length;
        if (undoBtn.disabled !== none) undoBtn.disabled = none;
        setText(hand, queue.length ? SHOW.card(Math.max(1, Math.min(total, total - queue.length + 1)), total) : "");
        const depth = String(depthOf(queue.length));
        if (deck.dataset.depth !== depth) deck.dataset.depth = depth;
        const want = queue.slice(0, 2);
        for (const [k, n] of nodes) if (!want.some((c) => c.key === k) && !n.classList.contains("leaving")) { n.remove(); nodes.delete(k); }
        want.forEach((c, i) => {
          let n = nodes.get(c.key);
          if (!n) {
            n = makeCard(c);
            n.classList.add(i === 0 ? "top" : "behind", "entering");
            nodes.set(c.key, n);
            deck.append(n);
            requestAnimationFrame(() => requestAnimationFrame(() => n.classList.remove("entering")));
          }
          n.classList.toggle("top", i === 0);
          n.classList.toggle("behind", i === 1);
          if (i === 0) { n.tabIndex = 0; n.classList.add("focusable"); bindDrag(n, c); } else { n.tabIndex = -1; n.classList.remove("focusable"); }
        });
        for (const c of queue.slice(0, 4)) {
          if (!c.poster || warmed.has(c.key)) continue;
          warmed.add(c.key);
          try { new Image().src = artUrl(c.poster, wide() ? 620 : 360); } catch {}
        }
        const top = want.length ? nodes.get(want[0].key) : null;
        const at = document.activeElement;
        const onDeck = !at || at === document.body || node.contains(at);
        if (top && at !== top && onDeck && !(at && at.closest && at.closest(".gp-swipe-tools"))) top.focus({ preventScroll: true });
      };
      const fly = (n, verdict, from) => {
        n.classList.remove("top", "behind", "focusable");
        n.classList.add("leaving");
        n.tabIndex = -1;
        const w = Math.max(vw, 600);
        if (calm()) { n.style.transition = "opacity 140ms linear"; n.style.opacity = "0"; }
        else {
          const dx = from ? from.dx : 0;
          const dy = from ? from.dy : 0;
          const to = verdict === "yes" ? `translate(${w}px, ${dy * 1.5}px) rotate(24deg)`
            : verdict === "no" ? `translate(${-w}px, ${dy * 1.5}px) rotate(-24deg)`
            : `translate(${dx * 1.5}px, ${Math.max(vh, 700)}px) rotate(${dx * 0.03}deg)`;
          const stamp = n.querySelector(`.ts-stamp.${verdict === "yes" ? "love" : verdict === "no" ? "nope" : "skip"}`);
          const go = () => {
            n.style.transition = "transform 300ms cubic-bezier(.2,.7,.3,1), opacity 300ms ease-in";
            n.style.transform = to;
            n.style.opacity = "0";
          };
          if (!from) {
            // a button or a key: no drag showed the answer, so the stamp is slammed
            // on, the card takes the hit, and then it is thrown
            slam(n, stamp, verdict === "yes" ? { x: 14, y: -4, r: 3 } : verdict === "no" ? { x: -14, y: -4, r: -3 } : { y: 12 });
            setTimeout(go, SLAM_MS);
            setTimeout(() => n.remove(), SLAM_MS + 320);
            return;
          }
          stamp?.style.setProperty("opacity", "1");
          go();
        }
        setTimeout(() => n.remove(), calm() ? 160 : 320);
      };
      // the key that matches the answer lights for a moment (arrows teach the buttons)
      const flashKey = (verdict) => {
        const k = answers.querySelector(`.ts-answer.${verdict}`);
        if (!k || calm()) return;
        k.classList.add("is-hit");
        later(() => k.classList.remove("is-hit"), 260);
      };
      let chain = Promise.resolve();
      const answer = (verdict, from = null) => {
        const c = queue[0];
        if (!c) return;
        queue.shift();
        local.set(c.key, verdict);
        answeredHere.push({ key: c.key, card: c, verdict });
        const n = nodes.get(c.key);
        nodes.delete(c.key);
        setPull(deck, 0);
        if (n) fly(n, verdict, from);
        haptic(10);
        flashKey(verdict);
        paintDeck();
        chain = chain.then(async () => {
          try {
            await api.group.act(pid, code, "vote", { device: deviceId, key: c.key, verdict });
          } catch (e) {
            // not taken: the card comes back
            local.delete(c.key);
            const i = answeredHere.findIndex((a) => a.key === c.key);
            if (i >= 0) answeredHere.splice(i, 1);
            if (e.status !== 409) { queue.unshift(c); paintDeck(); }
            toast(e.message || "Couldn't save that answer", "⚠️");
          }
          follow.refresh();
        });
        if (!queue.length) setTimeout(() => paint(), from || calm() ? 340 : SLAM_MS + 340); // (the last card is seen leaving)
      };
      const undo = () => {
        const last = answeredHere.pop();
        if (!last) return;
        local.set(last.key, null);
        queue.unshift(last.card);
        chain = chain.then(() => api.group.act(pid, code, "vote", { device: deviceId, key: last.key, verdict: null }).catch(() => {})).then(() => follow.refresh());
        if (view && view.step !== "swipe") paint();
        else paintDeck();
      };
      const bindDrag = (n, card) => {
        if (n._drag) return;
        n._drag = true;
        let start = null;
        let samples = [];
        const stamp = (cls, v) => { const st = n.querySelector(`.ts-stamp.${cls}`); if (st) st.style.opacity = String(Math.max(0, Math.min(1, v))); };
        n.addEventListener("pointerdown", (e) => {
          if (queue[0] !== card || e.button > 0) return;
          start = { x: e.clientX, y: e.clientY, id: e.pointerId };
          samples = [{ x: e.clientX, y: e.clientY, t: performance.now() }];
          try { n.setPointerCapture(e.pointerId); } catch {}
          n.classList.add("dragging");
          n.style.transition = "none";
        });
        n.addEventListener("pointermove", (e) => {
          if (!start || e.pointerId !== start.id) return;
          const dx = e.clientX - start.x;
          const dy = e.clientY - start.y;
          samples.push({ x: e.clientX, y: e.clientY, t: performance.now() });
          if (samples.length > 6) samples.shift();
          n.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx * 0.05}deg)`;
          stamp("love", dx / DIST_X);
          stamp("nope", -dx / DIST_X);
          stamp("skip", Math.abs(dx) < 60 ? dy / DIST_Y : 0);
          setPull(deck, pullOf(dx, Math.max(0, dy), DIST_X, DIST_Y)); // the next card rises to meet the drag
        });
        const end = (e) => {
          if (!start || e.pointerId !== start.id) return;
          const dx = e.clientX - start.x;
          const dy = e.clientY - start.y;
          start = null;
          n.classList.remove("dragging");
          const a = samples[0];
          const b = samples[samples.length - 1];
          const dt = Math.max(1, b.t - a.t);
          const vx = (b.x - a.x) / dt;
          const vy = (b.y - a.y) / dt;
          let verdict = null;
          if (e.type !== "pointercancel") {
            if ((dx > DIST_X || (vx > FLING && dx > 30)) && Math.abs(dx) >= Math.abs(dy) * 0.6) verdict = "yes";
            else if ((dx < -DIST_X || (vx < -FLING && dx < -30)) && Math.abs(dx) >= Math.abs(dy) * 0.6) verdict = "no";
            else if ((dy > DIST_Y || (vy > FLING && dy > 30)) && Math.abs(dy) > Math.abs(dx)) verdict = "maybe";
          }
          if (verdict) { uiHit(VERDICT_UI[verdict]); answer(verdict, { dx, dy }); return; } // [analytics]
          setPull(deck, 0);
          n.style.transition = calm() ? "none" : "transform 260ms cubic-bezier(.2,.9,.3,1.2)";
          n.style.transform = "";
          for (const st of n.querySelectorAll(".ts-stamp")) st.style.opacity = "";
        };
        n.addEventListener("pointerup", end);
        n.addEventListener("pointercancel", end);
        n.addEventListener("keydown", (e) => { if (e.key === "Enter" && queue[0] === card) { e.preventDefault(); uiHit("group.yes"); answer("yes"); } });
      };
      const onKey = (e) => {
        if (!node.isConnected || !currentScope().contains(node)) return;
        const t = e.target;
        if (t && (t.closest?.("input, textarea, [contenteditable]") || t.closest?.(".gp-swipe-tools") || t.closest?.("#nav, nav, .nav"))) return;
        let verdict = null;
        if (e.key === "ArrowRight") verdict = "yes";
        else if (e.key === "ArrowLeft") verdict = "no";
        else if (e.key === "ArrowDown") verdict = "maybe";
        else if ((e.key === "z" || e.key === "Z") && !e.altKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); e.stopPropagation(); undo(); return; }
        if (!verdict || !queue.length) return;
        e.preventDefault();
        e.stopPropagation();
        uiHit(VERDICT_UI[verdict]); // [analytics]
        answer(verdict);
      };
      window.addEventListener("keydown", onKey, true);
      untilLeave(() => window.removeEventListener("keydown", onKey, true));
      return {
        step: "swipe", node,
        update: (x) => {
          // the server's echo of our own answers: no longer only local
          for (const [k, v] of [...local]) if (v == null ? !x.mine[k] : x.mine[k] === v) local.delete(k);
          takeDeck(x);
          total = x.deck.length;
          setText(time, G.timeLeft(x, Date.now() - follow.receivedAt()));
          setText(progress, G.progressLine(x));
          paintMinis(x);
          paintDeck();
          if (!queue.length && ![...local.values()].some((v) => v == null)) setTimeout(() => paint(), 0);
        },
      };
    }

    // ---------- playing the pick ----------
    const playCard = (c) => {
      if (!c) return;
      if (c.id && c.type === "movie") return navigate(`#/play/${encodeURIComponent(c.id)}`);
      if (c.id) return navigate(`#/show/${encodeURIComponent(c.id)}`);
      if (c.imdbId) return navigate(`#/discover/${c.type === "show" ? "series" : "movie"}/${encodeURIComponent(c.imdbId)}`);
    };

    follow.take(first); // (the first paint: everything above is in place now)
  }
};

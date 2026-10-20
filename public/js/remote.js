// "Your TVs": the phone as a remote, Play on TV — and this browser as a
// device other devices can play on ("Play on this computer").
//
// The protocol is the server's (src/lib/devices.js has it in full). This file
// is both sides of it for the website:
//
//   CONTROLLER — every signed-in tab subscribes, so it knows whether a TV is
//     on: the "Play on TV" buttons and the Remote entries appear only then.
//     The remote screen (screens/remote.js) WATCHES one device: the server then
//     sends its position every second.
//   TARGET — a computer or a tablet (not a phone: a phone is the remote)
//     announces itself, unless "Let my other devices play here" is off
//     (Preferences, this device only). Commands drive the player through the
//     controller the player registers while it is up (registerPlayerTarget —
//     screens/player.js, the [phone-remote] block); arrows, OK and Back go
//     through the same keyboard path as a real keyboard or TV remote
//     (focus.js), so they move exactly what a key would.
import { state } from "./state.js";
import { send, onMessage } from "./ws.js";
import { el, toast } from "./ui.js";
import { navigate } from "./router.js";

// ---------------------------------------------------------------- this device
const KEY_ID = "aurora-device-id";
const KEY_NAME = "aurora-device-name";
const KEY_TARGET = "aurora-device-target"; // "0": this device is not offered to the others

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch {} },
};
let memId = null;
export const deviceId = () => {
  let id = store.get(KEY_ID);
  if (!id || !/^[A-Za-z0-9_-]{8,48}$/.test(id)) {
    const rnd = (crypto && crypto.getRandomValues) ? [...crypto.getRandomValues(new Uint8Array(9))].map((b) => b.toString(16).padStart(2, "0")).join("") : Math.random().toString(16).slice(2, 20);
    id = memId || `web-${rnd}`;
    memId = id;
    store.set(KEY_ID, id);
  }
  return id;
};

const ua = () => (typeof navigator !== "undefined" ? navigator.userAgent || "" : "");
// What this device is, in the word the TV shows ("Controlled from Elia's iPad").
export const deviceWord = () => {
  const u = ua();
  if (/iPhone|iPod/.test(u)) return "iPhone";
  if (/iPad/.test(u) || (/Macintosh/.test(u) && navigator.maxTouchPoints > 1)) return "iPad";
  if (/Android/.test(u)) return /Mobile/.test(u) ? "Android phone" : "Android tablet";
  // (a touch screen this small is a phone, whatever its browser says it is)
  const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  if (coarse && Math.min(screen.width || 1024, screen.height || 768) < 600) return "phone";
  if (/CrOS/.test(u)) return "Chromebook";
  if (/Mac/.test(u)) return "Mac";
  if (/Windows/.test(u)) return "PC";
  return "computer";
};
// phone / tablet / computer: a phone is a remote, the others can be played on
export const formOf = () => {
  const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  const short = Math.min(screen.width || 1024, screen.height || 768);
  const w = deviceWord();
  if (w === "iPhone" || w === "Android phone" || w === "phone" || (coarse && short < 600)) return "phone";
  if (w === "iPad" || w === "Android tablet" || coarse) return "tablet";
  return "computer";
};
const browserName = () => {
  const u = ua();
  return /Edg\//.test(u) ? "Edge" : /Firefox\//.test(u) ? "Firefox" : /Chrome\//.test(u) ? "Chrome" : /Safari\//.test(u) ? "Safari" : "Browser";
};
export const defaultDeviceName = () => {
  const w = deviceWord();
  return w === "iPad" || w === "Android tablet" ? w : `${browserName()} on ${w === "computer" ? "this computer" : w}`;
};
export const deviceName = () => (store.get(KEY_NAME) || "").trim() || defaultDeviceName();
export const setDeviceName = (name) => {
  const v = String(name || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 40);
  store.set(KEY_NAME, v || null);
  announce();
  return deviceName();
};
export const targetAllowed = () => formOf() !== "phone";
export const targetEnabled = () => targetAllowed() && store.get(KEY_TARGET) !== "0";
export const setTargetEnabled = (on) => {
  store.set(KEY_TARGET, on ? null : "0");
  announce();
};

// ---------------------------------------------------------------- the CONTROLLER side
let devices = [];
let household = false;
let listError = null;
let heard = false; // a list has come at least once since this socket opened
let watchId = null;
const listSubs = new Set();
const stateSubs = new Set();
const emitList = () => { for (const fn of [...listSubs]) { try { fn(devices); } catch {} } };

export const getDevices = () => devices;
export const devicesHeard = () => heard;
export const householdOn = () => household;
export const listProblem = () => listError;
/** fn(devices) on every change of the list; returns the unsubscribe */
export const onDevices = (fn) => { listSubs.add(fn); return () => listSubs.delete(fn); };
/** fn(deviceId, state) on every state the server passes on */
export const onDeviceState = (fn) => { stateSubs.add(fn); return () => stateSubs.delete(fn); };
export const findDevice = (id) => devices.find((d) => d.deviceId === id) || null;

const socketOpen = () => !!(state.ws && state.ws.readyState === WebSocket.OPEN);
let subscribedAs = null;
const subscribe = () => {
  if (!socketOpen()) return;
  if (!state.profile) {
    // signed out / no profile: this tab is nobody's remote any more
    if (subscribedAs) send({ type: "remote_unsubscribe" });
    subscribedAs = null;
    devices = [];
    emitList();
    return;
  }
  subscribedAs = state.profile.id;
  send({
    type: "remote_subscribe",
    profileId: state.profile.id,
    token: state.token || undefined,
    watch: watchId,
    ownDeviceId: announced ? deviceId() : null,
    // this browser's own id, also on a phone that is only a remote: the TV
    // says "Controlled from …" once per remote, and two iPhones of one
    // person carry the same words (Mi TV pass 2026-10-20)
    remoteId: deviceId(),
    label: deviceWord(),
  });
};
/** The remote screen looks at this device (null: at none) — ticks every second. */
export const watchDevice = (id) => {
  if (watchId === id) return;
  watchId = id || null;
  subscribe();
};

onMessage("remote_devices", (d) => {
  heard = true;
  listError = d.error || null;
  household = !!d.household;
  const at = performance.now();
  const serverNow = Number(d.now) || Date.now();
  devices = (Array.isArray(d.devices) ? d.devices : []).map((x) => ({ ...x, heardAt: at, serverAt: x.stateAt || serverNow }));
  emitList();
});
onMessage("device_state", (d) => {
  const dev = findDevice(d.deviceId);
  if (!dev) return;
  dev.state = d.state || dev.state;
  dev.heardAt = performance.now();
  for (const fn of [...stateSubs]) { try { fn(d.deviceId, dev.state); } catch {} }
});

// Commands, each answered (by the device, or by the server for it).
let seq = 0;
const waiting = new Map(); // id -> {resolve, timer}
onMessage("remote_ack", (d) => {
  const w = waiting.get(d.id);
  if (!w) return;
  waiting.delete(d.id);
  clearTimeout(w.timer);
  w.resolve({ ok: !!d.ok, error: d.error || null, message: d.message || null, ms: d.ms });
});
/** -> Promise<{ok, error, message}> — never rejects */
export const command = (deviceId_, cmd, args = {}) =>
  new Promise((resolve) => {
    if (!socketOpen()) return resolve({ ok: false, error: "offline", message: "Not connected to the server — trying again" });
    const id = `c${(++seq).toString(36)}`;
    const timer = setTimeout(() => {
      waiting.delete(id);
      resolve({ ok: false, error: "timeout", message: "No answer — is it still on?" });
    }, 8000);
    waiting.set(id, { resolve, timer });
    send({ type: "remote_command", id, deviceId: deviceId_, cmd, args });
  });

// ---------------------------------------------------------------- the TARGET side
let announced = false;
let watched = false;
let player = null; // what screens/player.js registered
let lastSent = "";
let lastSentAt = 0;
let tick = null;
const fromSeen = new Set();

const screenName = () => {
  const h = (location.hash || "#/").replace(/^#\/?/, "");
  if (!h) return "home";
  const w = h.split(/[/?]/)[0];
  return w === "play" ? "player" : w === "movie" || w === "show" || w === "discover" ? "detail" : w.slice(0, 24);
};
const currentState = () => {
  let now = null;
  let volume = { supported: false, level: null, muted: false, scope: "player" };
  if (player) {
    try { now = player.getState(); } catch { now = null; }
    try { volume = { supported: true, scope: "player", ...player.getVolume() }; } catch {}
  }
  return { screen: screenName(), appState: document.visibilityState === "hidden" ? "background" : "active", now, volume };
};
// the state without the clock, for "did something change?"
const shape = (s) => JSON.stringify({ ...s, now: s.now ? { ...s.now, position: Math.round((s.now.position || 0) / 30) } : null });
const report = (force = false) => {
  if (!announced || !socketOpen()) return;
  const s = currentState();
  const k = shape(s);
  const t = Date.now();
  // every second while a remote screen is open on this device, at once on a
  // change, else every half a minute at most (so a remote that opens later
  // starts from a fresh position)
  if (!force && !watched && k === lastSent && t - lastSentAt < 30000) return;
  lastSent = k;
  lastSentAt = t;
  send({ type: "device_state", state: s });
};
const schedule = () => {
  clearInterval(tick);
  tick = announced ? setInterval(() => report(false), watched ? 1000 : 3000) : null;
};
/** The player says something changed (paused, a track, the title): told at once. */
export const playerChanged = () => report(true);

const announce = () => {
  const want = !!state.profile && targetEnabled();
  if (!want) {
    if (announced && socketOpen()) send({ type: "device_leave" });
    announced = false;
    schedule();
    return;
  }
  if (!socketOpen()) return;
  announced = true;
  send({
    type: "device_announce",
    deviceId: deviceId(),
    name: deviceName(),
    kind: "web",
    form: formOf(),
    model: `${browserName()} · ${deviceWord()}`,
    profileId: state.profile.id,
    token: state.token || undefined,
    caps: { navigate: true, volume: true, playItem: true, tracks: true },
    state: currentState(),
  });
  lastSent = "";
  schedule();
};

onMessage("remote_watch", (d) => {
  watched = !!d.on;
  schedule();
  if (watched) report(true);
});

/** The player, while it is up: {getState, getVolume, toggle, play, pause, seek, skip, next, sub, audio, subDelay, volume, mute, stop}. */
export const registerPlayerTarget = (ctrl) => {
  player = ctrl;
  report(true);
  return () => {
    if (player === ctrl) player = null;
    report(true);
  };
};

// Where the player starts when a remote opened it ("Play on this computer"),
// taken once by that player (screens/player.js) — the position and the
// remote's subtitle / audio choice.
let handoff = null;
export const takeRemoteStart = (itemId) => {
  const h = handoff;
  if (!h || h.id !== itemId || Date.now() - h.at > 60000) return null;
  handoff = null;
  return h;
};

const KEYMAP = { up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", back: "Escape" };
const KEYCODES = { ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Escape: 27, Enter: 13 };
const pressKey = (key) => {
  const target = document.activeElement && document.activeElement !== document.body ? document.activeElement : document;
  const opts = { key, code: key, keyCode: KEYCODES[key], which: KEYCODES[key], bubbles: true, cancelable: true };
  target.dispatchEvent(new KeyboardEvent("keydown", opts));
  target.dispatchEvent(new KeyboardEvent("keyup", opts));
};

const whoFrom = (from) => {
  const label = (from && from.label) || "your phone";
  return from && from.profileName ? `${from.profileName}'s ${label}` : label;
};

const handle = async (d) => {
  const reply = (ok, error = null, message = null) =>
    send({ type: "remote_ack", ref: d.ref, ok, ...(error ? { error } : {}), ...(message ? { message } : {}) });
  const a = d.args || {};
  if (d.first) {
    const who = whoFrom(d.from);
    if (!fromSeen.has(who)) { fromSeen.add(who); toast(`Controlled from ${who}`, "📱"); }
  }
  try {
    switch (d.cmd) {
      case "play_item": {
        const it = a.item || {};
        if (String(it.id).startsWith("torrent|")) return reply(false, "unsupported", "Streams play from their own page — open it on this computer");
        handoff = { id: it.id, position: a.position, subLang: a.subLang || null, audioLang: a.audioLang || null, at: Date.now() };
        navigate(`#/play/${encodeURIComponent(it.id)}${a.restart ? "?restart=1" : ""}`);
        return reply(true, null, "Opening");
      }
      case "key": {
        if (a.key === "home") { navigate("#/"); return reply(true); }
        if (a.key === "ok") {
          const act = document.activeElement;
          if (act && act !== document.body && typeof act.click === "function") act.click();
          else pressKey("Enter");
          return reply(true);
        }
        if (!KEYMAP[a.key]) return reply(false, "bad-command");
        pressKey(KEYMAP[a.key]);
        return reply(true);
      }
      case "rename":
        setDeviceName(a.name);
        return reply(true);
    }
    if (!player) return reply(false, "nothing-playing", "Nothing is playing on this computer");
    const p = player;
    switch (d.cmd) {
      case "toggle": p.toggle(); break;
      case "play": p.play(); break;
      case "pause": p.pause(); break;
      case "seek": p.seek(a.to); break;
      case "skip": p.skip(a.by); break;
      case "next": {
        const r = p.next();
        if (r === false) return reply(false, "no-next", "There is no next episode");
        break;
      }
      case "sub": p.sub(a.id); break;
      case "audio": p.audio(a.id); break;
      case "sub_delay": {
        const r = p.subDelay(a);
        if (r === false) return reply(false, "no-subtitles", "Turn a subtitle track on first");
        break;
      }
      case "volume": p.volume(a); break;
      case "mute": p.mute(a.on); break;
      case "stop": p.stop(); break;
      default: return reply(false, "bad-command");
    }
    reply(true);
    setTimeout(() => report(true), 60);
  } catch (e) {
    reply(false, "failed", "That didn't work on this computer");
  }
};
onMessage("remote_command", (d) => { handle(d); });

// ---------------------------------------------------------------- wiring
// A socket opens (welcome), a profile is entered: say who we are again.
const refresh = () => {
  heard = false;
  announce();
  subscribe();
};
let started = false;
export const initRemote = () => {
  if (started) return;
  started = true;
  onMessage("welcome", () => setTimeout(refresh, 0));
  window.addEventListener("aurora-profile", () => setTimeout(refresh, 0));
  window.addEventListener("hashchange", () => setTimeout(() => report(false), 0));
  document.addEventListener("visibilitychange", () => {
    // a tab brought to the front claims the device again (the newest answers)
    if (document.visibilityState === "visible" && announced) announce();
    else report(true);
  });
  onDevices(paintNav);
  refresh();
};

// ---------------------------------------------------------------- the look's pieces
// The remote's own stylesheet, loaded the first time anything of it shows.
let cssP = null;
export const ensureRemoteCss = () => {
  if (cssP) return cssP;
  cssP = new Promise((resolve) => {
    if (document.querySelector('link[data-remote-css]')) return resolve();
    const v = (document.querySelector('link[href^="/css/aurora.css"]')?.getAttribute("href") || "").split("?v=")[1] || "";
    const link = el("link", { rel: "stylesheet", href: `/css/remote.css${v ? `?v=${v}` : ""}`, "data-remote-css": "" });
    link.addEventListener("load", () => resolve(), { once: true });
    link.addEventListener("error", () => resolve(), { once: true });
    document.head.append(link);
  });
  return cssP;
};

export const ICONS = {
  tv: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 20h8M12 17v3"/></svg>',
  computer: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2.5 19h19"/></svg>',
  tablet: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M11 18h2"/></svg>',
  remote: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="3"/><circle cx="12" cy="8" r="2"/><path d="M10 13h.01M14 13h.01M10 16.5h.01M14 16.5h.01"/></svg>',
  cast: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 9V7a2 2 0 012-2h14a2 2 0 012 2v10a2 2 0 01-2 2h-6"/><path d="M3 13a6 6 0 016 6M3 16.5A2.5 2.5 0 015.5 19M3 19h.01"/></svg>',
};
export const deviceIcon = (d) => ICONS[d && d.kind === "tv" ? "tv" : d && d.form === "tablet" ? "tablet" : "computer"];

// A short line about what a device is doing ("Playing Arrival", "On Home").
export const deviceLine = (d) => {
  const s = (d && d.state) || {};
  if (s.appState === "background") return "Aurora is in the background";
  const n = s.now;
  if (n) {
    const what = n.showTitle ? `${n.showTitle}${n.season != null && n.episode != null ? ` · S${n.season} E${n.episode}` : ""}` : n.title;
    return `${n.paused ? "Paused" : "Playing"} · ${what}`;
  }
  return s.screen === "home" ? "On Home" : "Ready";
};

// ---------------------------------------------------------------- pick a device
// A sheet listing the devices (or straight through when there is one).
// Resolves the chosen device, or null.
export const chooseDevice = async (title = "Play on…", { always = false } = {}) => {
  const list = getDevices();
  if (!list.length) return null;
  if (list.length === 1 && !always) return list[0];
  await ensureRemoteCss();
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      document.removeEventListener("ui-back", onBack, true);
      document.removeEventListener("keydown", onKey);
      wrap.classList.remove("on");
      setTimeout(() => wrap.remove(), 220);
      resolve(v);
    };
    // (captured, and kept from the screen under it: Back closes the sheet only)
    const onBack = (e) => { e.preventDefault(); e.stopImmediatePropagation(); finish(null); };
    const onKey = (e) => { if (e.key === "Escape") finish(null); };
    const sheet = el("div", { class: "rm-sheet", role: "dialog", "aria-modal": "true", "aria-label": title },
      el("div", { class: "rm-sheet-grip", "aria-hidden": "true" }),
      el("div", { class: "rm-sheet-title" }, title),
      ...list.map((d) =>
        el("button", { class: "rm-sheet-row focusable", "data-ui": "remote.device.pick", onclick: () => finish(d) },
          el("span", { class: "rm-sheet-ico", html: deviceIcon(d) }),
          el("span", { class: "rm-sheet-text" },
            el("span", { class: "rm-sheet-name" }, d.name),
            el("span", { class: "rm-sheet-sub" }, `${d.mine ? "" : `${d.profile && d.profile.name ? d.profile.name : "Someone"} · `}${deviceLine(d)}`)))),
      el("button", { class: "rm-sheet-row rm-sheet-cancel focusable", onclick: () => finish(null) }, "Cancel"),
    );
    const wrap = el("div", { class: "rm-sheet-wrap ui-overlay", onclick: (e) => e.target === wrap && finish(null) }, sheet);
    document.body.append(wrap);
    document.addEventListener("ui-back", onBack, true);
    document.addEventListener("keydown", onKey);
    requestAnimationFrame(() => wrap.classList.add("on"));
    setTimeout(() => sheet.querySelector(".rm-sheet-row")?.focus({ preventScroll: true }), 40);
  });
};

// The profile's remembered subtitle and audio languages (person prefs), so
// "Play on TV" starts the TV the way this device would have.
const remembered = () => {
  const prefs = (state.profile && state.profile.prefs) || {};
  const sub = prefs.subPick || null;
  return { subLang: sub === "off" || /^[a-z]{2,3}$/.test(String(sub || "")) ? sub : null, audioLang: /^[a-z]{2,3}$/.test(String(prefs.audioLang || "")) ? prefs.audioLang : null };
};

/** What a library item / episode looks like on the wire (the item the TV opens). */
export const wireItem = (it) => ({
  id: it.id,
  title: it.title || "",
  showTitle: it.showTitle || null,
  epTitle: it.showId ? it.title || null : null,
  season: it.season != null ? it.season : null,
  episode: it.episode != null ? it.episode : null,
  type: it.type === "show" ? "show" : it.showId ? null : "movie",
  imdbId: it.imdbId || null,
  poster: it.cover || it.poster || null,
  duration: it.duration || null,
});

// Play it there: the command, a word on how it went, and (by default) the
// remote screen for that device.
export const playOn = async (device, item, { position = null, restart = false, subLang, audioLang, open = true } = {}) => {
  if (!device || !item) return { ok: false };
  const r = remembered();
  const res = await command(device.deviceId, "play_item", {
    item: wireItem(item),
    position: position != null && position > 0 ? position : null,
    restart: !!restart,
    subLang: subLang !== undefined ? subLang : r.subLang,
    audioLang: audioLang !== undefined ? audioLang : r.audioLang,
  });
  if (res.ok) {
    toast(`Playing on ${device.name}`, "📺", null, { quiet: true });
    if (open) navigate(`#/remote/${encodeURIComponent(device.deviceId)}`);
  } else {
    toast(res.message || `Couldn't play on ${device.name}`, "⚠️");
  }
  return res;
};

// The Play-on buttons on screen, painted on every change of the list. Held
// WEAKLY: a title page that was left must not stay in memory because its
// button is on this list (test/ui/leaks.test.js). Where WeakRef is missing,
// the ones no longer in the page are let go on each route change.
const buttons = new Set();
const keepButton = (btn) => buttons.add(typeof WeakRef === "function" ? new WeakRef(btn) : { deref: () => btn, strong: true });
const pruneButtons = () => {
  for (const r of buttons) {
    const btn = r.deref();
    if (!btn || (r.strong && !btn.isConnected)) buttons.delete(r);
  }
};
onDevices((list) => {
  for (const r of buttons) {
    const btn = r.deref();
    if (!btn) { buttons.delete(r); continue; }
    if (btn.isConnected || !r.strong) btn._rmPaint(list);
  }
});
if (typeof window !== "undefined") window.addEventListener("hashchange", () => setTimeout(pruneButtons, 0));

// A "Play on TV" button for a title page / an episode row / a sheet. Hidden
// while no device is on; says the device's name when there is one.
// `getItem()` -> the library item to play (or null), `opts()` -> playOn options.
export const playOnButton = ({ getItem, opts = () => ({}), compact = false, bare = false, className = "", ui = "detail.playontv", labelOf = (t) => t } = {}) => { // data-ui
  const label = el("span", {}, "Play on TV");
  const b = el("button", {
    class: `${bare ? "" : "btn "}focusable rm-playon ${compact && !bare ? "rm-playon-compact" : ""} ${className}`.replace(/\s+/g, " ").trim(),
    "data-ui": ui,
    type: "button",
    html: ICONS.cast,
    onclick: async (e) => {
      e.stopPropagation();
      const item = getItem && getItem();
      if (!item) return;
      const d = await chooseDevice("Play on…");
      if (d) await playOn(d, item, opts() || {});
    },
  });
  if (!compact && !bare) b.append(label);
  b._rmPaint = (list) => {
    const n = list.length;
    b.hidden = n === 0;
    const text = n === 1 ? `Play on ${list[0].name}` : "Play on TV";
    label.textContent = text;
    b.setAttribute("aria-label", labelOf(text));
    b.title = labelOf(text);
  };
  b._rmPaint(getDevices());
  keepButton(b);
  if (getDevices().length) ensureRemoteCss();
  return b;
};

// The nav's Remote button: there while a device is on (glass and classic).
const paintNav = (list) => {
  const nav = document.getElementById("nav");
  if (!nav) return;
  let b = document.getElementById("nav-remote");
  if (!list.length) { if (b) b.hidden = true; return; }
  ensureRemoteCss();
  if (!b) {
    b = el("a", { id: "nav-remote", class: "nav-remote focusable", href: "#/remote", "data-nav": "", "data-ui": "nav.remote", "aria-label": "Remote", title: "Remote", html: ICONS.remote });
    const anchor = document.getElementById("nav-dl") || nav.querySelector(".nav-gear");
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(b, anchor);
    else nav.append(b);
  }
  b.hidden = false;
  const playing = list.find((d) => d.state && d.state.now);
  b.classList.toggle("live", !!playing);
};

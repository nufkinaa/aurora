// The remote (#/remote, #/remote/<deviceId>): a phone in the hand, the TV
// across the room. Phone-first, full screen, thumb-reachable:
//
//   top     — close, the device picker ("Living room TV ▾") with its
//             connection light, More (rename, how it works)
//   middle  — what is playing: the artwork over a blur of itself, the title,
//             a big scrub bar with times, ±10 / ±30, a big play / pause,
//             Subtitles / Audio sheets, Next episode, Stop. Nothing playing:
//             the profile's Continue Watching, a tap plays it there.
//   pad     — a touchpad (swipe = arrow, tap = OK) or D-pad buttons, Back,
//             Home, with a little buzz under the thumb where the phone can
//   bottom  — Now playing / Touchpad, and the volume (when the device can)
//
// Portrait phones switch between the middle and the pad; landscape, tablets
// and computers show both side by side. Everything here is a command over the
// devices channel (js/remote.js); the device answers, and its state comes back
// every second while this screen is open.
import { state } from "../state.js";
import { api } from "../api.js";
import { el, toast, fmtClock } from "../ui.js";
import { navigate } from "../router.js";
import { pushScope, popScope } from "../focus.js";
import {
  getDevices, onDevices, onDeviceState, findDevice, watchDevice, command, devicesHeard,
  ensureRemoteCss, initRemote, deviceIcon, deviceLine, chooseDevice, playOn, ICONS, householdOn, listProblem,
} from "../remote.js";

const LAST_KEY = "aurora-remote-last";
const VIEW_KEY = "aurora-remote-view";
const PAD_KEY = "aurora-remote-pad";

const I = {
  down: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
  more: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="19" cy="12" r="1.9"/></svg>',
  play: '<svg viewBox="0 0 24 24" width="34" height="34" fill="currentColor" aria-hidden="true"><path d="M8.2 5.3c-.8-.5-1.7.1-1.7 1v11.4c0 .9.9 1.5 1.7 1l9.4-5.7c.7-.4.7-1.5 0-2z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="34" height="34" fill="currentColor" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1.3"/><rect x="13.5" y="5" width="4" height="14" rx="1.3"/></svg>',
  back: (n) => `<svg viewBox="0 0 32 32" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 8.5A10 10 0 1 1 6 16"/><path d="M9 3.5v5h5"/><text x="16" y="20" text-anchor="middle" font-size="9" font-weight="700" fill="currentColor" stroke="none" font-family="system-ui,sans-serif">${n}</text></svg>`,
  fwd: (n) => `<svg viewBox="0 0 32 32" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 8.5A10 10 0 1 0 26 16"/><path d="M23 3.5v5h-5"/><text x="16" y="20" text-anchor="middle" font-size="9" font-weight="700" fill="currentColor" stroke="none" font-family="system-ui,sans-serif">${n}</text></svg>`,
  cc: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10 10.2a2.2 2.2 0 1 0 0 3.6M17 10.2a2.2 2.2 0 1 0 0 3.6"/></svg>',
  audio: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/></svg>',
  next: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M6.5 6.2c-.7-.4-1.5.1-1.5.9v9.8c0 .8.8 1.3 1.5.9l7.7-4.9c.6-.4.6-1.3 0-1.7z"/><rect x="16" y="5.5" width="2.6" height="13" rx="1"/></svg>',
  stop: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>',
  home: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 11l8-6.5 8 6.5"/><path d="M6.5 9.5V19h11V9.5"/></svg>',
  backKey: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 7L4 12l5 5"/><path d="M4 12h10a6 6 0 0 1 6 6"/></svg>',
  volDown: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.5h3l4-3.5v12l-4-3.5H4z"/><path d="M15 12h5"/></svg>',
  volUp: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.5h3l4-3.5v12l-4-3.5H4z"/><path d="M15 12h5M17.5 9.5v5"/></svg>',
  mute: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.5h3l4-3.5v12l-4-3.5H4z"/><path d="M15.5 9.5l5 5M20.5 9.5l-5 5"/></svg>',
  arrow: (deg) => `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="transform:rotate(${deg}deg)"><path d="M6 14l6-6 6 6"/></svg>`,
  check: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7"/></svg>',
};

const buzz = (ms = 8) => { try { if (navigator.vibrate) navigator.vibrate(ms); } catch {} };
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
const pct = (a, b) => (b > 0 ? Math.max(0, Math.min(100, (a / b) * 100)) : 0);

export const renderRemote = async (root, params = {}) => {
  initRemote(); // (opened straight from a link: the channel starts here)
  await ensureRemoteCss();
  let deviceId = params.id ? decodeURIComponent(params.id) : null;
  let exited = false;

  // ---------------------------------------------------------------- the frame
  const backdrop = el("div", { class: "rm-backdrop", "aria-hidden": "true" }, el("img", { alt: "", decoding: "async" }));
  const closeBtn = el("button", { class: "rm-icon-btn focusable", "aria-label": "Close the remote", "data-ui": "remote.close", html: I.down, onclick: () => leave() });
  const pickName = el("span", { class: "rm-pick-name" }, "Your TVs");
  const pickDot = el("span", { class: "rm-dot", "aria-hidden": "true" });
  const pickIco = el("span", { class: "rm-pick-ico", html: ICONS.tv });
  const picker = el("button", { class: "rm-picker focusable", "aria-haspopup": "dialog", "data-ui": "remote.device.open", onclick: () => pickDevice() },
    pickIco, pickName, el("span", { class: "rm-pick-caret", html: I.down }), pickDot);
  const moreBtn = el("button", { class: "rm-icon-btn focusable", "aria-label": "More", "data-ui": "remote.more", html: I.more, onclick: () => moreSheet() });
  const top = el("header", { class: "rm-top" }, closeBtn, picker, moreBtn);
  const banner = el("div", { class: "rm-banner", role: "status", hidden: true });

  // now playing
  const art = el("img", { class: "rm-art-img", alt: "", decoding: "async" });
  const artBox = el("div", { class: "rm-art" }, art);
  const eyebrow = el("div", { class: "rm-eyebrow" });
  const title = el("h1", { class: "rm-title" });
  const sub = el("div", { class: "rm-subtitle" });
  const scrub = el("input", { class: "rm-scrub-input focusable", type: "range", min: "0", max: "1000", step: "1", value: "0", "aria-label": "Position", "data-ui": "remote.seek" });
  const fill = el("div", { class: "rm-scrub-fill" });
  const scrubTrack = el("div", { class: "rm-scrub-track", "aria-hidden": "true" }, fill, el("div", { class: "rm-scrub-thumb" }));
  const tNow = el("span", { class: "rm-time" }, "0:00");
  const tLeft = el("span", { class: "rm-time" }, "-0:00");
  const scrubBox = el("div", { class: "rm-scrub" }, el("div", { class: "rm-scrub-hit" }, scrubTrack, scrub), el("div", { class: "rm-times" }, tNow, tLeft));
  const tBtn = (cls, label, html, fn, ui) => el("button", { class: `rm-t ${cls} focusable`, "aria-label": label, title: label, html, "data-ui": ui, onclick: (e) => { buzz(); fn(e); } });
  const playBtn = tBtn("rm-play", "Play", I.play, () => cmd("toggle", {}, { optimistic: () => setPaused(!view.paused) }), "remote.playpause"); // data-ui
  const transport = el("div", { class: "rm-transport" },
    tBtn("rm-skip", "Back 30 seconds", I.back(30), () => skip(-30), "remote.skip"), // data-ui
    tBtn("rm-skip", "Back 10 seconds", I.back(10), () => skip(-10), "remote.skip"), // data-ui
    playBtn,
    tBtn("rm-skip", "Forward 10 seconds", I.fwd(10), () => skip(10), "remote.skip"), // data-ui
    tBtn("rm-skip", "Forward 30 seconds", I.fwd(30), () => skip(30), "remote.skip"), // data-ui
  );
  const chip = (label, html, fn, ui) => el("button", { class: "rm-chip focusable", "data-ui": ui, onclick: () => { buzz(); fn(); } }, el("span", { class: "rm-chip-ico", html }), el("span", { class: "rm-chip-label" }, label));
  const ccChip = chip("Subtitles", I.cc, () => subsSheet(), "remote.subtitles"); // data-ui
  const audioChip = chip("Audio", I.audio, () => audioSheet(), "remote.audio"); // data-ui
  const nextChip = chip("Next episode", I.next, () => cmd("next", {}, { done: "Next episode" }), "remote.next"); // data-ui
  const stopChip = chip("Stop", I.stop, () => cmd("stop", {}, { done: "Stopped" }), "remote.stop"); // data-ui
  const chips = el("div", { class: "rm-chips" }, ccChip, audioChip, nextChip, stopChip);
  const playing = el("section", { class: "rm-playing" }, artBox, el("div", { class: "rm-meta" }, eyebrow, title, sub), scrubBox, transport, chips);

  // nothing playing: Continue Watching, played there with a tap
  const idleTitle = el("h1", { class: "rm-title" });
  const idleSub = el("div", { class: "rm-subtitle" });
  const idleRow = el("div", { class: "rm-cw", role: "list" });
  const idle = el("section", { class: "rm-idle" },
    el("div", { class: "rm-idle-glyph", html: ICONS.tv, "aria-hidden": "true" }), idleTitle, idleSub,
    el("div", { class: "rm-cw-head" }, "Continue watching"), idleRow);

  // nobody: no device on
  const emptyTitle = el("h1", { class: "rm-title" }, "No TV is on");
  const emptySub = el("p", { class: "rm-subtitle" });
  const empty = el("section", { class: "rm-empty" }, el("div", { class: "rm-idle-glyph", html: ICONS.remote, "aria-hidden": "true" }), emptyTitle, emptySub);

  const nowView = el("div", { class: "rm-view rm-view-now" }, playing, idle, empty);

  // the pad
  const padHint = el("div", { class: "rm-pad-hint", "aria-hidden": "true" }, el("span", {}, "Swipe to move"), el("span", {}, "Tap to select"));
  const ripple = el("span", { class: "rm-ripple", "aria-hidden": "true" });
  const touch = el("div", {
    class: "rm-touch focusable", tabindex: "0", role: "button", "data-ui": "remote.dpad",
    "aria-label": "Touchpad: swipe to move, tap to select. Arrow keys and Enter work too.",
  }, padHint, ripple, el("span", { class: "rm-touch-glow", "aria-hidden": "true" }));
  const dkey = (key, label, html, cls) => el("button", { class: `rm-dkey ${cls} focusable`, "aria-label": label, "data-ui": "remote.dpad", html, onclick: () => press(key) });
  const dpad = el("div", { class: "rm-dpad", role: "group", "aria-label": "Arrows" },
    dkey("up", "Up", I.arrow(0), "rm-up"), dkey("left", "Left", I.arrow(-90), "rm-left"),
    el("button", { class: "rm-dkey rm-ok focusable", "aria-label": "OK", "data-ui": "remote.dpad", onclick: () => press("ok") }, "OK"),
    dkey("right", "Right", I.arrow(90), "rm-right"), dkey("down", "Down", I.arrow(180), "rm-down"));
  const padMode = el("div", { class: "rm-seg rm-padmode", role: "tablist", "aria-label": "Pad" });
  const padSeg = (mode, label) => el("button", { class: "rm-seg-btn focusable", role: "tab", "data-mode": mode, "data-ui": "remote.padmode", onclick: () => setPad(mode) }, label);
  padMode.append(padSeg("touch", "Swipe"), padSeg("buttons", "Buttons"));
  const keyRow = el("div", { class: "rm-keys" },
    el("button", { class: "rm-key focusable", "aria-label": "Back", "data-ui": "remote.back", onclick: () => press("back") }, el("span", { html: I.backKey }), el("span", {}, "Back")),
    el("button", { class: "rm-key rm-key-pp focusable", "aria-label": "Play or pause", "data-ui": "remote.playpause", onclick: () => { buzz(); cmd("toggle", {}, { optimistic: () => setPaused(!view.paused) }); } }, el("span", { class: "rm-key-pp-ico", html: I.pause }), el("span", {}, "Play/Pause")),
    el("button", { class: "rm-key focusable", "aria-label": "Home", "data-ui": "remote.home", onclick: () => press("home") }, el("span", { html: I.home }), el("span", {}, "Home")));
  const padArea = el("div", { class: "rm-pad-area" }, touch, dpad);
  const padView = el("div", { class: "rm-view rm-view-pad" }, padMode, padArea, keyRow);

  const body = el("main", { class: "rm-body" }, nowView, padView);

  // the dock
  const tabs = el("div", { class: "rm-seg rm-tabs", role: "tablist", "aria-label": "Remote" });
  const tab = (v, label) => el("button", { class: "rm-seg-btn focusable", role: "tab", "data-view": v, "data-ui": "remote.view", onclick: () => setView(v) }, label);
  tabs.append(tab("now", "Now playing"), tab("pad", "Touchpad"));
  const volDown = el("button", { class: "rm-vol-btn focusable", "aria-label": "Volume down", "data-ui": "remote.volume", html: I.volDown, onclick: () => { buzz(); cmd("volume", { step: -1 }); } });
  const volMute = el("button", { class: "rm-vol-btn focusable", "aria-label": "Mute", "data-ui": "remote.mute", html: I.mute, onclick: () => { buzz(); cmd("mute", { on: !view.muted }, { optimistic: () => { view.muted = !view.muted; paintVolume(); } }); } });
  const volUp = el("button", { class: "rm-vol-btn focusable", "aria-label": "Volume up", "data-ui": "remote.volume", html: I.volUp, onclick: () => { buzz(); cmd("volume", { step: 1 }); } });
  const volLevel = el("div", { class: "rm-vol-level", "aria-hidden": "true" }, el("i"));
  const vol = el("div", { class: "rm-vol", role: "group", "aria-label": "Volume" }, volDown, volMute, volUp, volLevel);
  const dock = el("footer", { class: "rm-dock" }, tabs, vol);

  const screen = el("div", { class: "screen remote-screen", role: "region", "aria-label": "Remote" }, backdrop, top, banner, body, dock);
  root.innerHTML = "";
  root.append(screen);
  document.documentElement.classList.add("remote-open");
  pushScope(screen);

  // ---------------------------------------------------------------- state
  const view = { paused: true, muted: false, position: 0, duration: 0, at: performance.now(), dragging: false, seekHoldUntil: 0, nowId: null };
  const dev = () => (deviceId ? findDevice(deviceId) : null);

  const setPaused = (p) => {
    view.paused = p;
    playBtn.innerHTML = p ? I.play : I.pause;
    playBtn.setAttribute("aria-label", p ? "Play" : "Pause");
    playBtn.title = p ? "Play" : "Pause";
    keyRow.querySelector(".rm-key-pp-ico").innerHTML = p ? I.play : I.pause;
    screen.classList.toggle("is-paused", p);
  };

  const setView = (v) => {
    screen.dataset.view = v;
    store.set(VIEW_KEY, v);
    for (const b of tabs.children) {
      const on = b.dataset.view === v;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    }
  };
  const setPad = (m) => {
    screen.dataset.pad = m;
    store.set(PAD_KEY, m);
    for (const b of padMode.children) {
      const on = b.dataset.mode === m;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    }
  };
  setPad(store.get(PAD_KEY) === "buttons" ? "buttons" : "touch");

  // where the clock is NOW: the last report, moved on by the time since
  const livePos = () => {
    if (view.dragging) return view.position;
    if (view.paused || view.buffering) return view.position;
    const p = view.position + (performance.now() - view.at) / 1000;
    return view.duration ? Math.min(view.duration, p) : p;
  };
  const paintClock = () => {
    const p = view.dragging ? (Number(scrub.value) / 1000) * view.duration : livePos();
    const d = view.duration;
    fill.style.width = `${pct(p, d)}%`;
    scrubTrack.style.setProperty("--p", `${pct(p, d)}%`);
    if (!view.dragging) scrub.value = String(d ? Math.round((p / d) * 1000) : 0);
    tNow.textContent = fmtClock(p);
    tLeft.textContent = d ? `-${fmtClock(Math.max(0, d - p))}` : "";
    scrub.setAttribute("aria-valuetext", d ? `${fmtClock(p)} of ${fmtClock(d)}` : fmtClock(p));
  };

  const paintVolume = () => {
    const d = dev();
    const v = d && d.state && d.state.volume;
    const ok = !!(v && v.supported) && !!(d && d.caps && d.caps.volume);
    vol.hidden = !ok;
    screen.classList.toggle("no-volume", !ok);
    if (!ok) return;
    volMute.classList.toggle("on", !!view.muted);
    volMute.setAttribute("aria-pressed", view.muted ? "true" : "false");
    volMute.setAttribute("aria-label", view.muted ? "Unmute" : "Mute");
    const lvl = typeof v.level === "number" ? v.level : null;
    volLevel.hidden = lvl == null;
    if (lvl != null) volLevel.firstChild.style.width = `${Math.round((view.muted ? 0 : lvl) * 100)}%`;
    vol.title = v.scope === "system" ? "The TV's volume" : "This player's volume";
  };

  let lastArt = null;
  const paint = () => {
    if (exited) return;
    const list = getDevices();
    const d = dev();
    screen.classList.toggle("no-devices", !list.length);
    // the picker
    pickName.textContent = d ? d.name : list.length ? "Choose a device" : "Your TVs";
    pickIco.innerHTML = d ? deviceIcon(d) : ICONS.tv;
    picker.setAttribute("aria-label", d ? `Device: ${d.name}. Choose another` : "Choose a device");
    const online = !!(state.ws && state.ws.readyState === WebSocket.OPEN);
    pickDot.className = `rm-dot ${!online ? "off" : d ? "live" : "idle"}`;
    // the banner: the line to the server, the device, its app
    const bg = d && d.state && d.state.appState === "background";
    const msg = !online ? "Reconnecting to the server…"
      : deviceId && !d && list.length ? "That device isn't on any more — pick another above"
      : bg ? `Aurora is in the background on ${d.name} — open it there` : "";
    banner.hidden = !msg;
    banner.textContent = msg;
    // which section
    const n = d && d.state ? d.state.now : null;
    screen.dataset.state = !list.length ? "empty" : n ? "playing" : "idle";
    if (!list.length) {
      const name = state.profile ? state.profile.name : "you";
      emptySub.textContent = devicesHeard() || !online
        ? `Open Aurora on your TV — signed in as ${name} — and it shows up here.${householdOn() ? " TVs of the rest of the household show up too." : ""}${listProblem() === "not-signed-in" ? " (This device could not prove it is signed in — open Aurora again.)" : ""}`
        : "Looking for your TVs…";
    }
    const caps = (d && d.caps) || {};
    padView.classList.toggle("no-nav", !caps.navigate);
    if (!caps.navigate && d) padHint.firstChild.textContent = "This device can't be steered";
    else padHint.firstChild.textContent = "Swipe to move";
    if (n) {
      eyebrow.textContent = `${n.paused ? "Paused on" : "Playing on"} ${d.name}`;
      title.textContent = n.showTitle || n.title || "";
      const se = n.season != null && n.episode != null ? `S${n.season} E${n.episode}` : "";
      const name = n.epTitle || (n.showTitle && n.title && n.title !== n.showTitle ? n.title : "");
      sub.textContent = [se, name].filter(Boolean).join(" · ");
      const pic = n.backdrop || n.poster || null;
      const artPic = n.poster || n.backdrop || null;
      if (artPic !== lastArt) {
        lastArt = artPic;
        artBox.classList.toggle("wide", !n.poster && !!n.backdrop);
        if (artPic) { art.src = artPic; art.hidden = false; } else { art.removeAttribute("src"); art.hidden = true; }
        const bimg = backdrop.firstChild;
        if (pic) { bimg.src = pic; backdrop.classList.add("on"); } else { bimg.removeAttribute("src"); backdrop.classList.remove("on"); }
      }
      artBox.classList.toggle("has-art", !!artPic);
      artBox.dataset.letter = (n.showTitle || n.title || "?").trim().charAt(0).toUpperCase();
      // the clock: taken from the report unless a seek of ours is landing
      if (performance.now() > view.seekHoldUntil && !view.dragging) {
        view.position = n.position || 0;
        view.at = d.heardAt || performance.now();
      }
      if (view.nowId !== n.id) { view.nowId = n.id; view.seekHoldUntil = 0; view.position = n.position || 0; view.at = d.heardAt || performance.now(); }
      view.duration = n.duration || 0;
      view.buffering = !!n.buffering;
      screen.classList.toggle("is-buffering", !!n.buffering);
      if (!view.pendingToggle) setPaused(!!n.paused);
      scrub.disabled = !n.canSeek || !view.duration;
      ccChip.classList.toggle("on", !!n.sub);
      ccChip.disabled = !(n.subs && n.subs.length);
      audioChip.hidden = !(n.audios && n.audios.length > 1);
      nextChip.hidden = !n.hasNext;
      if (n.nextLabel) nextChip.title = `Next: ${n.nextLabel}`;
      paintClock();
    } else {
      view.nowId = null;
      if (lastArt !== null) { lastArt = null; backdrop.classList.remove("on"); }
      if (d) {
        idleTitle.textContent = `Nothing playing on ${d.name}`;
        idleSub.textContent = `${deviceLine(d)}${d.mine ? "" : ` · ${d.profile ? d.profile.name : ""}`}`;
      }
      fillIdle();
    }
    const v = d && d.state && d.state.volume;
    if (v && !view.pendingMute) view.muted = !!v.muted;
    paintVolume();
  };

  // Continue Watching, once per visit (and again when the profile's state moves)
  let idleFilled = false;
  const fillIdle = async () => {
    if (idleFilled || !state.profile) return;
    idleFilled = true;
    let rows = [];
    try { rows = (await api.home(state.profile.id)).rows || []; } catch {}
    if (exited) return;
    const cw = rows.find((r) => r.id === "continue");
    const items = (cw && cw.items ? cw.items : []).filter((it) => it && it.id && !String(it.id).startsWith("torrent|")).slice(0, 12);
    idleRow.innerHTML = "";
    idle.classList.toggle("has-cw", items.length > 0);
    for (const it of items) {
      const p = state.progress[it.id];
      const pos = p && !p.finished ? p.position : 0;
      const label = it.showId ? `${it.showTitle || ""} · S${it.season} E${it.episode}` : it.title;
      const b = el("button", { class: "rm-cw-card focusable", role: "listitem", "data-ui": "remote.play", "aria-label": `Play ${label} on the TV`,
        onclick: async () => {
          const d = dev();
          if (!d) return;
          buzz(12);
          b.classList.add("busy");
          const r = await playOn(d, it, { position: pos, open: false });
          b.classList.remove("busy");
          if (r.ok) setView("now");
        } },
      it.cover || it.backdrop ? el("img", { src: it.backdrop || it.cover, alt: "", loading: "lazy", decoding: "async" }) : el("span", { class: "rm-cw-letter" }, (it.showTitle || it.title || "?").charAt(0)),
      el("span", { class: "rm-cw-label" }, label),
      p && p.duration ? el("span", { class: "rm-cw-bar" }, el("i", { style: { width: `${pct(p.position, p.duration)}%` } })) : null);
      idleRow.append(b);
    }
  };

  // ---------------------------------------------------------------- talking to the device
  const failed = (r, what) => {
    if (r.ok) return false;
    toast(r.message || `${what || "That"} didn't work`, r.error === "slow-down" ? "✋" : "⚠️", null, { quiet: r.error === "slow-down" });
    return true;
  };
  const cmd = async (name, args = {}, { optimistic, done } = {}) => {
    const d = dev();
    if (!d) { toast("Pick a device first", "📺"); return { ok: false }; }
    if (optimistic) optimistic();
    if (name === "toggle") view.pendingToggle = true;
    if (name === "mute") view.pendingMute = true;
    const r = await command(d.deviceId, name, args);
    view.pendingToggle = false;
    view.pendingMute = false;
    if (failed(r)) { paint(); return r; }
    if (done) toast(done, "📺", null, { quiet: true });
    return r;
  };
  const press = async (key) => {
    buzz(key === "ok" ? 14 : 8);
    const r = await cmd("key", { key });
    return r;
  };
  const skip = (by) => {
    const to = Math.max(0, Math.min(view.duration || Infinity, livePos() + by));
    view.position = to;
    view.at = performance.now();
    view.seekHoldUntil = performance.now() + 2500;
    paintClock();
    cmd("skip", { by });
  };

  // the scrub bar: preview while the thumb is held, one seek when it is let go
  scrub.addEventListener("pointerdown", () => { view.dragging = true; screen.classList.add("is-scrubbing"); });
  scrub.addEventListener("input", () => { view.dragging = true; screen.classList.add("is-scrubbing"); paintClock(); });
  const commitScrub = () => {
    if (!view.dragging) return;
    const to = (Number(scrub.value) / 1000) * view.duration;
    view.dragging = false;
    screen.classList.remove("is-scrubbing");
    view.position = to;
    view.at = performance.now();
    view.seekHoldUntil = performance.now() + 3000;
    paintClock();
    buzz(10);
    cmd("seek", { to: Math.round(to * 10) / 10 });
  };
  scrub.addEventListener("change", commitScrub);
  scrub.addEventListener("pointerup", () => setTimeout(commitScrub, 0));
  scrub.addEventListener("keydown", (e) => e.stopPropagation()); // the slider's own arrows, not the pad's

  // the touchpad: a swipe is one arrow, a tap is OK; keys too
  let start = null;
  const showRipple = (x, y, kind) => {
    const r = touch.getBoundingClientRect();
    ripple.style.left = `${x - r.left}px`;
    ripple.style.top = `${y - r.top}px`;
    ripple.dataset.kind = kind;
    ripple.classList.remove("go");
    void ripple.offsetWidth;
    ripple.classList.add("go");
  };
  touch.addEventListener("pointerdown", (e) => {
    start = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId, moved: false };
    try { touch.setPointerCapture(e.pointerId); } catch {}
    touch.classList.add("held");
  });
  touch.addEventListener("pointermove", (e) => {
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    const dist = Math.hypot(dx, dy);
    // a long drag keeps stepping: every STEP pixels is another arrow
    const STEP = 70;
    if (dist >= 28 && !start.moved) {
      start.moved = true;
      const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
      start.dir = dir;
      start.steps = 1;
      start.ox = e.clientX; start.oy = e.clientY;
      showRipple(e.clientX, e.clientY, dir);
      press(dir);
    } else if (start.moved) {
      const ax = e.clientX - start.ox;
      const ay = e.clientY - start.oy;
      const along = start.dir === "left" ? -ax : start.dir === "right" ? ax : start.dir === "up" ? -ay : ay;
      if (along >= STEP) {
        start.ox = e.clientX; start.oy = e.clientY;
        showRipple(e.clientX, e.clientY, start.dir);
        press(start.dir);
      }
    }
  });
  const endTouch = (e) => {
    touch.classList.remove("held");
    if (!start || (e && e.pointerId !== start.id)) return;
    const s = start;
    start = null;
    if (!s.moved && e && e.type === "pointerup" && performance.now() - s.t < 600) {
      showRipple(e.clientX, e.clientY, "ok");
      press("ok");
    }
  };
  touch.addEventListener("pointerup", endTouch);
  touch.addEventListener("pointercancel", () => { start = null; touch.classList.remove("held"); });
  touch.addEventListener("contextmenu", (e) => e.preventDefault());
  const onPadKey = (e) => {
    const map = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", Enter: "ok", " ": "ok", Backspace: "back" };
    const k = map[e.key];
    if (!k) return;
    e.preventDefault();
    e.stopPropagation();
    press(k);
  };
  touch.addEventListener("keydown", onPadKey);
  // (focus.js moves focus on arrows: on the pad they are the TV's, not the page's)
  const onNavMove = (e) => { if (document.activeElement === touch) e.preventDefault(); };
  document.addEventListener("nav-move", onNavMove);

  // ---------------------------------------------------------------- sheets
  const sheet = (titleText, rows, { footer = null } = {}) => new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      document.removeEventListener("ui-back", onBack, true);
      wrap.classList.remove("on");
      setTimeout(() => wrap.remove(), 220);
      popScope(box);
      resolve(v);
    };
    const onBack = (e) => { e.preventDefault(); e.stopImmediatePropagation(); finish(null); };
    const box = el("div", { class: "rm-sheet", role: "dialog", "aria-modal": "true", "aria-label": titleText },
      el("div", { class: "rm-sheet-grip", "aria-hidden": "true" }),
      el("div", { class: "rm-sheet-title" }, titleText),
      el("div", { class: "rm-sheet-list" }, ...rows.map((r) => r.node ? r.node(finish) : el("button", {
        class: `rm-sheet-row focusable ${r.on ? "on" : ""}`, "data-ui": r.ui || "remote.sheet.pick", "aria-checked": r.on ? "true" : "false", role: "menuitemradio",
        onclick: () => { buzz(); finish(r.value); },
      },
      r.icon ? el("span", { class: "rm-sheet-ico", html: r.icon }) : null,
      el("span", { class: "rm-sheet-text" }, el("span", { class: "rm-sheet-name" }, r.label), r.sub ? el("span", { class: "rm-sheet-sub" }, r.sub) : null),
      r.on ? el("span", { class: "rm-sheet-check", html: I.check }) : null))),
      footer ? footer(finish) : null,
      el("button", { class: "rm-sheet-row rm-sheet-cancel focusable", onclick: () => finish(null) }, "Close"),
    );
    const wrap = el("div", { class: "rm-sheet-wrap ui-overlay", onclick: (e) => e.target === wrap && finish(null) }, box);
    screen.append(wrap);
    document.addEventListener("ui-back", onBack, true);
    requestAnimationFrame(() => wrap.classList.add("on"));
    pushScope(box);
    const on = box.querySelector(".rm-sheet-row.on") || box.querySelector(".rm-sheet-row");
    setTimeout(() => on && on.focus({ preventScroll: true }), 40);
  });

  const nowOf = () => { const d = dev(); return d && d.state ? d.state.now : null; };
  const subsSheet = async () => {
    const n = nowOf();
    if (!n) return;
    const delayRow = (finish) => {
      const val = el("span", { class: "rm-delay-val" });
      const show = (v) => { val.textContent = `${v > 0 ? "+" : ""}${(v || 0).toFixed(1)} s`; };
      show(n.subDelay || 0);
      const nudge = async (by) => {
        buzz();
        const cur = (nowOf() && nowOf().subDelay) || 0;
        show(Math.round((cur + by) * 10) / 10);
        const r = await cmd("sub_delay", { by });
        if (!r.ok) show(cur);
      };
      return el("div", { class: "rm-delay", role: "group", "aria-label": "Subtitle timing" },
        el("span", { class: "rm-delay-label" }, "Timing"),
        el("button", { class: "rm-delay-btn focusable", "aria-label": "Subtitles earlier", "data-ui": "remote.subdelay", onclick: () => nudge(-0.5) }, "−0.5"),
        val,
        el("button", { class: "rm-delay-btn focusable", "aria-label": "Subtitles later", "data-ui": "remote.subdelay", onclick: () => nudge(0.5) }, "+0.5"),
        el("button", { class: "rm-delay-btn focusable", "aria-label": "Reset the timing", "data-ui": "remote.subdelay", onclick: async () => { buzz(); show(0); await cmd("sub_delay", { value: 0 }); } }, "Reset"));
    };
    const rows = [{ label: "Off", value: { id: null }, on: !n.sub }, ...(n.subs || []).map((t) => ({ label: t.label || t.id, sub: t.lang ? t.lang.toUpperCase() : null, value: { id: t.id }, on: n.sub === t.id }))];
    const pick = await sheet("Subtitles", rows, { footer: n.sub ? delayRow : null });
    if (pick) cmd("sub", pick, { done: pick.id ? "Subtitles on" : "Subtitles off" });
  };
  const audioSheet = async () => {
    const n = nowOf();
    if (!n) return;
    const pick = await sheet("Audio", (n.audios || []).map((t) => ({ label: t.label || t.id, sub: t.lang ? t.lang.toUpperCase() : null, value: { id: t.id }, on: n.audio === t.id })));
    if (pick && pick.id !== n.audio) cmd("audio", pick, { done: "Switching the audio…" });
  };
  const pickDevice = async () => {
    const list = getDevices();
    if (!list.length) return;
    const d = await chooseDevice("Your devices", { always: true });
    if (d) select(d.deviceId);
  };
  const renameSheet = async () => {
    const d = dev();
    if (!d) return;
    const input = el("input", { class: "rm-input focusable", type: "text", maxlength: "40", value: d.name, "aria-label": "Name", autocomplete: "off" });
    const save = await sheet(`Name this ${d.kind === "tv" ? "TV" : "device"}`, [{ node: (finish) => {
      const form = el("form", { class: "rm-rename", onsubmit: (e) => { e.preventDefault(); finish({ name: input.value }); } },
        input, el("button", { class: "btn btn-primary focusable", type: "submit", "data-ui": "remote.rename" }, "Save"));
      setTimeout(() => { input.focus(); input.select(); }, 80);
      return form;
    } }]);
    const name = save && String(save.name || "").trim();
    if (!name || name === d.name) return;
    const r = await cmd("rename", { name });
    if (r.ok) toast(`Renamed to ${name}`, "✏️", null, { quiet: true });
  };
  const moreSheet = async () => {
    const d = dev();
    const rows = [];
    if (d) rows.push({ label: `Rename “${d.name}”`, value: "rename", ui: "remote.rename" }); // data-ui
    rows.push({ label: "How it works", sub: "Your phone controls the devices signed in to your profile", value: "help" });
    const pick = await sheet(d ? d.name : "Remote", rows);
    if (pick === "rename") renameSheet();
    if (pick === "help") {
      toast(householdOn() ? "This remote controls your own devices and, as the admin allows, the household's TVs" : "This remote controls the TVs and computers signed in to your profile — open Aurora on one and it shows up", "📱");
    }
  };

  // ---------------------------------------------------------------- which device
  const select = (id) => {
    deviceId = id;
    store.set(LAST_KEY, id || "");
    view.nowId = null;
    lastArt = undefined;
    watchDevice(id);
    const want = `#/remote/${encodeURIComponent(id)}`;
    if (id && location.hash !== want) { try { history.replaceState(history.state, "", want); } catch {} }
    paint();
  };
  const autoPick = () => {
    const list = getDevices();
    if (deviceId && findDevice(deviceId)) return;
    if (deviceId && !findDevice(deviceId) && !list.length) return; // keep it: it may come back (a restart)
    const last = store.get(LAST_KEY);
    const d = (last && findDevice(last)) || list.find((x) => x.state && x.state.now) || list[0];
    if (d && (!deviceId || !findDevice(deviceId))) {
      if (deviceId && deviceId !== d.deviceId && params.id) return paint(); // asked for one by name: say it is gone
      select(d.deviceId);
    }
  };

  // ---------------------------------------------------------------- live
  const offList = onDevices(() => { autoPick(); paint(); });
  const offState = onDeviceState((id) => { if (id === deviceId) paint(); });
  const clock = setInterval(() => { if (!view.paused && !view.dragging && screen.dataset.state === "playing") paintClock(); }, 250);
  // the server's line: the banner, and a fresh subscription once it is back
  const wsWatch = setInterval(() => paint(), 2000);
  if (deviceId) watchDevice(deviceId);
  autoPick();
  if (!deviceId) watchDevice(null);
  // a phone held upright: one view at a time
  setView(store.get(VIEW_KEY) === "pad" ? "pad" : "now");
  paint();
  // a remote control or a keyboard lands on the main button; a finger needs no ring anywhere
  const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  setTimeout(() => {
    if (coarse) { if (screen.contains(document.activeElement)) document.activeElement.blur(); return; }
    const want = screen.dataset.view === "pad" ? touch : screen.dataset.state === "playing" ? playBtn : picker;
    want.focus({ preventScroll: true });
  }, 60);

  const onBack = (e) => { e.preventDefault(); leave(); };
  document.addEventListener("ui-back", onBack);
  function leave() {
    if (history.length > 1) history.back();
    else navigate("#/");
  }

  return () => {
    exited = true;
    offList();
    offState();
    clearInterval(clock);
    clearInterval(wsWatch);
    watchDevice(null);
    document.removeEventListener("ui-back", onBack);
    document.removeEventListener("nav-move", onNavMove);
    document.documentElement.classList.remove("remote-open");
    popScope(screen);
  };
};

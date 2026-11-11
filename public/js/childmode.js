// Children mode (2026-11-11, docs/children-mode.md) — the website's side.
//
// elia: "can we make it just children mode where it cleans the feed and puts
// it in children mode and only after a passcode it returns to normal … it
// happens to the whole account". One account (account = profile): turned on
// here, on the TV or in the phone app, every device signed in to it is
// filtered to the age picked — the server's age gate (src/lib/kids.js) does
// that, this file only asks and paints.
//
//   off → "Who is watching? All ages · 7+ · 12+ · 16+" and Turn on. The very
//         first time the parent also chooses the passcode (twice); after that
//         it is remembered on the account and never asked when turning on.
//   on  → a younger age is one tap (it only restricts); an older one, or
//         leaving, takes the passcode. "Forgot the passcode?" takes the
//         account's own password (or Google), which clears it.
//
// The same words as the TV app (tv-native/src/childMode.ts) and the phone
// app. Loaded only when used (the menu, a socket word, an answer's header).
import { el, toast } from "./ui.js";
import { api } from "./api.js";
import { state, setProfile } from "./state.js";
import { navigate } from "./router.js";
import { pushScope, popScope } from "./focus.js";

export const AGES = [0, 7, 12, 16];
export const ageWords = (a) => (a === 0 ? "All ages" : `${a}+`);
// what the filter keeps, in a line ("titles for all ages", "titles up to 12+")
export const keepsLine = (a) => (a === 0 ? "Only titles rated for all ages." : `Only titles rated ${a}+ and under.`);

const isOn = () => !!(state.profile && state.profile.kids);
const curAge = () => (isOn() ? state.profile.kids.maxAge : null);

// The account changed (here, or on another device): this tab follows. A tab
// on the account becomes a children-mode tab at once — lists dropped and
// asked again, the lock on this browser (setProfile → kidsEnter), the mint
// mark — and back again when it ends. Home is where it lands either way.
// Every device says what happened, in the same words: the one that did it
// and the ones that followed (a person looking at the TV or a phone whose
// page just changed under them is told why). `note` adds the forgot line.
export const applyProfile = async (pub, { note = "" } = {}) => {
  if (!pub || !state.profile || pub.id !== state.profile.id) return;
  const was = curAge();
  const now = pub.kids && typeof pub.kids.maxAge === "number" ? pub.kids.maxAge : null;
  if (was === now) return;
  // (ended elsewhere: this browser's lock is void now — take it off; no
  // passcode is asked for a lock that no longer means anything)
  if (now === null) { try { await api.kidsExit(""); } catch {} }
  await setProfile({ ...state.profile, kids: pub.kids || null, childMode: pub.childMode || null }, state.token);
  if (!location.hash.startsWith("#/play/")) { // (the player finds out on its next request)
    navigate("#/");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }
  if (now === null) toast(`Children mode is off${note ? `. ${note}` : ""}`, "✅");
  else if (was === null) toast(`Children mode is on — ${ageWords(now)}`, "🧸");
  else toast(`Children mode — ${ageWords(now)}`, "🧸");
};

// Ask the server how the account stands now, and follow.
let checking = null;
export const recheck = () => {
  if (checking || !state.profile) return checking;
  const id = state.profile.id;
  checking = api.profiles()
    .then((list) => applyProfile((list || []).find((p) => p.id === id)))
    .catch(() => {})
    .finally(() => { checking = null; });
  return checking;
};
// The socket's word: { type: "child_mode", profileId, childMode }.
export const onWord = (msg) => {
  if (!msg || !state.profile || msg.profileId !== state.profile.id) return;
  const now = msg.childMode && typeof msg.childMode.maxAge === "number" ? msg.childMode.maxAge : null;
  if (now !== curAge()) recheck();
};
// An answer that says who it was filtered for (X-Aurora-Kids) and disagrees
// with this tab: the account changed while this tab was asleep or offline.
export const onAnswer = ({ kids }) => {
  if (!state.profile || state.switching) return;
  const said = kids == null || kids === "" ? null : Number(kids);
  if (said !== curAge()) recheck();
};

// ---------- the sheet ----------
const sheet = (build) => {
  const box = el("div", { class: "look-notice sheet child-sheet", role: "dialog", "aria-label": "Children mode" });
  const wrap = el("div", { class: "look-notice-wrap ui-overlay", onclick: (e) => e.target === wrap && close() }, box);
  const onBack = (e) => { e.preventDefault(); close(); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener("ui-back", onBack);
    document.removeEventListener("keydown", onKey);
    popScope(wrap);
    wrap.classList.add("leaving");
    setTimeout(() => wrap.remove(), 220);
  };
  const show = (nodes) => {
    box.replaceChildren(...nodes.filter(Boolean));
    setTimeout(() => (box.querySelector("[data-first]") || box.querySelector(".focusable"))?.focus({ preventScroll: true }), 40);
  };
  document.addEventListener("ui-back", onBack);
  document.addEventListener("keydown", onKey);
  document.body.append(wrap);
  pushScope(wrap);
  build({ show, close });
};
const codeInput = (placeholder, label) => el("input", {
  type: "password", class: "focusable kids-pin-input child-code", placeholder, "aria-label": label,
  inputmode: "numeric", pattern: "[0-9]*", maxlength: "6", autocomplete: "off",
});
const errLine = () => el("div", { class: "pw-error hidden", role: "alert" }, "");
const say = (line, msg) => { line.textContent = msg; line.classList.toggle("hidden", !msg); };
const chips = (selected, onPick) => el("div", { class: "kids-ages child-ages", role: "radiogroup", "aria-label": "Who is watching?" },
  AGES.map((a) => el("button", {
    class: "chip focusable" + (a === selected ? " on" : ""), type: "button", role: "radio",
    "aria-checked": String(a === selected), "data-age": String(a), "data-ui": "child.age",
    onclick: (e) => onPick(a, e.currentTarget),
  }, ageWords(a))));
const mark = (row, a) => row.querySelectorAll(".chip").forEach((c) => {
  const on = Number(c.dataset.age) === a;
  c.classList.toggle("on", on);
  c.setAttribute("aria-checked", String(on));
});
const label = (text) => el("div", { class: "child-label" }, text);

// Turning on: the age, and the passcode the first time only.
const turnOn = ({ show, close }, view) => {
  let pick = null;
  const first = !view.passcodeSet;
  const code = first ? codeInput("Passcode (4–6 digits)", "Choose a passcode") : null;
  const again = first ? codeInput("Once more", "The passcode once more") : null;
  const err = errLine();
  let busy = false;
  const go = el("button", { class: "btn btn-primary focusable", "data-ui": "child.on", disabled: true }, "Turn on");
  const row = chips(null, (a) => { pick = a; mark(row, a); go.disabled = false; say(err, ""); hint.textContent = keepsLine(a); });
  const hint = el("p", { class: "child-hint" }, "Pick who is watching.");
  const submit = async () => {
    if (busy || pick === null) return;
    say(err, "");
    const body = { maxAge: pick };
    if (first) {
      const c = code.value.trim();
      if (!/^\d{4,6}$/.test(c)) { code.focus(); return say(err, "The passcode is 4 to 6 digits."); }
      if (again.value.trim() !== c) { again.value = ""; again.focus(); return say(err, "Those two don't match."); }
      body.newPasscode = c;
    }
    busy = true;
    go.disabled = true;
    try {
      const r = await api.childModeOn(state.profile.id, body);
      close();
      await applyProfile(r.profile);
    } catch (e) {
      say(err, (e && e.message) || "That didn't work. Try again.");
    } finally {
      busy = false;
      go.disabled = pick === null;
    }
  };
  go.addEventListener("click", submit);
  if (again) again.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  if (code) code.addEventListener("keydown", (e) => { if (e.key === "Enter") again.focus(); });
  row.firstChild.setAttribute("data-first", "");
  show([
    el("div", { class: "sheet-icon", "aria-hidden": "true" }, "🧸"),
    el("div", { class: "look-notice-title" }, "Children mode"),
    el("p", { class: "look-notice-text" }, "Cleans the feed for children on every device signed in to this account. Leaving it takes the passcode."),
    label("Who is watching?"),
    row,
    hint,
    first && el("div", { class: "child-first" },
      label("Choose a passcode"),
      el("div", { class: "field child-field" }, code, again),
      el("p", { class: "child-hint" }, "You need it to leave Children mode. It is asked only this once — Aurora remembers it on this account.")),
    err,
    el("div", { class: "look-notice-actions" },
      el("button", { class: "btn focusable", onclick: () => close() }, "Cancel"),
      go),
  ]);
};

// While on: a younger age is a tap; an older one, or leaving, takes the passcode.
const whileOn = (ctl, view) => {
  const { show, close } = ctl;
  const cur = curAge();
  let pick = cur;
  const code = codeInput("Passcode", "Passcode");
  const err = errLine();
  let busy = false;
  const go = el("button", { class: "btn btn-primary focusable", "data-ui": "child.off" }, "Leave Children mode");
  const prompt = label("Enter the passcode to leave Children mode");
  const paint = () => {
    const raise = pick !== null && pick > cur;
    go.textContent = raise ? `Allow ${ageWords(pick)}` : "Leave Children mode";
    go.dataset.ui = raise ? "child.age" : "child.off";
    prompt.textContent = raise ? `Enter the passcode to allow ${ageWords(pick)}` : "Enter the passcode to leave Children mode";
  };
  const row = chips(cur, async (a) => {
    say(err, "");
    if (a === pick) return;
    if (a < cur) {
      // younger: no passcode (it only restricts)
      try {
        const r = await api.childModeOn(state.profile.id, { maxAge: a });
        close();
        await applyProfile(r.profile);
      } catch (e) { say(err, (e && e.message) || "That didn't work. Try again."); }
      return;
    }
    pick = a;
    mark(row, a);
    paint();
    code.focus();
  });
  const submit = async () => {
    if (busy) return;
    say(err, "");
    const c = code.value.trim();
    if (!/^\d{4,6}$/.test(c)) { code.focus(); return say(err, "The passcode is 4 to 6 digits."); }
    busy = true;
    try {
      const raise = pick !== null && pick > cur;
      const r = raise
        ? await api.childModeOn(state.profile.id, { maxAge: pick, passcode: c })
        : await api.childModeOff(state.profile.id, c);
      close();
      await applyProfile(r.profile);
    } catch (e) {
      code.value = "";
      code.focus();
      say(err, (e && e.message) || "That didn't work. Try again.");
    } finally { busy = false; }
  };
  go.addEventListener("click", submit);
  code.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  code.setAttribute("data-first", "");
  show([
    el("div", { class: "sheet-icon", "aria-hidden": "true" }, "🧸"),
    el("div", { class: "look-notice-title" }, "Children mode"),
    el("p", { class: "look-notice-text" }, `On for this account — ${ageWords(cur)}. ${keepsLine(cur)}`),
    label("Who is watching?"),
    row,
    prompt,
    el("div", { class: "field child-field" }, code),
    err,
    el("button", { class: "child-forgot focusable", type: "button", "data-ui": "child.forgot", onclick: () => forgot(ctl, view) }, "Forgot the passcode?"),
    el("div", { class: "look-notice-actions" },
      el("button", { class: "btn focusable", onclick: () => close() }, "Cancel"),
      go),
  ]);
};

// "Forgot the passcode?": the account's own password (or its Google sign-in)
// turns children mode off and clears the passcode.
const forgot = (ctl, view) => {
  const { show, close } = ctl;
  const ways = view.forgot || {};
  const err = errLine();
  const done = async (r) => {
    close();
    // (if this tab had already followed the socket, it still hears why)
    if (!isOn()) return toast("Children mode is off. You choose a new passcode next time.", "✅");
    await applyProfile(r.profile, { note: "You choose a new passcode next time." });
  };
  const pw = ways.password ? el("input", { type: "password", class: "focusable", placeholder: "Your password", "aria-label": "Your password", autocomplete: "current-password", "data-first": "" }) : null;
  let busy = false;
  const withPassword = async () => {
    if (busy || !pw) return;
    say(err, "");
    if (!pw.value) { pw.focus(); return say(err, "Type your password."); }
    busy = true;
    try { await done(await api.childModeForgot(state.profile.id, { password: pw.value })); }
    catch (e) { pw.value = ""; pw.focus(); say(err, (e && e.message) || "That didn't work. Try again."); }
    finally { busy = false; }
  };
  const withGoogle = async () => {
    say(err, "");
    try {
      const { googleWebFlow } = await import("./google.js");
      const r = await googleWebFlow("childmode");
      if (!r || !r.childReset) return say(err, "That Google sign-in didn't match this account.");
      await done(await api.childModeForgot(state.profile.id, { googleToken: r.childReset.token }));
    } catch (e) { say(err, (e && e.message) || "Google sign-in didn't work. Try again."); }
  };
  if (pw) pw.addEventListener("keydown", (e) => { if (e.key === "Enter") withPassword(); });
  const none = !ways.password && !ways.google;
  show([
    el("div", { class: "sheet-icon", "aria-hidden": "true" }, "🔑"),
    el("div", { class: "look-notice-title" }, "Forgot the passcode?"),
    el("p", { class: "look-notice-text" }, none
      ? `This account has no password to prove it is yours. Ask ${state.adminName || "the admin"} to clear the passcode in the admin page.`
      : "Your account's own password turns Children mode off and clears the passcode. You choose a new one next time."),
    pw && el("div", { class: "field child-field" }, pw),
    err,
    el("div", { class: "look-notice-actions" },
      el("button", { class: "btn focusable", onclick: () => whileOn(ctl, view) }, "Back"),
      ways.google && el("button", { class: "btn focusable", "data-ui": "child.google", onclick: withGoogle }, "Use Google"),
      pw && el("button", { class: "btn btn-primary focusable", "data-ui": "child.forgot", onclick: withPassword }, "Turn off")),
  ]);
};

// The menu's "Children mode" / "Leave Children mode".
export const openChildMode = async () => {
  if (!state.profile) return;
  let view = null;
  try { view = await api.childMode(state.profile.id); } catch (e) {
    return toast((e && e.message) || "Couldn't open Children mode", "⚠️");
  }
  // (the account changed meanwhile on another device: follow it first)
  if (!!view.on !== isOn() || (view.on && view.maxAge !== curAge())) {
    await applyProfile({ ...state.profile, kids: view.on ? { maxAge: view.maxAge } : null, childMode: view.on ? { maxAge: view.maxAge, since: view.since } : null });
  }
  sheet((ctl) => (view.on ? whileOn(ctl, view) : turnOn(ctl, view)));
};

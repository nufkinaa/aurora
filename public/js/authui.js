// The sign-in screens' parts (auth-round, 2026-10-31): one look and one set
// of behaviours for the sign-in, request-access, reset and new-password
// screens (screens/login.js, resetwall.js). docs/auth-round.md has the words
// and the practices this follows:
//   - a visible label above every field, help under it, the error IN PLACE of
//     the help (aria-describedby, aria-invalid), never a cleared field;
//   - the right autocomplete for password managers (username,
//     current-password, new-password, email, name);
//   - Show / Hide on passwords, Caps Lock said out loud;
//   - the rule shown up front on a new password, with a strength hint;
//   - one primary button that says what it does and is held while sending;
//   - Google's own button style (dark theme: #131314, #8E918F, #E3E3E3).
import { el } from "./ui.js";
import { PASSWORD_HELP, passwordStrength, tooManyWords } from "./passrules.js";

// Google's four-colour G (official geometry, inlined — no external assets).
export const GOOGLE_G = `<svg viewBox="0 0 48 48" aria-hidden="true" focusable="false"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`;

let seq = 0;
const uid = (p) => `${p}-${++seq}`;

// "the admin" (closed mode, before a session) starts a sentence with a capital.
export const cap = (s) => String(s || "").replace(/^./, (c) => c.toUpperCase());

// One field: label (+ an optional link on the label's line), input, help/error line.
//   opts: { key, label, type, autocomplete, inputmode, value, help, maxlength,
//           enterkeyhint, aside (a node at the label's end), required }
export const field = (opts) => {
  const id = uid(`af-${opts.key || "f"}`);
  const msgId = `${id}-msg`;
  const input = el("input", {
    id,
    name: opts.key,
    type: opts.type || "text",
    autocomplete: opts.autocomplete || "off",
    inputmode: opts.inputmode || null,
    enterkeyhint: opts.enterkeyhint || null,
    maxlength: opts.maxlength || null,
    autocapitalize: opts.autocapitalize || "none",
    autocorrect: "off",
    spellcheck: "false",
    class: "af-input focusable",
    "aria-describedby": msgId,
    "aria-required": opts.required ? "true" : null,
    dir: "auto",
  });
  if (opts.value) input.value = opts.value;
  const help = opts.help || "";
  const msg = el("p", { class: "af-msg", id: msgId, "aria-live": "polite" }, help);
  const labelRow = el("div", { class: "af-labelrow" },
    el("label", { class: "af-label", for: id }, opts.label),
    opts.aside || null);
  const box = el("div", { class: "af-box" }, input);
  const wrap = el("div", { class: "af-field" }, labelRow, box, msg);
  const f = {
    key: opts.key, wrap, input, box, msg,
    value: () => input.value,
    setError: (text) => {
      wrap.classList.add("invalid");
      input.setAttribute("aria-invalid", "true");
      msg.textContent = text;
    },
    clearError: () => {
      if (!wrap.classList.contains("invalid")) return;
      wrap.classList.remove("invalid");
      input.removeAttribute("aria-invalid");
      msg.textContent = f.help;
    },
    help,
    focus: () => input.focus({ preventScroll: false }),
  };
  input.addEventListener("input", () => f.clearError());
  return f;
};

// A password field: Show / Hide, Caps Lock, and (for a NEW password) the rule
// up front and a strength line. `personal`: () => [name, username, email].
export const passwordField = (opts) => {
  const f = field({ ...opts, type: "password", help: opts.isNew ? PASSWORD_HELP : opts.help || "" });
  const toggle = el("button", {
    type: "button", class: "af-reveal focusable",
    "aria-controls": f.input.id, "aria-pressed": "false",
  }, "Show");
  toggle.addEventListener("click", () => {
    const shown = f.input.type === "password";
    f.input.type = shown ? "text" : "password";
    toggle.textContent = shown ? "Hide" : "Show";
    toggle.setAttribute("aria-pressed", String(shown));
    toggle.setAttribute("aria-label", shown ? "Hide password" : "Show password");
    f.input.focus();
  });
  toggle.setAttribute("aria-label", "Show password");
  f.box.append(toggle);
  const caps = el("p", { class: "af-caps", hidden: true }, "Caps Lock is on.");
  f.wrap.insertBefore(caps, f.msg);
  const capsCheck = (e) => {
    if (!e || typeof e.getModifierState !== "function") return;
    caps.hidden = !e.getModifierState("CapsLock");
  };
  f.input.addEventListener("keydown", capsCheck);
  f.input.addEventListener("keyup", capsCheck);
  f.input.addEventListener("blur", () => { caps.hidden = true; });
  if (opts.isNew) {
    const bars = el("span", { class: "af-bars", "aria-hidden": "true" }, el("i"), el("i"), el("i"), el("i"));
    const word = el("span", { class: "af-strength-word" }, "");
    const meter = el("div", { class: "af-strength", "data-score": "0", hidden: true }, bars, word);
    f.wrap.insertBefore(meter, caps);
    f.input.setAttribute("aria-describedby", `${f.msg.id}`);
    const paint = () => {
      const v = f.input.value;
      if (!v) { meter.hidden = true; return; }
      const s = passwordStrength(v, opts.personal ? opts.personal() : []);
      meter.hidden = false;
      meter.dataset.score = String(s.score);
      word.textContent = `Strength: ${s.label}`;
    };
    f.input.addEventListener("input", paint);
    f.paintStrength = paint;
  }
  f.reveal = toggle;
  return f;
};

// The primary button: says what it does; while sending it is held and says so.
export const primaryButton = (label, busyLabel) => {
  const text = el("span", { class: "af-btn-text" }, label);
  const b = el("button", { type: "submit", class: "af-btn primary focusable" }, el("span", { class: "af-spin", "aria-hidden": "true" }), text);
  b.busy = (on) => {
    b.disabled = !!on;
    b.classList.toggle("busy", !!on);
    b.setAttribute("aria-busy", on ? "true" : "false");
    text.textContent = on ? busyLabel || label : label;
  };
  return b;
};

// "Continue with Google" — Google's dark button (branding guidelines: the
// standard G, #131314 fill, #8E918F 1px stroke, #E3E3E3 text, the wording
// Google allows).
export const googleButton = (label, onclick) =>
  el("button", { type: "button", class: "af-btn google focusable", onclick },
    el("span", { class: "af-g", html: GOOGLE_G }), el("span", {}, label));

// A line for errors that belong to no single field.
export const formError = () => {
  const n = el("p", { class: "af-formerr", role: "alert", hidden: true });
  n.show = (text) => { n.textContent = text; n.hidden = false; };
  n.clear = () => { n.hidden = true; n.textContent = ""; };
  return n;
};

// A server refusal → the words, placed: next to its field when the server
// named one this form has, otherwise on the form's line. Never clears input.
export const placeError = (e, fields, formErr) => {
  const status = e && e.status;
  let text = (e && e.message) || "";
  if (!status || /Failed to fetch|NetworkError|Load failed|timed out|Cannot reach/i.test(text)) {
    text = "Can't reach Aurora. Check your connection and try again.";
  } else if (status === 429) {
    text = /^Too many tries/.test(text) ? text : tooManyWords(e.retryAfter);
  } else if (status >= 500) {
    text = text && !/^\d{3} /.test(text) ? text : "Something went wrong on the server. Try again in a moment.";
  }
  text = cap(text);
  if (text && !/[.!?]$/.test(text)) text += ".";
  const f = e && e.field && fields.find((x) => x && x.key === e.field);
  if (f) {
    f.setError(text);
    f.focus();
  } else {
    formErr.show(text);
  }
  return text;
};

// The screen's frame: the Beam mark and the word. The mark is the nav's own
// (components.css .nav-logo .logo-mark, written by docs/brand/tools/build.py):
// borrowed from the page rather than copied, so a new logo reaches here too.
let markImage = null;
const beamImage = () => {
  if (markImage) return markImage;
  try {
    const n = document.querySelector(".nav-logo .logo-mark");
    const bg = n ? getComputedStyle(n).backgroundImage : "";
    if (bg && bg !== "none") markImage = bg;
  } catch {}
  return markImage;
};
export const brand = () => {
  const mark = el("span", { class: "auth-mark", "aria-hidden": "true" });
  const img = beamImage();
  if (img) mark.style.backgroundImage = img;
  return el("div", { class: "auth-brand" }, mark, el("span", { class: "auth-wordmark" }, "Aurora"));
};

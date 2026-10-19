// Voice search on the website: a microphone button in the search field.
//
// The browser's own speech recognition (the Web Speech API — Chrome, Edge and
// Safari have it; Firefox does not) hears; the words appear in the field as
// they are said, and the final words run the same server search as typing
// (search.js → /api/search?v=2&voice=1, where media/spoken.js tidies the
// sentence: "search for the movie Inception" → Inception). The TV app does the
// same with the remote's microphone (tv-native/src/voice.ts); the rules — the
// language, each moment, the words — are voicelogic.js, shared with the TV.
//
// The button is not drawn where it cannot work: no recogniser in this browser,
// or a page that is not a secure context (a microphone is only offered to
// https:// and localhost — the household's plain http://192.168… address
// gets none).
//
// The language: the person's (profile prefs `voiceLang`, the same on every
// device), else this browser's. The switch beside the words changes it — for
// this person, everywhere — and starts listening again in the other one.
import { el } from "./ui.js";
import { state, setPersonPref } from "./state.js";
import { bcp47, LANG_NAME, LANG_SELF, otherLang, voiceActive, voiceLangFor, voiceMessage, voiceReduce, VOICE_IDLE } from "./voicelogic.js";

export const speechCtor = () => {
  if (typeof window === "undefined") return null;
  if (window.isSecureContext === false) return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
};

// the TV's mic glyph (tv-native/src/components/Icon.tsx 'mic'), path for path
const MIC =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">' +
  '<path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg>';

const personLang = () => voiceLangFor(state.profile && state.profile.prefs && state.profile.prefs.voiceLang, navigator.language);

// attachVoice(box, input, { onInterim(text), onHeard(text), onCancel() })
//   → { mic, panel, stop() } — or null where voice search cannot work (nothing
//   is added to the page then).
export const attachVoice = (box, input, { onInterim, onHeard, onCancel } = {}) => {
  const Ctor = speechCtor();
  if (!Ctor) return null;

  let vs = { ...VOICE_IDLE, lang: personLang() };
  let rec = null;
  let session = 0;
  let before = ""; // what the field held when the mic was pressed (Escape puts it back)

  const mic = el("button", {
    "data-ui": "search.voice",
    class: "search-mic focusable",
    type: "button",
    "aria-label": "Search by voice",
    "aria-pressed": "false",
    title: "Search by voice",
    html: MIC,
    onclick: () => (voiceActive(vs) ? finish() : start()),
  });
  const words = el("span", { class: "voice-text" });
  const langBtn = el("button", {
    "data-ui": "search.voice.lang",
    class: "voice-lang chip focusable",
    type: "button",
    onclick: () => switchLang(),
  });
  const panel = el("div", { class: "voice-panel hidden", role: "status", "aria-live": "polite" },
    el("span", { class: "voice-dot", "aria-hidden": "true" }), words, langBtn);

  const paint = () => {
    const active = voiceActive(vs);
    mic.classList.toggle("listening", active);
    mic.setAttribute("aria-pressed", active ? "true" : "false");
    mic.setAttribute("aria-label", active ? "Stop listening" : "Search by voice");
    box.classList.toggle("voice-on", active);
    input.classList.toggle("voice-interim", active);
    // while words are coming they are the message; the line still says which language
    const text = voiceMessage(vs, "web") || (active ? `Listening in ${LANG_NAME[vs.lang]}` : "");
    words.textContent = text;
    panel.classList.toggle("voice-error", vs.phase === "error");
    panel.classList.toggle("hidden", !(active || vs.phase === "error"));
    langBtn.textContent = LANG_SELF[otherLang(vs.lang)];
    langBtn.setAttribute("aria-label", `Listening in ${LANG_NAME[vs.lang]}. Listen in ${LANG_NAME[otherLang(vs.lang)]} instead`);
    langBtn.classList.toggle("hidden", !(active || vs.error === "language" || vs.error === "no-match" || vs.error === "no-speech"));
  };
  const dispatch = (ev, mine) => {
    if (mine !== undefined && mine !== session) return; // a late word from a recogniser that was stopped
    const was = vs;
    vs = voiceReduce(vs, ev);
    if (vs.phase === "listening" && vs.interim !== was.interim) {
      input.value = vs.interim;
      if (onInterim) onInterim(vs.interim);
    }
    if (vs.phase === "heard" && was.phase !== "heard") {
      const text = vs.text;
      input.value = text;
      release();
      vs = voiceReduce(vs, { type: "done" });
      paint();
      if (onHeard) onHeard(text);
      return;
    }
    if (vs.phase === "error" || vs.phase === "idle") release();
    paint();
  };
  const release = () => {
    const r = rec;
    rec = null;
    session++;
    if (r) {
      r.onresult = r.onerror = r.onend = r.onstart = null;
      try { r.abort(); } catch {}
    }
  };

  // Chrome says "not-allowed" both when the person just said no and when the
  // site is blocked for good; the permission's state tells them apart.
  const blocked = async () => {
    try {
      const p = await navigator.permissions.query({ name: "microphone" });
      return p.state === "denied";
    } catch {
      return false;
    }
  };

  const start = (lang = vs.phase === "idle" || vs.phase === "error" ? personLang() : vs.lang) => {
    release();
    if (!voiceActive(vs)) before = input.value;
    dispatch({ type: "start", lang });
    const mine = session;
    let r;
    try {
      r = new Ctor();
    } catch {
      return dispatch({ type: "unavailable" }, mine);
    }
    rec = r;
    r.lang = bcp47(lang);
    r.interimResults = true;
    r.continuous = false;
    r.maxAlternatives = 1;
    r.onstart = () => dispatch({ type: "ready" }, mine);
    r.onresult = (e) => {
      let finalText = "";
      let interim = "";
      for (let i = 0; i < e.results.length; i++) {
        const res = e.results[i];
        const t = res && res[0] ? res[0].transcript : "";
        if (res.isFinal) finalText += t;
        else interim += t;
      }
      if (finalText.trim()) dispatch({ type: "final", text: finalText }, mine);
      else dispatch({ type: "partial", text: interim }, mine);
    };
    r.onerror = async (e) => {
      const code = e && e.error;
      if (code === "not-allowed" && (await blocked())) return dispatch({ type: "error", code: "service-not-allowed" }, mine);
      dispatch({ type: "error", code }, mine);
    };
    r.onend = () => dispatch({ type: "end" }, mine);
    try {
      r.start();
    } catch {
      dispatch({ type: "error", code: "busy" }, mine);
    }
  };
  // The mic pressed again while listening: what has been heard is the answer.
  const finish = () => {
    if (!rec) return;
    if (vs.interim) return dispatch({ type: "final", text: vs.interim }, session);
    try { rec.stop(); } catch { dispatch({ type: "cancel" }); }
  };
  const cancel = () => {
    if (!voiceActive(vs) && vs.phase !== "error") return;
    const wasActive = voiceActive(vs);
    dispatch({ type: "cancel" });
    if (wasActive) {
      input.value = before;
      if (onCancel) onCancel(before);
    }
  };
  // the language, for this person everywhere; listening again in it
  const switchLang = () => {
    const next = otherLang(vs.lang);
    setPersonPref("voiceLang", next);
    start(next);
  };

  // Escape while listening stops listening — wherever focus is (the field, the
  // mic, the language switch): it must not also be the app's Back
  const onKey = (e) => {
    if (e.key !== "Escape" || !voiceActive(vs)) return;
    if (!input.isConnected) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    cancel();
  };
  window.addEventListener("keydown", onKey, true); // (before focus.js, which reads Escape as Back on the document)
  // typing takes over from the microphone
  input.addEventListener("input", () => {
    if (voiceActive(vs) || vs.phase === "error") {
      release();
      vs = { ...VOICE_IDLE, lang: vs.lang };
      paint();
    }
  });
  paint();
  const stop = () => {
    release();
    vs = { ...VOICE_IDLE, lang: vs.lang };
    paint();
    window.removeEventListener("keydown", onKey, true);
  };
  return { mic, panel, stop, cancel };
};

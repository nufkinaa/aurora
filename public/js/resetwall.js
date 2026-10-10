// "Pick a new password" — the screen a forced reset puts in front of
// everything (the admin's People → "Reset password").
//
// The server is what forces it: a profile that owes a new password is signed
// out everywhere, and what its current password yields afterwards opens
// nothing but the route that saves a new one (src/lib/resetgate.js). This
// screen is the polite half, and it BLOCKS: no close button, no click-outside,
// Escape and Back do nothing, and a reload or a deep link comes straight back
// to it (boot asks /api/me, and any request the server refuses for this
// reason raises it — main.js). It offers two things: set the new password, or
// sign out.
//
// Who may save it: whoever knows the CURRENT password. A sign-in that has
// just typed it (the sign-in screen, the wall's unlock) hands it over and is
// not asked again; any other way here — a reload, a Google sign-in — asks for
// it. Someone who has forgotten it needs the admin ("Set password").
import { el, toast } from "./ui.js";
import { api, setAuthToken } from "./api.js";
import { state } from "./state.js";
import { pushScope, popScope } from "./focus.js";
import { reconnect } from "./ws.js";

const MIN_PW = 4; // as everywhere (routes/profiles.js MIN_PASSWORD)

let up = null; // the one wall on screen — a second ask gets the same promise
export const resetWallUp = () => !!up;

// opts.profile          { id, name, avatar } — whose password
// opts.currentPassword  the password just typed, or null to ask for it
// opts.token            the (restricted) unlock token to ask with, when there
//                       is no sign-in session — a profile with no username
// Resolves { token, session?, user? } — this device's fresh credentials —
// once a new password is saved. "Sign out" never resolves: the page reloads.
export const showResetWall = (opts = {}) => {
  if (up) return up;
  const profile = opts.profile || {};
  if (opts.token) setAuthToken(opts.token);
  const known = typeof opts.currentPassword === "string" && opts.currentPassword !== "";

  up = new Promise((resolve) => {
    const current = known ? null
      : el("input", { type: "password", class: "focusable", placeholder: "Current password", autocomplete: "current-password" });
    const input = el("input", { type: "password", class: "focusable", placeholder: `New password (${MIN_PW}+ characters)`, autocomplete: "new-password" });
    const again = el("input", { type: "password", class: "focusable", placeholder: "Once more", autocomplete: "new-password" });
    const err = el("div", { class: "pw-error hidden", role: "alert" }, "");
    const fail = (msg) => { err.textContent = msg; err.classList.remove("hidden"); };
    const save = el("button", { class: "btn btn-primary focusable", type: "button" }, "Set new password");
    const out = el("button", { class: "btn focusable", type: "button" }, "Sign out");

    // Back / Escape: swallowed before anything behind this screen hears them
    // (the router, a sheet that was open when the refusal arrived).
    const onBack = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
    let wrap = null;
    const close = () => {
      window.removeEventListener("ui-back", onBack, true);
      popScope(wrap);
      wrap.remove();
      up = null;
    };

    let busy = false;
    const leave = (message) => {
      // this sign-in is over (another device finished the reset, or the admin
      // signed the profile out again): nothing here can go through any more
      fail(message);
      setTimeout(() => location.reload(), 1800);
    };
    const submit = async () => {
      if (busy) return;
      err.classList.add("hidden");
      const cur = known ? opts.currentPassword : current.value;
      if (!cur) { fail("Your current password first."); return current.focus(); }
      if (input.value.length < MIN_PW) { fail(`At least ${MIN_PW} characters.`); return input.focus(); }
      if (input.value !== again.value) { fail("They don't match."); return again.focus(); }
      if (input.value === cur) { fail("That is the old password — pick a different one."); return input.focus(); }
      busy = true;
      save.disabled = true;
      try {
        const r = await api.setPassword(profile.id, input.value, cur, state.clientId);
        // The answer carries this device's fresh credentials; everything the
        // profile held before is gone. Kept the way an unlock keeps them, so
        // a reload stays inside.
        const token = (r && r.token) || null;
        setAuthToken(token);
        try {
          if (token) sessionStorage.setItem(`aurora-token-${profile.id}`, token);
          localStorage.setItem("aurora-profile", profile.id);
        } catch {}
        if (r && r.user) state.user = r.user;
        // the socket connected as a stranger's (the server drops what a
        // must-reset sign-in says): connect again, signed in
        reconnect();
        close();
        toast("New password saved — it's your sign-in password too", "✅");
        resolve({ token, session: (r && r.session) || null, user: (r && r.user) || null });
      } catch (e) {
        const msg = (e && e.message) || "";
        const wrong = /wrong password|current password is wrong/i.test(msg);
        if (wrong) {
          if (current) { current.value = ""; current.focus(); }
          fail(known ? "The password you signed in with is no longer the current one. Sign out and sign in again."
            : "That is not the current password.");
        } else if (e && (e.code === "same" || e.code === "needed" || e.status === 400 || e.status === 429)) {
          fail(msg ? msg.replace(/^./, (c) => c.toUpperCase()) + (/[.!?]$/.test(msg) ? "" : ".") : "Couldn't save it. Try again.");
        } else if (e && (e.status === 401 || e.status === 403 || e.status === 404)) {
          leave("This sign-in has ended. One moment…");
        } else {
          fail("Couldn't reach Aurora. Try again in a moment.");
        }
      } finally {
        busy = false;
        save.disabled = false;
      }
    };
    const signOut = async () => {
      if (busy) return;
      busy = true;
      out.disabled = true;
      // the session and the restricted unlock both end on the server
      try { await api.logout(); } catch {}
      setAuthToken(null);
      try {
        localStorage.removeItem("aurora-profile");
        if (profile.id) sessionStorage.removeItem(`aurora-token-${profile.id}`);
      } catch {}
      location.reload(); // boot knows where a tab without a sign-in belongs
    };

    save.addEventListener("click", submit);
    out.addEventListener("click", signOut);
    if (current) current.addEventListener("keydown", (e) => { if (e.key === "Enter") input.focus(); });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") again.focus(); });
    again.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });

    const box = el("div", { class: "modal reset-wall-box", role: "dialog", "aria-modal": "true", "aria-label": "Pick a new password" },
      el("h2", {}, `${profile.avatar || "🔑"} Pick a new password`),
      el("p", { class: "field-hint reset-wall-why" },
        `${state.adminName} asked for a new password for “${profile.name || "this profile"}”. It has been signed out everywhere, and nothing else works on it until a new one is saved.`),
      current && el("div", { class: "field" }, el("label", {}, "Current password"), current),
      el("div", { class: "field" }, el("label", {}, "New password"), input),
      el("div", { class: "field" }, el("label", {}, "Once more"), again, err),
      el("div", { class: "reset-wall-actions" }, save, out),
      el("p", { class: "field-hint reset-wall-forgot" },
        `Don't remember the current one? ${state.adminName} can set a password for you.`),
    );
    wrap = el("div", { class: "ui-overlay reset-wall" }, box);
    window.addEventListener("ui-back", onBack, true);
    document.body.append(wrap);
    pushScope(wrap);
    setTimeout(() => (current || input).focus(), 50);
  });
  return up;
};

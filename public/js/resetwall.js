// "Choose a new password" / "Set a password" — the screen a due password puts
// in front of everything:
//   - a forced reset (the admin's People → "Reset password"), or
//   - a FIRST password, owed by a profile that signs in with Google only
//     (auth-round, 2026-10-31: elia, signing up with Google without a
//     password "is not good at all" — `opts.passwordSetup`).
//
// The server is what forces it: until a password is saved, every credential
// of that profile opens nothing but the routes that save one
// (src/lib/resetgate.js). This screen is the polite half, and it BLOCKS: no
// close button, no click-outside, Escape and Back do nothing, and a reload or
// a deep link comes straight back to it (boot asks /api/me, and any request
// the server refuses for this reason raises it — main.js). It offers two
// things: save the password, or sign out. It wears the sign-in screens' look
// (authui.js, the night sky and one panel).
//
// Who may save a NEW password: whoever knows the CURRENT one — a sign-in
// that has just typed it hands it over — or a session the server trusts to
// change it without (signed in moments ago, or the person's own phone or
// browser: /api/auth/password/options). A first password asks for nothing.
import { el, toast } from "./ui.js";
import { api, setAuthToken } from "./api.js";
import { state } from "./state.js";
import { pushScope, popScope } from "./focus.js";
import { reconnect } from "./ws.js";
import { initAuroraSky } from "./aurora-sky.js";
import { passwordProblem } from "./passrules.js";
import { cap, passwordField, primaryButton, formError, placeError, brand } from "./authui.js";

let up = null; // the one wall on screen — a second ask gets the same promise
export const resetWallUp = () => !!up;

// opts.profile          { id, name, avatar } — whose password
// opts.currentPassword  the password just typed, or null to ask for it
// opts.token            the (restricted) unlock token to ask with, when there
//                       is no sign-in session — a profile with no username
// opts.passwordSetup    a first password (no current one exists)
// Resolves { token, session?, user? } — this device's fresh credentials —
// once a password is saved. "Sign out" never resolves: the page reloads.
export const showResetWall = (opts = {}) => {
  if (up) return up;
  const profile = opts.profile || {};
  if (opts.token) setAuthToken(opts.token);
  const setup = !!opts.passwordSetup;
  const known = typeof opts.currentPassword === "string" && opts.currentPassword !== "";
  const admin = cap(state.adminName || "the admin");

  up = new Promise((resolve) => {
    const formErr = formError();
    const current = known || setup ? null
      : passwordField({ key: "currentPassword", label: "Current password", autocomplete: "current-password", required: true, enterkeyhint: "next" });
    const fresh = passwordField({ key: "newPassword", label: setup ? "Password" : "New password", autocomplete: "new-password", isNew: true, personal: () => [profile.name], required: true, enterkeyhint: "next" });
    const again = passwordField({ key: "confirm", label: "Confirm password", autocomplete: "new-password", required: true, enterkeyhint: "go" });
    const hiddenUser = el("input", { type: "text", name: "username", autocomplete: "username", value: profile.name || "", hidden: true, "aria-hidden": "true", tabindex: "-1" });
    const save = primaryButton(setup ? "Save password" : "Save new password", "Saving…");
    const out = el("button", { type: "button", class: "auth-link focusable" }, "Sign out");
    const forgotNote = el("p", { class: "auth-hint", hidden: !current },
      `Don't remember it? Sign out, then use "Forgot password?" on the sign-in screen, or ask ${state.adminName || "the admin"}.`);
    // without the current password, when the server trusts this session
    let trusted = false;
    if (current) {
      api.passwordOptions().then((o) => {
        if (!o || o.needsCurrent || !current.wrap.isConnected) return;
        trusted = true;
        current.wrap.remove();
        forgotNote.hidden = true;
      }).catch(() => {});
    }

    // Back / Escape: swallowed before anything behind this screen hears them
    // (the router, a sheet that was open when the refusal arrived).
    const onBack = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
    let wrap = null;
    let stopSky = () => {};
    const close = () => {
      window.removeEventListener("ui-back", onBack, true);
      stopSky();
      popScope(wrap);
      wrap.remove();
      up = null;
    };

    let busy = false;
    const leave = (message) => {
      // this sign-in is over (another device finished the reset, or the admin
      // signed the profile out again): nothing here can go through any more
      formErr.show(message);
      setTimeout(() => location.reload(), 1800);
    };
    const submit = async () => {
      if (busy) return;
      formErr.clear();
      const askCurrent = !!current && !trusted;
      const cur = known ? opts.currentPassword : askCurrent ? current.value() : "";
      if (askCurrent && !cur) { current.setError("Enter your current password."); return current.focus(); }
      const bad = passwordProblem(fresh.value());
      if (bad) { fresh.setError(bad); return fresh.focus(); }
      if (fresh.value() !== again.value()) { again.setError("The passwords don't match."); return again.focus(); }
      if (cur && fresh.value() === cur) { fresh.setError("That's the old password. Choose a different one."); return fresh.focus(); }
      busy = true;
      save.busy(true);
      try {
        const r = cur
          ? await api.setPassword(profile.id, fresh.value(), cur, state.clientId)
          : await api.changePassword(fresh.value(), undefined, false, state.clientId);
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
        toast(setup ? "Password saved. You can sign in with it anywhere." : "New password saved. It's your sign-in password too.", "✅");
        resolve({ token, session: (r && r.session) || null, user: (r && r.user) || null });
      } catch (e) {
        const msg = (e && e.message) || "";
        if (/wrong password|current password is wrong/i.test(msg)) {
          if (current && current.wrap.isConnected) {
            current.setError("That's not the current password.");
            current.focus();
          } else {
            formErr.show("The password you signed in with is no longer the current one. Sign out and sign in again.");
          }
        } else if (e && (e.code === "same" || e.code === "needed" || e.code === "short" || e.status === 400 || e.status === 429)) {
          placeError(e, [current, fresh, again], formErr);
        } else if (e && (e.status === 401 || e.status === 403 || e.status === 404)) {
          if (e.field === "currentPassword" && current) {
            if (!current.wrap.isConnected) { trusted = false; forgotNote.before(current.wrap); forgotNote.hidden = false; }
            current.setError("Enter your current password.");
            current.focus();
          } else {
            leave("This sign-in has ended. One moment…");
          }
        } else {
          formErr.show("Can't reach Aurora. Check your connection and try again.");
        }
      } finally {
        busy = false;
        save.busy(false);
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
    out.addEventListener("click", signOut);
    const chain = [current, fresh, again].filter(Boolean);
    chain.forEach((f, i) => f.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && chain[i + 1] && chain[i + 1].wrap.isConnected) { e.preventDefault(); chain[i + 1].focus(); }
    }));

    const formNode = el("form", { class: "auth-form", novalidate: true },
      hiddenUser, current && current.wrap, forgotNote, fresh.wrap, again.wrap, formErr, save);
    formNode.addEventListener("submit", (e) => { e.preventDefault(); submit(); });
    const panel = el("main", { class: "auth-panel reset-panel reset-wall-box", role: "dialog", "aria-modal": "true", "aria-labelledby": "reset-wall-title" },
      brand(),
      el("h1", { class: "auth-title", id: "reset-wall-title" }, setup ? "Set a password" : "Choose a new password"),
      el("p", { class: "auth-lede reset-wall-why" }, setup
        ? `“${profile.name || "Your profile"}” signs in with Google only. Add a password so you can sign in anywhere.`
        : `${admin} asked for a new password on “${profile.name || "this profile"}”. It has been signed out everywhere, and nothing else works on it until a new one is saved.`),
      formNode,
      el("p", { class: "auth-foot" }, out),
    );
    const sky = el("canvas", { class: "login-sky", "aria-hidden": "true" });
    wrap = el("div", { class: "ui-overlay login-wrap reset-wall" }, sky, el("div", { class: "auth-shell" }, panel));
    window.addEventListener("ui-back", onBack, true);
    document.body.append(wrap);
    stopSky = initAuroraSky(sky);
    pushScope(wrap);
    setTimeout(() => {
      const a = document.activeElement;
      if (a && a !== document.body && panel.contains(a)) return; // already typing
      (current || fresh).input.focus();
    }, 50);
  });
  return up;
};

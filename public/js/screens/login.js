// The sign-in screens (prompt 10; redesigned in the sign-in round, 2026-10-31,
// docs/auth-round.md). The night sky with the real aurora painter is the
// ground; one glass panel carries every step:
//
//   Sign in · Request access     (a switch at the top of the panel)
//   Request access with Google   (Google verifies, the request still needs a password)
//   Reset your password          (Google · ask the admin · a reset code · email when on)
//   Choose a new password        (a reset token from any of those, or an emailed link)
//   Google's code flow           (where the popup can't run: a server reached by IP)
//
// ACCOUNT = PROFILE: a successful sign-in resolves with the profile and an
// unlock token, so boot walks straight in with no second password prompt.
// Shown at boot only when the wall is CLOSED; in transition mode it can be
// summoned voluntarily (opts.skippable adds a way out). opts.view:
// "signup" (the wall's Add profile), "forgot" (with opts.profile: the wall's
// "Forgot password?"), "reset" (opts.token: an emailed link).
import { el, toast } from "../ui.js";
import { api } from "../api.js";
import { state } from "../state.js";
import { pushScope, popScope } from "../focus.js";
import { initAuroraSky } from "../aurora-sky.js";
import { googleFlavor, googleWebFlow } from "../google.js";
import { passwordProblem } from "../passrules.js";
import {
  GOOGLE_G, cap, field, passwordField, primaryButton, googleButton, formError, placeError, brand,
} from "../authui.js";

export { GOOGLE_G };

// "Get the apps": a quiet way to the product page (/install — the TV, phone
// and computer apps) at the foot of the panel. Same words as the profile
// menu's item.
const getAppsLink = () =>
  el("p", { class: "auth-apps" },
    el("a", { href: "/install", class: "auth-link dim focusable", "data-ui": "signin.getapps" }, "Get the apps"));

// the admin's name: at the start of a sentence, and inside one
const admin = () => cap(state.adminName || "the admin");
const adminIn = () => state.adminName || "the admin";

// Resolves with the full login/claim response ({user, profile, profileToken})
// or null when skipped.
export const showLoginScreen = (opts = {}) =>
  new Promise((resolve) => {
    const sky = el("canvas", { class: "login-sky", "aria-hidden": "true" });
    const panel = el("main", { class: "auth-panel login-card", "aria-labelledby": "auth-title" });
    const shell = el("div", { class: "auth-shell login-gate" }, panel);
    const wrap = el("div", { class: "ui-overlay login-wrap" }, sky, shell);

    let stopSky = () => {};
    let polling = null; // the ask-the-admin waiting screen's timer
    const stopPolling = () => { if (polling) { clearTimeout(polling); polling = null; } };
    const cleanup = () => {
      stopPolling();
      stopSky();
      popScope(wrap);
      wrap.remove();
    };
    // `typed`: the password this sign-in just verified (none for Google).
    const done = async (res, typed = null) => {
      cleanup();
      // A new password is due on this profile (the admin's Reset password,
      // or a first one for a Google-only profile): what this sign-in yielded
      // opens nothing else on the server, so nothing else is shown — the
      // blocking screen (resetwall.js), for every way of signing in.
      if (res && res.mustReset && res.profile) {
        try {
          localStorage.setItem("aurora-profile", res.profile.id);
          if (res.profileToken) sessionStorage.setItem(`aurora-token-${res.profile.id}`, res.profileToken);
        } catch {}
        const { showResetWall } = await import("../resetwall.js");
        const fresh = await showResetWall({
          profile: res.profile, currentPassword: typed, token: res.profileToken || null, passwordSetup: !!res.passwordSetup,
        });
        res = {
          ...res,
          mustReset: false,
          profileToken: fresh.token || null,
          session: fresh.session || res.session,
          user: fresh.user || res.user,
        };
      }
      opts.onSignedIn?.(res && res.user);
      resolve(res);
    };

    let serverInfo = null; // {googleWeb, googleDevice, ...} once fetched
    let resetInfo = null; // {google, email, admin}
    const infoReady = Promise.all([
      api.serverInfo().then((i) => {
        // with the wall closed this screen comes before anything else has
        // asked: its own copy (and the reset sheet) name the admin
        if (i && i.adminName) state.adminName = i.adminName;
        return (serverInfo = i);
      }).catch(() => null),
      api.resetOptions().then((o) => (resetInfo = o)).catch(() => null),
    ]);

    const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
    // One step on screen at a time. `focusEl`: where the keyboard starts.
    const setView = (nodes, focusEl) => {
      stopPolling();
      panel.innerHTML = "";
      panel.append(brand(), ...nodes.filter(Boolean));
      if (!calm) {
        panel.classList.remove("view-in");
        void panel.offsetWidth;
        panel.classList.add("view-in");
      }
      // (only if nothing in the panel has the focus by then: a person — or a
      // password manager — that is already typing keeps their field)
      setTimeout(() => {
        const a = document.activeElement;
        if (a && a !== document.body && panel.contains(a)) return;
        focusEl?.focus({ preventScroll: true });
      }, calm ? 30 : 120);
    };
    const title = (text) => el("h1", { class: "auth-title", id: "auth-title" }, text);
    const lede = (...kids) => el("p", { class: "auth-lede" }, ...kids);
    const form = (onSubmit, ...kids) => {
      const f = el("form", { class: "auth-form", novalidate: true }, ...kids);
      f.addEventListener("submit", (e) => { e.preventDefault(); onSubmit(); });
      return f;
    };
    const back = (label, fn) => el("button", { type: "button", class: "auth-link focusable", onclick: fn }, label);

    // The switch between the two front doors.
    const tabs = (current) => {
      const mk = (key, label, go) => el("button", {
        type: "button", role: "tab", class: `auth-tab focusable${current === key ? " on" : ""}`,
        "aria-selected": current === key ? "true" : "false", tabindex: current === key ? "0" : "-1",
        "data-ui": `signin.tab.${key}`,
        onclick: () => { if (current !== key) go(); },
      }, label);
      const t = el("div", { class: "auth-tabs", role: "tablist", "aria-label": "Sign in or request access" },
        mk("signin", "Sign in", () => signinView()),
        mk("request", "Request access", () => signupView()));
      // arrow keys move along the tabs (the tablist pattern)
      t.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        e.stopPropagation();
        current === "signin" ? signupView() : signinView();
      });
      return t;
    };

    // One entry point for every Google button: the web popup where the
    // browser can use it (localhost/domain), the code flow otherwise.
    // purpose: "login", "signup" or "reset".
    const doGoogle = async (purpose, formErr) => {
      const flavor = googleFlavor(serverInfo);
      if (flavor === "web") {
        try {
          const r = await googleWebFlow(purpose);
          if (r.reset) return newPasswordView({ token: r.reset.token, name: r.reset.name, via: "google" });
          if (r.user && r.profile) return done(r);
          if (r.signup) return signupView({ pollId: r.pollId, email: r.signup.email, name: r.signup.name });
          formErr.show("Google sign-in didn't finish. Try again.");
        } catch (e) {
          formErr.show(cap(e.message || "Google sign-in didn't work. Try again."));
        }
        return;
      }
      if (flavor === "device") return googleView({ purpose });
      formErr.show("Google sign-in isn't available here.");
    };
    const googleBlock = (label, purpose, formErr) => {
      const area = el("div", { class: "auth-google" });
      // painted when server-info lands (a synchronous check raced the fetch)
      infoReady.then(() => {
        if (!googleFlavor(serverInfo) || area.childElementCount || !area.isConnected) return;
        area.append(
          el("div", { class: "auth-or", role: "separator" }, el("span", {}, "or")),
          googleButton(label, () => doGoogle(purpose, formErr)));
      });
      return area;
    };

    // ---------------- sign in ----------------
    const signinView = () => {
      const formErr = formError();
      const forgot = el("button", { type: "button", class: "auth-link small focusable", "data-ui": "signin.forgot", onclick: () => forgotView({ identifier: user.value().trim() }) }, "Forgot password?");
      const user = field({ key: "identifier", label: "Username or email", autocomplete: "username", maxlength: "80", enterkeyhint: "next", required: true });
      const pass = passwordField({ key: "password", label: "Password", autocomplete: "current-password", enterkeyhint: "go", aside: forgot, required: true });
      const submitBtn = primaryButton("Sign in", "Signing in…");
      user.input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); pass.focus(); } });

      const submit = async () => {
        formErr.clear();
        if (!user.value().trim()) { user.setError("Enter your username or email."); return user.focus(); }
        if (!pass.value()) { pass.setError("Enter your password."); return pass.focus(); }
        submitBtn.busy(true);
        try {
          const typed = pass.value();
          const res = await api.login(user.value().trim(), typed);
          done(res, typed);
        } catch (e) {
          placeError(e, [user, pass], formErr);
        } finally {
          submitBtn.busy(false);
        }
      };

      const nodes = [
        tabs("signin"),
        title("Sign in"),
        lede("Use your Aurora username or email."),
        form(submit, user.wrap, pass.wrap, formErr, submitBtn),
        googleBlock("Continue with Google", "login", formErr),
      ];
      if (opts.skippable) {
        nodes.push(el("p", { class: "auth-skip" },
          el("button", {
            type: "button", class: "auth-link dim focusable",
            onclick: () => { cleanup(); resolve(null); },
          }, "Continue without signing in")));
      }
      nodes.push(getAppsLink());
      setView(nodes, user.input);
    };

    // ---------------- request access ----------------
    // A password is required either way — with Google too (elia, auth-round:
    // signing up with Google and no password "is not good at all"). `googleCtx`
    // arrives verified from a Google step ({pollId, email, name}).
    const signupView = (googleCtx = null) => {
      const formErr = formError();
      const personal = () => [name.value(), uname.value(), email.value(), googleCtx && googleCtx.email];
      const name = field({ key: "name", label: "Your name", autocomplete: "name", maxlength: "24", value: (googleCtx && googleCtx.name) || "", autocapitalize: "words", help: "Shown on your profile.", required: true, enterkeyhint: "next" });
      const uname = field({ key: "username", label: googleCtx ? "Username (optional)" : "Username", autocomplete: "username", maxlength: "24", help: "Letters and numbers. You'll sign in with it.", required: !googleCtx, enterkeyhint: "next" });
      const email = field({ key: "email", label: "Email (optional)", type: "email", autocomplete: "email", inputmode: "email", maxlength: "80", help: "You can sign in with it too.", enterkeyhint: "next" });
      const pw = passwordField({ key: "password", label: "Password", autocomplete: "new-password", isNew: true, personal, required: true, enterkeyhint: "next" });
      const pw2 = passwordField({ key: "confirm", label: "Confirm password", autocomplete: "new-password", required: true, enterkeyhint: "next" });
      const note = field({ key: "note", label: `Note for ${adminIn()} (optional)`, maxlength: "200", autocapitalize: "sentences", enterkeyhint: "send" });
      const sendBtn = primaryButton("Send request", "Sending…");
      const chain = [name, uname, ...(googleCtx ? [] : [email]), pw, pw2];
      chain.forEach((f, i) => f.input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && chain[i + 1]) { e.preventDefault(); chain[i + 1].focus(); }
      }));

      const send = async () => {
        formErr.clear();
        if (!name.value().trim()) { name.setError("Enter your name."); return name.focus(); }
        if (!googleCtx && !uname.value().trim() && !email.value().trim()) {
          uname.setError("Choose a username, or give an email to sign in with."); return uname.focus();
        }
        const bad = passwordProblem(pw.value());
        if (bad) { pw.setError(bad); return pw.focus(); }
        if (pw.value() !== pw2.value()) { pw2.setError("The passwords don't match."); return pw2.focus(); }
        sendBtn.busy(true);
        try {
          await api.signupRequest({
            name: name.value().trim(),
            username: uname.value().trim(),
            email: googleCtx ? "" : email.value().trim(),
            password: pw.value(),
            note: note.value().trim(),
            pollId: googleCtx ? googleCtx.pollId : undefined,
          });
          sentView(name.value().trim());
        } catch (e) {
          placeError(e, [name, uname, email, pw, pw2, note], formErr);
        } finally {
          sendBtn.busy(false);
        }
      };

      const standalone = opts.view === "signup";
      const nodes = [
        standalone || googleCtx ? null : tabs("request"),
        title(googleCtx ? "Finish your request" : "Request access"),
        googleCtx
          ? lede("Set a password as well, so you can sign in on devices without Google.")
          : lede(`${admin()} approves new people. Once you're approved, sign in with the details you set here.`),
        googleCtx ? el("p", { class: "auth-verified" },
          el("span", { class: "af-g", html: GOOGLE_G }),
          el("span", {}, "Google: ", el("strong", {}, googleCtx.email || "verified"))) : null,
        form(send, name.wrap, uname.wrap, googleCtx ? null : email.wrap, pw.wrap, pw2.wrap, note.wrap, formErr, sendBtn),
        googleCtx ? null : googleBlock("Sign up with Google", "signup", formErr),
        el("p", { class: "auth-foot" },
          standalone
            ? back("Cancel", () => { cleanup(); resolve(null); })
            : googleCtx ? back("Back to sign in", () => signinView()) : null),
        getAppsLink(),
      ];
      setView(nodes, name.input);
    };

    const sentView = (who) => {
      const standalone = opts.view === "signup";
      const ok = el("button", {
        type: "button", class: "af-btn primary focusable",
        onclick: () => (standalone ? (cleanup(), resolve(null)) : signinView()),
      }, el("span", { class: "af-btn-text" }, standalone ? "Done" : "Back to sign in"));
      setView([
        title("Request sent"),
        lede(`${admin()} will look at “${who}” soon. Once you're approved, sign in with your username and password.`),
        ok,
      ], ok);
    };

    // ---------------- reset your password ----------------
    // Every way ends in the same place: a one-time reset token, then
    // newPasswordView. `ctx.profile`: the wall's "Forgot password?" (the
    // profile is known, no name to type).
    const forgotView = (ctx = {}) => {
      const formErr = formError();
      const opt = (key, label, sub, fn) => el("button", {
        type: "button", class: "auth-option focusable", "data-ui": `signin.reset.${key}`, onclick: fn,
      }, el("span", { class: "auth-option-title" }, label), sub ? el("span", { class: "auth-option-sub" }, sub) : null);
      const list = el("div", { class: "auth-options", role: "list" });
      const paint = () => {
        list.innerHTML = "";
        const o = resetInfo || { google: false, email: false };
        if (o.google && googleFlavor(serverInfo)) {
          list.append(opt("google", "Use Google", "For profiles linked to a Google account.", () => doGoogle("reset", formErr)));
        }
        list.append(opt("admin", `Ask ${adminIn()}`, `${admin()} approves it, then you choose a new password here.`, () => askAdminView(ctx)));
        list.append(opt("code", "I have a reset code", `A code ${adminIn()} gave you.`, () => codeView(ctx)));
        if (o.email && !ctx.profile) list.append(opt("email", "Email me a link", "To the email on your profile.", () => emailView(ctx)));
      };
      paint();
      infoReady.then(() => { if (list.isConnected) paint(); });
      setView([
        title("Reset your password"),
        lede(ctx.profile ? `For “${ctx.profile.name}”. Pick how you want to confirm it's you.` : "Pick how you want to confirm it's you."),
        list,
        formErr,
        el("p", { class: "auth-hint" }, "Still signed in on your phone or computer? Change it in Settings there."),
        el("p", { class: "auth-foot" }, ctx.profile
          ? back("Cancel", () => { cleanup(); resolve(null); })
          : back("Back to sign in", () => signinView())),
      ], list.querySelector("button"));
    };

    const askAdminView = (ctx = {}) => {
      const formErr = formError();
      const who = ctx.profile ? null : field({ key: "identifier", label: "Username or email", autocomplete: "username", maxlength: "80", value: ctx.identifier || "", required: true, enterkeyhint: "next" });
      const note = field({ key: "note", label: `Note for ${adminIn()} (optional)`, maxlength: "200", autocapitalize: "sentences", enterkeyhint: "send" });
      const btn = primaryButton("Send request", "Sending…");
      const send = async () => {
        formErr.clear();
        if (who && !who.value().trim()) { who.setError("Enter your username or email."); return who.focus(); }
        btn.busy(true);
        try {
          const r = ctx.profile
            ? await api.resetRequestFor(ctx.profile.id, note.value().trim())
            : await api.resetRequest(who.value().trim(), note.value().trim());
          waitView({ ...ctx, identifier: who ? who.value().trim() : "", ticket: r.ticket });
        } catch (e) {
          placeError(e, [who, note], formErr);
        } finally {
          btn.busy(false);
        }
      };
      setView([
        title(`Ask ${adminIn()}`),
        lede(`${admin()} gets your request. When it's approved, you choose a new password on this screen.`),
        form(send, who && who.wrap, note.wrap, formErr, btn),
        el("p", { class: "auth-foot" }, back("Other ways to reset", () => forgotView(ctx))),
      ], who ? who.input : note.input);
    };

    const waitView = (ctx) => {
      const status = el("p", { class: "auth-wait", role: "status" }, el("span", { class: "auth-wait-dot", "aria-hidden": "true" }), "Waiting for approval");
      setView([
        title("Request sent"),
        lede(`Keep this screen open. When ${adminIn()} approves, you can choose a new password here. You can also ask ${adminIn()} for a reset code.`),
        status,
        el("p", { class: "auth-foot" },
          back("I have a reset code", () => codeView(ctx)),
          el("span", { class: "auth-dot", "aria-hidden": "true" }, "·"),
          back("Back to sign in", () => (ctx.profile ? (cleanup(), resolve(null)) : signinView()))),
      ], null);
      const tick = async () => {
        polling = null;
        if (!wrap.isConnected) return;
        try {
          const s = await api.resetStatus(ctx.ticket);
          if (s.status === "approved" && s.token) return newPasswordView({ token: s.token, name: s.name, via: "admin" });
          if (s.status === "declined") {
            status.textContent = `${admin()} didn't approve this request. Ask ${adminIn()} in person, or try another way.`;
            status.classList.add("bad");
            return;
          }
          if (s.status === "expired" || s.status === "used") {
            status.textContent = "This request has ended. Send a new one if you still need it.";
            status.classList.add("bad");
            return;
          }
        } catch {}
        // (hidden tab: ask less often)
        polling = setTimeout(tick, document.hidden ? 15000 : 4000);
      };
      polling = setTimeout(tick, 4000);
    };

    const codeView = (ctx = {}) => {
      const formErr = formError();
      const who = ctx.profile ? null : field({ key: "identifier", label: "Username or email", autocomplete: "username", maxlength: "80", value: ctx.identifier || "", required: true, enterkeyhint: "next" });
      const code = field({ key: "code", label: "Reset code", autocomplete: "one-time-code", maxlength: "12", help: "8 letters and numbers, like K7M4-Q2PX.", autocapitalize: "characters", required: true, enterkeyhint: "go" });
      code.input.classList.add("af-code");
      if (who) who.input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); code.focus(); } });
      const btn = primaryButton("Continue", "Checking…");
      const send = async () => {
        formErr.clear();
        if (who && !who.value().trim()) { who.setError("Enter your username or email."); return who.focus(); }
        if (!code.value().trim()) { code.setError("Enter the reset code."); return code.focus(); }
        btn.busy(true);
        try {
          const r = ctx.profile
            ? await api.resetWithCodeFor(ctx.profile.id, code.value())
            : await api.resetWithCode(who.value().trim(), code.value());
          newPasswordView({ token: r.token, name: r.name, via: "code" });
        } catch (e) {
          placeError(e, [who, code], formErr);
        } finally {
          btn.busy(false);
        }
      };
      setView([
        title("Enter your reset code"),
        lede(`${admin()} can give you a code from the admin page. It works once, for 30 minutes.`),
        form(send, who && who.wrap, code.wrap, formErr, btn),
        el("p", { class: "auth-foot" }, back("Other ways to reset", () => forgotView(ctx))),
      ], who && !who.value() ? who.input : code.input);
    };

    const emailView = (ctx = {}) => {
      const formErr = formError();
      const who = field({ key: "identifier", label: "Username or email", autocomplete: "username", maxlength: "80", value: ctx.identifier || "", required: true, enterkeyhint: "send" });
      const btn = primaryButton("Email me a link", "Sending…");
      const send = async () => {
        formErr.clear();
        if (!who.value().trim()) { who.setError("Enter your username or email."); return who.focus(); }
        btn.busy(true);
        try {
          await api.resetEmail(who.value().trim());
          setView([
            title("Check your email"),
            lede("If that name has an email on its profile, a link to reset the password is on its way. It works for 30 minutes."),
            el("p", { class: "auth-foot" }, back("Back to sign in", () => signinView())),
          ], null);
        } catch (e) {
          placeError(e, [who], formErr);
        } finally {
          btn.busy(false);
        }
      };
      setView([
        title("Email me a link"),
        lede("We'll send a link to the email on your profile."),
        form(send, who.wrap, formErr, btn),
        el("p", { class: "auth-foot" }, back("Other ways to reset", () => forgotView(ctx))),
      ], who.input);
    };

    // The last step of every reset: the new password, then signed in.
    const newPasswordView = ({ token, name, via }) => {
      const formErr = formError();
      const pw = passwordField({ key: "newPassword", label: "New password", autocomplete: "new-password", isNew: true, personal: () => [name], required: true, enterkeyhint: "next" });
      const pw2 = passwordField({ key: "confirm", label: "Confirm password", autocomplete: "new-password", required: true, enterkeyhint: "go" });
      // (a hidden username field: password managers save the new password against it)
      const hiddenUser = el("input", { type: "text", name: "username", autocomplete: "username", value: name || "", hidden: true, "aria-hidden": "true", tabindex: "-1" });
      const others = el("input", { type: "checkbox", id: "af-signout-others", class: "focusable", checked: true });
      const othersRow = el("label", { class: "auth-check", for: "af-signout-others" }, others, el("span", {}, "Sign out of all other devices"));
      const btn = primaryButton("Save and sign in", "Saving…");
      pw.input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); pw2.focus(); } });
      const send = async () => {
        formErr.clear();
        const bad = passwordProblem(pw.value());
        if (bad) { pw.setError(bad); return pw.focus(); }
        if (pw.value() !== pw2.value()) { pw2.setError("The passwords don't match."); return pw2.focus(); }
        btn.busy(true);
        try {
          const res = await api.resetComplete(token, pw.value(), others.checked);
          toast("New password saved. You're signed in.", "✅");
          done(res, pw.value());
        } catch (e) {
          if (e && e.status === 410) {
            formErr.show(cap(e.message || "This reset has expired. Start again."));
          } else {
            placeError(e, [pw, pw2], formErr);
          }
        } finally {
          btn.busy(false);
        }
      };
      setView([
        title("Choose a new password"),
        lede(name ? `For “${name}”.${via === "google" ? " Google confirmed it's you." : ""}` : ""),
        form(send, hiddenUser, pw.wrap, pw2.wrap, othersRow, formErr, btn),
        el("p", { class: "auth-foot" }, back("Cancel", () => (opts.view === "reset" || opts.view === "forgot" ? (cleanup(), resolve(null)) : signinView()))),
      ], pw.input);
    };

    // An emailed link (#/reset/<token>): check it, then the new password.
    const linkView = async (token) => {
      setView([title("Reset your password"), lede("Checking the link…")], null);
      try {
        const r = await api.resetCheck(token);
        newPasswordView({ token, name: r.name, via: "email" });
      } catch (e) {
        setView([
          title("This link has expired"),
          lede(cap((e && e.message) || "This reset link has expired or was already used. Ask for a new one.")),
          el("p", { class: "auth-foot" }, back("Other ways to reset", () => forgotView())),
        ], null);
      }
    };

    // ---------------- Google device flow ----------------
    // purpose "login": a known Google identity signs its profile straight in;
    // an unknown one rolls into a prefilled access request. "signup": verify
    // the identity for the request form. "reset": a reset token.
    const googleView = async ({ purpose }) => {
      const backTo = () => (purpose === "signup" ? signupView() : purpose === "reset" ? forgotView() : signinView());
      setView([title("Continue with Google"), lede("Getting a code from Google…")], null);
      let start;
      try {
        start = await api.googleStartFor(purpose === "login" ? "signin" : purpose);
      } catch (e) {
        toast(cap(e.message || "Couldn't reach Google."), "!");
        return backTo();
      }
      let cancelled = false;
      const poll = async () => {
        if (cancelled || !wrap.isConnected) return;
        try {
          const r = await api.googlePoll(start.pollId);
          if (r.ok && r.reset) return newPasswordView({ token: r.reset.token, name: r.reset.name, via: "google" });
          if (r.ok && r.user) return done(r); // known identity → signed in
          if (r.ok && r.signup) {
            // verified but unknown → a prefilled access request
            return signupView({ pollId: start.pollId, email: r.signup.email, name: r.signup.name });
          }
          if (r.ok) {
            toast("You're already signed in in another tab. Reload this one.", "!");
            return signinView();
          }
        } catch (e) {
          toast(cap(e.message || "Google sign-in didn't work."), "!");
          return backTo();
        }
        setTimeout(poll, 3000);
      };
      setTimeout(poll, 3000);

      const nevermind = back("Cancel", () => { cancelled = true; backTo(); });
      setView([
        title("Continue with Google"),
        lede("On your phone or any device, open ",
          el("a", { class: "auth-link", href: start.verificationUrl, target: "_blank", rel: "noopener" }, start.verificationUrl.replace(/^https?:\/\//, "")),
          " and enter this code:"),
        el("div", { class: "auth-code", "aria-label": `Code ${start.userCode}` },
          [...String(start.userCode)].map((ch) => el("span", { class: ch === "-" ? "sep" : "", "aria-hidden": "true" }, ch))),
        el("p", { class: "auth-wait", role: "status" }, el("span", { class: "auth-wait-dot", "aria-hidden": "true" }), "Waiting for Google. This screen continues by itself."),
        el("p", { class: "auth-foot" }, nevermind),
      ], nevermind);
    };

    if (opts.view === "signup") signupView();
    else if (opts.view === "forgot") forgotView({ profile: opts.profile || null });
    else if (opts.view === "reset" && opts.token) linkView(opts.token);
    else signinView();
    document.body.append(wrap);
    // the painter checks canvas.isConnected — start it only once it's real
    stopSky = initAuroraSky(sky);
    pushScope(wrap);
  });

// The sign-in screen (prompt 10, redesigned): a night sky with the real
// aurora painter running full-viewport, the wordmark shining over it, and one
// floating glass card that carries every flow — sign in (username OR email),
// request access, and Google's device-code dance. Shown at boot only when the
// wall is CLOSED; in transition mode it can also be summoned voluntarily
// (opts.skippable adds a "continue without an account" path).
import { el, toast } from "../ui.js";
import { api } from "../api.js";
import { state } from "../state.js";
import { pushScope, popScope } from "../focus.js";
import { initAuroraSky } from "../aurora-sky.js";

// Small inline icon set (stroke = currentColor so the theme owns the color).
const icon = (d, extra = "") =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}${extra}</svg>`;
const I = {
  user: icon(`<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>`),
  lock: icon(`<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>`),
  mail: icon(`<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>`),
  note: icon(`<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>`),
  eye: icon(`<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>`),
  eyeOff: icon(`<path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 8 10 8a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3.5 8 10 8a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/>`),
};
// Google's four-color G (official geometry, inlined — no external assets).
const GOOGLE_G = `<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`;

// One labeled input row: icon + input (+ optional trailing button).
const field = ({ type = "text", placeholder, autocomplete, ic, maxlength, value = "" }) => {
  const input = el("input", {
    type, placeholder, autocomplete, value,
    class: "focusable",
    ...(maxlength ? { maxlength } : {}),
    autocapitalize: "none", spellcheck: "false",
  });
  const wrap = el("div", { class: "lfield" },
    el("span", { class: "lfield-ic", html: ic }),
    input);
  if (type === "password") {
    let shown = false;
    const eye = el("button", {
      type: "button", class: "lfield-eye focusable", "aria-label": "Show password", html: I.eye,
      onclick: () => {
        shown = !shown;
        input.type = shown ? "text" : "password";
        eye.innerHTML = shown ? I.eyeOff : I.eye;
        input.focus();
      },
    });
    wrap.append(eye);
  }
  return { wrap, input };
};

const errLine = () => el("div", { class: "lerr", role: "alert", "aria-live": "polite" });
const showErr = (node, msg) => {
  node.textContent = msg;
  node.classList.add("on");
  node.classList.remove("shake");
  void node.offsetWidth; // restart the animation
  node.classList.add("shake");
};
const clearErr = (node) => node.classList.remove("on");

export const showLoginScreen = (opts = {}) =>
  new Promise((resolve) => {
    const sky = el("canvas", { class: "login-sky", "aria-hidden": "true" });
    const card = el("div", { class: "login-card" });
    const gate = el("div", { class: "login-gate" },
      el("div", { class: "login-brand" },
        el("div", { class: "login-logo" }, "aurora"),
        el("div", { class: "login-tag" }, "your living-room cinema")),
      card,
    );
    const wrap = el("div", { class: "ui-overlay login-wrap" }, sky, gate);

    let stopSky = () => {};
    const cleanup = () => {
      stopSky();
      popScope(wrap);
      wrap.remove();
    };
    const done = (user) => {
      cleanup();
      opts.onSignedIn?.(user);
      resolve(user);
    };

    // Crossfade between card views — reduced motion just swaps.
    const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const setView = (nodes, focusEl) => {
      const fill = () => {
        card.innerHTML = "";
        card.append(...nodes);
        if (!calm) {
          card.classList.remove("view-in");
          void card.offsetWidth;
          card.classList.add("view-in");
        }
        setTimeout(() => focusEl?.focus({ preventScroll: true }), calm ? 30 : 220);
      };
      fill();
    };

    // ---------------- sign in ----------------
    const signinView = () => {
      const user = field({ placeholder: "Username or email", autocomplete: "username", ic: I.user, maxlength: "80" });
      const pass = field({ type: "password", placeholder: "Password", autocomplete: "current-password", ic: I.lock });
      const err = errLine();
      const submitBtn = el("button", { class: "lbtn primary focusable" }, el("span", {}, "Sign in"));

      const submit = async () => {
        clearErr(err);
        if (!user.input.value.trim() || !pass.input.value) {
          return showErr(err, "Both fields, please.");
        }
        submitBtn.disabled = true;
        submitBtn.classList.add("busy");
        try {
          const res = await api.login(user.input.value.trim(), pass.input.value);
          done(res.user);
        } catch (e) {
          showErr(err, e.message || "Sign-in failed.");
          pass.input.value = "";
          pass.input.focus();
        } finally {
          submitBtn.disabled = false;
          submitBtn.classList.remove("busy");
        }
      };
      submitBtn.addEventListener("click", submit);
      for (const f of [user, pass]) {
        f.input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
      }

      const google = el("div", { class: "lgoogle" });
      api.serverInfo().then((info) => {
        if (!info || !info.google) return;
        google.append(
          el("div", { class: "ldivider" }, el("span", {}, "or")),
          el("button", {
            class: "lbtn google focusable",
            onclick: () => googleView(),
          }, el("span", { class: "gmark", html: GOOGLE_G }), el("span", {}, "Continue with Google")),
        );
      }).catch(() => {});

      const nodes = [
        el("h2", { class: "lhead" }, "Welcome back"),
        el("p", { class: "lsub" }, "Sign in to pick up where you left off."),
        user.wrap,
        pass.wrap,
        err,
        submitBtn,
        google,
        el("div", { class: "lfoot" },
          "First time here? ",
          el("button", { class: "llink focusable", onclick: () => signupView() }, "Request access")),
      ];
      if (opts.skippable) {
        nodes.push(el("div", { class: "lskip" },
          el("button", {
            class: "llink dim focusable",
            onclick: () => { cleanup(); resolve(null); },
          }, "Continue without an account for now →")));
      }
      setView(nodes, user.input);
    };

    // ---------------- request access ----------------
    const signupView = () => {
      const uname = field({ placeholder: "Pick a username", autocomplete: "off", ic: I.user, maxlength: "24" });
      const real = field({ placeholder: "Your real name", autocomplete: "name", ic: I.note, maxlength: "40" });
      const email = field({ placeholder: "Email (optional)", autocomplete: "email", ic: I.mail, maxlength: "80" });
      const pw = field({ type: "password", placeholder: "Pick a password (4+ characters)", autocomplete: "new-password", ic: I.lock });
      const pw2 = field({ type: "password", placeholder: "Repeat the password", autocomplete: "new-password", ic: I.lock });
      const note = field({ placeholder: "A bribe, an explanation, or a fun fact", autocomplete: "off", ic: I.note, maxlength: "200" });
      const err = errLine();
      const sendBtn = el("button", { class: "lbtn primary focusable" }, el("span", {}, "Send my request"));

      const send = async () => {
        clearErr(err);
        if (pw.input.value !== pw2.input.value) return showErr(err, "The passwords don't match.");
        sendBtn.disabled = true;
        sendBtn.classList.add("busy");
        try {
          await api.signupRequest({
            username: uname.input.value.trim(),
            name: real.input.value.trim(),
            email: email.input.value.trim(),
            password: pw.input.value,
            note: note.input.value.trim(),
          });
          sentView(uname.input.value.trim());
        } catch (e) {
          showErr(err, e.message || "That didn't work.");
        } finally {
          sendBtn.disabled = false;
          sendBtn.classList.remove("busy");
        }
      };
      sendBtn.addEventListener("click", send);

      setView([
        el("h2", { class: "lhead" }, "Request access"),
        el("p", { class: "lsub" },
          `${state.adminName} approves every account personally. Your password is set now, so the moment you're in — you're in. `,
          el("span", { class: "ldim" }, "(Don't reuse a password you care about. This is a living room, not a bank.)")),
        uname.wrap, real.wrap, email.wrap, pw.wrap, pw2.wrap, note.wrap,
        err,
        sendBtn,
        el("div", { class: "lfoot" },
          el("button", { class: "llink focusable", onclick: () => signinView() }, "← Back to sign in")),
      ], uname.input);
    };

    const sentView = (uname) => {
      setView([
        el("div", { class: "lsent" },
          el("div", { class: "lsent-glyph" }, "🍿"),
          el("h2", { class: "lhead" }, "Request sent"),
          el("p", { class: "lsub" },
            `“${uname}” is now on the pile of things ${state.adminName} has to deal with. `,
            el("strong", {}, "Want it faster? Go ask in person."),
            " Once you're approved, come right back here and sign in."),
        ),
        el("button", { class: "lbtn primary focusable", onclick: () => signinView() },
          el("span", {}, "Back to sign in")),
      ]);
    };

    // ---------------- Google device flow ----------------
    const googleView = async () => {
      setView([
        el("h2", { class: "lhead" }, "Google sign-in"),
        el("p", { class: "lsub" }, "Getting a code from Google…"),
      ]);
      let start;
      try {
        start = await api.googleStart();
      } catch (e) {
        toast(e.message || "Couldn't reach Google.", "🙃");
        return signinView();
      }
      let cancelled = false;
      const poll = async () => {
        if (cancelled || !wrap.isConnected) return;
        try {
          const r = await api.googlePoll(start.pollId);
          if (r.ok && r.user) return done(r.user);
          if (r.ok) {
            toast("You're already signed in in another tab — reload.", "🙃");
            return signinView();
          }
        } catch (e) {
          toast(e.message || "Google sign-in failed.", "🙃");
          return signinView();
        }
        setTimeout(poll, 3000);
      };
      setTimeout(poll, 3000);

      setView([
        el("h2", { class: "lhead" }, "Google sign-in"),
        el("p", { class: "lsub" }, "On your phone (or any device), open",
          el("a", {
            class: "llink", style: { margin: "0 5px" },
            href: start.verificationUrl, target: "_blank", rel: "noopener",
          }, start.verificationUrl.replace(/^https?:\/\//, "")),
          "and enter this code:"),
        el("div", { class: "lcode" },
          [...String(start.userCode)].map((ch) => el("span", { class: ch === "-" ? "sep" : "" }, ch))),
        el("div", { class: "lwait" }, el("span", { class: "lwait-dot" }), "Waiting for Google — this screen finishes by itself."),
        el("div", { class: "lfoot" },
          el("button", {
            class: "llink focusable",
            onclick: () => { cancelled = true; signinView(); },
          }, "← Never mind, use a password")),
      ]);
    };

    signinView();
    document.body.append(wrap);
    // the painter checks canvas.isConnected — start it only once it's real
    stopSky = initAuroraSky(sky);
    pushScope(wrap);
  });

// Sign-in screen (prompt 10). Shown before the profile wall whenever the
// server's authMode isn't "open" and nobody is signed in on this browser.
// The session lives in an HttpOnly cookie — this screen only ever handles the
// form; nothing credential-shaped is stored client-side.
import { el, toast } from "../ui.js";
import { api } from "../api.js";
import { state } from "../state.js";
import { pushScope, popScope } from "../focus.js";

export const showLoginScreen = (onSignedIn) =>
  new Promise((resolve) => {
    const host = el("div", { class: "login-gate" });
    const wrap = el("div", {
      class: "ui-overlay",
      style: { position: "fixed", inset: 0, background: "var(--bg)", zIndex: 260, overflowY: "auto" },
    }, host);

    const cleanup = () => {
      popScope(wrap);
      wrap.remove();
    };
    const done = (user) => {
      cleanup();
      onSignedIn?.(user);
      resolve(user);
    };

    // ---------- sign-in form ----------
    const userInput = el("input", {
      type: "text", class: "focusable", placeholder: "Username",
      autocomplete: "username", autocapitalize: "none", spellcheck: "false", maxlength: "24",
    });
    const pwInput = el("input", {
      type: "password", class: "focusable", placeholder: "Password", autocomplete: "current-password",
    });
    const err = el("div", { class: "pw-error hidden" });
    const signinBtn = el("button", { class: "btn btn-primary focusable login-submit" }, "Sign in");

    const submit = async () => {
      err.classList.add("hidden");
      if (!userInput.value.trim() || !pwInput.value) {
        err.textContent = "Both fields, please.";
        err.classList.remove("hidden");
        return;
      }
      signinBtn.disabled = true;
      signinBtn.textContent = "Signing in…";
      try {
        const res = await api.login(userInput.value.trim(), pwInput.value);
        done(res.user);
      } catch (e) {
        err.textContent = e.message || "Sign-in failed.";
        err.classList.remove("hidden");
        pwInput.value = "";
        pwInput.focus();
      } finally {
        signinBtn.disabled = false;
        signinBtn.textContent = "Sign in";
      }
    };
    signinBtn.addEventListener("click", submit);
    for (const i of [userInput, pwInput]) {
      i.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    }

    // ---------- Google (device flow) ----------
    // The button exists only when the server says it's configured. The flow:
    // ask the server for a code, show it, poll until the phone-side consent
    // lands. All the Google traffic is phone↔Google over HTTPS.
    const googleArea = el("div", { class: "login-google hidden" });
    const startGoogle = async () => {
      googleArea.innerHTML = "";
      let start;
      try {
        start = await api.googleStart();
      } catch (e) {
        toast(e.message || "Couldn't reach Google.", "🙃");
        paintGoogleButton();
        return;
      }
      let cancelled = false;
      const codeBox = el("div", { class: "login-google-code" }, start.userCode);
      googleArea.append(
        el("div", { class: "login-google-steps" },
          el("div", {}, "On your phone, open ",
            el("a", { href: start.verificationUrl, target: "_blank", rel: "noopener" },
              start.verificationUrl.replace(/^https?:\/\//, ""))),
          el("div", {}, "and enter this code:"),
        ),
        codeBox,
        el("div", { class: "login-google-wait" }, "Waiting for you… this screen finishes by itself."),
        el("button", {
          class: "btn focusable", style: { marginTop: "10px" },
          onclick: () => { cancelled = true; paintGoogleButton(); },
        }, "Cancel"),
      );
      const poll = async () => {
        if (cancelled || !wrap.isConnected) return;
        try {
          const r = await api.googlePoll(start.pollId);
          // r.ok without a user is the LINK variant (already signed in
          // elsewhere) — not a login; never finish the screen on it
          if (r.ok && r.user) return done(r.user);
          if (r.ok) {
            toast("You're already signed in in another tab — reload.", "🙃");
            paintGoogleButton();
            return;
          }
        } catch (e) {
          toast(e.message || "Google sign-in failed.", "🙃");
          paintGoogleButton();
          return;
        }
        setTimeout(poll, 3000);
      };
      setTimeout(poll, 3000);
    };
    const paintGoogleButton = () => {
      googleArea.innerHTML = "";
      googleArea.append(
        el("div", { class: "login-divider" }, el("span", {}, "or")),
        el("button", { class: "btn focusable login-google-btn", onclick: startGoogle },
          el("span", { class: "g-mark", "aria-hidden": "true" }, "G"), "Sign in with Google"),
      );
    };
    api.serverInfo().then((info) => {
      if (info && info.google) {
        paintGoogleButton();
        googleArea.classList.remove("hidden");
      }
    }).catch(() => {});

    // ---------- request access (signup) ----------
    const signupForm = () => {
      const su = el("input", {
        type: "text", class: "focusable", placeholder: "Pick a username", maxlength: "24",
        autocomplete: "off", autocapitalize: "none", spellcheck: "false",
      });
      const sn = el("input", { type: "text", class: "focusable", placeholder: "Your real name", maxlength: "40" });
      const sp = el("input", { type: "password", class: "focusable", placeholder: "Pick a password (4+ chars)", autocomplete: "new-password" });
      const sp2 = el("input", { type: "password", class: "focusable", placeholder: "Repeat password", autocomplete: "new-password" });
      const note = el("input", { type: "text", class: "focusable", placeholder: "Optional — a bribe, an explanation, or a fun fact", maxlength: "200" });
      const sErr = el("div", { class: "pw-error hidden" });
      const sendBtn = el("button", { class: "btn btn-primary focusable" }, "Send request");
      const send = async () => {
        sErr.classList.add("hidden");
        if (sp.value !== sp2.value) {
          sErr.textContent = "The passwords don't match.";
          sErr.classList.remove("hidden");
          return;
        }
        sendBtn.disabled = true;
        try {
          await api.signupRequest({
            username: su.value.trim(), name: sn.value.trim(), password: sp.value, note: note.value.trim(),
          });
          card.innerHTML = "";
          card.append(
            el("div", { class: "request-sent" },
              el("div", { class: "request-sent-emoji" }, "🍿"),
              el("h2", {}, "Request sent!"),
              el("p", {}, `“${su.value.trim()}” is now on the pile of things ${state.adminName} has to deal with. Once it's approved, come back here and sign in — `,
                el("strong", {}, "if you want it faster, go ask in person.")),
            ),
            el("button", { class: "btn btn-primary focusable", style: { marginTop: "16px" }, onclick: paintSignin }, "Back to sign-in"),
          );
        } catch (e) {
          sErr.textContent = e.message || "That didn't work.";
          sErr.classList.remove("hidden");
        } finally {
          sendBtn.disabled = false;
        }
      };
      sendBtn.addEventListener("click", send);
      card.innerHTML = "";
      card.append(
        el("h2", {}, "Request access"),
        el("p", { class: "login-sub" }, `${state.adminName} approves every account — your password is set now so it works the moment that happens. Don't reuse a password you care about: this is a living room, not a bank.`),
        el("div", { class: "field" }, su),
        el("div", { class: "field" }, sn),
        el("div", { class: "field" }, sp),
        el("div", { class: "field" }, sp2),
        el("div", { class: "field" }, note),
        sErr,
        el("div", { style: { display: "flex", gap: "10px", marginTop: "14px" } },
          sendBtn,
          el("button", { class: "btn focusable", onclick: paintSignin }, "Back")),
      );
      setTimeout(() => su.focus(), 50);
    };

    // ---------- layout ----------
    const card = el("div", { class: "login-card" });
    const paintSignin = () => {
      card.innerHTML = "";
      card.append(
        el("h2", {}, "Sign in"),
        el("div", { class: "field" }, userInput),
        el("div", { class: "field" }, pwInput),
        err,
        signinBtn,
        googleArea,
        el("div", { class: "login-foot" },
          "New here? ",
          el("button", { class: "link-btn focusable", onclick: signupForm }, "Request access")),
      );
      setTimeout(() => userInput.focus(), 50);
    };
    paintSignin();

    host.append(
      el("div", { class: "login-brand" },
        el("div", { class: "login-logo" }, "aurora"),
        el("div", { class: "login-tag" }, "the living-room cinema")),
      card,
    );
    document.body.append(wrap);
    pushScope(wrap);
  });

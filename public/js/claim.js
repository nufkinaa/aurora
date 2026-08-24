// Account claiming — the transition-mode onboarding (prompt 10 rework).
// While the admin runs authMode "transition", the app works exactly as
// always, and each person gets ONE gentle prompt: a banner on Home that
// opens a small modal to make the migrated account theirs (confirm the
// username, set a password, optionally add an email). Claiming signs them
// in on the spot; when everyone has claimed, the admin closes the wall.
import { el, toast } from "./ui.js";
import { api } from "./api.js";
import { state } from "./state.js";
import { pushScope, popScope } from "./focus.js";

const DISMISS_KEY = "aurora-claim-later";

// The claim modal. `suggested` is the migrated account (pub shape).
export const showClaimModal = (suggested, onClaimed) => {
  const uname = el("input", {
    type: "text", class: "focusable", value: suggested?.username || "",
    placeholder: "Username", maxlength: "24",
    autocapitalize: "none", spellcheck: "false", autocomplete: "username",
  });
  const email = el("input", {
    type: "email", class: "focusable", placeholder: "Email (optional — lets you sign in with it too)",
    maxlength: "80", autocomplete: "email",
  });
  const pw = el("input", { type: "password", class: "focusable", placeholder: "Pick a password (4+ characters)", autocomplete: "new-password" });
  const pw2 = el("input", { type: "password", class: "focusable", placeholder: "Repeat the password", autocomplete: "new-password" });
  const err = el("div", { class: "pw-error hidden" });

  const close = () => {
    document.removeEventListener("ui-back", onBack);
    popScope(backdrop);
    backdrop.remove();
  };
  const onBack = (e) => { e.preventDefault(); close(); };

  const submit = async (btn) => {
    err.classList.add("hidden");
    if (pw.value !== pw2.value) {
      err.textContent = "The passwords don't match.";
      err.classList.remove("hidden");
      return;
    }
    btn.disabled = true;
    try {
      const r = await api.claimAccount({
        profileId: state.profile.id,
        username: uname.value.trim(),
        password: pw.value,
        email: email.value.trim(),
      });
      state.user = r.user;
      close();
      toast(`Welcome, @${r.user.username} — you're signed in`, "🎉");
      onClaimed?.(r.user);
    } catch (e) {
      err.textContent = e.message || "That didn't work.";
      err.classList.remove("hidden");
    } finally {
      btn.disabled = false;
    }
  };

  const goBtn = el("button", { class: "btn btn-primary focusable" }, "Claim my account");
  goBtn.addEventListener("click", () => submit(goBtn));
  for (const i of [uname, email, pw, pw2]) {
    i.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(goBtn); });
  }

  const box = el("div", { class: "modal claim-modal" },
    el("div", { class: "claim-glyph" }, "🔑"),
    el("h2", {}, "Make this account yours"),
    el("p", { class: "claim-sub" },
      `Aurora is getting real sign-in. Your profile `,
      el("strong", {}, state.profile.name),
      ` already has an account waiting — pick your username and password once, and every device signs in with it. `,
      el("span", { class: "claim-dim" }, "Nothing about your profile, history or list changes.")),
    el("div", { class: "field" }, el("label", {}, "Username"), uname),
    el("div", { class: "field" }, email),
    el("div", { class: "field" }, pw),
    el("div", { class: "field" }, pw2),
    err,
    el("div", { style: { display: "flex", gap: "10px", marginTop: "18px" } },
      goBtn,
      el("button", { class: "btn focusable", onclick: close }, "Later")),
  );
  const backdrop = el("div", {
    class: "modal-backdrop ui-overlay",
    onclick: (e) => e.target === backdrop && close(),
  }, box);
  document.body.append(backdrop);
  document.addEventListener("ui-back", onBack);
  pushScope(backdrop);
  setTimeout(() => (suggested?.username ? pw : uname).focus(), 60);
};

// The Home banner. Returns a node to prepend, or null when there is nothing
// to prompt for (wrong mode, signed in, dismissed this session, no account).
export const claimBanner = async () => {
  if (state.authMode !== "transition" || state.user || !state.profile) return null;
  try {
    if (sessionStorage.getItem(DISMISS_KEY)) return null;
  } catch {}
  let account = null;
  try {
    account = (await api.claimable(state.profile.id)).account;
  } catch {
    return null;
  }
  if (!account) return null;

  const banner = el("div", { class: "claim-banner" },
    el("div", { class: "claim-banner-glow", "aria-hidden": "true" }),
    el("span", { class: "claim-banner-ic" }, "🔑"),
    el("div", { class: "claim-banner-text" },
      el("strong", {}, "Aurora accounts are here."),
      ` One minute to claim yours — then every device knows it's you.`),
    el("button", {
      class: "btn btn-primary small focusable",
      onclick: () => showClaimModal(account, () => banner.remove()),
    }, "Set it up"),
    el("button", {
      class: "claim-banner-x focusable", "aria-label": "Not now",
      onclick: () => {
        try { sessionStorage.setItem(DISMISS_KEY, "1"); } catch {}
        banner.remove();
      },
    }, "✕"),
  );
  return banner;
};

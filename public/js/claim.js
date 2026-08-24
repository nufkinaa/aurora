// Account claiming — the transition-mode onboarding (prompt 10, account =
// profile). While the admin runs authMode "transition", the app works exactly
// as always, and each person gets ONE gentle prompt: a banner on Home that
// opens a small modal to switch sign-in on for their profile — pick a
// username (+ optional email). If the profile already has a password, that
// password simply IS the sign-in password and the modal never asks for one;
// otherwise it's set here. Claiming signs them in on the spot; when everyone
// has claimed, the admin closes the wall.
import { el, toast } from "./ui.js";
import { api } from "./api.js";
import { state } from "./state.js";
import { pushScope, popScope } from "./focus.js";

const DISMISS_KEY = "aurora-claim-later";

// The claim modal. `claimable` is {suggestedUsername, hasPassword, name}.
export const showClaimModal = (claimable, onClaimed) => {
  const uname = el("input", {
    type: "text", class: "focusable", value: claimable?.suggestedUsername || "",
    placeholder: "Username", maxlength: "24",
    autocapitalize: "none", spellcheck: "false", autocomplete: "username",
  });
  const email = el("input", {
    type: "email", class: "focusable", placeholder: "Email (optional — sign in with it too)",
    maxlength: "80", autocomplete: "email",
  });
  const pw = el("input", { type: "password", class: "focusable", placeholder: "Pick a password (4+ characters)", autocomplete: "new-password" });
  const pw2 = el("input", { type: "password", class: "focusable", placeholder: "Repeat the password", autocomplete: "new-password" });
  const err = el("div", { class: "pw-error hidden" });
  const needsPassword = !claimable?.hasPassword;

  const close = () => {
    document.removeEventListener("ui-back", onBack);
    popScope(backdrop);
    backdrop.remove();
  };
  const onBack = (e) => { e.preventDefault(); close(); };

  const submit = async (btn) => {
    err.classList.add("hidden");
    if (needsPassword && pw.value !== pw2.value) {
      err.textContent = "The passwords don't match.";
      err.classList.remove("hidden");
      return;
    }
    btn.disabled = true;
    try {
      const r = await api.claimAccount({
        profileId: state.profile.id,
        username: uname.value.trim(),
        email: email.value.trim(),
        ...(needsPassword ? { password: pw.value } : {}),
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

  const goBtn = el("button", { class: "btn btn-primary focusable" }, "Turn my sign-in on");
  goBtn.addEventListener("click", () => submit(goBtn));
  for (const i of [uname, email, pw, pw2]) {
    i.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(goBtn); });
  }

  const box = el("div", { class: "modal claim-modal" },
    el("div", { class: "claim-glyph" }, "🔑"),
    el("h2", {}, "Make this profile yours"),
    el("p", { class: "claim-sub" },
      `Aurora is getting real sign-in — and your profile IS your account. Pick your username once, and every device signs in as `,
      el("strong", {}, state.profile.name),
      `. `,
      needsPassword
        ? el("span", { class: "claim-dim" }, "Nothing about your history or list changes.")
        : el("span", { class: "claim-dim" }, "Your profile password stays your password — nothing new to remember.")),
    el("div", { class: "field" }, el("label", {}, "Username"), uname),
    el("div", { class: "field" }, email),
    needsPassword && el("div", { class: "field" }, pw),
    needsPassword && el("div", { class: "field" }, pw2),
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
  setTimeout(() => uname.focus(), 60);
};

// The Home banner. Returns a node to float over the hero, or null when there
// is nothing to prompt for (wrong mode, signed in, dismissed, no claim).
export const claimBanner = async () => {
  if (state.authMode !== "transition" || state.user || !state.profile) return null;
  try {
    if (sessionStorage.getItem(DISMISS_KEY)) return null;
  } catch {}
  let claimable = null;
  try {
    claimable = (await api.claimable(state.profile.id)).claimable;
  } catch {
    return null;
  }
  if (!claimable) return null;

  const banner = el("div", { class: "claim-banner" },
    el("div", { class: "claim-banner-glow", "aria-hidden": "true" }),
    el("span", { class: "claim-banner-ic" }, "🔑"),
    el("div", { class: "claim-banner-text" },
      el("strong", {}, "Aurora sign-in is here."),
      ` One minute to set yours up — then every device knows it's you.`),
    el("button", {
      class: "btn btn-primary small focusable",
      onclick: () => showClaimModal(claimable, () => banner.remove()),
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

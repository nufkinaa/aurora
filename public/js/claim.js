// The one-time sign-in confirmation (prompt 10, account = profile).
// In transition mode this modal IS the migration: entering an unclaimed
// profile at the wall shows it before the profile opens — confirm the
// username, maybe add an email, set a password only if the profile never had
// one. elia's spec: "everybody will have to confirm that they remember" — so
// at the wall it's required (no Later); closing it returns to the wall.
import { el, toast } from "./ui.js";
import { api } from "./api.js";
import { state } from "./state.js";
import { pushScope, popScope } from "./focus.js";

// `claimable` is {suggestedUsername, hasPassword, name} from api.claimable.
// opts.required: no "Later" — closing cancels the profile entry (onCancel).
export const showClaimModal = (claimable, onClaimed, opts = {}) => {
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

  const close = (cancelled) => {
    document.removeEventListener("ui-back", onBack);
    popScope(backdrop);
    backdrop.remove();
    if (cancelled) opts.onCancel?.();
  };
  const onBack = (e) => { e.preventDefault(); close(true); };

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
        profileId: opts.profileId || state.profile?.id,
        username: uname.value.trim(),
        email: email.value.trim(),
        ...(needsPassword ? { password: pw.value } : {}),
      });
      state.user = r.user;
      close(false);
      toast(`Welcome, @${r.user.username} — you're signed in`, "🎉");
      onClaimed?.(r.user);
    } catch (e) {
      err.textContent = e.message || "That didn't work.";
      err.classList.remove("hidden");
    } finally {
      btn.disabled = false;
    }
  };

  const goBtn = el("button", { class: "btn btn-primary focusable" }, opts.required ? "Confirm & continue" : "Turn my sign-in on");
  goBtn.addEventListener("click", () => submit(goBtn));
  for (const i of [uname, email, pw, pw2]) {
    i.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(goBtn); });
  }

  const box = el("div", { class: "modal claim-modal" },
    el("div", { class: "claim-glyph" }, "🔑"),
    el("h2", {}, opts.required ? "One-time setup" : "Make this profile yours"),
    el("p", { class: "claim-sub" },
      `Aurora now has real sign-in — and your profile IS your account. Confirm the username for `,
      el("strong", {}, claimable?.name || state.profile?.name || "this profile"),
      ` once, and every device signs in with it. `,
      needsPassword
        ? el("span", { class: "claim-dim" }, "Pick the password you'll sign in with — nothing about your history or list changes.")
        : el("span", { class: "claim-dim" }, "Your profile password stays your password — nothing new to remember.")),
    el("div", { class: "field" }, el("label", {}, "Username"), uname),
    el("div", { class: "field" }, email),
    needsPassword && el("div", { class: "field" }, pw),
    needsPassword && el("div", { class: "field" }, pw2),
    err,
    el("div", { style: { display: "flex", gap: "10px", marginTop: "18px" } },
      goBtn,
      el("button", { class: "btn focusable", onclick: () => close(true) }, opts.required ? "Cancel" : "Later")),
  );
  const backdrop = el("div", {
    class: "modal-backdrop ui-overlay",
    onclick: (e) => e.target === backdrop && close(true),
  }, box);
  document.body.append(backdrop);
  document.addEventListener("ui-back", onBack);
  pushScope(backdrop);
  setTimeout(() => uname.focus(), 60);
};

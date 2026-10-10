// Profile picker (shown before the app) + create/edit modal with optional
// password. Editing a profile / changing its password happens only at creation
// or from Settings (Preferences) for your own profile — the gate itself just
// picks (and unlocks) a profile.
import { el, icons, toast, confirmSheet } from "../ui.js";
import { api, setAuthToken } from "../api.js";
import { state, setProfile, loadProfiles, recentProfileIds, savedToken } from "../state.js";
import { pushScope, popScope } from "../focus.js";
import * as narrator from "../narrator.js";
import { showClaimModal } from "../claim.js";
import { showLoginScreen } from "./login.js";
import { profilePicked } from "../telemetry.js"; // [analytics]

const AVATARS = [
  "🍿", "🎬", "🦊", "🐼", "🚀", "🌵", "🦖", "👾", "🐳", "🌙", "⚡", "🔥",
  // the expanded set (prompt 8): more personalities to pick from
  "🐱", "🐶", "🦉", "🐸", "🦄", "🐧", "🍕", "🍩", "☕", "🌈", "🎧", "🎮",
  "🏀", "⚽", "🌊", "🍁", "🎃", "❄️", "💜", "🛸", "🧠", "🕶️", "👑", "🧸",
];
const COLORS = ["#e05f2c", "#8b7bff", "#2c9fe0", "#38b26c", "#d94f8a", "#e0b52c", "#7a5cd6", "#4ec3c9"];

// Shortest password accepted when creating a profile (mirrored server-side in
// routes/profiles.js — keep the two in step).
const MIN_PW = 4;
// Above this many profiles the gate switches from "a row of tiles" to a
// searchable, recents-first grid with compact tiles.
const SEARCH_FROM = 7;
const COMPACT_FROM = 13;

// Small modal shell with Back handling + focus scope.
const modal = (contentNodes, onClose = null) => {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener("ui-back", onBack);
    popScope(backdrop);
    backdrop.remove();
    if (onClose) onClose();
  };
  const onBack = (e) => { e.preventDefault(); close(); };
  const box = el("div", { class: "modal" }, contentNodes(close));
  const backdrop = el("div", { class: "modal-backdrop ui-overlay", onclick: (e) => e.target === backdrop && close() }, box);
  document.body.append(backdrop);
  document.addEventListener("ui-back", onBack);
  pushScope(backdrop);
  return { close, box };
};

// Ask for a profile's password; calls onSuccess(token) when it unlocks.
export const passwordPrompt = (profile, onSuccess) => {
  const input = el("input", { type: "password", class: "focusable", placeholder: "Password", autocomplete: "off" });
  const err = el("div", { class: "pw-error hidden" }, "Not quite. Try again.");

  const { close } = modal((close) => {
    const submit = async () => {
      err.classList.add("hidden");
      try {
        const typed = input.value;
        const res = await api.unlockProfile(profile.id, typed);
        close();
        narrator.call("onGoodPassword");
        onSuccess(res.token, res);
        // The admin asked for a new password at the next sign-in (People →
        // Reset password): the old one just proved who this is; a new one is
        // required before going on. After onSuccess, so the token is set.
        if (res.mustReset) newPasswordPrompt(profile, typed);
      } catch (e) {
        // Say what happened. Every failure used to read "Not quite. Try
        // again." — also when the server had stopped taking guesses for a few
        // minutes, when the admin had locked the profile, and when there was
        // no server to ask: all three sent people back to retype a password
        // that was never the problem.
        const status = e && e.status;
        const wrong = status === 401;
        err.textContent =
          wrong ? "Not quite. Try again."
          : status === 429 ? `${String(e.message || "Too many attempts").replace(/^./, (c) => c.toUpperCase())}.`
          : status === 403 ? `This profile has been locked. Take it up with ${state.adminName}.`
          : "Couldn't reach Aurora. Try again in a moment.";
        err.classList.remove("hidden");
        if (wrong) {
          input.value = "";
          narrator.call("onWrongPassword");
        }
        input.focus();
      }
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    return [
      el("h2", {}, `${profile.avatar} ${profile.name}`),
      el("div", { class: "field" }, el("label", {}, "Enter password"), input, err),
      el("div", { style: { display: "flex", gap: "10px", marginTop: "22px" } },
        el("button", { "data-ui": "profile.unlock", class: "btn btn-primary focusable", onclick: submit }, "Unlock"),
        el("button", { class: "btn focusable", onclick: close }, "Cancel")
      ),
    ];
  });
  setTimeout(() => input.focus(), 50);
};

// ---------- kids profiles: the household PIN ----------
// The limits a kids profile can have (mirrors AGES in src/lib/kids.js).
const KIDS_AGES = [
  [0, "All ages"],
  [7, "7+"],
  [12, "12+"],
  [16, "16+"],
];
export const kidsLabel = (kids) =>
  !kids ? "" : kids.maxAge === 0 ? "all-ages titles only" : `titles up to ${kids.maxAge}+`;

// Ask for the household PIN (or, with `choose`, for a new one — typed twice).
// `action(pin)` does the real work and throws with the server's message when
// the PIN is wrong; the sheet stays open for another try. Resolves true once
// the action went through, false when the sheet was closed instead.
export const pinPrompt = ({ title, note, choose = false, ok = "Continue", action }) =>
  new Promise((resolve) => {
    let done = false;
    const pinInput = (placeholder) => el("input", {
      type: "password", class: "focusable kids-pin-input", placeholder,
      inputmode: "numeric", pattern: "[0-9]*", maxlength: "6", autocomplete: "off",
    });
    const input = pinInput(choose ? "New PIN (4–6 digits)" : "PIN");
    const again = choose ? pinInput("Once more") : null;
    const err = el("div", { class: "pw-error hidden" }, "");
    const fail = (msg) => { err.textContent = msg; err.classList.remove("hidden"); };
    let busy = false;
    modal((close) => {
      const submit = async () => {
        if (busy) return;
        err.classList.add("hidden");
        const pin = input.value.trim();
        if (!/^\d{4,6}$/.test(pin)) return fail("The PIN is 4 to 6 digits.");
        if (again && again.value.trim() !== pin) return fail("Those two don't match.");
        busy = true;
        try {
          await action(pin);
          done = true;
          close();
        } catch (e) {
          fail((e && e.message) || "That didn't work. Try again.");
          input.value = "";
          if (again) again.value = "";
          input.focus();
        } finally {
          busy = false;
        }
      };
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") (again ? again.focus() : submit()); });
      if (again) again.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
      return [
        el("h2", {}, title),
        note && el("p", { class: "field-hint", style: { marginTop: "-6px" } }, note),
        el("div", { class: "field" }, el("label", {}, choose ? "Household PIN" : "Enter the PIN"), input, again, err),
        el("div", { style: { display: "flex", gap: "10px", marginTop: "22px" } },
          el("button", { class: "btn btn-primary focusable", onclick: submit }, ok),
          el("button", { class: "btn focusable", onclick: close }, "Cancel")
        ),
      ];
    }, () => resolve(done));
    setTimeout(() => input.focus(), 50);
  });

// This browser is locked to a kids profile and someone picked another one:
// the household PIN first. Resolves true when it is fine to go on. Entering
// the kids profile itself needs nothing; an older server (no kids routes) or
// a blip has nothing to enforce here — the server-side gate is what counts.
// `got.pin` is left holding the PIN that was just accepted, so the profile
// being opened next doesn't ask for the same PIN a second time.
const leaveKidsFirst = async (target, got = {}) => {
  let st = null;
  try { st = await api.kidsStatus(); } catch { return true; }
  const lock = st && st.lock;
  if (!lock || lock.profile === target.id) return true;
  const from = state.profiles.find((x) => x.id === lock.profile);
  const lift = async (pin) => {
    await api.kidsExit(pin);
    if (pin) got.pin = pin;
    // the kids profile's unlock token must not ride the next profile's requests
    setAuthToken(null);
  };
  if (!st.pinSet) {
    // no PIN in the house (the admin page nags about this): nothing to ask
    try { await lift(""); } catch {}
    return true;
  }
  return pinPrompt({
    title: "Grown-ups only",
    note: `Enter the household PIN to leave ${from ? `“${from.name}”` : "the kids profile"}.`,
    ok: "Unlock",
    action: lift,
  });
};

// A profile with NO password, in a house that has a kids profile and a PIN:
// the PIN opens it (otherwise it is the one-tap way round the kids profile).
// The server decides — it answers `pinRequired` — and it is the server that
// refuses the unlock; this only asks. Resolves the unlock answer, or null
// when the sheet was closed (stay at the wall). A failure that is NOT about
// the PIN resolves {} as before: there is nothing to verify, entry goes on.
const unlockOpenProfile = async (p, pin = "") => {
  try { return await api.unlockProfile(p.id, "", pin); }
  catch (e) { if (!(e && e.pinRequired)) return {}; }
  let meta = null;
  const ok = await pinPrompt({
    title: "Grown-ups only",
    note: `“${p.name}” has no password, so the household PIN opens it.`,
    ok: "Open",
    action: async (typed) => { meta = await api.unlockProfile(p.id, "", typed); },
  });
  return ok ? meta || {} : null;
};

// "Pick a new password" — the forced reset. Not dismissable by a button: the
// person either saves a new password or leaves the profile.
// `currentPassword` is the one they have just typed (the wall's unlock, the
// sign-in screen). A sign-in that typed none — Google — passes null, and the
// sheet asks for it: the server changes a password only for someone who
// knows the current one.
export const newPasswordPrompt = (profile, currentPassword = null) => {
  const askCurrent = typeof currentPassword !== "string";
  const current = askCurrent
    ? el("input", { type: "password", class: "focusable", placeholder: "Current password", autocomplete: "current-password" })
    : null;
  const input = el("input", { type: "password", class: "focusable", placeholder: "New password (4+ characters)", autocomplete: "new-password" });
  const again = el("input", { type: "password", class: "focusable", placeholder: "Once more", autocomplete: "new-password" });
  const err = el("div", { class: "pw-error hidden" }, "");
  const fail = (msg) => { err.textContent = msg; err.classList.remove("hidden"); };
  modal((close) => {
    const submit = async () => {
      err.classList.add("hidden");
      if (askCurrent && !current.value) return fail("Your current password first.");
      if (input.value.length < 4) return fail("At least 4 characters.");
      if (input.value !== again.value) return fail("They don't match.");
      try {
        const fresh = input.value;
        await api.setPassword(profile.id, fresh, askCurrent ? current.value : currentPassword);
        // Saving a password ends every unlock of the profile — this tab's too
        // (the edit sheet below renews its own the same way). Without a new
        // one a profile opened at the wall was refused everything from here
        // on, and met the wall again on the next reload.
        try {
          const { token } = await api.unlockProfile(profile.id, fresh);
          if (state.profile && state.profile.id === profile.id) await setProfile(state.profile, token);
          else if (token) sessionStorage.setItem(`aurora-token-${profile.id}`, token);
        } catch {}
        close();
        toast("New password saved — it's your sign-in password too", "✅");
      } catch (e) {
        fail(e && e.message === "wrong password" ? "That is not the current password."
          : (e && e.message) || "Couldn't save it. Try again.");
      }
    };
    again.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") again.focus(); });
    if (current) current.addEventListener("keydown", (e) => { if (e.key === "Enter") input.focus(); });
    return [
      el("h2", {}, `${profile.avatar || ""} Pick a new password`),
      el("p", { class: "field-hint" }, `${state.adminName} asked you to choose a new password for “${profile.name}” before going on.`),
      current && el("div", { class: "field" }, el("label", {}, "Current password"), current),
      el("div", { class: "field" }, el("label", {}, "New password"), input),
      el("div", { class: "field" }, el("label", {}, "Once more"), again, err),
      el("div", { style: { display: "flex", gap: "10px", marginTop: "22px" } },
        el("button", { class: "btn btn-primary focusable", onclick: submit }, "Save"),
      ),
    ];
  });
  setTimeout(() => (current || input).focus(), 50);
};

// Shown once a new-profile request is filed. Creating a profile isn't instant
// any more (an admin approves it), so the viewer needs to be told that clearly —
// and lightly, so it doesn't read like a rejection.
const requestSentModal = (name, onDone) => {
  const { box } = modal((close) => [
    el("div", { class: "request-sent" },
      el("div", { class: "request-sent-emoji" }, "🍿"),
      el("h2", {}, "Request sent!"),
      el("p", {},
        `Congratulations. “${name}” is now on the pile of things ${state.adminName} has to deal with. It'll get looked at eventually — `,
        el("strong", {}, "if you want it faster, go ask in person."),
      ),
      el("p", { class: "field-hint" },
        "If it gets approved — and that part is genuinely out of our hands — your profile turns up right here. Password included, since you worked so hard on it."
      ),
    ),
    el("div", { style: { display: "flex", gap: "10px", marginTop: "22px" } },
      el("button", {
        class: "btn btn-primary focusable",
        onclick: () => { close(); onDone(); },
      }, "Got it")
    ),
  ]);
  // A remote has nothing else to land on in this modal.
  setTimeout(() => box.querySelector(".btn")?.focus({ preventScroll: true }), 50);
};

// Create (existing=null) or edit an existing profile, including its password.
export const profileModal = (existing, onDone) => {
  let avatar = existing?.avatar || AVATARS[Math.floor(Math.random() * AVATARS.length)];
  let color = existing?.color || COLORS[Math.floor(Math.random() * COLORS.length)];

  const nameInput = el("input", { type: "text", class: "focusable", value: existing?.name || "", placeholder: "Name", maxlength: "24" });
  // A kids profile's sheet has no password, email or delete (the server
  // refuses those from inside a kids profile; the admin's People tab has them).
  const wasKids = existing && existing.kids ? existing.kids : null;

  // Email — EDIT mode only (creation goes through the request-access flow).
  // Prefilled only for the signed-in profile: emails never ride the public
  // wall data, so another profile's email simply starts blank here.
  const ownEmail = existing && state.user && state.user.profileId === existing.id ? state.user.email || "" : "";
  const emailInput = existing && !wasKids
    ? el("input", {
        type: "email", class: "focusable", value: ownEmail,
        placeholder: "Email (optional)", maxlength: "80", autocomplete: "email",
        "data-initial": ownEmail,
      })
    : null;

  // Approval fields — only when REQUESTING a new profile. Editing an existing
  // one is unchanged: these never appear and are never sent.
  const realNameInput = el("input", {
    type: "text", class: "focusable", placeholder: "e.g. Dana Cohen", maxlength: "60", autocomplete: "name",
  });
  const noteInput = el("input", {
    type: "text", class: "focusable", placeholder: "Optional — a bribe, an explanation, or a fun fact", maxlength: "200",
  });

  const avatarPick = el("div", { class: "avatar-pick" },
    AVATARS.map((a) => el("button", {
      class: `focusable ${a === avatar ? "on" : ""}`,
      onclick: (e) => { avatar = a; avatarPick.querySelectorAll("button").forEach((b) => b.classList.remove("on")); e.currentTarget.classList.add("on"); },
    }, a)));
  const colorPick = el("div", { class: "color-pick" },
    COLORS.map((c) => el("button", {
      class: `focusable ${c === color ? "on" : ""}`, style: { background: c }, "aria-label": c,
      onclick: (e) => { color = c; colorPick.querySelectorAll("button").forEach((b) => b.classList.remove("on")); e.currentTarget.classList.add("on"); },
    })));

  // Password fields. New profile: password + confirm, both REQUIRED (a profile
  // is private by default; see MIN_PW). Existing: current (only if it already
  // has a password) + new (blank = leave/keep, or set).
  const isNew = !existing;
  const hasPw = !!existing?.hasPassword;
  const curPw = el("input", { type: "password", class: "focusable", placeholder: "Current password", autocomplete: "off" });
  const newPw = el("input", {
    type: "password", class: "focusable", autocomplete: "new-password",
    placeholder: hasPw ? "New password (blank = unchanged)" : isNew ? `Password (at least ${MIN_PW} characters)` : "Password (optional)",
  });
  // Confirm only on creation: a mistyped password can't be removed without
  // knowing it, so a typo here would need an admin to delete the profile.
  const confirmPw = el("input", { type: "password", class: "focusable", placeholder: "Repeat password", autocomplete: "new-password" });
  const pwErr = el("div", { class: "pw-error hidden" });

  const pwSection = wasKids ? null : el("div", {},
    el("label", {}, isNew || hasPw ? "Password" : "Password (optional)"),
    hasPw ? curPw : "",
    newPw,
    isNew ? confirmPw : "",
    isNew ? el("div", { class: "field-hint" }, "Every profile gets a password — so nobody else can blame you for your watch history.") : "",
    hasPw ? el("button", {
      class: "btn small focusable", style: { marginTop: "8px", color: "#ff7a7a" },
      onclick: async () => {
        pwErr.classList.add("hidden");
        try {
          await api.setPassword(existing.id, "", curPw.value);
          toast("Password removed — living dangerously", "🔓");
          onDoneClose();
        } catch { showPwErr("That's not the current password."); }
      },
    }, "Remove password") : ""
  );

  const showPwErr = (m) => { pwErr.textContent = m; pwErr.classList.remove("hidden"); };
  let onDoneClose = () => {};

  // Kids profile: a switch and a limit. Changing either asks for the
  // household PIN on Save (the profile's own password is the child's — it is
  // not enough, and the server refuses without the PIN). Inside a kids
  // profile the controls stay folded behind "Change…", so a child tapping
  // around the edit sheet meets one quiet line, not a switch.
  let kidsOn = !!wasKids;
  let kidsAge = wasKids ? wasKids.maxAge : 7;
  const kidsChanged = () => kidsOn !== !!wasKids || (kidsOn && wasKids && kidsAge !== wasKids.maxAge);
  const kidsSwitch = el("button", {
    class: "btn small focusable pref-item-value pref-switch", role: "switch", type: "button",
    onclick: () => { kidsOn = !kidsOn; paintKids(); },
  }, el("span", {}, ""));
  const kidsChips = el("div", { class: "kids-ages" },
    KIDS_AGES.map(([age, label]) => el("button", {
      class: "chip focusable", type: "button", "data-age": String(age),
      onclick: () => { kidsAge = age; paintKids(); },
    }, label)));
  const kidsHint = el("div", { class: "field-hint" }, "");
  const paintKids = () => {
    kidsSwitch.classList.toggle("on", kidsOn);
    kidsSwitch.setAttribute("aria-checked", String(kidsOn));
    kidsSwitch.firstChild.textContent = kidsOn ? "On" : "Off";
    kidsChips.classList.toggle("hidden", !kidsOn);
    kidsChips.querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", Number(c.dataset.age) === kidsAge));
    kidsHint.textContent = kidsOn
      ? `Shows only ${kidsLabel({ maxAge: kidsAge })}, judged by the strictest rating any country gave a title. Anything without a known age rating stays hidden. Leaving this profile takes the household PIN.`
      : "A kids profile only shows titles rated for the age you pick, and takes a PIN to leave.";
  };
  paintKids();
  const kidsControls = el("div", { class: "kids-controls" },
    el("div", { class: "kids-row" }, el("span", {}, "Kids profile"), kidsSwitch),
    kidsChips,
    kidsHint);
  const kidsSection = !existing ? null : wasKids
    ? (() => {
        kidsControls.classList.add("hidden");
        const line = el("div", { class: "kids-row" },
          el("span", {}, el("span", { class: "kids-badge" }, "Kids"), ` ${kidsLabel(wasKids)}`),
          el("button", {
            class: "btn small focusable", type: "button",
            onclick: () => { line.classList.add("hidden"); kidsControls.classList.remove("hidden"); kidsSwitch.focus(); },
          }, "Change…"));
        return el("div", { class: "field kids-field" }, line, kidsControls);
      })()
    : el("div", { class: "field kids-field" }, kidsControls);

  // Save the kids setting behind the PIN. True when there is nothing left to
  // do (unchanged, or saved); false when the PIN sheet was closed instead.
  const saveKids = async () => {
    if (!existing || !kidsChanged()) return true;
    let st = null;
    try { st = await api.kidsStatus(); } catch {}
    if (!st) {
      showPwErr("Kids profiles need the newer server — it hasn't been restarted yet.");
      return false;
    }
    const want = kidsOn ? { maxAge: kidsAge } : null;
    let saved = null;
    const done = await pinPrompt(st.pinSet
      ? {
          title: "Household PIN",
          note: want
            ? `To make “${existing.name}” a kids profile (${kidsLabel(want)}).${st.scope ? ` ${st.scope}` : ""}`
            : `To switch kids mode off for “${existing.name}”.`,
          ok: "Save",
          action: async (pin) => { saved = await api.setKids(existing.id, { kids: want, pin }); },
        }
      : {
          title: "Choose a household PIN",
          note: `4 to 6 digits, for the grown-ups. It is asked when leaving a kids profile, when opening a profile that has no password, and when changing this setting — don't tell the kids.${st.scope ? ` ${st.scope}` : ""}`,
          choose: true,
          ok: "Save",
          action: async (pin) => { saved = await api.setKids(existing.id, { kids: want, newPin: pin }); },
        });
    if (!done) return false;
    // The active profile turns into (or out of) a kids one on the spot:
    // setProfile locks this browser to it, or the server drops the lock.
    if (state.profile?.id === existing.id) {
      await setProfile({ ...state.profile, kids: (saved && saved.profile && saved.profile.kids) || null }, state.token);
    }
    toast(want ? `“${existing.name}” is a kids profile now` : "Kids mode off", want ? "🧸" : "✅");
    return true;
  };

  const { close } = modal((close) => {
    onDoneClose = () => { close(); onDone(); };
    const save = async () => {
      const name = nameInput.value.trim();
      if (!name) return nameInput.focus();
      pwErr.classList.add("hidden");
      try {
        if (existing) {
          await api.updateProfile(existing.id, { name, avatar, color });
          // Email (a sign-in identifier) lives here with the rest of the
          // profile's identity. Only sent when it actually changed.
          if (emailInput && emailInput.value.trim() !== (emailInput.dataset.initial || "")) {
            try {
              const r = await api.setProfileEmail(existing.id, emailInput.value.trim());
              if (state.user && state.user.profileId === existing.id) state.user = r.user;
            } catch (e) {
              return showPwErr(e.message || "Couldn't save that email.");
            }
          }
          if (newPw.value && !wasKids) {
            await api.setPassword(existing.id, newPw.value, hasPw ? curPw.value : "");
            // Changing the password invalidates old tokens — re-unlock and
            // persist the fresh one (via setProfile) so this session, AND the
            // next reload, stay signed in.
            if (state.profile?.id === existing.id) {
              try {
                const { token } = await api.unlockProfile(existing.id, newPw.value);
                await setProfile(state.profile, token);
              } catch {
                toast("Password changed — please switch back into this profile", "⚠️");
              }
            }
            toast("New password locked in", "🔒");
          }
        } else {
          // Mandatory password on creation, validated before the round-trip so
          // we never create a profile that then fails to get its password.
          if (newPw.value.length < MIN_PW) {
            return showPwErr(`${MIN_PW} characters. Four. We lowered the bar to the floor and you still tripped.`);
          }
          if (newPw.value !== confirmPw.value) {
            return showPwErr("Those two don't match. Happens to the best of us.");
          }
          const realName = realNameInput.value.trim();
          if (realName.length < 2) {
            return showPwErr(`Add your real name — ${state.adminName} can't approve a mystery.`);
          }
          // Files a REQUEST — the server hashes the password now, so the profile
          // is protected the moment it's approved and never exists unprotected.
          await api.createProfile({
            name, avatar, color, password: newPw.value, realName, note: noteInput.value.trim(),
          });
          // Don't drop them back into a picker that won't show the profile yet.
          close();
          requestSentModal(name, onDone);
          return;
        }
        if (!(await saveKids())) return; // PIN sheet closed: stay here, nothing lost
        onDoneClose();
      } catch (e) {
        // The server rejects a duplicate name and a flooded queue with a real
        // message — showing it beats a generic failure the viewer can't act on.
        // Show the server's own message when it sent one — "that's not the
        // current password" was claimed for EVERY edit failure, even a name
        // clash or an expired token, which is a lie.
        showPwErr(
          (e && e.message) ||
            (existing ? "Couldn't save that profile." : "Couldn't send that request — is the server awake?")
        );
      }
    };
    return [
      el("h2", {}, existing ? "Edit profile" : "New profile"),
      isNew && el("p", { class: "field-hint", style: { marginTop: "-6px" } },
        `Every new profile needs ${state.adminName}'s approval. Yes, even yours. Especially yours.`),
      el("div", { class: "field" }, el("label", {}, "Name"), nameInput),
      emailInput && el("div", { class: "field" },
        el("label", {}, "Email"),
        emailInput,
        el("div", { class: "field-hint" }, "Optional — sign in with it instead of your username. Blank removes it.")),
      isNew && el("div", { class: "field" },
        el("label", {}, "Your real name"),
        realNameInput,
        el("div", { class: "field-hint" }, "Your actual name. Not your gamertag. Whoever runs this server has to know who they're letting in.")
      ),
      isNew && el("div", { class: "field" }, el("label", {}, "Note"), noteInput),
      el("div", { class: "field" }, el("label", {}, "Avatar"), avatarPick),
      el("div", { class: "field" }, el("label", {}, "Color"), colorPick),
      kidsSection,
      el("div", { class: "field" }, pwSection, pwErr),
      el("div", { style: { display: "flex", gap: "10px", marginTop: "22px", flexWrap: "wrap" } },
        el("button", { "data-ui": "profile.save", class: "btn btn-primary focusable", onclick: save }, existing ? "Save" : "Create"),
        el("button", { class: "btn focusable", onclick: close }, "Cancel"),
        existing && !wasKids && state.profiles.length > 1 &&
          el("button", {
            class: "btn focusable", style: { marginLeft: "auto", color: "#ff7a7a" },
            onclick: async () => {
              // One tap used to delete a profile — watch history, list,
              // ratings, gone, no question asked.
              const sure = await confirmSheet({
                title: `Delete “${existing.name}”?`,
                text: "Its watch history, My List and ratings go with it. There is no undo.",
                ok: "Delete profile",
                cancel: "Keep it",
                icon: "🗑",
              });
              if (!sure) return;
              try {
                await api.deleteProfile(existing.id);
                // Deleting the profile you're currently using would leave the
                // app with no active profile — reset to the picker cleanly.
                if (state.profile?.id === existing.id) {
                  try { localStorage.removeItem("aurora-profile"); sessionStorage.removeItem(`aurora-token-${existing.id}`); } catch {}
                  location.reload();
                  return;
                }
                onDoneClose();
              } catch { showPwErr("Couldn't delete that one — locked, maybe?"); }
            },
          }, "Delete profile")
      ),
    ];
  });
  setTimeout(() => nameInput.focus(), 50);
};

// Full-screen gate; resolves when a profile is chosen (and unlocked).
//
// Built to stay usable at household scale (50+ profiles): the profiles this
// DEVICE actually uses sit in a "Recently used" band on top, everything else
// follows alphabetically in a compact grid, and a name search filters the lot.
// Small households (< SEARCH_FROM profiles) see the plain row of tiles as
// before — no search box, no section labels.
// opts.dismissable: the gate was opened over a RUNNING app (nav menu →
// "Switch profile") — Back/Escape/✕ close it and return to where you were.
// The boot gate stays non-dismissable: there is nothing behind it.
export const showProfileGate = (onChosen, opts = {}) => {
  const host = el("div", { class: "profiles-gate" });
  const wrap = el("div", { class: "ui-overlay", style: { position: "fixed", inset: 0, background: "var(--bg)", zIndex: 250, overflowY: "auto" } }, host);

  if (opts.dismissable) {
    const onBack = (e) => { e.preventDefault(); cleanup(); };
    document.addEventListener("ui-back", onBack);
    wrap.append(el("button", { "data-ui": "profile.gate.close",
      class: "gate-close focusable", "aria-label": "Close",
      onclick: () => cleanup(),
    }, "✕"));
    wrap._onBack = onBack; // removed in cleanup
  }

  const enter = async (p, token, meta) => {
    // Unlocking a claimed profile signs the device in as a side effect (the
    // server just verified the same password) — keep the client in step.
    if (meta && meta.user) state.user = meta.user;
    profilePicked(); // [analytics] profile accepted → Home usable, as a timing
    await setProfile(p, token);
    cleanup();
    onChosen(p);
    // Everything below is decoration. It runs last and cannot throw into the
    // entry path — being greeted rudely is never worth failing a sign-in.
    narrator.call("onEnterProfile", meta || {});
    narrator.call("checkTodaysWatchTime");
  };

  // Transition-mode onboarding happens HERE, at the door (elia's spec: the
  // first thing a signing-in person sees is "confirm your username / email /
  // Google" — once, then everything is as it was). If the unlock already
  // signed the device in (a claimed profile — same password) or there is
  // nothing to claim, this is a straight pass-through.
  const maybeClaimThenEnter = async (p, token, meta) => {
    if (state.authMode === "transition" && !(meta && meta.user) && !state.user) {
      setAuthToken(token || null); // the claim check needs the profile's proof
      let claimable = null;
      try { claimable = (await api.claimable(p.id)).claimable; } catch {}
      if (claimable) {
        showClaimModal(claimable, () => enter(p, token, meta), {
          required: true,
          profileId: p.id,
          onCancel: () => setAuthToken(null), // back to the wall, nothing kept
        });
        return;
      }
    }
    enter(p, token, meta);
  };

  const openProfile = async (p) => {
    // Admin-locked: no way in, not even with the password.
    if (p.locked) return toast(`That profile's been locked. Take it up with ${state.adminName}.`, "🚫");
    // Leaving a kids profile for any other one: the household PIN first.
    const got = {};
    if (!(await leaveKidsFirst(p, got))) return;
    // Signed in as this profile? The session was minted by the same password
    // — convert it to an unlock token instead of prompting again.
    if (p.hasPassword && state.user && state.user.profileId === p.id) {
      try {
        const r = await api.sessionProfileToken();
        if (r.token && r.profileId === p.id) return enter(p, r.token, {});
      } catch {}
    }
    // This browser session may still hold a valid unlock token (boot uses it;
    // the gate should too) — re-entering your own profile from "Switch
    // profile" must not demand the password again.
    if (p.hasPassword) {
      const tok = savedToken(p.id);
      if (tok) {
        setAuthToken(tok);
        try {
          await api.profileState(p.id); // 200 = token still valid
          return maybeClaimThenEnter(p, tok, {});
        } catch {
          setAuthToken(null);
        }
      }
      return passwordPrompt(p, (token, meta) => maybeClaimThenEnter(p, token, meta));
    }
    // No password to check, but still call unlock: it hands this device a
    // session token and it's what tells the server which device entered, so the
    // admin's per-profile device list covers open profiles too. A failure here
    // must never block entry — there is nothing to verify.
    // (The one thing that DOES block: the household PIN, when the server asks
    // for it — see unlockOpenProfile. Closing that sheet stays at the wall.)
    const meta = await unlockOpenProfile(p, got.pin || "");
    if (!meta) return;
    maybeClaimThenEnter(p, meta.token || null, meta);
  };

  const tile = (p) =>
    el("button", { "data-ui": "profile.pick",
      class: "profile-tile focusable",
      style: p.locked ? { opacity: "0.45" } : {},
      title: p.name,
      onclick: () => openProfile(p),
    },
      el("div", { class: "big-avatar", style: { background: p.color } },
        // uploaded photo when there is one; the emoji stays the fallback
        p.avatarImage
          ? el("img", { class: "avatar-photo", src: p.avatarImage, alt: "" })
          : p.avatar,
        (p.locked || p.hasPassword) && el("span", { class: "profile-lock" }, p.locked ? "🚫" : "🔒"),
        p.kids && el("span", { class: "profile-kids", title: `Kids profile — ${kidsLabel(p.kids)}` }, "Kids")
      ),
      el("div", { class: "name" }, p.name)
    );

  // "Add profile" opens the modern request-access flow (name, sign-in
  // identity, password — avatar and colors come later, in Preferences).
  // The old create-modal survives only as the EDIT modal.
  const addTile = () =>
    el("button", { "data-ui": "profile.add",
      class: "profile-tile add focusable",
      onclick: async () => {
        const r = await showLoginScreen({ view: "signup" });
        // the Google path can resolve a full SIGN-IN (a known Google identity
        // used the button) — honor it instead of dumping them back at the wall
        if (r && r.user && r.profile) {
          return enter(r.profile, r.profileToken || null, { user: r.user });
        }
        render();
      },
    },
      el("div", { class: "big-avatar" }, "＋"),
      el("div", { class: "name" }, "Add profile")
    );

  const searchInput = el("input", {
    type: "search", class: "focusable", placeholder: "Search profiles",
    autocomplete: "off", "aria-label": "Search profiles", enterkeyhint: "search",
  });

  const body = el("div", { class: "profiles-body" });

  const section = (label, tiles) =>
    el("div", { class: "profiles-section" },
      label && el("div", { class: "profiles-section-label" }, label),
      el("div", { class: "profiles-row" }, tiles)
    );

  // Repaints the tiles only — never the header — so typing in the search box
  // can't steal focus from it mid-keystroke.
  const paint = () => {
    const all = state.profiles;
    const query = searchInput.value.trim().toLowerCase();
    body.innerHTML = "";

    if (query) {
      const hits = all.filter((p) => (p.name || "").toLowerCase().includes(query));
      body.append(
        hits.length
          ? section(`${hits.length} ${hits.length === 1 ? "match" : "matches"}`, hits.map(tile))
          : el("div", { class: "profiles-none" }, `No profile matches “${searchInput.value.trim()}”.`)
      );
      return;
    }

    const byName = [...all].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    const recent = recentProfileIds()
      .map((id) => all.find((p) => p.id === id))
      .filter(Boolean)
      .slice(0, 8);

    // Only worth splitting into bands once the flat row stops being scannable.
    if (recent.length && all.length >= SEARCH_FROM) {
      const recentIds = new Set(recent.map((p) => p.id));
      const rest = byName.filter((p) => !recentIds.has(p.id));
      body.append(section("Recently used on this device", recent.map(tile)));
      body.append(section(rest.length ? "Other profiles" : "All profiles", [...rest.map(tile), addTile()]));
    } else {
      body.append(el("div", { class: "profiles-row" }, [...byName.map(tile), addTile()]));
    }
  };

  const focusFirstTile = () => {
    const first = body.querySelector(".profile-tile");
    if (first) first.focus({ preventScroll: true });
  };

  const render = async () => {
    await loadProfiles();
    host.innerHTML = "";
    host.classList.toggle("compact", state.profiles.length >= COMPACT_FROM);
    host.append(
      el("div", { class: "profiles-head" },
        el("h1", {}, "Who's watching?"),
        // The migration heads-up (transition mode only): one friendly line so
        // nobody is surprised by the one-time username step, plus the email
        // nudge — an email is just a username you already can't forget.
        state.authMode === "transition" &&
          el("p", { class: "profiles-note" },
            "🔑 Heads up: Aurora is moving to real sign-ins. Pick a username you'll actually remember — and add an email too. It works exactly like a username, except your brain already keeps it safe."),
        state.profiles.length >= SEARCH_FROM &&
          el("label", { class: "profiles-search" },
            el("span", { class: "profiles-search-icon", html: icons.search }),
            searchInput
          )
      ),
      body
    );
    paint();
    // Land on a profile, never the search field — a remote shouldn't open a
    // keyboard just to pick a tile.
    focusFirstTile();
  };

  searchInput.addEventListener("input", paint);

  const cleanup = () => {
    if (wrap._onBack) document.removeEventListener("ui-back", wrap._onBack);
    popScope(wrap);
    wrap.remove();
  };

  document.body.append(wrap);
  pushScope(wrap);
  render();
};

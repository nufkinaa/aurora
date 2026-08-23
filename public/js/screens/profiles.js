// Profile picker (shown before the app) + create/edit modal with optional
// password. Editing a profile / changing its password happens only at creation
// or from Settings (Preferences) for your own profile — the gate itself just
// picks (and unlocks) a profile.
import { el, icons, toast } from "../ui.js";
import { api, setAuthToken } from "../api.js";
import { state, setProfile, loadProfiles, recentProfileIds } from "../state.js";
import { pushScope, popScope } from "../focus.js";
import * as narrator from "../narrator.js";

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
const modal = (contentNodes) => {
  const close = () => {
    document.removeEventListener("ui-back", onBack);
    popScope(backdrop);
    backdrop.remove();
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
        const res = await api.unlockProfile(profile.id, input.value);
        close();
        narrator.call("onGoodPassword");
        onSuccess(res.token, res);
      } catch {
        err.classList.remove("hidden");
        input.value = "";
        input.focus();
        narrator.call("onWrongPassword");
      }
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    return [
      el("h2", {}, `${profile.avatar} ${profile.name}`),
      el("div", { class: "field" }, el("label", {}, "Enter password"), input, err),
      el("div", { style: { display: "flex", gap: "10px", marginTop: "22px" } },
        el("button", { class: "btn btn-primary focusable", onclick: submit }, "Unlock"),
        el("button", { class: "btn focusable", onclick: close }, "Cancel")
      ),
    ];
  });
  setTimeout(() => input.focus(), 50);
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

  const pwSection = el("div", {},
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

  const { close } = modal((close) => {
    onDoneClose = () => { close(); onDone(); };
    const save = async () => {
      const name = nameInput.value.trim();
      if (!name) return nameInput.focus();
      pwErr.classList.add("hidden");
      try {
        if (existing) {
          await api.updateProfile(existing.id, { name, avatar, color });
          if (newPw.value) {
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
        onDoneClose();
      } catch (e) {
        // The server rejects a duplicate name and a flooded queue with a real
        // message — showing it beats a generic failure the viewer can't act on.
        showPwErr(
          existing ? (hasPw ? "That's not the current password." : "Couldn't save that profile.")
                   : (e && e.message) || "Couldn't send that request — is the server awake?"
        );
      }
    };
    return [
      el("h2", {}, existing ? "Edit profile" : "New profile"),
      isNew && el("p", { class: "field-hint", style: { marginTop: "-6px" } },
        `Every new profile needs ${state.adminName}'s approval. Yes, even yours. Especially yours.`),
      el("div", { class: "field" }, el("label", {}, "Name"), nameInput),
      isNew && el("div", { class: "field" },
        el("label", {}, "Your real name"),
        realNameInput,
        el("div", { class: "field-hint" }, "Your actual name. Not your gamertag. Whoever runs this server has to know who they're letting in.")
      ),
      isNew && el("div", { class: "field" }, el("label", {}, "Note"), noteInput),
      el("div", { class: "field" }, el("label", {}, "Avatar"), avatarPick),
      el("div", { class: "field" }, el("label", {}, "Color"), colorPick),
      el("div", { class: "field" }, pwSection, pwErr),
      el("div", { style: { display: "flex", gap: "10px", marginTop: "22px", flexWrap: "wrap" } },
        el("button", { class: "btn btn-primary focusable", onclick: save }, existing ? "Save" : "Create"),
        el("button", { class: "btn focusable", onclick: close }, "Cancel"),
        existing && state.profiles.length > 1 &&
          el("button", {
            class: "btn focusable", style: { marginLeft: "auto", color: "#ff7a7a" },
            onclick: async () => {
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
export const showProfileGate = (onChosen) => {
  const host = el("div", { class: "profiles-gate" });
  const wrap = el("div", { class: "ui-overlay", style: { position: "fixed", inset: 0, background: "var(--bg)", zIndex: 250, overflowY: "auto" } }, host);

  const enter = async (p, token, meta) => {
    await setProfile(p, token);
    cleanup();
    onChosen(p);
    // Everything below is decoration. It runs last and cannot throw into the
    // entry path — being greeted rudely is never worth failing a sign-in.
    narrator.call("onEnterProfile", meta || {});
    narrator.call("checkTodaysWatchTime");
  };

  const openProfile = async (p) => {
    // Admin-locked: no way in, not even with the password.
    if (p.locked) return toast(`That profile's been locked. Take it up with ${state.adminName}.`, "🚫");
    if (p.hasPassword) return passwordPrompt(p, (token, meta) => enter(p, token, meta));
    // No password to check, but still call unlock: it hands this device a
    // session token and it's what tells the server which device entered, so the
    // admin's per-profile device list covers open profiles too. A failure here
    // must never block entry — there is nothing to verify.
    let token = null;
    let meta = {};
    try { meta = await api.unlockProfile(p.id, ""); token = meta.token; } catch {}
    enter(p, token, meta);
  };

  const tile = (p) =>
    el("button", {
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
        (p.locked || p.hasPassword) && el("span", { class: "profile-lock" }, p.locked ? "🚫" : "🔒")
      ),
      el("div", { class: "name" }, p.name)
    );

  const addTile = () =>
    el("button", { class: "profile-tile add focusable", onclick: () => profileModal(null, render) },
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

  const cleanup = () => { popScope(wrap); wrap.remove(); };

  document.body.append(wrap);
  pushScope(wrap);
  render();
};

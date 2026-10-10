// TV pairing confirm screen (#/pair/:code) — where the QR on the TV lands
// the phone. Shows who's asking, and one tap signs that TV in as YOU. The
// heavy lifting (sessions, sign-in state) is the app's normal machinery:
// if this phone isn't signed in yet, the login overlay handles it inline.
//
// #/pair with no code ({host}/link, the address the TV prints under "No
// camera handy?") is the same screen with a field to TYPE the code in. A
// code the server knows goes on to #/pair/:code — the very flow the QR opens;
// nothing about who may approve changes.
import { el, toast } from "../ui.js";
import { api } from "../api.js";
import { state } from "../state.js";
import { navigate } from "../router.js";
import { showLoginScreen } from "./login.js";

// The TV's alphabet (src/lib/devicepair.js): no 0 / O / 1 / I / L, six long.
const CODE_LEN = 6;
const CODE_OK = /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{6}$/;
const TOO_MANY = "Too many tries from this device — wait a few minutes, then try again.";

// The code field. A code is checked with the server before moving on, so a
// mistyped one is answered here, next to the field, instead of on a dead end.
const paintCodeForm = (screen) => {
  screen.innerHTML = "";
  const input = el("input", {
    class: "focusable pair-code-input",
    type: "text",
    maxlength: String(CODE_LEN),
    placeholder: "CODE",
    inputmode: "text",
    autocapitalize: "characters",
    autocomplete: "off",
    autocorrect: "off",
    spellcheck: "false",
    enterkeyhint: "go",
    "aria-label": "The code on the TV",
  });
  const err = el("div", { class: "pw-error hidden", role: "alert" }, "");
  const fail = (msg) => { err.textContent = msg; err.classList.remove("hidden"); };
  const goBtn = el("button", { class: "btn btn-primary focusable" }, "Continue");
  let busy = false;
  const go = async () => {
    if (busy) return;
    err.classList.add("hidden");
    const code = input.value.trim().toUpperCase();
    if (!CODE_OK.test(code)) {
      input.focus();
      return fail(`The code is ${CODE_LEN} letters and numbers — it is on the TV's sign-in screen.`);
    }
    busy = true;
    goBtn.disabled = true;
    try {
      await api.devicePairDescribe(code);
      navigate(`#/pair/${code}`);
    } catch (e) {
      fail(e && e.status === 429 ? TOO_MANY
        : e && e.status === 404 ? "No TV is showing that code right now. Check it against the screen — codes live five minutes, so the TV may have a fresh one."
        : "Couldn't reach Aurora — try again.");
      input.select();
    } finally {
      busy = false;
      goBtn.disabled = false;
    }
  };
  goBtn.addEventListener("click", go);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  input.addEventListener("input", () => {
    input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, CODE_LEN);
    err.classList.add("hidden");
  });
  const card = el("div", { class: "pair-card" },
    el("div", { class: "pair-glyph" }, "📺"),
    el("h1", {}, "Sign in a TV"),
    el("p", { class: "pair-sub" }, "Type the code shown on the TV's sign-in screen."),
    input,
    err,
    el("div", { style: { display: "flex", gap: "10px", marginTop: "18px", flexWrap: "wrap" } },
      goBtn,
      el("button", { class: "btn focusable", onclick: () => navigate("#/") }, "Cancel")),
  );
  screen.append(el("div", { class: "pair-wrap" }, card));
  setTimeout(() => input.focus({ preventScroll: true }), 60);
};

export const renderPair = async (root, params) => {
  const code = String(params.code || "").toUpperCase();
  const screen = el("div", { class: "screen pair-screen" });
  root.append(screen);

  if (!code) return void paintCodeForm(screen);

  const paint = async () => {
    screen.innerHTML = "";
    let info = null;
    let refused = null;
    try {
      info = await api.devicePairDescribe(code);
    } catch (e) {
      refused = e;
    }

    const card = el("div", { class: "pair-card" });
    screen.append(el("div", { class: "pair-wrap" }, card));

    if (!info && refused && refused.status === 429) {
      card.append(
        el("div", { class: "pair-glyph" }, "✋"),
        el("h1", {}, "Slow down"),
        el("p", { class: "pair-sub" }, TOO_MANY),
        el("button", { class: "btn btn-primary focusable", onclick: () => navigate("#/") }, "Back to Aurora"),
      );
      return;
    }
    if (!info) {
      card.append(
        el("div", { class: "pair-glyph" }, "⌛"),
        el("h1", {}, "That code expired"),
        el("p", { class: "pair-sub" }, "Pairing codes live five minutes. Ask the TV for a fresh one and scan again — or type the new code."),
        el("div", { style: { display: "flex", gap: "10px", flexWrap: "wrap" } },
          el("button", { class: "btn btn-primary focusable", onclick: () => navigate("#/pair") }, "Type a code"),
          el("button", { class: "btn focusable", onclick: () => navigate("#/") }, "Back to Aurora")),
      );
      return;
    }
    if (info.approved) {
      card.append(
        el("div", { class: "pair-glyph" }, "✅"),
        el("h1", {}, "Already approved"),
        el("p", { class: "pair-sub" }, "The TV should be signing in right now."),
        el("button", { class: "btn btn-primary focusable", onclick: () => navigate("#/") }, "Done"),
      );
      return;
    }

    const who = info.device
      ? [info.device.device, info.device.os].filter((x) => x && x !== "Other").join(" · ") || "A device"
      : "A device";

    if (!state.user) {
      card.append(
        el("div", { class: "pair-glyph" }, "📺"),
        el("h1", {}, "Sign in to approve"),
        el("p", { class: "pair-sub" },
          `${who} wants to sign in to Aurora as you. Prove it's you first — then one tap finishes the TV.`),
        el("button", {
          class: "btn btn-primary focusable",
          onclick: async () => {
            const r = await showLoginScreen({ skippable: true });
            if (r && r.user) {
              state.user = r.user;
              paint();
            }
          },
        }, "Sign in"),
      );
      return;
    }

    const approveBtn = el("button", { class: "btn btn-primary focusable" }, `Yes — sign it in as @${state.user.username || state.user.name}`);
    approveBtn.addEventListener("click", async () => {
      approveBtn.disabled = true;
      try {
        await api.devicePairApprove(code);
        card.innerHTML = "";
        card.append(
          el("div", { class: "pair-glyph" }, "🎉"),
          el("h1", {}, "Done"),
          el("p", { class: "pair-sub" }, "Look at the TV — it's signing in as you right now."),
          el("button", { class: "btn btn-primary focusable", onclick: () => navigate("#/") }, "Back to Aurora"),
        );
      } catch (e) {
        toast(e.message || "That didn't work — scan again", "🙃");
        approveBtn.disabled = false;
      }
    });

    card.append(
      el("div", { class: "pair-glyph" }, "📺"),
      el("h1", {}, "Sign this TV in?"),
      el("p", { class: "pair-sub" },
        el("strong", {}, who),
        ` is asking to use your Aurora sign-in. Only approve this if the code on its screen is `,
        el("strong", { class: "pair-code" }, code),
        `.`),
      el("div", { style: { display: "flex", gap: "10px", marginTop: "18px", flexWrap: "wrap" } },
        approveBtn,
        el("button", { class: "btn focusable", onclick: () => navigate("#/") }, "No, ignore it")),
    );
  };

  await paint();
};

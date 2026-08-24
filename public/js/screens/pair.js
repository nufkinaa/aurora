// TV pairing confirm screen (#/pair/:code) — where the QR on the TV lands
// the phone. Shows who's asking, and one tap signs that TV in as YOU. The
// heavy lifting (sessions, sign-in state) is the app's normal machinery:
// if this phone isn't signed in yet, the login overlay handles it inline.
import { el, toast } from "../ui.js";
import { api } from "../api.js";
import { state } from "../state.js";
import { navigate } from "../router.js";
import { showLoginScreen } from "./login.js";

export const renderPair = async (root, params) => {
  const code = String(params.code || "").toUpperCase();
  const screen = el("div", { class: "screen pair-screen" });
  root.append(screen);

  const paint = async () => {
    screen.innerHTML = "";
    let info = null;
    try {
      info = await api.devicePairDescribe(code);
    } catch {}

    const card = el("div", { class: "pair-card" });
    screen.append(el("div", { class: "pair-wrap" }, card));

    if (!info) {
      card.append(
        el("div", { class: "pair-glyph" }, "⌛"),
        el("h1", {}, "That code expired"),
        el("p", { class: "pair-sub" }, "Pairing codes live five minutes. Ask the TV for a fresh one and scan again."),
        el("button", { class: "btn btn-primary focusable", onclick: () => navigate("#/") }, "Back to Aurora"),
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

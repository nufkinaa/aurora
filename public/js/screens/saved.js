// Saved on this device: titles kept in the browser's own storage, playable
// with no server in reach. Play opens the player in offline mode; Remove
// frees the space. Only ever shows THIS device's copies.
import { el, icons, fmtBytes, fmtClock, toast } from "../ui.js";
import { navigate } from "../router.js";
import { state, progressFor } from "../state.js";
import * as offline from "../offline.js";

const label = (it) =>
  it.showTitle ? `${it.showTitle} · S${it.season} E${it.episode}${it.title ? ` · ${it.title}` : ""}` : it.title;

export const renderSaved = async (root) => {
  const screen = el("div", { class: "screen" });
  root.append(screen);
  const body = el("div", { class: "page-pad" });
  const usage = el("span", { class: "count" });
  screen.append(el("div", { class: "browse-head" }, el("h1", {}, "Saved on this device"), usage), body);

  if (!offline.available()) {
    body.append(
      el(
        "div",
        { class: "empty" },
        el("div", { class: "glyph" }, "🔒"),
        "Offline copies need a secure address (https, or localhost). Open Aurora over https and the Save-offline buttons appear on every title you own.",
      ),
    );
    return;
  }

  const paint = async () => {
    body.innerHTML = "";
    const items = await offline.listSaved();
    const est = await offline.storageEstimate();
    usage.textContent = est && est.usage ? `${fmtBytes(est.usage)} used${est.quota ? ` of ${fmtBytes(est.quota)}` : ""}` : "";
    if (!items.length) {
      body.append(
        el(
          "div",
          { class: "empty" },
          el("div", { class: "glyph" }, "📱"),
          "Nothing saved yet. On any title you own, press “Save offline” and it lands here — playable with no server in reach.",
        ),
      );
      return;
    }
    body.append(
      el(
        "div",
        { class: "dl-list" },
        items.map((it) => {
          const p = progressFor(it.id);
          return el(
            "div",
            { class: "dl-row tone-ok" }, // a saved copy is a ready one
            el("div", { class: "dl-poster" }, it.cover ? el("img", { src: it.cover, alt: "" }) : el("div", { class: "card-fallback" }, it.title)),
            el(
              "div",
              { class: "dl-info" },
              el("div", { class: "dl-title" }, label(it)),
              el(
                "div",
                { class: "dl-status" },
                [
                  it.sizeBytes ? fmtBytes(it.sizeBytes) : null,
                  it.duration ? fmtClock(it.duration) : null,
                  p && !p.finished && p.position > 10 ? `resume at ${fmtClock(p.position)}` : null,
                  it.subtitles && it.subtitles.length ? `${it.subtitles.length} subtitle track${it.subtitles.length > 1 ? "s" : ""}` : null,
                ]
                  .filter(Boolean)
                  .join(" · "),
              ),
            ),
            el(
              "div",
              { class: "dl-actions" },
              el("button", {
                class: "btn btn-primary focusable",
                html: icons.play + "<span>Play</span>",
                onclick: () => navigate(`#/play/${it.id}?offline=1`),
              }),
              el("button", {
                class: "btn focusable",
                html: "<span>Remove</span>",
                onclick: async () => {
                  await offline.removeSaved(it.id);
                  toast(`Removed “${it.title}” from this device`, "🗑");
                  paint();
                },
              }),
            ),
          );
        }),
      ),
    );
  };
  await paint();
};

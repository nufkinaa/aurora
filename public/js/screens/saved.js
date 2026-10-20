// On this device: everything that plays right here, with or without a server.
//   Your files         videos and subtitles from this computer or phone, as a
//                      small library (js/localview.js) — nothing is uploaded
//   Saving now         saves to this device under way (js/devicejobs.js)
//   Saved for offline  titles kept in the browser's own storage, playable with
//                      no server in reach. Play opens the player in offline
//                      mode; Remove frees the space. Only THIS device's copies.
import { el, icons, fmtBytes, fmtClock, toast } from "../ui.js";
import { navigate, untilLeave } from "../router.js";
import { state, progressFor } from "../state.js";
import * as offline from "../offline.js";
import { yourFilesSection } from "../localview.js";
import { deviceJobsSection } from "../devicejobs.js";

// (an episode whose only name is its file's — "Show S01E02" — is not named twice)
const label = (it) =>
  it.showTitle ? `${it.showTitle} · S${it.season} E${it.episode}${it.title && it.title !== it.showTitle && !/^.+ S\d+E\d+$/i.test(it.title) ? ` · ${it.title}` : ""}` : it.title;

export const renderSaved = async (root) => {
  const screen = el("div", { class: "screen saved-screen" });
  root.append(screen);
  // The app came up with no server to talk to (main.js boot): say so, with
  // the way to try again — what is below still works.
  const down = state.noServer
    ? el("div", { class: "page-pad" },
      el("div", { class: "local-noserver", role: "status" },
        el("span", {}, "📡 Can't reach the Aurora server — your files and the saved titles still play."),
        el("button", { class: "btn small focusable", onclick: () => location.reload() }, "Try again")))
    : null;
  // ONE place for what is on this device, online or not (elia, 2026-10-18:
  // "a user can't see, while he's connected, his offline library … and also
  // download status and progress").
  const savedCount = el("span", { class: "count" });
  const savedTotal = el("span", { class: "saved-total" });
  const body = el("div", { class: "saved-body" });
  const savedSection = el("section", { class: "dl-section saved-section page-pad", "aria-labelledby": "saved-title" },
    el("h2", { class: "row-title saved-head", id: "saved-title" }, "Saved for offline", savedCount, savedTotal),
    body);
  screen.append(...[
    el("div", { class: "browse-head saved-top" },
      el("h1", {}, "On this device"),
      el("span", { class: "count" }, "Plays right here — even with no connection")),
    down,
    // what is on its way first: on a phone, Your files' big picker used to
    // push a save in progress below the fold (2026-10-20). (Once titles are
    // saved that picker folds to a strip — .has-saved — so the list is near.)
    offline.available() ? el("div", { class: "page-pad saving-host" }, deviceJobsSection({ title: "Saving now" })) : null,
    yourFilesSection(),
    savedSection,
  ].filter(Boolean));

  if (!offline.available()) {
    body.append(el("p", { class: "dl-note saved-empty" }, "🔒 Saving titles for offline needs a secure address (https, or localhost). Open Aurora over https and the Save-offline buttons appear on every title you own."));
    return;
  }

  let gen = 0;
  const paint = async () => {
    const mine = ++gen;
    const items = await offline.listSaved();
    const est = await offline.storageEstimate();
    if (mine !== gen) return; // a newer paint is on its way
    body.innerHTML = "";
    savedCount.textContent = items.length ? String(items.length) : "";
    // (titles saved: the empty "Your files" drop zone is a strip, not a wall above them)
    screen.classList.toggle("has-saved", items.length > 0);
    const total = items.reduce((n, it) => n + (it.sizeBytes || 0), 0);
    savedTotal.textContent = [
      total ? fmtBytes(total) : null,
      est && est.usage && est.quota ? `${fmtBytes(est.usage)} of ${fmtBytes(est.quota)} used on this device` : null,
    ].filter(Boolean).join(" · ");
    if (!items.length) {
      body.append(el("p", { class: "dl-note saved-empty" }, "Nothing saved for offline yet. On any title you own, press “Save offline” and it lands here — playable with no server in reach."));
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
              el("div", { class: "dl-title", dir: "auto" }, label(it)),
              el(
                "div",
                { class: "dl-status" },
                [
                  it.quality ? (it.quality === "original" ? "Original quality" : `${it.quality}p`) : null,
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
              el("button", { "data-ui": "saved.play",
                class: "btn btn-primary focusable",
                html: icons.play + "<span>Play</span>",
                onclick: () => navigate(`#/play/${it.id}?offline=1`),
              }),
              el("button", { "data-ui": "saved.remove",
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
  // a save that finishes (its job goes) lands in the list at once
  let running = offline.listJobs().length;
  untilLeave(offline.onJobs((jobs) => {
    if (jobs.length < running) paint();
    running = jobs.length;
  }));
};

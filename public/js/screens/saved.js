// Saved on this device: titles kept in the browser's own storage, playable
// with no server in reach. Play opens the player in offline mode; Remove
// frees the space. Only ever shows THIS device's copies.
// On top, "Play a file from this device" (js/localplay.js): a video from the
// computer or phone, in Aurora's player, with nothing uploaded — the one
// thing besides the saved copies that works with no server at all.
import { el, icons, fmtBytes, fmtClock, toast } from "../ui.js";
import { navigate, untilLeave } from "../router.js";
import { state, progressFor } from "../state.js";
import * as offline from "../offline.js";
import { localPlayCard } from "../localplay.js";
import { deviceJobsSection } from "../devicejobs.js";

const label = (it) =>
  it.showTitle ? `${it.showTitle} · S${it.season} E${it.episode}${it.title ? ` · ${it.title}` : ""}` : it.title;

export const renderSaved = async (root) => {
  const screen = el("div", { class: "screen" });
  root.append(screen);
  const body = el("div", { class: "page-pad" });
  const usage = el("span", { class: "count" });
  // The app came up with no server to talk to (main.js boot): say so, with
  // the way to try again — what is below still works.
  const down = state.noServer
    ? el("div", { class: "page-pad" },
      el("div", { class: "local-noserver", role: "status" },
        el("span", {}, "📡 Can't reach the Aurora server — saved titles and files from this device still play."),
        el("button", { class: "btn small focusable", onclick: () => location.reload() }, "Try again")))
    : null;
  // ONE place for what is on this device, online or not (elia, 2026-10-18:
  // "a user can't see, while he's connected, his offline library … and also
  // download status and progress"): saves under way, the saved titles, and
  // a video from the computer or phone.
  const jobsHost = el("div", { class: "page-pad" });
  // (nothing saved yet: the file picker comes first, the saved list's
  // one-line note under it — see paint)
  const cardHost = el("div", { class: "page-pad" }, localPlayCard());
  screen.append(...[
    el("div", { class: "browse-head" }, el("h1", {}, "On this device"), usage),
    down,
    jobsHost,
    body,
    cardHost,
  ].filter(Boolean));
  if (offline.available()) jobsHost.append(deviceJobsSection());

  if (!offline.available()) {
    body.append(el("p", { class: "dl-note" }, "🔒 Saving titles for offline needs a secure address (https, or localhost). Open Aurora over https and the Save-offline buttons appear on every title you own."));
    body.before(cardHost);
    return;
  }

  let gen = 0;
  const paint = async () => {
    const mine = ++gen;
    const items = await offline.listSaved();
    const est = await offline.storageEstimate();
    if (mine !== gen) return; // a newer paint is on its way
    body.innerHTML = "";
    usage.textContent = est && est.usage ? `${fmtBytes(est.usage)} used${est.quota ? ` of ${fmtBytes(est.quota)}` : ""}` : "";
    if (!items.length) {
      body.append(el("p", { class: "dl-note saved-empty" }, "No titles saved on this device yet. On any title you own, press “Save offline” and it lands here — playable with no server in reach."));
      body.before(cardHost);
      return;
    }
    body.after(cardHost);
    const total = items.reduce((n, it) => n + (it.sizeBytes || 0), 0);
    body.append(
      el("h2", { class: "row-title saved-head" }, "Saved titles", el("span", { class: "count" }, String(items.length)),
        total ? el("span", { class: "saved-total" }, fmtBytes(total)) : null),
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

// My downloads: what THIS profile asked the server to fetch, in the three
// states that matter to the person waiting — ready to play, on its way, and
// waiting on an admin — plus the ones that didn't make it. Only your own
// requests: the household queue (everyone's) stays in the admin panel.
//
// A finished download plays straight from here (the job knows the library
// id its file was indexed under), and playing it — or pressing Open — clears
// the nav's "✓ ready" nudge for it everywhere you're signed in.
import { el, icons, posterImg, fmtBytes, toast } from "../ui.js";
import { navigate } from "../router.js";
import { api } from "../api.js";
import { state, downloads, myDownloads } from "../state.js";
import { onMessage } from "../ws.js";

const ACTIVE = ["approved", "downloading"];

const when = (iso) => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = Date.now() - t;
  if (d < 60e3) return "just now";
  if (d < 3600e3) return `${Math.round(d / 60e3)} min ago`;
  if (d < 86400e3) return `${Math.round(d / 3600e3)} h ago`;
  return new Date(t).toLocaleDateString();
};

const fmtSpeed = (bps) => (bps > 0 ? `${(bps / 1e6).toFixed(1)} MB/s` : "");

const eta = (job) => {
  if (!job.sizeBytes || !job.downloadSpeed) return "";
  const left = job.sizeBytes * (1 - (job.progress || 0));
  const s = Math.round(left / job.downloadSpeed);
  if (s < 60) return "under a minute";
  if (s < 3600) return `${Math.round(s / 60)} min left`;
  return `${(s / 3600).toFixed(1)} h left`;
};

const statusLine = (job) => {
  switch (job.status) {
    case "done":
      return job.libraryId ? `Ready · ${when(job.doneAt)}` : "Finished — indexing…";
    case "downloading":
      return job.phase === "copying"
        ? `Copying into the library · ${Math.round((job.copyProgress || 0) * 100)}%`
        : job.phase === "finding" || job.phase === "starting"
          ? "Finding peers…"
          : [`${Math.round((job.progress || 0) * 100)}%`, fmtSpeed(job.downloadSpeed), eta(job)]
              .filter(Boolean)
              .join(" · ");
    case "approved":
      return "Queued — starts when a slot frees up";
    case "pending":
      return job.holdReason ? `Waiting for approval — ${job.holdReason}` : "Waiting for approval";
    case "declined":
      return "Declined by the admin";
    case "canceled":
      return "Canceled";
    case "error":
      return `Failed — ${job.error || "unknown error"}`;
    default:
      return job.status;
  }
};

const seen = (job) => {
  if (!state.profile || job.seenAt) return;
  api.downloadSeen(job.id, state.profile.id).catch(() => {});
};

const row = (job) => {
  const ready = job.status === "done" && job.libraryId;
  const fresh = ready && !job.seenAt;
  const actions = [];
  if (ready) {
    actions.push(
      el("button", {
        class: "btn btn-primary focusable",
        html: icons.play + "<span>Play</span>",
        onclick: () => {
          seen(job);
          navigate(`#/play/${job.libraryId}`);
        },
      }),
    );
  }
  if (job.imdbId) {
    actions.push(
      el("button", {
        class: "btn focusable",
        html: "<span>Open</span>",
        onclick: () => {
          seen(job);
          navigate(`#/discover/${job.type === "show" ? "series" : "movie"}/${job.imdbId}`);
        },
      }),
    );
  }
  // Yours, and not landed yet: one press takes it back (a mis-tap on a 60 GB
  // pack shouldn't be an admin's problem).
  if (job.mine && ["pending", "approved", "downloading", "error"].includes(job.status)) {
    actions.push(
      el("button", {
        class: "btn focusable",
        html: `<span>${job.status === "error" ? "Remove" : "Cancel"}</span>`,
        onclick: async (e) => {
          e.currentTarget.disabled = true;
          try {
            await api.downloadCancel(job.id, state.profile.id);
            toast(`Cancelled “${job.label || job.title}”`, "🗑");
          } catch (err) {
            e.currentTarget.disabled = false;
            toast(err.message || "Couldn't cancel", "⚠️");
          }
        },
      }),
    );
  }
  const pct = ACTIVE.includes(job.status) ? Math.round((job.progress || 0) * 100) : null;
  return el(
    "div",
    { class: `dl-row focusable-group ${job.status}${fresh ? " fresh" : ""}`, "data-id": job.id },
    el(
      "div",
      { class: "dl-poster" },
      job.poster ? posterImg(job.poster, job.title) : el("div", { class: "card-fallback" }, job.title),
    ),
    el(
      "div",
      { class: "dl-info" },
      el(
        "div",
        { class: "dl-title" },
        job.label || job.title,
        fresh && el("span", { class: "dl-new" }, "NEW"),
        job.quality && el("span", { class: "dl-quality" }, job.quality),
      ),
      el(
        "div",
        { class: "dl-status" },
        job.smart ? "Next episode, queued for you · " : "",
        statusLine(job),
        job.sizeBytes ? ` · ${fmtBytes(job.sizeBytes)}` : "",
      ),
      pct != null &&
        el("div", { class: "dl-bar" }, el("div", { class: "dl-bar-fill", style: { width: `${pct}%` } })),
    ),
    el("div", { class: "dl-actions" }, actions),
  );
};

const section = (title, jobs, emptyText) => {
  if (!jobs.length && !emptyText) return null;
  return el(
    "section",
    { class: "dl-section" },
    el("h2", { class: "row-title" }, title, el("span", { class: "count" }, jobs.length ? String(jobs.length) : "")),
    jobs.length ? el("div", { class: "dl-list" }, jobs.map(row)) : el("div", { class: "empty small" }, emptyText),
  );
};

export const renderDownloads = async (root) => {
  const screen = el("div", { class: "screen" });
  root.append(screen);
  const body = el("div", { class: "page-pad" });
  screen.append(
    el(
      "div",
      { class: "browse-head" },
      el("h1", {}, "My downloads"),
      el("span", { class: "count" }, state.profile ? `for ${state.profile.name}` : ""),
    ),
    body,
  );

  const paint = () => {
    body.innerHTML = "";
    if (!state.profile) {
      body.append(el("div", { class: "empty" }, "Pick a profile to see your downloads."));
      return;
    }
    const mine = myDownloads().sort((a, b) => Date.parse(b.at || 0) - Date.parse(a.at || 0));
    const ready = mine.filter((j) => j.status === "done");
    const moving = mine.filter((j) => ACTIVE.includes(j.status));
    const waiting = mine.filter((j) => j.status === "pending");
    const failed = mine.filter((j) => ["error", "declined", "canceled"].includes(j.status));
    if (!mine.length) {
      body.append(
        el(
          "div",
          { class: "empty" },
          el("div", { class: "glyph" }, "⬇"),
          "Nothing yet. Tap the ⬇ next to any source on a title's page and it lands here.",
        ),
      );
      return;
    }
    body.append(
      ...[
        section("Ready to play", ready.sort((a, b) => (a.seenAt ? 1 : 0) - (b.seenAt ? 1 : 0)), null),
        section("On its way", moving, null),
        section("Waiting for approval", waiting, null),
        section("Didn't make it", failed, null),
      ].filter(Boolean),
    );
  };
  paint();

  // Live: progress ticks, a finish, an approval — repaint the row that moved.
  const unsub = onMessage("download_update", ({ job }) => {
    if (!screen.isConnected) return unsub();
    if (!job) return;
    downloads.set(job.id, job);
    if (job.status === "done" && job.libraryId && !job.seenAt && job.mine) {
      toast(`“${job.label || job.title}” is ready to play`, "✅");
    }
    paint();
  });
  return () => unsub();
};

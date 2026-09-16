// My downloads: what THIS profile asked the server to fetch, grouped by the
// only thing the person waiting cares about — is it moving, is it waiting on
// someone, can I play it yet, did it die. Only your own requests: the
// household queue (everyone's) stays in the admin panel, and what the rest of
// the house has in flight sits at the bottom, without buttons, so a slow
// queue explains itself.
//
// A finished download plays straight from here (the job knows the library
// id its file was indexed under), and playing it — or pressing Open — clears
// the nav's "✓ ready" nudge for it everywhere you're signed in. A dead
// request can be retried (same source, one press) or cleared off the page.
import { el, icons, posterImg, fmtBytes, toast, confirmSheet } from "../ui.js";
import { navigate } from "../router.js";
import { api } from "../api.js";
import { state, downloads, myDownloads } from "../state.js";
import { onMessage } from "../ws.js";

const ACTIVE = ["approved", "downloading"];
const DEAD = ["error", "declined", "canceled"];

// Not the asker's — what the rest of the household has moving or waiting.
const othersDownloads = () =>
  [...downloads.values()].filter((j) => !j.mine && ["approved", "downloading", "pending"].includes(j.status));

const when = (iso) => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = Date.now() - t;
  if (d < 60e3) return "just now";
  if (d < 3600e3) return `${Math.round(d / 60e3)} min ago`;
  if (d < 86400e3) return `${Math.round(d / 3600e3)} h ago`;
  if (d < 7 * 86400e3) return `${Math.round(d / 86400e3)} d ago`;
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
};

const fmtSpeed = (bps) => (bps > 0 ? `${(bps / 1e6).toFixed(1)} MB/s` : "");

const eta = (job) => {
  if (!job.sizeBytes || !job.downloadSpeed) return "";
  const left = job.sizeBytes * (1 - (job.progress || 0));
  const s = Math.round(left / job.downloadSpeed);
  if (s < 60) return "under a minute left";
  if (s < 3600) return `${Math.round(s / 60)} min left`;
  return `${(s / 3600).toFixed(1)} h left`;
};

// One word for the state, and the line under the title. `tone` colours the
// row's edge and the status dot: ok / busy / wait / bad.
const describe = (job) => {
  switch (job.status) {
    case "done":
      return job.libraryId
        ? { tone: "ok", head: "Ready to play", line: [when(job.doneAt), job.sizeBytes && fmtBytes(job.sizeBytes)].filter(Boolean).join(" · ") }
        : { tone: "busy", head: "Finished", line: "Adding it to the library…", spin: true };
    case "downloading": {
      if (job.phase === "copying")
        return { tone: "busy", head: "Almost there", line: `Copying into the library · ${Math.round((job.copyProgress || 0) * 100)}%`, spin: true };
      if (job.phase === "finding" || job.phase === "starting" || !(job.progress > 0))
        return { tone: "busy", head: "Starting", line: job.peers > 0 ? `Connected to ${job.peers} peer${job.peers === 1 ? "" : "s"} — waiting for the first bytes` : "Finding peers…", spin: true };
      const pct = Math.round((job.progress || 0) * 100);
      return {
        tone: "busy",
        head: `Downloading · ${pct}%`,
        line: [fmtSpeed(job.downloadSpeed), eta(job), job.sizeBytes && fmtBytes(job.sizeBytes)].filter(Boolean).join(" · "),
      };
    }
    case "approved":
      return { tone: "wait", head: "Queued", line: "Starts when a download slot frees up" };
    case "pending":
      return {
        tone: "wait",
        head: "Waiting for approval",
        line: job.holdReason ? `${state.adminName} has to okay this one — ${job.holdReason}` : `${state.adminName} has to okay this one`,
      };
    case "declined":
      return { tone: "bad", head: "Declined", line: `${state.adminName} said no to this one` };
    case "canceled":
      return { tone: "bad", head: "Canceled", line: when(job.resolvedAt || job.at) };
    case "error":
      return { tone: "bad", head: "Failed", line: job.error || "The download stopped and couldn't recover" };
    default:
      return { tone: "wait", head: job.status, line: "" };
  }
};

// Buttons pressed and still waiting on the server — a live tick repaints the
// row, and the fresh button must not come back enabled mid-request.
const busy = new Set();

const seen = (job) => {
  if (!state.profile || job.seenAt) return;
  api.downloadSeen(job.id, state.profile.id).catch(() => {});
};

// The same request again — the server allows a second attempt once the first
// is dead, and the job carries every field the request needs.
const retry = async (job, btn) => {
  if (!state.profile) return;
  btn.disabled = true;
  try {
    const res = await api.requestDownload({
      infoHash: job.infoHash,
      fileIdx: job.fileIdx,
      type: job.type,
      imdbId: job.imdbId,
      title: job.title,
      label: job.label,
      poster: job.poster,
      quality: job.quality,
      sizeBytes: job.sizeBytes || 0,
      season: job.season || null,
      episode: job.episode || null,
      provider: job.provider || null,
      profile: state.profile.id,
    });
    if (res.error) throw new Error(res.error);
    if (res.alreadyAvailable) return toast("Already yours — it's in the library", "✅");
    toast(res.duplicate ? "That one is already on its way" : `Trying “${job.label || job.title}” again`, "⬇");
    // the dead row is history now — clear it so the page shows one row, not two
    api.downloadDismiss(job.id, state.profile.id).catch(() => {});
  } catch (err) {
    btn.disabled = false;
    toast(err.message || "Couldn't start it again", "⚠️");
  }
};

const row = (job, { others = false } = {}) => {
  const d = describe(job);
  const ready = job.status === "done" && job.libraryId;
  const fresh = ready && !job.seenAt && job.mine;
  const actions = [];
  if (!others) {
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
          html: `<span>${ready ? "Title page" : "Open"}</span>`,
          onclick: () => {
            seen(job);
            navigate(`#/discover/${job.type === "show" ? "series" : "movie"}/${job.imdbId}`);
          },
        }),
      );
    }
    // Yours, and not landed yet: one press takes it back (a mis-tap on a 60 GB
    // pack shouldn't be an admin's problem). A pack that is already moving
    // asks first — cancelling throws the bytes away.
    if (job.mine && ["pending", "approved", "downloading"].includes(job.status)) {
      actions.push(
        el("button", {
          class: "btn focusable",
          html: "<span>Cancel</span>",
          disabled: busy.has(job.id) || undefined,
          onclick: async (e) => {
            const b = e.currentTarget; // gone from the event once the await returns
            if (job.status === "downloading" && (job.progress || 0) > 0.05) {
              const ok = await confirmSheet({
                title: `Cancel “${job.label || job.title}”?`,
                text: `It's ${Math.round((job.progress || 0) * 100)}% down. Cancelling throws that away; you can always ask for it again.`,
                ok: "Cancel the download",
                cancel: "Keep going",
                icon: "🗑",
              });
              if (!ok) return;
            }
            b.disabled = true;
            busy.add(job.id);
            try {
              await api.downloadCancel(job.id, state.profile.id);
              toast(`Cancelled “${job.label || job.title}”`, "🗑");
            } catch (err) {
              b.disabled = false;
              toast(err.message || "Couldn't cancel", "⚠️");
            } finally {
              busy.delete(job.id);
            }
          },
        }),
      );
    }
    if (job.mine && DEAD.includes(job.status)) {
      if (job.infoHash && job.status !== "declined") {
        actions.push(
          el("button", {
            class: "btn focusable",
            html: "<span>Try again</span>",
            onclick: (e) => retry(job, e.currentTarget),
          }),
        );
      }
      actions.push(
        el("button", {
          class: "btn focusable quiet",
          html: "<span>Remove</span>",
          "aria-label": `Remove “${job.label || job.title}” from this list`,
          onclick: async (e) => {
            const b = e.currentTarget;
            b.disabled = true;
            try {
              await api.downloadDismiss(job.id, state.profile.id);
            } catch (err) {
              b.disabled = false;
              toast(err.message || "Couldn't remove it", "⚠️");
            }
          },
        }),
      );
    }
  }
  const pct = job.status === "downloading" && job.phase !== "copying" ? Math.round((job.progress || 0) * 100) : null;
  const sub = [];
  if (job.type === "show" && job.season && job.episode && !/S\d+ ?E\d+/i.test(job.label || "")) sub.push(`S${job.season} E${job.episode}`);
  if (job.quality) sub.push(job.quality);
  if (job.provider && !others) sub.push(job.provider);
  return el(
    "div",
    { class: `dl-row tone-${d.tone} ${job.status}${fresh ? " fresh" : ""}${others ? " others" : ""}`, "data-id": job.id },
    el(
      "div",
      { class: "dl-poster" },
      job.poster ? posterImg(job.poster, job.title, "dl-poster-img", "card-fallback", { w: 64 }) : el("div", { class: "card-fallback" }, job.title),
    ),
    el(
      "div",
      { class: "dl-info" },
      el(
        "div",
        { class: "dl-title" },
        el("span", { class: "dl-name" }, job.label || job.title),
        fresh && el("span", { class: "dl-new" }, "NEW"),
        job.smart && el("span", { class: "dl-auto", title: "Queued by smart downloads — the next episode, fetched ahead of you" }, "AUTO"),
      ),
      sub.length > 0 && el("div", { class: "dl-sub" }, sub.join(" · ")),
      el(
        "div",
        { class: "dl-status" },
        d.spin ? el("span", { class: "mini-spinner" }) : el("i", { class: "dl-dot", "aria-hidden": "true" }),
        el("b", {}, d.head),
        d.line && el("span", { class: "dl-line" }, ` · ${d.line}`),
      ),
      pct != null &&
        el("div", { class: "dl-bar", role: "progressbar", "aria-valuenow": pct, "aria-valuemin": 0, "aria-valuemax": 100 },
          el("div", { class: "dl-bar-fill", style: { width: `${pct}%` } })),
    ),
    actions.length > 0 && el("div", { class: "dl-actions" }, actions),
  );
};

// Rows are keyed by job id and kept across repaints: a job that moves from
// "Downloading now" to "Ready to play" takes its node (poster included) with
// it, and only rows whose state actually changed are rebuilt.
const rowCache = new Map(); // id -> { sig, node }
const rowSig = (j, others) =>
  [j.status, j.phase || "", j.libraryId || "", !!j.seenAt, j.error || "", j.holdReason || "", j.label || j.title, others, busy.has(j.id)].join("|");
const rowFor = (j, others) => {
  const sig = rowSig(j, others);
  const hit = rowCache.get(j.id);
  if (hit && hit.sig === sig) return hit.node;
  const node = row(j, { others });
  rowCache.set(j.id, { sig, node });
  return node;
};

const section = (key, title, jobs, { others = false, note = null } = {}) => {
  if (!jobs.length) return null;
  return el(
    "section",
    { class: `dl-section dl-${key}` },
    el("h2", { class: "row-title" }, title, el("span", { class: "count" }, String(jobs.length))),
    note && el("p", { class: "dl-note" }, note),
    el("div", { class: "dl-list" }, jobs.map((j) => rowFor(j, others))),
  );
};

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

export const renderDownloads = async (root) => {
  const screen = el("div", { class: "screen downloads" });
  root.append(screen);
  const summary = el("p", { class: "dl-summary" });
  const body = el("div", { class: "page-pad" });
  screen.append(
    el(
      "div",
      { class: "browse-head" },
      el("h1", {}, "My downloads"),
      el("span", { class: "count" }, state.profile ? `for ${state.profile.name}` : ""),
    ),
    el("div", { class: "page-pad" }, summary),
    body,
  );

  const byNewest = (a, b) => Date.parse(b.at || 0) - Date.parse(a.at || 0);

  const paint = () => {
    body.innerHTML = "";
    if (!state.profile) {
      summary.textContent = "";
      body.append(el("div", { class: "empty" }, "Pick a profile to see your downloads."));
      return;
    }
    const mine = myDownloads().sort(byNewest);
    const moving = mine.filter((j) => j.status === "downloading" || (j.status === "done" && !j.libraryId));
    const queued = mine.filter((j) => j.status === "approved" || j.status === "pending");
    const ready = mine
      .filter((j) => j.status === "done" && j.libraryId)
      .sort((a, b) => (a.seenAt ? 1 : 0) - (b.seenAt ? 1 : 0) || Date.parse(b.doneAt || 0) - Date.parse(a.doneAt || 0));
    const dead = mine.filter((j) => DEAD.includes(j.status));
    const others = othersDownloads().sort(byNewest);
    const pendingApproval = queued.filter((j) => j.status === "pending").length;

    // The one line that answers "so where are we?"
    const bits = [];
    if (moving.length) bits.push(`${moving.length} downloading`);
    if (queued.length) bits.push(pendingApproval ? `${plural(queued.length, "request")} waiting (${pendingApproval} on ${state.adminName})` : `${queued.length} queued`);
    if (ready.length) bits.push(`${ready.length} ready to play`);
    if (dead.length) bits.push(`${dead.length} didn't make it`);
    summary.textContent = mine.length ? bits.join(" · ") : "";
    summary.classList.toggle("hidden", !mine.length);

    if (!mine.length) {
      body.append(
        el(
          "div",
          { class: "empty dl-empty" },
          el("div", { class: "glyph" }, "⬇"),
          el("h2", {}, "Nothing downloading yet"),
          el("p", {}, "Open any title, pick a source and press SAVE — it downloads to the server and lands here, and in the library, when it's done."),
          el("div", { class: "dl-empty-actions" },
            el("button", { class: "btn small focusable", onclick: () => navigate("#/movies") }, "Browse Movies"),
            el("button", { class: "btn small focusable", onclick: () => navigate("#/shows") }, "Browse Shows")),
        ),
      );
    }
    // Moving first (that's what you came to check), then what's waiting and
    // why, then the payoff, then what died — and the rest of the house last.
    body.append(
      ...[
        section("moving", "Downloading now", moving),
        section("queued", "Waiting", queued),
        section("ready", "Ready to play", ready),
        section("dead", "Didn't make it", dead),
        section("others", "Also on the server", others, {
          others: true,
          note: `What the rest of the house has in flight — it shares the server's download slots with yours.`,
        }),
      ].filter(Boolean),
    );
  };
  paint();

  // Live: progress ticks, a finish, an approval — repaint. Ticks arrive
  // every second or two per active job; a repaint is a few rows, cheap.
  const unsubRemoved = onMessage("download_removed", ({ id }) => {
    if (!screen.isConnected) return unsubRemoved();
    rowCache.delete(id);
    if (id && downloads.delete(id)) paint();
  });
  // A progress tick on a row that is already here just moves its numbers
  // and its bar (so the bar glides instead of being rebuilt every second);
  // anything that changes what section a row belongs to repaints the page.
  const patchRow = (job) => {
    const node = body.querySelector(`.dl-row[data-id="${job.id}"]`);
    if (!node) return false;
    const fresh = row(job, { others: !job.mine });
    node.querySelector(".dl-status")?.replaceWith(fresh.querySelector(".dl-status"));
    const bar = node.querySelector(".dl-bar-fill");
    const freshBar = fresh.querySelector(".dl-bar-fill");
    if (bar && freshBar) bar.style.width = freshBar.style.width;
    else if (!!bar !== !!freshBar) return false; // the bar came or went: full repaint
    return true;
  };
  const unsub = onMessage("download_update", ({ job }) => {
    if (!screen.isConnected) return unsub();
    if (!job) return;
    const prev = downloads.get(job.id);
    downloads.set(job.id, job);
    if (job.status === "done" && job.libraryId && !job.seenAt && job.mine && !(prev && prev.status === "done" && prev.libraryId)) {
      toast(`“${job.label || job.title}” is ready to play`, "✅");
    }
    const sameShape =
      prev && prev.status === job.status && (prev.phase || null) === (job.phase || null) &&
      (prev.libraryId || null) === (job.libraryId || null) && !!prev.seenAt === !!job.seenAt;
    if (!(sameShape && patchRow(job))) paint();
  });
  return () => {
    unsub();
    unsubRemoved();
    rowCache.clear();
  };
};

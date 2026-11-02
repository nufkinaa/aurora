// Cancel your own download: the question, the call, the toast. One place for My
// downloads and a title's page. The TV and the phone say the same
// (tv-native/src/downloadsLogic.ts cancelQuestion). It always asks: a cancel used
// to go straight through under 5%, and on a TV remote that was one stray OK away
// (Niso's report, 2026-10-31).
import { toast, confirmSheet } from "./ui.js";
import { api } from "./api.js";
import { state } from "./state.js";

export const CANCEL_LIVE = ["pending", "approved", "downloading"];

// The question, as words (a replacement's copy is safe, and says so).
export const cancelWords = (job) => {
  const pct = job.status === "downloading" ? Math.round((job.progress || 0) * 100) : 0;
  return {
    title: `Cancel “${job.label || job.title}”?`,
    text: `${pct > 0 ? `It's ${pct}% down. Cancelling throws that away; you can always ask for it again.` : "You can always ask for it again."}${job.replaces ? " Your copy stays as it was." : ""}`,
    ok: "Cancel the download",
    cancel: "Keep going",
    icon: "🗑",
  };
};

// true once it is cancelled; false when the person kept it or the server refused.
export const askCancelDownload = async (job) => {
  if (!state.profile) return false;
  if (!(await confirmSheet(cancelWords(job)))) return false;
  try {
    await api.downloadCancel(job.id, state.profile.id);
    toast(`Cancelled “${job.label || job.title}”`, "🗑");
    return true;
  } catch (err) {
    toast(err.message || "Couldn't cancel", "⚠️");
    return false;
  }
};

// "3 downloading · 12 ready": how many of this profile's own downloads are where.
// A count, nothing more: there is no limit. The TV and the phone say the same
// (downloadsLogic.ts countLine).
export const downloadCountLine = (jobs) => {
  const n = { downloading: 0, queued: 0, waiting: 0, ready: 0, failed: 0 };
  for (const j of jobs) {
    if (j.status === "done" && j.libraryId) n.ready++;
    else if (j.status === "downloading" || j.status === "done") n.downloading++;
    else if (j.status === "approved") n.queued++;
    else if (j.status === "pending") n.waiting++;
    else if (["error", "declined", "canceled"].includes(j.status)) n.failed++;
  }
  return [
    n.downloading ? `${n.downloading} downloading` : null,
    n.queued ? `${n.queued} queued` : null,
    n.waiting ? `${n.waiting} waiting for approval` : null,
    n.ready ? `${n.ready} ready` : null,
    n.failed ? `${n.failed} didn't make it` : null,
  ].filter(Boolean).join(" · ");
};

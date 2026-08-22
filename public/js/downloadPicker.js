// "Download to this device" — pick the video and which subtitle tracks come
// with it, then hand each file to the browser.
//
// Files go out one at a time instead of as a zip: the video keeps its resumable
// direct download with a real progress bar, and each .srt lands in the same
// folder under a matching name, which is how desktop players find sidecars.
import { el, icons, fmtBytes, toast } from "./ui.js";
import { pushScope, popScope } from "./focus.js";

// Remembering the chosen languages matters most for a series — nobody wants to
// tick "Hebrew" again for every episode of a season.
const PREF_KEY = "aurora-download-subs";

const readPref = () => {
  try {
    const stored = JSON.parse(localStorage.getItem(PREF_KEY));
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
};

const writePref = (labels) => {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify([...labels]));
  } catch {}
};

// When this device last pulled a copy of a title down, so My List can order by
// it. Device-local on purpose: "I have this on my laptop" is a fact about the
// laptop, not about the account, and the household's other screens have their own
// answer. Filed under every id the title answers to (library id, IMDb id),
// because a list entry can be either kind.
const DEVICE_KEY = "aurora-device-downloads";
let deviceCache = null;

export const deviceDownloads = () => {
  if (!deviceCache) {
    try {
      deviceCache = JSON.parse(localStorage.getItem(DEVICE_KEY)) || {};
    } catch {
      deviceCache = {};
    }
  }
  return deviceCache;
};

// 0 when this device has never taken a copy.
export const deviceDownloadedAt = (item) => {
  const map = deviceDownloads();
  return Math.max((item && map[item.id]) || 0, (item && item.imdbId && map[item.imdbId]) || 0);
};

const rememberDevice = (keys) => {
  if (!keys || keys.length === 0) return;
  const map = deviceDownloads();
  for (const key of keys) map[key] = Date.now();
  try {
    localStorage.setItem(DEVICE_KEY, JSON.stringify(map));
  } catch {}
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const triggerDownload = (url) => {
  const link = el("a", { href: url, download: "", style: { display: "none" } });
  document.body.append(link);
  link.click();
  link.remove();
};

// Subtitles go first: they are a few KB each and finish instantly rather than
// waiting behind gigabytes of video for a connection slot.
const startDownloads = async (files, wantedLabels, withVideo, keys) => {
  const subs = [];
  const videos = [];
  for (const file of files) {
    if (withVideo) videos.push(file.videoUrl);
    for (const track of file.subtitles) {
      if (wantedLabels.has(track.label)) subs.push(track.downloadUrl);
    }
  }
  const urls = [...subs, ...videos];
  if (urls.length === 0) return;
  rememberDevice(keys);

  const parts = [
    videos.length && `${videos.length} video file${videos.length > 1 ? "s" : ""}`,
    subs.length && `${subs.length} subtitle file${subs.length > 1 ? "s" : ""}`,
  ].filter(Boolean);
  toast(
    urls.length > 1
      ? `Downloading ${parts.join(" + ")} — allow multiple files if your browser asks`
      : `Downloading ${parts.join(" + ")}`,
    "⬇️",
  );

  for (const url of urls) {
    triggerDownload(url);
    // Downloads fired in the same tick get dropped; a small gap keeps them all.
    await sleep(300);
  }
};

// Every distinct subtitle language across the selection, with how many of the
// files actually carry it — a season is rarely subtitled evenly.
const subtitleOptions = (files) => {
  const counts = new Map();
  for (const file of files) {
    for (const track of file.subtitles) {
      counts.set(track.label, (counts.get(track.label) || 0) + 1);
    }
  }
  return [...counts].map(([label, count]) => ({ label, count }));
};

const optionRow = (name, meta, isOn, toggle, onChange) => {
  const row = el(
    "button",
    {
      type: "button",
      role: "checkbox",
      class: "dl-opt focusable",
      "aria-checked": String(isOn()),
      "aria-label": name,
    },
    el("span", { class: "dl-opt-box", html: icons.check }),
    el(
      "span",
      { class: "dl-opt-body" },
      el("span", { class: "dl-opt-name" }, name),
      meta && el("span", { class: "dl-opt-meta" }, meta),
    ),
  );
  row.sync = () => row.setAttribute("aria-checked", String(isOn()));
  const handleToggle = () => {
    toggle();
    row.sync();
    onChange();
  };
  row.addEventListener("click", handleToggle);
  return row;
};

// files: [{ videoUrl, sizeBytes, subtitles: [{ label, downloadUrl }] }]
// keys:  ids the title answers to, stamped once the download actually starts.
export const showDownloadPicker = ({ title, files, keys }) => {
  const ready = (files || [])
    .filter((file) => file && file.videoUrl)
    .map((file) => ({
      videoUrl: file.videoUrl,
      sizeBytes: file.sizeBytes || 0,
      // Embedded tracks live inside the container and have no file to send.
      subtitles: (file.subtitles || []).filter((track) => track.downloadUrl),
    }));

  if (ready.length === 0) {
    toast("Nothing downloaded here yet", "🤷");
    return;
  }

  const options = subtitleOptions(ready);
  // Nothing to choose between — don't stand an empty dialog between the viewer
  // and their file.
  if (options.length === 0) {
    startDownloads(ready, new Set(), true, keys);
    return;
  }

  const remembered = new Set(readPref());
  const selected = new Set(
    options.filter((option) => remembered.has(option.label)).map((option) => option.label),
  );
  // First download, or a title that has none of the remembered languages: take
  // the lot rather than quietly sending a bare video.
  if (selected.size === 0) for (const option of options) selected.add(option.label);

  let withVideo = true;
  const totalBytes = ready.reduce((sum, file) => sum + file.sizeBytes, 0);

  const selectedCount = () =>
    (withVideo ? ready.length : 0) +
    ready.reduce(
      (n, file) => n + file.subtitles.filter((track) => selected.has(track.label)).length,
      0,
    );

  const confirm = el("button", { class: "btn btn-primary focusable" });
  // A title can carry a dozen tracks (every alternative the source offered), so
  // the header doubles as an all-or-nothing switch.
  const toggleAll = el("button", { class: "dl-picker-all focusable" });
  const repaint = () => {
    const count = selectedCount();
    confirm.textContent =
      count === 0 ? "Nothing selected" : `Download ${count} file${count > 1 ? "s" : ""}`;
    toggleAll.textContent = selected.size === options.length ? "Clear all" : "Select all";
  };

  toggleAll.addEventListener("click", () => {
    const selectAll = selected.size < options.length;
    selected.clear();
    if (selectAll) for (const option of options) selected.add(option.label);
    for (const row of subtitleRows) row.sync();
    repaint();
  });

  const close = () => {
    document.removeEventListener("ui-back", handleBack);
    window.removeEventListener("hashchange", close);
    popScope(backdrop);
    backdrop.remove();
  };
  const handleBack = (e) => {
    e.preventDefault();
    close();
  };
  // The dialog hangs off <body>, so a route change (or a page re-render firing
  // its own hashchange) would otherwise leave it floating over the new screen.
  window.addEventListener("hashchange", close);

  confirm.addEventListener("click", () => {
    if (selectedCount() === 0) return toast("Pick at least one file", "🤷");
    writePref(selected);
    close();
    startDownloads(ready, selected, withVideo, keys);
  });

  const videoRow = optionRow(
    ready.length > 1 ? `Video files (${ready.length})` : "Video file",
    totalBytes ? fmtBytes(totalBytes) : null,
    () => withVideo,
    () => {
      withVideo = !withVideo;
    },
    repaint,
  );

  const subtitleRows = options.map((option) =>
    optionRow(
      option.label,
      ready.length > 1 ? `${option.count} of ${ready.length} episodes` : null,
      () => selected.has(option.label),
      () => {
        if (selected.has(option.label)) selected.delete(option.label);
        else selected.add(option.label);
      },
      repaint,
    ),
  );
  repaint();

  const backdrop = el(
    "div",
    {
      class: "modal-backdrop ui-overlay",
      onclick: (e) => e.target === backdrop && close(),
    },
    el(
      "div",
      { class: "modal", style: { maxWidth: "460px" } },
      el("h2", {}, "Download to this device"),
      el("p", { class: "dl-picker-sub" }, title),
      el(
        "div",
        { class: "dl-picker-list" },
        videoRow,
        el("div", { class: "dl-picker-head" }, el("span", {}, "Subtitles"), toggleAll),
        subtitleRows,
      ),
      el(
        "div",
        { class: "dl-picker-actions" },
        el("button", { class: "btn focusable", onclick: close }, "Cancel"),
        confirm,
      ),
    ),
  );

  document.body.append(backdrop);
  document.addEventListener("ui-back", handleBack);
  pushScope(backdrop);
};

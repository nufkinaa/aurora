// THE detail page — one page per title, whether it is on disk, streamable, or
// both (unified 2026-07-27; there used to be a separate library page and
// Discover page, which meant a downloaded show and a streamable show looked like
// two different things).
//
// It is entered two ways and fills in the other half itself:
//   #/movie/:libId, #/show/:libId   → local copy first; the IMDb id is resolved
//                                     (/api/imdb-for) so sources still show up
//   #/discover/:type/:imdbId        → stream metadata first; the library is
//                                     searched by title for a copy you own
//
// Local episodes play straight away; anything you don't have offers sources.
import {
  el,
  icons,
  fmtDuration,
  fmtClock,
  fmtBytes,
  fmtAirDate,
  resolveAirStates,
  toast,
} from "../ui.js";
import { api } from "../api.js";
import { dropdown } from "./browse.js";
import {
  state,
  refreshProgress,
  episodeProgressFor,
  progressFor,
  loadLibrary,
} from "../state.js";
import { navigate } from "../router.js";
import { shelfRow } from "../components.js";
import { heroBlock, watchlistButton } from "./details.js";
import { pushScope, popScope } from "../focus.js";
import { showDownloadPicker } from "../downloadPicker.js";
import { onMessage } from "../ws.js";
import * as narrator from "../narrator.js";

// "My List" toggle for a streamable (Discover) title — stores a stream ref.
import * as surprise from "../surprise.js";
const streamWatchlistButton = (meta) => {
  let inList = false;
  const btn = el("button", { class: "btn focusable" });
  const paint = () => {
    btn.innerHTML =
      (inList ? icons.check : icons.plus) +
      `<span>${inList ? "In My List" : "My List"}</span>`;
  };
  if (state.profile) {
    api
      .watchlist(state.profile.id)
      .then(({ items }) => {
        inList = items.some((x) => x.imdbId === meta.imdbId);
        paint();
      })
      .catch(() => {});
  }
  paint();
  btn.addEventListener("click", async () => {
    if (!state.profile) return;
    inList = !inList;
    paint();
    try {
      await api.toggleWatchlist(
        state.profile.id,
        {
          imdbId: meta.imdbId,
          type: meta.type === "show" ? "show" : "movie",
          title: meta.title,
          poster: meta.poster || null,
          year: meta.year || null,
          // Stored with the ref so My List's genre filter and rating sort can
          // see streamable entries (the server keeps only what it is sent).
          genres: meta.genres || [],
          rating: meta.rating || null,
        },
        inList,
      );
      toast(
        inList ? `“${meta.title}” saved for later` : "Off the list. Bold.",
        inList ? "➕" : "➖",
      );
    } catch {}
  });
  return btn;
};

const QUALITY_COLOR = {
  "2160p": "#c084fc",
  "1080p": "#60a5fa",
  "720p": "#34d399",
  "480p": "#fbbf24",
  SD: "#9aa1b5",
};
// Canonical high→low order for the quality filter pills
const QUALITY_ORDER = ["2160p", "1080p", "720p", "480p", "SD"];

// Language code -> flag emoji, so audio languages read at a glance instead of
// a bare "PL" in the middle of the card.
const LANG_FLAG = {
  EN: "🇬🇧",
  HE: "🇮🇱",
  HI: "🇮🇳",
  FR: "🇫🇷",
  DE: "🇩🇪",
  ES: "🇪🇸",
  IT: "🇮🇹",
  RU: "🇷🇺",
  JA: "🇯🇵",
  KO: "🇰🇷",
  PT: "🇵🇹",
  PL: "🇵🇱",
  TR: "🇹🇷",
  ZH: "🇨🇳",
};
const langFlag = (code) => LANG_FLAG[code] || code;

// Download-button state for a source, given its job (if any). A sand-clock told
// people nothing — this reports what the server is actually doing, live, with a
// ring around the percentage (see paintDl / the download_update subscription).
const DL_ACTIVE = ["pending", "approved", "downloading"];

const dlFace = (job) => {
  if (!job)
    return {
      face: "⬇",
      pct: null,
      hint: "Download for better playback (will take more time)",
    };
  const pct = Math.round((job.progress || 0) * 100);
  switch (job.status) {
    case "done":
      return {
        face: "✓",
        pct: null,
        hint: "In your library — plays instantly",
      };
    case "pending":
      return {
        face: "⏳",
        pct: null,
        hint: "Waiting for admin approval (the server is low on disk)",
      };
    case "approved":
      return {
        dots: true,
        pct: null,
        hint: "Queued — starts when the current downloads finish",
      };
    case "downloading":
      // Before any bytes move, the engine is still locating the torrent's file
      // list — showing "0%" there reads as a download that isn't working.
      if (job.phase === "finding")
        return {
          dots: true,
          pct: null,
          hint: "Finding the file on the network…",
        };
      // Peers are connected and bytes are moving, but the first whole piece of
      // this episode hasn't landed yet — so the percentage is still 0.
      if (job.phase === "starting")
        return {
          dots: true,
          pct: null,
          hint: `Starting${job.peers ? ` — ${job.peers} peer${job.peers > 1 ? "s" : ""} connected` : "…"}`,
        };
      if (job.phase === "copying") {
        const c =
          job.copyProgress != null ? Math.round(job.copyProgress * 100) : null;
        return {
          face: "→",
          pct: c ?? 100,
          hint: `Saving to your library${c != null ? ` — ${c}%` : ""}`,
        };
      }
      return {
        face: String(pct),
        pct,
        hint: `Downloading — ${pct}%${job.downloadSpeed ? ` at ${(job.downloadSpeed / 1e6).toFixed(1)} MB/s` : ""}`,
      };
    case "error":
      return {
        face: "!",
        pct: null,
        hint: job.error || "The download failed — tap to try again",
      };
    default:
      return {
        face: "⬇",
        pct: null,
        hint: "Download for better playback (will take more time)",
      };
  }
};

// Paint a download button from a job. Kept separate from the row so the live
// WebSocket updates can repaint in place without rebuilding anything.
// Three bouncing dots, so "we're working on it" reads as motion rather than a
// button that has frozen. Built once and reused; the CSS does the animating.
const DOTS_HTML = '<i></i><i></i><i></i>';

const paintDl = (btn, job) => {
  const { face, dots, pct, hint } = dlFace(job);
  const faceEl = btn.querySelector(".dl-face");
  faceEl.classList.toggle("dl-dots", !!dots);
  if (dots) {
    // Only rebuild when switching in, so the animation doesn't restart on every
    // progress tick.
    if (faceEl.childElementCount !== 3) faceEl.innerHTML = DOTS_HTML;
  } else {
    faceEl.textContent = face;
  }
  btn.title = hint;
  btn.setAttribute("aria-label", hint);
  btn.classList.toggle("on", !!job && DL_ACTIVE.includes(job.status));
  btn.classList.toggle("done", !!job && job.status === "done");
  btn.classList.toggle("failed", !!job && job.status === "error");
  btn.classList.toggle("has-ring", pct != null);
  if (pct != null)
    btn.style.setProperty("--dl-pct", String(Math.max(0, Math.min(100, pct))));
  // A finished download is nothing to click; anything else can be (re)requested.
  btn.disabled = !!job && job.status === "done";
  // The action rail's caption (torrent cards only — the owned row's device-
  // download button has none): says what the ⬇ DOES, so it never gets
  // confused with Play again.
  const cap = btn.querySelector(".dl-cap");
  if (cap) cap.textContent = job && job.status === "done" ? "SAVED" : "SAVE";
};

// The badge a source carries when it already has a download job. Saying it on
// the row itself is the whole point: a downloaded episode used to look exactly
// like the 40 torrents around it, so people re-streamed what they already had.
const DL_BADGE = {
  done: { text: "✓ DOWNLOADED", class: "source-owned" },
  downloading: { text: "⬇ DOWNLOADING", class: "source-getting" },
  approved: { text: "⏳ QUEUED", class: "source-getting" },
  pending: { text: "⏳ NEEDS APPROVAL", class: "source-getting" },
};

// A stream source row (reused for movies and episodes). `onDownload` requests a
// server-side download of this exact source; `dlStatus` is the current job
// state for it (if any) so the button can show "queued / downloading / saved".
const sourceRow = (stream, onPlay, onDownload, job) => {
  const color = QUALITY_COLOR[stream.quality] || QUALITY_COLOR.SD;
  const dlStatus = job && job.status;
  const owned = dlStatus === "done";
  const seedClass =
    stream.seeders >= 30 ? "good" : stream.seeders >= 5 ? "ok" : "low";
  const tags = (stream.tags || []).slice(0, 5);

  const playBtn = el(
    "button",
    {
      class: "source-row focusable" + (owned ? " owned" : ""),
      onclick: () => onPlay(stream),
    },
    el(
      "span",
      {
        class: "source-quality",
        style: { color, borderColor: color + "66", background: color + "1a" },
      },
      stream.quality,
    ),
    el(
      "div",
      { class: "source-info" },
      el(
        "div",
        { class: "source-title" },
        el("span", { class: "source-name" }, stream.release || stream.filename),
        DL_BADGE[dlStatus] &&
          el(
            "span",
            { class: DL_BADGE[dlStatus].class },
            DL_BADGE[dlStatus].text,
          ),
        stream.lastChosen && el("span", { class: "source-last" }, "⟳ LAST"),
        stream.recommended && el("span", { class: "source-best" }, "★ BEST"),
        stream.cam && el("span", { class: "source-cam" }, "CAM"),
        stream.pack &&
          el(
            "span",
            {
              class: "source-pack",
              title:
                "Part of a multi-movie collection torrent — weaker swarms, slower starts. Prefer a single release.",
            },
            "PACK",
          ),
      ),
      el(
        "div",
        { class: "source-meta" },
        // A downloaded source plays off the disk, so seeders and swarm health
        // stopped being the story for this row.
        owned
          ? el("span", { class: "owned-note" }, "Plays your copy · instant")
          : el(
              "span",
              { class: `source-seeds ${seedClass}` },
              `● ${stream.seeders}`,
            ),
        stream.sizeString && el("span", {}, stream.sizeString),
        stream.languages &&
          stream.languages.length > 0 &&
          el(
            "span",
            {
              class: "source-langs",
              title: "Audio: " + stream.languages.join(", "),
            },
            stream.languages.map((c) => langFlag(c)).join(" "),
          ),
        stream.provider &&
          el("span", { class: "source-provider" }, stream.provider),
      ),
      tags.length > 0 &&
        el(
          "div",
          { class: "source-tags" },
          tags.map((t) => el("span", { class: "source-tag" }, t)),
        ),
    ),
    el("span", { class: "source-play", html: icons.play }),
  );

  const dlBtn = el(
    "button",
    {
      class: "source-dl focusable",
      onclick: () => {
        if (dlBtn.disabled) return;
        // Optimistic feedback until the first live update lands (a second or two).
        paintDl(dlBtn, { status: "approved", progress: 0 });
        onDownload(stream);
      },
    },
    el("i", { class: "dl-ring" }),
    el("span", { class: "dl-face" }),
    el("span", { class: "dl-cap" }, "SAVE"),
  );
  paintDl(dlBtn, job);

  const wrap = el("div", { class: "source-row-wrap" }, playBtn, dlBtn);
  // Let the live WebSocket updates repaint this row's button in place.
  wrap._paintDl = (j) => paintDl(dlBtn, j);
  return wrap;
};

// Codecs browsers routinely can't decode: HEVC/x265 (esp. 10-bit) and AV1.
// These get transcoded to H.264 server-side. Audio codecs that are silent in
// most browsers get the audio-only transcode (video is copied, much cheaper).
const VIDEO_TRANSCODE_TAGS = ["H.265", "AV1"];
const AUDIO_TRANSCODE_TAGS = ["DTS", "DTS-HD", "TrueHD", "Atmos", "DD+"];

// Parse a Cinemeta runtime string ("152 min", "1h 52min", "57 min") to seconds,
// so the player can show the whole movie's length instead of "how much has
// transcoded so far".
const runtimeToSeconds = (runtime) => {
  if (!runtime) return 0;
  const s = String(runtime);
  const h = s.match(/(\d+)\s*h/i);
  const m = s.match(/(\d+)\s*m/i);
  if (h || m) return ((h ? +h[1] : 0) * 60 + (m ? +m[1] : 0)) * 60;
  const n = parseInt(s, 10);
  return isNaN(n) ? 0 : n * 60; // bare number = minutes
};

// localStorage key for the last source picked for a title/episode
const lastStreamKey = (imdbId, season, episode) =>
  `aurora-laststream-${imdbId}${season && episode ? `:${season}:${episode}` : ""}`;

// Build the item the player will receive for a chosen source
const playStream = (stream, base, label, season, episode) => {
  // Remember this pick so it can be surfaced first next time.
  try {
    localStorage.setItem(
      lastStreamKey(base.imdbId, season, episode),
      stream.infoHash,
    );
  } catch {}
  const id = `torrent|${stream.infoHash}|${stream.fileIdx}`;
  // Base for transcode HLS; the player appends the seek offset: `${base}/${ss}/index.m3u8?v=…`
  const transcodeBase = `/stream/torrent/hls/${stream.infoHash}/${stream.fileIdx}`;
  const tags = stream.tags || [];
  const needsVideo = tags.some((t) => VIDEO_TRANSCODE_TAGS.includes(t));
  const needsAudio = tags.some((t) => AUDIO_TRANSCODE_TAGS.includes(t));

  const item = {
    id,
    type: "movie",
    title: label,
    year: base.year,
    cover: base.poster || null,
    backdrop: base.backdrop || null,
    videoUrl: `/stream/torrent/${stream.infoHash}/${stream.fileIdx}`,
    downloadUrl: `/stream/torrent/${stream.infoHash}/${stream.fileIdx}`,
    // Transcode base + codec. The player builds seekable URLs from these:
    // `${transcodeBase}/${ss}/index.m3u8?v=${transcodeV}`. A "direct" stream that
    // stalls falls back to v=h264 from the stall point.
    transcodeBase,
    transcodeV: needsVideo ? "h264" : needsAudio ? "copy" : "h264",
    needsTranscode: needsVideo || needsAudio,
    // True runtime so the scrubber shows the whole movie's length, not the
    // amount transcoded so far (a live HLS playlist's duration keeps growing).
    duration: runtimeToSeconds(base.runtime),
    subtitles: [],
    infoHash: stream.infoHash,
    imdbId: base.imdbId,
    season,
    episode,
    quality: stream.quality,
    _isTorrent: true,
    // where Back should return to
    returnHash: location.hash,
  };
  state.pendingItems[id] = item;
  navigate(`#/play/${id}`);

  // Fetch Hebrew + English subtitles in the background and attach them; the
  // player picks up item.subtitles and also listens for this late arrival.
  api
    .torrentSubtitles(
      base.type === "show" ? "series" : "movie",
      base.imdbId,
      season,
      episode,
    )
    .then(({ subtitles }) => {
      if (subtitles && subtitles.length) {
        item.subtitles = subtitles;
        document.dispatchEvent(
          new CustomEvent("torrent-subs", { detail: { id, subtitles } }),
        );
      }
    })
    .catch(() => {});
};

// Friendly confirmation sheet after a download request — a toast is easy to
// miss, and this is the moment to set expectations (a few minutes; and on the
// rare low-disk request, that an admin has to wave it through first).
// Same modal pattern as profiles.js: ui-overlay class + focus scope + Back.
const showDownloadRequested = (label, needsApproval) => {
  const close = () => {
    document.removeEventListener("ui-back", onBack);
    popScope(backdrop);
    backdrop.remove();
  };
  const onBack = (e) => {
    e.preventDefault();
    close();
  };
  const backdrop = el(
    "div",
    {
      class: "modal-backdrop ui-overlay",
      onclick: (e) => e.target === backdrop && close(),
    },
    el(
      "div",
      { class: "modal dl-confirm" },
      el("div", { class: "dl-confirm-emoji" }, "🍿"),
      el(
        "h2",
        { class: "dl-confirm-title" },
        needsApproval ? "Download requested!" : "Downloading now!",
      ),
      el(
        "p",
        { class: "dl-confirm-sub" },
        needsApproval
          ? `“${label}” needs a quick admin approval this time — the server is running low on space. ` +
              "Once it's waved through it lands in your library in minutes, ready to play in full quality."
          : "“it usually takes about 40 seconds for a download to start, chill for a sec :)." +
              `${label}” is already downloading. In a few minutes it lands in your library, ` +
              "ready to play instantly in full quality. " +
              "Go grab some popcorn; it'll be ready before it goes cold. 🍿",
      ),
      el(
        "button",
        { class: "btn btn-primary focusable", onclick: close },
        "Great, can't wait",
      ),
    ),
  );
  document.body.append(backdrop);
  document.addEventListener("ui-back", onBack);
  pushScope(backdrop);
};

// Ask the server to download this exact source to the library. It starts right
// away unless the server is low on disk, in which case an admin has to approve
// it first (the server decides; `needsApproval` comes back in the response).
const requestDownload = async (stream, base, label, season, episode) => {
  const type = base.type === "show" ? "show" : "movie";
  try {
    const res = await api.requestDownload({
      infoHash: stream.infoHash,
      fileIdx: stream.fileIdx,
      type,
      imdbId: base.imdbId,
      title: base.title,
      label,
      year: base.year || null,
      poster: base.poster || null,
      quality: stream.quality,
      sizeBytes: stream.sizeBytes || 0,
      season: season || null,
      episode: episode || null,
      provider: stream.provider || null,
      seeders: stream.seeders || 0,
      profile: state.profile ? state.profile.name : null,
    });
    if (res.error) return toast(res.error, "⚠️");
    if (res.alreadyAvailable)
      return toast("Already yours — it's in the library", "✅");
    if (res.duplicate) {
      return toast(
        res.job && res.job.status === "done"
          ? "Already downloaded — go watch it"
          : "Already queued. Patience.",
        "⏳",
      );
    }
    showDownloadRequested(label, !!res.needsApproval);
  } catch {
    toast("Couldn't request the download", "⚠️");
  }
};

// Look up existing download jobs for a set of streams, keyed by infoHash:fileIdx,
// so rows can show "queued / downloading / saved" on load. Best-effort.
const dlKey = (j) => `${j.infoHash}:${j.fileIdx}`;
const fetchDownloadStates = async () => {
  try {
    const jobs = await api.downloads();
    const map = new Map();
    // Newest first from the server; keep the newest job per source.
    for (const j of jobs) if (!map.has(dlKey(j))) map.set(dlKey(j), j);
    return map;
  } catch {
    return new Map();
  }
};

// A quality filter bar. Shows "All" plus one pill per quality actually present
// in the results (high→low), each with a count. Clicking re-renders the list.
const buildFilterBar = (streams, renderList) => {
  const bar = el("div", { class: "source-filters" });
  let active = "all";

  const apply = () => {
    const list =
      active === "all" ? streams : streams.filter((s) => s.quality === active);
    renderList(list);
  };

  const makePill = (value, label, count) => {
    const pill = el(
      "button",
      {
        class: `source-filter focusable${value === active ? " active" : ""}`,
        onclick: () => {
          if (active === value) return;
          active = value;
          bar
            .querySelectorAll(".source-filter")
            .forEach((p) => p.classList.remove("active"));
          pill.classList.add("active");
          apply();
        },
      },
      el("span", {}, label),
      el("span", { class: "source-filter-count" }, String(count)),
    );
    return pill;
  };

  bar.append(makePill("all", "All", streams.length));
  for (const q of QUALITY_ORDER) {
    const n = streams.filter((s) => s.quality === q).length;
    if (n > 0) bar.append(makePill(q, q, n));
  }
  return bar;
};

// The "you already have this" row: the finished download, presented as the
// obvious first choice above the torrents rather than as a green tick somewhere
// in the list. Plays the library file, so it starts instantly and seeks freely.
const ownedRow = ({ id, label, onDownload }) =>
  el(
    "div",
    { class: "source-row-wrap" },
    el(
      "button",
      {
        class: "source-row owned focusable",
        onclick: () => navigate(`#/play/${id}`),
      },
      el("span", { class: "source-quality owned-chip" }, "YOURS"),
      el(
        "div",
        { class: "source-info" },
        el(
          "div",
          { class: "source-title" },
          el("span", { class: "source-name" }, label || "Your downloaded copy"),
          el("span", { class: "source-owned" }, "✓ DOWNLOADED"),
        ),
        el(
          "div",
          { class: "source-meta" },
          el(
            "span",
            { class: "owned-note" },
            "Starts instantly · seek anywhere · full quality",
          ),
        ),
      ),
      el("span", { class: "source-play", html: icons.play }),
    ),
    // Sits where a torrent row keeps its "get this onto the server" button, and
    // means the matching thing here: get the copy we already have onto yours.
    onDownload &&
      el("button", {
        class: "source-dl focusable",
        html: icons.downloadDevice,
        title: "Download to this device",
        "aria-label": "Download to this device",
        onclick: onDownload,
      }),
  );

// Render a sources list into a host element (with loading + empty states)
// `owned` (optional) is the library copy of exactly this title/episode —
// `{ id, label }` — which gets its own row above every torrent.
const loadSources = async (
  host,
  { type, imdbId, year, season, episode, owned },
  onPlay,
  onDownload,
) => {
  host.innerHTML = "";
  host.append(
    el(
      "div",
      { class: "sources-loading" },
      el("span", { class: "mini-spinner" }),
      season
        ? `Finding sources for S${season} E${episode}…`
        : "Finding sources…",
    ),
  );
  try {
    const [{ streams: rawStreams }, dlStates] = await Promise.all([
      api.torrentSources({ type, title: imdbId, year, season, episode }),
      fetchDownloadStates(),
    ]);
    let streams = rawStreams;
    host.innerHTML = "";
    if (!streams || streams.length === 0) {
      host.append(el("div", { class: "sources-empty" }, "No sources found."));
      return;
    }

    // Drop dead torrents (0 peers) entirely — but only when seeder counts are
    // actually present, so a provider that reports no counts doesn't wipe the
    // whole list.
    if (streams.some((s) => s.seeders > 0)) {
      streams = streams.filter((s) => s.seeders > 0);
    }
    if (streams.length === 0) {
      host.append(
        el("div", { class: "sources-empty" }, "No sources with active peers."),
      );
      return;
    }

    // Surface the last source the user played for this title/episode: flag it
    // and float it to the top so "continue with the same source" is one tap.
    try {
      const lastHash = localStorage.getItem(
        lastStreamKey(imdbId, season, episode),
      );
      if (lastHash) {
        const i = streams.findIndex((s) => s.infoHash === lastHash);
        if (i > 0) {
          const [s] = streams.splice(i, 1);
          s.lastChosen = true;
          streams.unshift(s);
        } else if (i === 0) streams[0].lastChosen = true;
      }
    } catch {}

    // Sources that already have a download job go to the very top, saved ones
    // first: whatever the list is sorted by, "you already have this" outranks
    // it. Stable within each group, so the ★ BEST / ⟳ LAST order survives.
    const dlRank = (s) => {
      const st = (dlStates.get(`${s.infoHash}:${s.fileIdx}`) || {}).status;
      return st === "done" ? 0 : DL_ACTIVE.includes(st) ? 1 : 2;
    };
    streams = streams
      .map((s, i) => ({ s, i, r: dlRank(s) }))
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .map((x) => x.s);

    const listHost = el("div", { class: "source-list" });
    // Rows by source key, so a live download_update repaints just that button.
    const rows = new Map();
    const renderList = (list) => {
      listHost.innerHTML = "";
      rows.clear();
      if (list.length === 0) {
        listHost.append(
          el("div", { class: "sources-empty" }, "No sources at this quality."),
        );
        return;
      }
      listHost.append(
        ...list.map((s) => {
          const key = `${s.infoHash}:${s.fileIdx}`;
          const job = dlStates.get(key);
          // A source that is already downloaded plays the LIBRARY file, not the
          // torrent: the whole point of having downloaded it is that it starts
          // instantly and seeks. Streaming it again would be the confusing option.
          const play =
            job && job.status === "done" && owned
              ? () => navigate(`#/play/${owned.id}`)
              : onPlay;
          const row = sourceRow(s, play, onDownload, job);
          // the ★ BEST pick stays visible while the list scrolls in its box
          if (s.recommended) row.classList.add("best-pinned");
          rows.set(key, row);
          return row;
        }),
      );
    };

    // Live download progress. One subscription per sources list; the previous
    // one is dropped first (picking another episode re-renders into the same
    // host), and it lets go by itself once the page is gone.
    if (host._dlUnsub) host._dlUnsub();
    host._dlUnsub = onMessage("download_update", ({ job }) => {
      if (!host.isConnected) {
        if (host._dlUnsub) host._dlUnsub();
        host._dlUnsub = null;
        return;
      }
      if (!job) return;
      const key = dlKey(job);
      const prev = dlStates.get(key);
      dlStates.set(key, job);
      const row = rows.get(key);
      if (row && row._paintDl) row._paintDl(job);
      // It just finished: the library has a new file, so re-render to promote it
      // to the top with its ✓ DOWNLOADED badge and the "plays your copy" row.
      if (job.status === "done" && (!prev || prev.status !== "done")) {
        loadLibrary(true).catch(() => {});
        toast(`“${job.label || job.title}” is ready to play`, "✅");
      }
    });

    host.append(
      el(
        "div",
        { class: "source-hint" },
        "Tip: more seeders (●) = faster, more reliable playback; a smaller file starts quicker. The ★ BEST pick balances both.",
      ),
      // The copy on disk, before any torrent and outside the quality filter, so
      // it can't be filtered away or scrolled past.
      ...(owned ? [ownedRow(owned)] : []),
      // Nothing to sell here when they already own it.
      ...(owned
        ? []
        : [
            el(
              "div",
              { class: "dl-callout" },
              el("span", { class: "dl-callout-icon" }, "⬇"),
              el(
                "div",
                { class: "dl-callout-body" },
                el(
                  "div",
                  { class: "dl-callout-title" },
                  "Want the best experience? Download it.",
                ),
                el(
                  "div",
                  { class: "dl-callout-sub" },
                  "Downloads start instantly every time, seek anywhere without buffering, and keep full quality on every device. " +
                    "Tap the ⬇ next to any source — it starts right away and lands in your library in minutes.",
                ),
              ),
            ),
          ]),
      // The compact box (elia: "a small box, not kilometres down the page"):
      // filters are its non-scrolling header, the rows scroll inside it.
      el("div", { class: "source-box" }, buildFilterBar(streams, renderList), listHost),
    );
    renderList(streams);
  } catch {
    host.innerHTML = "";
    host.append(
      el(
        "div",
        { class: "sources-empty" },
        "Couldn't reach the source provider.",
        el("button", {
          class: "btn small focusable",
          style: { marginLeft: "12px" },
          onclick: () =>
            loadSources(host, { type, imdbId, year, season, episode, owned }, onPlay, onDownload),
        }, "Try again"),
      ),
    );
  }
};

// Resolve a library title to its IMDb id so a locally-owned title can still
// offer stream sources. Answers are cached on the server for good; this map just
// avoids repeating the round trip while the page is open.
const imdbCache = new Map();
const resolveImdbId = async (item) => {
  const key = `${item.type}|${item.title}|${item.year || ""}`;
  if (imdbCache.has(key)) return imdbCache.get(key);
  let id = null;
  try {
    const r = await api.imdbFor(item.type, item.title, item.year);
    id = (r && r.imdbId) || null;
  } catch {}
  imdbCache.set(key, id);
  return id;
};

// Hand library entries (a movie, an episode, or a whole season of them) to the
// picker that copies them onto the viewer's own machine.
// `keys` identify the TITLE, not the files — an episode grabbed on its own still
// counts as "I took a copy of this series" wherever the series is listed.
const openDownload = (title, entries, keys) =>
  showDownloadPicker({
    title,
    keys,
    files: entries.map((entry) => ({
      videoUrl: entry.downloadUrl,
      sizeBytes: entry.sizeBytes,
      subtitles: entry.subtitles || [],
    })),
  });

// The union of what's on disk and what the series actually has: library seasons
// know what you can play, Cinemeta knows the episode titles and everything you
// don't have yet.
const mergeSeasons = (lib, meta) => {
  const libSeasons = (lib && lib.seasons) || [];
  const metaSeasons = (meta && meta.seasons) || [];
  const numbers = [
    ...new Set([
      ...libSeasons.map((s) => Number(s.number)),
      ...metaSeasons.map((s) => Number(s.number)),
    ]),
  ]
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

  return numbers.map((number) => {
    const byNum = new Map();
    for (const e of (metaSeasons.find((s) => Number(s.number) === number) || {})
      .episodes || []) {
      byNum.set(Number(e.episode), {
        season: number,
        episode: Number(e.episode),
        title: e.title,
        overview: e.overview,
        // Cinemeta is the only side that knows these: the scanner sees a file,
        // not a broadcast date. Dropping them here is what left the page unable
        // to say when anything aired.
        released: e.released || null,
        thumbnail: e.thumbnail || null,
        local: null,
      });
    }
    for (const e of (libSeasons.find((s) => Number(s.number) === number) || {})
      .episodes || []) {
      const row = byNum.get(Number(e.episode)) || {
        season: number,
        episode: Number(e.episode),
        title: e.title,
        overview: null,
        released: null,
        thumbnail: null,
        local: null,
      };
      row.local = e; // the file you can play right now
      row.title = row.title || e.title;
      byNum.set(Number(e.episode), row);
    }
    return {
      number,
      episodes: [...byNum.values()].sort((a, b) => a.episode - b.episode),
    };
  });
};

export const renderDetail = async (root, { source, type, id }) => {
  const screen = el("div", { class: "screen" });
  root.append(screen);

  // Skeleton hero while the metadata lands.
  screen.append(
    el(
      "div",
      { class: "detail-hero" },
      el("div", { class: "hero-fade" }),
      el("div", { class: "detail-poster skeleton" }),
      el(
        "div",
        { class: "detail-info" },
        el("div", {
          class: "skeleton",
          style: { width: "320px", height: "44px", marginBottom: "14px" },
        }),
        el("div", {
          class: "skeleton",
          style: { width: "220px", height: "18px" },
        }),
      ),
    ),
  );

  // ---------- identity: fill in whichever half we weren't given ----------
  let lib = null; // the library item (local files), if we own it
  let meta = null; // stream metadata (backdrop, cast, episode titles)
  let imdbId = null;

  if (source === "library") {
    lib = await api.item(id).catch(() => null);
    if (!lib) return navigate("#/");
    imdbId = await resolveImdbId(lib);
    // Sources are a bonus here — never let a metadata hiccup hide the local copy.
    if (imdbId)
      meta = await api
        .discoverMeta(lib.type === "show" ? "show" : "movie", imdbId)
        .catch(() => null);
  } else {
    imdbId = id;
    meta = await api.discoverMeta(type, id).catch(() => null);
    if (!meta) {
      toast("Couldn't load details", "⚠️");
      return navigate("#/requests");
    }
    try {
      await loadLibrary();
    } catch {}
    const libId = findInLibrary(meta);
    if (libId) lib = await api.item(libId).catch(() => null);
  }
  await refreshProgress().catch(() => {});

  const isShow = (lib ? lib.type : meta.type) === "show";
  // Library metadata wins where we have it (it is what actually plays); stream
  // metadata fills the gaps, which is usually the backdrop, cast and synopsis.
  const view = {
    type: isShow ? "show" : "movie",
    title: (lib && lib.title) || (meta && meta.title) || "Untitled",
    cover: (lib && lib.cover) || (meta && (meta.cover || meta.poster)) || null,
    backdrop: (lib && lib.backdrop) || (meta && meta.backdrop) || null,
    synopsis: (lib && lib.synopsis) || (meta && meta.synopsis) || null,
    rating: (lib && lib.rating) || (meta && meta.rating) || null,
    certificate: (lib && lib.certificate) || (meta && meta.certificate) || null,
    genres:
      (lib && lib.genres && lib.genres.length
        ? lib.genres
        : meta && meta.genres) || [],
    year: (lib && lib.year) || (meta && meta.year) || null,
    subtitles: (lib && lib.subtitles) || null,
    video: lib && lib.video,
    audio: lib && lib.audio,
    width: lib && lib.width,
    height: lib && lib.height,
  };
  // Both ids this title could be filed under in a watchlist (see openDownload).
  const deviceKeys = [lib && lib.id, imdbId].filter(Boolean);

  screen.innerHTML = "";
  const sourcesSection = el("div", { class: "sources-section page-pad" });
  const seasons = isShow ? mergeSeasons(lib, meta) : [];

  // Next episode to watch, over the merged list: the most recently touched
  // unfinished local episode, else the one after the last finished one.
  let nextUp = null;
  if (isShow) {
    const flat = seasons.flatMap((s) => s.episodes).filter((e) => e.local);
    let lastTouch = -1;
    for (const row of flat) {
      const p = progressFor(row.local.id);
      if (p && p.updatedAt > lastTouch) {
        lastTouch = p.updatedAt;
        nextUp = p.finished ? flat[flat.indexOf(row) + 1] || null : row;
      }
    }
    if (!nextUp) nextUp = flat[0] || null;
    nextUp = nextUp ? { ...nextUp, resumed: lastTouch >= 0 } : null;
  }

  const movieProg = !isShow && lib ? progressFor(lib.id) : null;
  const resumable = movieProg && !movieProg.finished && movieProg.position > 10;

  // ---------- hero actions ----------
  const scrollToSources = () => {
    const target =
      sourcesSection.querySelector(".focusable") ||
      screen.querySelector(".season-bar .focusable");
    target?.focus({ preventScroll: true });
    (sourcesSection.querySelector(".source-row")
      ? sourcesSection
      : screen.querySelector(".season-bar")
    )?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const actions = [];
  if (!isShow && lib) {
    actions.push(
      el("button", {
        class: "btn btn-primary focusable",
        html:
          icons.play +
          `<span>${resumable ? "Resume " + fmtClock(movieProg.position) : "Play"}</span>`,
        onclick: () => navigate(`#/play/${lib.id}`),
      }),
    );
    if (resumable) {
      actions.push(
        el("button", {
          class: "btn focusable",
          html: icons.play + "<span>Start over</span>",
          onclick: () => navigate(`#/play/${lib.id}?restart=1`),
        }),
      );
    }
  } else if (isShow && nextUp) {
    actions.push(
      el("button", {
        class: "btn btn-primary focusable",
        html:
          icons.play +
          `<span>${nextUp.resumed ? `Continue S${nextUp.season} E${nextUp.episode}` : "Play"}</span>`,
        onclick: () => navigate(`#/play/${nextUp.local.id}`),
      }),
    );
  }
  // Streams: the only play button when we own nothing, a secondary one otherwise.
  if (imdbId) {
    actions.push(
      el("button", {
        class: `btn ${actions.length ? "" : "btn-primary"} focusable`,
        html:
          icons.play +
          `<span>${isShow ? (lib ? "All episodes" : "Choose episode") : lib ? "Other versions" : "Stream now"}</span>`,
        onclick: scrollToSources,
      }),
    );
  }
  if (surprise.landedHere()) {
    actions.push(
      el("button", {
        class: "btn focusable",
        html: "🎲 <span>Roll again</span>",
        onclick: () => surprise.rollAgain(),
      }),
    );
  }
  if (state.profile) {
    actions.push(lib ? watchlistButton(lib) : streamWatchlistButton(meta));
  }
  if (!isShow && lib && lib.downloadUrl) {
    actions.push(
      el("button", {
        class: "btn btn-icon focusable",
        html: icons.downloadDevice,
        title: "Download to this device",
        "aria-label": "Download to this device",
        onclick: () => openDownload(view.title, [lib], deviceKeys),
      }),
    );
  }
  // Mark watched works for a streamed film too — against its IMDb id when there
  // is no local file, so "I've seen this" isn't a privilege of downloaded titles.
  if (!isShow && state.profile && (lib || imdbId)) {
    const watchId = lib ? lib.id : streamProgressKey(imdbId);
    const seen = (lib ? movieProg : progressFor(watchId)) || null;
    actions.push(
      el("button", {
        class: "btn btn-icon focusable",
        html: icons.check,
        title: seen && seen.finished ? "Mark unwatched" : "Mark watched",
        "aria-label": "Toggle watched",
        style: seen && seen.finished ? { color: "#4ade80" } : null,
        onclick: async () => {
          try {
            if (seen && seen.finished) {
              await api.clearProgress(state.profile.id, watchId);
              toast("Back on the pile", "↩️");
            } else {
              const dur = (lib && lib.duration) || 1;
              await api.saveProgress(
                state.profile.id,
                watchId,
                dur,
                dur,
                lib ? undefined : { imdbId, title: view.title, type: "movie" },
              );
              toast("Marked watched — nicely done", "✅");
              narrator.call(
                "onMarkWatched",
                seen && seen.position,
                seen && seen.duration,
              );
            }
            await refreshProgress();
            window.dispatchEvent(new HashChangeEvent("hashchange"));
          } catch {}
        },
      }),
    );
  }

  // The year a season actually aired, taken from its first dated episode. A show
  // that started in 2019 and is airing its fourth season now should not still say
  // 2019 while you are looking at season 4.
  const seasonYear = (season) => {
    for (const ep of (season && season.episodes) || []) {
      const t = Date.parse(ep.released);
      if (Number.isFinite(t)) return new Date(t).getFullYear();
    }
    return null;
  };

  // The soonest episode still to come, anywhere in the series — the one thing
  // people want from the page of a show that is mid-run. Costs nothing: the
  // episode list is already loaded, so this is a scan over data in hand.
  const nextAiring = () => {
    if (!isShow) return null;
    const now = Date.now();
    let best = null;
    for (const s of seasons) {
      for (const ep of s.episodes) {
        const t = Date.parse(ep.released);
        if (!Number.isFinite(t) || t <= now) continue;
        if (!best || t < best) best = t;
      }
    }
    return best;
  };

  const metaPartsFor = (season) => {
    const upcoming = nextAiring();
    return [
      String(seasonYear(season) || view.year || "") || null,
      isShow &&
        seasons.length &&
        `${seasons.length} season${seasons.length !== 1 ? "s" : ""}`,
      isShow && lib && lib.episodeCount && `${lib.episodeCount} downloaded`,
      !isShow && lib && lib.duration && fmtDuration(lib.duration),
      !isShow && !lib && meta && meta.runtime,
      !isShow && lib && lib.sizeBytes && fmtBytes(lib.sizeBytes),
      meta && meta.director && `Dir. ${meta.director}`,
      upcoming && `Next episode ${fmtAirDate(upcoming)}`,
    ];
  };

  screen.append(
    heroBlock(view, actions, metaPartsFor(null), {
      rateKey: imdbId || (lib && lib.id),
    }),
  );

  if (meta && meta.cast && meta.cast.length) {
    screen.append(
      el(
        "div",
        { class: "detail-cast page-pad" },
        el("span", { class: "cast-label" }, "Cast "),
        meta.cast.join(" · "),
      ),
    );
  }

  // "More like this" — a row of similar titles at the bottom of the page.
  // Appended per-branch (the movie branch returns early) and filled in async;
  // an empty or failed answer simply leaves no row.
  const similarHost = el("div");
  const fillSimilar = () => {
    if (!imdbId) return;
    api
      .discoverSimilar(
        view.type === "show" ? "series" : "movie",
        imdbId,
        meta && meta.tmdbId,
      )
      .then(({ items, source }) => {
        const cards = (items || [])
          .filter((m) => m.imdbId && m.poster && m.imdbId !== imdbId)
          .map((m) => ({ ...m, source: "stream", cover: m.poster }));
        const node = shelfRow(
          source === "genre" ? "Similar titles" : "More like this",
          cards,
          { showKind: true },
        );
        if (node && similarHost.isConnected) {
          node.style.marginTop = "26px";
          similarHost.append(node);
        }
      })
      .catch(() => {});
  };

  // ---------- movies ----------
  if (!isShow) {
    // A local-only title (no IMDb match) simply has nothing to stream.
    if (!imdbId) return;
    screen.append(
      el(
        "h2",
        { class: "row-title", style: { marginTop: "24px" } },
        lib ? "Other versions" : "Sources",
      ),
      sourcesSection,
      similarHost,
    );
    fillSimilar();
    const base = meta || { ...view, imdbId };
    const showMovieSources = () =>
      loadSources(
        sourcesSection,
        {
          type: "movie",
          imdbId,
          year: view.year,
          owned: lib
            ? {
                id: lib.id,
                label: `${view.title} — in your library`,
                onDownload: lib.downloadUrl
                  ? () => openDownload(view.title, [lib], deviceKeys)
                  : null,
              }
            : null,
        },
        (s) => playStream(s, base, view.title),
        (s) => requestDownload(s, base, view.title),
      );
    showMovieSources();

    // Finished while you were watching the page? Show it, don't make them reload.
    const unsubMovie = onMessage("download_update", async ({ job }) => {
      if (!screen.isConnected) return unsubMovie();
      if (!job || job.status !== "done") return;
      const mine =
        (job.imdbId && job.imdbId === imdbId) ||
        libNorm(job.title) === libNorm(view.title);
      if (!mine) return;
      try {
        await loadLibrary(true);
      } catch {}
      const libId = findInLibrary(
        meta || { type: "movie", title: view.title, year: view.year },
      );
      const fresh = libId ? await api.item(libId).catch(() => null) : null;
      if (!fresh) return;
      lib = fresh;
      showMovieSources();
    });
    return;
  }

  // ---------- shows ----------
  const seasonKey = `aurora-season-${imdbId || (lib && lib.id)}`;
  const savedSeason = parseInt(localStorage.getItem(seasonKey) || "", 10);
  const hasSaved = seasons.some((s) => s.number === savedSeason);
  let activeSeason = hasSaved
    ? savedSeason
    : nextUp
      ? nextUp.season
      : seasons[0]?.number || 1;

  const seasonBar = el("div", { class: "season-bar" });
  const episodeList = el("div", { class: "episode-list" });
  const epSourcesLabel = el(
    "h2",
    { class: "row-title", style: { marginTop: "8px" } },
    "Sources",
  );

  const base = meta || { ...view, imdbId };

  // The episode whose sources are on screen, so a finished download can put its
  // "plays your copy" row in front of you without you doing anything.
  let openRow = null;

  const openSources = (row, { scroll = true } = {}) => {
    if (!imdbId) return;
    openRow = row;
    epSourcesLabel.textContent = `Sources · S${row.season} E${row.episode}`;
    loadSources(
      sourcesSection,
      {
        type: "series",
        imdbId,
        year: view.year,
        season: row.season,
        episode: row.episode,
        owned: row.local
          ? {
              id: row.local.id,
              label: `${view.title} · S${row.season} E${row.episode} — in your library`,
              onDownload: row.local.downloadUrl
                ? () =>
                    openDownload(
                      `${view.title} — S${row.season} E${row.episode}`,
                      [row.local],
                      deviceKeys,
                    )
                : null,
            }
          : null,
      },
      (s) =>
        playStream(
          s,
          base,
          `${view.title} · S${row.season} E${row.episode}`,
          row.season,
          row.episode,
        ),
      (s) =>
        requestDownload(
          s,
          base,
          `${view.title} · S${row.season} E${row.episode}`,
          row.season,
          row.episode,
        ),
    );
    if (scroll)
      sourcesSection.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // Mark an episode watched — the local file when we have it, otherwise against
  // the IMDb id, so an episode you streamed (or watched elsewhere) can be ticked
  // off exactly like one you own.
  // `defer` skips the refresh+repaint so a season batch does them ONCE at the
  // end — per-episode it was N×(POST + full profile fetch + list rebuild).
  const setWatched = async (row, watched, defer = false) => {
    if (!state.profile) return;
    const local = row.local;
    const id = local
      ? local.id
      : streamProgressKey(imdbId, row.season, row.episode);
    const dur = (local && local.duration) || 1;
    try {
      if (watched) {
        await api.saveProgress(
          state.profile.id,
          id,
          dur,
          dur,
          local
            ? undefined
            : {
                imdbId,
                season: row.season,
                episode: row.episode,
                title: view.title,
              },
        );
      } else {
        await api.clearProgress(state.profile.id, id);
      }
      if (!defer) {
        await refreshProgress();
        renderEpisodes();
      }
    } catch {}
  };

  // Watched-state of one episode row, local or streamed (shared by the rows
  // and the season pill's label/batch).
  const isWatchedRow = (r) =>
    !!(r.local
      ? progressFor(r.local.id)?.finished
      : (
          episodeProgressFor(imdbId, r.season, r.episode) ||
          progressFor(streamProgressKey(imdbId, r.season, r.episode))
        )?.finished);

  // Assigned below, once the season bar exists — a season you own nothing in
  // has nothing to offer, so the pill comes and goes with the active season.
  let downloadSeasonPill = null;
  let markSeasonPill = null; // label follows the active season's true state
  const ownedIn = (season) =>
    ((season && season.episodes) || []).filter((r) => r.local && r.local.downloadUrl);

  const renderEpisodes = (scrollToNext = false) => {
    const season = seasons.find((s) => s.number === activeSeason) || seasons[0];
    // Keep the hero's meta line honest about which season you're looking at.
    const metaNode = screen.querySelector(".detail-meta-parts");
    if (metaNode) {
      metaNode.textContent = metaPartsFor(season).filter(Boolean).join(" · ");
    }
    if (downloadSeasonPill) {
      const owned = ownedIn(season);
      downloadSeasonPill.hidden = owned.length === 0;
      downloadSeasonPill.textContent = `Download season to device (${owned.length})`;
    }
    if (markSeasonPill && season) {
      // Say what the tap will actually DO — the old static label silently
      // CLEARED a fully-watched season.
      const states = resolveAirStates(season.episodes);
      const aired = season.episodes.filter((r, i) => states[i] === "aired");
      const left = aired.filter((r) => !isWatchedRow(r)).length;
      markSeasonPill.textContent =
        left === 0 && aired.length > 0
          ? "Mark season unwatched"
          : left === aired.length
            ? "Mark season watched"
            : `Mark season watched (${left} left)`;
      markSeasonPill.hidden = aired.length === 0;
    }
    episodeList.innerHTML = "";
    if (!season || !season.episodes.length) {
      episodeList.append(
        el("div", { class: "sources-empty" }, "No episodes listed yet."),
      );
      return;
    }
    const airStates = resolveAirStates(season.episodes);
    // The first aired episode you haven't finished — marked in the list so a
    // 24-row season doesn't make you hunt through the Watched badges.
    const upNextAt = season.episodes.findIndex(
      (r, i) => airStates[i] === "aired" && !isWatchedRow(r),
    );
    const anyWatched = season.episodes.some((r) => isWatchedRow(r));
    season.episodes.forEach((row, i) => {
      const local = row.local;
      const air = airStates[i];
      // Not aired yet means there is nothing to open: no file, and no source
      // provider has anything either. A row that opens an empty list reads as
      // broken, so these say what they are and stay put.
      const unaired = air !== "aired";
      // Progress comes from the local file when we have it, otherwise from
      // whatever source was streamed for this episode before.
      const p = local
        ? progressFor(local.id)
        : episodeProgressFor(imdbId, row.season, row.episode) ||
          progressFor(streamProgressKey(imdbId, row.season, row.episode));
      const pct =
        p && p.duration > 0
          ? Math.min(100, (p.position / p.duration) * 100)
          : 0;
      const watched = !!(p && p.finished);

      const epBtn = el(
        "button",
        {
          // Every episode opens its list, downloaded or not — pressing an episode
          // shouldn't drop you straight into playback. Your copy sits at the top of
          // that list as the obvious first choice, so it is still one more click.
          class:
            "episode" +
            (unaired ? " unaired" : " focusable") +
            (local ? " owned" : "") +
            (i === upNextAt && anyWatched ? " up-next" : ""),
          ...(unaired
            ? { disabled: true, "aria-disabled": "true" }
            : { onclick: () => openSources(row) }),
        },
        el("div", { class: "episode-num" }, row.episode),
        el(
          "div",
          { class: "episode-body" },
          el(
            "div",
            { class: "episode-title" },
            el(
              "span",
              { class: "episode-name" },
              row.title || `Episode ${row.episode}`,
            ),
            local && el("span", { class: "source-owned" }, "✓ DOWNLOADED"),
            i === upNextAt && anyWatched && el("span", { class: "ep-up-next" }, "UP NEXT"),
          ),
          el(
            "div",
            { class: "episode-sub" },
            // The date leads: for an episode you don't own it is the only fact
            // on the line, and for one you do it is the thing the page was
            // missing. "Date TBA" stands in when a season is announced but not
            // yet scheduled.
            air === "tba"
              ? el("span", { class: "ep-air tba" }, "Date TBA")
              : row.released &&
                el(
                  "span",
                  { class: "ep-air" + (unaired ? " upcoming" : "") },
                  fmtAirDate(row.released),
                ),
            local &&
              local.duration &&
              el("span", { class: "ep-dur" }, fmtDuration(local.duration)),
            local &&
              local.subtitles &&
              local.subtitles.length > 0 &&
              el("span", { class: "badge" }, "CC"),
            watched && el("span", { class: "badge" }, "Watched"),
            // Last and shrinkable: the facts about the file come first, and the
            // synopsis gives way instead of pushing them onto a second line.
            row.overview && el("span", { class: "ep-overview" }, row.overview),
          ),
        ),
        pct > 0 &&
          !watched &&
          el(
            "div",
            { class: "episode-bar" },
            el("div", { style: { width: pct + "%" } }),
          ),
        !unaired && el("span", { class: "episode-play", html: icons.play }),
      );

      const extras = [];
      // Only an episode we hold on disk can be handed to the viewer's machine.
      if (local && local.downloadUrl) {
        extras.push(
          el("button", {
            class: "ep-action focusable",
            title: "Download to this device",
            "aria-label": `Download episode ${row.episode} to this device`,
            html: icons.downloadDevice,
            onclick: () =>
              openDownload(`${view.title} — S${row.season} E${row.episode}`, [local], deviceKeys),
          }),
        );
      }
      // Every episode that exists can be ticked off, downloaded or not (see
      // setWatched) — but nothing that hasn't aired, which nobody can have seen.
      if (state.profile && !unaired && (local || imdbId)) {
        extras.push(
          el("button", {
            class: `ep-action focusable ${watched ? "on" : ""}`,
            title: watched ? "Mark unwatched" : "Mark watched",
            "aria-label": watched ? "Mark unwatched" : "Mark watched",
            html: icons.check,
            onclick: () => setWatched(row, !watched),
          }),
        );
      }
      episodeList.append(
        extras.length
          ? el("div", { class: "episode-wrap" }, epBtn, ...extras)
          : epBtn,
      );
    });
    // On open (and season switch), bring the next unwatched episode into
    // view when it sits deep in a long season — only when there's real
    // watching history, so a fresh show never yanks the page around.
    if (scrollToNext && anyWatched && upNextAt > 3 && season.episodes.length > 8) {
      const target = episodeList.querySelector(".up-next");
      if (target)
        setTimeout(() => {
          if (!target.isConnected) return;
          target.scrollIntoView({
            behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
              ? "auto"
              : "smooth",
            block: "center",
          });
        }, 350);
    }
  };

  const pickSeason = (n) => {
    activeSeason = n;
    try {
      localStorage.setItem(seasonKey, String(n));
    } catch {}
    renderEpisodes(true);
  };
  if (seasons.length > 8) {
    // A long show's pills ran off the bar (scrollbar hidden, no affordance) —
    // one picker jumps anywhere. Same dropdown as the browse filters: scope-
    // safe for the D-pad, Back closes it.
    const seasonBtn = el("button", { class: "picker-btn focusable" });
    const face = () => {
      seasonBtn.innerHTML = "";
      seasonBtn.append(
        el("span", { class: "picker-label" }, "Season"),
        el("span", { class: "picker-value" }, String(activeSeason)),
        el("span", { class: "picker-caret" }, "▾"),
      );
    };
    seasonBtn.onclick = () =>
      dropdown(
        seasonBtn,
        seasons.map((s) => ({ label: `Season ${s.number}`, value: s.number })),
        activeSeason,
        (v) => {
          pickSeason(v);
          face();
        },
      );
    face();
    seasonBar.append(seasonBtn);
  } else {
    for (const s of seasons) {
      const pill = el(
        "button",
        {
          class: `season-pill focusable ${s.number === activeSeason ? "active" : ""}`,
          onclick: () => {
            pickSeason(s.number);
            seasonBar
              .querySelectorAll(".season-pill")
              .forEach((p) => p.classList.remove("active"));
            pill.classList.add("active");
          },
        },
        `Season ${s.number}`,
      );
      if (seasons.length > 1) seasonBar.append(pill);
    }
  }
  // Trailing actions sit apart from the season pills; whichever comes first
  // pushes the pair to the far end of the bar.
  const trailing = [];
  if (lib) {
    downloadSeasonPill = el(
      "button",
      {
        class: "season-pill focusable",
        onclick: () => {
          const season =
            seasons.find((s) => s.number === activeSeason) || seasons[0];
          openDownload(
            `${view.title} — Season ${season.number}`,
            ownedIn(season).map((r) => r.local),
            deviceKeys,
          );
        },
      },
      "Download season to device",
    );
    trailing.push(downloadSeasonPill);
  }
  // One tap for the whole season — as ONE parallel batch with a single
  // repaint (it was N serial requests, each refetching the profile and
  // rebuilding the list), and an Undo that restores each episode's previous
  // state, so accidentally clearing a watched season is one tap back.
  if (state.profile && (lib || imdbId)) {
    const applyBatch = async (rows, want) => {
      markSeasonPill.disabled = true;
      const before = markSeasonPill.textContent;
      markSeasonPill.textContent = "Working…";
      await Promise.allSettled(
        rows.map(({ r, watched }) => setWatched(r, watched, true)),
      );
      await refreshProgress();
      renderEpisodes();
      markSeasonPill.disabled = false;
      if (markSeasonPill.textContent === "Working…")
        markSeasonPill.textContent = before;
      return want;
    };
    markSeasonPill = el(
      "button",
      {
        class: "season-pill focusable",
        onclick: async () => {
          if (markSeasonPill.disabled) return;
          const season =
            seasons.find((s) => s.number === activeSeason) || seasons[0];
          const airStates = resolveAirStates(season.episodes);
          const rows = season.episodes.filter((_, i) => airStates[i] === "aired");
          const prev = rows.map((r) => ({ r, watched: isWatchedRow(r) }));
          const target = !rows.every(isWatchedRow);
          await applyBatch(
            prev.filter((p) => p.watched !== target).map(({ r }) => ({ r, watched: target })),
            target,
          );
          toast(
            target
              ? `Season ${season.number} marked watched`
              : `Season ${season.number} marked unwatched`,
            "✅",
            { label: "Undo", onClick: () => applyBatch(prev.filter((p) => p.watched !== target), null) },
          );
        },
      },
      "Mark season watched",
    );
    trailing.push(markSeasonPill);
  }
  if (trailing.length) {
    seasonBar.append(
      el(
        "div",
        {
          class: "season-bar-trailing",
          style: { marginLeft: seasons.length > 1 ? "auto" : "0" },
        },
        trailing,
      ),
    );
  }

  screen.append(seasonBar, episodeList);
  if (imdbId) screen.append(epSourcesLabel, sourcesSection);
  renderEpisodes(true);

  // A download that finishes while you're looking at the page updates the page.
  // Waiting for a download and then having to reload to see it is the sort of
  // thing that makes people think it didn't work.
  const unsubDone = onMessage("download_update", async ({ job }) => {
    if (!screen.isConnected) return unsubDone();
    if (!job || job.status !== "done") return;
    const mine =
      (job.imdbId && job.imdbId === imdbId) ||
      libNorm(job.title) === libNorm(view.title);
    if (!mine) return;
    try {
      await loadLibrary(true);
    } catch {}
    const libId = lib
      ? lib.id
      : findInLibrary(
          meta || { type: view.type, title: view.title, year: view.year },
        );
    const fresh = libId ? await api.item(libId).catch(() => null) : null;
    if (!fresh) return;
    lib = fresh;
    seasons.splice(0, seasons.length, ...mergeSeasons(lib, meta));
    renderEpisodes();
    // Re-open the same episode's list (without yanking the page around) so the
    // new copy shows up as the top row.
    const again =
      openRow &&
      (seasons.find((s) => s.number === openRow.season)?.episodes || []).find(
        (e) => e.episode === openRow.episode,
      );
    if (again) openSources(again, { scroll: false });
  });

  // Extras (bonus downloads the scanner found next to the show).
  if (lib && lib.extras && lib.extras.length > 0) {
    screen.append(
      el("h2", { class: "row-title", style: { marginTop: "26px" } }, "Extras"),
      el(
        "div",
        { class: "episode-list", style: { paddingTop: 0 } },
        lib.extras.map((x) =>
          el(
            "a",
            { class: "extra-row focusable", href: x.url },
            el("span", {
              html: icons.download,
              style: { width: "20px", height: "20px", display: "inline-flex" },
            }),
            x.name,
            el("span", { class: "size" }, fmtBytes(x.sizeBytes)),
          ),
        ),
      ),
    );
  }

  screen.append(similarHost);
  fillSimilar();

  if (imdbId) {
    sourcesSection.append(
      el(
        "div",
        { class: "sources-empty" },
        "Pick an episode above to see its sources.",
      ),
    );
  }
};

// Progress key for something watched WITHOUT a library copy. Marking a streamed
// title watched has to record it somewhere, and there is no library id to hang
// it on — so it hangs on the IMDb id (plus season/episode for a show), which is
// the only stable identity a streamed title has.
export const streamProgressKey = (imdbId, season, episode) =>
  season ? `stream|${imdbId}|${season}|${episode}` : `stream|${imdbId}`;

const libNorm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

// Find a library item for a streamed title. Exact title first, then a prefix
// match with the year agreeing — folder names carry extra words, and a copy of
// Avatar (2009) sitting in a folder called "Avatar Movie" is still your copy.
// The same tolerance the server's /api/imdb-for uses, in the other direction.
const libMatch = (pool, title, year) => {
  const want = libNorm(title);
  if (!want) return null;
  const exact = (pool || []).find((i) => libNorm(i.title) === want);
  if (exact) return exact;
  return (
    (pool || []).find((i) => {
      const have = libNorm(i.title);
      // A year that disagrees, or a stub of a title, is a different thing.
      if (year && i.year && Math.abs(i.year - year) > 1) return false;
      if (Math.min(have.length, want.length) < 4) return false;
      return have.startsWith(want) || want.startsWith(have);
    }) || null
  );
};

const findInLibrary = (meta) => {
  const lib = state.library;
  if (!lib) return null;
  const pool = meta.type === "show" ? lib.shows : lib.movies;
  const hit = libMatch(pool, meta.title, meta.year);
  return hit ? hit.id : null;
};

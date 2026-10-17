// The player — a direct port of the web player, public/js/screens/player.js.
//
// The web player is the artefact that has actually passed elia's standards, so
// it is the spec: same source-selection order, same offset-aware transcode, same
// probe-before-seek, same keep-alive, same copy. Where this file diverges it is
// because ExoPlayer cannot do what a <video> element does, and every one of
// those places says so.
//
// The three structural rules this rewrite is built around:
//
//  1. THE textTracks LIST IS FROZEN BEFORE THE FIRST URI. react-native-video
//     folds textTracks (and bufferConfig, and minLoadRetryCount) into ONE native
//     source object; handing over a new source runs ReactExoplayerView.setSrc(),
//     which calls clearResumePosition() and reloads from zero. The web builds
//     every <track> up front when it creates the <video>, so the port resolves
//     the whole subtitle list first and never touches it again — which is why
//     late-arriving OpenSubtitles tracks can no longer throw a running film back
//     to 0:00. Switching tracks goes through `selectedTextTrack` only, which does
//     NOT reload.
//
//  2. SUBTITLES ARE RENDERED IN JS, NOT BY EXOPLAYER. This is what fixes
//     "subtitles do not work at all", and there are three independent reasons
//     for it:
//
//       • Selection was broken and could not be worked around cleanly. In
//         react-native-video 6.19's Android bridge
//         (ReactExoplayerView.selectTextTrackInternal), `index` is matched as
//         `targetIndex == trackIndex` — the index WITHIN a TrackGroup. Every
//         side-loaded subtitle is its own single-track group, so trackIndex is
//         always 0: index 0 always selects the FIRST track and every other index
//         silently matches nothing ("Text track not found … Keeping current
//         selection."). The default pick is Hebrew, which is rarely track 0, so
//         nothing was ever selected.
//
//       • Cue times could not be anchored. Sidecar cue times are CONTENT
//         absolute, but a transcode's clock starts at streamOffset — so
//         resuming Inception 8:53 in would have put every cue 8:53 early. The
//         web fixes this by rewriting cue.startTime (see its applyOffsetToTrack);
//         ExoPlayer exposes no equivalent, and re-encoding the VTT per offset
//         would mean changing the track list mid-film, i.e. a reload.
//
//       • Rule 1 stops applying. With no textTracks in the source, the source
//         changes only when the URI does — so late-arriving OpenSubtitles tracks
//         are free, exactly as they are on the web, and switching tracks is pure
//         JS with no native involvement at all.
//
//     Cues are matched against the player's CONTENT clock, so the anchoring
//     problem disappears by construction, and this brings across two things the
//     handover doc had written off: the site's per-track timing nudge
//     (nudgeSubs/resyncSubs) and its ::cue background. ExoPlayer's own text
//     renderer is disabled so an MKV's default in-container track can never
//     draw a second copy underneath.
//
//  3. A TORRENT URL IS NEVER HANDED OVER BLIND, BUT NEVER WITHHELD FOREVER.
//     (Rule 1 still governs bufferConfig and minLoadRetryCount, which are folded
//     into the same native source object.)
//     ExoPlayer's HTTP timeouts fire long before the server finds peers, where
//     the browser's <video> simply waits — hence the ready-gate. But the gate
//     used to require `peers > 0`, which a fully-downloaded (or cached) torrent
//     legitimately never reports, and that is what left Continue Watching
//     sitting on the loading screen forever. The gate now opens on the honest
//     signal — the kick request actually returning bytes — and has two time
//     fallbacks, because handing the URL over late is always better than never.
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  ActivityIndicator,
  Animated,
  BackHandler,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TVFocusGuideView,
  useTVEventHandler,
  View,
} from 'react-native';
import Video, {
  BufferingStrategyType,
  OnLoadData,
  OnProgressData,
  SelectedTrack,
  SelectedTrackType,
  VideoRef,
} from 'react-native-video';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import Focusable from '../components/Focusable';
import Icon, {IconName} from '../components/Icon';
import {api, ApiError, assetUrl, imgSrc, mediaHeaders, Item, Party, PartyItem, ProfileState, SubtitleTrack} from '../api';
import {useApp} from '../AppContext';
import {useRouteShown} from '../useRouteShown';
import {setPlayingContext} from '../errors';
import {acceptTvEvent, useFocusFallback} from '../focus';
import {canNavigate} from '../navLock';
import {openXray} from '../overlay';
import {loadMe, profilePick, rememberPick, useMe} from '../navSection';
import {audioPick, langCode, langOf, pickOf, sameAudio} from '../lang';
import {
  createParty,
  joinParty,
  leaveParty,
  onPartyEnded,
  onPartyItem,
  onPartyState,
  onPartyUpdate,
  party,
  PartyStateMsg,
  sendPartyState,
  setPartyItem,
} from '../party';
import {holdLibraryRefresh, isOpen as socketOpen, onLibraryNews, reportActivity} from '../realtime';
import {ignoreIntro, loadIgnoredIntros, loadPrefs, savePrefs, Prefs, PREFS_DEFAULTS} from '../storage';
import {PERSON_KEYS, PersonKey} from '../personPrefs';
import {resumePoint, SKIP_STEPS} from '../episodeRules';
import {
  nextAutoRun,
  NextEp,
  nextAnswerChanged,
  nextFile,
  NEXT_REASK_BEFORE_END_S,
  planUpNext,
  Range,
  rangeOf,
  readNext,
  skippableAt,
  stallStep,
  STALL_MARK_MS,
  stallClockFirstFrame,
  stallClockNew,
  stallClockOff,
  stallClockOn,
  upNextState,
} from '../playerRules';
import {openReport, overlayOpen} from '../overlay';
import {onPersonPrefs, setPersonPref} from '../personSync';
import {track} from '../usage';
import {clearImageMemory, isLowRam} from '../perfTier';
import {RootStackParamList} from '../navigation';
import theme, {useTvMetrics} from '../theme';
import {menuMaxHeight} from '../popupFit';
import {refreshTuning, tuning, TUNING_DEFAULTS} from './tuning';
import {Clock, clockBaseFor, clockFromHeaders, toContent, toMedia} from './clock';
import {Cue, cueBottom, cueTextAt, parseVtt} from './cues';
import {delaysForItem, loadDelays, roundDelay, saveDelay} from './subDelay';
import {audioName, autoPick, buildTracks, followPick, hasLang, langName, Track as SubTrack} from './subTracks';
import {afterClaim, claimFirst, SERVER_BUSY, whenRoom} from '../serverManners';
import {playerError, seekResumed, seekStarted, seeking} from '../telemetry'; // [analytics]

const {colors, radius, fontSize, spacing} = theme;

// The site's .player-top / .player-bottom scrims. RN has no linear-gradient, so
// these are baked PNGs (tools/gen-gradients.js) stretched over each bar. Without
// them the controls sat on flat translucent slabs with a visible top edge — the
// site deliberately fades them out so the chrome floats on the picture.
const SCRIM_TOP = require('../assets/player-top.png');
const SCRIM_BOTTOM = require('../assets/player-bottom.png');

// ---------------------------------------------------------------- constants
// From player.js. (The skip steps and the resume rule live in episodeRules.ts,
// where a test holds them to the website's.)
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const SKIP_CHAIN_MS = 900;
// The site hides its chrome 3200ms after the last input. That is a mouse-era
// number and it does not survive a remote: reaching Subtitles is six D-pad
// presses from the scrubber, and every pause to think threw the chrome away and
// put focus back on the scrubber, so you had to start the walk again. A press
// still resets it; this is just how long "no input" is allowed to be.
const HIDE_MS = 7000;
// seekTo()'s debounce: a burst of remote presses moves the scrubber instantly
// but touches the network once, after the presses stop.
const SEEK_DEBOUNCE_MS = 450;
// The web's HLS recovery budget: four attempts per burst, and the budget
// refreshes if the next failure comes more than a window later — so an outage
// that ends (server restarted, swarm woke up) is picked up again instead of
// leaving the viewer on a dead screen forever.
const MAX_RECOVERIES = 4;
const RECOVERY_WINDOW_MS = 30000;
// The site's S/M/L ::cue sizes, scaled up for a 10-foot view.
const CUE_PX: Record<Prefs['cueSize'], number> = {S: 18, M: 24, L: 32};

// Hoisted to module scope, and that matters: react-native-video folds
// bufferConfig into the video SOURCE, and the source is what
// setSrc()/clearResumePosition() key off. A fresh object literal here meant a new
// source identity on every render, and this component re-renders roughly once a
// second while the scrubber is on screen.
//
// The sizes are also much deeper than react-native-video's defaults. Everything
// this player reads is either a LAN file or a torrent being written as it
// downloads, so a short buffer turns any hiccup — a busy Wi-Fi moment, a slow
// swarm second, the server seeking on disk — straight into a visible stall.
// (The web asks hls.js for maxBufferLength: 45 for the same reason.)
const BUFFER_CONFIG = {
  minBufferMs: 50000,
  maxBufferMs: 120000,
  bufferForPlaybackMs: 2000,
  bufferForPlaybackAfterRebufferMs: 8000,
  backBufferDurationMs: 30000,
};
// LOW-RAM boxes (perfTier.ts): the same time targets, but ExoPlayer stops
// filling the buffer once it holds ~30% of the app's heap class (memoryClass:
// 192 MB → ~58 MB) instead of whatever 50-120 s of a high-bitrate file weighs
// — measured ~250 MB of Java heap on a remux, on a box with 1.9 GB in all —
// and keeps 10 s behind the playhead instead of 30. Below 8 s buffered it
// keeps loading regardless (patches/react-native-video: a buffer that may
// never reach the rebuffer threshold would stall forever). Viewer-invisible:
// the picture and the start/rebuffer thresholds are the same; a box that
// lacks the memory simply holds less ahead.
const BUFFER_CONFIG_LOW_RAM = {
  ...BUFFER_CONFIG,
  backBufferDurationMs: 10000,
  maxHeapAllocationPercent: 0.3,
  // and stop filling while less than 10% of the Java heap is free (this check
  // never fired before the patch: a cast zeroed the reserve)
  minBufferMemoryReservePercent: 0.1,
};
// The buffer configuration for a new source: the constants above, with the
// two start thresholds from the server's tuning when it set them
// (playback/tuning.ts). ONE object per distinct setting, ever — the same
// identity rule as the constants (a fresh object is a fresh source). With
// nothing tuned these ARE the constants.
const tunedBuffers = new Map<string, typeof BUFFER_CONFIG>();
const bufferConfigFor = (lowRam: boolean) => {
  const base = lowRam ? BUFFER_CONFIG_LOW_RAM : BUFFER_CONFIG;
  const t = tuning();
  if (t.startBufferMs === TUNING_DEFAULTS.startBufferMs && t.rebufferMs === TUNING_DEFAULTS.rebufferMs) return base;
  const key = `${lowRam ? 1 : 0}|${t.startBufferMs}|${t.rebufferMs}`;
  let c = tunedBuffers.get(key);
  if (!c) {
    c = {...base, bufferForPlaybackMs: t.startBufferMs, bufferForPlaybackAfterRebufferMs: t.rebufferMs};
    tunedBuffers.set(key, c);
  }
  return c;
};
// A torrent stream trickles at first — retry reads generously rather than
// erroring on the first slow chunk. This is the ExoPlayer equivalent of the
// web's fragLoadingMaxRetry: 8 / fragLoadingTimeOut: 60000.
const MIN_LOAD_RETRY = 50;

const fmt = (s: number) => {
  if (!isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return (h ? `${h}:` : '') + `${mm}:${String(sec).padStart(2, '0')}`;
};
const fmtSpeed = (bytesPerSec: number) => {
  if (!bytesPerSec) return '';
  const mb = bytesPerSec / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB/s` : `${Math.round(bytesPerSec / 1024)} KB/s`;
};
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const NO_FILE = 'This title has no playable file.';
// The ?v= of a transcode job: the remux, the full re-encode, or one of the
// server's CAPPED encodes for a slow line (media/remux.js CAPS — 720p at about
// 2.4 Mbit/s all in, 480p at about 1.1) — the site's Quality ladder.
type VCodec = 'copy' | 'h264' | 'h264-720' | 'h264-480';
// No first frame from a library file after this long: say so, and offer a way
// out (see the slow-start watchdog).
const SLOW_START_MS = 25000;
// …and after this long, say why it is probably happening.
const SLOW_BIG_MS = 90000;

// The site's buffering copy (screens/player.js), ported verbatim.
//
// A spinner alone is what makes a working player look hung: the viewer can't
// tell "no seeders" from "transcoding" from "downloaded, nearly there". These
// are the exact distinctions the web player draws.
type StatusInput = {
  st: {peers: number; downloadSpeed: number; progress: number} | null;
  readySec: number;
  everPlayed: boolean;
  onTranscode: boolean;
  seekWait: {target: number; at: number} | null;
  stalled: boolean; // 60s in and not a single frame has played
};
const torrentStatusCopy = ({
  st,
  readySec,
  everPlayed,
  onTranscode,
  seekWait,
  stalled,
}: StatusInput): {title: string; sub: string} => {
  if (stalled) {
    return {title: 'Still trying…', sub: 'Few or no seeders — try another source'};
  }
  const waiting = seekWait
    ? ` · skipping to ${fmt(seekWait.target)} (${fmt(
        Math.round((Date.now() - seekWait.at) / 1000),
      )})`
    : '';
  if (st && st.peers > 0) {
    const parts = [`${st.peers} peer${st.peers === 1 ? '' : 's'}`];
    // Speed only while actually downloading. A (near) complete file reads 0 by
    // nature, and "0 MB/s" looks broken — the real wait there is the transcode.
    const downloaded = (st.progress || 0) >= 0.99;
    if (st.downloadSpeed > 30000) parts.push(fmtSpeed(st.downloadSpeed));
    else if (downloaded) parts.push('downloaded');
    parts.push(
      readySec > 0
        ? `${readySec}s of video ready`
        : onTranscode
        ? 'transcoding…'
        : 'getting the first frames…',
    );
    return {
      title: seekWait
        ? 'Fetching that part of the stream…'
        : everPlayed
        ? 'Re-buffering…'
        : onTranscode
        ? 'Preparing stream…'
        : 'Buffering…',
      sub: parts.join(' · ') + waiting,
    };
  }
  return {
    title: seekWait ? 'Fetching that part of the stream…' : 'Connecting to peers…',
    sub: (seekWait ? 'waiting on the swarm' : 'This can take a moment') + waiting,
  };
};

// ExoPlayer's own text renderer, off. An MKV can carry an in-container track
// flagged DEFAULT, which media3 would switch on by itself and draw underneath
// the cues this file renders — two copies of the subtitles, one of them
// mistimed. Module scope so it is never a new object.
const NO_NATIVE_TEXT: SelectedTrack = {type: SelectedTrackType.DISABLED};

// ------------------------------------------------------------------ WebVTT
// The parser, the lookup and the cue layer's position are in cues.ts (pure,
// with logic tests): everything the server serves is meant to be WebVTT, but a
// torrent's own .srt, a provider's BOM or a missing blank line must not cost
// the viewer the subtitles.

// The cue layer. Deliberately its own component with its own state: it ticks at
// 200ms for accurate cue boundaries, but only calls setState when the TEXT
// changes — so a two-hour film re-renders this about once every couple of
// seconds and never touches the player tree above it.
const Subtitles = React.memo(function CueLayer({
  cues,
  timeRef,
  offset,
  sizePx,
  background,
  bottom,
}: {
  cues: Cue[] | null;
  timeRef: React.MutableRefObject<() => number>;
  offset: number;
  sizePx: number;
  background: boolean;
  bottom: number;
}) {
  const [text, setText] = useState('');
  useEffect(() => {
    if (!cues || !cues.length) {
      setText('');
      return;
    }
    // A stateless lookup (cues.ts cueTextAt, a binary search): there is no
    // cursor to leave behind, so a seek or a delay nudge in EITHER direction
    // shows the right cue on the very next tick — and `offset` is a dependency,
    // so a nudge re-runs this at once rather than on the next 200 ms beat.
    const tick = () => {
      const next = cueTextAt(cues, timeRef.current() - offset);
      setText(prev => (prev === next ? prev : next));
    };
    tick();
    const iv = setInterval(tick, 200);
    return () => clearInterval(iv);
  }, [cues, timeRef, offset]);
  if (!text) return null;
  return (
    <View pointerEvents="none" style={[styles.cueWrap, {bottom}]}>
      <Text
        style={[
          styles.cueText,
          {fontSize: sizePx, lineHeight: Math.round(sizePx * 1.4)},
          background ? styles.cueBg : styles.cueShadow,
        ]}>
        {text}
      </Text>
    </View>
  );
});

// .menu-item. The site marks the ACTIVE entry with a ✓ in front of the label and
// reserves the same width on every other row (`.menu-item:not(.active)::before {
// width: 13px }`), so the labels all start at the same x and the list is
// scannable at a glance. A background fill alone — which is what this app had —
// tells you something is highlighted but not which one is ON, and at 10 feet
// with focus ALSO drawing a background they were easy to confuse.
// A dub's name for the menu: subTracks.ts audioName (the server's label, else
// the language and what the track's title adds).

// A menu section's title with its glyph (elia, 2026-10-07: "add icons where
// it makes sense"): the same icon family as the transport row, dim, 13dp.
const MenuTitle = ({icon, label, gap}: {icon: IconName; label: string; gap?: boolean}) => (
  <View style={[styles.menuTitleRow, gap && styles.menuTitleGap]}>
    <Icon name={icon} size={13} color={colors.textDim} />
    <Text style={styles.menuTitle}>{label}</Text>
  </View>
);

const MenuItem = React.forwardRef<
  View,
  {
    label: string;
    tag?: string;
    on?: boolean;
    icon?: IconName; // a glyph before the label, for the rows that are actions rather than choices
    hasTVPreferredFocus?: boolean;
    onPress: () => void;
    onFocusChange?: (f: boolean) => void;
    uiId?: string; // [analytics] which control this is (Focusable.uiId)
  }
>(function PlayerMenuItem({label, tag, on, icon, hasTVPreferredFocus, onPress, onFocusChange, uiId}, ref) {
  return (
    <Focusable
      ref={ref}
      round
      noScale
      ring="none"
      highlightColor={colors.surfaceHover}
      hasTVPreferredFocus={hasTVPreferredFocus}
      onFocusChange={onFocusChange}
      uiId={uiId}
      onPress={onPress}
      style={styles.menuItem}>
      <Text style={[styles.menuCheck, !on && styles.menuCheckOff]}>✓</Text>
      {icon ? <Icon name={icon} size={14} color={on ? colors.text : colors.textDim} /> : null}
      <Text style={[styles.menuItemText, on && styles.menuItemTextOn]} numberOfLines={1}>
        {label}
      </Text>
      {tag ? <Text style={styles.menuTag}>{tag}</Text> : null}
    </Focusable>
  );
});

// A subtitle track as the player uses it: the server's track plus `key`, a
// stable unique id for the menu and the current selection (subTracks.ts
// buildTracks). Which one switches on by itself is subTracks.ts autoPick.
type Track = SubTrack<SubtitleTrack>;

// .pbtn — the site's circular transport button.
//
// Focus is the site's treatment, not a violet ring: `.pbtn:focus` fills the
// circle white and flips the glyph black. On a 10-foot screen a solid white disc
// among transparent ones is a stronger cue than an outline.
//
// The white fill rides on Focusable's highlightColor, which animates natively
// with no re-render. Only the ICON colour needs React state, and that is eight
// components that exist solely while the chrome is on screen — not the ~90
// cards a row holds, which is where the no-re-render rule actually matters.
const PBtn = React.forwardRef<
  View,
  {
    icon: IconName;
    label: string;
    big?: boolean;
    badge?: string;
    hasTVPreferredFocus?: boolean;
    onPress: () => void;
    onFocusChange?: (focused: boolean) => void;
    uiId?: string; // [analytics] which control this is (Focusable.uiId)
  }
>(function PlayerButton(
  {icon, label, big, badge, hasTVPreferredFocus, onPress, onFocusChange, uiId},
  ref,
) {
  const [focused, setFocused] = useState(false);
  return (
    <Focusable
      ref={ref}
      round
      ring="none"
      accessibilityLabel={label}
      hasTVPreferredFocus={hasTVPreferredFocus}
      highlightColor={colors.white}
      onFocusChange={f => {
        setFocused(f);
        onFocusChange?.(f);
      }}
      uiId={uiId}
      onPress={onPress}
      style={big ? styles.pbtnBig : styles.pbtn}>
      <Icon name={icon} size={big ? 28 : 21} color={focused ? colors.bg : colors.white} />
      {badge ? (
        <Text style={[styles.pbtnBadge, focused && styles.pbtnBadgeOn]}>{badge}</Text>
      ) : null}
    </Focusable>
  );
});

export default function Player({
  route,
  navigation,
}: NativeStackScreenProps<RootStackParamList, 'Player'>) {
  const {id, title, epTitle, stream, restart, party: partyCode, autoRun: autoRunParam} = route.params;
  const isTorrent = !!stream;
  // Decided once per player: the buffer config is part of the video source,
  // and changing it mid-film would reload the source.
  const [lowRam] = useState(isLowRam);
  // On a low-RAM box the pictures the screens behind are not drawing go from
  // memory on the way in (Fresco keeps what a view still holds); they come
  // back from the disk cache when the viewer returns.
  useEffect(() => {
    if (lowRam) clearImageMemory();
  }, [lowRam]);
  const {profileId} = useApp();
  const me = useMe(profileId);
  const videoRef = useRef<VideoRef>(null);
  // The web's `exited` flag: every async continuation checks it before touching
  // the player, so a late fetch can't setState on a screen that is gone.
  const exited = useRef(false);
  useEffect(
    () => () => {
      exited.current = true;
    },
    [],
  );

  // ---------------------------------------------------------------- state
  const [error, setError] = useState('');
  // The item request itself failed (not: the title has no file). Kept apart
  // from `error` because this one can be retried — `loadTry` re-runs the load.
  // (`retry: false` — the server REFUSED: a title a kids profile may not
  // open, one that is gone. Asking again gets the same answer, so only Back.)
  const [loadErr, setLoadErr] = useState<{title: string; detail?: string; retry?: boolean} | null>(null);
  const [loadTry, setLoadTry] = useState(0);
  // The slow-start card (see the watchdog by that name): null, 'slow' at 25s
  // with no first frame, 'big' at 90s. Declared up here because the remote
  // handler, further up than the watchdog, reads it.
  const [slowStart, setSlowStart] = useState<null | 'slow' | 'big'>(null);
  const slowSnooze = useRef(0);
  const slowMarked = useRef(false);
  const [meta, setMeta] = useState<{item: Item} | null>(null);
  // Every subtitle track known so far. Because the cues are rendered in JS
  // (rule 2) this list is NOT part of the video source, so it can grow whenever
  // a provider answers — the web's addTracks, with none of the reload hazard.
  const [subs, setSubs] = useState<SubtitleTrack[]>([]);
  const [uri, setUri] = useState<string | null>(null);
  const [usingTranscode, setUsingTranscode] = useState(false);

  const [paused, setPaused] = useState(false);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [buffering, setBuffering] = useState(true);
  // usage stats: this screen's content is on (routeTiming.ts)
  useRouteShown(!!uri && !buffering);
  const [controls, setControls] = useState(true);
  const [subKey, setSubKey] = useState<string | null>(null); // null = off
  const [cues, setCues] = useState<Cue[] | null>(null);
  // Per-track timing nudge, ported from the web's `trackOffsets`. It is PER
  // TRACK on purpose: external subtitle files are timed for whichever release
  // their uploader had — measured across eight tracks of one film, the first cue
  // landed anywhere from 0.0s to 357.0s — so a delay that fixes one track is
  // wrong for the next, and a single shared value silently followed you around.
  const [subOffsets, setSubOffsets] = useState<Record<string, number>>({});
  // Bumped by Resync to force the cue file to be fetched again.
  const [reload, setReload] = useState(0);
  const [menu, setMenu] = useState<null | 'cc' | 'speed' | 'settings' | 'party'>(null);
  // Which audio track plays (multi-dub files): the server's index, 0 = the
  // first. Rides every transcode URL as &a=; a track other than the first
  // means the transcode path even for a file that would direct-play — a
  // player cannot switch tracks inside one stream (same as the web).
  const [audioIdx, setAudioIdx] = useState(0);
  const audioIdxRef = useRef(0);
  const audioChosen = useRef(false); // the viewer picked one: the default stops applying
  const menuOpen = menu !== null;
  // The menus' ceiling on this screen (popupFit.ts): each one scrolls inside
  // it, and Android scrolls the focused row into view — nothing overflows the
  // top of a 540dp panel any more (owner, 2026-10-17).
  const {height: winH} = useTvMetrics();
  const menuH = menuMaxHeight(winH);
  const gearScroll = useRef<ScrollView>(null);
  const [rate, setRate] = useState(1);
  // Level, for the indicator and for <Video volume>. Not adjustable from here
  // — see the .vol-group comment in the transport row.
  const volume: number = 1;
  const [muted, setMuted] = useState(false);
  const [volBtnFocused, setVolBtnFocused] = useState(false);
  const [scrubFocused, setScrubFocused] = useState(false);
  // .vol-group:focus-within — the level bar is width:0 until the group has focus.
  const volOpen = volBtnFocused;
  const [prefs, setPrefs] = useState<Prefs>(PREFS_DEFAULTS);
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const [tstatus, setTstatus] = useState<{
    peers: number;
    downloadSpeed: number;
    progress: number;
  } | null>(null);
  const [seekWait, setSeekWait] = useState<{target: number; at: number} | null>(null);
  // Where a far seek is HEADED, held on the scrubber for the whole restart. The
  // web's `seekPreview`: without it the bar snapped back to the old position and
  // sat there until the new stream loaded, so the skip looked like it hadn't
  // registered and then jumped seconds later.
  const [seekPreview, setSeekPreview] = useState<number | null>(null);
  const [toastMsg, setToastMsg] = useState('');
  // The Up next card: which episode, the seconds left before it starts by
  // itself (null: nothing starts by itself), and whether this is the "Still
  // watching?" form of it (playerRules.ts planUpNext).
  const [upNext, setUpNext] = useState<{
    next: NextEp;
    countdown: number | null;
    still: boolean;
  } | null>(null);
  // Skip intro / Skip recap: inside a known range right now (the button
  // shows), and which of the two it would skip.
  const [inIntro, setInIntro] = useState(false);
  const inIntroRef = useRef(false);
  const [skipKind, setSkipKind] = useState<'intro' | 'recap'>('intro');
  const skipKindRef = useRef<'intro' | 'recap'>('intro');
  // The direct-play stall card (see the watchdog by that name).
  const [stallCard, setStallCard] = useState(false);
  // The resume card — "Resuming from 12:34" with the frame, Start over beside it.
  const [resumeCard, setResumeCard] = useState<{at: number} | null>(null);
  // The watch party this player is in, for the pill and the panel.
  const [partyInfo, setPartyInfo] = useState<Party | null>(party.current);
  // Marking an intro by hand: the start pressed, waiting for the end.
  const [markStart, setMarkStart] = useState<number | null>(null);

  // ---------------------------------------------------------------- refs
  // Live mirrors, so the async/interval closures read CURRENT values instead of
  // whatever was captured when they were created.
  const itemRef = useRef<Item | null>(null);
  const curRef = useRef(0); // CONTENT time
  const durRef = useRef(0);
  const bufRef = useRef(0); // CONTENT time of the buffered edge
  const pausedRef = useRef(false);
  const controlsRef = useRef(true);
  const bufferingRef = useRef(true);
  const everPlayed = useRef(false);
  const mountedAt = useRef(Date.now());

  // CONTENT time at which the current HLS playlist begins, and how long that
  // playlist itself is (the web's `streamOffset`). A live transcode is generated
  // forward from one starting point, so its playlist only ever spans
  // [streamOffset, transcoded edge]; seeking outside it has to re-generate the
  // transcode AT the target.
  // streamOffset NAMES the job (the /:ss/ of its URL) and is nothing more.
  // Every content <-> media conversion goes through clockBase instead: the
  // content time at media position 0 (playback/clock.ts). They are the same
  // number except on a COPY job at an offset, which keeps the source's own
  // timestamps and starts at the keyframe before ss — there the playlist
  // answer says where (X-Aurora-Base), and assuming ss put the scrubber, the
  // saved position and every subtitle cue up to a GOP ahead of the picture.
  // Direct play: 0.
  const streamOffset = useRef(0);
  const clockBase = useRef(0);
  const localDur = useRef(0);
  const usingTranscodeRef = useRef(false);
  const currentV = useRef<VCodec>('copy');
  // True while a seek is probing a new offset. Nothing may request the OLD
  // playlist during that window — the server would recreate that job and
  // supersede the one the seek is waiting for.
  const probing = useRef(false);
  const probeToken = useRef(0);
  const farSeekSeq = useRef(0);
  // Every setUri is a generation. react-native-video treats an identical source
  // string as a no-op, so a re-issue of the same playlist needs the URL to
  // change; `g` is ignored by the server (it only reads v= and seek=).
  const gen = useRef(0);
  const resumeAt = useRef(0);
  const triedH264 = useRef(false);
  const switchedToTranscode = useRef(false);
  const recoveries = useRef(0);
  const lastRecoveryAt = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seekTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingSeek = useRef<number | null>(null);
  const seekPreviewRef = useRef<number | null>(null);
  const skipStreak = useRef(0);
  const skipAccum = useRef(0);
  const skipDir = useRef(0);
  const lastSkipAt = useRef(0);
  const torrentBytes = useRef(0);
  const prefetchCtrl = useRef<AbortController | null>(null);
  const upNextShown = useRef(false);
  const rateRef = useRef(1);
  // The clock the cue layer runs on: content time, INTERPOLATED between the
  // player's 1Hz progress events. Reading curRef directly would leave cues up to
  // a second late (and a second is very visible in dialogue); raising
  // progressUpdateInterval instead would mean four native->JS events a second
  // for the whole film. Defined once — every value it reads is a ref.
  const progAt = useRef(Date.now());
  const progTime = useRef(0);
  const timeRef = useRef(() => {
    // Frozen while paused OR BUFFERING. Extrapolating through a stall is what
    // made subtitles drift after a skip: a seek is followed by seconds of
    // re-buffering during which no progress event arrives, so the clock ran on
    // while the picture stood still and the cues ended up that far ahead — and
    // stayed there until the next progress event yanked them back.
    if (pausedRef.current || bufferingRef.current) return progTime.current;
    // Belt and braces: never extrapolate more than a beat past the last real
    // anchor. Progress arrives at 1Hz, so anything beyond that is an event we
    // did not get, and guessing further only compounds the error.
    const elapsed = Math.min(1.5, Math.max(0, (Date.now() - progAt.current) / 1000));
    return progTime.current + elapsed * rateRef.current;
  });
  const advancing = useRef(false);
  // Set when /state could not be read even on retry: saving progress would
  // then overwrite a resume point we never saw. See the load effect.
  const progressReadFailed = useRef(false);
  // A NO-OP focus fallback, registered deliberately. When the chrome hides,
  // the focused control unmounts and this player has NOTHING focusable by
  // design (the remote is handled by useTVEventHandler). The global rescue in
  // focus.ts would otherwise hand focus to the topmost fallback of the FROZEN
  // screen underneath — so an OK press aimed at pause could also press
  // "My List" on the Detail page below the video. Innermost registration wins,
  // so this sink absorbs the rescue while the player is up.
  // …unless the chrome is up, in which case the scrubber takes it back: the
  // Skip intro button and the resume card unmount while focused.
  const scrubRef = useRef<{requestTVFocus?: () => void} | null>(null);
  const focusSink = useRef({
    requestTVFocus: () => {
      if (controlsRef.current) scrubRef.current?.requestTVFocus?.();
    },
  });
  useFocusFallback(focusSink);
  // Intro ranges: the household's hand-marked one wins over the detected one.
  const intro = useRef<{start: number; end: number} | null>(null);
  const autoIntro = useRef<{start: number; end: number} | null>(null);
  // "Previously on…" — only the public databases know these (a recap repeats
  // in no other episode, so the audio comparison can never find one). The
  // same button offers it, under its own name (the site's autoRecap).
  const autoRecap = useRef<Range | null>(null);
  // Bumped when a mark lands, so the ticks on the track repaint (the marks
  // themselves live in refs — the 4 Hz progress loop reads them).
  const [marksTick, setMarksTick] = useState(0);
  const creditsStart = useRef<number | null>(null);
  const introKey = useRef<string | null>(null);
  // Party: mute the events our own remote-apply causes; keep the party across
  // an Up next hand-over; land a late joiner once the clock is valid.
  const partyEcho = useRef(0);
  const keepParty = useRef(false);
  const pendingLand = useRef<PartyStateMsg | null>(null);
  // Auto-subtitles: the server was asked once for a track in the person's language.
  const subsFetched = useRef(false);
  const playTracked = useRef(false);
  // Where the start's time went, in ms since mount — sent with the
  // first-frame mark so the server's log can split a slow start into "the
  // app was still asking the server about the title" (meta) and "the source
  // was handed to the player" (armed); what is left up to the first frame is
  // ExoPlayer opening the source and filling its start buffer.
  const startMs = useRef<{meta: number; armed: number}>({meta: 0, armed: 0});
  // A direct-play source opened AT the resume point (tuning.resumeAtSource):
  // the uri it applies to, and where. Any other uri starts where it always did.
  const startAt = useRef<{uri: string; ms: number} | null>(null);
  // uri, mirrored for callbacks that fire before ANY source is armed: a skip
  // pressed on the loading screen must not cancel the arming probe (see skip).
  const uriRef = useRef<string | null>(null);
  // prefs, mirrored for callbacks that must not run side effects inside a
  // setState updater (savePrefs there could persist a render React discarded).
  const prefsRef = useRef<Prefs>(PREFS_DEFAULTS);
  const pauseBtnRef = useRef<any>(null);
  // the control-row buttons that open a menu, and which of them opened this one
  const ccBtnRef = useRef<any>(null);
  const speedBtnRef = useRef<any>(null);
  const partyBtnRef = useRef<any>(null);
  const gearBtnRef = useRef<any>(null);
  const menuOpener = useRef<React.RefObject<any> | null>(null);
  // Which part of the chrome holds focus. The web decides whether left/right
  // seeks by asking whether the focused element is inside .player-controls or a
  // menu; there is no DOM to ask here, so each focusable claims its zone. Only
  // the gaining element writes (something is always focused while the chrome is
  // up), so no blur/focus ordering race can leave this stale.
  const zone = useRef<'scrub' | 'row' | 'menu' | 'top' | 'skip' | 'card' | null>(null);
  const markZone = useCallback(
    (z: 'scrub' | 'row' | 'menu' | 'top' | 'skip' | 'card') => (focused: boolean) => {
      if (focused) zone.current = z;
    },
    [],
  );

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);
  useEffect(() => {
    controlsRef.current = controls;
  }, [controls]);
  useEffect(() => {
    bufferingRef.current = buffering;
  }, [buffering]);
  useEffect(() => {
    seekPreviewRef.current = seekPreview;
  }, [seekPreview]);
  useEffect(() => {
    itemRef.current = meta?.item || null;
  }, [meta]);
  useEffect(() => {
    rateRef.current = rate;
  }, [rate]);
  useEffect(() => {
    uriRef.current = uri;
  }, [uri]);
  useEffect(
    () => () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (seekTimer.current) clearTimeout(seekTimer.current);
      if (toastTimer.current) clearTimeout(toastTimer.current);
      if (countdownTimer.current) clearInterval(countdownTimer.current);
      prefetchCtrl.current?.abort();
    },
    [],
  );

  // The web leans on toast() for everything it wants to tell the viewer while
  // the film keeps playing ("Resuming from 42:10", "Stream ended early —
  // recovering…"). Without it those moments were silent here, which is what made
  // a recovering stream look like a broken one.
  const toast = useCallback((msg: string) => {
    setToastMsg(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(''), 4200);
  }, []);

  useEffect(() => {
    loadPrefs().then(p => {
      prefsRef.current = p;
      setPrefs(p);
      setPrefsLoaded(true);
    });
    // A setting that follows the person, changed on another device while this
    // plays (personSync.ts): it applies from here on.
    const off = onPersonPrefs(person => {
      const next = {...prefsRef.current, ...person};
      prefsRef.current = next;
      setPrefs(next);
    });
    // The profile's remembered dub and subtitle pick (navSection's record):
    // asked for again when the copy is over five minutes old, so a choice made
    // on the site is known here. Not waited for — the copy already held is
    // what arming and the subtitle auto-pick read if this is still in flight.
    loadMe(profileId, 5 * 60000);
    return off;
  }, [profileId]);

  // ---------------------------------------------------------------- chrome
  const showControls = useCallback(() => {
    // Scrubber state is frozen while the controls are hidden (see onProgress),
    // so refresh it from the live refs before revealing.
    if (pendingSeek.current == null && seekPreviewRef.current == null) {
      setCurrent(curRef.current);
    }
    setBuffered(bufRef.current);
    setDuration(durRef.current); // it grows with the playlist while hidden
    setControls(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      // The web's hideControls: never while a menu is open, and never while
      // paused — a paused player with no chrome is just a frozen frame.
      if (menuOpen || pausedRef.current || upNext) return;
      setControls(false);
    }, HIDE_MS);
  }, [menuOpen, upNext]);
  useEffect(() => {
    showControls();
  }, [showControls]);

  // The site flashes a big play/pause glyph in the middle of the picture on every
  // toggle (.player-flash). It's the confirmation that the keypress landed, which
  // matters more on a remote than on a mouse.
  const flashAnim = useRef(new Animated.Value(0)).current;
  const [flashPaused, setFlashPaused] = useState(false);
  // What the PERSON did goes to the party; what the party made us do does not.
  const partyUser = useCallback((playing: boolean) => {
    if (!party.current || Date.now() < partyEcho.current) return;
    sendPartyState(playing, curRef.current, playing ? 'play' : 'pause');
  }, []);
  const togglePlay = useCallback(() => {
    const next = !pausedRef.current;
    setPaused(next);
    partyUser(!next);
    setFlashPaused(next);
    flashAnim.setValue(0);
    Animated.timing(flashAnim, {
      toValue: 1,
      duration: 500,
      useNativeDriver: true,
      isInteraction: false,
    }).start();
    showControls();
  }, [flashAnim, showControls, partyUser]);

  // Closing a menu puts focus back on the button that opened it (found on the
  // Mi TV, 2026-10-08: it fell on Rewind, the first button, so the next OK
  // jumped the film back ten seconds). Asked for twice: once now, and once
  // after the panel has really left - while it is still mounted its focus
  // trap wins and Android then picks the row's first button by itself.
  const closeMenu = useCallback(() => {
    setMenu(null);
    showControls();
    const back = () => (menuOpener.current?.current || pauseBtnRef.current)?.requestTVFocus?.();
    setTimeout(back, 0);
    setTimeout(back, 180);
  }, [showControls]);

  const dismissUpNext = useCallback(() => {
    if (countdownTimer.current) clearInterval(countdownTimer.current);
    countdownTimer.current = null;
    setUpNext(null);
    showControls();
    setTimeout(() => pauseBtnRef.current?.requestTVFocus?.(), 0);
  }, [showControls]);

  // If another screen ever lands on top of this one (a stray navigation),
  // don't keep playing invisibly underneath it.
  useEffect(() => navigation.addListener('blur', () => setPaused(true)), [navigation]);

  // ------------------------------------------------------- transcode plumbing
  // Make the server download the bytes around `targetSec` BEFORE seeking there.
  // A torrent file is sparse while downloading: ExoPlayer's Range request into a
  // hole stalls until pieces trickle in, hitting its short HTTP timeouts. A Range
  // fetch at the estimated byte re-anchors WebTorrent's piece priorities and
  // resolves only once those bytes truly exist — then the real seek lands on
  // data. (The web's prefetchRegion, same mechanism.)
  const prefetchRegion = useCallback(
    async (targetSec: number) => {
      if (!stream || !durRef.current) return;
      const url = assetUrl(stream.videoUrl) as string;
      prefetchCtrl.current?.abort(); // a newer seek supersedes the old wait
      const ctrl = new AbortController();
      prefetchCtrl.current = ctrl;
      const timer = setTimeout(() => ctrl.abort(), 60000);
      try {
        if (!torrentBytes.current) {
          const head = await fetch(url, {
            headers: {Range: 'bytes=0-1', ...mediaHeaders()},
            signal: ctrl.signal,
          });
          const cr = head.headers.get('Content-Range') || '';
          torrentBytes.current = parseInt(cr.split('/')[1], 10) || 0;
        }
        if (!torrentBytes.current) return;
        // Linear time->byte estimate is plenty for a prefetch hint.
        const byte = Math.max(
          0,
          Math.min(
            torrentBytes.current - 1,
            Math.floor((targetSec / durRef.current) * torrentBytes.current),
          ),
        );
        const end = Math.min(torrentBytes.current - 1, byte + 2 * 1024 * 1024);
        const res = await fetch(url, {
          headers: {Range: `bytes=${byte}-${end}`, ...mediaHeaders()},
          signal: ctrl.signal,
        });
        await res.arrayBuffer(); // resolves only once those bytes exist on disk
      } catch {
        // aborted (superseded seek) or timed out — seek anyway, ExoPlayer retries
      } finally {
        clearTimeout(timer);
      }
    },
    [stream],
  );

  const transcodeUrl = useCallback(
    (base: string, ss: number, v: VCodec) =>
      `${assetUrl(base)}/${Math.max(0, Math.floor(ss || 0))}/index.m3u8?v=${v}${
        audioIdxRef.current > 0 ? `&a=${audioIdxRef.current}` : ''
      }`,
    [],
  );

  // THE SERVER IS BUSY (503 + Retry-After: no room in its encoder budget —
  // server 1.6.93). The claim below is the one request of a start whose answer
  // this code sees (ExoPlayer's own read of the playlist reports only "Source
  // error"), so it is the claim that is watched: on 503 it waits what the
  // server says (5 s at most) and asks again, three times at most
  // (serverManners.ts whenRoom), with the loading state on screen. While the
  // claim for the CURRENT source is in flight or waiting, a player error
  // before anything has played is not run through the codec ladder (onError):
  // a busy server refuses the player's playlist read too, and the ladder's
  // answer to that — a heavier encode — is the wrong one. When there is room
  // the source is handed over again if the player had given up on it; when
  // there is none after the last try, ONE message with Try again / Back.
  // The player is handed its source at once, as before: a start on a server
  // with room is not a round trip slower for any of this.
  const claimGen = useRef(0); // the source generation whose claim is pending (0 = none)
  const claimSwallowed = useRef(0); // …and the generation a player error was held back for
  // `handOver`: the claim goes FIRST (serverManners.ts claimFirst — an encode
  // that has not played yet): the player is handed its source only once the
  // server has said there is room, so ExoPlayer never meets the refusal.
  // `onClock`: the claim's answer is the job's playlist, and on a copy job at
  // an offset it carries the job's real clock (X-Aurora-Base — see clockBase).
  // On a handed-over start it lands BEFORE the player gets the source, so the
  // first frame is already on the job's own clock.
  const claimStream = useCallback((url: string, g: number, handOver = false, onClock?: (c: Clock | null) => void) => {
    claimGen.current = g;
    const alive = () => !exited.current && gen.current === g;
    whenRoom(
      async () => {
        // bounded, like the far-seek probe: a claim that never settled would
        // hold errors back for ever
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 45000);
        try {
          const res = await fetch(`${url}&seek=1`, {headers: mediaHeaders(), signal: ctrl.signal});
          if (res.ok && onClock && alive()) onClock(clockFromHeaders(h => res.headers.get(h)));
          return {status: res.status, retryAfter: res.headers.get('retry-after')};
        } finally {
          clearTimeout(t);
        }
      },
      {
        sleep,
        alive,
        onWait: (ms, n) => {
          console.log(`[player] the server is busy: asking again in ${ms} ms (${n}/3)`);
          // an error the player raised a moment before this answer may have
          // armed the stuck-playlist retry: this wait owns the start now
          if (retryTimer.current) clearTimeout(retryTimer.current);
          retryTimer.current = null;
          recoveries.current = 0;
          setBuffering(true);
        },
      },
    ).then(out => {
      if (claimGen.current === g) claimGen.current = 0;
      if (out.kind === 'gone' || !alive()) return;
      if (handOver) {
        const next = afterClaim(out);
        if (next === 'busy') {
          console.log('[player] the server is still busy: giving up on this start');
          setBuffering(false);
          setError(SERVER_BUSY);
        } else if (next === 'play') {
          setUri(`${url}&g=${g}`);
        }
        return;
      }
      const swallowed = claimSwallowed.current === g;
      if (out.kind === 'busy') {
        if (everPlayed.current) return; // the player got in by itself meanwhile
        console.log('[player] the server is still busy: giving up on this start');
        setBuffering(false);
        setError(SERVER_BUSY);
        return;
      }
      // Room (or an answer that is not "busy", or the claim itself failed):
      // if the player's error was held back, the source is handed over once
      // more — with no claim pending, whatever it says next is judged as
      // always.
      if (swallowed && !everPlayed.current) setUri(`${url}&g=${++gen.current}`);
    });
  }, []);

  // The web's startTranscode. `claim` fires the &seek=1 request that tells the
  // server the VIEWER chose this position — the only kind of request allowed to
  // retire the job still running at the previous offset. Without it the old
  // ffmpeg keeps its slot and the next seek is answered with "busy
  // transcoding". ExoPlayer is handed the URL WITHOUT the flag, exactly as
  // hls.js is.
  //
  // `clock`: the job's published clock when the caller already has it (the
  // far-seek probe WAS the claim). Unclaimed here, the claim's own answer
  // brings it a moment later; until then the clock is the offset, which is
  // exact for every encode and for ss = 0, and at most a GOP early for a copy.
  const startTranscode = useCallback(
    (base: string, offset: number, v: VCodec, claim = true, clock: Clock | null = null) => {
      const ss = Math.max(0, Math.floor(offset || 0));
      streamOffset.current = ss;
      clockBase.current = clockBaseFor(ss, v, clock);
      localDur.current = 0;
      usingTranscodeRef.current = true;
      currentV.current = v;
      resumeAt.current = 0; // baked into the offset: never seek to it as well
      curRef.current = ss;
      bufRef.current = ss;
      progTime.current = ss;
      progAt.current = Date.now();
      setUsingTranscode(true);
      setCurrent(ss);
      setBuffering(true);
      const url = transcodeUrl(base, ss, v);
      const g = ++gen.current;
      // an encode that has not played yet asks first and is handed over by
      // the claim (claimFirst); anything else goes to the player at once
      const first = claim && claimFirst(v, everPlayed.current);
      if (claim) {
        claimStream(url, g, first, c => {
          // still this job (the generation check is claimStream's alive())
          const b = clockBaseFor(ss, v, c);
          if (b !== clockBase.current) {
            console.log(`[player] copy job at ${ss}: its clock starts at ${b.toFixed(2)}`);
            clockBase.current = b;
          }
        });
      }
      if (!first) setUri(`${url}&g=${g}`);
    },
    [transcodeUrl, claimStream],
  );

  // Restart the transcode at an absolute content time — but PROBE the playlist
  // first, so a point the server can't serve yet (bytes not downloaded, or a
  // busy concurrency cap) leaves current playback untouched instead of killing
  // it. Resolves true if playback was switched, false if the point isn't ready.
  const startTranscodeAt = useCallback(
    async (
      base: string,
      target: number,
      v: VCodec,
      {fallbackToZero = false}: {fallbackToZero?: boolean} = {},
    ): Promise<boolean> => {
      const ss = Math.max(0, Math.floor(target) - 2);
      const token = ++probeToken.current;
      setBuffering(true);
      probing.current = true;
      setSeekWait({target, at: Date.now()});
      // Bounded: while a probe is in flight, probing=true disables BOTH the
      // stall watchdog and the transcode keepalive — a probe that never settled
      // wedged the player in "Fetching that part…" with every recovery
      // mechanism switched off. prefetchRegion already aborts this way.
      // (Each ask has its own 45 s. A busy server — 503 + Retry-After — is
      // waited for and asked again, three times at most, the loading state
      // staying up: serverManners.ts whenRoom.)
      const alive = () => !exited.current && token === probeToken.current;
      let clock: Clock | null = null; // the job's published clock (see clockBase)
      try {
        const out = await whenRoom(
          async () => {
            const ctrl = new AbortController();
            const probeTimer = setTimeout(() => ctrl.abort(), 45000);
            try {
              const res = await fetch(`${transcodeUrl(base, ss, v)}&seek=1`, {
                headers: mediaHeaders(),
                signal: ctrl.signal,
              });
              if (res.ok) clock = clockFromHeaders(h => res.headers.get(h));
              return {status: res.status, retryAfter: res.headers.get('retry-after')};
            } finally {
              clearTimeout(probeTimer);
            }
          },
          {
            sleep,
            alive,
            onWait: (ms, n) => console.log(`[player] the server is busy: asking again in ${ms} ms (${n}/3)`),
          },
        );
        if (out.kind === 'gone' || !alive()) return true;
        if (out.kind === 'busy') {
          // No room after the last try. Something is playing: it stays, and
          // the viewer is told. Nothing has played yet: one message with
          // Try again / Back — never the same request in a loop, and not the
          // start of the film instead of the point that was asked for.
          console.log('[player] the server is still busy: this point is not started');
          if (everPlayed.current) {
            toast('The server is busy — try again in a moment');
            return false;
          }
          setError(SERVER_BUSY);
          return true;
        }
        if (out.kind !== 'answered' || out.status < 200 || out.status > 299) throw new Error('not ready');
        startTranscode(base, ss, v, false, clock); // the probe already claimed it
        return true;
      } catch {
        if (!alive()) return true;
        if (fallbackToZero) {
          startTranscode(base, 0, v, false);
          return true;
        }
        return false;
      } finally {
        if (token === probeToken.current) {
          probing.current = false;
          setSeekWait(null);
        }
      }
    },
    [startTranscode, transcodeUrl, toast],
  );

  // Another dub (elia, 2026-10-07: "users can't change the dub"): the stream
  // restarts at the current second with that track mapped in, server-side.
  const switchAudio = useCallback(
    (idx: number, label: string) => {
      if (idx === audioIdxRef.current) return;
      const base = itemRef.current?.transcodeBase || stream?.transcodeBase;
      if (!base) return;
      track('feat', {f: 'audio_track'}); // the site's name for the same thing
      audioChosen.current = true;
      audioIdxRef.current = idx;
      setAudioIdx(idx);
      toast(`Audio: ${label}`);
      // The language follows the profile to the next title, here and on the
      // site (its rememberPick("audioLang")). A track with no language tag has
      // nothing to carry over, so what was remembered before stays. Hebrew,
      // English and Russian are stored as "he" / "en" / "ru" whatever the file
      // called them; any other dub as its own tag (lang.ts audioPick).
      const lang = audioPick((itemRef.current?.audioTracks || []).find(t => t.index === idx)?.language);
      if (lang) rememberPick(profileId, 'audioLang', lang);
      startTranscodeAt(base, curRef.current, 'copy', {fallbackToZero: true});
    },
    [startTranscodeAt, stream, profileId, toast],
  );

  // Merge newly-arrived tracks, de-duplicated by URL — the same file offered by
  // two providers is noise, not a choice. (The web's addTracks does this with a
  // Set over the <track> srcs.)
  const addSubs = useCallback((incoming: SubtitleTrack[]) => {
    if (!incoming?.length) return;
    setSubs(prev => {
      const have = new Set(prev.map(t => t.url));
      const add = incoming.filter(t => t?.url && !have.has(t.url));
      return add.length ? [...prev, ...add] : prev;
    });
  }, []);

  // ---------------------------------------------------------------- load
  // Resolve the item and the resume point. Subtitles are fetched alongside and
  // simply appear when they land; they never gate playback.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        // The saved position is read here — and the 5s save loop later WRITES
        // over it. A transient failure used to be swallowed into "no progress",
        // so playback started at 0:00 and five seconds later the real resume
        // point (an hour into a film) was overwritten with ~5s. Retry once;
        // if the history genuinely can't be read, refuse to write over it.
        // The item is asked for NOW, beside the history: neither needs the
        // other's answer, and one after the other was a round trip of black
        // screen on every start (a fifth of a second and more on a far server).
        const itemP = stream ? null : api.item(id, profileId);
        itemP?.catch(() => {}); // (its failure is reported where it is awaited, below)
        refreshTuning(); // for this start if it answers in time, else the next
        // The title page read this profile's history a moment ago, to draw
        // Play / Resume: that answer is the one the viewer just acted on.
        // Asking again only made the start wait. Anything older than half a
        // minute — or written to since (saveProgress forgets it) — is read
        // again, as always.
        let st: ProfileState | null = api.stateIfFresh(profileId, 30000);
        if (!st) {
          try {
            st = await api.state(profileId);
          } catch {}
        }
        if (!st && live) {
          await sleep(1000);
          try {
            st = await api.state(profileId);
          } catch {}
        }
        if (!live) return;
        if (!st) {
          progressReadFailed.current = true;
          toast("Couldn't read your watch history — resume and progress saving are off");
          st = {progress: {}} as ProfileState;
        }

        if (stream) {
          // openItem/Sources compose an episode's nav title as "Show · S2 E10",
          // but the site puts the SHOW on the heading and the episode on the line
          // beneath — so split it back apart. Without this the two lines read
          // "Silo · S2 E10" and "S2 E10 · Silo · S2 E10".
          const ep = /^(.*?)\s+·\s+S\d+\s*E\d+$/.exec(title);
          // Synthetic item, so everything downstream (transcode fallback, the
          // scrubber's total, showId=none) works uniformly.
          const it = {
            id: stream.id,
            type: stream.type,
            title: ep ? '' : title,
            showTitle: ep ? ep[1] : undefined,
            transcodeBase: stream.transcodeBase,
            // The title's real runtime. ExoPlayer cannot derive a duration for a
            // file that is still downloading, which left the bar dead and had the
            // Streamer stamp a LIVE chip on the picture; the web floors its
            // scrubber on this exact value for the same reason.
            duration: stream.duration,
            season: stream.season,
            episode: stream.episode,
            year: stream.year ?? undefined,
          } as Item;
          // Where it resumes (episodeRules.ts resumePoint — the site's rule:
          // past ten seconds, not in the last twenty, four seconds early).
          const at = restart ? null : resumePoint(st.progress?.[id], it.duration);
          if (at != null) resumeAt.current = at;
          durRef.current = it.duration || 0;
          setDuration(it.duration || 0);
          setMeta({item: it});
          // OpenSubtitles (Hebrew/English), fire-and-forget: they appear in the
          // menu the moment they resolve, which is what the web does.
          if (stream.imdbId) {
            api
              .torrentSubtitles(
                // The web's rule: the presence of a season+episode decides this,
                // NOT `type`. A Continue Watching play-item stored by the browser
                // carries type:"movie" even for an episode, and asking the movie
                // endpoint for an episode's IMDb id returns nothing at all —
                // measured on Silo S2E10: movie 0 tracks, series 11.
                stream.season && stream.episode ? 'series' : 'movie',
                stream.imdbId,
                stream.season,
                stream.episode,
                stream.release,
              )
              .then(r => live && addSubs(r.subtitles || []))
              .catch(() => {});
          }
        } else {
          const it = await (itemP as Promise<Item>);
          if (!live) return;
          if (!it.videoUrl && !it.transcodeBase) {
            setError(NO_FILE);
            return;
          }
          // `restart` (Detail's "Start over") means ignore the saved position.
          const at = restart ? null : resumePoint(st.progress?.[id], it.duration);
          if (at != null) resumeAt.current = at;
          durRef.current = it.duration || 0;
          setDuration(it.duration || 0);
          startMs.current.meta = Date.now() - mountedAt.current;
          setMeta({item: it});
          addSubs(it.subtitles || []);
        }
      } catch (e) {
        if (!live) return;
        // Status 0 is the client's own verdict — no answer, or none in time
        // (api.ts request()) — so the line is to blame, not the title. Anything
        // else carries the server's own message, which is written for viewers.
        const unreachable = !(e instanceof ApiError) || e.status === 0;
        // A refusal (403: over a kids profile's limit; 404: the title is
        // gone) is final — the server's own words, and no Retry to press.
        const refused = e instanceof ApiError && (e.status === 403 || e.status === 404);
        setLoadErr(
          unreachable
            ? {title: "Couldn't reach the server", detail: e instanceof ApiError ? e.message : undefined}
            : refused
              ? {title: (e as Error).message || "This title can't be opened", retry: false}
              : {title: "Couldn't load this title", detail: (e as Error).message},
        );
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, profileId, restart, loadTry]);

  // ------------------------------------------- torrent kick + ready-gate
  // See rule 3 at the top. Nothing on the server adds the torrent until a stream
  // request arrives (on the web the <video> element's own request does this), so
  // a tiny ranged GET both starts peer discovery AND is the honest answer to "can
  // this be streamed": it completes with 2 bytes once piece 0 exists.
  const [gateOpen, setGateOpen] = useState(!stream);
  useEffect(() => {
    if (!stream) return;
    let live = true;
    let done = false;
    const startedAt = Date.now();
    const open = (why: string) => {
      if (done || !live) return;
      done = true;
      console.log(`[player] torrent ready-gate opened (${why})`);
      setGateOpen(true);
    };

    const kickUrl = assetUrl(stream.videoUrl) as string;
    fetch(kickUrl, {headers: {Range: 'bytes=0-1', ...mediaHeaders()}})
      .then(r => {
        // 206 (or a 200 from a server ignoring the range) means bytes are really
        // flowing — the same thing the browser's <video> waits for.
        if (r.ok || r.status === 206) open('bytes');
      })
      .catch(() => {});

    // Absolute fallback, armed INDEPENDENTLY of the poll. It used to sit after
    // the poll's await — so a status endpoint that accepted the connection and
    // never answered parked every tick before the check, and the gate never
    // opened at all. The web never gates; a late handoff is always better than
    // a screen that never plays.
    const absTimer = setTimeout(() => open('timeout'), 45000);

    let inFlight = false; // never stack a second request behind a hung one
    const poll = setInterval(async () => {
      if (!live || inFlight) return;
      inFlight = true;
      try {
        const s = await api.torrentStatus(stream.infoHash);
        if (!live) return;
        // Swarm status is only visible pre-handoff and during rebuffers; when
        // playback is running smoothly, updating it every couple of seconds just
        // re-rendered the player for an overlay that isn't on screen.
        if (!done || bufferingRef.current) {
          setTstatus({peers: s.peers, downloadSpeed: s.downloadSpeed, progress: s.progress});
        }
        // Subtitle files that live INSIDE the torrent, offered as soon as the
        // torrent has metadata.
        if (s.subtitles?.length) addSubs(s.subtitles);
        // `peers > 0` alone was the Continue Watching bug: a torrent the server
        // already has in full reports zero peers and would never open the gate.
        if (s.ready && (s.peers > 0 || s.progress > 0)) open('ready+data');
        // Metadata but nothing else after 20s — hand it over and let ExoPlayer's
        // (generous) retry budget do the waiting instead of this loop.
        else if (s.ready && Date.now() - startedAt > 20000) open('ready+timeout');
      } catch {
      } finally {
        inFlight = false;
      }
    }, 1500);

    return () => {
      live = false;
      clearTimeout(absTimer);
      clearInterval(poll);
    };
  }, [stream, addSubs]);

  // ---------------------------------------------------------------- arming
  // The one place a first URI is chosen. Mirrors player.js's source-selection
  // ladder (lines 397-433).
  const armRef = useRef(false);
  useEffect(() => {
    if (armRef.current || !meta || !gateOpen) return;
    armRef.current = true;
    const it = meta.item;
    const base = it.transcodeBase;
    const r = resumeAt.current;
    // The original language first: a multi-dub file starts on the track the
    // server marked `original`, not on whichever the release listed first.
    // …unless this viewer chose a dub last time: the language they picked in
    // the AUDIO menu (here or on the site — the profile's `audioLang`) wins on
    // every title that has it. The site's rule, to the letter.
    if (!audioChosen.current) {
      const list = it.audioTracks || [];
      const liked = profilePick(profileId, 'audioLang');
      // Compared as a LANGUAGE, not as a string: "he" remembered on one file
      // is the "heb" track of the next.
      const mine = liked ? list.find(t => sameAudio(t.language, liked)) : undefined;
      const pick = mine || list.find(t => t.original);
      if (list.length > 1) console.log('[prefs] audio: remembered', liked, '→ track', pick ? pick.index : 0, mine ? '(remembered)' : '(original)');
      if (pick && pick.index > 0) {
        audioIdxRef.current = pick.index;
        setAudioIdx(pick.index);
      }
    }
    if (stream) {
      // A source the server tagged DTS / TrueHD / Atmos / DD+ / H.265 will not
      // play as-is on this hardware, so hand ExoPlayer the remux rather than
      // letting it walk into a passthrough AudioTrack failure and recover from
      // it. Same call the browser client makes up front, and resume is baked
      // into the offset exactly as the web does it (the server reads the torrent
      // through its blocking Range route, so any offset works at swarm speed).
      if (stream.needsTranscode && base) {
        if (r > 0) {
          prefetchRegion(r); // fire-and-forget warm-up
          startTranscodeAt(base, r, stream.transcodeV || 'copy', {fallbackToZero: true});
        } else {
          startTranscode(base, 0, stream.transcodeV || 'copy');
        }
      } else {
        // Direct play. The resume point is applied as a native seek in onLoad,
        // routed through commitSeek so a sparse torrent's bytes are fetched
        // first (see prefetchRegion).
        setUri(assetUrl(stream.videoUrl) as string);
      }
    } else if (base && ((it.audio && it.audio.compatible === false) || !it.videoUrl || audioIdxRef.current > 0)) {
      // The scanner already knows whether this file's audio is playable, and the
      // browser client acts on that same flag. Walking into it instead meant
      // ExoPlayer tried to PASSTHROUGH 6-channel E-AC3 to the HDMI sink, the
      // device refused to open the AudioTrack, and after seven retries the whole
      // renderer threw — which is what "playback is broken" looked like from the
      // sofa. v=copy is the cheap remux: video copied, audio re-encoded to AAC.
      //
      // The resume point goes into the OFFSET, not a later seek. A live playlist
      // only spans [offset, transcoded edge], so starting at 0 and seeking meant
      // waiting for ffmpeg to reach the resume point — which is what made
      // resuming a remuxed file sit and buffer. (The server used to upgrade
      // copy->h264 for any non-zero start; it no longer does: an offset copy
      // keeps the source's timestamps and starts at the keyframe before the
      // offset, and its playlist answer says where — see clockBase.)
      //
      // No videoUrl at all (never seen in practice, but the gate above only
      // rejects an item with NEITHER) means the transcode is the only route, and
      // a copy can't be assumed to help.
      startTranscode(base, r, it.videoUrl ? 'copy' : 'h264');
    } else {
      const direct = assetUrl(it.videoUrl) as string;
      // The file itself, opened AT the resume point when the server's tuning
      // asks for it (tuning.ts resumeAtSource): the source carries the
      // position, so ExoPlayer's first read is where the film continues —
      // not the top of the file, then a seek. onLoad finds nothing left to
      // seek to. Off unless tuned on: it is the device that has to say this
      // is better.
      if (r > 0 && tuning().resumeAtSource) {
        startAt.current = {uri: direct, ms: Math.round(r * 1000)};
        resumeAt.current = 0;
        curRef.current = r;
        bufRef.current = r;
        progTime.current = r;
        progAt.current = Date.now();
        setCurrent(r);
      }
      setUri(direct);
    }
    startMs.current.armed = Date.now() - mountedAt.current;
    if (r > 0) {
      // A library file has a frame to show (/img/frame); a stream has no file
      // to pull one from, so it keeps the toast — the site's resume card.
      if (stream) toast(`Resuming from ${fmt(r)}`);
      else {
        setResumeCard({at: r});
        // toned down (elia): four seconds, and a smaller, dimmer card (see styles.resumeCard)
        setTimeout(() => !exited.current && setResumeCard(null), 4000);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, gateOpen]);

  // ---------------------------------------------------------------- skip intro
  // The hand-marked range per show (/api/intro) and the server's detection per
  // episode (/api/intro/auto): the button appears inside the range, Up next at
  // the detected credits. A detected intro the household said was wrong stays
  // ignored on this TV.
  useEffect(() => {
    if (!meta) return;
    const it = meta.item;
    const key = !stream && it.showId ? `show:${it.showId}` : stream?.season && stream.imdbId ? `imdb:${stream.imdbId}` : null;
    introKey.current = key;
    let live = true;
    if (key) {
      api
        .intro(key)
        .then(r => {
          if (live && r && isFinite(Number(r.start)) && isFinite(Number(r.end)) && Number(r.end) > Number(r.start)) {
            intro.current = {start: Number(r.start), end: Number(r.end)};
            setMarksTick(t => t + 1);
          }
        })
        .catch(() => {});
    }
    // One shape from both doors (the site's applyAutoSegments): a library
    // episode asks by file id — its own detection first, the public databases
    // under it; a STREAMED episode has no file to analyse and asks by
    // identity (/api/segments) — which is what gives streams a Skip intro, a
    // Skip recap and an Up next timed to the credits. They had none here.
    const streamedEp = !!(stream && stream.imdbId && stream.season && stream.episode);
    const ask =
      !stream && it.showId
        ? api.introAuto(id)
        : streamedEp
          ? api.segments({imdbId: stream!.imdbId as string, season: stream!.season, episode: stream!.episode, duration: it.duration || 0})
          : null;
    if (ask) {
      Promise.all([ask, loadIgnoredIntros()])
        .then(([r, ignored]) => {
          if (!live || !r) return;
          const off = !!key && ignored.includes(key); // "ignore the detected intro" covers both
          const i = rangeOf(r.intro);
          const rc = rangeOf(r.recap);
          if (i && !off) autoIntro.current = i;
          if (rc && !off) autoRecap.current = rc;
          if (r.credits && isFinite(r.credits.start)) creditsStart.current = r.credits.start;
          setMarksTick(t => t + 1);
        })
        .catch(() => {});
    }
    return () => {
      live = false;
    };
  }, [meta, stream, id]);
  const activeIntro = () => intro.current || autoIntro.current;
  const skipIntro = useCallback(() => {
    // what the button would skip right now: the recap while inside it, else
    // the intro (playerRules.ts skippableAt — the site's skippableNow)
    const seg = skippableAt(curRef.current, {recap: autoRecap.current, intro: activeIntro()});
    if (!seg) return;
    inIntroRef.current = false;
    setInIntro(false);
    track('feat', {f: seg.kind === 'recap' ? 'skip_recap' : 'skip_intro'});
    seekTo(seg.range.end);
    showControls();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- auto-subtitles
  // The viewer asked for a language and this file has no track in it: the
  // server fetches one from the providers and writes it next to the file, for
  // everyone; it switches on here the moment it lands (the site's behaviour).
  useEffect(() => {
    if (stream || !meta || !prefsLoaded || subsFetched.current || !prefs.subsDefault) return;
    const want = langCode(prefs.subLang); // "any" asks for nothing
    if (!want) return;
    // Told by lang.ts, the rule the auto pick uses — a sidecar labelled
    // "HEB" or a torrent's "Movie.2020.heb" IS Hebrew (the old regexes here
    // only knew "hebrew" / "עבר" and asked the server for a track the file
    // already had).
    if (hasLang(meta.item.subtitles, want)) return;
    subsFetched.current = true;
    console.log(`[player] no ${want} subtitles on disk — asking the server`);
    api
      .subtitlesFetch(id, want)
      .then(r => {
        console.log(`[player] subtitle fetch: ${r?.tracks?.length || 0} track(s)`);
        if (exited.current || !r?.tracks?.length) return;
        // tagged with the language asked for, so the auto pick (which waits
        // for it: autoPick upgradeTo) knows it when it lands
        addSubs(r.tracks.map(t => ({...t, lang: t.lang || want})));
      })
      .catch(e => console.log('[player] subtitle fetch failed:', (e as Error).message));
  }, [stream, meta, prefsLoaded, prefs.subsDefault, prefs.subLang, id, addSubs]);

  // ---------------------------------------------------------------- watch party
  useEffect(() => {
    setPlayingContext({id, title});
    return () => setPlayingContext(null);
  }, [id, title]);
  // While a film plays, a library change re-reads nothing behind it (the
  // title page under the player used to re-read its library copy on every
  // message): realtime.ts holds the news and tells the screens once, after
  // the player is left. And on leaving — or going on to the next episode,
  // which is a new player — the server is told it may stop what it was
  // preparing for this viewer (api.playBye — the jit producers and the
  // offset transcode of a library title; api.torrentBye for a torrent).
  useEffect(() => {
    const why = `player:${mountedAt.current}`;
    holdLibraryRefresh(why, true);
    return () => {
      holdLibraryRefresh(why, false);
      // (a torrent: its own goodbye, for the transcode it may be playing)
      if (!isTorrent) api.playBye(id).catch(() => {});
      else if (stream?.infoHash) api.torrentBye(stream.infoHash, stream.fileIdx).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, isTorrent]);
  const partySnapshot = useCallback((): PartyItem => {
    const it = itemRef.current;
    if (stream) return {...(streamMeta() || {}), id: stream.id, cover: stream.cover ?? null, backdrop: stream.backdrop ?? null} as PartyItem;
    return {
      id,
      title: it?.title || title,
      showTitle: it?.showTitle,
      season: it?.season,
      episode: it?.episode,
      cover: it?.cover ?? null,
      type: it?.type,
    };
  }, [stream, id, title]); // eslint-disable-line react-hooks/exhaustive-deps
  const applyPartyState = useCallback(
    (st: PartyStateMsg, announce: boolean) => {
      partyEcho.current = Date.now() + 1500;
      const elapsed = st.playing && st.now && st.at ? Math.max(0, st.now - st.at) / 1000 : 0;
      const target = (st.position || 0) + elapsed;
      // A transcoded / torrent stream restarts its pipeline on a seek, so it
      // tolerates more drift on the periodic sync (the site's numbers).
      const heavy = usingTranscodeRef.current || isTorrent;
      const drift = curRef.current - target;
      const tol = st.kind === 'sync' ? (heavy ? 8 : 2.5) : heavy ? 3 : 1.2;
      if (Math.abs(drift) > tol && uriRef.current) seekTo(target);
      if (st.playing && pausedRef.current) setPaused(false);
      else if (!st.playing && !pausedRef.current) setPaused(true);
      if (announce && st.by && st.kind !== 'sync') {
        toast(st.kind === 'pause' ? `${st.by} paused` : st.kind === 'play' ? `${st.by} pressed play` : `${st.by} jumped to ${fmt(target)}`);
      }
    },
    [isTorrent, toast], // eslint-disable-line react-hooks/exhaustive-deps
  );
  useEffect(() => {
    const offs = [
      onPartyState(st => applyPartyState(st, true)),
      onPartyUpdate(p => setPartyInfo({...p})),
      onPartyEnded(() => {
        setPartyInfo(null);
        setMenu(m => (m === 'party' ? null : m));
      }),
      // The host moved to another title (Up next, mostly): follow it, party intact.
      onPartyItem(({item: next, party: p}) => {
        if (!next || party.role === 'host' || String(next.id) === String(id)) return;
        keepParty.current = true;
        toast(`${p.host ? p.host.name : 'The host'} moved on to ${next.showTitle ? `S${next.season} E${next.episode}` : next.title || 'the next title'}`);
        const nextTitle = next.showTitle && next.season != null ? `${next.showTitle} · S${next.season} E${next.episode}` : String(next.title || title);
        saveProgress();
        navigation.replace('Player', {
          id: String(next.id),
          title: nextTitle,
          stream: String(next.id).startsWith('torrent|') ? (next as never) : undefined,
          party: p.code,
        });
      }),
    ];
    return () => offs.forEach(off => off());
  }, [applyPartyState, id, title, navigation, toast]); // eslint-disable-line react-hooks/exhaustive-deps
  // Joining via a code (Home's pill, Settings, or the host's hand-over).
  useEffect(() => {
    if (!partyCode) return;
    if (party.current && party.current.code === partyCode) {
      setPartyInfo(party.current);
      return;
    }
    let live = true;
    let tries = 0;
    const attempt = async () => {
      if (!live) return;
      if (!socketOpen()) {
        if (++tries < 12) setTimeout(attempt, 600); // the socket may still be connecting
        else toast("Couldn't join: not connected to the server");
        return;
      }
      try {
        const p = await joinParty(partyCode);
        if (!live) return;
        setPartyInfo(p);
        toast(`Joined ${p.host ? p.host.name + "'s" : 'the'} party`);
        // Land where they are — once the clock is valid (onLoad), or now.
        const land: PartyStateMsg = {...p.state, now: p.now, kind: 'sync'};
        if (uriRef.current && durRef.current) applyPartyState(land, false);
        else pendingLand.current = land;
      } catch (e) {
        if (live) toast(`Couldn't join: ${(e as Error).message}`);
      }
    };
    attempt();
    return () => {
      live = false;
    };
  }, [partyCode]); // eslint-disable-line react-hooks/exhaustive-deps
  // The host's heartbeat: a sync every 5s while playing, for drifters and late joiners.
  useEffect(() => {
    const iv = setInterval(() => {
      if (party.current && party.role === 'host' && !pausedRef.current && uriRef.current) {
        sendPartyState(true, curRef.current, 'sync');
      }
    }, 5000);
    return () => clearInterval(iv);
  }, []);
  // Leaving the player leaves the party — unless this player is handing over
  // to the next episode's player with the party still running.
  useEffect(
    () => () => {
      if (party.current && !keepParty.current) leaveParty();
    },
    [],
  );
  const startParty = useCallback(async () => {
    try {
      const p = await createParty(partySnapshot());
      setPartyInfo(p);
      track('feat', {f: 'party_start'});
      toast(`Party ${p.code} — others join with that code`);
      // The party starts from where we are, in our state.
      sendPartyState(!pausedRef.current, curRef.current, 'sync');
    } catch (e) {
      toast(`Couldn't start a party: ${(e as Error).message}`);
    }
  }, [partySnapshot, toast]);
  const endParty = useCallback(() => {
    const wasHost = party.role === 'host';
    leaveParty();
    setPartyInfo(null);
    toast(wasHost ? 'Party ended' : 'Left the party');
    closeMenu();
  }, [toast, closeMenu]);

  // ---------------------------------------------------------------- subtitles
  const tracks = useMemo(() => buildTracks(subs), [subs]);
  // THE AUTO PICK (subTracks.ts autoPick — the web's autoTrackIndex, same
  // precedence: the last hand pick, then Settings). Decided once the person's
  // settings are loaded and the first tracks exist — and then it keeps
  // FOLLOWING the tracks until the viewer picks by hand, because tracks keep
  // arriving after the start: OpenSubtitles answers seconds later, a torrent's
  // own files come with its metadata, the server's fetch for a missing
  // language lands later still. It used to be decided ONCE, on whatever came
  // first, so a stream whose first answer was the torrent's English file
  // stayed on English (or on nothing) when the Hebrew track arrived a moment
  // later — one of the ways "subtitles are not working" (Dor, 2026-10-17).
  // After the first decision it only ever switches subtitles ON or to the
  // language it was waiting for (`upgradeTo`), never off; a reload or a seek
  // re-decides nothing (no dependency on them).
  //
  // A track that switched on BY ITSELF and then could not be loaded, or came
  // back with no cues, is set aside (badSubs) and the next best one tried —
  // a dead provider link must not leave the viewer with nothing. A track the
  // viewer picked is never second-guessed.
  const subHand = useRef(false); // the viewer picked in the menu: the auto pick stops
  const subAutoDone = useRef(false);
  const badSubs = useRef(new Set<string>());
  const [badTick, setBadTick] = useState(0);
  const subKeyRef = useRef<string | null>(null);
  useEffect(() => {
    subKeyRef.current = subKey;
  }, [subKey]);
  useEffect(() => {
    if (subHand.current || !prefsLoaded || !tracks.length) return;
    const usable = tracks.filter(t => !badSubs.current.has(t.url));
    const p = autoPick(usable, prefs, profileId, profilePick(profileId, 'subPick'));
    const pickKey = p.index >= 0 ? usable[p.index].key : null;
    const cur = subKeyRef.current;
    const first = !subAutoDone.current;
    subAutoDone.current = true;
    const step = followPick({first, cur, curUsable: !!cur && usable.some(t => t.key === cur), pickKey});
    if (first) {
      console.log(
        `[player] ${tracks.length} track(s):`,
        tracks.map(t => t.key).join(' | '),
        `→ ${pickKey || 'off'} (${p.why}${p.upgradeTo ? `, waiting for ${p.upgradeTo}` : ''})`,
      );
    }
    if (!step.change) return;
    if (!first) console.log(`[player] subtitles: ${cur || 'off'} → ${step.key || 'off'} (${p.why})`);
    subKeyRef.current = step.key; // (the mirror effect runs after this render)
    setSubKey(step.key);
    if (step.announce && p.index >= 0) {
      const name = langName(usable[p.index].lang) || langName(langOf(usable[p.index]));
      toast(name ? `${name} subtitles found — switched on` : 'Subtitles found — switched on');
    }
  }, [tracks, prefsLoaded, prefs.subsDefault, prefs.subLang, prefs.lastSubSet, prefs.lastSubLang, profileId, badTick, toast]); // eslint-disable-line react-hooks/exhaustive-deps

  // Remember a HAND-PICKED track (or "off") so the next episode comes up the
  // same way — see autoPick. Only called from the subtitle menu: an automatic
  // pick must never write here, or the preference would be whatever the rules
  // guessed rather than what the viewer actually chose.
  const rememberSub = useCallback((t: Track | null) => {
    subHand.current = true; // whatever was picked, the auto pick is over for this title
    // "off", or the track's language when it is Hebrew, English or Russian.
    // Anything else — another language, a "Track 4" nobody can place — is a
    // one-off for this title: what was remembered stays as it was, here and on
    // the profile (see subTracks.ts rememberedPick).
    const pick = pickOf(t);
    if (!pick) return;
    // Computed OUTSIDE the updater: savePrefs inside one could run twice or
    // persist a render React discarded.
    const next: Prefs = {
      ...prefsRef.current,
      // The same normalised code the profile gets ("he", never "heb" or a
      // label), so the two memories cannot disagree about what was picked.
      lastSubLang: pick === 'off' ? null : pick,
      lastSubLabel: null,
      lastSubSet: true,
      lastSubProfile: profileId,
    };
    prefsRef.current = next;
    setPrefs(next);
    savePrefs(next);
    // And on the profile, in the site's own shape (its rememberPick("subPick")).
    rememberPick(profileId, 'subPick', pick);
  }, [profileId]);

  const subUrl = useMemo(
    () => tracks.find(t => t.key === subKey)?.url || null,
    [tracks, subKey],
  );
  // Load the chosen track's cues. A file that comes back empty is worth saying
  // out loud: on the web an empty track was a silent dead end (browsers never
  // retry one), and "I turned subtitles on and nothing happened" is exactly the
  // report this player exists to stop. A track that switched on BY ITSELF and
  // fails is set aside and the auto pick tries the next one (see above).
  // A track pulled out of the film's own file is extracted by the server on
  // first use, which reads the whole file — that can take a while, so after a
  // few seconds the wait is said out loud instead of looking broken.
  useEffect(() => {
    if (!subUrl) {
      setCues(null);
      return;
    }
    let live = true;
    setCues(null);
    // `reload` is what Resync bumps, and it goes on the URL as well: a track that
    // came back short or empty once would otherwise be served from cache forever.
    const url = `${assetUrl(subUrl)}${reload ? `${subUrl.includes('?') ? '&' : '?'}retry=${reload}` : ''}`;
    const slow = setTimeout(() => live && toast('Preparing subtitles…'), 4000);
    const failed = (msg: string) => {
      if (!subHand.current && !badSubs.current.has(subUrl)) {
        badSubs.current.add(subUrl);
        setBadTick(n => n + 1); // the auto pick moves on to the next track
        toast(`${msg} — trying another track`);
      } else toast(msg);
    };
    fetch(url, {headers: mediaHeaders()})
      .then(r => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then(txt => {
        if (!live) return;
        const parsed = parseVtt(txt);
        console.log(`[player] cues loaded: ${parsed.length} from ${subUrl}`);
        setCues(parsed.length ? parsed : null);
        if (!parsed.length) failed('That subtitle file has no cues');
      })
      .catch(e => {
        if (!live) return;
        console.log(`[player] cues failed: ${subUrl} (${(e as Error).message})`);
        setCues(null);
        failed("That subtitle track couldn't be loaded");
      })
      .finally(() => clearTimeout(slow));
    return () => {
      live = false;
      clearTimeout(slow);
    };
  }, [subUrl, reload, toast]);

  // The delay of the track on screen (seconds, positive = subtitles later),
  // per track and remembered on this box per title + track (subDelay.ts): a
  // track that needed +2.5 s needs it again next time, resume included.
  // Keyed by the track's URL, not its menu key — the URL is what names the
  // file; the key is only its place in this menu.
  const subOffsetsRef = useRef<Record<string, number>>({});
  useEffect(() => {
    let live = true;
    loadDelays().then(map => {
      if (!live) return;
      // what was nudged in the moment before this answered wins
      const merged = {...delaysForItem(map, id), ...subOffsetsRef.current};
      subOffsetsRef.current = merged;
      setSubOffsets(merged);
    });
    return () => {
      live = false;
    };
  }, [id]);
  const subOffset = (subUrl && subOffsets[subUrl]) || 0;
  const setSubDelay = useCallback(
    (url: string, seconds: number) => {
      const v = roundDelay(seconds);
      const next = {...subOffsetsRef.current, [url]: v};
      subOffsetsRef.current = next;
      setSubOffsets(next);
      saveDelay(id, url, v); // 0 (Reset) removes the entry
    },
    [id],
  );
  // The web's nudgeSubs: positive = subtitles later. Applied by looking cues up
  // at (clock - offset), so nothing about the parsed file is ever mutated and
  // repeated nudges can't accumulate error. The cue layer takes the new
  // offset as a prop and looks up again at once.
  const nudgeSubs = useCallback(
    (delta: number) => {
      if (!subUrl) return;
      setSubDelay(subUrl, (subOffsetsRef.current[subUrl] || 0) + delta);
      showControls();
    },
    [subUrl, setSubDelay, showControls],
  );
  const resetSubDelay = useCallback(() => {
    if (!subUrl) return;
    setSubDelay(subUrl, 0);
    showControls();
  }, [subUrl, setSubDelay, showControls]);
  // The site's resyncSubs, and deliberately the nuclear option there too: throw
  // the loaded cues away, re-download the file, and drop the manual delay. It
  // exists for "the subs look off and I don't want to fiddle with ±0.5s" — one
  // press, and it says what it did rather than leaving you guessing.
  const resyncSubs = useCallback(() => {
    if (!subKey || !subUrl) return;
    setSubDelay(subUrl, 0);
    setReload(n => n + 1);
    toast(`“${subKey}” re-downloaded, delay reset to 0.0s`);
  }, [subKey, subUrl, setSubDelay, toast]);

  // uri + bufferConfig + minLoadRetryCount in ONE memo, because that is exactly
  // what react-native-video folds into one native source (rule 1). Anything
  // unmemoised here is a fresh source — and a reload from zero — on every
  // scrubber tick.
  const source = useMemo(
    () =>
      uri
        ? {
            uri,
            // Closed mode gates /stream/* like everything else; ExoPlayer
            // forwards these on every segment/range request.
            headers: mediaHeaders(),
            bufferConfig: bufferConfigFor(lowRam),
            minLoadRetryCount: MIN_LOAD_RETRY,
            // (only the uri this was armed for — a reload of the source
            // after an error carries its own position)
            ...(startAt.current && startAt.current.uri === uri ? {startPosition: startAt.current.ms} : {}),
          }
        : undefined,
    [uri, lowRam],
  );

  // ---------------------------------------------------------------- seeking
  const totalDuration = useCallback(() => durRef.current || 0, []);

  const commitSeek = useCallback(async () => {
    if (pendingSeek.current == null) return;
    const target = pendingSeek.current;
    pendingSeek.current = null;
    seekStarted(target); // [analytics] seek → playing again, as a timing
    const base = itemRef.current?.transcodeBase || stream?.transcodeBase;
    // A committed seek is shared with the party — unless it IS the party's
    // (partyEcho), which is how the room avoids echoing seeks back and forth.
    if (party.current && Date.now() >= partyEcho.current) sendPartyState(!pausedRef.current, target, 'seek');

    // EVERY committed seek supersedes whatever earlier seek is still in flight —
    // including a NEAR seek arriving while a far-seek probe is awaiting. Without
    // this, the late probe resolved after the near seek and yanked playback to
    // the abandoned far target, with the stale seekWait/preview stuck on screen
    // because their owner's token check refused to clear them.
    const seq = ++farSeekSeq.current;

    if (usingTranscodeRef.current && base) {
      // The live playlist only spans [streamOffset, transcoded edge]. A seek
      // outside that cannot be served — it has to be re-generated from the
      // target, which is exactly what the web does. Without this the seek
      // silently waited on ffmpeg reaching the target from the old offset.
      // (content times: the playlist's data begins at clockBase — for a copy
      // job the keyframe before its offset — and runs localDur past it)
      const edge = clockBase.current + localDur.current;
      if (target < clockBase.current || target >= edge + 4) {
        setSeekPreview(target); // hold the destination on screen while it loads
        // The web PAUSES here, to stop the old spot playing on while the bar
        // shows the new one. This port must not: `paused` can only be cleared
        // again by onLoad, and if the reload then errors (a cold torrent, a
        // starved ffmpeg) onLoad never comes — the player sat paused behind a
        // buffering overlay, re-buffering forever and never continuing, which is
        // exactly the bug reported after a skip. The overlay's wash already
        // covers the picture, so the confusion the web was solving does not
        // arise. Nothing here can leave playback stopped.
        setBuffering(true);
        if (isTorrent) {
          prefetchRegion(target); // warm the swarm toward the target region
          toast('Downloading that part of the movie…');
        }
        const attempt = async () => {
          const t0 = Date.now();
          const ok = await startTranscodeAt(base, target, currentV.current);
          return {ok, ms: Date.now() - t0};
        };
        // A refused seek is usually TRANSIENT: the server was still tearing down
        // the previous transcode, or momentarily at its concurrency cap. Retrying
        // is our job, not the viewer's. Only a QUICK refusal is retried — a slow
        // failure means the source really couldn't deliver that region.
        let r = await attempt();
        for (let i = 0; !r.ok && r.ms < 20000 && i < 3; i++) {
          if (exited.current || seq !== farSeekSeq.current) return;
          await sleep(1500);
          if (exited.current || seq !== farSeekSeq.current) return;
          r = await attempt();
        }
        if (!r.ok && seq === farSeekSeq.current && !exited.current) {
          setSeekPreview(null); // give the bar back to reality
          toast("That part can't be fetched right now — the source may be too slow");
          // NOT just a state reset. The probe's &seek=1 retired the job the
          // current playlist came from, and any error ExoPlayer raised during
          // the probe was swallowed (onError bails while probing) leaving the
          // player idle-after-error with no source change coming. Re-issue the
          // pre-seek playlist: it revives the retired job server-side AND
          // re-prepares the player where it was. Buffering stays true until
          // that reload's onLoad; if the reload itself fails, onError now runs
          // normally and its ladder takes over.
          if (curRef.current > clockBase.current + 5) resumeAt.current = curRef.current;
          setUri(`${transcodeUrl(base, streamOffset.current, currentV.current)}&g=${++gen.current}`);
        }
        return;
      }
    }

    // Direct torrent playback: a target past the buffered edge is a hole in the
    // file, so fetch that region before asking ExoPlayer for it.
    if (isTorrent && !usingTranscodeRef.current && target > bufRef.current + 2) {
      setBuffering(true);
      setSeekWait({target, at: Date.now()});
      try {
        await prefetchRegion(target);
      } finally {
        if (seq === farSeekSeq.current) setSeekWait(null);
      }
      if (seq !== farSeekSeq.current || exited.current) return;
    }
    // A NEAR seek: cancel any probe still in flight (its token check will make
    // it a no-op) and take back the overlay state its finally-block will now
    // refuse to clear. Only once a source is actually armed — before that, the
    // only probe that can be in flight is the ARMING one, and cancelling it
    // would strand the player on the loading screen with no setUri ever coming.
    if (uriRef.current) {
      ++probeToken.current;
      probing.current = false;
      setSeekWait(null);
      setSeekPreview(null);
    }
    // Native seeks are in PLAYLIST (media) time: content time minus the
    // clock base of the playlist (clock.ts).
    videoRef.current?.seek(toMedia(clockBase.current, target));
    curRef.current = target;
    progTime.current = target;
    progAt.current = Date.now();
  }, [isTorrent, prefetchRegion, startTranscodeAt, stream, toast, transcodeUrl]);

  const seekTo = useCallback(
    (sec: number) => {
      const total = totalDuration();
      const target = Math.max(0, Math.min(total ? total - 1 : sec, sec));
      pendingSeek.current = target;
      setCurrent(target); // move the scrubber immediately
      if (seekTimer.current) clearTimeout(seekTimer.current);
      seekTimer.current = setTimeout(commitSeek, SEEK_DEBOUNCE_MS);
    },
    [commitSeek, totalDuration],
  );

  // Accelerating skip, straight from the web player: 10s a press, and a fast
  // chain escalates to 30s / 1m / 2m / 5m. A flat 10s step is what made getting
  // anywhere in an hour-long episode feel like work.
  const skipAnim = useRef(new Animated.Value(0)).current;
  const [skipHint, setSkipHint] = useState<{dir: number; label: string} | null>(null);
  const skip = useCallback(
    (dir: number) => {
      // Nothing armed yet (the torrent loading screen): there is nothing to
      // seek IN, and the commitSeek this would schedule cancels in-flight
      // probes — including the ARMING probe, whose cancellation left the
      // spinner up forever because nothing else ever calls setUri.
      if (!uriRef.current) return;
      const now = Date.now();
      if (now - lastSkipAt.current > SKIP_CHAIN_MS || dir !== skipDir.current) {
        skipStreak.current = 0;
        skipAccum.current = 0;
      }
      lastSkipAt.current = now;
      skipDir.current = dir;
      const step = SKIP_STEPS[Math.min(skipStreak.current, SKIP_STEPS.length - 1)];
      skipStreak.current += 1;
      skipAccum.current += step;

      // Chained skips continue from where the last one was headed, so pressing
      // skip again while a far seek loads keeps moving forward.
      const base =
        pendingSeek.current != null
          ? pendingSeek.current
          : seekPreviewRef.current != null
          ? seekPreviewRef.current
          : curRef.current;
      // Order matters: showControls() refreshes the scrubber from the live refs,
      // so the preview target must be set AFTER it to win the batch.
      showControls();
      seekTo(base + dir * step);

      // The ACCUMULATED jump, not this single press, so a burst reads "« 40s"
      // rather than flashing "10s" four times.
      const acc = skipAccum.current;
      setSkipHint({
        dir,
        label:
          acc >= 60
            ? `${Math.floor(acc / 60)}m${acc % 60 ? ` ${acc % 60}s` : ''}`
            : `${acc}s`,
      });
      skipAnim.setValue(1);
      Animated.timing(skipAnim, {
        toValue: 0,
        duration: 150,
        delay: 550,
        useNativeDriver: true,
        isInteraction: false,
      }).start();
    },
    [seekTo, showControls, skipAnim],
  );

  // The subtitle menu's list, so opening it can scroll to the ticked track.
  const ccScroll = useRef<ScrollView>(null);

  // ---------------------------------------------------------------- input
  const onTV = useCallback(
    (evt: {eventType: string}) => {
      if (!acceptTvEvent(evt)) return; // one press, one event (focus.ts)
      // Someone is there: the run of episodes that started by themselves is
      // over (the site's noteInput — "Still watching?" counts hands-off ones).
      autoRun.current = 0;
      // A sheet is up over the player (X-Ray, Report a problem): the remote is
      // the sheet's. Without this an OK pressed in the sheet also reached this
      // handler and, once the chrome had hidden, paused the film under it.
      if (overlayOpen()) return;
      const t = evt.eventType;
      // The web's media-key handler. A remote (or an HDMI-CEC transport control)
      // sends the discrete play/pause keys, not just the toggle — treating only
      // 'playPause' meant the dedicated pause key did nothing at all.
      if (t === 'playPause') return togglePlay();
      if (t === 'pause') {
        if (!pausedRef.current) togglePlay();
        return;
      }
      if (t === 'play') {
        if (pausedRef.current) togglePlay();
        return;
      }
      if (t === 'fastForward') return skip(1);
      if (t === 'rewind') return skip(-1);
      if (menuOpen || upNext || slowStart || stallCard) return; // the overlay's own focusables handle it
      if (!controls) {
        if (t === 'left') return skip(-1);
        if (t === 'right') return skip(1);
        // OK on the focused Skip intro button / resume card is theirs alone —
        // the Pressable fires, and this global handler must not also toggle.
        if (t === 'select') {
          if ((zone.current === 'skip' && inIntroRef.current) || zone.current === 'card') return;
          return togglePlay();
        }
        return showControls(); // up/down/menu reveal the UI
      }
      // Left/right SEEK while the SCRUBBER holds focus, and that is why the
      // chrome opens with it focused: press right and you are skipping.
      //
      // The web's rule is broader — it seeks unless the focused element is
      // inside .player-controls or a menu — but that does not survive the port.
      // A browser can preventDefault the arrow key; react-native-tvos cannot, so
      // the native focus engine ALSO moves focus on the same press, and the JS
      // handler runs against a focus state that is already one step stale.
      // Measured on the Streamer: walking the transport row fired stray seeks.
      // Keying strictly off the scrubber is deterministic, and everything else
      // in the row keeps a working D-pad.
      if (t === 'left' || t === 'right') {
        if (zone.current === 'scrub') return skip(t === 'right' ? 1 : -1);
      }
      showControls(); // any activity keeps the chrome alive
    },
    [controls, menuOpen, upNext, slowStart, stallCard, skip, togglePlay, showControls],
  );
  useTVEventHandler(onTV);

  // Hardware back, mirroring the web's ui-back handler: close a menu, dismiss Up
  // Next, hide the chrome, then leave.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (menuOpen) {
        closeMenu();
        return true;
      }
      if (upNext) {
        dismissUpNext();
        return true;
      }
      // Chrome open? Back CLOSES it and nothing else. Leaving is the second
      // press, from a clean picture. This is the web's `onBack` and it is the one
      // branch the first port left out — so Back walked straight out of the film
      // while the controls were still up, which is a whole title lost to one
      // press aimed at dismissing a scrubber.
      //
      // Only once something is actually PLAYING (`uri`) and not on the error
      // screen: `controls` is true from mount, so on the torrent loading screen
      // the first Back was eaten with no visible change and abandoning a slow
      // torrent took two presses.
      if (controls && uri && !error) {
        if (hideTimer.current) clearTimeout(hideTimer.current);
        setControls(false);
        return true;
      }
      // A HOST leaving ends the party for everyone in it: with guests in the
      // room that takes a second Back within six seconds (the site's rule) —
      // one press aimed at the chrome must not end the evening for the rest.
      if (party.current && party.role === 'host' && (party.current.members?.length || 0) > 1) {
        if (Date.now() - hostBackAt.current > 6000) {
          hostBackAt.current = Date.now();
          toast('Press Back again to end the party for everyone');
          return true;
        }
      }
      return false; // picture is clean — let navigation pop
    });
    return () => sub.remove();
  }, [menuOpen, upNext, controls, uri, error, closeMenu, dismissUpNext, toast]);
  const hostBackAt = useRef(0);

  // ------------------------------------------------------- progress + keepalive
  // For torrent streams the play-item rides along, so Continue Watching can
  // render and resume it — `torrent|…` ids are not in the server's scanner, and
  // without the meta the entry is skipped entirely (src/profiles.js).
  const streamMeta = useCallback(() => {
    if (!stream) return undefined;
    return {
      id: stream.id,
      type: stream.type,
      title: stream.title || title,
      year: stream.year,
      cover: stream.cover,
      backdrop: stream.backdrop,
      imdbId: stream.imdbId,
      infoHash: stream.infoHash,
      season: stream.season,
      episode: stream.episode,
      videoUrl: stream.videoUrl,
      downloadUrl: stream.videoUrl,
      transcodeBase: stream.transcodeBase,
      transcodeV: stream.transcodeV,
      needsTranscode: stream.needsTranscode,
      quality: stream.quality,
      duration: durRef.current || stream.duration,
      _isTorrent: true,
    };
  }, [stream, title]);

  // Playback marks, as the site sends them (player.js mark): how long the
  // film took to start and by which path, where it stalled, what failed -
  // one line each in the server's log, which is what the admin's Logs tab
  // and the healer read. Library titles only (a stream has no id to file
  // them under), and never more than forty a film.
  const markCount = useRef(0);
  const mark = useCallback(
    (name: string, extra: Record<string, string | number | boolean | null> = {}) => {
      if (isTorrent || markCount.current++ > 40) return;
      api.playMark(id, {name, ms: Date.now() - mountedAt.current, ...extra}).catch(() => {});
    },
    [id, isTorrent],
  );
  useEffect(() => {
    mark('mount', {app: 'tv'});
  }, [mark]);
  // A stall is buffering that lasts: over three seconds, after the first
  // frame, and not one the viewer caused by seeking a moment ago.
  // (playerRules.ts stallClock*: the wait before the first frame is the start,
  // never a stall — noteFirstFrame starts the clock's life.)
  const stallClock = useRef(stallClockNew());
  const stallTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noteBuffering = useCallback(
    (on: boolean) => {
      if (stallTimer.current) clearTimeout(stallTimer.current);
      stallTimer.current = null;
      if (!on) {
        const ms = stallClockOff(stallClock.current, Date.now());
        if (ms) mark('stall-end', {lasted: ms, at: Math.round(curRef.current || 0), app: 'tv'});
        return;
      }
      if (!stallClockOn(stallClock.current, Date.now())) return;
      stallTimer.current = setTimeout(() => {
        if (!playTracked.current || pausedRef.current || probing.current) return;
        mark('stall', {at: Math.round(curRef.current || 0), transcode: usingTranscodeRef.current, app: 'tv'});
        track('feat', {f: 'stall_tv'});
      }, STALL_MARK_MS);
    },
    [mark],
  );
  useEffect(
    () => () => {
      if (stallTimer.current) clearTimeout(stallTimer.current);
    },
    [],
  );

  const saveProgress = useCallback(() => {
    // Never write over a history we could not read (see the load effect).
    if (progressReadFailed.current) return;
    const pos = curRef.current;
    const dur = durRef.current;
    if (!pos || !dur) return;
    api.forgetState(); // what a screen read before this write is stale now
    api.saveProgress(profileId, id, pos, dur, streamMeta()).catch(() => {});
  }, [id, profileId, streamMeta]);

  // "Watching <title>" to the server, with the position, every five seconds -
  // paused or not, as the site does (player.js saveTimer). History, sessions
  // and the admin's live view are made of these; and "Browsing" on the way out.
  const activityLabel = useCallback(() => {
    const it = itemRef.current;
    if (it?.showTitle && it.season != null && it.episode != null) return `${it.showTitle} S${it.season}E${it.episode}`;
    if (stream?.season != null && stream?.episode != null) return `${title || it?.title || ''} S${stream.season}E${stream.episode}`;
    return it?.title || title || '';
  }, [stream, title]);
  useEffect(() => {
    const say = () => {
      const label = activityLabel();
      if (!label) return;
      reportActivity('Watching', label, {position: curRef.current || 0, duration: durRef.current || 0});
    };
    say();
    const first = setTimeout(say, 1500); // the title is known a moment after mount
    const iv = setInterval(say, 5000);
    return () => {
      clearTimeout(first);
      clearInterval(iv);
      reportActivity('Browsing');
    };
  }, [activityLabel]);

  const lastReported = useRef(0);
  useEffect(() => {
    const iv = setInterval(() => {
      if (pausedRef.current) return;
      if (Math.abs(curRef.current - lastReported.current) < 4) return;
      lastReported.current = curRef.current;
      saveProgress();
    }, 5000);
    return () => clearInterval(iv);
  }, [saveProgress]);
  useEffect(() => () => saveProgress(), [saveProgress]);

  // Keep the server-side halves of this playback alive for as long as the player
  // is open — including while PAUSED, when nothing else requests anything:
  //  • the torrent: evicted after 30 min untouched, destroying its pieces (a
  //    pause over dinner used to mean re-downloading from scratch).
  //  • the transcode: ffmpeg is killed after 2.5 min with no segment request and
  //    its directory deleted. ExoPlayer stops fetching once its buffer is full,
  //    so a stream paused (or simply well-buffered) for that long lost its
  //    transcode and stalled permanently on resume. Re-requesting the playlist
  //    marks the job in use — and revives it if it was already reaped.
  // This was missing entirely from the previous build, and it is the most likely
  // cause of "it just buffers" on a long-running transcode.
  useEffect(() => {
    const iv = setInterval(() => {
      if (exited.current) return;
      if (stream?.infoHash) api.torrentStatus(stream.infoHash).catch(() => {});
      // Never ping the old offset mid-seek — that request would supersede the
      // job the seek is waiting on.
      if (usingTranscodeRef.current && !probing.current) {
        const base = itemRef.current?.transcodeBase || stream?.transcodeBase;
        if (base) {
          fetch(transcodeUrl(base, streamOffset.current, currentV.current), {
            headers: mediaHeaders(),
          }).catch(() => {});
        }
      }
    }, 60000);
    return () => clearInterval(iv);
  }, [stream, transcodeUrl]);

  // Decode-stall watchdog (the web's stallTimer): data buffered ahead but the
  // clock frozen is a DECODE stall, not a peer stall — canPlayType's native
  // equivalent (the codec ladder) can lie about hardware decoding, so fall back
  // to the transcode instead of sitting there. Not armed once playback is
  // already on a transcode, and not for sources that started on one.
  const canFallback =
    !usingTranscode &&
    !!(meta?.item?.transcodeBase || stream?.transcodeBase) &&
    !(isTorrent && stream?.needsTranscode);
  const fallbackToTranscode = useCallback(() => {
    if (switchedToTranscode.current) return;
    const base = itemRef.current?.transcodeBase || stream?.transcodeBase;
    if (!base) return;
    switchedToTranscode.current = true;
    toast("This encode won't decode here — switching to transcode…");
    startTranscodeAt(base, curRef.current, 'h264', {fallbackToZero: true});
  }, [startTranscodeAt, stream, toast]);
  useEffect(() => {
    if (!canFallback) return;
    let lastCT = -1;
    let stalls = 0;
    const iv = setInterval(() => {
      if (exited.current || switchedToTranscode.current || usingTranscodeRef.current) return;
      const ct = curRef.current;
      const ahead = bufRef.current - ct > 3;
      if (!pausedRef.current && ahead && ct === lastCT) {
        if (++stalls >= 3) fallbackToTranscode(); // ~6s
      } else {
        stalls = 0;
      }
      lastCT = ct;
    }, 2000);
    return () => clearInterval(iv);
  }, [canFallback, fallbackToTranscode]);

  // Slow-start watchdog (library files). The stall watchdogs above only arm
  // once something is buffered or a transcode is running; a big file played
  // as-is over a slow line has neither, and measured through a 2.5 Mbit line
  // a 2 GB HEVC MKV sat on a black spinner for over 3.5 minutes with nothing
  // said. 25s after mount with the item loaded and no frame yet, a card says
  // so and offers a way out; at 90s it says why. Cancelled by the first frame,
  // by an error, by leaving; a torrent never arms it — its ready-gate has its
  // own 45s timer and its own status copy. Polled once a second (the first
  // frame is a ref, set in onProgress) and quiet while a seek/switch probes.
  useEffect(() => {
    if (isTorrent || !meta || error || loadErr) {
      setSlowStart(null);
      return;
    }
    const iv = setInterval(() => {
      if (exited.current) return;
      if (playTracked.current) {
        setSlowStart(null);
        clearInterval(iv);
        return;
      }
      if (probing.current || Date.now() < slowSnooze.current) return;
      const waited = Date.now() - mountedAt.current;
      if (waited < SLOW_START_MS) return;
      if (!slowMarked.current) {
        slowMarked.current = true;
        mark('slow-start', {at: Math.round(waited / 1000), transcode: usingTranscodeRef.current, app: 'tv'});
      }
      const next = waited >= SLOW_BIG_MS ? 'big' : 'slow';
      setSlowStart(cur => (cur === next ? cur : next));
    }, 1000);
    return () => clearInterval(iv);
  }, [isTorrent, meta, error, loadErr, mark]);
  // Lower quality = the server's 480p capped encode (about 1.1 Mbit/s all
  // in), started where the viewer is — the resume point if it never got going.
  // Offered only when this file has a transcode route and is not on a capped
  // encode already.
  const canLowerQuality = !isTorrent && !!meta?.item?.transcodeBase && !currentV.current.startsWith('h264-');
  const keepWaiting = useCallback(() => {
    slowSnooze.current = Date.now() + SLOW_START_MS;
    setSlowStart(null);
  }, []);
  const lowerQuality = useCallback(() => {
    const base = itemRef.current?.transcodeBase;
    if (!base) return;
    slowSnooze.current = Date.now() + SLOW_START_MS;
    setSlowStart(null);
    switchedToTranscode.current = true; // the decode-stall fallback must not undo this
    track('feat', {f: 'slow_start_lower'});
    toast('Lower quality — 480p');
    const at = resumeAt.current || curRef.current || 0;
    startTranscodeAt(base, at, 'h264-480').then(ok => {
      if (ok || exited.current) return;
      // Probe refused (no encoder free, or no answer): the file keeps loading.
      toast("Lower quality isn't available right now");
    });
  }, [startTranscodeAt, toast]);

  // Endless-rebuffer watchdog. The error path can only react to an error, and a
  // transcode whose ffmpeg has quietly died (or been retired by someone else's
  // seek) does not error — ExoPlayer simply waits for a segment that will never
  // arrive, which from the sofa is "it buffered forever and never continued".
  // A playlist that has produced no progress for 25s while nominally playing is
  // that case; re-issuing it either revives the job server-side or produces a
  // real error the handler above can act on. Bounded by the same recovery budget.
  useEffect(() => {
    const iv = setInterval(() => {
      if (exited.current || pausedRef.current || !bufferingRef.current) return;
      if (!usingTranscodeRef.current || probing.current) return;
      if (Date.now() - progAt.current < 25000) return;
      const base = itemRef.current?.transcodeBase || stream?.transcodeBase;
      if (!base || recoveries.current >= MAX_RECOVERIES) return;
      recoveries.current += 1;
      lastRecoveryAt.current = Date.now();
      progAt.current = Date.now(); // one re-issue per stall, not one per tick
      console.log('[player] stalled with no error — re-issuing the playlist');
      // HOLD THE POSITION. A re-handed source starts at playlist position 0 —
      // content time streamOffset — so without this, every recovery silently
      // rewound to wherever the transcode began (usually 0:00) and the progress
      // loop then saved that over the real position. onLoad routes resumeAt
      // through commitSeek, which native-seeks if the revived playlist still
      // spans the position and restarts the transcode at it if not.
      if (curRef.current > clockBase.current + 5) resumeAt.current = curRef.current;
      setUri(`${transcodeUrl(base, streamOffset.current, currentV.current)}&g=${++gen.current}`);
    }, 5000);
    return () => clearInterval(iv);
  }, [stream, transcodeUrl]);

  // Direct-play stall watchdog — a library file played as it is (no
  // repackaging). The watchdog above only covers repackaged streams; a direct
  // file whose connection went quiet mid-film just sat on a spinner with
  // nothing said (audit F40). The site's staged recovery, with its timings
  // (playerRules.ts stallStep): a nudge at 6 s (seek to where we are — that
  // alone restarts a reader that gave up), the source handed over again at
  // 20 s (at the same position), and at 45 s a card that says so and offers a
  // way out. One of each per stall; the picture moving again ends the stall.
  // After two re-hands in one film the next stall goes straight to the card.
  // A torrent is left alone — its own status copy says what the swarm is doing.
  const stallAt = useRef({since: 0, nudged: false, rebuilt: false, carded: false});
  const stallRebuilds = useRef(0);
  const rebuildDirect = useCallback(() => {
    const it = itemRef.current;
    if (!it?.videoUrl || usingTranscodeRef.current) return;
    if (curRef.current > 5) resumeAt.current = curRef.current;
    const base = assetUrl(it.videoUrl) as string;
    // the same file again: `g` only makes the address new, so the player
    // really reloads it (the server ignores it)
    setUri(`${base}${base.includes('?') ? '&' : '?'}g=${++gen.current}`);
  }, []);
  useEffect(() => {
    if (isTorrent) return;
    const iv = setInterval(() => {
      const d = stallAt.current;
      const stuck =
        !exited.current &&
        playTracked.current &&
        !pausedRef.current &&
        bufferingRef.current &&
        !usingTranscodeRef.current &&
        !probing.current &&
        pendingSeek.current == null;
      if (!stuck) {
        if (d.since) {
          stallAt.current = {since: 0, nudged: false, rebuilt: false, carded: false};
          setStallCard(c => (c ? false : c));
        }
        return;
      }
      if (!d.since) d.since = Date.now();
      let step = stallStep(Date.now() - d.since, d);
      if (step === 'rebuild' && stallRebuilds.current >= 2) {
        d.rebuilt = true;
        step = 'card';
      }
      if (step === 'nudge') {
        d.nudged = true;
        mark('stall-nudge', {at: Math.round(curRef.current || 0), app: 'tv'});
        videoRef.current?.seek(toMedia(clockBase.current, curRef.current));
      } else if (step === 'rebuild') {
        d.rebuilt = true;
        stallRebuilds.current += 1;
        mark('stall-rebuild', {at: Math.round(curRef.current || 0), app: 'tv'});
        toast('Still stuck — loading it again…');
        rebuildDirect();
      } else if (step === 'card') {
        d.carded = true;
        mark('stall-card', {at: Math.round(curRef.current || 0), app: 'tv'});
        setStallCard(true);
      }
    }, 1000);
    return () => clearInterval(iv);
  }, [isTorrent, mark, rebuildDirect, toast]);
  // The card's own ways out: once more (and the card goes until the next
  // stall has lasted as long), the 480p encode where the file has one, or Back.
  const stallRetry = useCallback(() => {
    stallAt.current = {since: 0, nudged: true, rebuilt: true, carded: false};
    setStallCard(false);
    rebuildDirect();
  }, [rebuildDirect]);

  // ---------------------------------------------------------------- Up Next
  // WHICH EPISODE IS NEXT is the server's answer (GET /api/next-episode — one
  // rule for the website and this app, src/media/nextep.js): the REAL next
  // episode of the series. This player used to take "the next file in the
  // library's list", which only lists what is on disk — with E1–E4 and E8
  // downloaded, Up next after E4 was E8 (audit C-2) — and a streamed episode
  // had no Up next at all (A-6). Asked once, as the episode starts; the Next
  // button and the Up next card both read it.
  //   library  on disk: Play now, and it may start by itself
  //   stream   not on disk: "Choose episode" opens its sources; never by itself
  const [nextEp, setNextEp] = useState<NextEp | null>(null);
  const nextEpRef = useRef<NextEp | null>(null);
  const showIdOfItem = meta?.item?.showId || null;
  // ASKED AGAIN when the answer may have changed while this player is open
  // (an episode added to the library while the one before it plays — the
  // device pass found Up next still offering to stream it): on the library's
  // news (realtime.ts onLibraryNews, at once even while the screens' refresh
  // is held, then a random 1–6 s wait so a house of TVs does not ask together)
  // and once near the end (playerRules.ts NEXT_REASK_BEFORE_END_S). A changed
  // answer replaces the card if it is already up.
  const askNextRef = useRef<((why: 'open' | 'news' | 'end') => void) | null>(null);
  const showUpNextRef = useRef<(() => void) | null>(null);
  const retractUpNextRef = useRef<(() => void) | null>(null);
  const nextReaskedNearEnd = useRef(false);
  useEffect(() => {
    nextEpRef.current = null;
    setNextEp(null);
    askNextRef.current = null;
    nextReaskedNearEnd.current = false;
    if (!meta) return;
    const lib = !stream && !!showIdOfItem;
    const streamed = !!(stream && stream.imdbId && stream.season && stream.episode);
    if (!lib && !streamed) return;
    let live = true;
    const set = (n: NextEp | null, why: string) => {
      if (!live) return;
      const was = nextEpRef.current;
      nextEpRef.current = n;
      setNextEp(n);
      if (why !== 'open' && nextAnswerChanged(was, n)) {
        console.log(`[player] next episode now ${n ? `${n.kind} ${n.label}` : 'none'} (was ${was ? `${was.kind} ${was.label}` : 'none'}, ${why})`);
        // the card on screen named the old answer: put the new one up instead
        if (upNextShown.current) {
          retractUpNextRef.current?.();
          if (n) showUpNextRef.current?.();
        }
      }
    };
    const ask = (why: 'open' | 'news' | 'end') => {
      const q = lib
        ? api.nextEpisode({id})
        : api.nextEpisode({
            imdbId: stream!.imdbId as string,
            season: stream!.season as number,
            episode: stream!.episode as number,
            title: meta.item.showTitle || meta.item.title || title,
            year: stream!.year ?? null,
          });
      q.then(r => {
        const n = readNext(r);
        if (n === undefined) throw new Error('not an answer');
        set(n, why);
      }).catch(() => {
        // A server from before the route (404), or no answer: a library
        // episode falls back to the next file on disk, as this player always
        // did; a streamed one has nothing to fall back to. A re-ask that
        // fails keeps the answer it had.
        if (!lib || !live) return;
        api
          .item(showIdOfItem as string, profileId)
          .then(show => set(nextFile(show.seasons, id), why))
          .catch(() => {});
      });
    };
    askNextRef.current = ask;
    ask('open');
    let newsTimer: ReturnType<typeof setTimeout> | null = null;
    const offNews = onLibraryNews(() => {
      if (newsTimer) return; // one ask for a burst of news
      newsTimer = setTimeout(() => {
        newsTimer = null;
        if (live) ask('news');
      }, 1000 + Math.random() * 5000);
    });
    return () => {
      live = false;
      askNextRef.current = null;
      offNews();
      if (newsTimer) clearTimeout(newsTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, showIdOfItem, id, profileId]);

  // "Still watching?" — how many episodes in a row started BY THEMSELVES up to
  // and including this one (the route carries the count from player to
  // player). Any press on the remote ends the run (onTV).
  const autoRun = useRef(Math.max(0, Math.floor(autoRunParam || 0)));

  const showUpNext = useCallback(() => {
    if (upNextShown.current) return;
    const next = nextEpRef.current;
    if (!next) return; // not known yet, or nothing is next: later ticks ask again
    upNextShown.current = true;
    const inParty = !!party.current;
    const plan = planUpNext({
      next,
      autoplayPref: prefsRef.current.autoplayNext,
      inParty,
      guest: inParty && party.role !== 'host',
      autoRun: autoRun.current,
    });
    if (plan.card === 'still') track('feat', {f: 'still_watching_shown'});
    setUpNext({next, countdown: plan.countdown, still: plan.card === 'still'});
    setControls(true);
    if (countdownTimer.current) clearInterval(countdownTimer.current);
    countdownTimer.current = null;
    if (plan.countdown != null) {
      countdownTimer.current = setInterval(() => {
        setUpNext(prev => {
          if (!prev || prev.countdown == null) return prev;
          return {...prev, countdown: prev.countdown - 1};
        });
      }, 1000);
    }
  }, []);
  showUpNextRef.current = showUpNext;
  // The viewer went back out of the credits: the card goes (and any countdown
  // with it) and is armed again for when the credits return — the site's rule.
  const retractUpNext = useCallback(() => {
    if (!upNextShown.current) return;
    upNextShown.current = false;
    if (countdownTimer.current) clearInterval(countdownTimer.current);
    countdownTimer.current = null;
    setUpNext(prev => (prev ? null : prev));
  }, []);
  retractUpNextRef.current = retractUpNext;

  // On to the next episode. `byCountdown`: it started by itself (the card ran
  // out) — everything else is a person's press (Play now, Keep watching, the
  // Next button).
  const goNext = useCallback(
    (target: NextEp, byCountdown: boolean) => {
      if (advancing.current) return; // guard against OK double-firing
      advancing.current = true;
      if (countdownTimer.current) clearInterval(countdownTimer.current);
      countdownTimer.current = null;
      setUpNext(null);
      saveProgress();
      const inParty = !!party.current;
      // A GUEST NEVER ADVANCES ON THEIR OWN — the host's party_item does it
      // for the whole room (see onPartyItem). Say so, and give the player
      // back: this branch used to return with the guard still set, which left
      // the Next button dead for the rest of the episode (audit X6).
      if (inParty && party.role !== 'host') {
        advancing.current = false;
        toast('Following the host — the next episode starts when theirs does');
        showControls();
        setTimeout(() => pauseBtnRef.current?.requestTVFocus?.(), 0);
        return;
      }
      const it = itemRef.current;
      // Not on disk: its sources, to pick one (the site sends the viewer to
      // the show's page on that episode for the same reason — a source is
      // never chosen for them). A party does not come along: there is no one
      // file yet for the room to follow.
      if (target.kind === 'stream') {
        navigation.replace('Sources', {
          type: 'series',
          imdbId: target.imdbId,
          title: it?.showTitle || it?.title || title,
          season: target.season,
          episode: target.episode,
          year: stream?.year ?? it?.year ?? null,
          poster: stream?.cover ?? it?.cover ?? null,
        });
        return;
      }
      // A hosted party comes along: the guests are told the new episode.
      if (inParty) {
        setPartyItem({id: target.id, title: target.label, showTitle: it?.showTitle, cover: it?.cover ?? null});
        keepParty.current = true;
      }
      navigation.replace('Player', {
        id: target.id,
        title: it?.showTitle ? `${it.showTitle} · S${target.season} E${target.episode}` : target.label,
        epTitle: target.name || undefined,
        party: party.current?.code,
        autoRun: nextAutoRun({byCountdown, inParty, autoRun: autoRun.current}),
      });
    },
    [navigation, saveProgress, showControls, stream, title, toast],
  );
  const playUpNext = useCallback(() => {
    if (!upNext) return;
    if (upNext.still) track('feat', {f: 'still_watching_keep'});
    goNext(upNext.next, false);
  }, [goNext, upNext]);
  // "I'm done" on Still watching?: out of the player.
  const doneWatching = useCallback(() => {
    track('feat', {f: 'still_watching_done'});
    if (countdownTimer.current) clearInterval(countdownTimer.current);
    setUpNext(null);
    saveProgress();
    if (navigation.isFocused()) navigation.goBack();
  }, [navigation, saveProgress]);
  // The countdown reaching zero is the autoplay. Driven off state rather than
  // from inside the interval so it can never fire twice.
  useEffect(() => {
    if (upNext && upNext.countdown != null && upNext.countdown <= 0) goNext(upNext.next, true);
  }, [upNext, goNext]);

  // ---------------------------------------------------------------- video events
  // The first picture, once — from whichever of the two reports it first: the
  // player saying it is ready to draw (onReadyForDisplay: ExoPlayer reaching
  // READY, its start buffer full — the frame is on screen within a few
  // milliseconds of it), or the clock having moved (onProgress — which ticks
  // once a SECOND, and so used to stamp every start up to a second late).
  const noteFirstFrame = () => {
    if (playTracked.current) return;
    playTracked.current = true;
    // Whatever buffering came before this was the start, not a stall
    // (noteBuffering): no stall clock or pending stall mark carries over.
    stallClockFirstFrame(stallClock.current);
    if (stallTimer.current) clearTimeout(stallTimer.current);
    stallTimer.current = null;
    // ONE moment, one number: the play mark, the usage statistic and the
    // analytics timing (usage.track('play') hands `ms` to telemetry's
    // play_first_frame) all carry this same reading.
    const ms = Date.now() - mountedAt.current;
    // (the device's own copy of the number, for logcat beside the server's log)
    console.log(`[player] first frame +${ms}ms meta=${startMs.current.meta} armed=${startMs.current.armed} buf=${tuning().startBufferMs}`);
    mark('first-frame', {
      ms,
      transcode: usingTranscodeRef.current,
      v: usingTranscodeRef.current ? currentV.current : 'direct',
      app: 'tv',
      meta: startMs.current.meta,
      armed: startMs.current.armed,
      buf: tuning().startBufferMs, // the start buffer in force (tuning.ts)
    });
    track('play', {
      kind: isTorrent ? 'stream' : 'library',
      path: usingTranscodeRef.current ? `hls-${currentV.current}` : 'direct',
      ms,
    });
  };

  const onLoad = (d: OnLoadData) => {
    // A still-transcoding HLS playlist reports only what has been written so far
    // and it keeps growing, so the metadata runtime is the honest total. This
    // mirrors the web's totalDuration().
    localDur.current = d.duration || 0;
    const dur = Math.max(
      clockBase.current + localDur.current,
      itemRef.current?.duration || 0,
    );
    durRef.current = dur;
    setDuration(dur);
    setBuffering(false);
    // The new stream's clock is valid from here, so the held seek target can
    // hand the scrubber back to it without the bar ever stepping backwards.
    setSeekPreview(null);
    if (pendingLand.current) {
      const land = pendingLand.current;
      pendingLand.current = null;
      resumeAt.current = 0; // the party's position wins over our saved one
      setTimeout(() => !exited.current && applyPartyState(land, false), 50);
    }
    // Transcoded streams resume by starting the transcode at the saved offset
    // (baked into streamOffset by startTranscode, which also clears resumeAt);
    // direct playback seeks natively. A torrent's bytes at that offset may not
    // exist yet, and a RELOADED transcode's fresh playlist may not span the
    // held position — commitSeek handles both (near = native seek, far =
    // restart at the target), so any transcode goes through it too.
    if (resumeAt.current > 0) {
      const r = resumeAt.current;
      resumeAt.current = 0;
      if (isTorrent || usingTranscodeRef.current) {
        pendingSeek.current = r;
        commitSeek();
      } else {
        videoRef.current?.seek(toMedia(clockBase.current, r));
        curRef.current = r;
        progTime.current = r;
        progAt.current = Date.now();
        setCurrent(r);
      }
    }
  };

  const onProgress = (d: OnProgressData) => {
    // media → content through clockBase (clock.ts), not the job's offset
    const content = toContent(clockBase.current, d.currentTime);
    curRef.current = content;
    if (seeking()) seekResumed(content); // [analytics] (one boolean while no seek is being timed)
    // Re-anchor the cue clock (see timeRef): the interpolation between these
    // events is what keeps subtitles on the frame rather than up to a second out.
    progTime.current = content;
    progAt.current = Date.now();
    bufRef.current = toContent(clockBase.current, d.playableDuration || 0);
    if (d.currentTime > 0) everPlayed.current = true;
    // THE PLAYLIST GROWS; localDur MUST GROW WITH IT. It was written once, at
    // onLoad, when an event playlist is ~2-8s long — so half an hour in, the
    // "edge" commitSeek tested against was still ~8s past the offset and EVERY
    // seek, even a 10s skip, took the far path: kill ffmpeg, restart, full
    // re-buffer. seekableDuration is the playlist's real current span.
    if (usingTranscodeRef.current && d.seekableDuration && d.seekableDuration > localDur.current) {
      localDur.current = d.seekableDuration;
      // The honest total also grows with it — for a title whose metadata
      // carried no runtime, durRef froze at that first tiny playlist, which
      // clamped forward skips to ~8s and had progress saves mark the title
      // finished within seconds (position/duration ≈ 1).
      const grown = toContent(clockBase.current, d.seekableDuration);
      if (grown > durRef.current) {
        durRef.current = grown;
        if (controlsRef.current) setDuration(grown);
      }
    }
    // A working stream earns a fresh recovery budget (the web resets it on the
    // `playing` event). Two seconds INTO THIS SOURCE — a reload restarts the
    // clock, so this can't be satisfied by an older, healthier attempt.
    if (d.currentTime > 2) recoveries.current = 0;
    // Only push position into state while the scrubber is actually on screen —
    // otherwise steady playback re-rendered the whole player tree every second
    // for nothing. A pending/preview seek owns the bar; don't fight it.
    if (controlsRef.current && pendingSeek.current == null && seekPreviewRef.current == null) {
      setCurrent(content);
      setBuffered(bufRef.current);
    }
    // Skip intro / Skip recap: inside a known range, playing, and not in its
    // final second — the recap while inside it, else the intro.
    const seg = pausedRef.current ? null : skippableAt(content, {recap: autoRecap.current, intro: intro.current || autoIntro.current});
    if (seg && seg.kind !== skipKindRef.current) {
      skipKindRef.current = seg.kind;
      setSkipKind(seg.kind);
    }
    const inR = !!seg;
    if (inR !== inIntroRef.current) {
      inIntroRef.current = inR;
      setInIntro(inR);
    }
    // Up next at the detected credits; otherwise a window that scales with the
    // runtime — for any episode whose next one is known, streamed ones too
    // (playerRules.ts upNextState). Only while playing: pausing on the last
    // minute must not pop a countdown over the frame. Going back out of the
    // credits takes the card away again.
    if (!nextReaskedNearEnd.current && askNextRef.current && durRef.current > 0 && durRef.current - content <= Math.max(NEXT_REASK_BEFORE_END_S, creditsStart.current ? durRef.current - creditsStart.current + 30 : 0) && content > 0) {
      nextReaskedNearEnd.current = true;
      askNextRef.current('end');
    }
    if (nextEpRef.current || upNextShown.current) {
      const s = upNextState(content, durRef.current, creditsStart.current);
      if (s === 'show' && !pausedRef.current) showUpNext();
      else if (s === 'retract') retractUpNext();
    }
    if (d.currentTime > 0) noteFirstFrame();
  };

  // The episode ran out with the Up next card on. A card that was counting
  // down starts the next episode now; one that was NOT (autoplay is off, the
  // next episode needs a source picked, "Still watching?", a party guest)
  // stays up and waits to be answered — the end of an episode used to start
  // the next one whatever the card said, the setting included.
  const endOnCard = () => {
    if (!upNext) return false;
    if (upNext.countdown != null) goNext(upNext.next, true);
    else setPaused(true);
    return true;
  };
  const onEnd = () => {
    // A transcode that "ends" FAR before the known duration is a truncated
    // playlist (its input starved server-side), not the end of the movie —
    // restart the stream where it died instead of silently closing the player
    // (a cached 9s stump made every open of an episode flash-close on the web).
    //
    // BOUNDED by the same budget as the error ladder. Metadata runtimes
    // overshoot real files (Cinemeta's nominal 60min vs a 52min episode), so
    // "ended 90s early" can BE the true end — unbounded, this looped forever:
    // each restart probed 2s earlier, ffmpeg wrote a header-only playlist past
    // EOF, onEnd fired again, ~240 ffmpeg spawns and Up Next never appeared.
    // And never fallbackToZero here: restarting a FINISHED film at 0:00 (and
    // saving ~5s over the completed position) is the one wrong answer.
    const base = itemRef.current?.transcodeBase || stream?.transcodeBase;
    const d = durRef.current;
    if (usingTranscodeRef.current && base && d && d - curRef.current > 90) {
      const now = Date.now();
      if (now - lastRecoveryAt.current > RECOVERY_WINDOW_MS) recoveries.current = 0;
      if (recoveries.current < MAX_RECOVERIES) {
        recoveries.current += 1;
        lastRecoveryAt.current = now;
        toast('Stream ended early — recovering…');
        // A failed probe must not strand the ENDED player behind a permanent
        // spinner (startTranscodeAt sets buffering true and, on false, clears
        // only its own probe state) — treat that failure as the real end.
        startTranscodeAt(base, curRef.current, currentV.current).then(ok => {
          if (ok || exited.current) return;
          setBuffering(false);
          // No saveProgress here: goNext saves, and the goBack path saves in
          // the unmount cleanup — a third call was just a duplicate POST.
          if (endOnCard()) return;
          if (navigation.isFocused()) navigation.goBack();
        });
        return;
      }
      // Budget spent: accept this as the actual end of the title.
    }
    saveProgress();
    if (endOnCard()) return;
    // isFocused guard: a spurious second end event (or one arriving after the
    // user already backed out) must not pop an extra screen off the stack.
    if (navigation.isFocused()) navigation.goBack();
  };

  const onError = (e?: {error?: {errorString?: string; errorException?: string}}) => {
    const detail = `${e?.error?.errorString || ''} ${e?.error?.errorException || ''}`;
    console.log('[player] error:', detail);
    playerError(detail, (e?.error as {errorCode?: string} | undefined)?.errorCode); // [analytics] ExoPlayer's error name and code, never the address
    mark('error', {m: detail.trim().slice(0, 40), at: Math.round(curRef.current || 0), app: 'tv'});
    const base = itemRef.current?.transcodeBase || stream?.transcodeBase;

    // Errors while a far-seek probe is in flight are EXPECTED: the probe's
    // &seek=1 just retired the job the old playlist came from, so its pending
    // segment requests fail. The seek owns the transition — re-issuing the OLD
    // offset from here would recreate the retired job and yank playback back
    // to it, which is precisely "I skipped and it jumped back".
    if (probing.current) {
      setBuffering(true);
      return;
    }
    // The same for a start whose claim has not been answered yet, or is
    // waiting on a busy server (claimStream): that answer decides what
    // happens to this source — the ladder below would ask a busy server for a
    // heavier encode.
    if (claimGen.current && claimGen.current === gen.current && !everPlayed.current) {
      claimSwallowed.current = gen.current;
      setBuffering(true);
      return;
    }

    // A STUCK PLAYLIST is not a codec problem, and must not be treated as one.
    //
    // The server writes HLS with -hls_playlist_type event, so ExoPlayer treats
    // the playlist as live and expects it to keep growing. On a cold torrent
    // ffmpeg can go seconds without emitting a segment, and media3 then throws
    // HlsPlaylistTracker$PlaylistStuckException. Running the codec ladder on that
    // burned the one h264 retry and reloaded the stream, which is what made a
    // seek "not work": the transcode HAD restarted at the right offset, and then
    // this threw the position away.
    //
    // The string test cannot be relied on by itself: react-native-video forwards
    // only the TOP-LEVEL exception, which for this is the generic
    // "ExoPlaybackException: Source error" — the real cause is a nested
    // `Caused by:` that never reaches JS. `everPlayed` is the honest
    // discriminator: a codec the device cannot decode fails on the FIRST frame,
    // so a file that has already been playing happily has a fine codec by
    // definition and the failure is the stream catching up.
    const looksTransient =
      /PlaylistStuck|playlist|Source error/i.test(detail) || everPlayed.current;
    if (looksTransient && usingTranscodeRef.current && base) {
      // The web's burst budget: bounded per burst, refreshing after a quiet
      // window, so an outage that ends is picked up again instead of leaving the
      // viewer on a dead screen forever.
      const now = Date.now();
      if (now - lastRecoveryAt.current > RECOVERY_WINDOW_MS) recoveries.current = 0;
      lastRecoveryAt.current = now;
      if (recoveries.current < MAX_RECOVERIES) {
        recoveries.current += 1;
        setBuffering(true);
        const url = transcodeUrl(base, streamOffset.current, currentV.current);
        // BACK OFF before re-issuing. A seek restarts ffmpeg at a new offset and
        // it needs a moment to emit the first segment; retrying instantly just
        // failed again and spent the whole budget inside a second.
        const wait = Math.min(3000, 700 * recoveries.current);
        if (retryTimer.current) clearTimeout(retryTimer.current);
        // Captured generation: if a SEEK issues a new source while this timer
        // waits, firing it anyway would re-issue the pre-seek offset on top of
        // the seek's own reload. And hold the position — a re-handed source
        // starts at playlist 0 (content = streamOffset), silently rewinding.
        const g = gen.current;
        retryTimer.current = setTimeout(() => {
          if (exited.current || gen.current !== g || probing.current) return;
          if (curRef.current > clockBase.current + 5) resumeAt.current = curRef.current;
          setUri(`${url}&g=${++gen.current}`);
        }, wait);
        return;
      }
      // Budget spent, and nothing has EVER played: re-issuing the same playlist
      // four more times will not help. If a rung of the codec ladder is still
      // unused this is the moment to take it — a v=copy remux whose audio the
      // sink still refuses looks exactly like a stuck playlist from JS, and the
      // web never sees this case because a browser reports the decode error
      // directly.
      if (!everPlayed.current && !triedH264.current && !currentV.current.startsWith('h264')) {
        triedH264.current = true;
        startTranscode(base, streamOffset.current, 'h264');
        return;
      }
      // Otherwise keep a slow heartbeat, because without one nothing would ever
      // load again, no further error could fire, and the window above could never
      // refresh: the screen would stay dead until the viewer acted.
      toast("This source isn't responding — still trying, or pick another");
      setBuffering(true);
      if (retryTimer.current) clearTimeout(retryTimer.current);
      const gh = gen.current; // same generation + position rules as above
      retryTimer.current = setTimeout(() => {
        if (exited.current || gen.current !== gh || probing.current) return;
        recoveries.current = 0;
        if (curRef.current > clockBase.current + 5) resumeAt.current = curRef.current;
        setUri(`${transcodeUrl(base, streamOffset.current, currentV.current)}&g=${++gen.current}`);
      }, RECOVERY_WINDOW_MS);
      return;
    }
    // Never run the codec ladder on something that was already playing: it
    // decoded fine a moment ago, so the codec is not the problem. A direct
    // stream that dies mid-film gets the transcode at the same position, exactly
    // as the web's video `error` listener does.
    if (everPlayed.current) {
      if (base && !switchedToTranscode.current) {
        fallbackToTranscode();
        return;
      }
      setError('Lost the stream. Try again, or go back and pick another source.');
      return;
    }
    if (!base) {
      setError("This title can't be played on this device.");
      return;
    }
    // Two rungs, cheapest first. Almost every failure on this hardware is the
    // AUDIO (E-AC3/DTS passthrough the sink won't open), and for that a video
    // copy with the audio re-encoded is enough — going straight to h264 threw
    // away picture quality and pinned the server's CPU to fix a sound problem.
    // Both rungs reload at streamOffset, so a fallback after a seek keeps the
    // position the viewer asked for.
    if (!usingTranscodeRef.current) {
      switchedToTranscode.current = true;
      startTranscode(base, streamOffset.current, 'copy');
    } else if (!triedH264.current) {
      triedH264.current = true;
      startTranscode(base, streamOffset.current, 'h264');
    } else {
      setError("This title can't be played on this device.");
    }
  };

  // ---------------------------------------------------------------- prefs menu
  // The gear menu stays open while you toggle, exactly like the site's (it
  // rebuilds itself in place), so this saves without closing anything.
  const setPref = useCallback(
    <K extends keyof Prefs>(key: K, value: Prefs[K]) => {
      // Same purity rule as rememberSub.
      const next = {...prefsRef.current, [key]: value};
      prefsRef.current = next;
      setPrefs(next);
      // a choice that follows the person goes to their profile; one that is
      // this screen's stays on the box (personPrefs.ts)
      if ((PERSON_KEYS as string[]).includes(key)) setPersonPref(key as PersonKey, value as never);
      else savePrefs(next);
      showControls();
    },
    [showControls],
  );

  // ---------------------------------------------------------------- derived
  // Seconds of video actually ready to play — what the viewer cares about, not
  // the scattered whole-torrent download percentage.
  const readySec = Math.max(0, Math.round(bufRef.current - curRef.current));
  // 60s in with no frame ever played: the site stops saying "buffering" and
  // tells the truth. No extra timer — the swarm poll re-renders while the
  // overlay is up, so this flips on its own.
  const stalled = isTorrent && !everPlayed.current && Date.now() - mountedAt.current > 60000;
  const status = torrentStatusCopy({
    st: tstatus,
    readySec,
    everPlayed: everPlayed.current,
    onTranscode: usingTranscode,
    seekWait,
    stalled,
  });

  // Where the bottom bar's top edge is, as distance from the bottom of the
  // screen, for the cue layer (cueBottom). The bar is the last child of the
  // full-screen controls column, so (column height − bar y) is that distance;
  // children are laid out before their parent reports, so until the column's
  // height is known the bar's own height stands in (the same number, as the
  // bar sits flush with the bottom).
  const chromeH = useRef(0);
  const bottomBar = useRef<{y: number; h: number} | null>(null);
  const [chromeLift, setChromeLift] = useState<number | null>(null);
  const liftFromLayout = () => {
    const b = bottomBar.current;
    if (!b) return;
    const v = Math.round(chromeH.current > 0 ? chromeH.current - b.y : b.h);
    setChromeLift(prev => (prev === v ? prev : v));
  };
  const onBottomLayout = (e: {nativeEvent: {layout: {y: number; height: number}}}) => {
    bottomBar.current = {y: e.nativeEvent.layout.y, h: e.nativeEvent.layout.height};
    liftFromLayout();
  };
  const onControlsLayout = (e: {nativeEvent: {layout: {height: number}}}) => {
    chromeH.current = e.nativeEvent.layout.height;
    liftFromLayout();
  };
  // (hooks above this line: the early returns below must not change their number)

  if (loadErr) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{loadErr.title}</Text>
        {loadErr.detail ? <Text style={styles.statusSub}>{loadErr.detail}</Text> : null}
        <View style={styles.upNextActions}>
          {loadErr.retry === false ? null : (
            <Focusable uiId="player.retry"
              round
              hasTVPreferredFocus
              onPress={() => {
                setLoadErr(null);
                setLoadTry(t => t + 1);
              }}
              style={styles.exitBtn}>
              <Text style={styles.exitText}>Retry</Text>
            </Focusable>
          )}
          <Focusable round hasTVPreferredFocus={loadErr.retry === false} onPress={() => canNavigate(navigation) && navigation.goBack()} style={styles.exitBtn}>
            <Text style={styles.exitText}>Back</Text>
          </Focusable>
        </View>
      </View>
    );
  }
  if (error) {
    // Not a dead end (the site's "Playback stopped" card: Try again / Back).
    // Try again is a FRESH player on the same title — it resumes from the
    // position saved a moment ago and walks the whole source ladder again,
    // which is what recovers a server that was restarting or a line that
    // dropped. A title with no file at all has nothing to try again.
    const canRetry = error !== NO_FILE;
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{error}</Text>
        <View style={styles.upNextActions}>
          {canRetry ? (
            <Focusable uiId="player.retry"
              round
              hasTVPreferredFocus
              onPress={() => {
                if (!canNavigate(navigation)) return;
                track('feat', {f: 'player_retry'});
                navigation.replace('Player', {id, title, epTitle, stream, party: partyCode});
              }}
              style={styles.exitBtn}>
              <Text style={styles.exitText}>Try again</Text>
            </Focusable>
          ) : null}
          <Focusable
            round
            hasTVPreferredFocus={!canRetry}
            onPress={() => canNavigate(navigation) && navigation.goBack()}
            style={styles.exitBtn}>
            <Text style={styles.exitText}>Back</Text>
          </Focusable>
        </View>
      </View>
    );
  }
  if (!uri) {
    // Torrents wait here while the server finds peers (the ready-gate); show the
    // live swarm status so the wait never looks frozen.
    return (
      <View style={styles.center}>
        {/* WHAT is loading — the spinner alone left the wait anonymous, which
            reads worse the longer a slow swarm takes. */}
        <Text style={styles.loadingTitle} numberOfLines={1}>
          {title}
        </Text>
        <ActivityIndicator color={colors.text} size="large" />
        {isTorrent ? (
          <>
            <Text style={styles.statusTitle}>{status.title}</Text>
            <Text style={styles.statusSub}>{status.sub}</Text>
          </>
        ) : null}
        {/* Toasts fired before a source is armed (e.g. "watch history couldn't
            be read") were invisible: the toast element only existed in the main
            tree, so the message expired behind this spinner unseen. */}
        {toastMsg ? <Text style={styles.statusSub}>{toastMsg}</Text> : null}
        <Focusable
          round
          hasTVPreferredFocus
          onPress={() => canNavigate(navigation) && navigation.goBack()}
          style={styles.exitBtn}>
          <Text style={styles.exitText}>Cancel</Text>
        </Focusable>
      </View>
    );
  }

  // Priority: the seek being typed > the far seek in flight > the real clock —
  // the web's updateScrubber.
  const shown = seekPreview != null ? seekPreview : current;
  const pct = duration ? Math.min(100, (shown / duration) * 100) : 0;
  const bufPct = duration ? Math.min(100, (buffered / duration) * 100) : 0;
  // The intro range the track draws (hand-marked wins over detected); the
  // marksTick state re-renders this when a mark lands.
  const marksRange = intro.current || autoIntro.current;
  void marksTick;
  // Second line under the title, composed the way the site composes it:
  // "S1 E4 · Episode Title" for an episode, else the year.
  const epSeason = itemRef.current?.season ?? stream?.season;
  const audioTracks = itemRef.current?.audioTracks || [];
  const epEpisode = itemRef.current?.episode ?? stream?.episode;
  // The episode's real name wins over the library's placeholder ("Episode 1").
  const epName =
    epTitle || (itemRef.current?.title && !/^Episode \d+$/.test(itemRef.current.title) ? itemRef.current.title : '');
  const subtitleText =
    epSeason && epEpisode
      ? `S${epSeason} E${epEpisode}${epName ? ` · ${epName}` : ''}`
      : itemRef.current?.year
      ? String(itemRef.current.year)
      : '';

  return (
    <View style={styles.root}>
      <Video
        ref={videoRef}
        source={source}
        // Low-RAM: buffer by memory, not only by time (BUFFER_CONFIG_LOW_RAM).
        bufferingStrategy={lowRam ? BufferingStrategyType.DEPENDING_ON_MEMORY : BufferingStrategyType.DEFAULT}
        style={styles.video}
        paused={paused}
        rate={rate}
        volume={muted ? 0 : volume}
        muted={muted}
        resizeMode="contain"
        progressUpdateInterval={1000}
        // Subtitles are drawn by <Subtitles> below; ExoPlayer's own text
        // renderer stays off so an MKV's DEFAULT-flagged in-container track can
        // never draw a second, mistimed copy (rule 2).
        selectedTextTrack={NO_NATIVE_TEXT}
        onLoad={onLoad}
        onReadyForDisplay={() => {
          // A resume that is still to be sought to (onLoad does it, right
          // after this first READY): the frame on screen is the film's first,
          // not the one the viewer is waiting for. The READY after the seek
          // is the start.
          if (resumeAt.current > 0) return;
          noteFirstFrame();
        }}
        onProgress={onProgress}
        onEnd={onEnd}
        onError={onError}
        onBuffer={({isBuffering}) => {
          setBuffering(isBuffering);
          noteBuffering(isBuffering);
        }}
      />

      {/* The cue layer. Lifted clear of the transport bar while the chrome is up
          — the site can leave its cues where they are because its controls are a
          thin strip; at 10-foot sizes they would sit right on top of them. */}
      <Subtitles
        cues={cues}
        timeRef={timeRef}
        offset={subOffset}
        sizePx={CUE_PX[prefs.cueSize]}
        background={prefs.cueBackground}
        // Chrome up: just above the real top of the bottom bar (its scrubber
        // row is the bar's first line), measured by onLayout — so a cue can
        // never be drawn under the scrubber whatever the bar's height on this
        // screen, and does not float mid-picture either (elia, 2026-10-07:
        // "take the subs down a bit when the timeline is open"). Until the bar
        // has been measured, the 150 that used to be the only answer. Chrome
        // hidden: 48, as always. (cues.ts cueBottom)
        bottom={cueBottom(controls, chromeLift, chromeH.current || undefined)}
      />

      {/* Mid-playback stall. The site only darkens the picture and explains
          itself for TORRENT streams (.torrent-status); a library file just gets
          a spinner, because there is nothing useful to say about it. */}
      {buffering ? (
        <View style={[styles.bufferWrap, isTorrent && styles.bufferWash]} pointerEvents="none">
          <ActivityIndicator color={colors.white} size="large" />
          {isTorrent ? (
            <>
              <Text style={styles.statusTitle}>{status.title}</Text>
              <Text style={styles.statusSub}>{status.sub}</Text>
            </>
          ) : null}
        </View>
      ) : null}

      {/* Centre play/pause flash — outside the `controls` gate on purpose: the
          site flashes it even when the chrome is hidden. */}
      <Animated.View
        pointerEvents="none"
        style={[
          styles.flash,
          {
            opacity: flashAnim.interpolate({inputRange: [0, 0.3, 1], outputRange: [0, 1, 0]}),
            transform: [
              {scale: flashAnim.interpolate({inputRange: [0, 1], outputRange: [0.7, 1.15]})},
            ],
          },
        ]}>
        <Icon name={flashPaused ? 'pause' : 'play'} size={44} color={colors.white} />
      </Animated.View>

      {/* Accelerating-skip readout (site: .skip-indicator) */}
      {skipHint ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.skipHint,
            skipHint.dir < 0 ? styles.skipHintLeft : styles.skipHintRight,
            {opacity: skipAnim},
          ]}>
          <Text style={styles.skipHintText}>
            {skipHint.dir < 0 ? `« ${skipHint.label}` : `${skipHint.label} »`}
          </Text>
        </Animated.View>
      ) : null}

      {/* Controls */}
      {controls ? (
        <View style={styles.controls} pointerEvents="box-none" onLayout={onControlsLayout}>
          {/* box-none, not none: the Back button inside is a real focus target,
              same as the site's .player-top back button. */}
          <View style={styles.topBar} pointerEvents="box-none">
            <View style={styles.scrim} pointerEvents="none">
              <Image source={SCRIM_TOP} style={styles.scrimImg} resizeMode="stretch" />
            </View>
            <PBtn uiId="player.back"
              icon="back"
              label="Back"
              onFocusChange={markZone('top')}
              onPress={() => canNavigate(navigation) && navigation.goBack()}
            />
            {partyInfo ? (
              <View style={styles.partyPill} pointerEvents="none">
                <Icon name="people" size={16} color={colors.white} />
                <Text style={styles.partyPillText}>{`${partyInfo.members.length} · ${partyInfo.code}`}</Text>
              </View>
            ) : null}
            <View style={styles.titleWrap}>
              {/* For an episode the site's heading is the SHOW, with the episode
                  on the line beneath — the route's title is a composed label
                  ("Show · S1 E1") and using it here repeated the S/E. */}
              <Text style={styles.title} numberOfLines={1}>
                {epSeason && epEpisode ? itemRef.current?.showTitle || title : title}
              </Text>
              {subtitleText ? (
                <Text style={styles.subtitle} numberOfLines={1}>
                  {subtitleText}
                </Text>
              ) : null}
              {isTorrent || usingTranscode ? (
                <View style={styles.badgeRow}>
                  {/* Viewer words, not pipeline words: "torrent" and
                      "transcode" read as warnings from the sofa. */}
                  {isTorrent ? <Text style={styles.badge}>STREAM</Text> : null}
                  {usingTranscode ? <Text style={styles.badge}>OPTIMIZED</Text> : null}
                </View>
              ) : null}
            </View>
          </View>

          <View style={styles.bottom} onLayout={onBottomLayout}>
            <View style={styles.scrim} pointerEvents="none">
              <Image source={SCRIM_BOTTOM} style={styles.scrimImg} resizeMode="stretch" />
            </View>
            {/* Site order: scrubber first, timestamps underneath it. The
                scrubber is FOCUSABLE, exactly as it is on the site
                (`tabindex="0"`, `.scrubber:focus`), and it takes focus when the
                chrome appears — that is what makes "press right to skip" work. */}
            {/* A focus guide the full width of the row: the bar itself stops
                short of the two times, so UP from the outermost buttons
                (Rewind, Settings) had nothing straight above it and went
                nowhere (Mi TV, 2026-10-08). The guide catches it and hands
                focus to its one focusable, the bar. */}
            <TVFocusGuideView autoFocus trapFocusLeft trapFocusRight style={styles.scrubRow}>
            <Text style={styles.time}>{fmt(shown)}</Text>
            <Focusable uiId="player.scrub"
              noScale
              ref={scrubRef as never}
              hasTVPreferredFocus={!menuOpen && !upNext}
              onFocusChange={f => {
                setScrubFocused(f);
                if (f) zone.current = 'scrub';
              }}
              onPress={togglePlay}
              style={styles.scrubber}>
              <View style={[styles.track, scrubFocused && styles.trackTall]}>
                <View style={[styles.trackBuffer, {width: `${bufPct}%`}]} />
                <View style={[styles.trackFill, {width: `${pct}%`}]}>
                  {/* the lit head bead (glass.css .scrubber-fill::after) */}
                  <View style={[styles.head, scrubFocused && styles.headBig]} />
                </View>
                {/* The intro as a band on the track, so the skip range reads at a
                    glance (elia: "the skip intro timings on the timeline"). */}
                {duration > 0 && marksRange && marksRange.end > marksRange.start ? (
                  <View
                    style={[
                      styles.introBand,
                      {
                        left: `${(marksRange.start / duration) * 100}%`,
                        width: `${((marksRange.end - marksRange.start) / duration) * 100}%`,
                      },
                    ]}
                  />
                ) : null}
                {/* Landmark ticks (the site's .scrubber-marks): where the intro
                    starts and ends, where the credits begin. Drawn taller than
                    the track and over the fill, so they stay visible under it. */}
                {duration > 0
                  ? [
                      intro.current?.start ?? autoIntro.current?.start,
                      intro.current?.end ?? autoIntro.current?.end,
                      creditsStart.current,
                    ]
                      .filter((t): t is number => t != null && isFinite(t) && t > 0 && t < duration)
                      .map((t, i) => (
                        <View key={`${i}-${marksTick}`} style={[styles.mark, {left: `${(t / duration) * 100}%`}]} />
                      ))
                  : null}
              </View>
            </Focusable>
            <Text style={[styles.time, styles.timeRight]}>
              {duration ? `-${fmt(Math.max(0, duration - shown))}` : ''}
            </Text>
            </TVFocusGuideView>
            <View style={styles.buttons}>
              <PBtn uiId="player.seek.back"
                icon="back10"
                label="Back 10 seconds"
                onFocusChange={markZone('row')}
                onPress={() => skip(-1)}
              />
              <PBtn uiId="player.playpause"
                ref={pauseBtnRef}
                big
                icon={paused ? 'play' : 'pause'}
                label="Play/Pause"
                onFocusChange={markZone('row')}
                onPress={togglePlay}
              />
              <PBtn uiId="player.seek.fwd"
                icon="forward10"
                label="Forward 10 seconds"
                onFocusChange={markZone('row')}
                onPress={() => skip(1)}
              />
              {nextEp ? (
                <PBtn uiId="player.next"
                  icon="skip"
                  label={`Next episode — ${nextEp.label}${nextEp.kind === 'stream' ? ' (choose a source)' : ''}`}
                  onFocusChange={markZone('row')}
                  onPress={() => goNext(nextEp, false)}
                />
              ) : null}
              {/* .vol-group — the mute button, with the level bar collapsed to
                  zero width until it takes focus, as the site does it.

                  The level bar is an INDICATOR here, not a control. The site's is
                  a range input driven by arrows, and that cannot work on this
                  platform: RN can't preventDefault a D-pad press, so every arrow
                  aimed at the level also moved focus off it — one step per visit,
                  which reads as a broken slider. The remote's own volume keys are
                  what actually sets the level on a TV, and they go to the device
                  whatever this screen does; mute is the part worth having here. */}
              <View style={styles.volGroup}>
                <PBtn uiId="player.mute"
                  icon={muted || volume === 0 ? 'volumeOff' : 'volume'}
                  label="Mute"
                  onPress={() => setMuted(m => !m)}
                  onFocusChange={f => {
                    setVolBtnFocused(f);
                    if (f) zone.current = 'row';
                  }}
                />
                <View
                  pointerEvents="none"
                  style={[styles.volWrap, volOpen ? styles.volWrapOpen : null]}>
                  <View style={styles.volTrack}>
                    <View
                      style={[
                        styles.volFill,
                        {width: `${Math.round((muted ? 0 : volume) * 100)}%`},
                      ]}
                    />
                  </View>
                </View>
              </View>
              <View style={styles.spacer} />
              {tracks.length > 0 ? (
                <PBtn uiId="player.subtitles.open"
                  icon="cc"
                  label="Subtitles"
                  badge={subKey ? undefined : 'off'}
                  onFocusChange={markZone('row')}
                  ref={ccBtnRef}
                  onPress={() => {
                    menuOpener.current = ccBtnRef;
                    setMenu('cc');
                  }}
                />
              ) : null}
              {/* Speed keeps the site's icon, but shows the rate underneath when
                  it isn't 1x — otherwise nothing on screen tells you playback is
                  running fast. */}
              <PBtn uiId="player.speed.open"
                icon="speed"
                label="Speed"
                badge={rate === 1 ? undefined : `${rate}x`}
                onFocusChange={markZone('row')}
                ref={speedBtnRef}
                onPress={() => {
                  menuOpener.current = speedBtnRef;
                  setMenu('speed');
                }}
              />
              <PBtn uiId="player.xray"
                icon="xray"
                label="X-Ray"
                onFocusChange={markZone('row')}
                onPress={() => {
                  // the film waits while you read; it resumes when the sheet goes
                  // — except in a watch party, where it keeps playing (the
                  // site's rule): pausing only THIS TV took it out of step
                  // with the room without telling anyone (audit X11).
                  const wasPlaying = !pausedRef.current && !party.current;
                  if (!party.current) setPaused(true);
                  const it = itemRef.current;
                  openXray({
                    query: it?.id && !String(it.id).startsWith('torrent|')
                      ? {itemId: it.id}
                      : {type: (stream?.season ? 'series' : 'movie'), imdbId: stream?.imdbId || it?.imdbId || null, season: stream?.season ?? null, episode: stream?.episode ?? null},
                    title: it?.showTitle || title || it?.title || '',
                    onClose: () => {
                      if (wasPlaying) setPaused(false);
                    },
                  });
                }}
              />
              <PBtn uiId="player.party"
                icon="people"
                label="Watch together"
                badge={partyInfo ? String(partyInfo.members.length) : undefined}
                onFocusChange={markZone('row')}
                ref={partyBtnRef}
                onPress={() => {
                  menuOpener.current = partyBtnRef;
                  setMenu('party');
                }}
              />
              <PBtn uiId="player.settings.open"
                icon="gear"
                label="Settings"
                onFocusChange={markZone('row')}
                ref={gearBtnRef}
                onPress={() => {
                  menuOpener.current = gearBtnRef;
                  setMenu('settings');
                }}
              />
            </View>
          </View>
        </View>
      ) : null}

      {/* Skip intro — inside the range, playing. It takes focus as it appears so
          OK skips; leaving the range hands focus back to the scrubber. */}
      {inIntro && uri && !menuOpen && !upNext ? (
        <Focusable uiId="player.skipintro"
          round
          light
          hasTVPreferredFocus
          onFocusChange={markZone('skip')}
          onPress={skipIntro}
          style={[styles.skipIntro, {bottom: controls ? 144 : 56}]}>
          <Text style={styles.skipIntroText}>{skipKind === 'recap' ? 'Skip recap' : 'Skip intro'}</Text>
          <Icon name="skip" size={18} color={colors.bg} />
        </Focusable>
      ) : null}

      {/* The resume card: the frame you stopped on, and Start over for six seconds. */}
      {resumeCard && uri && !menuOpen ? (
        <View style={[styles.resumeCard, {bottom: controls ? 144 : 56}]}>
          <Image
            source={imgSrc(`/img/frame/${encodeURIComponent(id)}?t=${Math.floor(resumeCard.at)}`) || undefined}
            style={styles.resumeFrame}
            resizeMode="cover"
            fadeDuration={200}
          />
          <View style={styles.resumeText}>
            <Text style={styles.resumeK}>RESUMING FROM</Text>
            <Text style={styles.resumeT}>{fmt(resumeCard.at)}</Text>
          </View>
          <Focusable uiId="player.startover"
            round
            onFocusChange={markZone('card')}
            onPress={() => {
              setResumeCard(null);
              seekTo(0);
              toast('From the top');
              showControls();
            }}
            style={styles.resumeBtn}>
            <Text style={styles.resumeBtnText}>Start over</Text>
          </Focusable>
        </View>
      ) : null}

      {/* Subtitle menu. Focus is trapped inside while it's open — otherwise a
          stray D-pad press wanders to the transport bar behind the overlay. */}
      {menu === 'cc' ? (
        <TVFocusGuideView trapFocusUp trapFocusDown trapFocusLeft trapFocusRight style={[styles.menu, {maxHeight: menuH}]}>
          <MenuTitle icon="cc" label="SUBTITLES" />
          <ScrollView ref={ccScroll} style={styles.menuScroll}>
            {/* The site's first CC entry: one press that drops any manual delay
                and re-downloads the track. Cheap insurance for "the subs look off
                and I don't want to fiddle with ±0.5s". */}
            {subKey ? (
              <MenuItem uiId="player.subtitles.resync"
                label="⟲  Resync subtitles"
                onFocusChange={markZone('menu')}
                onPress={resyncSubs}
              />
            ) : null}
            <MenuItem uiId="player.subtitles.pick"
              label="Off"
              icon="close"
              on={!subKey}
              hasTVPreferredFocus={!subKey}
              onFocusChange={markZone('menu')}
              onPress={() => {
                setSubKey(null);
                rememberSub(null);
                closeMenu();
              }}
            />
            {tracks.map(t => (
              // The current track claims focus, and the list has to SHOW it:
              // with eight tracks the ticked one sat below the fold and the menu
              // opened on what looked like an unmarked list with no focus in it
              // (Mi TV, 2026-10-06). Android does not scroll to a child focused
              // before layout, so the row's own layout scrolls it into view.
              <View
                key={t.key}
                onLayout={
                  subKey === t.key
                    ? e => ccScroll.current?.scrollTo({y: Math.max(0, e.nativeEvent.layout.y - 160), animated: false})
                    : undefined
                }>
                <MenuItem uiId="player.subtitles.pick"
                  label={t.label}
                  tag={t.embedded ? 'Embedded' : undefined}
                  on={subKey === t.key}
                  hasTVPreferredFocus={subKey === t.key}
                  onFocusChange={markZone('menu')}
                  onPress={() => {
                    setSubKey(t.key);
                    rememberSub(t);
                    closeMenu();
                  }}
                />
              </View>
            ))}
            {/* .sub-sync — the site's timing row, in its order: the two nudges
                either side of the CURRENT delay, then Reset. External subtitle
                files are timed for whichever release their uploader had (measured
                across eight tracks of one film, the first cue landed anywhere from
                0.0s to 357.0s), so this is the difference between a usable track
                and a useless one. The menu stays open while you nudge. */}
            {subKey ? (
              <>
                <MenuTitle icon="forward10" label="SUBTITLE TIMING" gap />
                <View style={styles.syncRow}>
                  {[-5, -0.5].map(d => (
                    <Focusable
                      key={d}
                      round
                      noScale
                      ring="none"
                      highlightColor={colors.surfaceHover}
                      accessibilityLabel={`Subtitles ${Math.abs(d)} seconds earlier`}
                      onFocusChange={markZone('menu')}
                      onPress={() => nudgeSubs(d)}
                      style={styles.syncBtn}>
                      <Text style={styles.syncBtnText} numberOfLines={1}>{`−${Math.abs(d)}s`}</Text>
                    </Focusable>
                  ))}
                  <Text style={styles.syncValue} numberOfLines={1}>
                    {`${subOffset >= 0 ? '+' : '−'}${Math.abs(subOffset).toFixed(1)}s`}
                  </Text>
                  {[0.5, 5].map(d => (
                    <Focusable
                      key={d}
                      round
                      noScale
                      ring="none"
                      highlightColor={colors.surfaceHover}
                      accessibilityLabel={`Subtitles ${d} seconds later`}
                      onFocusChange={markZone('menu')}
                      onPress={() => nudgeSubs(d)}
                      style={styles.syncBtn}>
                      <Text style={styles.syncBtnText} numberOfLines={1}>{`+${d}s`}</Text>
                    </Focusable>
                  ))}
                  <Focusable
                    round
                    noScale
                    ring="none"
                    highlightColor={colors.surfaceHover}
                    accessibilityLabel="Reset subtitle timing"
                    onFocusChange={markZone('menu')}
                    onPress={resetSubDelay}
                    style={styles.syncBtn}>
                    <Text style={styles.syncBtnText} numberOfLines={1}>Reset</Text>
                  </Focusable>
                </View>
              </>
            ) : null}
          </ScrollView>
        </TVFocusGuideView>
      ) : null}

      {/* Speed — the site's SPEEDS menu. */}
      {menu === 'speed' ? (
        <TVFocusGuideView trapFocusUp trapFocusDown trapFocusLeft trapFocusRight style={[styles.menu, {maxHeight: menuH}]}>
          <MenuTitle icon="speed" label="SPEED" />
          <ScrollView style={styles.menuScroll}>
            {SPEEDS.map(sp => (
              <MenuItem uiId="player.speed.pick"
                key={sp}
                label={sp === 1 ? 'Normal' : `${sp}×`}
                on={rate === sp}
                hasTVPreferredFocus={rate === sp}
                onFocusChange={markZone('menu')}
                onPress={() => {
                  setRate(sp);
                  closeMenu();
                }}
              />
            ))}
          </ScrollView>
        </TVFocusGuideView>
      ) : null}

      {/* Settings — the site's gear menu, and ONLY what the site's gear menu has:
          Playback -> autoplay, Subtitle style -> size + background. "On by
          default" and "Preferred language" used to be here too, which is why this
          menu and the CC menu read as overlapping — those two are Preferences on
          the site (and are already on Aurora's own Settings screen), not things
          you set mid-film. */}
      {menu === 'settings' ? (
        <TVFocusGuideView trapFocusUp trapFocusDown trapFocusLeft trapFocusRight style={[styles.menu, {maxHeight: menuH}]}>
          {/* Its own scroller (it had none: a film with several dubs and an
              intro to mark ran past the top of the screen). */}
          <ScrollView ref={gearScroll} style={styles.menuScroll} showsVerticalScrollIndicator={false}>
          {audioTracks.length > 1 ? (
            <>
              <MenuTitle icon="volume" label="AUDIO" />
              {audioTracks.map(t => (
                // the ticked dub claims focus, so the list must SHOW it (the
                // subtitle menu's rule: Android does not scroll to a child
                // focused before layout)
                <View
                  key={`a${t.index}`}
                  onLayout={
                    audioIdx === t.index
                      ? e => gearScroll.current?.scrollTo({y: Math.max(0, e.nativeEvent.layout.y - 120), animated: false})
                      : undefined
                  }>
                <MenuItem uiId="player.audio.pick"
                  label={audioName(t)}
                  tag={[t.original ? 'Original' : null, t.codec ? t.codec.toUpperCase() : null, t.channels ? `${t.channels}ch` : null]
                    .filter(Boolean)
                    .join(' · ')}
                  on={audioIdx === t.index}
                  hasTVPreferredFocus={audioIdx === t.index}
                  onFocusChange={markZone('menu')}
                  onPress={() => {
                    closeMenu();
                    switchAudio(t.index, audioName(t));
                  }}
                />
                </View>
              ))}
            </>
          ) : null}
          {epSeason && epEpisode ? (
            <>
              <MenuTitle icon="play" label="PLAYBACK" gap={audioTracks.length > 1} />
              <MenuItem uiId="player.autoplay"
                label="Autoplay next episode"
                tag={prefs.autoplayNext ? 'On' : 'Off'}
                hasTVPreferredFocus={audioTracks.length <= 1}
                onFocusChange={markZone('menu')}
                onPress={() => setPref('autoplayNext', !prefs.autoplayNext)}
              />
            </>
          ) : null}
          {introKey.current ? (
            <>
              <MenuTitle icon="skip" label="SKIP INTRO" gap />
              {autoIntro.current && !intro.current ? (
                <MenuItem
                  label="Ignore the detected intro"
                  tag={`${fmt(autoIntro.current.start)}–${fmt(autoIntro.current.end)}`}
                  onFocusChange={markZone('menu')}
                  onPress={() => {
                    if (introKey.current) ignoreIntro(introKey.current);
                    autoIntro.current = null;
                    autoRecap.current = null;
                    inIntroRef.current = false;
                    setInIntro(false);
                    toast('Skip intro is off for this show on this TV');
                    closeMenu();
                  }}
                />
              ) : null}
              {markStart == null ? (
                <MenuItem
                  label="Mark intro start (now)"
                  tag={intro.current ? `marked ${fmt(intro.current.start)}–${fmt(intro.current.end)}` : undefined}
                  onFocusChange={markZone('menu')}
                  onPress={() => {
                    setMarkStart(Math.floor(curRef.current));
                    toast(`Intro starts ${fmt(curRef.current)} — play to where it ends, then save`);
                    closeMenu();
                  }}
                />
              ) : (
                <>
                  <MenuItem
                    label="Intro ends here (save)"
                    tag={`from ${fmt(markStart)}`}
                    onFocusChange={markZone('menu')}
                    onPress={async () => {
                      const end = Math.floor(curRef.current);
                      if (end <= markStart) return toast('The end has to come after the start');
                      try {
                        await api.setIntro(introKey.current!, markStart, end, me?.name || null);
                        intro.current = {start: markStart, end};
                        toast('Saved — every episode of this show now offers Skip intro');
                      } catch (e) {
                        toast((e as Error).message || "Couldn't save the intro");
                      }
                      setMarkStart(null);
                      closeMenu();
                    }}
                  />
                  <MenuItem
                    label="Cancel marking"
                    onFocusChange={markZone('menu')}
                    onPress={() => {
                      setMarkStart(null);
                      closeMenu();
                    }}
                  />
                </>
              )}
            </>
          ) : null}
          <MenuTitle icon="cc" label="SUBTITLE STYLE" gap />
          <MenuItem
            label="Size"
            tag={{S: 'Small', M: 'Medium', L: 'Large'}[prefs.cueSize]}
            // A film with one audio track has no section above this one, and
            // with nothing asking for focus the panel opened dead - focus
            // stayed on the gear behind it (found on the Mi TV, 2026-10-08).
            hasTVPreferredFocus={audioTracks.length <= 1 && !(epSeason && epEpisode)}
            onFocusChange={markZone('menu')}
            onPress={() => {
              const order: Prefs['cueSize'][] = ['S', 'M', 'L'];
              setPref('cueSize', order[(order.indexOf(prefs.cueSize) + 1) % 3]);
            }}
          />
          <MenuItem
            label="Background"
            tag={prefs.cueBackground ? 'On' : 'Off'}
            onFocusChange={markZone('menu')}
            onPress={() => setPref('cueBackground', !prefs.cueBackground)}
          />
          {/* Report a problem, from where the problems are (the site's player
              has the same entry). The film waits while the sheet is up; what
              was playing, the position and the last errors go with the report
              by themselves. */}
          <MenuTitle icon="gear" label="HELP" gap />
          <MenuItem
            label="Report a problem"
            onFocusChange={markZone('menu')}
            onPress={() => {
              setMenu(null);
              if (!party.current) setPaused(true);
              track('feat', {f: 'report_player'});
              openReport(`In the player: ${activityLabel()} at ${fmt(curRef.current)}${usingTranscodeRef.current ? `, ${currentV.current}` : ', direct'}`);
            }}
          />
          </ScrollView>
        </TVFocusGuideView>
      ) : null}

      {/* Watch together — the party panel (site: .party-panel). */}
      {menu === 'party' ? (
        <TVFocusGuideView trapFocusUp trapFocusDown trapFocusLeft trapFocusRight style={[styles.menu, {maxHeight: menuH}]}>
          <MenuTitle icon="people" label="WATCH TOGETHER" />
          <ScrollView style={styles.menuScroll} showsVerticalScrollIndicator={false}>
          {partyInfo ? (
            <>
              <Text style={styles.partyCode}>{partyInfo.code.split('').join(' ')}</Text>
              <Text style={styles.partyHint}>
                {`${partyInfo.members.map(m => m.name).join(', ')} · ${partyInfo.members.length} watching. On another device: Join a watch party (on a TV it is under Settings, on the website in the profile menu), and type the code. Anyone can play, pause or jump — everyone follows.`}
              </Text>
              <MenuItem
                label={party.role === 'host' ? 'End party' : 'Leave party'}
                hasTVPreferredFocus
                onFocusChange={markZone('menu')}
                onPress={endParty}
              />
              <MenuItem label="Close" onFocusChange={markZone('menu')} onPress={closeMenu} />
            </>
          ) : (
            <>
              <Text style={styles.partyHint}>
                Start a party and Aurora hands you a four-letter code. Anyone on another device joins with it, and play, pause and jumps stay in step. Everyone on Aurora sees the party on their Home and can join.
              </Text>
              <MenuItem uiId="player.party.start"
                label="Start a party"
                hasTVPreferredFocus
                onFocusChange={markZone('menu')}
                onPress={() => {
                  startParty();
                }}
              />
              <MenuItem label="Close" onFocusChange={markZone('menu')} onPress={closeMenu} />
            </>
          )}
          </ScrollView>
        </TVFocusGuideView>
      ) : null}

      {/* Up Next — focus trapped for the same reason as the subtitle menu. */}
      {upNext ? (
        <TVFocusGuideView trapFocusUp trapFocusDown trapFocusLeft trapFocusRight style={styles.upNext}>
          {/* "Still watching?" — three episodes started by themselves with
              nobody touching the remote: this one waits to be asked for. */}
          <Text style={styles.upNextKicker}>{upNext.still ? 'STILL WATCHING?' : 'UP NEXT'}</Text>
          <Text style={styles.upNextTitle} numberOfLines={1}>
            {upNext.still ? `Up next · ${upNext.next.label}` : upNext.next.label}
          </Text>
          <View style={styles.upNextActions}>
            <Focusable uiId={upNext.still ? 'player.stillwatching.keep' : 'player.upnext.play'}
              round
              light
              ring="violet"
              hasTVPreferredFocus
              onFocusChange={markZone('menu')}
              onPress={playUpNext}
              style={styles.btnPrimary}>
              <Text style={styles.btnPrimaryText}>
                {upNext.still ? '▶  Keep watching' : upNext.next.kind === 'stream' ? '▶  Choose episode' : '▶  Play now'}
              </Text>
            </Focusable>
            <Focusable uiId={upNext.still ? 'player.stillwatching.done' : 'player.upnext.dismiss'}
              round
              onFocusChange={markZone('menu')}
              onPress={upNext.still ? doneWatching : dismissUpNext}
              style={styles.btn}>
              <Text style={styles.btnText}>
                {upNext.still ? "I'm done" : upNext.countdown != null ? `Dismiss (${upNext.countdown})` : 'Dismiss'}
              </Text>
            </Focusable>
          </View>
        </TVFocusGuideView>
      ) : null}

      {/* The picture stopped and did not come back (the direct-play stall
          watchdog): say so, with a way out — the same box as the slow start. */}
      {stallCard && !upNext && !menuOpen && !slowStart ? (
        <TVFocusGuideView trapFocusUp trapFocusDown trapFocusLeft trapFocusRight style={styles.upNext}>
          <Text style={styles.upNextTitle}>Playback has stalled — the connection to the server went quiet</Text>
          <View style={styles.upNextActions}>
            <Focusable uiId="player.stall.retry" round light ring="violet" hasTVPreferredFocus onFocusChange={markZone('menu')} onPress={stallRetry} style={styles.btnPrimary}>
              <Text style={styles.btnPrimaryText}>Try again</Text>
            </Focusable>
            {canLowerQuality ? (
              <Focusable uiId="player.stall.lower"
                round
                onFocusChange={markZone('menu')}
                onPress={() => {
                  setStallCard(false);
                  lowerQuality();
                }}
                style={styles.btn}>
                <Text style={styles.btnText}>Lower quality</Text>
              </Focusable>
            ) : null}
            <Focusable round onFocusChange={markZone('menu')} onPress={() => canNavigate(navigation) && navigation.goBack()} style={styles.btn}>
              <Text style={styles.btnText}>Back</Text>
            </Focusable>
          </View>
        </TVFocusGuideView>
      ) : null}

      {/* Slow start — the Up Next box and pills, over the spinner. Focus is
          trapped for the same reason; Back still leaves the way it always does. */}
      {slowStart && !upNext && !menuOpen ? (
        <TVFocusGuideView trapFocusUp trapFocusDown trapFocusLeft trapFocusRight style={styles.upNext}>
          <Text style={styles.upNextTitle}>
            {slowStart === 'big'
              ? 'This file may be too big for this connection'
              : 'Still loading… this connection is slow'}
          </Text>
          <View style={styles.upNextActions}>
            <Focusable uiId="player.slowstart.wait"
              round
              light
              ring="violet"
              hasTVPreferredFocus
              onFocusChange={markZone('menu')}
              onPress={keepWaiting}
              style={styles.btnPrimary}>
              <Text style={styles.btnPrimaryText}>Keep waiting</Text>
            </Focusable>
            {canLowerQuality ? (
              <Focusable uiId="player.slowstart.lower" round onFocusChange={markZone('menu')} onPress={lowerQuality} style={styles.btn}>
                <Text style={styles.btnText}>Lower quality</Text>
              </Focusable>
            ) : null}
            <Focusable
              round
              onFocusChange={markZone('menu')}
              onPress={() => canNavigate(navigation) && navigation.goBack()}
              style={styles.btn}>
              <Text style={styles.btnText}>Back</Text>
            </Focusable>
          </View>
        </TVFocusGuideView>
      ) : null}

      {/* The web's toast(), which is how it narrates everything that happens
          while the film keeps playing. */}
      {toastMsg ? (
        <View style={styles.toast} pointerEvents="none">
          <Text style={styles.toastText}>{toastMsg}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.black},
  video: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0},
  center: {
    flex: 1,
    backgroundColor: colors.black,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg,
  },
  bufferWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
  },
  // The title above the pre-arm spinner: the film you are waiting FOR.
  loadingTitle: {
    color: colors.text,
    fontSize: fontSize.title,
    fontWeight: '900',
    maxWidth: '70%',
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  // .torrent-status-title / .torrent-status-sub
  statusTitle: {
    color: colors.text,
    fontSize: fontSize.row,
    fontWeight: '800',
    textAlign: 'center',
  },
  statusSub: {
    color: colors.textDim,
    fontSize: fontSize.body,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: -spacing.sm,
    paddingHorizontal: spacing.xl,
  },
  // Approximates the site's radial vignette; RN has no radial-gradient.
  bufferWash: {backgroundColor: 'rgba(5,6,12,0.82)'},
  controls: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'space-between',
  },
  // Behind each bar. The site fades its scrims to transparent so the chrome
  // floats on the picture; a flat translucent slab has a hard visible edge.
  //
  // Two views, not one, and deliberately so. An <Image> needs a real size — four
  // insets alone will not stretch it — but a PERCENTAGE size resolves against the
  // parent, and these bars are content-sized (no fixed height), so height:'100%'
  // resolved against `auto` and collapsed to nothing. A plain View DOES resolve
  // top/bottom insets against a content-sized parent.
  scrim: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0},
  scrimImg: {width: '100%', height: '100%'},
  // Smaller chrome (elia, 2026-10-06): the picture is the point. Title at the
  // section size, the top band 34/44 → 24/28, the bottom band 28/28 → 16/22,
  // buttons 58 → 46 (the big one 68 → 54). Nothing comes closer to the edge
  // than the 5% overscan inset.
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.pageX,
    paddingTop: 24,
    paddingBottom: 28,
  },
  titleWrap: {flex: 1},
  // .player-title's text-shadow. Without it the heading and the episode line sit
  // unreadably on a bright frame — a sky, a snow scene — because the scrim alone
  // is a gradient, not a backing plate.
  title: {
    color: colors.white,
    fontSize: fontSize.row,
    fontWeight: '800',
    letterSpacing: -0.3,
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowOffset: {width: 0, height: 1},
    textShadowRadius: 10,
  },
  subtitle: {
    color: colors.textDim,
    fontSize: fontSize.small,
    fontWeight: '600',
    marginTop: 1,
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowOffset: {width: 0, height: 1},
    textShadowRadius: 10,
  },
  badgeRow: {flexDirection: 'row', gap: spacing.sm, marginTop: 6},
  badge: {
    color: '#60a5fa',
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 1.4,
    borderWidth: 1,
    borderColor: 'rgba(96,165,250,0.3)',
    backgroundColor: 'rgba(96,165,250,0.12)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    overflow: 'hidden',
  },
  // A slimmer bar (elia): 32dp less than it was — top padding 44 → 28, the
  // gaps under the track and above the buttons tightened. The bottom padding
  // stays at the 5% overscan inset (27dp on a 540dp panel), so nothing moves
  // closer to the edge of the screen than it was allowed to be.
  bottom: {paddingHorizontal: spacing.pageX, paddingTop: 16, paddingBottom: 22},
  // .scrub-row — the times sit either side of the bar, tabular, dim.
  scrubRow: {flexDirection: 'row', alignItems: 'center', gap: 12},
  // .scrubber { height: 22px; display:flex; align-items:center }
  scrubber: {flex: 1, height: 22, justifyContent: 'center', borderRadius: radius.s},
  // .scrubber-track, and `.scrubber:focus .scrubber-track { height: 8px }`.
  // glass.css .scrubber-track: 6dp, 8 with focus; NOT clipped, the head bead
  // hangs over the end of the fill.
  track: {
    height: 6,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.22)',
  },
  trackTall: {height: 8},
  // .scrubber-marks i — a 3px white tick with a dark hairline around it.
  mark: {
    position: 'absolute',
    top: -3,
    bottom: -3,
    width: 3,
    marginLeft: -1,
    borderRadius: 2,
    backgroundColor: '#ffffff',
    boxShadow: '0 0 0 1px rgba(0,0,0,0.55)',
  },
  // The intro range: a pale band on the track between its two ticks.
  introBand: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    backgroundColor: 'rgba(255,255,255,0.35)',
  },
  trackBuffer: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(255,255,255,0.25)',
    borderRadius: 3,
  },
  // .scrubber-fill — the site's violet → cyan → mint ramp with a mint glow.
  trackFill: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    borderRadius: 3,
    backgroundColor: '#8cffbe',
    experimental_backgroundImage: 'linear-gradient(90deg, #8b7bff, #7fd1e8, #8cffbe)',
    boxShadow: '0 0 14px rgba(140,255,190,0.5)',
  },
  // .scrubber-fill::after — a 16px white bead with a soft ring and glow,
  // centred on the end of the fill; it grows a little while the bar has focus.
  head: {
    position: 'absolute',
    right: -7,
    top: '50%',
    marginTop: -7,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#ffffff',
    boxShadow: '0 0 0 4px rgba(255,255,255,0.22), 0 0 24px rgba(140,255,190,0.7)',
  },
  headBig: {right: -8, marginTop: -8, width: 16, height: 16, borderRadius: 8},
  time: {color: colors.textDim, fontSize: 13, fontWeight: '700', minWidth: 44, fontVariant: ['tabular-nums']},
  timeRight: {textAlign: 'right'},
  buttons: {flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: 6},
  // .pbtn — a circle, transparent until focused. The bg is transparent rather
  // than a surface colour so the buttons read as floating over the picture.
  pbtn: {
    width: 46,
    height: 46,
    borderRadius: 999,
    backgroundColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // .pbtn.big — transparent like the rest; the white fill is the FOCUS state,
  // not a permanent one. Only the glyph is larger (34 vs 26 on the site).
  pbtnBig: {
    width: 54,
    height: 54,
    borderRadius: 999,
    backgroundColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // .pbtn-label .lbl — the current rate, tucked under the icon.
  pbtnBadge: {position: 'absolute', bottom: 4, color: colors.white, fontSize: 10, fontWeight: '900'},
  pbtnBadgeOn: {color: colors.bg},
  // .vol-group's slider. Focusable rather than decorative so the remote can
  // reach it; the fill is the level. Collapsed to nothing until the group has
  // focus, matching .vol-slider's `width: 0; opacity: 0` -> `width: 90px`.
  volWrap: {width: 0, height: 46, justifyContent: 'center', opacity: 0},
  volWrapOpen: {width: 96, opacity: 1, paddingHorizontal: 6, marginRight: 8},
  volTrack: {
    height: 5,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.28)',
    overflow: 'hidden',
  },
  volFill: {height: '100%', backgroundColor: colors.white, borderRadius: 3},
  volGroup: {flexDirection: 'row', alignItems: 'center'},
  spacer: {flex: 1},
  // Pill buttons — used by the Up Next card and the error/buffering gates, not
  // by the transport bar (which is circular, matching .pbtn).
  btn: {backgroundColor: colors.surface, paddingVertical: 12, paddingHorizontal: 22},
  btnText: {color: colors.text, fontSize: fontSize.body, fontWeight: '700'},
  btnPrimary: {backgroundColor: colors.white, paddingVertical: 12, paddingHorizontal: 30},
  btnPrimaryText: {color: colors.bg, fontSize: fontSize.body, fontWeight: '800'},
  // .player-flash
  flash: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    width: 104,
    height: 104,
    marginTop: -52,
    marginLeft: -52,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // .skip-indicator
  skipHint: {
    position: 'absolute',
    top: '46%',
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderRadius: 999,
    paddingVertical: 12,
    paddingHorizontal: 28,
  },
  skipHintRight: {right: '12%'},
  skipHintLeft: {left: '12%'},
  skipHintText: {
    color: colors.white,
    fontSize: 32,
    fontWeight: '900',
    textShadowColor: 'rgba(0,0,0,0.8)',
    textShadowOffset: {width: 0, height: 2},
    textShadowRadius: 20,
  },
  // maxHeight is not cosmetic: Speed has six entries and a subtitle list can have
  // many more, and at full height the box grew straight off the top of the screen
  // — the heading was cut in half. Bounded + scrollable handles any track count.
  //
  // The bound has to leave room for its own offset: `bottom` + maxHeight must fit
  // the screen. The Streamer lays out at 540dp, so bottom:160 + 74% (400dp) put
  // the top edge 20dp PAST the top and clipped the heading off — which is the
  // exact bug this maxHeight was added to fix, just at a different size. 60%
  // (324dp) clears it here and on a 720dp set.
  // Smaller popups (elia, 2026-10-06): a narrower, tighter sheet sitting just
  // above the slimmer bar, opaque so no subtitle cue shows through it.
  menu: {
    position: 'absolute',
    right: spacing.pageX,
    bottom: 124,
    maxHeight: '62%',
    // A little of the room's light in the glass (elia, 2026-10-07: "give the
    // background there a bit hue"): the site's violet from the top-left, the
    // aurora's green from the foot, over a near-opaque navy.
    backgroundColor: 'rgba(16,15,30,0.97)',
    experimental_backgroundImage:
      'linear-gradient(140deg, rgba(104,86,226,0.30) 0%, rgba(16,15,30,0) 48%, rgba(70,200,150,0.20) 100%)',
    borderRadius: radius.l,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    minWidth: 280,
    maxWidth: 400,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    borderTopColor: 'rgba(255,255,255,0.20)',
  },
  menuScroll: {flexGrow: 0},
  menuTitleRow: {flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: spacing.sm, marginLeft: 12},
  menuTitle: {
    color: colors.textDim,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 2,
  },
  // Row, not a plain block: the site's entries put a value tag on the right.
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    // No justifyContent: the ✓ column and the tag's auto margin do the spacing,
    // and space-between would fight both. The gap still matters — without it a
    // long label shrinks until it touches its own value ("Autoplay next
    // episodeOn").
    gap: spacing.sm,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginBottom: 1,
  },
  menuTitleGap: {marginTop: spacing.md},
  // Wraps by WHOLE items, never inside one: with `flex: 1` cells in a 280dp
  // sheet the labels broke mid-word ("−0.5 / s", "Res / et" — Mi TV,
  // 2026-10-09). Each cell now keeps its label's width (flexShrink 0) and
  // grows into spare room; the sheet widens up to its maxWidth, and anything
  // still left over moves to a second line as a whole cell.
  syncRow: {flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.xs, marginBottom: spacing.sm},
  syncBtn: {
    flexGrow: 1,
    flexShrink: 0,
    minWidth: 52,
    paddingHorizontal: 8,
    backgroundColor: colors.surface,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  syncBtnText: {color: colors.text, fontSize: fontSize.small, fontWeight: '800'},
  // The ✓ column. Present on every row (transparent when off) so labels align —
  // the site reserves 13px the same way.
  menuCheck: {width: 18, color: colors.text, fontSize: fontSize.small, fontWeight: '800'},
  menuCheckOff: {opacity: 0},
  // .sub-sync .tag — the current delay, sitting between the two pairs of nudges.
  syncValue: {
    minWidth: 62,
    flexShrink: 0,
    textAlign: 'center',
    color: colors.text,
    fontSize: fontSize.small,
    fontWeight: '800',
  },
  // .menu-item .tag { margin-left: auto }
  menuTag: {color: colors.textFaint, fontSize: 12, fontWeight: '700', marginLeft: 'auto'},
  // NOT flex:1. The tag is pushed right by its own auto margin (which is what
  // the site does), because a flexing label shrinks to whatever the box already
  // is instead of making the box wide enough — "Resync subtitles" came out as
  // "Resync sub…" inside a menu with room to spare.
  menuItemText: {color: colors.textDim, fontSize: fontSize.small, fontWeight: '700', flexShrink: 1},
  menuItemTextOn: {color: colors.text},
  upNext: {
    position: 'absolute',
    right: spacing.pageX,
    bottom: 60,
    backgroundColor: 'rgba(13,14,24,0.97)',
    borderRadius: radius.l,
    padding: spacing.lg,
    maxWidth: 460,
    borderWidth: 1,
    borderColor: colors.line,
  },
  upNextKicker: {color: colors.accent, fontSize: fontSize.small, fontWeight: '900', letterSpacing: 2},
  upNextTitle: {
    color: colors.text,
    fontSize: fontSize.row,
    fontWeight: '800',
    marginVertical: spacing.sm,
  },
  upNextActions: {flexDirection: 'row', gap: spacing.md, marginTop: spacing.sm},
  errorText: {
    color: colors.text,
    fontSize: fontSize.row,
    fontWeight: '700',
    textAlign: 'center',
    paddingHorizontal: spacing.xl,
  },
  exitBtn: {backgroundColor: colors.surface, paddingVertical: 12, paddingHorizontal: 32},
  exitText: {color: colors.text, fontSize: fontSize.body, fontWeight: '700'},
  // .party-pill — in the party: how many, and the code, beside the title.
  partyPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(139,123,255,0.28)',
    borderWidth: 1,
    borderColor: 'rgba(139,123,255,0.5)',
    borderRadius: radius.pill,
    paddingVertical: 6,
    paddingHorizontal: 14,
  },
  partyPillText: {color: colors.white, fontSize: fontSize.small, fontWeight: '800', letterSpacing: 1},
  partyCode: {color: colors.text, fontSize: 40, fontWeight: '900', letterSpacing: 6, marginBottom: spacing.sm},
  partyHint: {color: colors.textDim, fontSize: fontSize.small, lineHeight: 20, marginBottom: spacing.md},
  // .skip-intro — a white key, bottom right, above the transport when it is up.
  skipIntro: {
    position: 'absolute',
    right: spacing.pageX,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.white,
    paddingVertical: 11,
    paddingHorizontal: 22,
  },
  skipIntroText: {color: colors.bg, fontSize: fontSize.body, fontWeight: '800'},
  // .resume-card — the frame, the time, Start over.
  resumeCard: {
    position: 'absolute',
    left: spacing.pageX,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    // Toned down: quieter plate, no bright top edge, tighter padding, a
    // thumbnail-sized frame and smaller type — there if you look for it,
    // out of the way of the picture if you don't.
    backgroundColor: 'rgba(13,14,24,0.72)',
    borderRadius: radius.l,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 6,
    paddingRight: spacing.sm,
    opacity: 0.92,
  },
  resumeFrame: {width: 80, height: 45, borderRadius: radius.s, backgroundColor: colors.bgRaised},
  resumeText: {minWidth: 70},
  resumeK: {color: colors.textDim, fontSize: 9, fontWeight: '800', letterSpacing: 1.4},
  resumeT: {color: colors.text, fontSize: fontSize.body, fontWeight: '800', marginTop: 1},
  resumeBtn: {backgroundColor: colors.surface, paddingVertical: 7, paddingHorizontal: 14},
  resumeBtnText: {color: colors.textDim, fontSize: 13, fontWeight: '700'},
  // The site's .toast, pinned above the transport bar so it never covers it.
  toast: {
    position: 'absolute',
    bottom: 24,
    alignSelf: 'center',
    maxWidth: '70%',
    backgroundColor: 'rgba(13,14,24,0.94)',
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    paddingVertical: 10,
    paddingHorizontal: 22,
  },
  toastText: {color: colors.text, fontSize: fontSize.body, fontWeight: '700', textAlign: 'center'},
  // The ::cue box. Centred, never wider than the safe area, and word-wrapped —
  // a two-line Hebrew cue is normal.
  cueWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    paddingHorizontal: '10%',
  },
  cueText: {
    color: colors.white,
    fontWeight: '700',
    textAlign: 'center',
    paddingHorizontal: 12,
    paddingVertical: 2,
    overflow: 'hidden',
    borderRadius: 4,
  },
  // `::cue { background: rgba(0,0,0,.75) }` — the site's default.
  cueBg: {backgroundColor: 'rgba(0,0,0,0.75)'},
  // With the plate off, the text still has to survive a bright frame.
  cueShadow: {
    textShadowColor: 'rgba(0,0,0,0.95)',
    textShadowOffset: {width: 0, height: 2},
    textShadowRadius: 8,
  },
});

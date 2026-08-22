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
  OnLoadData,
  OnProgressData,
  SelectedTrack,
  SelectedTrackType,
  VideoRef,
} from 'react-native-video';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import Focusable from '../components/Focusable';
import Icon, {IconName} from '../components/Icon';
import {api, assetUrl, Item, ProfileState, SubtitleTrack} from '../api';
import {useApp} from '../AppContext';
import {useFocusFallback} from '../focus';
import {canNavigate} from '../navLock';
import {loadPrefs, savePrefs, Prefs, PREFS_DEFAULTS} from '../storage';
import {RootStackParamList} from '../navigation';
import theme from '../theme';

const {colors, radius, fontSize, spacing} = theme;

// The site's .player-top / .player-bottom scrims. RN has no linear-gradient, so
// these are baked PNGs (tools/gen-gradients.js) stretched over each bar. Without
// them the controls sat on flat translucent slabs with a visible top edge — the
// site deliberately fades them out so the chrome floats on the picture.
const SCRIM_TOP = require('../assets/player-top.png');
const SCRIM_BOTTOM = require('../assets/player-bottom.png');

// ---------------------------------------------------------------- constants
// All ported verbatim from player.js.
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const SKIP_STEPS = [10, 10, 10, 30, 60, 60, 120, 300];
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
// Everything the server serves is WebVTT (src/media/subtitles.js converts SRT
// and extracts embedded tracks to it), so one small parser covers every track.
type Cue = {start: number; end: number; text: string};
const parseTs = (s: string): number | null => {
  // hh:mm:ss.mmm, mm:ss.mmm, and the comma form in case an SRT slips through.
  const m = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/.exec(s);
  if (!m) return null;
  return (
    (m[1] ? parseInt(m[1], 10) : 0) * 3600 +
    parseInt(m[2], 10) * 60 +
    parseInt(m[3], 10) +
    parseInt(m[4].padEnd(3, '0'), 10) / 1000
  );
};
const parseVtt = (raw: string): Cue[] => {
  const out: Cue[] = [];
  for (const block of raw.replace(/\r\n?/g, '\n').split(/\n\s*\n+/)) {
    const lines = block.split('\n').filter(l => l.trim() !== '');
    // The header, NOTE and STYLE blocks have no timing line; skipping on that
    // rather than on position also tolerates a cue id above the timings.
    const i = lines.findIndex(l => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->');
    const start = parseTs(a);
    const end = parseTs(b);
    if (start == null || end == null) continue;
    const text = lines
      .slice(i + 1)
      .join('\n')
      // <i>/<b>/<c.classname>/<v Speaker> markup, and ASS override blocks that
      // survive a sloppy conversion. RN's Text can't do inline styling from a
      // string, and a visible "<i>" is worse than losing the italics.
      .replace(/<[^>]*>/g, '')
      .replace(/\{\\[^}]*\}/g, '')
      .trim();
    if (text) out.push({start, end, text});
  }
  // Some tracks ship out of order; the renderer's cursor assumes sorted cues.
  out.sort((x, y) => x.start - y.start);
  return out;
};

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
  const cursor = useRef(0);
  useEffect(() => {
    cursor.current = 0;
    if (!cues || !cues.length) {
      setText('');
      return;
    }
    const tick = () => {
      const t = timeRef.current() - offset;
      let i = cursor.current;
      // A backward seek moves the clock behind the cursor; restart from 0 (once,
      // then the walk below is amortised to nothing).
      if (i >= cues.length || cues[i].start > t) i = 0;
      while (i < cues.length && cues[i].end < t) i++;
      cursor.current = i;
      const c = i < cues.length && cues[i].start <= t ? cues[i] : null;
      const next = c ? c.text : '';
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
const MenuItem = React.forwardRef<
  View,
  {
    label: string;
    tag?: string;
    on?: boolean;
    hasTVPreferredFocus?: boolean;
    onPress: () => void;
    onFocusChange?: (f: boolean) => void;
  }
>(function PlayerMenuItem({label, tag, on, hasTVPreferredFocus, onPress, onFocusChange}, ref) {
  return (
    <Focusable
      ref={ref}
      round
      noScale
      ring="none"
      highlightColor={colors.surfaceHover}
      hasTVPreferredFocus={hasTVPreferredFocus}
      onFocusChange={onFocusChange}
      onPress={onPress}
      style={styles.menuItem}>
      <Text style={[styles.menuCheck, !on && styles.menuCheckOff]}>✓</Text>
      <Text style={[styles.menuItemText, on && styles.menuItemTextOn]} numberOfLines={1}>
        {label}
      </Text>
      {tag ? <Text style={styles.menuTag}>{tag}</Text> : null}
    </Focusable>
  );
});

// A subtitle track as the player uses it: the server's track plus `key`, a
// stable unique id for the menu and the current selection. Duplicate labels are
// numbered so two tracks can never share a key.
type Track = SubtitleTrack & {key: string};
const buildTracks = (subs: SubtitleTrack[]): Track[] => {
  const seen = new Map<string, number>();
  const out: Track[] = [];
  const urls = new Set<string>();
  for (const [i, t] of subs.entries()) {
    if (!t || !t.url || urls.has(t.url)) continue; // the same file twice is noise
    urls.add(t.url);
    const base = t.label || `Track ${i + 1}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    out.push({...t, label: base, key: n > 1 ? `${base} (${n})` : base});
  }
  return out;
};

// Which subtitle track to switch on by itself — the web's autoTrackIndex,
// honouring the same stored Preferences.
const SUB_LANG_TEST: Record<string, {code: RegExp; label: RegExp}> = {
  he: {code: /^(he|heb|iw)/i, label: /hebrew|עבר/i},
  en: {code: /^(en|eng)/i, label: /english/i},
};
const autoTrack = (tracks: Track[], prefs: Prefs): Track | null => {
  if (!tracks.length) return null;

  // WHAT YOU PICKED LAST TIME WINS, over everything below.
  //
  // Without this, every episode came up on whatever the generic rules chose, so
  // a viewer who wants the second Hebrew track (because the first one is out of
  // sync, which is common — see the resync row) re-picked it at the top of every
  // single episode. Autoplay makes that worse, not better: the next episode
  // starts by itself and the subtitles are wrong again.
  //
  // Matching is by LANGUAGE, not by track identity, because the next episode's
  // subtitles are a different file from a different uploader — there is no id to
  // carry over. Label is the fallback for tracks whose lang field is empty.
  if (prefs.lastSubSet) {
    // An explicit "off" carries over too. Someone who turned subtitles off meant
    // it, and `lastSubSet` is what tells that apart from a fresh install.
    if (!prefs.lastSubLang && !prefs.lastSubLabel) return null;
    const sameLang =
      prefs.lastSubLang &&
      tracks.find(t => (t.lang || '').toLowerCase() === prefs.lastSubLang!.toLowerCase());
    if (sameLang) return sameLang;
    const sameLabel =
      prefs.lastSubLabel &&
      tracks.find(t => (t.label || '').toLowerCase() === prefs.lastSubLabel!.toLowerCase());
    if (sameLabel) return sameLabel;
    // Remembered a language this release simply does not have. Fall through to
    // the generic rules rather than showing nothing.
  }

  if (!prefs.subsDefault) return null;
  const match = (want: string) => {
    const test = SUB_LANG_TEST[want];
    if (!test) return null;
    return (
      tracks.find(t => test.code.test(t.lang || '') || test.label.test(t.label || '')) || null
    );
  };
  // The viewer's chosen language wins. With 'any' the web falls back to the
  // first track; here Hebrew is tried first, because that is what this household
  // watches with and what the previous build hard-coded — a strict port would
  // have silently changed the default to whatever track happens to be first.
  return match(prefs.subLang) || match('he') || tracks[0];
};

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
  }
>(function PlayerButton(
  {icon, label, big, badge, hasTVPreferredFocus, onPress, onFocusChange},
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
      onPress={onPress}
      style={big ? styles.pbtnBig : styles.pbtn}>
      <Icon name={icon} size={big ? 34 : 26} color={focused ? colors.bg : colors.white} />
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
  const {id, title, stream, restart} = route.params;
  const isTorrent = !!stream;
  const {profileId} = useApp();
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
  const [menu, setMenu] = useState<null | 'cc' | 'speed' | 'settings'>(null);
  const menuOpen = menu !== null;
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
  const [upNext, setUpNext] = useState<{
    id: string;
    title: string;
    countdown: number | null;
  } | null>(null);

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
  // transcode AT the target, and the player's own clock is relative to it.
  const streamOffset = useRef(0);
  const localDur = useRef(0);
  const usingTranscodeRef = useRef(false);
  const currentV = useRef<'copy' | 'h264'>('copy');
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
  const autoSubsApplied = useRef(false);
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
  const focusSink = useRef({requestTVFocus: () => {}});
  useFocusFallback(focusSink);
  // uri, mirrored for callbacks that fire before ANY source is armed: a skip
  // pressed on the loading screen must not cancel the arming probe (see skip).
  const uriRef = useRef<string | null>(null);
  // prefs, mirrored for callbacks that must not run side effects inside a
  // setState updater (savePrefs there could persist a render React discarded).
  const prefsRef = useRef<Prefs>(PREFS_DEFAULTS);
  const pauseBtnRef = useRef<any>(null);
  // Which part of the chrome holds focus. The web decides whether left/right
  // seeks by asking whether the focused element is inside .player-controls or a
  // menu; there is no DOM to ask here, so each focusable claims its zone. Only
  // the gaining element writes (something is always focused while the chrome is
  // up), so no blur/focus ordering race can leave this stale.
  const zone = useRef<'scrub' | 'row' | 'menu' | 'top' | null>(null);
  const markZone = useCallback(
    (z: 'scrub' | 'row' | 'menu' | 'top') => (focused: boolean) => {
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
  }, []);

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
  const togglePlay = useCallback(() => {
    const next = !pausedRef.current;
    setPaused(next);
    setFlashPaused(next);
    flashAnim.setValue(0);
    Animated.timing(flashAnim, {
      toValue: 1,
      duration: 500,
      useNativeDriver: true,
      isInteraction: false,
    }).start();
    showControls();
  }, [flashAnim, showControls]);

  const closeMenu = useCallback(() => {
    setMenu(null);
    showControls();
    setTimeout(() => pauseBtnRef.current?.requestTVFocus?.(), 0);
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
          const head = await fetch(url, {headers: {Range: 'bytes=0-1'}, signal: ctrl.signal});
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
          headers: {Range: `bytes=${byte}-${end}`},
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
    (base: string, ss: number, v: 'copy' | 'h264') =>
      `${assetUrl(base)}/${Math.max(0, Math.floor(ss || 0))}/index.m3u8?v=${v}`,
    [],
  );

  // The web's startTranscode. `claim` fires the &seek=1 request that tells the
  // server the VIEWER chose this position — the only kind of request allowed to
  // retire the job still running at the previous offset. Without it the old
  // ffmpeg keeps its slot and the next seek is answered with "busy
  // transcoding". ExoPlayer is handed the URL WITHOUT the flag, exactly as
  // hls.js is.
  const startTranscode = useCallback(
    (base: string, offset: number, v: 'copy' | 'h264', claim = true) => {
      const ss = Math.max(0, Math.floor(offset || 0));
      streamOffset.current = ss;
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
      if (claim) fetch(`${url}&seek=1`).catch(() => {});
      setUri(`${url}&g=${++gen.current}`);
    },
    [transcodeUrl],
  );

  // Restart the transcode at an absolute content time — but PROBE the playlist
  // first, so a point the server can't serve yet (bytes not downloaded, or a
  // busy concurrency cap) leaves current playback untouched instead of killing
  // it. Resolves true if playback was switched, false if the point isn't ready.
  const startTranscodeAt = useCallback(
    async (
      base: string,
      target: number,
      v: 'copy' | 'h264',
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
      const ctrl = new AbortController();
      const probeTimer = setTimeout(() => ctrl.abort(), 45000);
      try {
        const res = await fetch(`${transcodeUrl(base, ss, v)}&seek=1`, {signal: ctrl.signal});
        if (exited.current || token !== probeToken.current) return true;
        if (!res.ok) throw new Error('not ready');
        startTranscode(base, ss, v, false); // the probe already claimed it
        return true;
      } catch {
        if (exited.current || token !== probeToken.current) return true;
        if (fallbackToZero) {
          startTranscode(base, 0, v, false);
          return true;
        }
        return false;
      } finally {
        clearTimeout(probeTimer);
        if (token === probeToken.current) {
          probing.current = false;
          setSeekWait(null);
        }
      }
    },
    [startTranscode, transcodeUrl],
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
        let st: ProfileState | null = null;
        try {
          st = await api.state(profileId);
        } catch {}
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
          const p = restart ? null : st.progress?.[id];
          if (
            p &&
            !p.finished &&
            p.position > 10 &&
            (!it.duration || p.position < it.duration - 20)
          ) {
            resumeAt.current = Math.floor(p.position);
          }
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
              )
              .then(r => live && addSubs(r.subtitles || []))
              .catch(() => {});
          }
        } else {
          const it = await api.item(id, profileId);
          if (!live) return;
          if (!it.videoUrl && !it.transcodeBase) {
            setError('This title has no playable file.');
            return;
          }
          // `restart` (Detail's "Start over") means ignore the saved position.
          const p = restart ? null : st.progress?.[id];
          if (
            p &&
            !p.finished &&
            p.position > 10 &&
            (!it.duration || p.position < it.duration - 20)
          ) {
            resumeAt.current = Math.floor(p.position);
          }
          durRef.current = it.duration || 0;
          setDuration(it.duration || 0);
          setMeta({item: it});
          addSubs(it.subtitles || []);
        }
      } catch {
        if (live) setError('Could not load this title.');
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, profileId, restart]);

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
    fetch(kickUrl, {headers: {Range: 'bytes=0-1'}})
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
    } else if (base && ((it.audio && it.audio.compatible === false) || !it.videoUrl)) {
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
      // resuming a remuxed file sit and buffer. (The server upgrades copy->h264
      // for any non-zero start, since it cannot cut a copied stream off a
      // keyframe; the web accepts that trade for the same reason.)
      //
      // No videoUrl at all (never seen in practice, but the gate above only
      // rejects an item with NEITHER) means the transcode is the only route, and
      // a copy can't be assumed to help.
      startTranscode(base, r, it.videoUrl ? 'copy' : 'h264');
    } else {
      setUri(assetUrl(it.videoUrl) as string);
    }
    if (r > 0) toast(`Resuming from ${fmt(r)}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, gateOpen]);

  // ---------------------------------------------------------------- subtitles
  const tracks = useMemo(() => buildTracks(subs), [subs]);
  // Pick a default track the first time any exist — the web's autoTrackIndex,
  // once per title rather than on every media (re)load, so a viewer who turned
  // subtitles off is never overruled by the next seek.
  useEffect(() => {
    if (autoSubsApplied.current || !tracks.length || !prefsLoaded) return;
    autoSubsApplied.current = true;
    console.log(`[player] ${tracks.length} track(s):`, tracks.map(t => t.key).join(' | '));
    const pick = autoTrack(tracks, prefs);
    if (pick) setSubKey(pick.key);
  }, [tracks, prefsLoaded, prefs]);

  // Remember a HAND-PICKED track (or "off") so the next episode comes up the
  // same way — see autoTrack. Only called from the subtitle menu: an automatic
  // pick must never write here, or the preference would be whatever the rules
  // guessed rather than what the viewer actually chose.
  const rememberSub = useCallback((t: Track | null) => {
    // Computed OUTSIDE the updater: savePrefs inside one could run twice or
    // persist a render React discarded.
    const next: Prefs = {
      ...prefsRef.current,
      lastSubLang: t?.lang || null,
      // Label is only worth storing when there is no lang to match on; keeping
      // both would make a remembered "Hebrew" fail on the next episode just
      // because that uploader named the file differently.
      lastSubLabel: t && !t.lang ? t.label || null : null,
      lastSubSet: true,
    };
    prefsRef.current = next;
    setPrefs(next);
    savePrefs(next);
  }, []);

  const subUrl = useMemo(
    () => tracks.find(t => t.key === subKey)?.url || null,
    [tracks, subKey],
  );
  // Load the chosen track's cues. A file that comes back empty is worth saying
  // out loud: on the web an empty track was a silent dead end (browsers never
  // retry one), and "I turned subtitles on and nothing happened" is exactly the
  // report this player exists to stop.
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
    fetch(url)
      .then(r => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then(txt => {
        if (!live) return;
        const parsed = parseVtt(txt);
        console.log(`[player] cues loaded: ${parsed.length} from ${subUrl}`);
        setCues(parsed.length ? parsed : null);
        if (!parsed.length) toast('That subtitle file has no cues — try another track');
      })
      .catch(() => {
        if (!live) return;
        setCues(null);
        toast("That subtitle track couldn't be loaded");
      });
    return () => {
      live = false;
    };
  }, [subUrl, reload, toast]);

  const subOffset = (subKey && subOffsets[subKey]) || 0;
  // The web's nudgeSubs: positive = subtitles later. Applied by looking cues up
  // at (clock - offset), so nothing about the parsed file is ever mutated and
  // repeated nudges can't accumulate error.
  const nudgeSubs = useCallback(
    (delta: number) => {
      if (!subKey) return;
      setSubOffsets(prev => {
        const next = Math.round(((prev[subKey] || 0) + delta) * 10) / 10;
        return {...prev, [subKey]: next};
      });
      showControls();
    },
    [subKey, showControls],
  );
  // The site's resyncSubs, and deliberately the nuclear option there too: throw
  // the loaded cues away, re-download the file, and drop the manual delay. It
  // exists for "the subs look off and I don't want to fiddle with ±0.5s" — one
  // press, and it says what it did rather than leaving you guessing.
  const resyncSubs = useCallback(() => {
    if (!subKey) return;
    setSubOffsets(prev => ({...prev, [subKey]: 0}));
    setReload(n => n + 1);
    toast(`“${subKey}” re-downloaded, delay reset to 0.0s`);
  }, [subKey, toast]);

  // uri + bufferConfig + minLoadRetryCount in ONE memo, because that is exactly
  // what react-native-video folds into one native source (rule 1). Anything
  // unmemoised here is a fresh source — and a reload from zero — on every
  // scrubber tick.
  const source = useMemo(
    () => (uri ? {uri, bufferConfig: BUFFER_CONFIG, minLoadRetryCount: MIN_LOAD_RETRY} : undefined),
    [uri],
  );

  // ---------------------------------------------------------------- seeking
  const totalDuration = useCallback(() => durRef.current || 0, []);

  const commitSeek = useCallback(async () => {
    if (pendingSeek.current == null) return;
    const target = pendingSeek.current;
    pendingSeek.current = null;
    const base = itemRef.current?.transcodeBase || stream?.transcodeBase;

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
      const edge = streamOffset.current + localDur.current;
      if (target < streamOffset.current || target >= edge + 4) {
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
          if (curRef.current > streamOffset.current + 5) resumeAt.current = curRef.current;
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
    // Native seeks are in PLAYLIST time: content time minus the offset the
    // playlist started at.
    videoRef.current?.seek(Math.max(0, target - streamOffset.current));
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

  // ---------------------------------------------------------------- input
  const onTV = useCallback(
    (evt: {eventType: string}) => {
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
      if (menuOpen || upNext) return; // the overlay's own focusables handle it
      if (!controls) {
        if (t === 'left') return skip(-1);
        if (t === 'right') return skip(1);
        if (t === 'select') return togglePlay();
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
    [controls, menuOpen, upNext, skip, togglePlay, showControls],
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
      return false; // picture is clean — let navigation pop
    });
    return () => sub.remove();
  }, [menuOpen, upNext, controls, uri, error, closeMenu, dismissUpNext]);

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

  const saveProgress = useCallback(() => {
    // Never write over a history we could not read (see the load effect).
    if (progressReadFailed.current) return;
    const pos = curRef.current;
    const dur = durRef.current;
    if (!pos || !dur) return;
    api.saveProgress(profileId, id, pos, dur, streamMeta()).catch(() => {});
  }, [id, profileId, streamMeta]);

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
          fetch(transcodeUrl(base, streamOffset.current, currentV.current)).catch(() => {});
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
      if (curRef.current > streamOffset.current + 5) resumeAt.current = curRef.current;
      setUri(`${transcodeUrl(base, streamOffset.current, currentV.current)}&g=${++gen.current}`);
    }, 5000);
    return () => clearInterval(iv);
  }, [stream, transcodeUrl]);

  // ---------------------------------------------------------------- Up Next
  const showUpNext = useCallback(async () => {
    if (upNextShown.current) return;
    const it = itemRef.current;
    if (!it?.showId) return;
    upNextShown.current = true;
    try {
      const show = await api.item(it.showId, profileId);
      const flat = (show.seasons || []).flatMap(s => s.episodes);
      const i = flat.findIndex(e => e.id === id);
      const next = i >= 0 ? flat[i + 1] : null;
      if (!next || exited.current) return;
      const label = `S${next.season} E${next.episode} · ${next.title || ''}`.trim();
      const auto = prefs.autoplayNext;
      setUpNext({id: next.id, title: label, countdown: auto ? 15 : null});
      setControls(true);
      if (auto) {
        if (countdownTimer.current) clearInterval(countdownTimer.current);
        countdownTimer.current = setInterval(() => {
          setUpNext(prev => {
            if (!prev || prev.countdown == null) return prev;
            return {...prev, countdown: prev.countdown - 1};
          });
        }, 1000);
      }
    } catch {
      upNextShown.current = false; // transient — later ticks retry
    }
  }, [id, prefs.autoplayNext, profileId]);

  const playUpNext = useCallback(() => {
    if (advancing.current || !upNext) return; // guard against OK double-firing
    advancing.current = true;
    if (countdownTimer.current) clearInterval(countdownTimer.current);
    const target = upNext;
    setUpNext(null);
    saveProgress();
    navigation.replace('Player', {id: target.id, title: target.title});
  }, [navigation, saveProgress, upNext]);
  // The countdown reaching zero is the autoplay. Driven off state rather than
  // from inside the interval so it can never fire twice.
  useEffect(() => {
    if (upNext && upNext.countdown != null && upNext.countdown <= 0) playUpNext();
  }, [upNext, playUpNext]);

  // ---------------------------------------------------------------- video events
  const onLoad = (d: OnLoadData) => {
    // A still-transcoding HLS playlist reports only what has been written so far
    // and it keeps growing, so the metadata runtime is the honest total. This
    // mirrors the web's totalDuration().
    localDur.current = d.duration || 0;
    const dur = Math.max(
      streamOffset.current + localDur.current,
      itemRef.current?.duration || 0,
    );
    durRef.current = dur;
    setDuration(dur);
    setBuffering(false);
    // The new stream's clock is valid from here, so the held seek target can
    // hand the scrubber back to it without the bar ever stepping backwards.
    setSeekPreview(null);
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
        videoRef.current?.seek(Math.max(0, r - streamOffset.current));
        curRef.current = r;
        progTime.current = r;
        progAt.current = Date.now();
        setCurrent(r);
      }
    }
  };

  const onProgress = (d: OnProgressData) => {
    const content = streamOffset.current + d.currentTime;
    curRef.current = content;
    // Re-anchor the cue clock (see timeRef): the interpolation between these
    // events is what keeps subtitles on the frame rather than up to a second out.
    progTime.current = content;
    progAt.current = Date.now();
    bufRef.current = streamOffset.current + (d.playableDuration || 0);
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
      const grown = streamOffset.current + d.seekableDuration;
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
    if (durRef.current && durRef.current - content < 30 && itemRef.current?.showId) {
      showUpNext();
    }
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
          // No saveProgress here: playUpNext saves, and the goBack path saves
          // in the unmount cleanup — a third call was just a duplicate POST.
          if (upNext) {
            playUpNext();
            return;
          }
          if (navigation.isFocused()) navigation.goBack();
        });
        return;
      }
      // Budget spent: accept this as the actual end of the title.
    }
    saveProgress();
    if (upNext) return playUpNext();
    // isFocused guard: a spurious second end event (or one arriving after the
    // user already backed out) must not pop an extra screen off the stack.
    if (navigation.isFocused()) navigation.goBack();
  };

  const onError = (e?: {error?: {errorString?: string; errorException?: string}}) => {
    const detail = `${e?.error?.errorString || ''} ${e?.error?.errorException || ''}`;
    console.log('[player] error:', detail);
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
          if (curRef.current > streamOffset.current + 5) resumeAt.current = curRef.current;
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
      if (!everPlayed.current && !triedH264.current && currentV.current !== 'h264') {
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
        if (curRef.current > streamOffset.current + 5) resumeAt.current = curRef.current;
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
      setError('Lost the stream. Press Back and pick the source again.');
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
      savePrefs(next);
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

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{error}</Text>
        <Focusable
          round
          hasTVPreferredFocus
          onPress={() => canNavigate(navigation) && navigation.goBack()}
          style={styles.exitBtn}>
          <Text style={styles.exitText}>Back</Text>
        </Focusable>
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
  // Second line under the title, composed the way the site composes it:
  // "S1 E4 · Episode Title" for an episode, else the year.
  const epSeason = itemRef.current?.season ?? stream?.season;
  const epEpisode = itemRef.current?.episode ?? stream?.episode;
  const subtitleText =
    epSeason && epEpisode
      ? `S${epSeason} E${epEpisode}${itemRef.current?.title ? ` · ${itemRef.current.title}` : ''}`
      : itemRef.current?.year
      ? String(itemRef.current.year)
      : '';

  return (
    <View style={styles.root}>
      <Video
        ref={videoRef}
        source={source}
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
        onProgress={onProgress}
        onEnd={onEnd}
        onError={onError}
        onBuffer={({isBuffering}) => setBuffering(isBuffering)}
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
        bottom={controls ? 230 : 48}
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
        <View style={styles.controls} pointerEvents="box-none">
          {/* box-none, not none: the Back button inside is a real focus target,
              same as the site's .player-top back button. */}
          <View style={styles.topBar} pointerEvents="box-none">
            <View style={styles.scrim} pointerEvents="none">
              <Image source={SCRIM_TOP} style={styles.scrimImg} resizeMode="stretch" />
            </View>
            <PBtn
              icon="back"
              label="Back"
              onFocusChange={markZone('top')}
              onPress={() => canNavigate(navigation) && navigation.goBack()}
            />
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

          <View style={styles.bottom}>
            <View style={styles.scrim} pointerEvents="none">
              <Image source={SCRIM_BOTTOM} style={styles.scrimImg} resizeMode="stretch" />
            </View>
            {/* Site order: scrubber first, timestamps underneath it. The
                scrubber is FOCUSABLE, exactly as it is on the site
                (`tabindex="0"`, `.scrubber:focus`), and it takes focus when the
                chrome appears — that is what makes "press right to skip" work. */}
            <Focusable
              noScale
              hasTVPreferredFocus={!menuOpen && !upNext}
              onFocusChange={f => {
                setScrubFocused(f);
                if (f) zone.current = 'scrub';
              }}
              onPress={togglePlay}
              style={styles.scrubber}>
              <View style={[styles.track, scrubFocused && styles.trackTall]}>
                <View style={[styles.trackBuffer, {width: `${bufPct}%`}]} />
                <View style={[styles.trackFill, {width: `${pct}%`}]} />
              </View>
            </Focusable>
            <View style={styles.times}>
              <Text style={styles.time}>{fmt(shown)}</Text>
              {/* Centre slot: how much is loaded ahead. Most useful while a
                  torrent fills in; blank once it's all there, like the site. */}
              <Text style={styles.bufferPct}>
                {duration && bufPct < 99.5 ? `${Math.round(bufPct)}% loaded` : ''}
              </Text>
              <Text style={styles.time}>
                {duration ? `-${fmt(Math.max(0, duration - shown))}` : ''}
              </Text>
            </View>
            <View style={styles.buttons}>
              <PBtn
                icon="back10"
                label="Back 10 seconds"
                onFocusChange={markZone('row')}
                onPress={() => skip(-1)}
              />
              <PBtn
                ref={pauseBtnRef}
                big
                icon={paused ? 'play' : 'pause'}
                label="Play/Pause"
                onFocusChange={markZone('row')}
                onPress={togglePlay}
              />
              <PBtn
                icon="forward10"
                label="Forward 10 seconds"
                onFocusChange={markZone('row')}
                onPress={() => skip(1)}
              />
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
                <PBtn
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
                <PBtn
                  icon="cc"
                  label="Subtitles"
                  badge={subKey ? undefined : 'off'}
                  onFocusChange={markZone('row')}
                  onPress={() => setMenu('cc')}
                />
              ) : null}
              {/* Speed keeps the site's icon, but shows the rate underneath when
                  it isn't 1x — otherwise nothing on screen tells you playback is
                  running fast. */}
              <PBtn
                icon="speed"
                label="Speed"
                badge={rate === 1 ? undefined : `${rate}x`}
                onFocusChange={markZone('row')}
                onPress={() => setMenu('speed')}
              />
              <PBtn
                icon="gear"
                label="Settings"
                onFocusChange={markZone('row')}
                onPress={() => setMenu('settings')}
              />
            </View>
          </View>
        </View>
      ) : null}

      {/* Subtitle menu. Focus is trapped inside while it's open — otherwise a
          stray D-pad press wanders to the transport bar behind the overlay. */}
      {menu === 'cc' ? (
        <TVFocusGuideView trapFocusUp trapFocusDown trapFocusLeft trapFocusRight style={styles.menu}>
          <Text style={styles.menuTitle}>SUBTITLES</Text>
          <ScrollView style={styles.menuScroll}>
            {/* The site's first CC entry: one press that drops any manual delay
                and re-downloads the track. Cheap insurance for "the subs look off
                and I don't want to fiddle with ±0.5s". */}
            {subKey ? (
              <MenuItem
                label="⟲  Resync subtitles"
                onFocusChange={markZone('menu')}
                onPress={resyncSubs}
              />
            ) : null}
            <MenuItem
              label="Off"
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
              <MenuItem
                key={t.key}
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
            ))}
            {/* .sub-sync — the site's timing row, in its order: the two nudges
                either side of the CURRENT delay, then Reset. External subtitle
                files are timed for whichever release their uploader had (measured
                across eight tracks of one film, the first cue landed anywhere from
                0.0s to 357.0s), so this is the difference between a usable track
                and a useless one. The menu stays open while you nudge. */}
            {subKey ? (
              <>
                <Text style={[styles.menuTitle, styles.menuTitleGap]}>SUBTITLE TIMING</Text>
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
                      <Text style={styles.syncBtnText}>{`−${Math.abs(d)}s`}</Text>
                    </Focusable>
                  ))}
                  <Text style={styles.syncValue}>
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
                      <Text style={styles.syncBtnText}>{`+${d}s`}</Text>
                    </Focusable>
                  ))}
                  <Focusable
                    round
                    noScale
                    ring="none"
                    highlightColor={colors.surfaceHover}
                    accessibilityLabel="Reset subtitle timing"
                    onFocusChange={markZone('menu')}
                    onPress={() => nudgeSubs(-subOffset)}
                    style={styles.syncBtn}>
                    <Text style={styles.syncBtnText}>Reset</Text>
                  </Focusable>
                </View>
              </>
            ) : null}
          </ScrollView>
        </TVFocusGuideView>
      ) : null}

      {/* Speed — the site's SPEEDS menu. */}
      {menu === 'speed' ? (
        <TVFocusGuideView trapFocusUp trapFocusDown trapFocusLeft trapFocusRight style={styles.menu}>
          <Text style={styles.menuTitle}>SPEED</Text>
          <ScrollView style={styles.menuScroll}>
            {SPEEDS.map(sp => (
              <MenuItem
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
        <TVFocusGuideView trapFocusUp trapFocusDown trapFocusLeft trapFocusRight style={styles.menu}>
          <Text style={styles.menuTitle}>PLAYBACK</Text>
          <MenuItem
            label="Autoplay next episode"
            tag={prefs.autoplayNext ? 'On' : 'Off'}
            hasTVPreferredFocus
            onFocusChange={markZone('menu')}
            onPress={() => setPref('autoplayNext', !prefs.autoplayNext)}
          />
          <Text style={[styles.menuTitle, styles.menuTitleGap]}>SUBTITLE STYLE</Text>
          <MenuItem
            label="Size"
            tag={{S: 'Small', M: 'Medium', L: 'Large'}[prefs.cueSize]}
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
        </TVFocusGuideView>
      ) : null}

      {/* Up Next — focus trapped for the same reason as the subtitle menu. */}
      {upNext ? (
        <TVFocusGuideView trapFocusUp trapFocusDown trapFocusLeft trapFocusRight style={styles.upNext}>
          <Text style={styles.upNextKicker}>UP NEXT</Text>
          <Text style={styles.upNextTitle} numberOfLines={1}>
            {upNext.title}
          </Text>
          <View style={styles.upNextActions}>
            <Focusable
              round
              light
              ring="violet"
              hasTVPreferredFocus
              onFocusChange={markZone('menu')}
              onPress={playUpNext}
              style={styles.btnPrimary}>
              <Text style={styles.btnPrimaryText}>▶  Play now</Text>
            </Focusable>
            <Focusable
              round
              onFocusChange={markZone('menu')}
              onPress={dismissUpNext}
              style={styles.btn}>
              <Text style={styles.btnText}>
                {upNext.countdown != null ? `Dismiss (${upNext.countdown})` : 'Dismiss'}
              </Text>
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
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    paddingHorizontal: spacing.pageX,
    paddingTop: 34,
    paddingBottom: 44,
  },
  titleWrap: {flex: 1},
  // .player-title's text-shadow. Without it the heading and the episode line sit
  // unreadably on a bright frame — a sky, a snow scene — because the scrim alone
  // is a gradient, not a backing plate.
  title: {
    color: colors.white,
    fontSize: fontSize.title,
    fontWeight: '800',
    letterSpacing: -0.3,
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowOffset: {width: 0, height: 1},
    textShadowRadius: 10,
  },
  subtitle: {
    color: colors.textDim,
    fontSize: fontSize.body,
    fontWeight: '600',
    marginTop: 2,
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
  bottom: {paddingHorizontal: spacing.pageX, paddingTop: 44, paddingBottom: 34},
  // .scrubber { height: 22px; display:flex; align-items:center }
  scrubber: {height: 26, justifyContent: 'center', borderRadius: radius.s},
  // .scrubber-track, and `.scrubber:focus .scrubber-track { height: 8px }`.
  track: {
    height: 5,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.22)',
    overflow: 'hidden',
  },
  trackTall: {height: 8},
  trackBuffer: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(255,255,255,0.25)',
  },
  trackFill: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    backgroundColor: colors.white,
    borderRadius: 3,
  },
  times: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
  },
  time: {color: colors.textDim, fontSize: fontSize.small, fontWeight: '700'},
  bufferPct: {color: colors.textFaint, fontSize: fontSize.small, fontWeight: '600'},
  buttons: {flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.md},
  // .pbtn — a circle, transparent until focused. The bg is transparent rather
  // than a surface colour so the buttons read as floating over the picture.
  pbtn: {
    width: 58,
    height: 58,
    borderRadius: 999,
    backgroundColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // .pbtn.big — transparent like the rest; the white fill is the FOCUS state,
  // not a permanent one. Only the glyph is larger (34 vs 26 on the site).
  pbtnBig: {
    width: 68,
    height: 68,
    borderRadius: 999,
    backgroundColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // .pbtn-label .lbl — the current rate, tucked under the icon.
  pbtnBadge: {position: 'absolute', bottom: 6, color: colors.white, fontSize: 11, fontWeight: '900'},
  pbtnBadgeOn: {color: colors.bg},
  // .vol-group's slider. Focusable rather than decorative so the remote can
  // reach it; the fill is the level. Collapsed to nothing until the group has
  // focus, matching .vol-slider's `width: 0; opacity: 0` -> `width: 90px`.
  volWrap: {width: 0, height: 58, justifyContent: 'center', opacity: 0},
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
  menu: {
    position: 'absolute',
    right: spacing.pageX,
    bottom: 160,
    maxHeight: '60%',
    backgroundColor: 'rgba(13,14,24,0.97)',
    borderRadius: radius.l,
    padding: spacing.lg,
    minWidth: 330,
    maxWidth: 480,
    borderWidth: 1,
    borderColor: colors.line,
  },
  menuScroll: {flexGrow: 0},
  menuTitle: {
    color: colors.textDim,
    fontSize: fontSize.small,
    fontWeight: '800',
    letterSpacing: 2,
    marginBottom: spacing.md,
  },
  // Row, not a plain block: the site's entries put a value tag on the right.
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    // No justifyContent: the ✓ column and the tag's auto margin do the spacing,
    // and space-between would fight both. The gap still matters — without it a
    // long label shrinks until it touches its own value ("Autoplay next
    // episodeOn").
    gap: spacing.md,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginBottom: 2,
  },
  menuTitleGap: {marginTop: spacing.md},
  syncRow: {flexDirection: 'row', gap: spacing.xs, marginBottom: spacing.sm},
  syncBtn: {
    flex: 1,
    backgroundColor: colors.surface,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  syncBtnText: {color: colors.text, fontSize: fontSize.small, fontWeight: '800'},
  // The ✓ column. Present on every row (transparent when off) so labels align —
  // the site reserves 13px the same way.
  menuCheck: {width: 22, color: colors.text, fontSize: fontSize.body, fontWeight: '800'},
  menuCheckOff: {opacity: 0},
  // .sub-sync .tag — the current delay, sitting between the two pairs of nudges.
  syncValue: {
    minWidth: 62,
    textAlign: 'center',
    color: colors.text,
    fontSize: fontSize.small,
    fontWeight: '800',
  },
  // .menu-item .tag { margin-left: auto }
  menuTag: {color: colors.textFaint, fontSize: fontSize.small, fontWeight: '700', marginLeft: 'auto'},
  // NOT flex:1. The tag is pushed right by its own auto margin (which is what
  // the site does), because a flexing label shrinks to whatever the box already
  // is instead of making the box wide enough — "Resync subtitles" came out as
  // "Resync sub…" inside a menu with room to spare.
  menuItemText: {color: colors.textDim, fontSize: fontSize.body, fontWeight: '700', flexShrink: 1},
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

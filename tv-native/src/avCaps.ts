// WHAT THIS TV CAN PLAY, said to the server — and what the server decided
// from it (TV round 2026-10-19: direct play, passthrough, refresh-rate
// matching). PURE: no imports, so the logic tests run it as it is; av.ts does
// the native calls, the storage and the sending around it.
//
// The native side (AvModule.kt getCapabilities) reads the box: its hardware
// video decoders and their profiles / sizes / frame rates (MediaCodecList),
// what the screen shows as HDR (Display.HdrCapabilities), the audio it can
// decode and the bitstreams the TV / soundbar takes as they are (the audio
// HAL's direct-playback answer — exactly what ExoPlayer itself asks before it
// passes anything through), and the screen's modes. buildReport turns that
// into the report the server reads (src/media/avcaps.js), minus whatever this
// box has been caught lying about (Lies, below).
//
// The server answers each title with `play` (src/media/playpath.js):
//   direct     the file as it is — no ffmpeg; the sound passed through or
//              decoded here
//   remux      the picture copied, the sound made AAC stereo
//   transcode  the picture re-encoded to H.264
// armPlan / streamPlan read that answer for the player.

/** What AvModule.kt answers (every field optional: an older build, a box that
 *  could not say). */
export type NativeAv = {
  model?: string;
  sdk?: number;
  video?: Record<string, {profiles?: string[]; maxW?: number; maxH?: number; maxFps?: number; maxLevel?: number}>;
  dv?: number[];
  hdr?: string[];
  audioDecode?: string[];
  passthrough?: string[];
  maxChannels?: number;
  display?: {w?: number; h?: number; hz?: number; modes?: number[][]};
};

/** What this box was caught lying about (kept on the box, av.ts): a codec it
 *  said it decodes / passes through, and then could not. `video` entries are
 *  "codec" or "codec:profile" ("hevc:main10"). */
export type Lies = {passthrough?: string[]; decode?: string[]; video?: string[]};

export type CapsReport = {
  client: 'tv';
  model?: string;
  sdk?: number;
  video: Record<string, {profiles?: string[]; maxW?: number; maxH?: number; maxFps?: number; maxLevel?: number}>;
  hdr: string[];
  dv: number[];
  audio: {decode: string[]; passthrough: string[]; maxChannels?: number};
  containers: Record<string, true>;
  display?: {w: number; h: number; hz: number; modes: number[][]};
};

// ExoPlayer opens all of these itself (media3's extractors), whatever is inside.
const CONTAINERS = ['mp4', 'mkv', 'webm', 'ts', 'avi', 'mov'];

const list = (x: unknown): string[] => (Array.isArray(x) ? x.filter(v => typeof v === 'string') : []);

// A codec's profiles, plainest first: a decoder that fails one cannot be
// trusted with any above it (a box whose HEVC Main10 failed plays no Main12
// either; one whose plain H.264 failed plays no H.264 at all).
const PROFILE_ORDER: Record<string, string[]> = {
  h264: ['baseline', 'main', 'high', 'high10', 'high422', 'high444'],
  hevc: ['main', 'main10', 'main12'],
  vp9: ['0', '2', '3'],
  av1: ['main', 'high', 'professional'],
};
/** The profile the decision leaned on, for a file of this codec and depth
 *  (what a decoder failure on it is pinned to). */
export const profileFor = (codec: string | null | undefined, bitDepth: number | null | undefined): string | null => {
  const deep = (bitDepth || 8) > 8;
  switch (codec) {
    case 'h264':
      return deep ? 'high10' : 'high';
    case 'hevc':
      return deep ? 'main10' : 'main';
    case 'vp9':
      return deep ? '2' : '0';
    case 'av1':
      return 'main';
    default:
      return null;
  }
};

/** The report for the server: what the box said, minus what it lied about. */
export const buildReport = (n: NativeAv | null | undefined, lies: Lies = {}): CapsReport => {
  const src = n || {};
  const video: CapsReport['video'] = {};
  const lieVideo = list(lies.video);
  for (const [codec, c] of Object.entries(src.video || {})) {
    if (!c || lieVideo.includes(codec)) continue;
    const order = PROFILE_ORDER[codec] || [];
    // the first lied profile in the codec's order: it and everything above it go
    const cut = order.findIndex(p => lieVideo.includes(`${codec}:${p}`));
    const profiles = list(c.profiles).filter(p => !lieVideo.includes(`${codec}:${p}`) && (cut < 0 || order.indexOf(p) < cut || order.indexOf(p) < 0));
    // a codec whose every listed profile lied is not offered at all
    if (list(c.profiles).length && !profiles.length) continue;
    video[codec] = {...c, profiles};
  }
  const lieDec = list(lies.decode);
  const liePass = list(lies.passthrough);
  // E-AC-3 that cannot be passed through cannot carry Atmos (JOC) through either
  const pass = list(src.passthrough).filter(x => !liePass.includes(x) && !(x === 'eac3-joc' && liePass.includes('eac3')));
  const out: CapsReport = {
    client: 'tv',
    video,
    hdr: list(src.hdr),
    dv: Array.isArray(src.dv) ? src.dv.filter(x => typeof x === 'number') : [],
    audio: {decode: list(src.audioDecode).filter(x => !lieDec.includes(x)), passthrough: pass},
    containers: Object.fromEntries(CONTAINERS.map(c => [c, true as const])),
  };
  if (src.maxChannels) out.audio.maxChannels = src.maxChannels;
  if (src.model) out.model = src.model;
  if (src.sdk) out.sdk = src.sdk;
  const d = src.display;
  if (d && d.w && d.h && d.hz) out.display = {w: d.w, h: d.h, hz: d.hz, modes: Array.isArray(d.modes) ? d.modes.slice(0, 64) : []};
  return out;
};

// ------------------------------------------------------------ the decision
export type Play = {
  v?: number;
  mode: 'direct' | 'remux' | 'transcode';
  video?: 'direct' | 'copy' | 'encode';
  audio?: 'passthrough' | 'decode' | 'convert';
  form?: string;
  decodes?: boolean;
  container?: boolean;
  fps?: number;
  why?: string[];
  tracks?: {index: number; audio: string}[];
  guessed?: boolean;
};

/** A `play` the server sent, read; null when there is none (or it is not one). */
export const readPlay = (x: unknown): Play | null => {
  if (!x || typeof x !== 'object') return null;
  const p = x as Play;
  return p.mode === 'direct' || p.mode === 'remux' || p.mode === 'transcode' ? p : null;
};

/** How a library title starts, by the server's decision: the file itself, the
 *  copy (`copy`), or the encode (`h264`). null = no decision to go by — the
 *  player's own rule stands (Player.tsx arming). A chosen dub other than the
 *  first track always goes through the copy (only the server maps another
 *  track in), whatever the decision. */
export const armPlan = (
  play: Play | null,
  o: {audioIdx: number; hasVideoUrl: boolean; hasBase: boolean},
): 'direct' | 'copy' | 'h264' | null => {
  if (!play || !o.hasBase) return null;
  if (!o.hasVideoUrl) return 'h264';
  if (play.mode === 'transcode') return 'h264';
  if (o.audioIdx > 0) return 'copy';
  return play.mode === 'direct' ? 'direct' : 'copy';
};

/** A torrent source's start, by the server's decision (its release name read
 *  by the same table): what streamPlayItem hands the player. null = the
 *  release-tag rule (playBest.ts) stands. */
export const streamPlan = (play: Play | null): {needsTranscode: boolean; transcodeV: 'copy' | 'h264'} | null => {
  if (!play) return null;
  return {needsTranscode: play.mode !== 'direct', transcodeV: play.mode === 'transcode' ? 'h264' : 'copy'};
};

// ------------------------------------------------------------ the lies
// ExoPlayer's error names (react-native-video sends "ExoPlaybackException:
// ERROR_CODE_…" and the code as "2" + the number).
// (only failures that say "this box cannot", never "these bytes were bad":
// DECODING_FAILED — a damaged file can cause it — is not counted as a lie)
const AUDIO_SINK = /AUDIO_TRACK_(INIT|WRITE)_FAILED|AudioSink\$InitializationException/i;
const DECODER = /DECODER_INIT_FAILED|DECODING_FORMAT_EXCEEDS_CAPABILITIES|DECODING_FORMAT_UNSUPPORTED/i;
const SINK_CODES = ['25001', '25002'];
const DECODER_CODES = ['24001', '24004', '24005'];

/** What a failure BEFORE THE FIRST FRAME of a direct start says this box lied
 *  about, or null (not a codec failure, or one that cannot be pinned down).
 *  `play`: the decision the start was made on; `codec`: the file's video
 *  codec and the profile the decision needed ("hevc", "main10"); `audioCodec`:
 *  the track's codec. */
export const lieFrom = (
  err: {detail?: string; code?: string},
  play: Play | null,
  facts: {videoCodec?: string | null; videoProfile?: string | null; audioCodec?: string | null},
): Lies | null => {
  if (!play || play.mode !== 'direct') return null;
  const detail = String(err.detail || '');
  const code = String(err.code || '');
  const sink = AUDIO_SINK.test(detail) || SINK_CODES.includes(code);
  const dec = !sink && (DECODER.test(detail) || DECODER_CODES.includes(code));
  if (sink) {
    if (play.audio === 'passthrough' && play.form) return {passthrough: [play.form]};
    if (play.audio === 'decode' && facts.audioCodec) return {decode: [facts.audioCodec]};
    return null;
  }
  if (dec) {
    const audioSide = /audio\/|MediaCodecAudioRenderer/i.test(detail);
    const videoSide = /video\/|MediaCodecVideoRenderer/i.test(detail);
    if (audioSide && !videoSide) return play.audio === 'decode' && facts.audioCodec ? {decode: [facts.audioCodec]} : null;
    if (videoSide && facts.videoCodec) return {video: [facts.videoProfile ? `${facts.videoCodec}:${facts.videoProfile}` : facts.videoCodec]};
  }
  return null;
};

/** Two lie lists as one (each entry once). */
export const mergeLies = (a: Lies | null | undefined, b: Lies | null | undefined): Lies => {
  const out: Lies = {};
  for (const k of ['passthrough', 'decode', 'video'] as const) {
    const all = [...new Set([...list(a?.[k]), ...list(b?.[k])])];
    if (all.length) out[k] = all.slice(0, 20);
  }
  return out;
};

// ------------------------------------------------------------ the frame rate
/** Whether this start asks the screen for the film's frame rate: the person
 *  said Auto (the default), the film's rate is known and is a real film rate.
 *  The native side then picks the mode (AvModule.kt / ModePick.kt) — or none,
 *  when the screen has nothing that fits better than what it shows now. */
export const wantsFrameRate = (pref: 'auto' | 'off' | undefined, fps: number | null | undefined): boolean =>
  pref !== 'off' && typeof fps === 'number' && fps >= 10 && fps <= 121;

/** How long the start waits, at most, for a mode switch to settle (the HDMI
 *  blink is 1–3 s; a screen that never says it switched does not hold the
 *  film for longer than this). */
export const FRAME_RATE_WAIT_MS = 5000;
/** After the screen says it switched: this long more before the film starts,
 *  so the first second of picture is not lost to a screen still resyncing. */
export const FRAME_RATE_SETTLE_MS = 1200;

// The player's two clocks, told apart. PURE — no imports; the logic tests run
// it as it is.
//
//   CONTENT time  where we are in the film (the scrubber, the resume point the
//                 server saves, the subtitle cues, Skip intro, a party's sync).
//   MEDIA time    what ExoPlayer reports and seeks in: the position inside the
//                 source it was handed (onProgress currentTime, seek()).
//
// For a direct-played file the two are the same. For a transcode playlist,
// content = clockBase + media, and clockBase is NOT always the offset the job
// was asked for (`ss`, which names the URL — streamOffset in Player.tsx):
//
//   • an ENCODE (v=h264…) or any job at ss = 0 makes a fresh timeline that
//     starts at ss, so clockBase = ss. (What this player always assumed.)
//   • a COPY job at ss > 0 keeps the SOURCE's own timestamps (ffmpeg -copyts,
//     server src/media/remux.js and torrent-transcode.js), and a copied video
//     can only begin at a keyframe — the one at or before ss (measured: asked
//     for 100 → video from 93.75, audio from 99.97). The playlist answer says
//     where segment 0 really begins (X-Aurora-Base, the earliest stream start)
//     and how far into it playback should start (X-Aurora-Offset, also put in
//     the playlist as #EXT-X-START). ExoPlayer — like hls.js on the website
//     (public/js/screens/player.js clockFromHeaders) — maps the first sample
//     of the first segment to position 0 (its TimestampAdjuster), so media 0 is
//     content X-Aurora-Base, not ss. Assuming ss put the scrubber, the saved
//     resume point and every subtitle cue up to a GOP (several seconds) AHEAD
//     of the picture on exactly the files that take this path: EAC3/AC3/DTS
//     audio with a resume point or after a far seek, a second dub, a torrent
//     that needs repackaging.
//
//   (That ExoPlayer rebases to the first sample is reasoned from media3's HLS
//   TimestampAdjuster, the same behaviour hls.js has; it is to be confirmed on
//   the device — see the report that came with this file.)

export type Clock = {base: number; offset: number};

/** The published clock of a copy-at-offset playlist answer, or null when the
 *  answer carries none (an encode, ss = 0, a server too old to send it, or a
 *  probe of the first segment that failed server-side). */
export const clockFromHeaders = (get: (name: string) => string | null | undefined): Clock | null => {
  let base = NaN;
  let offset = NaN;
  try {
    base = parseFloat(String(get('X-Aurora-Base') ?? ''));
    offset = parseFloat(String(get('X-Aurora-Offset') ?? ''));
  } catch {
    return null;
  }
  if (!Number.isFinite(base) || base < 0) return null;
  return {base, offset: Number.isFinite(offset) && offset > 0 ? offset : 0};
};

/** How far below the asked-for offset a copied job may really begin: a GOP.
 *  Real releases run 2-10 s, some HEVC encodes longer; a "base" further away
 *  than this is not this job's keyframe (a server that did not copy the
 *  timestamps answers ~0 for any ss) and the plain offset is the safer clock. */
export const MAX_GOP_SEC = 60;

/** Content time at media position 0 for a job at `ss` with codec `v`. */
export const clockBaseFor = (ss: number, v: string, clock: Clock | null | undefined): number => {
  const s = Math.max(0, Math.floor(ss || 0));
  if (v !== 'copy' || s <= 0 || !clock) return s;
  const b = clock.base;
  if (!Number.isFinite(b) || b > s + 1 || b < s - MAX_GOP_SEC) return s;
  return b;
};

/** media → content */
export const toContent = (clockBase: number, mediaSec: number): number => clockBase + (Number.isFinite(mediaSec) ? mediaSec : 0);
/** content → media (what seek() takes) */
export const toMedia = (clockBase: number, contentSec: number): number => Math.max(0, contentSec - clockBase);

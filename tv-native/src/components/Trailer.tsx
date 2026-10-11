// Trailers, in the app, played by ExoPlayer (react-native-video) — the same
// player as the films. What plays was chosen beforehand (trailers.ts): Apple's
// HLS trailer, or a YouTube trailer resolved on this TV. There is no WebView
// any more (elia, 2026-10-09): the YouTube embed was the heaviest thing this
// app drew (~120-140 MB of renderer on a 2 GB box), picked its quality from
// the player's size, and failed in ways nothing could see.
//
// Mounted only while a trailer runs; none exists at rest.
//
// THE PICTURE IS A SurfaceView — ON THE BILLBOARD TOO. This file used to ask
// for a TextureView there (`viewType={hero ? TEXTURE : SURFACE}`) and said so
// in its comments, and the lab's research took that at its word. On Android,
// react-native-video 6.19.2 ignores the prop: ReactExoplayerViewManager
// .setViewType → ReactExoplayerView.setViewType → ExoPlayerView
// .updateSurfaceView, whose whole body is a TODO (ExoPlayerView.kt:142). The
// view is media3's `PlayerView(context)`, built without attributes, and a
// PlayerView without a `surface_type` attribute makes a SurfaceView
// (media3-ui 1.8.0, PlayerView's constructor: the default is 1,
// SURFACE_TYPE_SURFACE_VIEW; a TextureView only for surface_type 2). So the
// trailer has always composed on its own plane behind a hole in the window,
// and a video frame redraws nothing of ours — the cost the research worried
// about is not there. `viewType` is now SURFACE for both, which changes
// nothing today and is what we want if the library ever honours it.
//
// WHAT FOLLOWS FROM IT BEING A SurfaceView (the film player is one as well):
//  • It sits BELOW the window; what our views draw after it (the billboard's
//    dim, scrim and text; the sheet's head bar) is blended over it by
//    SurfaceFlinger. The window is made translucent by the platform the
//    moment a SurfaceView asks for a transparent region (ViewRootImpl
//    .requestTransparentRegion), so per-pixel alpha above the hole works.
//  • It cannot be alpha-animated by an ancestor's opacity in a way that is
//    the same on every Android: what an ancestor's alpha does to the HOLE
//    differs by version. The billboard's cross-fade is therefore offered a
//    second way that does not depend on it — HERO_TRAILER_COVER below.
//  • Rounded clipping does not reach it (nothing here rounds it). The
//    billboard's 115% frame simply hangs over the window's edges, and
//    resizeMode "cover" enlarges the surface past its box the same way; both
//    are cut by the screen, not by a clip.
//  • The canvas scale (canvas.tsx) reaches it: measured on the Mi TV.
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {StyleSheet, View, ViewStyle, StyleProp} from 'react-native';
import Video, {OnProgressData, OnVideoErrorData, ViewType} from 'react-native-video';
import {refreshTrailer, ResolvedTrailer, trailerPlayFailed} from '../trailers';
import {track} from '../usage';

export type TrailerState = 'ready' | 'playing' | 'paused' | 'ended' | 'error';

/** How the billboard cross-fades between its art and the trailer (Home.tsx).
 *
 *  false — AS IT HAS BEEN: the layer that holds the video animates its
 *  opacity 0 → 1. The video is a SurfaceView behind a hole, so what that
 *  looks like is the platform's doing: the hole is cut by SurfaceView's draw
 *  (a CLEAR / punch-hole op) inside an ancestor that is being drawn with
 *  alpha, and React Native views draw alpha op by op, without an offscreen
 *  layer (ReactViewGroup.hasOverlappingRendering is false unless
 *  needsOffscreenAlphaCompositing). Where the punch-hole op carries alpha
 *  (Android 13/14's RecordingCanvas.punchHole) that is close to a cross-fade,
 *  dipping a little dark half-way; where it does not, the hole opens fully at
 *  the first frame and the "fade" is a cut. Not established on the TV yet.
 *
 *  true — THE ART FADES, ABOVE THE HOLE. The video's layer goes from absent
 *  (opacity 0: no hole) to fully there in one step at the instant playback
 *  starts, and in that same frame a copy of the billboard's art is drawn over
 *  it at full strength — the same picture, so nothing shows — and then fades
 *  out over the 800 ms, and back in over the 700 ms when the trailer ends.
 *  The window above a SurfaceView is blended per pixel, so that is a true
 *  cross-fade on every Android by construction. While no trailer plays the
 *  copy is not drawn (opacity 0), so the billboard at rest is unchanged.
 *
 *  Default false: the two cannot be shown identical from here (the first is
 *  version-dependent). Flip it on the TV, film both fades, keep the better. */
export const HERO_TRAILER_COVER: boolean = false;

// Kept for the callers: the WebView's quality step-down has nothing to do now —
// ExoPlayer adapts on its own, and the caps below bound it.
export const trailerStepDown = () => {};

// What the picture may cost. Apple's playlists go up to 4K HEVC and YouTube's
// renditions to 1080p; a muted billboard behind the UI has no use for more than
// 1080p H.264 (4K decode under the UI dropped the Mi TV to 63% janky frames
// with the old embed), and the sheet stops there too.
const MAX_BITRATE_HERO = 6_000_000;
const MAX_BITRATE_SHEET = 9_000_000;

// 'stop' ends the player's work for good, for an owner that cannot unmount it
// at once (Home, while its screen is frozen on the way out).
export type TrailerHandle = {cmd: (c: 'mute' | 'unmute' | 'pause' | 'play' | 'stop') => void};

const errText = (e: OnVideoErrorData) => {
  const x = (e && (e as {error?: Record<string, unknown>}).error) || {};
  return String(x.errorCode || '') + ' ' + String(x.errorString || x.errorException || x.error || 'player error');
};

export default function TrailerFrame({
  trailer,
  muted,
  style,
  onState,
  handle,
  hero = false,
}: {
  trailer: ResolvedTrailer;
  muted: boolean;
  style?: StyleProp<ViewStyle>;
  onState: (s: TrailerState) => void;
  // Written with a `cmd` the owner can call (mute/unmute) without re-rendering.
  handle?: React.MutableRefObject<TrailerHandle | null>;
  // the billboard: the lower bitrate cap, and no claim on the audio focus
  hero?: boolean;
}) {
  const [src, setSrc] = useState<ResolvedTrailer>(trailer);
  const [mutedNow, setMutedNow] = useState(muted);
  const [paused, setPaused] = useState(false);
  const [stopped, setStopped] = useState(false);
  const started = useRef(false);
  const pos = useRef(0);
  const retried = useRef(false);
  const resumeAt = useRef(0);
  const gone = useRef(false);
  useEffect(() => {
    gone.current = false;
    return () => {
      gone.current = true;
    };
  }, []);
  useEffect(() => setMutedNow(muted), [muted]);

  if (handle) {
    handle.current = {
      cmd: c => {
        if (c === 'mute') setMutedNow(true);
        else if (c === 'unmute') setMutedNow(false);
        else if (c === 'pause') {
          setPaused(true);
          if (started.current) onState('paused');
        } else if (c === 'play') {
          setPaused(false);
          if (started.current) onState('playing');
        }
        else if (c === 'stop') setStopped(true);
      },
    };
  }

  const onProgress = useCallback(
    (p: OnProgressData) => {
      pos.current = p.currentTime || 0;
      if (!started.current && p.currentTime > 0) {
        started.current = true;
        console.log('[trailer] playing', src.source, src.kind, src.quality);
        track('feat', {f: 'trailer_source', s: src.source});
        onState('playing');
      }
    },
    [onState, src],
  );

  const onError = useCallback(
    async (e: OnVideoErrorData) => {
      const reason = errText(e).slice(0, 100);
      console.log('[trailer] player error', src.source, reason);
      // A YouTube stream turned away part-way (403 after about a minute on
      // some videos): resolve the same video again, once, and carry on from
      // where it was.
      if (src.source === 'youtube' && started.current && !retried.current) {
        retried.current = true;
        const at = pos.current;
        const next = await refreshTrailer(src);
        if (gone.current) return;
        if (next) {
          resumeAt.current = at;
          setSrc(next);
          return;
        }
      }
      trailerPlayFailed(src, reason);
      onState('error');
    },
    [onState, src],
  );

  // one object per stream, so a re-render (mute, pause) never looks like a new source
  const source = useMemo(
    () => ({
      uri: src.uri,
      type: src.type,
      headers: src.headers,
      startPosition: resumeAt.current > 0 ? Math.round(resumeAt.current * 1000) : undefined,
    }),
    [src],
  );

  if (stopped) return <View style={[styles.wrap, style]} pointerEvents="none" />;
  return (
    // pointerEvents none + not focusable: the D-pad never lands on the video —
    // the app's own buttons stay in charge.
    <View style={[styles.wrap, style]} pointerEvents="none">
      <Video
        key={src.uri}
        source={source}
        style={styles.video}
        muted={mutedNow}
        volume={mutedNow ? 0 : 1}
        paused={paused}
        repeat={false}
        controls={false}
        resizeMode="cover"
        // (ignored on Android by this version of the library — see the header)
        viewType={ViewType.SURFACE}
        maxBitRate={hero ? MAX_BITRATE_HERO : MAX_BITRATE_SHEET}
        shutterColor="transparent"
        focusable={false}
        // a muted billboard must not take the audio focus from anything
        disableFocus={hero}
        playInBackground={false}
        progressUpdateInterval={500}
        onLoad={() => onState('ready')}
        onProgress={onProgress}
        onEnd={() => onState('ended')}
        onError={onError}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {overflow: 'hidden', backgroundColor: '#000'},
  video: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0},
});

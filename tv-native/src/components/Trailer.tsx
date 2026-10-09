// Trailers, in the app, played by ExoPlayer (react-native-video) — the same
// player as the films. What plays was chosen beforehand (trailers.ts): Apple's
// HLS trailer, or a YouTube trailer resolved on this TV. There is no WebView
// any more (elia, 2026-10-09): the YouTube embed was the heaviest thing this
// app drew (~120-140 MB of renderer on a 2 GB box), picked its quality from
// the player's size, and failed in ways nothing could see.
//
// Mounted only while a trailer runs; none exists at rest.
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {StyleSheet, View, ViewStyle, StyleProp} from 'react-native';
import Video, {OnProgressData, OnVideoErrorData, ViewType} from 'react-native-video';
import {refreshTrailer, ResolvedTrailer, trailerPlayFailed} from '../trailers';
import {track} from '../usage';

export type TrailerState = 'ready' | 'playing' | 'paused' | 'ended' | 'error';

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
  // the billboard: a TextureView (so the cross-fade's opacity reaches the
  // picture — a SurfaceView ignores it) and the lower bitrate cap
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
        viewType={hero ? ViewType.TEXTURE : ViewType.SURFACE}
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

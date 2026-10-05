// react-native-video, as a browser <video>. Enough of it for the player screen
// to lay out and its controls to work: the source plays when Chrome can play it
// (a direct MP4/H.264 file does; an HLS stream or HEVC usually will not, and the
// player shows its own error state — which is also a layout worth seeing).
import * as React from 'react';
import {View} from 'react-native-web';

export const SelectedTrackType = {SYSTEM: 'system', DISABLED: 'disabled', TITLE: 'title', LANGUAGE: 'language', INDEX: 'index'};
export const SelectedVideoTrackType = {AUTO: 'auto', DISABLED: 'disabled', RESOLUTION: 'resolution', INDEX: 'index'};
export const ResizeMode = {CONTAIN: 'contain', COVER: 'cover', STRETCH: 'stretch', NONE: 'none'};
export const TextTrackType = {SUBRIP: 'application/x-subrip', TTML: 'application/ttml+xml', VTT: 'text/vtt'};

const Video = React.forwardRef(function Video(
  {source, style, paused, rate = 1, volume = 1, muted, resizeMode = 'contain', progressUpdateInterval = 250, onLoad, onProgress, onEnd, onError, onBuffer, onSeek, onReadyForDisplay},
  ref,
) {
  const el = React.useRef(null);
  const uri = source && (typeof source === 'string' ? source : source.uri);

  React.useImperativeHandle(ref, () => ({
    seek: t => {
      if (el.current) el.current.currentTime = t;
    },
    pause: () => el.current && el.current.pause(),
    resume: () => el.current && el.current.play().catch(() => {}),
    getCurrentPosition: async () => (el.current ? el.current.currentTime : 0),
    setVolume: v => {
      if (el.current) el.current.volume = v;
    },
    presentFullscreenPlayer() {},
    dismissFullscreenPlayer() {},
  }));

  React.useEffect(() => {
    const v = el.current;
    if (!v) return;
    if (paused) v.pause();
    else v.play().catch(() => {});
  }, [paused, uri]);
  React.useEffect(() => {
    if (el.current) el.current.playbackRate = rate || 1;
  }, [rate, uri]);
  React.useEffect(() => {
    if (!el.current) return;
    el.current.volume = Math.max(0, Math.min(1, volume));
    el.current.muted = !!muted || volume === 0;
  }, [volume, muted, uri]);

  React.useEffect(() => {
    if (!onProgress) return;
    const t = setInterval(() => {
      const v = el.current;
      if (!v || v.paused || v.readyState < 2) return;
      const b = v.buffered;
      onProgress({currentTime: v.currentTime, playableDuration: b.length ? b.end(b.length - 1) : v.currentTime, seekableDuration: v.duration || 0});
    }, progressUpdateInterval);
    return () => clearInterval(t);
  }, [onProgress, progressUpdateInterval]);

  return (
    <View style={style}>
      {uri ? (
        <video
          ref={el}
          src={uri}
          playsInline
          // a browser tab may not start with sound until it has been clicked
          muted={!!muted}
          style={{width: '100%', height: '100%', objectFit: resizeMode === 'cover' ? 'cover' : resizeMode === 'stretch' ? 'fill' : 'contain', background: '#000'}}
          onLoadedMetadata={e => {
            const v = e.currentTarget;
            onLoad &&
              onLoad({
                duration: v.duration,
                currentTime: v.currentTime,
                naturalSize: {width: v.videoWidth, height: v.videoHeight, orientation: 'landscape'},
                audioTracks: [],
                textTracks: [],
                videoTracks: [],
              });
            onReadyForDisplay && onReadyForDisplay();
          }}
          onEnded={() => onEnd && onEnd()}
          onWaiting={() => onBuffer && onBuffer({isBuffering: true})}
          onPlaying={() => onBuffer && onBuffer({isBuffering: false})}
          onCanPlay={() => onBuffer && onBuffer({isBuffering: false})}
          onSeeked={e => onSeek && onSeek({currentTime: e.currentTarget.currentTime, seekTime: e.currentTarget.currentTime})}
          onError={e => {
            const err = e.currentTarget.error;
            onError && onError({error: {errorString: (err && err.message) || 'The browser could not play this source', errorCode: String((err && err.code) || '')}});
          }}
        />
      ) : null}
    </View>
  );
});

export default Video;

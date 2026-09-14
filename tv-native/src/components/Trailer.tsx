// YouTube trailers, in the app. A WebView carrying the IFrame Player API,
// which is the only way to know when the video is actually PLAYING (so the
// artwork can cross-fade to it) and when it ended or failed (so the artwork
// comes back). Mounted only while a trailer runs — a WebView is the heaviest
// thing this app draws, so none exists at rest.
import React, {useCallback, useMemo, useRef} from 'react';
import {StyleSheet, View, ViewStyle, StyleProp} from 'react-native';
import {WebView} from 'react-native-webview';
import {getBaseUrl} from '../api';

export type TrailerState = 'ready' | 'playing' | 'paused' | 'ended' | 'error';

// YT.PlayerState: -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued.
const page = (id: string, muted: boolean, origin: string) => `<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;background:#000;overflow:hidden;height:100%}#p{position:absolute;inset:0}</style>
</head><body><div id="p"></div><script>
var post=function(o){try{window.ReactNativeWebView.postMessage(JSON.stringify(o))}catch(e){}};
var player=null,started=false;
function onYouTubeIframeAPIReady(){player=new YT.Player('p',{host:'https://www.youtube.com',videoId:${JSON.stringify(id)},width:'100%',height:'100%',
playerVars:{autoplay:1,mute:${muted ? 1 : 0},controls:0,rel:0,modestbranding:1,playsinline:1,iv_load_policy:3,disablekb:1,fs:0,enablejsapi:1,origin:${JSON.stringify(origin)}},
events:{onReady:function(e){${muted ? 'e.target.mute();' : 'e.target.unMute();e.target.setVolume(100);'}try{e.target.setPlaybackQuality('hd1080')}catch(x){}e.target.playVideo();post({t:'ready'})},
onStateChange:function(e){if(e.data===1){started=true;post({t:'playing'})}else if(e.data===0)post({t:'ended'});else if(e.data===2)post({t:'paused'})},
onError:function(e){post({t:'error',c:e.data})}}})}
window.__cmd=function(c){try{if(!player)return;if(c==='mute')player.mute();if(c==='unmute'){player.unMute();player.setVolume(100)}if(c==='pause')player.pauseVideo();if(c==='play')player.playVideo()}catch(e){}};
var s=document.createElement('script');s.src='https://www.youtube.com/iframe_api';s.onerror=function(){post({t:'error',c:'script'})};document.head.appendChild(s);
setTimeout(function(){if(!started)post({t:'error',c:'timeout'})},14000);
</script></body></html>`;

export type TrailerHandle = {cmd: (c: 'mute' | 'unmute' | 'pause' | 'play') => void};

export default function TrailerFrame({
  videoId,
  muted,
  style,
  onState,
  handle,
}: {
  videoId: string;
  muted: boolean;
  style?: StyleProp<ViewStyle>;
  onState: (s: TrailerState) => void;
  // Written with a `cmd` the owner can call (mute/unmute) without re-rendering.
  handle?: React.MutableRefObject<TrailerHandle | null>;
}) {
  const web = useRef<WebView>(null);
  // The page lives at the Aurora server's origin — the same origin the
  // website's embed runs under, and the one YouTube's embed accepts.
  const origin = getBaseUrl() || 'https://nufurora.com';
  const html = useMemo(() => page(videoId, muted, origin), [videoId, muted, origin]);
  const onMessage = useCallback(
    (e: {nativeEvent: {data: string}}) => {
      let m: {t?: string} = {};
      try {
        m = JSON.parse(e.nativeEvent.data);
      } catch {
        return;
      }
      console.log('[trailer]', videoId, m.t, (m as {c?: unknown}).c ?? '');
      if (m.t === 'ready' || m.t === 'playing' || m.t === 'paused' || m.t === 'ended' || m.t === 'error') {
        onState(m.t);
      }
    },
    [onState],
  );
  if (handle) {
    handle.current = {
      cmd: c => web.current?.injectJavaScript(`window.__cmd(${JSON.stringify(c)});true;`),
    };
  }
  return (
    // pointerEvents none + not focusable: the D-pad must never land inside the
    // web page — the app's own buttons stay in charge.
    <View style={[styles.wrap, style]} pointerEvents="none">
      <WebView
        ref={web}
        source={{html, baseUrl: origin + '/'}}
        style={styles.web}
        javaScriptEnabled
        domStorageEnabled
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback
        allowsFullscreenVideo={false}
        androidLayerType="hardware"
        scrollEnabled={false}
        focusable={false}
        // YouTube answers the stock Android WebView UA with "This video is
        // unavailable" (error 152); a desktop Chrome UA gets the embed.
        userAgent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"
        thirdPartyCookiesEnabled
        sharedCookiesEnabled
        setBuiltInZoomControls={false}
        onMessage={onMessage}
        onError={() => onState('error')}
        onHttpError={() => onState('error')}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {overflow: 'hidden', backgroundColor: '#000'},
  web: {flex: 1, backgroundColor: '#000'},
});

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

// YouTube picks the quality from the PLAYER'S SIZE in CSS pixels, not from the
// screen (setPlaybackQuality has been a no-op for years). The WebView's CSS
// pixel is a dp, so a full-screen player here was ~1100 px wide and got
// 720p at best — "the trailer is always low res" (elia, 2026-10-07). Laying
// the player out LARGER and scaling it down makes it exactly 1920 px wide to
// YouTube, which serves 1080p, while the picture still fits the frame. Not
// more: at 2200 px YouTube handed the Mi TV 2160p and the UI fell to 63%
// janky frames while it decoded 4K. Stalls step it back down: two rebuffers in the first 25 s
// (or one longer than 2.5 s) shrink the player to 1× and reload at the same
// second — and the whole session stays at 1× after that (a box that could
// not keep up once will not next time either).
let trailerHi = true;
export const trailerStepDown = () => {
  trailerHi = false;
};

// YT.PlayerState: -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued.
const page = (id: string, muted: boolean, origin: string, hi: boolean) => `<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;background:#000;overflow:hidden;height:100%}#p{position:absolute;left:0;top:0;width:100%;height:100%;transform-origin:0 0}</style>
</head><body><div id="p"></div><script>
var post=function(o){try{window.ReactNativeWebView.postMessage(JSON.stringify(o))}catch(e){}};
var player=null,started=false,hi=${hi ? 'true' : 'false'},playedAt=0,stalls=0,stallAt=0;
// the factor that makes the player exactly 1920 CSS px wide — never more: at
// 2200 px YouTube handed the Mi TV 2160p and the UI fell to 63% janky frames
var K=hi?Math.max(1,Math.min(2,1920/Math.max(1,window.innerWidth))):1;
(function(){var p=document.getElementById('p');p.style.width=(K*100)+'%';p.style.height=(K*100)+'%';p.style.transform='scale('+(1/K)+')'})();
function stepDown(){if(!hi||!player)return;hi=false;var p=document.getElementById('p');p.style.width='100%';p.style.height='100%';p.style.transform='none';
try{var t=player.getCurrentTime()||0;player.loadVideoById({videoId:${JSON.stringify(id)},startSeconds:t})}catch(e){}post({t:'stepdown'})}
function onYouTubeIframeAPIReady(){player=new YT.Player('p',{host:'https://www.youtube.com',videoId:${JSON.stringify(id)},width:'100%',height:'100%',
playerVars:{autoplay:1,mute:${muted ? 1 : 0},controls:0,rel:0,modestbranding:1,playsinline:1,iv_load_policy:3,disablekb:1,fs:0,enablejsapi:1,origin:${JSON.stringify(origin)}},
events:{onReady:function(e){${muted ? 'e.target.mute();' : 'e.target.unMute();e.target.setVolume(100);'}try{e.target.setPlaybackQuality('hd1080')}catch(x){}e.target.playVideo();post({t:'ready'})},
onStateChange:function(e){if(e.data===1){if(!started){started=true;playedAt=Date.now()}if(stallAt&&Date.now()-stallAt>2500)stepDown();stallAt=0;post({t:'playing'})}
else if(e.data===3){if(started){stalls++;stallAt=Date.now();if(stalls>=2&&Date.now()-playedAt<25000)stepDown();else if(stalls>=4)stepDown()}}
else if(e.data===0)post({t:'ended'});else if(e.data===2)post({t:'paused'})},
onPlaybackQualityChange:function(e){post({t:'quality',c:e.data})},
onError:function(e){post({t:'error',c:e.data})}}})}
window.__cmd=function(c){try{if(!player)return;if(c==='mute')player.mute();if(c==='unmute'){player.unMute();player.setVolume(100)}if(c==='pause')player.pauseVideo();if(c==='play')player.playVideo();if(c==='stop'){started=true;player.stopVideo();player.destroy();player=null;document.body.innerHTML=''}}catch(e){}};
var s=document.createElement('script');s.src='https://www.youtube.com/iframe_api';s.onerror=function(){post({t:'error',c:'script'})};document.head.appendChild(s);
setTimeout(function(){if(!started)post({t:'error',c:'timeout'})},14000);
</script></body></html>`;

// 'stop' ends the page's work for good — the player is destroyed and the page
// emptied — for a WebView that cannot be unmounted at once (see Home).
export type TrailerHandle = {cmd: (c: 'mute' | 'unmute' | 'pause' | 'play' | 'stop') => void};

// The WebView's layer type. "hardware" gave the WebView its own offscreen GPU
// layer — ~2208x1242 px for Home's over-sized billboard frame — redrawn on
// every video frame and then composited again: measured on the Mi TV, 24 fps
// at 26 ms a frame (94% janky) while a trailer played. "none" lets the
// WebView draw straight into the window's own hardware-accelerated canvas
// (the platform default), which is the same picture without the extra
// full-size pass. If a box ever plays a trailer black or torn with "none",
// flip this one constant back to 'hardware' — nothing else depends on it.
const WEBVIEW_LAYER: 'none' | 'software' | 'hardware' = 'none';

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
  const html = useMemo(() => page(videoId, muted, origin, trailerHi), [videoId, muted, origin]);
  const onMessage = useCallback(
    (e: {nativeEvent: {data: string}}) => {
      let m: {t?: string} = {};
      try {
        m = JSON.parse(e.nativeEvent.data);
      } catch {
        return;
      }
      console.log('[trailer]', videoId, m.t, (m as {c?: unknown}).c ?? '');
      if (m.t === 'stepdown') trailerStepDown();
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
        androidLayerType={WEBVIEW_LAYER}
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
        // The renderer process died (the system reclaimed it — a WebView
        // renderer is ~120-140 MB on a 2 GB box — or it crashed). The page is
        // gone and the view would stay blank: report an error so the owner
        // unmounts this WebView (Home goes back to its art and skips this
        // trailer for the visit; the trailer sheet shows its message).
        onRenderProcessGone={() => onState('error')}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {overflow: 'hidden', backgroundColor: '#000'},
  web: {flex: 1, backgroundColor: '#000'},
});

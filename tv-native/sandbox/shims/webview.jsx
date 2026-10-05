// react-native-webview, as an <iframe>. The app uses it for one thing — the
// YouTube trailer page (components/Trailer.tsx) — which talks back through
// window.ReactNativeWebView.postMessage; that is bridged to onMessage here.
import * as React from 'react';
import {View} from 'react-native-web';

export const WebView = React.forwardRef(function WebView({source, style, onMessage, onError}, ref) {
  const frame = React.useRef(null);
  const html = source && source.html;
  const bridge = '<script>window.ReactNativeWebView={postMessage:function(d){parent.postMessage({__rnwv:d},"*")}};<\/script>';

  React.useImperativeHandle(ref, () => ({
    injectJavaScript: code => {
      try {
        frame.current && frame.current.contentWindow && frame.current.contentWindow.eval(code);
      } catch (e) {
        console.warn('[sandbox webview]', e);
      }
    },
    reload() {},
    stopLoading() {},
  }));

  React.useEffect(() => {
    const on = e => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      if (e.data && typeof e.data.__rnwv === 'string' && onMessage) onMessage({nativeEvent: {data: e.data.__rnwv}});
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, [onMessage]);

  return (
    <View style={style}>
      <iframe
        ref={frame}
        title="webview"
        tabIndex={-1}
        allow="autoplay; encrypted-media"
        style={{width: '100%', height: '100%', border: 0, background: '#000'}}
        {...(html != null ? {srcDoc: bridge + html} : {src: source && source.uri})}
        onError={() => onError && onError({nativeEvent: {}})}
      />
    </View>
  );
});

export default WebView;

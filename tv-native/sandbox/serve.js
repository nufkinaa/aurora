// Aurora TV sandbox — the TV app's real screens in a browser, at TV panel sizes.
//
//   cd tv-native/sandbox && npm install && npm start      → http://localhost:4200
//
// What it is: App.tsx and src/ bundled for the web with react-native-web, with
// the TV-only parts stood in for (shims/): the d-pad is the arrow keys, OK is
// Enter, Back is Escape. The page at / shows the app in several frames at once,
// one per panel size (Android TVs lay out at 960x540, 1280x720 or 1920x1080 dp
// — see useTvMetrics in src/theme.ts), so a layout can be looked at on all of
// them without a TV, a cable or an APK.
//
// What it is NOT: the TV. Layout comes from the browser's flexbox instead of
// Yoga, text from Chrome's font rendering, focus order from shims/react-native.jsx.
// Use it to catch things that overflow, collide or drift between sizes; confirm
// on the Streamer before calling a layout done.
//
// The app needs an Aurora server. Everything that is not the sandbox's own page
// is passed through to one (AURORA, default http://localhost:4000), and the
// app's SERVER_CANDIDATES is replaced at build time with this origin — so the
// browser sees one origin and no CORS. Nothing under src/ is edited.
//
//   PORT=4300 AURORA=https://nufurora.com npm start
const esbuild = require('esbuild');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT) || 4200;
const TARGET = new URL(process.env.AURORA || 'http://localhost:4000');

const shim = name => path.join(__dirname, 'shims', name);
const ALIAS = {
  'react-native': shim('react-native.jsx'),
  'react-native-video': shim('video.jsx'),
  'react-native-webview': shim('webview.jsx'),
  '@react-native-async-storage/async-storage': shim('async-storage.js'),
};

const sandboxPlugin = {
  name: 'aurora-tv-sandbox',
  setup(build) {
    build.onResolve({filter: /^(react-native|react-native-video|react-native-webview|@react-native-async-storage\/async-storage)$/}, a => ({
      path: ALIAS[a.path],
    }));
    // ONE React: the app's own copy, whoever asks (react-dom lives in this
    // folder's node_modules and would otherwise be free to find another).
    build.onResolve({filter: /^react(\/|$)/}, a => ({path: require.resolve(a.path, {paths: [ROOT]})}));
    // The server is wherever this page came from.
    build.onLoad({filter: /[\\/]src[\\/]api\.ts$/}, async a => {
      const src = await fs.promises.readFile(a.path, 'utf8');
      const out = src.replace(/export const SERVER_CANDIDATES = \[[\s\S]*?\];/, 'export const SERVER_CANDIDATES = [window.location.origin];');
      if (out === src) throw new Error('sandbox: SERVER_CANDIDATES not found in src/api.ts — update the pattern in sandbox/serve.js');
      return {contents: out, loader: 'ts'};
    });
  },
};

let ctx = null;
const bundle = async () => {
  if (!ctx) {
    ctx = await esbuild.context({
      entryPoints: [path.join(__dirname, 'entry.jsx')],
      bundle: true,
      write: false,
      outfile: 'app.js',
      platform: 'browser',
      format: 'iife',
      target: 'es2022',
      sourcemap: 'inline',
      jsx: 'automatic',
      loader: {'.png': 'dataurl', '.jpg': 'dataurl', '.js': 'jsx'},
      resolveExtensions: ['.web.tsx', '.web.ts', '.web.jsx', '.web.js', '.tsx', '.ts', '.jsx', '.js', '.json'],
      mainFields: ['browser', 'module', 'main'],
      nodePaths: [path.join(__dirname, 'node_modules')],
      define: {__DEV__: 'true', 'process.env.NODE_ENV': '"development"', global: 'window'},
      logLevel: 'silent',
      plugins: [sandboxPlugin],
    });
  }
  // a rebuild per load: always the files as they are on disk, in ~100ms
  const r = await ctx.rebuild();
  return r.outputFiles[0].text;
};

const send = (res, code, type, body) => {
  res.writeHead(code, {'content-type': type, 'cache-control': 'no-store'});
  res.end(body);
};

const errorScript = e => {
  const text = (e.errors || []).map(x => `${x.location ? `${x.location.file}:${x.location.line}: ` : ''}${x.text}`).join('\n') || String(e.stack || e);
  console.error('\n[sandbox] build failed\n' + text);
  return `document.body.innerHTML='<pre style="color:#ffb4b4;font:13px/1.5 ui-monospace,Consolas,monospace;padding:20px;white-space:pre-wrap">'+${JSON.stringify(
    'The TV bundle did not build:\n\n' + text,
  )}.replace(/</g,'&lt;')+'</pre>'`;
};

const proxy = (req, res) => {
  const lib = TARGET.protocol === 'https:' ? https : http;
  const up = lib.request(
    {
      protocol: TARGET.protocol,
      hostname: TARGET.hostname,
      port: TARGET.port || (TARGET.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: req.url,
      headers: {...req.headers, host: TARGET.host},
    },
    r => {
      res.writeHead(r.statusCode || 502, r.headers);
      r.pipe(res);
    },
  );
  up.on('error', e => send(res, 502, 'text/plain', `No Aurora server at ${TARGET.origin} (${e.code || e.message}). Start it, or set AURORA=…`));
  req.pipe(up);
};

const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/' || url === '/sandbox') return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(path.join(__dirname, 'index.html')));
  if (url === '/frame') return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(path.join(__dirname, 'frame.html')));
  if (url === '/sandbox/app.js') {
    try {
      return send(res, 200, 'text/javascript; charset=utf-8', await bundle());
    } catch (e) {
      return send(res, 200, 'text/javascript; charset=utf-8', errorScript(e));
    }
  }
  proxy(req, res);
});

// the app's WebSocket (src/realtime.ts) goes through too
server.on('upgrade', (req, socket, head) => {
  const lib = TARGET.protocol === 'https:' ? require('tls') : require('net');
  const port = Number(TARGET.port) || (TARGET.protocol === 'https:' ? 443 : 80);
  const up = lib.connect({host: TARGET.hostname, port, servername: TARGET.hostname}, () => {
    const headers = Object.entries({...req.headers, host: TARGET.host})
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n');
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
    if (head && head.length) up.write(head);
    socket.pipe(up).pipe(socket);
  });
  const done = () => {
    socket.destroy();
    up.destroy();
  };
  up.on('error', done);
  socket.on('error', done);
});

server.listen(PORT, () => {
  console.log(`Aurora TV sandbox   http://localhost:${PORT}`);
  console.log(`Aurora server       ${TARGET.origin}`);
  bundle().then(
    () => console.log('bundle ok'),
    e => errorScript(e),
  );
});

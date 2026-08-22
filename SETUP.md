# Aurora — setup & operations

Personal streaming server (Node + Express + WebTorrent): scans local movie/show
folders into a Netflix-style web app, streams torrent sources via Torrentio,
transcodes anything a browser can't play (ffmpeg), does profiles, watch
progress, subtitles (incl. Hebrew via OpenSubtitles/Wizdom), and unattended
download-to-library (admin approval only when the disk is low). Frontend is
vanilla ES modules in `public/`, no build step.

## Requirements

- **Node 20+**. (`npm install` runs `tools/patch-webtorrent.js` automatically —
  it null-guards WebTorrent's piece picker, which otherwise crashes under
  multi-peer load.)
- **ffmpeg + ffprobe on PATH** — e.g. `winget install Gyan.FFmpeg`, then open a
  NEW terminal so PATH refreshes. Without it: streaming still works, but no
  transcoding, no audio-fix remux, no embedded subtitles, no video stills.
- **aria2** — the download-to-library engine. Windows:
  `winget install aria2.aria2`. Linux: `sudo apt install aria2`. Without it,
  browsing and streaming are unaffected but downloads can't start, and
  /admin → Server → Environment says so in as many words. It's found on PATH,
  in winget's package folder on Windows, or wherever `"aria2Path"` in
  config.json points.
- Optional (only for burned-bitmap subtitle OCR): Tesseract + Python 3.
- Developed and battle-tested on Windows; the tool discovery in `src/config.js`
  handles macOS/Linux PATH lookups too, but those platforms see less testing.

## Setup

```bash
npm install
cp config.example.json config.json
cp .env.example .env
```

1. `config.json` → `libraries.movies` / `libraries.shows`: folders on YOUR
   machine (empty folders are fine to start; downloads land in the first one).
   Set `adminName` to whatever the UI should call you. If you use ntfy
   notifications, pick your own random `notifications.ntfy.topic` and subscribe
   to it in the ntfy app.
2. `.env` → set `AURORA_ADMIN_PASSWORD`. **The admin panel is disabled until
   you do** — there is no default password and no localhost bypass; every
   admin request carries the password and the panel re-asks after a refresh.
   `TMDB_API_KEY` and `OPENROUTER_API_KEY` are optional (age ratings / AI
   recommender).

Run:

```bash
node server.js
```

(or `pm2 start ecosystem.config.js`, or on Windows drop a shortcut to
`start-aurora.cmd` into `shell:startup`). Open `http://localhost:4000` — admin
panel at `/admin`.

## ⚠️ Network safety

Aurora is built for a **private LAN** — most APIs have no authentication.
The boot banner prints a `Network` URL and warns if that address is NOT a
private one (`192.168.x.x` / `10.x.x.x` / `172.16-31.x.x`). If it warns, your
machine may be reachable from the internet: keep inbound connections to node
blocked by the firewall, or bind the server to a LAN interface.

## Migrating data from another instance

Copy the other machine's `data/*.json` files (NOT `data/cache/`) into `data/`
before first start: profiles (passwords are scrypt hashes), watch history &
progress, telemetry, download history. Titles whose media files you don't have
will drop out of the library on first scan; Discover streaming works
immediately regardless.

## Notes

- Profile unlock sessions live in server memory: after every restart, protected
  profiles ask for their password again. By design.
- Torrent staging lives in `%TEMP%\webtorrent` (streaming) and
  `%TEMP%\aurora-downloads` (aria2); stale entries are swept at boot.
- Downloads run in a separate **aria2c** process driven over JSON-RPC
  (`src/media/aria2.js`) — a heavy download never touches the streaming
  server's event loop.
- The react-native TV project (`tv-native/`) has its own `npm install` and
  build script (`build-apk.bat`).

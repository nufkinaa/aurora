# Aurora — torrent streaming

Aurora resolves titles through [Cinemeta](https://v3-cinemeta.strem.io) and asks
[Torrentio](https://torrentio.strem.fun) (the same public index Stremio uses)
for sources. Streaming is WebTorrent serving HTTP range requests straight out
of the swarm; download-to-library is a separate aria2 pipeline (see
`src/media/downloads.js`). This doc covers the streaming half.

## Architecture

```
Detail page asks for sources
       │
       ▼
GET /api/torrents/sources?type=&title=&year=&season=&episode=
       │
       ├─ resolveId(): title → IMDb id via Cinemeta search (cached)
       ├─ fetchTorrentio(): Torrentio streams for that id (cached 6h)
       └─ rank(): quality / seeders / CAM & dub detection / pack handling → ★ best pick
       │
       ▼
Player opens /stream/torrent/{infoHash}/{fileIdx}
       │
       ├─ torrent added to WebTorrent lazily — nothing joins the swarm
       │  until a player actually asks for bytes
       ├─ Range requests → 206; pieces around the playhead are prioritized,
       │  far seeks trigger a prefetch region instead of a stall
       ├─ files the client can't decode → /stream/torrent/hls/... (ffmpeg)
       └─ buffering UI polls /api/torrents/status/{infoHash}
```

## HTTP endpoints (`src/routes/torrent.js`)

| Endpoint | Purpose |
|---|---|
| `GET /api/torrents/sources?type=&title=&year=&season=&episode=` | Ranked source list for a title (`type` is `movie` or `series`) |
| `GET /api/torrents/status/:infoHash` | Live `{ready, peers, progress, downloadSpeed, subtitles}` for the buffering UI; polling it keeps the torrent alive |
| `GET /stream/torrent/:infoHash/:fileIdx` | The stream itself (HTTP range, self-healing reads) |
| `GET /stream/torrent/hls/:infoHash/:fileIdx/:ss/index.m3u8` | On-the-fly HLS transcode from offset `ss` seconds |
| `GET /stream/torrent/sub/:infoHash/:fileIdx` | A subtitle file from inside the torrent, converted to VTT |
| `GET /api/torrents/subtitles/:type/:id` | External subtitle tracks (OpenSubtitles + Wizdom) by IMDb id |
| `GET /stream/websub` | Fetch-and-convert proxy for those external tracks (host allow-listed) |
| `GET /api/admin/torrents` | Admin: what the streaming client is holding (find stray giants) |
| `POST /api/admin/torrents/:infoHash/remove` | Admin: evict a stream torrent immediately |

## Client lifecycle (`src/media/torrent.js`)

- WebTorrent is created lazily (`maxConns: 40`, no outgoing seed connections)
  — the module loading must never join a swarm on its own.
- **Eviction:** a torrent untouched for 30 minutes is dropped; beyond a hard
  cap of 12 concurrent torrents the least-recently-used goes first. Stale
  staging directories in `%TEMP%\webtorrent` are swept at boot (`server.js`).
- **Caching** (`data/cache/torrent-streams.json`): Torrentio source lists live
  for 6 hours; title → IMDb id mappings are kept indefinitely.
- **Ranking:** parses resolution/quality out of release names, weighs seeders,
  flags CAM/TS and dubbed audio, detects season packs (several episodes share
  one torrent, each pointing at its own file index), and marks a ★ recommended
  pick.
- `npm install` applies `tools/patch-webtorrent.js` — null-guards for
  WebTorrent 3.0.16's piece picker and peer teardown, which otherwise crash
  under multi-peer load.

## Edge cases handled

- **Seeking into undownloaded territory** — the read stream recovers instead of
  erroring, and a prefetch region is raised around the target offset.
- **Peer discovery slower than player timeouts** — clients "kick" the stream
  with a tiny range request, then poll `/api/torrents/status/...` and only
  start the real player once peers exist (the native TV app relies on this).
- **Completed pieces nulled mid-read** — see the webtorrent patch above.
- **Windows file locks on eviction** — staging that fails to delete is retried
  by the boot sweep.

## Config

Torrent streaming is on by default; set `"torrents": false` in `config.json`
to disable it entirely (source lists come back empty and the UI hides the
feature).

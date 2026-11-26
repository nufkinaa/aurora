# Clipwave Media Server API v1 in Aurora

Aurora serves the Clipwave Media Server API v1. It lets the Clipwave app search the library,
read subtitles and pull only the parts of a film or episode it needs.
Code: `src/routes/clipwave.js` (routes) and `src/lib/clipwavetokens.js` (keys).
Tests: `test/clipwave.test.js` (end to end) and `test/ui/admin-clipwave.test.js` (admin panel).

## Set it up

1. **Admin panel → Server → Clipwave access.** Name a key, press **Create key** and copy it.
   It is shown only once. Aurora keeps only its SHA-256 hash.
2. **In Clipwave → Settings → My server:**
   - Paste the address shown there: `https://<your host>/clipwave`. Clipwave adds `/v1` itself.
   - Paste the key.
   - Press **Test**.
3. **Remove** a key in the same place. It stops working at once.

A key can do one thing: read the library through `/clipwave/v1`. It cannot reach profiles,
history, downloads or any admin route, and nothing else (a session, the admin password) opens
`/clipwave`. Keys are made and removed only with the admin password. At most 20 keys.

HTTPS: the key travels in a header, so use the server's public `https://` address.

## Endpoints

Every endpoint is `GET`, needs `Authorization: Bearer <key>`, and answers in JSON with camelCase keys.
Times are in seconds. Every error has the shape `{ "error": { "code", "message" } }`.

| Endpoint | What Aurora answers |
|---|---|
| `/v1/ping` | `name`, `apiVersion: 1`, `serverVersion` (Aurora's version), `capabilities`. `"clip"` is listed when ffmpeg is available, `"audio"` when ffmpeg has libopus. |
| `/v1/search?q=&type=all\|movie\|show\|episode&limit=&offset=` | Matches titles, ignoring case and accents. A year in the query (`princess bride 1987`) counts as a bonus. `show s03e07` finds that episode. For `type=episode`, the episodes of a show named in the query count. Ranking: exact title, then starts-with, then contains, then all words. |
| `/v1/library?type=movie\|show&sort=title\|year\|added&order=asc\|desc` | Films and shows (both when no `type` is given). `added` sorts newest first by default. |
| `/v1/shows/{showId}/episodes?season=` | That show's episodes, in order. |
| `/v1/items/{id}` | A film or an episode in full (details below). A show id answers `400`. |
| `/v1/items/{id}/subtitles/{subtitleId}` | SRT (`application/x-subrip`). Sidecar files and the file's own text tracks are converted from what the player gets: already lined up and repaired. |
| `/v1/items/{id}/file` | The file exactly as it is on disk. Range gives `206`, no Range gives `200`, a range past the end gives `416`. Sends `ETag` and `Last-Modified`, and honours `If-Range`. |
| `/v1/items/{id}/poster?w=` | JPEG, PNG or WebP, scaled when `w` is given. An episode shows its show's poster. |
| `/v1/items/{id}/clip?start=&end=&audioTrack=` | Fragmented MP4: the video copied as it is, the sound converted to AAC stereo at 192k. At most 600 s. |
| `/v1/items/{id}/audio?audioTrack=` | Ogg Opus, mono, 16 kHz, 24 kbps. |

### Details in `/v1/items/{id}`

- **IDs:** Aurora's own library ids (12 hex characters). They stay the same unless a file is renamed or moved.
- **`audioTracks[].index`:** the audio track's position among the file's audio tracks. This is
  the `n` in `-map 0:a:n` and the value `audioTrack=` expects.
- **`audioTracks[].default`:** the first track.
- **Subtitle ids:**
  - `x_<id>` is a file next to the video.
  - `e_<n>` is the video's own n-th subtitle track.
  - Picture subtitles (PGS/VobSub) are never listed.
- **`directors` and `studios`:** from X-Ray's sources, kept on disk.
  - The first time an item is opened, Aurora waits up to 4 s for them.
  - Lists return them only once they are known.
- **`originalTitle`, `tmdbId`, `chapters`:** always `null`, `null` and `[]` for now.
- **`imdbId`:** the film's id. An episode has none of its own, so it is `null`.

## Load

- Cuts (`clip`, `audio`):
  - At most 3 at a time; a 4th gets `503 busy` with `Retry-After: 5`.
  - They run below normal priority, so they never take the CPU from someone watching.
  - ffmpeg is stopped when Clipwave hangs up.
- A file on a network drive that is not answering gets `503 busy` with `Retry-After: 60` at once.
- Clipwave reads only what it needs: for 5 shorts from a 2-hour film, about 5–10 minutes of video.

## Self-test

```bash
H="Authorization: Bearer $KEY"; B=https://your-host/clipwave/v1
curl -s -H "$H" $B/ping
curl -s -H "$H" "$B/search?q=princess"
curl -s -o /dev/null -w "%{http_code} %{size_download}\n" -H "$H" -H "Range: bytes=0-1048575" $B/items/<id>/file   # 206 1048576
curl -s -o /dev/null -w "%{http_code}\n" $B/ping   # no key: 401
```

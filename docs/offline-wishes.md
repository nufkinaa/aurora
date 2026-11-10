# "Save it to this device too" — offline wishes (contract)

Owner: `offline-web` (server + website). The phone app (`offline-phone`) builds
on this. **The contract only grows**: fields and states may be added, nothing
is renamed or removed. A change to it gets a "Changed" note at the top of this
file with the date.

## What it is

elia, 2026-11-10: "…if we can somehow maybe schedule download to phone before
it downloaded to the server."

A **wish** is one device's standing request, for one profile, to save a title
the library does not hold yet — a film, an episode, or every episode of one
season as it lands — at a chosen quality. When the server's download lands in
the library, the server links the wish to the new library item, starts
preparing the device copy at that quality (the same `/api/offline/*`
machinery a device uses itself: a person's request in the copy lane; a
re-encode waits for its place and never pushes a viewer aside), and tells the
profile's devices. The device that made the wish saves it **by itself** the
next time it is open (or at once, when it is), then reports it saved, which
ends the wish.

Rules elia set: no cap on downloads; nothing is deleted automatically (a
failed wish stays until the person dismisses it).

## Identity

- **Profile**: the routes live under `/api/profiles/:id/…` and pass the same
  gate as every profile route (session, or `X-Profile-Token` for a protected
  profile; 404 for an unknown profile, 401 locked).
- **Device**: `deviceId`, `[A-Za-z0-9_-]{8,48}`, the device's own id — the
  same one the device announces for "Play on TV" (`lib/devices.js`): the
  website's is `localStorage["aurora-device-id"]` via
  `public/js/remote.js deviceId()`; the phone app uses its stored remote (`aurora.remote.deviceId`, tv-native/src/storage.ts)
  device id. A wish belongs to (profile, device).
- **Title** (before a library item exists): `type` `movie|show`, `imdbId`
  (`tt…`), and for a show `season` (+ `episode` for one episode). A download
  job's `id` (`jobId`) may be given as well, or instead of the IMDb id when
  the job has none.

## Routes

All JSON. Old routes are unchanged: `/api/offline/options|prepare|status|cancel`
and `/offline/file/:id` answer exactly as before (the phone app 1.1.2 and
older keep working).

### `GET /api/profiles/:id/offline-wishes?device=<deviceId>`
→ `200 { wishes: [Wish] }` — this device's wishes (without `device`: every
wish of the profile, each naming its device). `Cache-Control: no-store`.

### `POST /api/profiles/:id/offline-wishes`
Body:
```json
{
  "deviceId": "web-3fa1…",           // required
  "deviceName": "Pixel 8",            // optional, for "waiting on …" lines
  "scope": "title",                   // "title" (a film or ONE episode) | "season"
  "type": "show",                     // "movie" | "show"
  "imdbId": "tt0903747",              // required unless jobId is given
  "jobId": "a1b2c3d4e5f6",            // optional: the download job it waits for
  "season": 2, "episode": 5,          // show: season always; episode for scope "title"
  "title": "Breaking Bad · S2 E5",    // optional, shown until the item exists
  "showTitle": "Breaking Bad",        // optional
  "poster": "https://…",              // optional
  "quality": "720",                   // "original" | "1080" | "720" | "480"
  "hevc": false,                      // the device plays HEVC in MP4 (as /api/offline/*?hevc=1)
  "pushKey": "9f86d0…"                // optional: sha256 hex of THIS browser's push endpoint
}
```
→ `200 { wish: Wish }`, or `400 { error }` (bad device id, bad quality,
missing season/episode, a season wish for a film…).
Idempotent: the same device asking again for the same title is the SAME wish
(its quality, hevc, pushKey… are updated; a failed one starts waiting again).
If the title is already in the library the wish comes back `ready` at once.

### `DELETE /api/profiles/:id/offline-wishes/:wishId`
→ `200 { ok: true }` | `404`. Cancel / Dismiss. A copy the server was
preparing only because of this wish is cancelled on the server. A season
wish takes its episode wishes that are not saved yet with it.

### `POST /api/profiles/:id/offline-wishes/:wishId/saved`
→ `200 { ok: true }` | `404`. The device has its copy: the wish ends.
(For an episode wish made by a season wish, only that episode ends; the
season wish keeps waiting for the next episode.)

### `GET /api/offline/wish-options?type=&imdbId=&season=&episode=&duration=<s>&hevc=1`
The size sheet before the file exists — the same shape as
`/api/offline/options/:id`: `{ options: [{ quality, label, detail, sizeBytes,
estimated: true, instant, note, ready: false }], duration, ffmpeg, download }`.
Original's size is the download's size; the re-encodes are estimated from
`duration` (seconds, the running time the client knows) or, without it, the
note says "about N GB an hour". `download`: `{ id, status, progress }` of the
matching download job, or null.

## Wish

```json
{
  "id": "5d1e0c9a7b21",
  "profileId": "…", "deviceId": "web-…", "deviceName": "Pixel 8",
  "scope": "title" | "season",
  "type": "movie" | "show", "imdbId": "tt…", "jobId": "…" | null,
  "season": 2 | null, "episode": 5 | null,
  "title": "…", "showTitle": "…" | null, "poster": "…" | null,
  "quality": "720", "hevc": false,
  "state": "waiting" | "ready" | "failed",
  "libraryId": "ab12cd34ef56" | null,      // ready: the library item to save
  "readyQuality": "720" | null,            // ready: the quality the server prepares (see below)
  "copy": { "state": "queued|working|ready|error|idle|unavailable", "progress": 0.42, "sizeBytes": 123 | null, "error": null } ,  // ready only
  "note": "This device can't play the original's picture — it is saved at 1080p." | null,
  "error": "The download was cancelled — there is nothing to save." | null,   // failed only
  "parentId": "…" | null,                  // an episode wish made by a season wish
  "createdAt": 1794300000000, "updatedAt": …, "readyAt": … | null
}
```

States:
- `waiting` — the title is not in the library yet (download queued, running,
  waiting for approval, or not even requested — a wish can wait for a title
  somebody downloads later). A **season** wish stays `waiting` for good: each
  episode that lands becomes its own `title` wish with `parentId`, `ready`.
- `ready` — in the library: save `libraryId` at `readyQuality` with the usual
  device flow (`POST /api/offline/prepare/<libraryId>?q=<readyQuality>` then
  poll `/api/offline/status`, then fetch the `url` it gives), then
  `POST …/saved`. `copy` says how far the server's copy is (it was started
  when the title landed; the device's own `prepare` joins it).
  `readyQuality` differs from `quality` when the file cannot be made at the
  quality asked: Original of a picture this device cannot play → the best
  re-encode; a size above the file's own → the next one down. `note` says so
  in words to show.
- `failed` — the download it waited for failed, was cancelled, declined or
  taken off the list, and no other download of that title is on its way;
  `error` is the sentence to show. Stays until DELETEd (Dismiss). If the title
  lands later after all, the wish turns `ready` by itself.

## Live updates

- WebSocket (the app's one socket), to every socket of the profile:
  - `{ "type": "offline_wish", "wish": Wish }` — created, changed, ready,
    failed, or its server copy became ready.
  - `{ "type": "offline_wish_removed", "id": "…", "deviceId": "…" }`
  A device keeps only messages whose `wish.deviceId` / `deviceId` is its own.
- Web push (website only, optional): when a wish's copy is ready on the server
  and the wish carries a `pushKey` that matches one of the profile's push
  subscriptions, that ONE browser gets a notification ("Ready to save on this
  device — open Aurora and it saves by itself", opens `/#/saved`), once. Its
  tag is the download's own (`dl-<jobId>`), so on that browser it replaces the
  "Downloaded and ready to watch" notification instead of adding a second one.
  The phone app has no web push; it relies on the socket and on asking when it
  comes back.

## What a client does

1. **Make a wish** wherever a title is on its way: (website) the film's title
   page while it downloads, the "Downloading now!" sheet, every not-yet-landed
   row on My downloads; a season: "and every new episode of Season N".
   Ask the quality with `/api/offline/wish-options` (or the remembered one).
2. **Show it**: on the title ("Will be saved to this device when it arrives"),
   and in Downloads / On this device as a row "Waiting for the server's copy"
   with Cancel (`DELETE`). A failed wish: its `error`, with Dismiss (`DELETE`).
3. **Act on it** — on app start, when the app comes back to the front, when
   the socket (re)connects, and on every `offline_wish` message:
   `GET …/offline-wishes?device=<mine>`, then for every `ready` wish not saved
   or being saved here yet, save `libraryId` at `readyQuality` by itself, one
   after another; on success `POST …/saved`. A wish whose save fails stays
   `ready` (the device's own row says why, with Retry).
4. A season wish's own row says "Saving new episodes of Season N as they
   arrive", with Cancel.

## Server internals (for reviewers)

- `src/media/offlinewish.js` — the store (`data/offline-wishes.json`,
  `{ wishes: [] }`, safety bound 500 per profile; the oldest failed one makes
  room, a live one never), `add/list/remove`, `landed(job, destPath)` and
  `ended(job, how)`.
- `src/media/downloads.js` — `tellWishes(job, …)` beside `tellMyList` /
  `tellReplace`: `finish()` (landed), `fail()`, `cancel()`, `decline()`,
  `remove()` of a live job. A replacement download never touches wishes.
- On landing the file is looked for until the library has indexed AND probed
  it (up to 3 minutes, every 2 s), so Original can be judged (a remux needs the
  codecs); then `offline.prepare(libraryId, q, { hevc }, { keepMs: 3 days,
  person: true })` — a person's request (ahead of copies made ahead of time),
  kept 3 days for the device to come back (the copy folder's cap still
  applies; a swept copy is made again on the device's own prepare).
- `offline.onReady(fn)` tells the wishes when a copy is done (push + socket).
- `lib/push.js sendToKey(profileId, key, msg)` — one subscription only.

## Notes for the phone app (`offline-phone`)

- Device id: use one stable id per installed app (`[A-Za-z0-9_-]{8,48}`); the
  phone's remote/Play-on-TV id is fine. Send `deviceName` (e.g. "Pixel 8").
- `hevc`: true when the phone's decoder plays HEVC (most do) — Original of an
  HEVC file is then a repackaging, not a re-encode.
- Act on wishes at app start, on resume (AppState "active"), on socket
  reconnect and on `offline_wish`. Save `libraryId` at `readyQuality` with the
  app's own offline flow, then `POST …/saved`. Never delete a wish because a
  save failed: keep it `ready`, show the save's own error with Retry.
- Show waiting / season / failed wishes in the phone's Downloads with the same
  words as the website: "Waiting for the server's copy — it is saved here by
  itself when it arrives" (Cancel), "Every new episode of season N" (Cancel),
  "Won't arrive — <error>" (Dismiss); the title's button: "This device too" /
  "Will be saved to this device".
- The website saves its copy in 16 MB Range parts and carries on after any
  interruption (docs/offline-audit.md); the old one-request download of
  `/offline/file/:id` is still answered as before. `/offline/file/:id` now has a
  stable ETag for the life of the copy (its name + size), so a phone can resume
  a half-done file with `Range` + `If-Range`.

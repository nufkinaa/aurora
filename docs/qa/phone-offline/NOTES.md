# Phone downloads / offline — 2026-10-20 (branch fix-phone-offline)

## Why "Original" said "Preparing on the server" for ever

`src/media/offline.js` had ONE slot (`running`) for every copy. A play-ready copy made ahead
of time after a download (`preconvert.js`, 1080p re-encode) took the slot, then waited at
`cpuwork.background.gate("encode")` while anybody's stream was being encoded (and on Linux
was paused with SIGSTOP under one) — still holding the slot. The person's own request
(Original = a few-seconds repackaging, or a sized encode) was queued behind it with no log
line and state `queued`; the phone showed "Preparing 0%". Reproduced in Chrome at 390 px with
`test/ui/support/offline-busy.js` (before-*.png: still "Preparing 0%" after 20 s;
after-*.png: saved in ~2 s).

Fix: two lanes (repackagings never wait for an encode), a person's request goes ahead of
made-ahead copies (passes one waiting for its place, sets aside one running), every wait has
a reason (`status().wait`), Cancel reaches the server (`POST /api/offline/cancel/:id`),
failed / swept copies can be made again, a silent ffmpeg is stopped after 10 min.

## Which button does what on a phone (the decision)

- **Save offline** (offline.js): a copy this device plays, kept inside Aurora (Saved), with
  a size to pick, progress on My downloads and On this device, plays with no network.
- **Download to this device** (downloadPicker.js): the library's raw file handed to the
  browser. On an iPhone it goes to Files, outside Aurora, often an MKV / AC-3 the phone
  can't play, with no progress anywhere in Aurora.

A touch-first device (`pointer: coarse`, phones and tablets) where offline saving works
(https) gets **Save offline** wherever it used to get the raw file: the episode card's button,
the title page, the season bar ("Save season offline (N)" instead of "Download season to
device"), and the "Yours" row of a sources / hold sheet. "Save 3 offline" stays. A computer
keeps both (a file for VLC is a real use there). On plain http (no offline storage) the phone
keeps the raw file as its only way. The player has no download action (unchanged).

## Screenshots

- `before-*` / `after-*`: the iPhone report, old vs new code, busy server.
- `wait2-*`, `test-waiting-*`: a save that waits (encode while somebody streams): reason,
  moving bar, Cancel, on the title, My downloads and On this device.
- `pass2-glass-390-*`, `pass-classic-375-*`: episode card save (sheet, %, tick, Remove asks
  first), My downloads, film actions, Saved list, playing with the network cut.
- `pass-*-downloads-both`: a server download and a device save on the same screen.
- `pass-glass-390-episode-sheet`, `test-buttons-*`: hold sheet / buttons per look and width.
- `test-storage-full`: no room on the device.

Not verified: real iPhone Safari (Cache API with a streamed body, storage quota numbers,
HEVC `canPlayType`) — all checks are Chrome with touch emulation.

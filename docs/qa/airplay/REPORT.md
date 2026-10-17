# AirPlay from the web player — 2026-10-17

Matan's report, from the player: "Airplay do not work".

**This could not be tested on a real Apple device.** The test rig has no Mac, iPhone, iPad or Apple TV. Everything below was tested with WebKit's AirPlay API stubbed into Chrome. The receiver's requests were made by Node with no cookie and no headers, which is all a receiver has. The owner's steps for a real device are in "Test it for real" at the end.

## Why it didn't work

With AirPlay video, Safari does not send the picture. It sends the media's **address**, and the Apple TV fetches it **itself**. Each of these broke that on its own:

1. **Mac and iPad: hls.js streams have no address, and hls.js turns AirPlay off.**
   - Only the iPhone plays HLS natively (`nativeHlsFor` is iPhone-only). On a Mac or iPad every stream goes through hls.js: MKV, AC-3 audio, the quality ladder.
   - hls.js feeds the `<video>` through ManagedMediaSource, a `blob:` URL that means nothing on another device.
   - hls.js 1.6.16 also sets `video.disableRemotePlayback = true` when it attaches a ManagedMediaSource. WebKit requires this unless an AirPlay alternative source is given.
   - So Safari never offered AirPlay, and the old button was hidden whenever `hls` was set. Only a file played as itself (an MP4) could be offered.
2. **Sign-in required: the Apple TV has no session.** It sends no `aurora_session` cookie and no `X-Session` header. In sign-in mode "closed", the wall in server.js refused every `/stream/*` request with 401: playlists, segments and the file. That broke even the iPhone's native-HLS AirPlay and MP4 files. Both could work in "open" mode.
3. **Codecs and containers.** The Apple TV plays H.264 or HEVC with AAC or Dolby audio, in MP4 or HLS. HEVC in HLS has to be fMP4 with the `hvc1` tag. MKV, AVI, DTS, AV1, VP9 and 10-bit H.264 need the server's stream.
4. **Subtitles never reached the TV.** The player draws them through `<track>`. Over AirPlay, Apple TV only shows subtitles listed as renditions in an HLS master playlist (`EXT-X-MEDIA TYPE=SUBTITLES`). Side-loaded WebVTT is not sent.
5. **The address.** When Aurora is opened as `http://localhost:4000` on the server machine, the TV is given `localhost`, which it cannot reach.

Sources:
- WebKit, [How to use Media Source Extensions with AirPlay](https://webkit.org/blog/15036/how-to-use-media-source-extensions-with-airplay/): put the MSE/MMS object URL first and an AirPlay-compatible `<source>` (HLS) second. On AirPlay, Safari switches to the second.
- MDN, [ManagedMediaSource](https://developer.mozilla.org/en-US/docs/Web/API/ManagedMediaSource): it only opens when remote playback is disabled or an AirPlay alternative is provided.
- WebKit [bug 274195](https://bugs.webkit.org/show_bug.cgi?id=274195): the alternative only counts while the element loads from `<source>` children, not from `src`.
- WebKit [bug 306052](https://bugs.webkit.org/show_bug.cgi?id=306052), fixed 2026-01: on iOS, MMS videos fall back to the AirPlay-compatible source when a route activates.
- [Wowza/Flowplayer AirPlay docs](https://developer.wowza.com/docs/wowza-flowplayer/plugins/airplay) and the [THEOplayer AirPlay limitations FAQ](https://optiview.dolby.com/docs/theoplayer/faq/what-are-the-limitations-of-AirPlay/): side-loaded WebVTT is not shown over AirPlay, and MSE blob sources can't be AirPlayed.

## What was built

### Server

**AirPlay links (`src/lib/airtoken.js`).** A link is `/air/<token>/stream/…`.
- **The token.** `base64url(payload).HMAC-SHA256`. The key is random per process and never written down, so a restart ends every link.
- **Why the token is in the path.** Every address in a playlist is relative (`index.m3u8?v=…`, `seg00012.m4s?…`, `init.mp4`, `sub/0.m3u8`). Resolved against `/air/<token>/stream/…/`, they keep the token, with no playlist rewritten.
- **The payload:**
  - the title: `l:<library id>` or `t:<infoHash>:<fileIdx>`
  - the profile that asked
  - a digest of the asking sign-in session (never the session itself)
  - the asker's kids age limit
  - the expiry
  - a nonce
- **What it opens:** GET and HEAD of that one title's stream paths, and nothing else. That covers the file, the remux, the jit playlists and segments, the offset transcode, and the AirPlay master and subtitle playlists. It never opens `/api`, `/img`, `/stream/download`, other titles, or POST (not even the jit goodbye beacon). `pathScope()` holds the whole list.
- **Lifetime:** the film's length plus 2 h, at least 3 h and at most 8 h.
- **It stops working when:**
  - it expires;
  - the session that asked ends (sign out, or the admin's Kick or Reset password);
  - the profile is locked, deleted, or owes a new password;
  - it was made without a session (open mode) and the wall is now closed.
- **The middleware** runs before the sign-in wall. It:
  1. checks the token;
  2. takes **every** credential off the request (cookie, `X-Session`, `X-Profile-Token`, `X-Profile`, the admin header, the internal pass);
  3. rewrites `req.url` to the stream path;
  4. sets `req.air`.

**The other gates.**
- **The wall (`server.js`)** lets a `req.air` request through.
- **The reset gate (`src/lib/resetgate.js`)** refuses a link whose profile owes a new password.
- **The kids rules (`src/routes/api.js` `kidsFor`)** judge a link as its asker. They apply the stricter of the limit in the link and the profile's limit now.
- **The kids gate (`src/lib/kids.js`)** also judges the new `/stream/airplay/<id>` paths.

**`POST /api/airplay/link` (`src/routes/airplay.js`).** Takes `{ path }` and returns `{ url, expiresAt, needed, origin? }`.
- The path must be a stream path a link may open, of a title that exists.
- The kids gate is run on exactly that path, as the asker, before anything is signed.
- `needed: false` means the server is open (open or transition mode), so the plain address plays for anyone on the network.
- `origin` is set when the page was opened as localhost. It is the server machine's home-network address, so the TV can reach it. That address is a private IPv4 of a real adapter, 192.168.x first.

**The AirPlay master playlist (`/stream/airplay/<id>/master.m3u8` in `src/routes/stream.js`).** This is how a title with subtitles goes to the TV.
- Its one variant is the jit stream, with the same query passed through.
- Every subtitle of the title is a WebVTT `EXT-X-MEDIA TYPE=SUBTITLES` rendition. The one that is on in the player is `DEFAULT=YES`, the rest `AUTOSELECT=YES`, all `FORCED=NO`.
- Each subtitle is one segment as long as the film. Its WebVTT gets `X-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000`. That is jit's constant 10 s media-clock offset (`jit.TS_OFFSET_SEC`) in 90 kHz units.
- `subtitles.vttText()` serves sidecar `.srt`/`.vtt` files and tracks inside the film. It uses the same extraction cache as the player.

### Web player

**`public/js/airplay.js` picks what the TV gets** (`receiverSource(item)`):

| Title | The TV gets |
|---|---|
| MP4 or MOV; H.264 8-bit or HEVC; AAC, AC-3, E-AC-3 or MP3; first audio track; no subtitle on | the file |
| Any other title the TV can decode | the jit stream as fMP4 (`seg=fmp4`, plus `vtag=hvc1` for HEVC, plus `a=N` for another track) |
| AV1, VP9, 10-bit H.264, MPEG-2 and the like | the full encode (`v=h264&seg=fmp4`) |
| A library title with subtitles, when a stream is needed or a subtitle is on | the AirPlay master |
| A torrent | the file (MP4), or the torrent's jit stream (MKV) |

These can't be sent, and the player says why instead: an offline copy, AVI and other containers jit can't index, and a torrent whose format isn't known yet.

**`createAirplay()` does the switching:**
- **The button** shows only when Safari says a TV is in reach (`webkitplaybacktargetavailabilitychanged`). A press opens `webkitShowPlaybackTargetPicker()` inside the gesture. If the title can't go, a message appears instead of the picker.
- **The AirPlay alternative.** On an element where hls.js has put a ManagedMediaSource, the signed link is added as an AirPlay alternative `<source>`, after hls.js's own. `disableRemotePlayback` goes back to `false`.
  - This is WebKit's documented pattern, so Safari's own AirPlay menus work too: Control Center, the macOS menu bar, the iPad's native controls.
  - The alternative is put back after every hls.js re-attach (`MEDIA_ATTACHED`).
  - It can be turned off with `localStorage["aurora-airplay-alt"] = "0"`.
- **When the TV takes over** (`webkitcurrentplaybacktargetiswirelesschanged` turns true), one of three things happens:
  - Normally, hls.js comes off and the element plays the signed absolute link at the same position.
  - If Safari already moved to the alternative source, the element keeps playing it untouched.
  - If the server is open and the element already plays a plain address (an iPhone playing the file), nothing changes.
- **When AirPlay ends,** the player puts back what it was playing, at the position the TV reached: the jit stream or ladder, the offset job, the remux or the file. A paused TV comes back paused.
- **When the TV reports an error,** the player gets one fresh link and resumes at the same spot; the old link may have expired, or the server restarted. A second error within 2 minutes shows "The TV couldn't play this film…".
- **Another audio track while on AirPlay:** the TV is sent the same film with that track, at the same spot.

**`public/js/screens/player.js`.**
- While on AirPlay, nothing may put another stream on the element. `startHls`, `startDirect`, `startTranscode`, `startTranscodeAt` and `tryJitSwitch` stand down. So do the decode-stall and silent-audio watchdogs and the element-error fallbacks.
- A quality pick during AirPlay shows a message: the TV gets the full picture.

**Smaller changes.**
- `public/js/api.js`: `api.airplayLink(path, profileId)`.
- `public/css/glass.css`: the AirPlay button is lit while on AirPlay.

### Chromecast and the Remote Playback API

The player never used them; there is no Cast button. The change touches `disableRemotePlayback` only in Safari (the WebKit picker must exist), and only on an element where hls.js put a ManagedMediaSource `<source>`. In Chrome nothing is listened to and nothing on the element changes.

The UI test checks this for a direct file and for an hls.js stream: `disableRemotePlayback` stays `false`, no `<source>` is added, and no AirPlay button shows. Chrome's own "Cast…" menu (tab casting) doesn't depend on the element.

## Tests

**`test/airtoken.test.js`** (10 tests):
- which paths belong to which title, and which never do;
- minting and verifying: tampering, a re-signed payload, expiry, the nonce;
- the lifetime bounds, and GET/HEAD only;
- the middleware:
  - credentials are stripped and the query is kept;
  - relative segment URLs keep the token;
  - an encoded `..` is refused;
  - links stop for an ended session, a due reset, a locked or deleted profile, and an open-mode link once the wall closes;
  - requests outside `/air` are untouched;
- the VTT timestamp map.

**`test/airplay-client.test.js`** (19 tests, WebKit stubbed):
- the receiver source for every kind of title, and the refusals;
- localhost handling, including the home-network origin the server gives;
- the button and the picker;
- the alternative `<source>`, and its off switch;
- the switch to the link at the same position, and back;
- keeping Safari's own switch;
- an open server with a plain address;
- a title that can't be sent, and a refused link;
- receiver errors (one fresh link, then a message);
- an audio change while on AirPlay;
- Chrome: nothing touched.

**`test/ui/airplay.test.js`** (3 tests; a private instance, real Chrome, WebKit's API stubbed):
- **Sign-in required, end to end.**
  - The button appears only once a TV is in reach, and pressing it opens the picker.
  - When the TV takes over, the element plays an absolute `/air/…/stream/airplay/<film2>/master.m3u8?seg=fmp4&sub=0`.
  - The receiver fetches the master, the variant, `init.mp4`, a segment, the subtitle playlist and the VTT (with the map) with **no credential**. All return 200.
  - The same token is refused for another title (403), the API (403) and the download route (403). The same stream without the link returns 401, and so does a changed token.
  - No error card shows while on AirPlay. After AirPlay ends, hls.js is back near the same spot.
  - Signing out kills the link (401).
- **Kids.**
  - A 7+ profile gets no link for an 18+ title (403).
  - A grown-up's link stops working (403) once that profile is made a kids profile.
  - Unsigned paths and odd queries return 400, and an unknown title 404.
- **Chrome.** No button, and remote playback is left alone.

**Screenshots** (desktop and phone, real Chrome, WebKit stubbed):
1. No TV in reach: no button.
2. A TV in reach: the AirPlay button in the tools row.
3. On AirPlay: the button is lit. Chrome can't play the TV's stream, so it shows the "TV couldn't play" message.

## What could not be verified (needs a real Apple device)

- **The alternative `<source>` on macOS Safari 17+ and iPadOS 17+ (ManagedMediaSource).** Untested: whether Safari honours an alternative added after hls.js attached. If it misbehaves, there are two fallbacks:
  - when the TV takes over, the switch still sets `src` itself;
  - `localStorage["aurora-airplay-alt"]="0"` turns the alternative off.
- **Whether `webkitplaybacktargetavailabilitychanged` says "available" on an hls.js element before the alternative is in place.** If it doesn't, the button never appears on a Mac with ManagedMediaSource: the link is prepared and the alternative attached only on the first availability event. The one exception is if WebKit reports availability regardless. **This is the first thing to check on a Mac.**
- **Subtitles on the Apple TV:** the timing through `X-TIMESTAMP-MAP`, and whether a master without `CODECS` is accepted. `BANDWIDTH` is the file's rate × 1.25 + 192k, or 12 Mbit/s for the encode.
- **iPhone in native fullscreen:** setting `src` when AirPlay starts may drop the phone out of fullscreen. This only happens when sign-in is required or the stream is not a plain address.
- **The next episode while on AirPlay:** it opens a new player and element, so AirPlay most likely ends and the episode plays on the device.
- **The reverse proxy in front of nufurora.com** must pass `/air/` to Aurora, as it passes `/stream/` and `/api/`. The repo has no proxy config to check. If it only forwards a fixed list of paths, add `/air/` to it.
- **The home-network address** is a guess from the network adapters: 192.168.x first, virtual adapters skipped. On this PC it picked 192.168.50.108; the server's own startup line printed 172.16.0.6, a virtual adapter.

## Test it for real (owner)

You need an Apple TV, and an iPhone or a Mac (ideally both), all on the home Wi-Fi.

### A. Mac, Safari, a server that requires sign-in

Use nufurora.com, or the LAN server in mode "closed".

1. Sign in on the Mac and open a **library MKV film**. Most of the library is MKV, which hls.js plays.
2. Move the mouse over the player. An **AirPlay** button (a screen with a triangle) should appear in the right-hand tools row, next to Picture in picture.
   - If it doesn't, open Safari's Web Inspector console and run these two lines. Note both answers.
     - `document.querySelector('.player video').querySelectorAll('source').length`
     - `document.querySelector('.player video').disableRemotePlayback`
3. Press it and pick the Apple TV. Within a few seconds the TV should start the film **at the same minute**. The Mac shows Safari's "playing on Apple TV" placard, and the button is lit.
4. Seek on the Mac's timeline, and press ±10 s. The TV should follow.
5. On a title that has subtitles, turn subtitles on in the player before step 3. The Apple TV's subtitle menu (swipe down) should list them, with the one you had on already showing. Check that the timing is right.
6. On a multi-dub title, pick another audio track in the player's settings. The TV should reload with that track at the same spot.
7. Stop AirPlay, with the button or from the Apple TV's menu. The Mac should resume **where the TV was**, back on hls.js (the Quality menu returns).
8. While the film plays, start AirPlay from **Control Center → Screen Mirroring**, or from the macOS menu-bar AirPlay icon. It should behave as in step 3.
9. Try an **MP4 film** (plays as the file) and an **HEVC film**. The TV should play both.

### B. iPhone, Safari, sign-in required

1. Open a film. Start AirPlay from the player's button, then again from the native fullscreen controls. The TV should play at the same minute.
2. Note whether the phone drops out of fullscreen when the TV takes over.

### C. Things that should say no, nicely

- **A film saved offline on the phone (Downloads).** The AirPlay button should say "This is the copy saved on this device…".
- **Localhost on the server PC.** Open `http://localhost:4000` on the PC itself. AirPlay should still work, because the TV gets the PC's 192.168.x address. If it says "needs Aurora opened by its network address", the PC has no usable home-network adapter.
- **A kids profile.** AirPlay works for a title the profile can play. The link refuses anything else.

### D. Security spot checks (any computer)

1. While AirPlaying, copy the address the TV got. In Web Inspector: `document.querySelector('.player video').currentSrc`.
2. Open it in another browser with no sign-in. It should play (that is the point), but only that film's stream.
3. Change the film id in the address: 403. Change `/stream/…` to `/api/library`: 403.
4. Sign out on the Mac. The address should stop working (401).
5. Without anything done, it stops by itself after 3 to 8 hours, depending on the film's length.

If something misbehaves, send back the Safari console lines and the server log lines around `/air/`. The token never reaches telemetry: it is reduced to `/air/:id/…`.

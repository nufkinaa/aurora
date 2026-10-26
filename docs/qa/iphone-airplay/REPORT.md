# iPhone AirPlay sound-only + stalls (branch fix-iphone-airplay, 5e685d1)

Matan is on nufurora.com (sign-in mode closed); the house server has no Korra and no iPhone telemetry, so the stall findings come from the code.

## AirPlay sound only
An iPhone uses native HLS (`nativeHlsFor`, player.js:204), not hls.js. When AirPlay is picked, iOS hands the TV the plain stream address at once; on a closed server that needs the session cookie, so the TV gets a 401. The switch to a signed link ran only after the "now wireless" event, too late. (Sound-only card = inference, not device-tested.)
Fixes: signed copy of the same address as soon as Safari reports a TV in reach on a sign-in server (airplay.js:330–360, player.js:907, 2795; off switch `localStorage["aurora-airplay-twin"]="0"`); subtitle master only when a subtitle is on, now with RESOLUTION/FRAME-RATE/CODECS (stream.js:833); "Playing on the TV · No picture there?" toast sends the H.264 encode; TV errors step down one at a time (drop subtitle → fresh link → H.264 → message); expired link refreshed at the same spot.

## Stalls
1. The line watcher stepped native HLS down to a live 480/720 encode on "under 8 s buffered" (hls.js rule) — native HLS exempt now (player.js:5685).
2. Any native-copy error was treated as "device refuses the copy" and escalated to a full encode, sometimes restarting at 0:00 — retried in place up to 3× in 5 min first (player.js:6273).
3. No recovery for native stalls — seek in place at 20 s, reload at 45 s, error card at 90 s (player.js:5936).
4. Step-down and line watcher stand down during AirPlay.
New start-up marks: step-down, media-error, airplay, stall.

Tests: airplay-client 27 pass (8 new); UI airplay-iphone (4) + airplay (3) ×3 green in Chrome with Matan's UA at 430×745; root npm test 1934 ×2; whole test:ui 362 ×2.

## Checks on an iPhone + Apple TV (nufurora.com)
1. MKV episode, wait 1 s; Web Inspector: `document.querySelector('.player video').getAttribute('src')` starts `https://nufurora.com/air/…/stream/transcode/…`.
2. Subtitles off, AirPlay from the player's button: TV shows the picture at the same minute; phone shows "Playing on the TV · No picture there?"; seeks follow.
3. Same from fullscreen AirPlay, Control Center → Screen Mirroring, Now Playing AirPlay.
4. Subtitle on: shown on the TV, or "The TV couldn't take the subtitles…" and carries on.
5. Sound only: press "No picture there?"; note Apple TV model and file codec.
6. Stop AirPlay: phone resumes where the TV was, no resume card.
7. 10 min away from home: no "Auto 480p/720p" chip on a good line, no freezes.
8. Restart the server mid-film: the phone carries on.

Not verified: any real iPhone/Apple TV (whether iOS hands over the signed address; fullscreen kept across the address switch; Safari's buffer); WebKit (not installed); Matan's stall data; a stream on the signed address idles out ~2.5 min after leaving instead of stopping.

# TV problems (parked — for the TV agent)

Findings from the web-side audit and the usage stats of 2026-09-14 → 16.
Nothing here has been changed in `tv-native/`; the server side that the
fixes need is already in place where noted.

## 1. Hero trailers autoplay far too much on the TV (biggest item)

- Usage stats: `trailer_play` was used 876 times, 822 of them on the TV,
  against 10 TV home views — roughly 80 trailer starts per visit to Home.
- The same box (MIBOX3, Android 9) reports the slowest screens in the whole
  household by a mile: `tv:home` 21 s median / 113 s p90 to painted,
  `tv:detail` 10 s / 67 s, `tv:player` 14 s / 31 s. Web screens paint in
  under 200 ms.
- The 3× `Cannot read properties of undefined (reading 'M_ID')` client
  errors come from YouTube's iframe player, i.e. the trailer path.
- Suggested: default the TV hero trailers OFF (or one trailer per dwell with a
  long cooldown), and measure `tv:home` again. The web player defaults them
  off on phones for the same reason.

## 2. Multi-dub releases: no way to pick the audio track

- Report (DorM, 2h ago on tv:WhatsNew): "multidub video — user can't switch
  dubs".
- Server side is done (commit `4e4dc71`): the probe reports every audio
  stream with `index`, `language`, `title`, `codec`, `channels`
  (`/api/torrents/probe/:hash/:idx` → `audioStreams`; library items carry
  `audioTracks` when there is more than one). Both HLS transcode paths take
  `?a=<audio index>` on the playlist URL (`/stream/torrent/hls/.../index.m3u8?v=copy&a=1`,
  `/stream/transcode/:id/:ss/index.m3u8?v=copy&a=1`); segment URIs carry it
  themselves. One job per chosen track.
- The web player shows an "Audio" section in the settings menu and restarts
  at the current position with the chosen track. The TV needs the same menu
  entry and the same restart-through-transcode.

## 3. Resolution badge said 720p for letterboxed 1080p

- Web fix in `public/js/ui.js` (`resTier`): judge by width OR height. A
  2.40:1 film is 1920×800, and height alone reads as 720p. If the TV has its
  own badge logic, apply the same rule.

## 4. Closed sign-in mode

- Supported: `tv-native/src/api.ts` reads `authMode` from `/api/ping`, sends
  the session header on every request (images and video included), reacts
  to a `401 {signinRequired:true}` by clearing credentials and showing
  `screens/SignIn.tsx`. Nothing to do unless the rollout shows otherwise.

## 5. Things worth a look while in there

- The TV reports its look as "legacy" in the usage stats (907 of 1718
  events), which skews the looks split; harmless, but a `tv` look value would
  make the analytics honest.
- `library/hls-copy` first frame on the TV: 2.5 s median, 4 s p90 — fine.

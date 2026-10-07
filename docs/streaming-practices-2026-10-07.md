# Streaming practices Aurora lacks — 2026-10-07

Mirror of the Claude doc "Streaming practices Aurora lacks" (https://claude.ai/code/artifact/39482cd1-ab37-49d1-b652-aa70ae69e5d1), written for elia after 1.6.50.

## Already in place
Slow-line cap (720p/480p) with step-down/step-up and Data saver · Original = bit-exact copy (direct play / HLS copy), re-encode only where the device can't decode (crf 18) · pre-convert after download · seek-bar frame previews, Continue Watching frames, skip intro/credits, Up next · sized WebP pictures with fade/retry/fallback, idle-time hero upgrade · idle prefetch · offline service worker, device downloads, API retries, problem reports · watch together, TV code sign-in, device list, sign-in rollout, shortcuts, muted hero trailer · glass/sky device tiers.

## Playback gaps
| Practice | Aurora today | Value | Effort |
| --- | --- | --- | --- |
| Quality ladder (ABR: renditions in one master playlist, per-segment switching) | one capped stream at a time; a switch restarts | High | High |
| Fast start low then climb | start decided by probe; climb = restart | Medium | falls out of the ladder |
| Media Session API (lock screen, media keys) | none | Medium | Low |
| Picture in picture | none | Low–Medium | Low |
| Casting (Chromecast/AirPlay) | none (TV app is the path) | Medium | AirPlay low, Cast high |
| Tone mapping on HDR re-encodes | 10-bit folded to 8-bit, no tonemap | Medium (4K HDR) | Low–Medium |
| Resume 3–5 s early | exact second (to confirm) | Low | Low |
| Remembered audio/subtitle language per profile | per title (to confirm) | Medium | Low |
| Still watching? prompt | none | Low | Low |

## Pictures & page speed gaps
Blur-up placeholders (Medium/Medium) · dominant-colour tiles (Low/Low) · AVIF beside WebP (Low/Low) · virtualised long grids (Medium on phones/Medium) · skeleton screens (Low/Low).

## Resilience gaps
Segment retry policy (hls.js defaults) · stall nudge/segment reload · player-level error card with Try again · line-health indicator before the stall.

## Discovery, accounts, devices gaps
Kids profiles with PIN + rating gate (High/Medium) · Web Push notifications (Medium/Medium) · "Because you watched" naming (Low/Low) · follow a show (Low–Medium/Low) · viewer-side sign out everywhere (Low/Low).

## Do next
1. Media Session API. 2. Blur-up placeholders. 3. Tone-mapped HDR re-encodes. 4. Kids profiles with PIN. 5. Real quality ladder for library files (background 720p/480p renditions + master playlist + hls.js ABR). Alongside: resume early, Still watching?. Casting deliberately later.

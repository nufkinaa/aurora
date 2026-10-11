# TV bundle `tv-safe-perf` — the device pass

*Branch `tv-safe-perf`, merged with master at server 1.6.96. Nothing below has
been run on a TV: this is the list for the real Mi TV (no sandbox). No version
was bumped and no APK was published.*

Every item says **what to do** and **the evidence that passes it**. A line
with no evidence written down is not passed.

## 0. Before the first press

| | do | evidence |
|---|---|---|
| 0.1 | Server for the pass: this branch on its own port with its own data folder (never production on :4000). `tools/ttff/lib.js startInstance`, or the branch checked out beside production. | `GET /api/ping` on that port answers; `authMode` as the section needs. |
| 0.2 | QA variant APK: this PC's LAN address first in `SERVER_CANDIDATES` (lab builds keep the local server first; the release keeps nufurora-first — `src/serverPick.ts` is not to be touched), `gradlew assembleRelease`, **"BUILD SUCCESSFUL" read before installing**, `adb install -r`, then `sed -i '/QA VARIANT/d' tv-native/src/api.ts`. | `grep -ac <LAN ip> index.android.bundle` ≥ 1 in the QA build and **0** in anything published. |
| 0.3 | `adb logcat -c`, then `adb logcat ReactNativeJS:V *:S > pass.log` for the whole pass. Server stdout to a file. | both files exist and grow. |
| 0.4 | Stay-awake stays on (`svc power stayon true`); never switch it off. | — |
| 0.5 | The picture patch is in the build: `test/tv-image-headers-patch.test.js` green in this tree. | test passes (it does at this commit). |

## 1. First frame — one number, twice

The player stamps the first frame once (`noteFirstFrame`, Player.tsx): on
ExoPlayer's first READY-for-display, or the first clock tick, whichever comes
first. The same reading goes to the server's play mark, to the usage event and
to the analytics timing.

| | do | evidence |
|---|---|---|
| 1.1 | Play a library film from its title page (direct play). | logcat `[player] first frame +N ms meta=… armed=… buf=2000` and the server log `[play] <id> +Nms first-frame transcode=false v=direct app=tv meta=… armed=… buf=2000` carry **the same N** (and the same meta / armed). |
| 1.2 | Admin → App health → timings, `play_first_frame` for the TV: the newest sample. | equals N of 1.1 (the usage event carries `ms: N`; ±0 ms — it is one variable). |
| 1.3 | A resume (film left at ~40%). | exactly **one** `first-frame` line per start; N is the picture at the resume point, not the film's first frame (compare with a stopwatch on a phone video: within ~150 ms). |
| 1.4 | A file whose sound the TV cannot play (AC-3 / E-AC-3: the offset job). | one `first-frame` line with `transcode=true v=copy`; `armed − meta` ≈ 0. |
| 1.5 | Open the same film from its title page within 30 s of the page loading. | no `GET /api/profiles/<id>/state` between the press and `first-frame` in the server log (the fresh state is reused); `meta` is small (item memoised: a few ms). |
| 1.6 | Watch 20 s, Back, press Play again at once. | it resumes where it was left (the saved progress was not masked by the reused state: `forgetState` on save). |
| 1.7 | Next episode (Up next → play). | one `first-frame` per episode, each from its own mount (+0ms `mount` line before it). |

## 2. The three `tvPlayer` switches — one at a time

All three are **off** unless the server's config.json has `"tvPlayer"`. Follow
the device plan in `docs/qa/ttff/REPORT.md` §8: the line is
`node tools/throttle-proxy.js --listen 4010 --to <port> --down D --up U --latency L --handshake 1 --slowstart 1`,
the QA build pointed at `:4010`; four corners (LL-HB 100000/40000/2, HL-HB
50000/20000/90, HL-LB 3000/1000/100, LL-LB 3000/1000/5); files: an MKV the TV
plays itself, an MP4 with its index at the end, an AC-3 file, and a resume at
40% of each; 5 cold + 5 warm per cell, reading `first-frame`.

| | do | evidence |
|---|---|---|
| 2.0 | Baseline: no `tvPlayer` key. `curl <server>/api/tv/tuning`. | `{}`; marks say `buf=2000`. The table of medians per file × line is written down — everything below is compared with it. |
| 2.1 | **`startBufferMs`** alone: `"tvPlayer": {"startBufferMs": 1000}`, restart the dev server, wait a minute (or leave and re-enter Home). | marks say `buf=1000`. Median `first-frame` per cell against 2.0: expected ≈ unchanged on LL-HB / HL-HB, up to −0.9 s on the 3 Mbit/s lines. Then ten minutes of a film on LL-LB and on the real home Wi-Fi: the count of `stall` marks is **not higher** than the same ten minutes at 2000. Only then try 500. |
| 2.2 | **`rebufferMs`** alone: `{"rebufferMs": 4000}` (start buffer back to default). | marks say `buf=2000`. Force a stall on LL-LB (seek far ahead on a direct file): time from `stall` to `stall-end` against the same seek at 8000; no rise in the number of stalls over ten minutes. |
| 2.3 | **`resumeAtSource`** alone: `{"resumeAtSource": true}`; the resume runs only. | `first-frame` lower than 2.0's resume cells by about one seek + one start buffer; the resume card shows; the scrubber starts AT the resume point (not at 0:00 and then jumping); subtitles are in time 30 s in; Back and re-enter resumes at the same second. The AC-3 file's resume (offset path — the switch does not touch it) is unchanged from 2.0. |
| 2.4 | Remove the key, restart. | `/api/tv/tuning` is `{}` again; marks back to `buf=2000` within a minute. |
| 2.5 | What wins goes into production's config.json — no new APK. | the chosen values and their tables are written under this section. |

## 3. Sign-in required (closed mode)

`node adm.js POST api/admin/auth-mode '{"mode":"closed"}'` on the pass's
server; pair the TV by approving its on-screen code with the test profile.
**Set the mode back to "transition" afterwards** (kids tests fail while closed).

| | do | evidence |
|---|---|---|
| 3.1 | Home, Movies, Shows, a film's page, a show's page with episode stills, Search, a Continue Watching resume frame. | every picture drawn (photos of each screen). `grep -c "\[auth\] 401" <server stdout>` = **0** for the whole section. |
| 3.2 | `/api/tv/tuning` in closed mode. | the server log shows `GET /api/tv/tuning` answered 200 for the TV's session (not 401); with 2.1's key set, marks say `buf=1000`. |
| 3.3 | Play a direct file and an AC-3 file. | both start; no `[auth] 401` on `/stream/…` (ExoPlayer carries the session on every segment) nor on the `&seek=1` claim. |
| 3.4 | Leave the player. | `POST /stream/transcode/<id>/jit/bye` in the server log, 204, no `[auth] 401`. |
| 3.5 | The socket. | the admin page lists the TV as "Aurora TV <version>" within a few seconds of Home. |
| 3.6 | Admin: sign the TV's session out ("kick"). | the TV goes to sign-in once; logcat shows no reconnect loop (no new socket until signed in again). |

## 4. A kids profile

| | do | evidence |
|---|---|---|
| 4.1 | Enter a grown-up profile, open Movies; switch to the kids profile within a minute; open Movies. | the kids list (no title above its rating); photo. Server log: the kids profile's `/api/library` request carries **no** `If-None-Match` from the grown-up's answer (first request after the switch is unconditional). |
| 4.2 | Kids → Settings. | no download switches, no Sign out. |
| 4.3 | Leaving the kids profile asks for the household PIN. | the PIN sheet; a wrong PIN says so (the server's words), no retry storm in the log (a `429` on that POST is shown, never repeated). |
| 4.4 | A title a kids profile may not open (deep link / Continue Watching leftover). | the player says the server's refusal with Back only (no Try again). |

## 5. A forced password reset

| | do | evidence |
|---|---|---|
| 5.1 | Admin → People → force a reset on the QA profile while the TV is on Home. | the TV raises the new-password screen (not the sign-in screen); Back does not leave it. |
| 5.2 | Kill the app, start it again. | the new-password screen again. |
| 5.3 | Same password as before / too short. | refused with the server's reason ("same", "needed"). |
| 5.4 | A valid new password. | Home; the socket reconnects (admin page lists the TV); pictures draw (closed mode: `[auth] 401` still 0). |

## 6. A busy server (503 + Retry-After)

Only an **encode** can be refused (`v=h264`, `h264-480`); a `v=copy` job is
not counted against the budget. So: admin → Server → Encoding → *At once* = 1,
start a transcode that holds the slot from another device (the website on a
phone with a forced lower quality, or a second TV file that needs h264), then
on the TV start a title that needs h264 (a file with no direct-play address,
or the gear menu's lighter stream).

| | do | evidence |
|---|---|---|
| 6.1 | Start it while the slot is held, and free the slot ~6 s later. | the loading state stays up (no error card, no toast); logcat `[player] the server is busy: asking again in 5000 ms (1/3)` (then 2/3 if needed), then `[player] first frame …`. Server log: `503` on the `&seek=1` request, then 200. **No** `error` play-mark storm and no h264→… ladder lines in between. |
| 6.2 | Start it and keep the slot held for a minute. | after three waits (≤ 5 s each; about 15–27 s in all) ONE card: "The server is busy with other streams right now. Try again in a moment." with **Try again / Back**. Nothing further is requested until a press (server log quiet for this title). |
| 6.3 | Press Try again after freeing the slot. | plays. |
| 6.4 | While a direct film is playing, pick the lighter stream (480p) with the slot held. | the film keeps playing; a toast "The server is busy — try again in a moment"; the position is not lost. |
| 6.5 | An ordinary start with the budget free. | `first-frame` medians for the AC-3 file equal section 2.0's (the busy handling added no round trip: the source is still handed over at once). |
| 6.6 | 429: on the TV open Home, Movies, Shows and Search quickly while `ab`/a script holds 4 heavy requests of the same session (or temporarily set `perClient: 1`). | logcat `[api] 429: asking again in N ms (1/2)`; the screen fills without an error state. |

## 7. The server restarts while the app is open

Restart the pass's server (admin → Server → Restart, or the keeper).

| | do | evidence |
|---|---|---|
| 7.1 | On Home, idle. | logcat `[live] the server is restarting: back in N ms` with N between 2000 and 5000; **no toast, no error card**; the admin page lists the TV again within ~10 s of the server being up; Home's rows are still there. |
| 7.2 | Server log after it is back. | the TV's socket arrives once (no burst of upgrades); with two TVs, their reconnects are not in the same 100 ms. |
| 7.3 | While a direct film plays. | the film continues from its buffer or recovers by itself (stall recovery 6/20/45 s); position kept; no error card if the server is back within ~20 s. |
| 7.4 | While an AC-3 (offset) film plays. | buffering, then playing again at the same position (the stuck-playlist recovery re-issues the offset); if it gives up: the "Lost the stream" card with Try again, which resumes. |
| 7.5 | Stop the server for 5 minutes (not a restart). | reconnect tries back off to ≤ 30 s with jitter (timestamps of the socket attempts in logcat / server log are not on a fixed beat); App health later shows one `ws_reconnect` timing for the outage — and **none** for 7.1's planned restart. |

## 8. The library changes

Drop a file into the library folder (or let a download land) on the pass's server.

| | do | evidence |
|---|---|---|
| 8.1 | TV on Home, looking at it. | logcat `[live] home: library changed, rows re-read` within ~0.3 s of the server's `library_updated`; **one** `GET /api/home` in the server log (carrying `If-None-Match`); the new title appears; focus does not move. |
| 8.2 | A season pack landing (many files). | one re-read per coalesced server message — never one per file; never two `/api/home` in flight (server log: each `/api/home` from the TV ends before the next begins). |
| 8.3 | Nothing changed for this profile (a file a kids profile cannot see lands while a kids profile is on Home). | `GET /api/home` → **304** in the server log; no re-render (no picture flicker, `[row]` lines absent). |
| 8.4 | TV on Movies (not Home). | logcat `[live] browse: library changed, shelf re-read` 0.5–5 s after the message; `GET /api/library` with `If-None-Match`; 304 when the list is the same. |
| 8.5 | **While a film plays**: land a file. | logcat shows **no** `[live] … re-read` / `re-reading the library copy` lines during playback; no `/api/library`, `/api/item`, `/api/home` from the TV in the server log; no dropped frames at that moment. |
| 8.6 | Then leave the player. | one re-read 0.5–5 s after leaving (title page: `[live] detail: re-reading the library copy`); back on Home the rows are current. |
| 8.7 | The TV's own download landing (press Play on a title not held, wait). | the title page flips to the copy's Play as before (its own `download_update` path — not delayed by the above). |

## 9. Rows and Home

| | do | evidence |
|---|---|---|
| 9.1 | Hold RIGHT along a 40-card shelf, then LEFT back. | no blank card ever enters the screen; logcat has **no** `[row] behind …` line; `[art] prefetch n=… fail=0`. Frame stats (`dumpsys gfxinfo com.auroratv`) p90 not worse than the 5.1.31 numbers on the same shelf. |
| 9.2 | Return to a shelf after going down three rows and back up. | the shelf is where it was left (same card focused); no reload flash. |
| 9.3 | **Home's vertical window is OFF.** | `HOME_WINDOW` is `false` in `src/homeWindow.ts` of the built commit (`grep -n "HOME_WINDOW: boolean" tv-native/src/homeWindow.ts`); on the TV, going down to the last shelf and back up never shows a shelf mounting late (no empty band). |
| 9.4 | Return to Home from a title page with nothing changed. | no row re-renders (no picture flicker); server: `/api/home` → 304. |
| 9.5 | Movies / Shows first paint. | 5 rows mounted first, the rest follow; no visible pop of the top rows. |

## 10. The rail does not open by itself

| | do | evidence |
|---|---|---|
| 10.1 | From a shelf's first card press LEFT once, release. | focus lands on the rail; the rail does **not** act on the release of that same press (no navigation, no section change). 20 times in a row, at different speeds. |
| 10.2 | Hero: LEFT on Play with a trailer running; UP from the first shelf. | rail opens only on the press that asks for it; UP from Home's top does not wrap into the rail. |
| 10.3 | Open and close the rail 10 times, then idle 30 s. | the rail stays closed; idle renders 0 frames (`gfxinfo` total frames unchanged over the 30 s). |

## 11. The rest of the bundle (regressions to look for after the merge)

| | do | evidence |
|---|---|---|
| 11.1 | Skip recap / Skip intro on a streamed episode; Still watching? after three hands-off episodes. | the pills appear and act; Still watching pauses. |
| 11.2 | Direct-play stall recovery: throttle to 300 kbit for 30 s mid-film. | recovers at 6 / 20 / 45 s steps without losing the position; `stall` / `stall-end` marks. |
| 11.3 | Title page: press an episode not held → saved, and the sources pill one press away. | the job shows on the card; the pill opens the kept list (no second search in the server log). |
| 11.4 | Settings follow the person: toggle autoplay on the website for the QA profile. | the TV's gear menu shows the new value without a restart (`profile_updated`). |
| 11.5 | Route timing and usage. | App health shows route timings for Home / Detail / Player from this TV; no title or typed text in any report (the contract test is green). |
| 11.6 | Profile switch. | nothing of the last profile is shown (lists, AI picks); the reused player state (`stateIfFresh`) is not carried over: the first play as the new profile asks `/api/profiles/<new id>/state`. |
| 11.7 | Memory after an hour of browsing + three films. | PSS not above the 5.1.31 figure by more than ~30 MB (`dumpsys meminfo com.auroratv`). |

## What is known not to be covered by this build

- The TV still plays repackaged streams through the **offset job**, not the
  jit stream: the `bye` it now sends frees nothing server-side today (an
  offset job ends 2.5 minutes after its last request, or at the viewer's next
  seek). The lower rung marked `&need=1` is a jit-ladder offer and does not
  reach the TV.
- A request that fails on the line during a restart (status 0) is not retried
  by the fetch layer; screens that already show content keep it, a screen
  opened in that window shows its usual error with Retry.

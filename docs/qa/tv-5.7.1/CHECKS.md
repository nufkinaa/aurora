# TV 5.7.1 — Mi TV checks (2026-10-28)

Mi TV (192.168.50.31), QA builds vc166–vc176 (QA variant, private instance of tv-5.7.1 through
`adb reverse`, the stall-rig films; a fault proxy between the TV and the instance: freeze /
416 / corrupt HLS segments). Times are from logcat (`[player] …` lines) and the instance's
`[play]` marks. Photo names start with the build they were taken on.

| # | Check | Result | Photo |
|---|---|---|---|
| 1 | Direct film, one broken range request mid-film (416 after a cut) | error at 2:34 → the same file again 0.3 s later → playing on at the same spot; ~4 s lost against the wall clock | — |
| 2 | Direct film, connection frozen (no bytes, new requests hang) | buffer ran out → stall 6 s (nudge), 20 s (same file again), 45–47 s the card "The stream stopped…"; outage ended → moving again ~7 s later at the same spot (456 → 457), card gone | r166-stall-card |
| 3 | Copy, one corrupt segment | PARSING error → same playlist 0.3 s later → moving 3.3 s after the error at the same spot (253.9 → 254.8) | — |
| 4 | Copy, every segment corrupt | 2 reloads (0.3 s, 2 s) then the card "The film stopped…" 2.2–2.6 s after the first error; quiet try every 30 s (logged at :32, :02, :32); fault ended → the next quiet try played on 2.0 s later at 377.9 → 378.8, card gone | r168-film-card |
| 5 | Card → Try again (fault ended) | moving 2.2 s after the press at the same spot (506.9 → 507.8) | — |
| 6 | Copy played 17 s, three errors | not the card: the full encode from the same spot (539 → 538), moving 16 s later (CPU encode on a busy PC) | — |
| 7 | Encoder (ffmpeg) killed mid-film, encode path | error when the buffer ran out (35 s) → the job made again AT the spot (1210 → 1209), moving 14 s after the error, no rewind | — |
| 8 | Remuxer killed mid-film, copy path | the server picked the job up again by itself; the picture never stopped | — |
| 9 | Copy, connection frozen | stall 157 s → reload 20 s (no seek nudge on a repackaged stream) → card at ~46 s while our probe was still waiting; recovered on a quiet try after the outage (see "server" below) | r172-copy-freeze-card |
| 10 | Never 0:00 | every recovery above came back within a GOP of where the film was (copy: up to 8.5 s earlier, the keyframe) | — |
| 11 | Report a problem from the player's menu | focus in the text field at once, keyboard up; typing works; closing the sheet: OK on the player plays/pauses again | r167-report-from-player-focus, r174-report-from-player |
| 12 | Recommend: note typed (2 lines), then the D-pad | 19 presses, quick (adb) and held 320 ms (uinput): faces ↔ note ↔ Send every time, DOWN from the long note lands on Send (not Cancel); edited the note again and sent it to Dana (arrived with the edit) | r174-recommend-note-walk, r174-recommend-note-refocused; before the fix: r168-before-fix-held-up-skipped-note |
| 13 | Start (direct) | first frame 2.4 s | r173-start-jolt |
| 14 | Seek forward (direct, accelerating skip) | 4.5 s rebuffer, playing at the new spot | r173-seek-direct |
| 15 | Resume | reopened at 8:46, where it was left | r173-resume |
| 16 | Watch party, TV hosts, website guest (Chrome) | guest followed TV play, +10 s jump, pause, play (within ~2 s); "Dana paused" on the TV when the guest pressed pause; same frame (11:28) on both | r173-party-tv-host, r173-party-web-guest |
| 17 | Closed mode | paired by code, Home with pictures, film plays, a forced error mid-film recovered (frozen 28 s after a far seek → reload → moving 4.7 s later); `[auth] 401` in the log: 0 | r173-closed-signin, r173-closed-home, r173-closed-play |

Not the TV's (seen while testing, server side): after a long freeze of a copy, the server
answered three seek probes with 500 "Remux did not start in time" (20 s each) before the
fourth worked — the card was up ~2 min instead of one quiet try; the same 500s refused a fresh
Dubfilm copy start later while other agents' test runs loaded the PC
(r173-copy-start-server-refused).

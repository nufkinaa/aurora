# Release 1.9.0 / TV 5.4.0 — 2026-10-20

Released and pushed. CI is green. The house server runs 1.9.0. TVs get 5.4.0 once nufurora.com pulls (`git pull`; no new dependencies).

| Feature | Website | TV | Checked on the Mi TV |
|---|---|---|---|
| Refresh rate follows the film | setting only (a browser can't switch the screen) | ✅ | ✅ no needless switch or blink (this TV has only a 59.94 Hz mode) |
| Dolby / DTS sound kept as it is + direct play by device | ✅ | ✅ | ✅ all 15 test titles direct, E-AC-3/AC-3/DTS/TrueHD out as they are |
| Night mode + dialogue boost | ✅ (not on iPhone/Safari) | ✅ | ✅ by logs (not judged by ear) |
| Subtitles your way (size, colour, background, position) | ✅ | ✅ | ✅ synced both ways, Hebrew right to left |
| Phone as a remote + Play on TV | ✅ | ✅ | ✅ 21 of 23 checks; the D-pad never opens the rail by itself |
| Voice search (Hebrew + English) | ✅ | ✅ | ✅ up to the mic prompt; "הסנדק" → The Godfather |
| Home opens at once, never jumps | ✅ | ✅ | ✅ 0 cards moved |
| Smoother on the TV + 10 small fixes | — | ✅ | ✅ |
| New screen: 8 cards with the NEW ribbon | ✅ | ✅ | ✅ |
| Classic look on a phone: tab bar at the bottom, player dock fits | ✅ | — | — |

| Fixed along the way | |
|---|---|
| Stopped encoders held their files for up to 93 s on a busy PC | ✅ |
| Two Search screens on top of each other after a quick Back | ✅ |
| Kids profile switch made requests the kids lock refused | ✅ |
| Admin: deleting a file the server was still reading failed | ✅ |
| Play on TV while Aurora was in the background started the film later by itself | ✅ |
| Remote's search key didn't start listening; Hebrew via the TV's own search found nothing | ✅ |
| Names like O'Connor showed "&apos;" | ✅ |

| Tests (final tree) | Result |
|---|---|
| Server + website unit tests | 1939/1939, three runs |
| Full browser suite | 350 pass, 0 fail (two full runs); one run in between lost a file to the PC running out of network buffers, and that file passed 3/3 alone |
| TV logic / type check / release build | 680/680 · clean · OK |
| CI (GitHub, Node 20 + 22) | green |

## Decisions for you (nothing is blocked)
1. **Server restart in open mode:** profile unlock codes are kept only in memory. After a restart, a TV on a password-protected profile drops off the phone's list until the profile is opened again. Closed mode is fine. Fixing it means keeping those codes across restarts, which is a sign-in change.
2. **Night mode vs. surround:** with night mode or dialogue boost on, a Dolby film is decoded on the TV, so the effect works but the receiver gets PCM. The other choice is surround first, with the effects greyed out.
3. **Phone remote has no "Start over":** Play on TV always resumes.

## Good to know
- The Mi TV runs a QA build of 5.4.0 (vc124) with the local server first, so it never takes the nufurora-first release.
- This PC's network buffer pool is at about 1.9 GB, which is very high. A reboot clears it. After a reboot, start the keeper again.

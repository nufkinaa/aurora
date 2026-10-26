# Get another version (branch feat-replace-version, a87fc72)

Regular-user flow for a bad copy (burned-in subtitles, bad picture, bad sound, wrong language, other): pick a reason, pick another version (same ranking, current copy excluded, server checks it against the title's own sources), it downloads as a normal person's download (disk gate, queue, 3 per account). The old copy plays until the new file is complete; then the server swaps it in under the same library id (idpins.json when the container changes) so progress, My List, ratings and links carry over. If someone is watching, the swap waits until they stop. Cancel or failure keeps the old copy. Kids refused; one replacement per title; only the asker or admin cancels. The bad release is remembered and skipped by smart downloads, follows, the source race and ★ BEST. Admin: Problem reports line, Inbox "Replaced copies", People sheet, download row "replaces · reason".

Tests: unit 11/11; UI 11 tests ×3; root npm test 1960/1960 ×2; whole test:ui 369 pass ×2; TV jest 701/701; tsc clean. Screenshots: this folder.

Not verified: the Mi TV; a real torrent end to end (fake engine on the private server); a Windows file lock that never lets go; the per-title subtitle delay kept for the old release; a folder that already holds another video with the same base name ("(2)" name, pin may not take).

## Mi TV checks (QA variant, Claude QA, torrents on)
1. Owned film → round buttons → RIGHT from Versions: two-line "Problem with this copy?"; title not pushed off the top. OK opens five reasons, first focused; D-pad never leaves the sheet.
2. Back closes with focus on the button. OK on a reason: spinner, then "Get another version", rows (quality · size · seeders · release), one ★ BEST. Back → reasons; Back → closed.
3. OK on a version: toast "Getting another version — your copy stays playable until it's in." Reopen: "Another version is on its way", progress states with a bar, "Reason: …", "Cancel — keep this copy".
4. Play the old copy until the download ends: "Ready — it takes over once nobody is playing this copy." (My downloads: "Ready — waiting for nobody to be playing the old copy"). Stop: swap happens, progress and My List stay.
5. Cancel: "Cancelled — your copy stays as it was."; old copy plays.
6. Another profile during a replacement: "Asked for by Claude QA", no Cancel.
7. Hold OK on an owned episode: "Problem with this copy?" row, sheet headed by the episode. Not-on-disk episode: no row.
8. Player menu HELP: entry under "Report a problem"; OK pauses and opens; Back closes and the player responds. Torrent stream: no entry.
9. Kids profile: none of the three entries.
10. Torrents off in admin: all entries gone after reopening (up to 5 min).

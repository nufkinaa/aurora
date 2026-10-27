# Household recommendations — Mi TV device checks (TV 5.7.0)

The TV half of docs/qa/household-recs/DESIGN.md. Every check is on the Mi TV with a QA
variant against a private test server (memory: aurora-tv-qa-mitv-2026-10-06.md for the
build/install recipe; `adb shell svc power stayon true` after the install). Photos with
`adb exec-out screencap -p`. Words must match the table in DESIGN.md letter for letter.

## Set-up

- Private test server (scripts/ui-test-server.js), sign-in mode **open** for checks 1–16,
  **closed** for check 17.
- Profiles: **Avi** (grown-up, the TV's profile), **Dana** and **Ben** (grown-ups, used from
  the website on a laptop), **Noa** (kids profile, max age 7), Dana with an **avatar photo**
  (avatarImage) and Ben with an emoji avatar.
- Seed, before the server starts, `data/household-recs.json` with **17 different titles**
  recommended to Avi (the hourly limits make that slow by hand): 3 titles from both Dana and
  Ben (they must rank first), the rest from one of them; 2 with a note ("Watch it with the
  sound up"); a mix of library films, a library show and catalogue titles (imdbId only);
  `at` within the last hour, no `seenAt`.
- Library: at least one film rated 18 / R and one title with no certificate (for Noa).

## Receiving

1. **The row.** Open Aurora as Avi. On Home press DOWN until the shelves.
   - "Recommended by your household" sits directly under "Recommended for You" (nothing after
     the heading — the website draws no "N new" either).
   - Every card not looked at yet carries the NEW pill (top left), as on the website.
   - Every card shows its title and under it "From Dana", "From Ben" or "From Dana and Ben"
     (a darker shade at the foot of the poster, two lines, not clipped, the NEW pill and the
     film/series corner tag still where they were).
   - The three titles from both people are the first three cards.
   - No other shelf grew a line under its posters (Recently Added, Because you…).
2. **Show all tile (> 15 only).** In the household row press RIGHT to the end: after card 15
   comes a titled tile "Show all recommended" (no film/series tag). Hold OK on it: nothing
   opens. OK: the Show all screen opens. Back to Home.
   Then (check 9) hide two titles with Not for me so 15 are left: back on Home the tile is
   gone and RIGHT stops at card 15.
3. **The Show all screen.** Title "Recommended by your household", a count ("17 titles"), the
   tabs "For you" · "You sent" (For you lit), a filter row "Everyone" · "Dana" · "Ben".
   - The grid is in the row's order, every card with its "From …" line; first focus is the
     first card.
   - UP from the top row lands on the filter row; UP again on the tabs; LEFT from a first
     chip opens the rail.
   - Filter "Dana": only titles Dana recommended (also the shared ones); "Everyone" brings all
     back.
   - Back to Home: no household card carries NEW any more (opening the page marks all seen).
4. **Hold-OK sheet of a household card** (on Home and on the Show all grid). Hold OK:
   - under the facts, "From Dana and Ben" in violet and, for a card with a note,
     “Watch it with the sound up” — Dana in italics;
   - buttons: Play/Open · Details · "+  Add to My List" · "Recommend" · "Not for me".
   - "+  Add to My List": toast "Added to My List", the button reads "✓  In My List". Back:
     the sheet closes, Home's row is read again and the title has left the row (it is in My
     List). Check My List shows it.
5. **Not for me + Undo (sheet).** Hold OK on another household card → "Not for me": toast
   "Hidden from your recommendations", the button now reads "Undo" (focus stays on it). OK
   on "Undo": it reads "Not for me" again. Press "Not for me" once more, then Back: the title
   is gone from the row. (TV toasts take no button: Undo is the button itself.)
6. **Title page banner.** Open (OK) a household card that has a note. Under the round icon
   row: "Recommended by Dana and Ben" (violet), then “Watch it with the sound up” — Dana, and
   a "Not for me" pill to its right, reachable with DOWN from the icon row. Press it: toast
   "Hidden from your recommendations", the pill reads "Undo"; press again: "Not for me".
   A title nobody recommended has no banner. An episode opened from Continue Watching of a
   recommended show: its show page shows the banner.

## Sending

7. **Recommend → picker → send.** On any film's title page the icon row has "Recommend"
   (paper-plane disc) after My List; on a show's page too. Press it:
   - sheet "Recommend “<title>”", line "Pick who should see it", faces for Dana, Ben, Noa
     (Dana's photo loads, Ben's emoji), the note field "Add a note (optional)" with "0/140",
     "Send" (dim) and "Cancel". Avi is not in the list.
   - OK on Dana: a violet edge and ✓; the button reads "Send to 1". OK on Ben: "Send to 2".
     OK on Dana again: "Send to 1"; again: "Send to 2".
   - DOWN to the note, OK: the TV keyboard; type a few words; the counter follows
     ("12/140"); a 141st character is not taken.
   - "Send to 2": the sheet closes, toast "Recommended to Dana and Ben". On the website as
     Dana: the title is in her row with the note.
   - Back on the TV: Settings → Recommendations → "What you sent" (check 13) lists it.
   - Open Recommend again on the same title: Dana and Ben read "Already has it from you",
     still pickable; the note field offers the note you wrote.
8. **The limit.** Recommend four different titles to Dana only (four sends). Open Recommend
   on a fifth: Dana is greyed with "More in NN min" and OK on her changes nothing (the button
   stays "Send"). Ben is still pickable.
9. **Kids.** On the 18 / R film: Recommend → Noa is greyed with "Not for Noa's age"; on the
   title with no certificate: "No age rating yet". OK on her changes nothing.
10. **Recommend from the sheet.** Hold OK on a card of Recently Added → "Recommend": the peek
    closes and the picker opens for that title. On a Continue Watching episode: the picker
    names the SHOW.
11. **Nothing sent.** Make Ben turn recommendations off on the website, keep his face picked
    on the TV picker opened before that, press "Send to 1": the sheet stays, says "Ben isn't
    taking recommendations" under the buttons, Ben is now greyed "Not taking
    recommendations" and the button reads "Send".

## Live

12. **The arrival toast.** TV on Home (focus somewhere in the shelves). On the website as Dana
    recommend a NEW title to Avi. Within ~2 s on the TV: toast "Dana recommended <title>" at
    the bottom, focus does not move, and the household row is read again with the title in it,
    carrying NEW (the focused card stays put). As Dana send the SAME title again with another note: no
    toast. As Dana and Ben, send two new titles within a few seconds: one toast per ping;
    after two quick ones from both, "2 new recommendations from your household" may show
    (whichever the second ping finds). Nothing on the phone (no ntfy push).
    - The same while the TV is on a title page: the toast shows; the Home row is read when
      Home is shown again.

## Settings

13. **Recommendations section.** Settings, scroll to "Recommendations" (above Privacy):
    - row "Recommendations from the household" — note "People on this server can recommend
      films and shows to you. They show on Home." — value "On";
    - "Mute someone and their recommendations stop reaching you. They aren't told." then chips
      "Dana · Mute", "Ben · Mute", "Noa · Mute";
    - row "What you sent" (note: what you recommended, and whether each person saw it…) →
      opens the Show all screen on "You sent": each title with "Dana · Seen   Ben · Sent"
      etc. (Sent · Seen · In their list · Watching · Watched as the website's You sent shows).
14. **Mute.** "Dana · Mute" → "Dana · Muted". Home: Dana-only titles left the row, shared ones
    say "From Ben". Website as Dana: Avi is still pickable; send → no toast on the TV. Website
    as Avi, Settings: Dana shows Muted there too (server-side). Unmute: her titles are back.
15. **Off.** Switch "Recommendations from the household" to Off: the row is gone from Home;
    website as Dana: Avi greyed "Not taking recommendations". On again: the row is back.
16. **Kids profile on the TV.** Switch to Noa: her row shows only what fits her age; Recommend
    on a title page works (Avi, Dana, Ben pickable); Settings has the Recommendations section.

## Closed sign-in mode (once — RN Image headers, memory aurora-tv-image-headers.md)

17. Restart the test server in **closed** mode, sign the TV in as Avi. Check: Home row posters,
    the Show all grid posters and the You sent thumbnails, Dana's avatar PHOTO in the picker
    all load (no grey tiles). `adb logcat -d | grep -i " 401 "` shows nothing for /img or
    /avatars. (All new pictures go through api.ts imgSrc/artSrc, which add X-Session /
    X-Profile-Token.)

## Regression and perf

18. Home: Continue Watching frame cards, Recently Added posters (no extra line), hero, rail.
    Hold RIGHT across the household row for 3 s, then LEFT back: no stutter beyond the other
    rows (`adb logcat -s ReactNativeJS | grep "\[row\] behind"` no more often than on Recently
    Added). Go Home → title → Back: focus returns to the same household card.
19. Title page: Play keeps first focus; LEFT from Play opens the rail; My List toggles; the
    new Recommend disc and the banner do not push the synopsis off screen on a film with a
    long title (two-line title + banner with a note).
20. My List grid, Browse grid, Search grid: cards unchanged; hold OK on a normal card shows
    "+  My List" (not "Add to My List") and the new "Recommend".
21. Render switches: with the developer setting at "recommended" (native card text) and once
    with everything off — the household card shows the same two lines in both.

## Not on the TV (said in the report)

- No "Recommend" at the end of a film: the TV player has no end card for films (Up next is
  episodes only; a film's end returns to its title page, where Recommend is one press away).
- Toasts take no buttons on the TV: "Undo" is the Not for me button itself (sheet and title
  page); the arrival toast has no "Show" — the row is already up to date on Home and the
  Show all page is at Settings → Recommendations → What you sent / the row's tile.

# Offline, as a person sees it — the design language

Written 2026-11-10 by the `offline-look` lane. This is the look and the words of
offline watching on the website, in plain values, so the Android phone app (and
anything later) can match it one to one. How saving works is in
`docs/offline-audit.md` and `docs/offline-wishes.md`; nothing here changes it.

Code: `public/js/offlineUi.js` (the mark, the words, the nav, the moments),
`offlineButtons.js` (title page and episode buttons), `offlinePack.js` (Pack for
a trip), `offlineRest.js` (resting pages), `screens/saved.js` (the place),
the marked `offline-look` blocks in `components.css` and `screens.css`.

## 1. One idea, one name

| What | The words — always these |
| --- | --- |
| The place | **On this device** |
| The action | **Save to this device** (short form on a tight button: "Save to device") |
| The state | **Saved on this device** |
| Undo of the action | **Remove from this device** |
| Something asked for before the server has it | **Waiting for the server's copy** |

Never said to a person: cache, quota, service worker, storage API, OPFS, sync,
queue, job, blob. "Download" means the server fetching a title, or a file handed
to the browser's own downloads folder — never a copy inside Aurora.

## 2. Three colours, three meanings

| Colour | Value | Means |
| --- | --- | --- |
| Mint | `#6ee7b7` | here · saving · chosen |
| Amber | `#f5c542` | waiting on something (the connection, the server's copy, you paused it) — never an alarm |
| Red | `#ff7a7a` | needs you |

Dark ink on mint: `#0b0c14`. On a white (focused) surface the three darken to
`#0a7a52`, `#8a6500`, `#c62828`.

## 3. The mark

One sign for "this device", drawn on a 24 × 24 grid, always a circle with a glyph.

- Ring: centre 12,12 · radius 9.6 · stroke 1.8 · the text colour at 42 % (60 % when it is the "can be saved" state).
- Progress arc: same circle, stroke 2.3, round ends, starts at 12 o'clock, clockwise; its length is the percent. Moves with a 420 ms ease.
- Solid disc (saved): radius 11, mint.
- Glyphs (filled, the text colour):
  - arrow landing on a line — `M10.9 5.7h2.2v5.2h2.8L12 15.7l-3.9-4.8h2.8z M7.6 17h8.8v1.7H7.6z`
  - pause — `M8.7 7.7h2.3v8.6H8.7z M13 7.7h2.3v8.6H13z`
  - "!" — `M10.9 6.3h2.2v7.3h-2.2z M10.9 15.5h2.2v2.2h-2.2z`

| State | Ring | Arc | Glyph | Said to a screen reader |
| --- | --- | --- | --- | --- |
| can be saved (`none`) | thin, 60 % | — | arrow | (the button's own name) |
| waiting for its turn (`queued`) | dotted (dash 2.2, gap 3.83, round) | — | arrow | "Waiting for its turn" |
| getting ready (`preparing`) | 28 % | a quarter, turning once per 1.1 s | arrow | "Getting ready" |
| saving (`saving`) | 28 % | mint, = percent | arrow | "Saving 42%" |
| waiting for the connection (`retrying`) | 28 % | amber, = percent | arrow | "Waiting for the connection" |
| paused (`paused`) | 28 % | amber, = percent | pause | "Paused" |
| waiting for the server's copy (`waiting`) | amber, dashed (4.6 / 2.94) | — | arrow | "Waiting for the server's copy" |
| needs you (`failed`) | red, solid | — | "!" red | "Didn't save" |
| saved (`saved`) | none | — | arrow in `#0b0c14` on the mint disc | "Saved on this device" |

Saved is a filled disc with the same arrow — not a tick. A tick already means
"watched" on Aurora; two ticks on one poster would be one too many.

Sizes: 20 in a row or a button · 22 on a poster and in the big title-page button ·
18 in the top bar · 15 in a menu row · 13 as the small ring on the phone's More tab ·
24 on a resting page's cover.

The mark is decoration (`aria-hidden`); the state is always in the name of the
thing that carries it.

### Where it sits

- **Poster card**: bottom right, 8 from each edge (18 from the bottom when the card has a progress bar), on its own disc `rgba(8,10,20,0.82)` with a soft shadow — no blur. While saving, the percent stands left of it (11 px, weight 800, tabular figures). On a show's poster, the number of episodes that are here. A card with nothing on this device gets nothing at all — no node, no work.
- **Episode row**: at the right end, the row's own button. On a phone it is the 44 × 44 press target.
- **Title page**: inside the button "Save to this device" → "Saving 42%" → "Saved on this device".
- **Player menu**: a row "Save to this device", the mark where other rows keep their tick.
- **Top bar (desktop)**: the entry "On this device" wears the device icon; while anything saves, the icon becomes the ring, with "Saving · 42%" (or "Saving 3 · 42%") in its name. Under 1360 wide the word hides and the icon stays.
- **Bottom bar (phone)**: the place lives under More; while anything saves, More wears the 13 px ring at its top right (and its green "new" dot steps aside).

### The device icon

For the place itself (nav entry, links that lead there): a screen on a stand with
the arrow coming down into it — `icons.downloadDevice` in `ui.js`, stroke 1.9,
round. A file handed to the browser is a page with an arrow (`fileIcon`), so the
two are never mistaken. No emoji stands for either.

## 4. The moments

- **A save lands**: the mark swells once (scale 0.6 → 1.34 → 1 in 620 ms) and one mint ring leaves it (0 → 12 px, 900 ms, fading). One quiet toast: "“Name” is on this device · 1.2 GB — it plays with no connection", with **Open**. Nothing else moves. With reduced motion: no swell, no ring, the toast only.
- **A save that needs you**: the nav says "One save needs you" (red disc on the phone's More ring); the row says why in plain words ("Didn't save" and the reason) and carries the one button that fixes it — **Resume** or **Retry**; when the room ran out, the line offers **Make room**, which leads to the list.
- **Saved by itself** (Keep the next episode ready): "Saved by itself: Show · S2 E5", once, quiet; in the list that copy carries the small tag "Kept ready".
- **Back on the line**: once — "Back on the line — where you stopped is saved" (or "…in 3 titles is saved").

Play and delight live only in these moments and in the empty state. Nothing
bounces while a person is choosing or reading.

## 5. The place — "On this device"

Top to bottom:

1. Title "On this device", beside it "Plays right here — even with no connection". On the right: **Pack for a trip** (only with the server in reach). With the server out of reach, one amber line first: "Can't reach the Aurora server — your files and the saved titles still play." with **Try again**.
2. **Saving now** — one row per save (the system lane's rows, `devicejobs.js`): poster, name, a head in the row's tone, one line under it, a thin bar, buttons on the right.

   | State | Head | Line | Buttons |
   | --- | --- | --- | --- |
   | saving | "Saving to this device · 42%" | "3.1 MB/s · about 4 min left" | **Pause** · **Cancel** |
   | waiting for its turn | "Waiting for its turn" | — | **Pause** · **Cancel** |
   | waiting for the connection | "Waiting for the connection · 42%" | "it carries on by itself" | **Pause** · **Cancel** |
   | paused | "Paused at 42%" | "What is saved stays here — press Resume to carry on" | **Resume** (the filled one) · **Cancel** |
   | needs you | "Didn't save" | the reason, in plain words | **Retry** (the filled one) · **Dismiss** |

   A paused save's bar rests in amber `rgba(245,197,66,0.62)` and does not glow. A paused save never carries on by itself.
3. **Waiting for the server's copy** — the same row shape; there is no picture yet, so the frame holds the amber waiting sign (26 px, the dashed ring with the arrow) on `rgba(245,197,66,0.07)` with a 1 px amber line at 20 %. One title: head "Waiting for the server's copy", line "It is saved here by itself when it arrives". A season: "Every new episode of season 2". A show: "Every new episode". Both with "Waiting for the server's copy — each one is saved here by itself as it arrives". **Cancel**.
4. **Saved for offline** (with the count), and right under the heading the room: "**6.2 GB** saved here · room for ≈ 18 GB more", a thin bar (the saved part in mint), and — when something was watched to the end — **Remove watched · 3 · 2.1 GB**: one press, one line "Removed 3 watched titles from this device — 2.1 GB freed" with **Undo**.
5. The titles. A film is a row: "1 h 12 min left · 1.2 GB · Original quality · English", **Play** / **Resume**, **Remove**. A show is one group: its name, "3 episodes · 2.1 GB · 1 watched", **Play S1 E3** (the next one not finished), a bin for the whole group; then its episodes in order, the next one tagged **Next up**, finished ones tagged **Watched** (with the site's tick) and stepping back, one saved by itself tagged **Kept ready**. Removing says "Removed “X” from this device" with **Undo**, up for 6 s; the row goes at once and comes back whole on Undo.
6. Foot: the switch **Keep the next episode ready** with "When you finish a saved episode, the next one saves itself. Nothing is removed." and, when it has done so, "Saved by itself: Show · S2 E5" with the mint mark. Then the honest notes (section 8).
7. The person's own files ("play a video from this computer or phone") — after the titles; first only when nothing is saved and they have some.

Empty: the mark in a mint ring, "Nothing saved for offline yet", "Press [Save to
this device] on a film or an episode and it lands here." (the words in brackets
drawn as the button looks), "Then it plays anywhere — a flight, a train, the
middle of nowhere.", "Room on this device: ≈ 18 GB", and a short list "Worth
having with you" (what you are in the middle of, then My List; 4 on a phone, 6
wider), each with its own one-press save. While something is already on its way:
one quiet line, "Nothing saved for offline yet — what is on its way lands here."

Nothing is ever removed from a device by itself. Every removal is a press, and
every removal can be undone.

## 6. Choosing — the size sheet

One sheet, the same from a title page, an episode, the player and My downloads.

- Title: "Save to this device — which size?", under it the title's name in quotes.
- **Sound** (only when the copy has more than one): the word "Sound" on its own line, then one chip per sound ("English · 5.1", "Hebrew", "English · Commentary"). Chosen by default: the person's dub language, else the original, else the first.
- Sizes: one row each — name ("Original", "1080p", "720p", "480p"), a short note ("as it is", "good for a phone"), the size on the right ("≈ 2.3 GB" when estimated). A size that will not fit is still shown, with "more than the room left".
- Under the sizes: "Room on this device: ≈ 18 GB".
- For something the server does not have yet: two full-width rows, one at most — "And every new episode of season 2" and "And every new episode of this show". Each starts with an empty 16 px ring; chosen, the ring is a mint disc with a dark tick.
- "Always use the size I pick" (a chip), and **Not now**.
- A chosen chip says so twice: mint tint `rgba(110,231,183,0.16)` with a 1.5 px mint ring inside, and a 14 px tick before its words. Never colour alone.
- The sheet never grows taller than the screen; it scrolls inside itself and keeps clear of the safe areas.

Season buttons on a show's page: **Save the next 3** and **Save the season (8)**;
the size is asked once for all of them; while they save the button carries the
ring, and a press on it says "Saving 8 episodes of “Show” — 2 of 8" with **Stop**.

## 7. No connection

Calm, and intended.

- **One line**, a pill at the bottom centre (on a phone: above the tab bar; over the player: at the top): the amber no-signal sign (17 px), "No connection", a hairline, then the link **On this device** in mint. Pill: `rgba(20,22,30,0.94)`, border `rgba(245,197,66,0.32)`, text `#e9ecf4` at 0.84 rem / 600, radius 999. It fades up 6 px in 280 ms. On the place itself the link is hidden; over a copy that is playing the whole line is hidden.
- **What is not here rests**: every poster without a copy drops to 42 % (70 % under the pointer or focus). Posters with a copy stay full and keep their mint mark — the eye goes to what works.
- **A title that is not here**: a resting page instead of an error — its cover at 45 %, the kicker "NO CONNECTION" in amber, the title, one line ("This one isn't on this device, so it waits for the connection."), **On this device** and **Try again**. If some of its episodes are here, the page is mint instead of amber: "One episode is on this device — it plays with no connection." and **Play S1 E3**.
- **A page with nothing kept**: "This page is resting" / "This page isn't on this device, so it waits for the connection." — never a blank screen, never a spinner that does not end.
- **Play on something that is not here**: one toast, "This one isn't on this device — it plays when the connection is back", and the person stays where they were.
- **Coming back**: the line goes, the posters return, and — only if something was watched meanwhile — "Back on the line — where you stopped is saved", once.

## 8. Honest notes — each said once, where it matters

| When | Where | Words |
| --- | --- | --- |
| The address is plain http | On this device (in place of the list) | "Saving needs the secure address" — "Open Aurora at its https address (or on the computer it runs on) and a Save to this device button appears on every film and episode. Your own files below play either way." |
| Safari / iPhone, not on the Home Screen | On this device: under the room the first time (with **Got it**), afterwards small in the foot | "Safari may clear these after a week without a visit. Add Aurora to the Home Screen (Share → Add to Home Screen) and they stay until you remove them." |
| Another browser that has not promised to keep the copies | same place | "This browser may clear these if the device runs very short of space. Install Aurora (the browser's Install, or “Add to Home screen”) and they stay until you remove them." |
| Chrome writes straight onto the device (the faster saving) | On this device foot, only in a browser where it is true and only once there is a copy | "Saving is quicker in this browser — Chrome writes a film straight onto the device." Nothing is said, and nothing promised, in Safari or Firefox. |
| A size is an estimate | everywhere | "≈" before the number |

## 9. Kids, motion, keyboard

- A kids profile sees only the copies it saved itself — on the place, on posters, in the nav — and what is offered to it comes from its own shelves only.
- Reduced motion: no swell, no ring, no turning quarter (it stands still), no pill slide.
- Everything new is reachable by keyboard, has a visible focus ring from the site's own tokens, and a name that says the state ("Save Episode 3 to this device", "Saving 42% — press for Stop", "Remove X from this device").
- Press targets on a phone are at least 44 × 44.

## 10. For the phone app

Take as they are: the three colours, the mark's geometry and its nine states,
the words of section 1, the row shapes of section 5, the two-signal rule for a
chosen option, the 42 % rest, and the pill. Native equivalents: the mark as one
vector drawable with a progress arc; the pill as a bottom inset above the tab
bar; the landing moment as one 620 ms scale and one ring, off under "remove
animations".

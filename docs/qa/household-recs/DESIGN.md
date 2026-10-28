# Household recommendations — design (1.13.0 / TV 5.7.0)

elia, 2026-10-27: *"Let's have a feature so people in the household can recommend stuff to one
another, and it should be easy to add to the list of the one who got the recommendation. Let's have
the recommendations sit as a row below 'Recommended for you' or somewhere there; show 15
recommended titles there, and if more people recommended that title to the user it should rank
higher and be shown before the rest. We can have 'Show all recommended' after that, shown on a
separate page (only when there are more than 15). Restraints: a user should not be able to
recommend to the same user more than 3 or 4 times an hour. Realize yourself all of the stuff and
decisions about it."*

Server: `src/media/household.js` (the rules, pure core + the server's wiring), `src/routes/household.js`
(the routes and the cards), Home's row in `src/routes/api.js`. Store: `data/household-recs.json`
(a JsonStore: owner lock, writes off the event loop, last-good copies, backed up like every data
store). Website and TV app use the same routes and print the same words (table below).

## Decisions

### What can be recommended
- **Films and shows.** An episode stands for its show (recommending from an episode's page or the
  end of an episode recommends the show). Reason: the recipient's row is a row of titles; "watch
  S2E5 of X" is a note, and the note is there for that.
- **Library titles and catalogue titles** (not yet downloaded) alike. A title is kept by its IMDb
  id when it has one — so the library copy and the catalogue entry are one title — else by its
  library id (`lib:<id>`). The card the recipient sees is the library copy when the server has
  one (it plays from disk), else the catalogue title.

### Who can get it
- Every profile on this server except yourself.
- **Not** a profile the admin locked (left out of the picker), **not** a request still waiting for
  approval (it is not a profile yet).
- **Kids profiles:** the same age gate as everywhere (`lib/kids.js`; a title with no known age
  rating is out). The picker shows the kid greyed — "Not for Noa's age" / "No age rating yet" — and
  the server refuses it at the send. What a kid receives is filtered again on the way out, so a kids
  limit lowered later also hides what was sent before (and the kids gate's own filter on
  `GET /api/profiles/:id/household` stands behind that).
- **Someone who turned recommendations off** (Settings) is greyed for everyone:
  "Not taking recommendations"; a send to them is refused.
- **Someone who has already watched it** is greyed: "Has watched it" (a rated title counts as
  watched, as on Home). Reason: saves the sender's hourly quota and the recipient's row.
- **Someone who already has it from you** shows "Already has it from you" and stays pickable:
  sending again only updates the note.

### Limits (server-enforced)
- At most **4 new recommendations from one person to the same person in any rolling hour**
  (elia said 3 or 4; 4 lets a sender finish a short "you must see these" burst).
- At most **12 new recommendations from one person in any rolling hour in all** (a send to three
  people counts three) — the "sane overall cap".
- **A repeat of the same title to the same person is not a new one:** it updates the note (an
  empty note keeps the one there was) and counts nothing.
- When a limit is hit the answer says how long to wait, in minutes, by the oldest send that counts:
  "You can recommend more to Dana in 23 min" / "You've sent a lot this hour — you can recommend
  more in 23 min". The picker shows the person greyed with "More in 23 min".
- A refusal is an answer (`200` with `refused: [...]`), not an error: the apps show its line.

### The note
- Optional, **one line, at most 140 characters** (code points), control characters and line breaks
  folded to spaces. Shown on the title page and the peek sheet as *“note” — Dana*.

### Receiving
- Home row **"Recommended by your household"**, directly under "Recommended for You" (before the
  recommender's "Because you…" rows). Shown only when there is something in it. The person can move
  or hide it like any row (Settings → Home rows).
- **Up to 15 cards**, ranked by the **number of different people** who recommended the title, then
  by the **newest** recommendation.
- Each card says who: **"From Dana"**, **"From Dana and Avi"**, **"From Dana and 2 others"**.
- **"Show all recommended"** after the row, **only when there are more than 15** → a separate page
  (website `#/household`, TV "Recommended" screen): every title, same ranking, filter by person
  ("Everyone", or one person).
- **One press to My List**: a "+" button on the card (website), "Add to My List" on the hold/peek
  sheet and on the title page (both apps). The card stays put (now marked "In My List") until the
  next Home refresh; then it is gone from the row — it lives in My List.
- **"Not for me"** on the peek sheet and the title page hides the title from this person's
  recommendations — from **every** sender, now and later (it says "not for me", not "not from
  you"). Undo is offered in the toast. **The sender is never told**; their Sent list shows "Seen"
  at most.
- Hidden from the row and the page: what the person has **watched, is watching (Continue
  Watching), has rated or has on My List**, what a kids profile may not see, recommendations from
  muted senders or from profiles that no longer exist.
- The title page and peek sheet of a recommended title show **"Recommended by Dana"** and the note.
  Opening the title page counts it as **seen**.
- **New ones**: when something arrives, the recipient's open apps get a content-free ping over the
  live socket (`{ type: "household_recs" }`); the app then asks its own gated route and shows a
  toast — **"Dana recommended Dune"** (one) / **"3 new recommendations from your household"**
  (several) — with **Show** (one: its title page; several: the Show all page). A card not yet
  looked at carries the usual **NEW** tag (unseen = not looked at, for 7 days at most); the row
  also carries a quiet `sub` "2 new" for where row lines are drawn (the website draws none now).
  An installed web app whose window is in the background also gets its icon badge bumped. Opening the Show all page marks all seen. **No phone push**,
  no ntfy/Telegram: in-app only.

### The sender's side
- **"What you sent"** in Settings → Recommendations always leads there (Home's link only shows
  past 15); the website's address is `#/household/sent`.
- The Show all page has a second tab, **"You sent"**: what you recommended, newest first, and per
  person what became of it: **Sent → Seen → In their list → Watching → Watched**.
- Not too nosy, on purpose: it says no more than the household already sees on a shared server
  (no positions, no times watched, no dismissals — "Not for me" reads as "Seen"; a mute reads as
  "Sent").

### Settings (per person, on the server, the same on every device)
- **"Recommendations from the household"** on/off (default on). Off: nothing shows, nobody can
  send to you (they see you greyed); turning it back on brings back what was there.
- **Mute** one person: their recommendations stop reaching you. **They are not told** — their send
  "goes", nothing arrives, and the picker shows you as pickable. Unmuting brings back their old
  ones too.
- Both live in `data/household-recs.json` (`settings[profileId]`), read and written through
  `GET/POST /api/profiles/:id/household/settings`.

### Data and tidying
- `data/household-recs.json`: `{ v: 1, recs: [{ id, from, to, key, title, note, at, updatedAt?,
  seenAt?, dismissedAt?, muted? }], sends: { [from]: [{ to, at }] }, settings: { [id]: { off?, muted? } } }`.
- `sends` is the rolling hour (only the last hour is kept). `recs` keep a snapshot of the title
  (name, year, poster, genres, rating) so a catalogue title still draws when the catalogue cache
  is cold.
- **Pruned** daily (`daily.register("household-recs")`) and on every send: older than **90 days**
  goes; so does anything from or to a profile that no longer exists (and a mute of one);
  at most 300 per recipient and 5,000 in all (the oldest go first). Watched ones are kept
  (the sender's "Watched") until the 90 days.
- Home's memo (`homeStamp`) includes the recipient's own household stamp, so a new arrival, a
  dismissal or a "seen" is on the next Home load; somebody else's recommendations move nothing.

### Privacy and permissions
- Every route acts as the profile in the address and is guarded exactly like that profile's own
  data (`routes/profiles.js` gate: must exist; "closed" mode needs the session that owns it; a
  protected profile needs its token; admin-locked is refused). A device locked to a kids profile
  reaches no other profile's routes (the kids gate).
- The live-socket ping carries no title and no name.

### Analytics
- Usage features (`track("feat", …)`): `hhrec-open` (the picker opened), `hhrec-send`,
  `hhrec-add` (added to My List from a recommendation), `hhrec-dismiss`, `hhrec-all` (Show all
  page), `hhrec-toast`.
- Controls (`src/lib/tel/controls-vocab.js`): `detail.recommend`, `detail.hh.dismiss`,
  `peek.recommend`, `peek.hh.dismiss`, `card.hh.add`, `recommend.person`, `recommend.send`,
  `recommend.close`, `home.hh.all`, `household.tab`, `household.filter`, `settings.hh.toggle`
  (the website's switch is its usual `settings.toggle`), `settings.hh.mute`, `settings.hh.sent`
  (the website's row is its usual `settings.link`), `player.recommend` (see the vocab for which
  app has which).
- Route words in SEGMENTS: `household`, `sent`, `?from`, `?key` (`recommend`, `people`, `for`,
  `dismiss`, `seen`, `settings` were there).

## API

All under the acting profile, all JSON.

| Route | Body / query | Answer |
|---|---|---|
| `GET /api/profiles/:id/recommend/people` | `?key=tt…\|lib:…&type=movie\|show` | `{ people: [{ id, name, avatar, avatarImage, color, kids, state, line, waitMin, note? }], noteMax, perPerson, perHour }` — `state`: `ok · sent · seen · kids · off · limit` |
| `POST /api/profiles/:id/recommend` | `{ to: [ids], title: { id } \| { imdbId, type, title, poster, year, genres, rating }, note }` | `{ sent: [{ to, name, updated }], refused: [{ to, name, reason, line, waitMin? }], line, key }` |
| `GET /api/profiles/:id/household` | `?from=<id>&slim=1` | `{ items: [card + hh], total, people: [{ id, name, n }], unseen }` |
| `GET /api/profiles/:id/household/for` | `?key=` | `{ from: [{ id, name, note, at }], dismissed }` (marks seen) |
| `POST /api/profiles/:id/household/dismiss` | `{ key, undo? }` | `{ ok }` |
| `POST /api/profiles/:id/household/seen` | — | `{ ok, n }` |
| `GET /api/profiles/:id/household/sent` | `?slim=1` | `{ items: [card + { hh: { key, to: [{ id, name, status, at, note }], at } }] }` |
| `GET /api/profiles/:id/household/settings` | — | `{ on, people: [{ id, name, avatar, avatarImage, color, muted }] }` |
| `POST /api/profiles/:id/household/settings` | `{ on?, muted? }` | the same |

A recommended card (Home's row and the page) is the usual card plus
`meta: "From Dana and Avi"` and `hh: { key, from: [{ id, name, note, at }], count, at, unseen, note?, noteBy? }`.
Home's row: `{ id: "household", title: "Recommended by your household", sub?: "2 new", items (≤ 15), total, more }`.
`?slim=1` gives the TV's card shape (as `/api/home?slim=1`).

## Words (the website and the TV print exactly these)

| Where | Text |
|---|---|
| Home row title | Recommended by your household |
| Row quiet line (some unseen) | 1 new / N new |
| Card line | From Dana · From Dana and Avi · From Dana and 2 others |
| After the row (> 15) | Show all recommended |
| Show all page title | Recommended by your household |
| Its tabs | For you · You sent |
| Its filter | Everyone · <name> |
| Empty "For you" | Nothing recommended to you yet. When someone in your household recommends a film or a show, it shows up here. |
| Empty "You sent" | You haven't recommended anything yet. Press Recommend on any film or show. |
| Sent statuses | Sent · Seen · In their list · Watching · Watched |
| Button (title page, peek, end of film) | Recommend |
| Picker title | Recommend “<title>” |
| Picker line | Pick who should see it |
| Note field | Add a note (optional) — counter n/140 |
| Send button | Send (nobody picked: disabled) · Send to N |
| Person lines (from the server) | Not taking recommendations · Not for Noa's age · No age rating yet · Already has it from you · Has watched it · More in 23 min |
| Sent toast (server `line`) | Recommended to Dana and Avi |
| Refused (server lines) | You can recommend more to Dana in 23 min · You've sent a lot this hour — you can recommend more in 23 min · Dana isn't taking recommendations · Not for Noa's age · Dana has watched it already |
| Title page / peek banner | Recommended by Dana and Avi — then each note as “note” — Dana |
| Add | Add to My List · In My List (after) |
| Not for me | Not for me → toast "Hidden from your recommendations" with Undo |
| Arrival toast | Dana recommended Dune · 3 new recommendations from your household — action Show |
| Settings section | Recommendations |
| Settings switch | Recommendations from the household — "People on this server can recommend films and shows to you. They show on Home." |
| Mute line | Mute someone and their recommendations stop reaching you. They aren't told. |
| Mute buttons | <name> · Mute / <name> · Muted |
| Settings row | What you sent — "What you recommended, and whether each person saw it, put it on their list or watched it." |
| Picker, nobody else on the server | There's nobody else on this server yet. |
| A film's credits card | ENJOYED IT? (small heading) — Recommend “<title>” to someone in your household — Recommend · Dismiss |

## Where the button is
- **Website**: the title pages (library film, library show, catalogue film/show), the hold/peek
  sheet of any title card, and a film's credits card in the player ("Enjoyed it?", shown once in
  the last stretch — at the detected credits, or the same runtime-scaled window Up next uses for
  episodes; it never takes the focus from the film; the player's keys stay away from the sheet).
  An episode's end already has Up next; recommending a show is on its page and its peek sheet.
- **TV**: the title page (Detail, a "Recommend" disc after My List) and the hold-OK sheet.

## Where the TV differs, and why
- **No Recommend at the end of a film on the TV**: the TV player has no end card for films (Up
  next is for episodes only) and a finished film returns to its title page, where Recommend is
  one press away. The website has the credits card.
- **TV toasts take no buttons** (a toast that took the D-pad would pull focus out of whatever
  the person is browsing): Undo is the "Not for me" button itself — it reads "Undo" after the
  press, on the hold-OK sheet and on the title page — and the arrival toast has no "Show" (the
  row is already updated; the Show all screen is the row's last tile or Settings →
  Recommendations → What you sent).
- **"+" on the card** is the website's (a pointer can hit a corner); on the TV the same one
  press is "+ Add to My List" on the hold-OK sheet.
- **Show all recommended** is a link under the row on the website and the row's last tile on
  the TV (D-pad: RIGHT to the end of the row) — both only when there are more than 15.
- The TV toasts an arrival only for recommendations newer than the last one it showed; the
  website toasts each unseen one it has not told in this tab (the first ping after a reload can
  differ by one).

## The TV's design pass (2026-10-28, branch design-household-tv)

Words unchanged — everything below is layout. Photos and the before/after note:
`docs/qa/household-design/tv/`.

- **Placement**: the row sits directly under "Recommended for You" also for a person whose Home
  row order was saved before 1.13.0 (a stored order that does not name `household` used to send
  it to the foot of Home) — `orderRows` in `src/routes/api.js`; no Recommended row (kids, little
  history): where it would have been, after Continue Watching / New episodes.
- **The card**: the title, then the line in two pieces, each one line — "From Dana" / "and 10
  others" — the second held open for a single sender, so every title of the row sits at one
  height; the household violet for the From lines; the frame card's deeper shade under the
  words (white words over a white poster did not read).
- **Right-to-left names** (both apps should do this): a line that may START with a name, a note or
  a title gets an invisible left-to-right mark, and a Hebrew name / note is fenced off with one on
  each side — otherwise "נועם recommended Dune" is laid out as a right-to-left line ("recommended
  Dune נועם"), "נועם · Mute" reads "Mute · נועם" and a Hebrew note by Dana reads "Dana — ”note“".
  (The Unicode isolates FSI/PDI were ignored by the Mi TV's text stack.) TV: householdRecs.ts
  `ltr` / `iso`.
- **Show all tile**: the card's size and focus, a violet wash and an arrow in a ring.
- **Show all page**: the person filter is one scrolling line (it wrapped to two or three with a big
  household); You sent rows are compact, the note in italics, each person's status a pill with the
  state's colour (Seen white, In their list violet, Watching cyan, Watched mint).
- **Picker**: the note and Send / Cancel stay in view under the faces (with 14 people Send was
  below the sheet's edge), six faces to a line, a greyed face keeps a full focus ring, the note
  field shows a focus edge.
- **Title page banner**: who + Not for me on one line, the notes under it at the lockup's width
  set off by a violet rule (two at most, two lines each).
- **Settings**: DOWN from the switch lands on the first mute chip (a focus guide); the mute chips
  only while recommendations are on (as the website).

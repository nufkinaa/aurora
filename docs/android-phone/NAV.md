# Phone navigation: every screen within reach (phone app + website on a phone)

Owner: elia. Written 2026-11-06 on branch `phone-nav` (Android phone app) so the
website's branch `web-small-nav` can match it: **same set, same order, same words**.
If the website needs to differ, change this file in both branches and say why.

## 1. The bottom tab bar (phones, portrait)

`Home · Movies · Shows · My List · More · [Search icon]`

(Search stays last, elia 2026-10-06; More is the last word, right before it.)

- Four tabs, More, and Search, nothing else. The extra tabs the website shows today on a
  phone (AI, Saved, New) move into **More**.
- **No label is ever cut off.** The bar fits itself to the width and the font size:
  1. labels at 12.16 px bold (the font may grow with the phone's font size up to x1.2);
  2. if they do not fit: the side padding of each item shrinks (10 → 4 px);
  3. then the label size steps down, to 10.5 px at the least;
  4. then **More** becomes an icon (three dots), with "More" as its accessible name.
  Labels are measured, not guessed (the app measures the real text; the website
  can use `scrollWidth`). Search is always the magnifier icon, "Search" its name.
- Held sideways the bar sits at the top (unchanged); the same fit rule applies.
- `uiId` / `data-ui`: `nav.home`, `nav.movies`, `nav.shows`, `nav.mylist`,
  `nav.search`, `nav.more`.

## 2. The More sheet (`nav.more`)

A bottom sheet, one line per place, an icon and the words below. Scrolls when the
font is large. Order and words:

| # | Words (phone app)              | Words (website)                | Opens                    | uiId                |
|---|--------------------------------|--------------------------------|--------------------------|---------------------|
| 1 | What's new                     | What's new                     | `#/new`                  | `more.new`          |
| 2 | Saved on this phone            | Saved on this device           | `#/saved`                | `more.saved`        |
| 3 | My downloads                   | My downloads                   | `#/downloads`            | `more.downloads`    |
| 4 | Your TVs                       | Your TVs                       | `#/remote`               | `more.remote`       |
| 5 | Recommended by your household  | Recommended by your household  | `#/household`            | `more.household`    |
| 6 | Your Aurora Wrapped            | Your Aurora Wrapped            | `#/wrapped`              | `more.wrapped`      |
| 7 | Swipe your taste               | Swipe your taste               | `#/taste`                | `more.taste`        |
| 8 | AI pick                        | AI pick                        | `#/pick`                 | `more.pick`         |
| 9 | Settings                       | Settings                       | `#/preferences`          | `more.settings`     |
| 10| Get the apps                   | Get the apps                   | `/install`               | `more.apps`         |

Then, under a hairline, the three actions that are not pages:

| # | Words                 | Does                         | uiId          |
|---|-----------------------|------------------------------|---------------|
| 11| Sign in a TV          | `#/pair` (type or scan a code) | `more.pair` |
| 12| Join a watch party    | the join sheet               | `more.party`  |
| 13| Report a problem      | the report sheet             | `more.report` |

Rules:
- **AI pick** is listed only when the server has AI (`GET /api/ai/status` → `enabled`),
  the same rule as the website's AI tab today.
- **Your TVs** is always listed (its page says "No TV is on" when none is).
- "What's new" carries the green dot while this version's page is unseen (website),
  the phone shows it when it has the same "seen" marker.
- Short second lines under each line are allowed (phone app uses them); the first line
  is the words above, exactly.

## 3. Your TVs, one tap away (`nav.remote`)

A round TV button in the top bar, left of the Settings gear, **only while one of your
TVs is on** (the remote's device list is not empty — the website's rule for its
"Remote" menu line). Tap → `#/remote`. Accessible name: "Your TVs". It is also line 4
of More and stays in the profile menu.

## 4. The profile menu

Unchanged (Switch profile / Sign out, Settings, My downloads, Your TVs, What's new,
Get the apps, Report a problem, Join a watch party). More is the full list; the
profile menu stays the short one under the avatar.

## 5. Every phone screen and how it is reached (phone app)

| Screen                         | Reached from                                                         |
|--------------------------------|----------------------------------------------------------------------|
| Home                           | tab Home; the Aurora mark in the top bar                             |
| Movies / Shows                 | tabs                                                                 |
| My List                        | tab                                                                  |
| Search                         | tab (icon)                                                           |
| Title page (Detail), Sources   | any poster; Sources from a title page                                |
| Player / OfflinePlayer         | Play on a title page / a saved copy                                  |
| What's new                     | More 1; profile menu; Settings → Aurora                              |
| Saved on this phone            | More 2; Settings → Saved on this phone → On this phone               |
| My downloads                   | More 3; profile menu; Settings → Aurora                              |
| Your TVs (remote)              | top-bar TV button (when a TV is on); More 4; profile menu; Settings  |
| Sign in a TV (PairTv)          | More 11; Your TVs → Sign in a TV; Settings → Aurora; a TV's QR       |
| Recommended by your household  | More 5; Home's household row; Settings → What you sent               |
| Your Aurora Wrapped            | More 6; Settings → Your profile                                      |
| Swipe your taste (+ Edit list) | More 7; Settings → Your profile; Edit list from Swipe your taste     |
| AI pick                        | More 8 (when the server has AI)                                      |
| Settings (+ Edit profile)      | More 9; top-bar gear; profile menu                                   |
| Get the apps                   | More 10 (opens the browser); profile menu                            |
| Join a watch party / Report    | More 12 / 13; profile menu; Settings                                 |

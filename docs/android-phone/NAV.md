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

**The website's menu behind More, line for line** (docs/web-nav.md, `js/navmore.js`,
web 1.15.17): the same places, in the same order, in the same words. The website draws
it as the TV's side menu from the left; the phone app keeps a bottom sheet (a thumb
reaches it), with the same groups between hairlines and Settings and you at the foot.
One line per place: an icon, the words, a short second line (the phone's, optional).
Scrolls when the font is large.

| # | Words (phone app)              | Words (website)                | Opens                       | uiId              |
|---|--------------------------------|--------------------------------|-----------------------------|-------------------|
| 1 | Search                         | Search                         | the Search tab              | `more.search`     |
| 2 | Home                           | Home                           | the Home tab                | `more.home`       |
| 3 | Movies                         | Movies                         | the Movies tab              | `more.movies`     |
| 4 | Shows                          | Shows                          | the Shows tab               | `more.shows`      |
| 5 | My List                        | My List                        | the My List tab             | `more.list`       |
| 6 | Calendar                       | Calendar                       | `#/calendar` (slot: listed once that screen exists, branch release-calendar) | `more.calendar` |
| 7 | AI                             | AI                             | `#/pick` (only when the server has AI) | `more.pick` |
| — | hairline                       |                                |                             |                   |
| 8 | What's new                     | What's new                     | `#/new`                     | `more.new`        |
| 9 | Saved on this device           | Saved on this device           | `#/saved`                   | `more.saved`      |
| 10| My downloads                   | My downloads                   | `#/downloads`               | `more.downloads`  |
| 11| Your TVs                       | Your TVs                       | `#/remote`                  | `more.remote`     |
| 12| Recommended by your household  | Recommended by your household  | `#/household`               | `more.household`  |
| 13| Your Aurora Wrapped            | Your Aurora Wrapped            | `#/wrapped`                 | `more.wrapped`    |
| 14| Swipe your taste               | Swipe your taste               | `#/taste`                   | `more.taste`      |
| 15| Get the apps                   | Get the apps                   | `/install`                  | `more.apps`       |
| — | hairline                       |                                |                             |                   |
| 16| Sign in a TV                   | Sign in a TV                   | `#/pair` (type or scan a code) | `more.pair`    |
| 17| Join a watch party             | Join a watch party             | the join sheet              | `more.party`      |
| 18| Report a problem               | Report a problem               | the report sheet            | `more.report`     |
| — | hairline (the foot)            |                                |                             |                   |
| 19| Settings                       | Settings                       | `#/preferences`             | `more.settings`   |
| 20| ‹your name›                    | ‹your name›                    | the profile menu (switch profile, sign out …) | `more.profile` |

Rules:
- **AI** ("AI", the TV's word; it was "AI pick") is listed only when the server has AI
  (`GET /api/ai/status` → `enabled`).
- **Calendar** is a slot: it appears once the app has its screen (another branch).
- **Your TVs** is always listed (its page says "No TV is on" when none is).
- **Pick together** (group-pick, 1.15.18) is NOT a More line: the website keeps it in the
  profile menu (js/main.js) and not in its menu behind More, so the phone does the same —
  profile menu → Pick together (and the AI page on the TV). Add it to both lists together.
- Lines 1–5 switch the tab bar to that tab (back to the tab screen first).
- "What's new" carries the green dot while this version's page is unseen (website),
  the phone shows it when it has the same "seen" marker.
- Short second lines under each line are allowed (phone app uses them); the first line
  is the words above, exactly.

## 3. Your TVs, one tap away (`nav.remote`)

A round TV button in the top bar, left of the Settings gear, **only while one of your
TVs is on** (the remote's device list is not empty — the website's rule for its
"Remote" menu line). Tap → `#/remote`. Accessible name: "Your TVs". It is also line 11
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
| What's new                     | More 8; profile menu; Settings → Aurora                              |
| Saved on this device           | More 9; Settings → Saved on this phone → On this phone               |
| My downloads                   | More 10; profile menu; Settings → Aurora                              |
| Your TVs (remote)              | top-bar TV button (when a TV is on); More 11; profile menu; Settings |
| Sign in a TV (PairTv)          | More 16; Your TVs → Sign in a TV; Settings → Aurora; a TV's QR       |
| Recommended by your household  | More 12; Home's household row; Settings → What you sent               |
| Your Aurora Wrapped            | More 13; Settings → Your profile                                      |
| Swipe your taste (+ Edit list) | More 14; Settings → Your profile; Edit list from Swipe your taste     |
| AI                             | More 7 (when the server has AI)                                      |
| Settings (+ Edit profile)      | More 19; top-bar gear; profile menu                                   |
| Get the apps                   | More 15 (opens the browser); profile menu                            |
| Join a watch party / Report    | More 17 / 18; profile menu; Settings                                 |

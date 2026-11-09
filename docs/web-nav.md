# The website's navigation on a phone (2026-11-06, side menu 2026-11-09)

elia: "do we have a way to reach all screens on smaller phone screens where the navbar
is smaller?", then "if the screen is too small on android or iPhone web we can do an
hamburger menu like we have on tv (it can also look the same)".

## The tab bar (phones: glass up to 720 px wide, classic up to 600 px)

`Home · Movies · Shows · My List · More · [Search]` (as in docs/android-phone/NAV.md §1)

- AI, New and Saved left the bar (on a 320 px phone with AI and Saved on, Search had
  fallen off the end of the bar; New was hidden on phones altogether).
- More is lit while a screen only the menu leads to is open, and carries New's green dot
  while this version's What's new is unseen.
- **No word is cut off** (`js/navmore.js fitBar`): the words are measured; if one does not
  fit, the items' sides come in, then the words step down to 10.5 px, then More becomes
  the menu's three lines (its name stays "More"). At the normal text size every phone from
  320 px fits with no step; only a reader's larger text needs them.
- Desktop and tablet: no More; the nav is as it was.

## The menu behind More (`js/navmore.js`): the TV's side menu, for a finger

The TV app's rail (`tv-native/src/components/NavRail.tsx`) opened, made for touch: it comes
in from the left over the page (280 ms), as tall as the screen, about the TV's 240 dp wide
(min(288 px, 86 % of the screen)). It has the same opaque #0a0b14 body with the violet hue
from the top-left and the green from the foot, the right half brought back to the body's
colour and a 48 px feather into the page. On top sit the Aurora mark (36) and the wordmark
(23/800). The rows are the TV's `.nav-item`: 15/600 near-white with a cast shadow, 48 tall,
round; the lit row is `--surface`; a keyboard-focused row inverts to white. Every row leads
with an icon (2026-11-10, elia: "on the side panel on web mobile put icons also"): the Android
phone app's More-sheet glyph for that place, path for path (`js/navicons.js`, mirroring
`tv-native/src/phone/moreItems.ts` + `phone/ui/Icon.tsx`), 20 px in a 22 px column 12 px
before the words, so every row's words start at one line; drawn in currentColor (lit and
focused rows colour it with the words), `aria-hidden` (a row's name is its words). Search
and Settings keep the website's line magnifier and gear; the rest are filled silhouettes.
The profile pill keeps the avatar, its padding set so your name starts where the words do.
Read right to left, the icon leads on the right and the paper plane turns round. Settings and the
profile pill (avatar + your name) are pinned at the foot, as the TV's spacer puts them. The
TV has one look, so the menu is the same in the glass and classic looks. It closes on a tap
beside it, a swipe to the left, Back/Escape, or by choosing a line. The rows in between
scroll on a short screen, and the last one fades while there is more below.

| # | Words | Opens | Where it comes from |
|---|---|---|---|
| # | Words | Icon (the app's name) | Opens | Where it comes from |
|---|---|---|---|---|
| 1 | Search | magnifier, line (`navSearch`) | `#/search` | TV rail |
| 2 | Home | house (`home`) | `#/` | TV rail |
| 3 | Movies | film strip (`film`) | `#/movies` | TV rail |
| 4 | Shows | screen on a stand (`series`) | `#/shows` | TV rail |
| 5 | My List | bookmark (`bookmark`) | `#/list` | TV rail |
| (6) | **Calendar** — listed once the app has a `#/calendar` screen | calendar page (`calendar`) | `#/calendar` | slot left for it |
| 7 | AI (only when the server has AI) | speech bubble (`chat`) | `#/pick` | TV rail |
| — | hairline | | | |
| 8 | What's new | sparkles (`sparkle`) | `#/new` | NAV.md 1 |
| 9 | Saved on this device | screen with an arrow in (`downloadDevice`) | `#/saved` | NAV.md 2 |
| 10 | My downloads | arrow onto a line (`download`) | `#/downloads` | NAV.md 3 |
| 11 | Your TVs (a second line "Living room TV · on" while a TV is on) | TV (`tv`) | `#/remote` | NAV.md 4 |
| 12 | Recommended by your household | paper plane (`send`) | `#/household` | NAV.md 5 |
| 13 | Your Aurora Wrapped | star (`star`) | `#/wrapped` | NAV.md 6 |
| 14 | Swipe your taste | two heads (`people`) | `#/taste` | NAV.md 7 |
| 15 | Get the apps | nine squares (`apps`) | `/install` | NAV.md 10 |
| — | hairline | | | |
| 16 | Sign in a TV | remote (`remote`) | `#/pair` | NAV.md 11 |
| 17 | Join a watch party | two heads (`people`) | the join sheet | NAV.md 12 |
| 18 | Report a problem | warning triangle (`warning`) | the report sheet | NAV.md 13 |
| foot | Settings | gear, line (`navGear`) | `#/preferences` | TV rail |
| foot | you: avatar + name → the profile menu (switch profile, sign out …) | your avatar | | TV rail ("Profile") |

Adding a place: one line in `MENU` in `js/navmore.js` (with a `when` if it only applies
sometimes), its id in `TAG`, its icon in `js/navicons.js` (the app's glyph for it;
test/navicons.test.js fails a line without one, or one that is not the app's), `more.<id>` in `src/lib/tel/controls-vocab.js` and
docs/analytics.md, and a line in the test's list (`test/ui/nav-more.test.js`).

Differences from NAV.md (phone-nav), for that branch to follow or argue: the menu is a side
menu from the left rather than a bottom sheet; the TV's places come first (Search … AI) and
Settings sits at the foot with you; the AI line says "AI" (the TV's word) rather than "AI
pick"; data-ui ids `more.search/home/movies/shows/list/calendar/profile` are new.

## Every screen, and how a phone reaches it

| Screen | Reached from |
|---|---|
| Home / Movies / Shows / My List / Search | the tabs; the menu |
| A title, its sources, a person, the player | any poster; Play; Sources on a title |
| Calendar (coming) | the menu, once its screen exists |
| AI | the menu (when the server has AI) |
| What's new | the menu; profile menu; Settings |
| Saved on this device (incl. playing a saved copy) | the menu; profile menu ("On this device") |
| My downloads | the menu; profile menu; the download pill at the top while something downloads |
| Your TVs (the remote) | **the TV button at the top while a TV is on**; the menu; profile menu (while a TV is on); Settings |
| Recommended by your household / What you sent | the menu; Home's household row; Settings → What you sent |
| Your Aurora Wrapped | the menu; Settings |
| Swipe your taste (+ Edit list) | the menu; Settings; Edit list from Swipe your taste |
| Get the apps (`/install`) | the menu; profile menu; the sign-in card |
| Sign in a TV (`#/pair`) | the menu; a TV's QR code |
| Join a watch party / Report a problem | the menu; profile menu |
| Settings, Edit profile & password | the gear at the top; the menu's foot; profile menu |
| Switch profile / Sign out | the menu's foot (you); the avatar at the top |
| Requests (`#/requests`, "Discover") | deep links only (website-only; neither app has it) |

What the TV or the phone app can do that has no page of its own here: the TV's "This TV"
settings (match frame rate, surround) and the phone's storage settings (save to the SD card,
a space limit, check for updates) belong to those devices. The website's equivalents for the
rest (playback, subtitles, sound, downloads, privacy, usage stats) are sections of Settings.

## Your TVs on the phone

The round TV button left of the gear (`#nav-remote`, js/remote.js) is there whenever one of
your TVs is on, in both looks, at every phone width. Its name is now "Your TVs" (the
remote's own title), as are the profile-menu line and the Settings line that used to say
"Remote". In the menu, "Your TVs" says which TV is on.

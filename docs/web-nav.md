# The website's navigation on a phone (2026-11-06)

The set, the order and the words are shared with the Android phone app:
[`docs/android-phone/NAV.md`](android-phone/NAV.md) (branch `phone-nav`). This page is
the website's side: where each screen is reached, and how the bar fits.

## The tab bar (phones: glass up to 720 px wide, classic up to 600 px)

`Home · Movies · Shows · My List · More · [Search]`

- AI, New and Saved left the bar for **More** (on a 320 px phone with AI and Saved on,
  Search had fallen off the end of the bar; New was hidden on phones altogether).
- More is lit while a screen it leads to is open, and carries New's green dot while this
  version's What's new is unseen.
- **No word is cut off** (`js/navmore.js fitBar`, NAV.md §1): the words are measured; if one
  does not fit, the items' sides come in, then the words step down to 10.5 px, then More
  becomes three dots (its name stays "More"). Only a reader's larger text needs any step:
  at the normal size every phone from 320 px fits without one.
- Desktop and tablet: no More; the nav is as it was (New stays in the glass island).

## More (`#nav-more`, `js/navmore.js`)

A sheet over the bar, in the bar's own frosted glass (the 1.15.10 floor), one line each:

| # | Words | Opens | data-ui |
|---|---|---|---|
| 1 | What's new | `#/new` | `more.new` |
| 2 | Saved on this device | `#/saved` | `more.saved` |
| 3 | My downloads | `#/downloads` | `more.downloads` |
| 4 | Your TVs (second line "Living room TV · on" while a TV is on) | `#/remote` | `more.remote` |
| 5 | Recommended by your household | `#/household` | `more.household` |
| 6 | Your Aurora Wrapped | `#/wrapped` | `more.wrapped` |
| 7 | Swipe your taste | `#/taste` | `more.taste` |
| 8 | AI pick (only when the server has AI) | `#/pick` | `more.pick` |
| 9 | Settings | `#/preferences` | `more.settings` |
| 10 | Get the apps | `/install` | `more.apps` |
| — | (hairline) | | |
| 11 | Sign in a TV | `#/pair` | `more.pair` |
| 12 | Join a watch party | the join sheet | `more.party` |
| 13 | Report a problem | the report sheet | `more.report` |

On a short screen the sheet stops under the top buttons and scrolls; its last line fades
while there is more below.

## Every screen, and how a phone reaches it

| Screen | Reached from |
|---|---|
| Home | tab Home; the Aurora mark |
| Movies / Shows / My List | tabs |
| Search | tab (magnifier) |
| A title, a person, the player | any poster; Play |
| What's new | More 1; profile menu; Settings |
| Saved on this device | More 2; profile menu ("On this device") |
| My downloads | More 3; profile menu; the download pill at the top while something downloads |
| Your TVs (the remote) | **the TV button at the top while a TV is on**; More 4; profile menu (while a TV is on); Settings |
| Recommended by your household | More 5; Home's household row; Settings → What you sent |
| Your Aurora Wrapped | More 6; Settings |
| Swipe your taste (+ Edit list) | More 7; Settings; Edit list from Swipe your taste |
| AI pick | More 8 (when the server has AI) |
| Settings | the gear at the top; More 9; profile menu |
| Get the apps (`/install`) | More 10; profile menu; the sign-in card |
| Sign in a TV (`#/pair`) | More 11; a TV's QR code |
| Join a watch party / Report a problem | More 12 / 13; profile menu |
| Requests (`#/requests`, "Discover") | deep links only — not in the nav since it left it, and not in NAV.md's set |

## Your TVs on the phone

The round TV button left of the gear (`#nav-remote`, js/remote.js) is there whenever one of
your TVs is on, in both looks, at every phone width; its name is now "Your TVs" (the remote's
own title), as are the profile-menu line and the Settings line that were "Remote".

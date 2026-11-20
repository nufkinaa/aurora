# Real glass, everywhere (2026-11-20)

elia: "I still find some elements that were not changed to the new glass look, like episode cards, the search... make sure we have changed everywhere" — and the Calendar.

Every pane that wears the glass tokens now takes the still half of real glass, in calm values: no light along its top (the old white hairline and sheen are gone), a body a shade darker towards the top with a little violet towards the foot, a lit violet foot line, and the violet / mint split at its two ends. No new lens and no new blur: the lens stays on the bars, the hero's button and the paused player.

It is done at the tokens (`--g-sheen`, `--g-edge`, `--g-edge-thin`, `--g-edge-thick`, `--g-edge-menu`), so every surface that uses them changed at once; the section is the last one in `public/css/glass.css`, "Real glass, everywhere".

| surface | before | now |
|---|---|---|
| top bar, phone tab bar, round top buttons, logo and profile pills, hero and title glass buttons, the player's dock and pills, Up next, resume card, quality and party pills | real glass | unchanged |
| episode cards, source rows, download rows, taste tiles, the season bar and its pills | old glass (white top line) | calm real glass |
| an episode's side buttons (desktop, tablet) | plain tiles | calm real glass |
| the search field and its suggestions list | old glass | calm real glass |
| chips, category pills, filters, pickers, season pills | old glass | calm real glass (thin) |
| Settings panes, the rating pane, pair cards, callouts, What's new cards, the trailer box, hero picks | old glass | calm real glass |
| menus (profile, drop-downs, the player's), sheets, dialogs, peek, toasts, the sign-in card, the party panel | old glass | calm real glass |
| Calendar: the day's pane, the Next-up card, chips | old glass | calm real glass (through the tokens) |
| Calendar: the month's days and arrows | own white top line | no top line, a lit foot; days with a release carry the split |
| the phone's side menu (More) | its own look | unchanged: 0 pixels differ at three widths, both looks |
| posters and cards in shelves, the hero slab, skeletons | not glass panes | unchanged |
| the classic look | — | unchanged |

Checks:
- Nothing moved: 36 screen × width cases against today's stylesheet.
- Words: no cell reads worse than today. Episodes on a phone over a bright sky band were 3.8:1 and are 4.0:1 (a phone's in-page panes are 70 % full for 67 %, to make up for the sheen that left their top); Settings icons there went from 4.2 to 4.7. On a desktop the words on in-page panes read 8–13:1 (11–14 before: a little violet now sits behind the foot of a pane).
- Speed: `timings.txt`. Phone scroll 17.7 / 18.1 / 18.55 ms today, 17.8 / 18.1 / 18.65 with the sweep, no late frames on either; desktop Home at rest 1554 ms today, 1576 ms with the sweep (medians of 6, ranges overlap).

Sheets (today beside the sweep, real size first): `01`–`02` episode cards, `03`–`04` search, `05` chips, `06` Settings, `07` Downloads, `08` the profile menu, `09`–`10` a toast and a sheet, `11` a film's page, `12` What's new, `13`–`16` the Calendar (month and list, desktop and phone).

The phone app: the same calm glass on its panes (episode cards, the search field, chips, sheets, the Calendar's cells, Downloads rows, toasts), through `tv-native/src/phone/theme.ts` (`RG_CALM_*`, `G_EDGE`, `G_FILL`, `E_EDGE`). Not built and not seen on a device this pass; `tsc` and the logic tests pass. Left as they are: the Remote screen (its own look), the games and Wrapped, text fields.

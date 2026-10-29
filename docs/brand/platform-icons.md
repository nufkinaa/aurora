# Platform glyphs on /install

The Download section of `/install` (src/lib/installpage.js, drawn from the
list in src/lib/releases.js) shows one glyph per platform. They live in
`src/lib/platform-icons.js` as inline SVG in `currentColor` — no files, no
outside requests.

| Glyph | Where it comes from | Licence |
| --- | --- | --- |
| Android head (inside the TV and phone outlines) | Simple Icons 16.36.0, `android` | Path data CC0-1.0; Simple Icons lists the Android robot as **CC BY 3.0** (Google) — credited in the page footer: "The Android robot is reproduced or modified from work created and shared by Google and used according to terms described in the Creative Commons 3.0 Attribution License." |
| Apple (iPhone & iPad, macOS) | Simple Icons 16.36.0, `apple` | Path data CC0-1.0; the mark is Apple's trademark |
| Linux (Tux) | Simple Icons 16.36.0, `linux` | Path data CC0-1.0 |
| LG (the face only, without the letters) | Simple Icons 16.36.0, `lg` (the second sub-path) | Path data CC0-1.0; LG's trademark |
| Apple TV | Simple Icons 16.36.0, `appletv` | Path data CC0-1.0; Apple's trademark |
| Windows (four panes) | drawn here | — |
| TV, phone, browser-window outlines, globe; plain TV for Fire TV and Samsung | drawn here | — |

Simple Icons: https://simpleicons.org — npm `simple-icons`, licence CC0-1.0
(see its DISCLAIMER.md: the collection is CC0, a brand's mark can carry its
own terms). Simple Icons has no Windows, Fire TV, Tizen or webOS mark, so
Windows is drawn as four squares and the two TVs use the plain TV outline;
their names are always written beside them.

The marks are their owners' trademarks and are used only to say which
platform a download is for (nominative use); the page footer says so.

## Adding one

1. Add the entry to `RELEASES` in src/lib/releases.js (its `icon` names a
   glyph here).
2. For a new mark: copy its `d` from the Simple Icons package (check the
   icon's `license` in `data/simple-icons.json`), add it to `P` and to
   `LATER` (and to `TILE`, inside a device outline, once it has a file).
3. `node --test test/releases.test.js` checks every glyph: inline, no colour
   of its own, no outside reference, one stroke weight.

# The glass: measured contrast, before and after

Branch `glass-apple`, 2026-11-10. "Before" is today's glass (origin/master's
stylesheet), "after" is this branch's — both drawn by the same GPU-backed
Chrome against the same private server, the sky and every animation held
still.

## How it was measured

For each surface the worst things that can be behind it were staged on the
page itself (`tools/glass-apple/stage.js`):

- **white poster / white picture** — a plain white sheet behind the glass
  (the picture a button sits on turned white);
- **bright poster** — a cream and lemon poster wall;
- **mid grey** — the backdrop where the old dark-or-light word flip sat on
  the fence;
- **white text under** — lines of bold white text running behind the glass;
- **bright sky band** — the whole sky painted in the aurora's brightest
  green (the real sky is never all of it at once: this is its ceiling);
- **the sky** — the sky as it usually is; **black** — nothing behind.

Then the page was photographed twice — once as it is and once with the
surface's own words and icons hidden — and for every label the two
photographs give the ink's colour (the pixels that changed most) and the
colour right behind it (the same pixels with the words gone). The number in
the table is the WCAG contrast of those two, and each cell is the WORST
label of its kind on that surface. Painted controls (a white primary button,
a switch, a badge, an avatar) are left out: they are not this material.

- **words** — the surface's main words; **chosen** — the selected tab / chip;
- **icons** — its icons; **quiet words** — the second and third voice (a
  note, a count, a hint).

A cell marked ✗ is under 4.5:1.

Run it again: `node tools/glass-apple/contrast.js both <dir>` then
`python tools/glass-apple/contrast.py <dir> <table file>`.

## The result

**214 measured cells. Under 4.5:1 — before: 61, after: 8.**

(Measured again after the second pass and the jury's ruling on it — the
deeper sheets, toast and search list, the panes in the page, the rim; menus
and chips at the first measurement's values again. Against the first
measurement of this branch no cell is lower, 84 are higher, 130 are the
same; nothing on the chrome moved.)

- Every main word, every chosen label and every word or icon on the chrome
  (tab bar, nav island, top buttons, menus, sheets, the peek, toasts, the
  buttons on a picture) is at 5.1:1 or better after, over every backdrop.
  The lowest is 5.1 (the nav island over a plain white poster) and 5.3 (an
  episode's title on a phone with the sky all bright).
- The eight that remain are all one case: **the second voice on a pane in
  the page while the WHOLE sky is its brightest green** — a chip's quiet
  label (3.8–3.9), small grey icons on a settings row, an episode on a phone and
  the search list (3.8–4.3; an icon needs 3:1), an episode's "Episode 1"
  line on a phone (3.8) and the kind of a search suggestion (4.3). On the sky
  as it is, all of them are at 6.0:1 or better (before: 2.0–4.3). To carry
  them over an all-bright sky the pane would have to be nearly opaque (it
  stopped reading as glass) or the quiet grey as bright as the main words
  (the page lost its second voice); neither was done.
- Where "after" is LOWER than "before" and both pass, it is by design:
  today's nav flips its words to dark ink over a bright poster (14–20:1) and
  to white over a dark one, and the flip is what failed in between (3.2–4.5
  over white text or a bright sky). Apple's bar does not flip; ours now keeps
  white words on a body that is dark enough over anything (5.1–5.9 over
  white, 8–16 elsewhere). The profile menu's words are 9.7–10.8 where
  today's are 11.4–12.6.

## The type tag on a hero ("SERIES" / "FILM")

Not one of the 214 cells: measured apart, by `tools/glass-apple/fixes.js`
(the pill photographed with its letters and without; the letters' own colour
against the darkest and the lightest point of the ground under them).
"A plain white sheet" is white laid directly behind a copy of the pill, with
none of the hero's own fades over it — the case of a phone hero at full
brightness over a white picture.

| where | letters | behind it | before | after |
|---|---|---|---:|---:|
| Home's hero, phone 402 | gold `#f0c67e` | a plain white sheet | 1.6 ✗ | 5.4 |
| Home's hero, phone 402 | gold | the hero's picture turned white (its fades over it) | 2.1 ✗ | 7.5 |
| Home's hero, phone 402 | gold | the hero as it is | 2.9 ✗ | 7.9 |
| Home's hero, desktop 1440 | gold | a plain white sheet | 1.6 ✗ | 5.4 |
| Home's hero, desktop 1440 | gold | the picture turned white | 5.3 | 8.8 |
| Home's hero, desktop 1440 | gold | the hero as it is | 6.0 | 8.9 |
| a film's page, phone 402 | cyan `#7fd1e8` | the page as it is | 4.3 ✗ | 8.0 |
| a film's page, desktop 1440 | cyan | the picture turned white | 1.3 ✗ | 6.3 |
| a film's page, desktop 1440 | cyan | the page as it is | 1.7 ✗ | 6.7 |
| a show's page, desktop 1440 | cyan | the picture turned white | 1.4 ✗ | 6.4 |
| a show's page, desktop 1440 | cyan | the page as it is | 4.2 ✗ | 8.2 |
| a show's page, phone 402 | cyan | the page as it is | 5.4 | 8.3 |

## The Remote screen

Not one of the 214 cells: its pads lie over the title's own art, blurred and
dimmed, and it needs a TV to be on. Measured apart by
`tools/glass-apple/remote-contrast.js` (a simulated TV on the private
server; phone 402 × 874; now playing, the touchpad, the arrow buttons; the
usual art and the art turned all white; the worst 1 % behind each word and
icon, as above). "Approved" is the first round's Remote, "item 6" the second
pass's dark panes, "third" the version made after the second jury.

| what, over an all-white picture | approved | item 6 | third |
|---|---:|---:|---:|
| the pills: Subtitles, Audio, Stop, Continue on this phone | 6.2–7.7 | 13.7–14.6 | 10.0–11.2 |
| the pills' icons | 5.9–6.4 | 13.5–14.1 | 9.6–10.1 |
| the round skip buttons' icons | 5.1 | 12.5 | 8.4 |
| the round button at the top | 6.8 | 13.9 | 9.8 |
| the picker: "Living room TV" | 5.2 | 8.3 | 7.5 |
| the picker's icons | 1.7 ✗ | 2.7 ✗ | 4.8 |
| the dock: the chosen tab ("Now playing" / "Touchpad") | 5.6–5.9 | 12.5 | 7.6 |
| the dock: the other tab | 5.3–5.7 | 10.0 | 8.4 |
| Swipe / Buttons: the chosen one | 6.4 | 9.3 | 5.4 |
| Swipe / Buttons: the other | 5.9–6.1 | 5.9–6.1 | 5.9–6.0 |
| the touchpad's hints | 1.7 ✗ | 3.6 ✗ | 7.3 |
| OK | 3.0 ✗ | 10.8 | 5.6 |
| the arrows | 3.1–4.6 ✗ | 10.5–13.0 | 7.1–9.5 |
| Back, Play/Pause, Home | 8.0–9.5 | 15.3–15.9 | 12.4–13.5 |
| their icons | 7.0–8.4 | 12.3–14.8 | 8.4–11.6 |
| the volume buttons' icons | 7.8 | 13.0 | 10.6 |
| **lowest of the 46 labels on a pane / under 4.5:1** | **1.7 / 9** | **2.7 / 5** | **4.8 / 0** |
| the same on the usual art | 2.2 / 7 | 3.9 / 5 | 5.9 / 0 |

On no pane, straight on the film, the same in all three and not touched: the
title 4.8, the time left 7.0, the elapsed time 3.5 ✗ over the all-white
picture (5.7, 7.7 and 8.0 on the usual art).

## Not measured here

- Safari on an iPhone: there is no WebKit on this PC. The body alone (no
  backdrop filter at all) holds 4.5:1 by arithmetic — a white backdrop
  behind `rgba(40,40,46,0.72)` is a grey of 100, luminance 0.127, 5.9:1
  against white words — so a browser that drops the filter is covered.
- The player's dock: it sits on a scrim of its own over the film and takes
  the same body; its words are white on it.

## The table

### Chips (desktop 1440)

| what | behind it | before | after |
|---|---|---:|---:|
| chosen | bright sky band | 1.6 ✗ | 6.6 |
| chosen | the sky | 8.7 | 8.8 |
| quiet words | bright sky band | 1.3 ✗ | 3.9 ✗ |
| quiet words | the sky | 3.4 ✗ | 6.9 |

### Chips (phone 402)

| what | behind it | before | after |
|---|---|---:|---:|
| chosen | bright sky band | 1.7 ✗ | 6.7 |
| chosen | the sky | 6.2 | 8.5 |
| quiet words | bright sky band | 1.3 ✗ | 3.8 ✗ |
| quiet words | the sky | 2.0 ✗ | 6.0 |

### Episodes and the season bar (desktop 1440)

| what | behind it | before | after |
|---|---|---:|---:|
| words | bright sky band | 1.3 ✗ | 6.4 |
| words | the sky | 4.5 | 11.3 |
| icons | bright sky band | 1.1 ✗ | 4.6 |
| icons | the sky | 4.3 ✗ | 9.3 |
| quiet words | bright sky band | 1.2 ✗ | 5.0 |
| quiet words | the sky | 3.3 ✗ | 9.1 |

### Episodes and the season bar (phone 402)

| what | behind it | before | after |
|---|---|---:|---:|
| words | bright sky band | 1.4 ✗ | 5.3 |
| words | the sky | 4.8 | 9.2 |
| icons | bright sky band | 1.1 ✗ | 3.8 ✗ |
| icons | the sky | 2.6 ✗ | 6.5 |
| quiet words | bright sky band | 1.2 ✗ | 3.8 ✗ |
| quiet words | the sky | 2.9 ✗ | 6.5 |

### Details button on the hero (desktop 1440)

| what | behind it | before | after |
|---|---|---:|---:|
| words | white picture | 16.2 | 14.1 |
| icons | white picture | 15.4 | 13.9 |

### Details button on the hero (phone 402)

| what | behind it | before | after |
|---|---|---:|---:|
| words | white picture | 13.2 | 13.0 |
| icons | white picture | 12.2 | 12.9 |

### Profile menu (desktop 1440)

| what | behind it | before | after |
|---|---|---:|---:|
| words | white poster | 11.4 | 9.7 |
| words | white text under | 12.2 | 10.4 |
| words | bright sky band | 12.1 | 10.3 |
| words | black | 12.6 | 10.8 |

### Profile menu (phone 402)

| what | behind it | before | after |
|---|---|---:|---:|
| words | white poster | 11.4 | 9.7 |
| words | white text under | 12.3 | 10.5 |
| words | bright sky band | 12.0 | 10.2 |
| words | black | 12.6 | 10.8 |

### Nav island, logo, profile (desktop 1440)

| what | behind it | before | after |
|---|---|---:|---:|
| words | white poster | 14.9 | 5.1 |
| words | bright poster | 14.7 | 5.2 |
| words | mid grey | 6.6 | 8.1 |
| words | white text under | 4.5 ✗ | 10.1 |
| words | bright sky band | 5.6 | 10.6 |
| words | black | 17.9 | 14.6 |
| chosen | white poster | 20.1 | 5.5 |
| chosen | bright poster | 20.0 | 5.6 |
| chosen | mid grey | 11.7 | 7.2 |
| chosen | white text under | 4.6 | 8.4 |
| chosen | bright sky band | 4.9 | 8.6 |
| chosen | black | 12.6 | 9.5 |
| icons | white poster | 14.2 | 5.5 |
| icons | bright poster | 14.2 | 5.6 |
| icons | mid grey | 6.3 | 8.7 |
| icons | white text under | 3.8 ✗ | 11.7 |
| icons | bright sky band | 4.4 ✗ | 11.7 |
| icons | black | 11.3 | 15.6 |
| quiet words | white text under | 3.6 ✗ | 11.3 |
| quiet words | bright sky band | 3.8 ✗ | 11.8 |
| quiet words | black | 11.9 | 16.2 |

### Nav island, logo, profile (desktop 2560)

| what | behind it | before | after |
|---|---|---:|---:|
| words | white poster | 14.9 | 5.1 |
| words | bright poster | 14.7 | 5.2 |
| words | mid grey | 6.6 | 8.1 |
| words | white text under | 4.1 ✗ | 10.0 |
| words | bright sky band | 5.9 | 10.6 |
| words | black | 17.9 | 14.6 |
| chosen | white poster | 20.1 | 5.5 |
| chosen | bright poster | 20.1 | 5.5 |
| chosen | mid grey | 11.7 | 7.2 |
| chosen | white text under | 4.1 ✗ | 8.2 |
| chosen | bright sky band | 5.0 | 8.6 |
| chosen | black | 12.6 | 9.5 |
| icons | white poster | 14.2 | 5.5 |
| icons | bright poster | 14.2 | 5.6 |
| icons | mid grey | 6.3 | 8.7 |
| icons | white text under | 3.2 ✗ | 11.0 |
| icons | bright sky band | 4.4 ✗ | 11.8 |
| icons | black | 11.3 | 15.6 |
| quiet words | white text under | 3.5 ✗ | 11.1 |
| quiet words | bright sky band | 4.4 ✗ | 12.3 |
| quiet words | black | 11.9 | 16.2 |

### Nav island, logo, profile (tablet 1024)

| what | behind it | before | after |
|---|---|---:|---:|
| words | white poster | 14.2 | 5.1 |
| words | bright poster | 14.0 | 5.2 |
| words | mid grey | 6.4 | 8.1 |
| words | white text under | 4.6 | 10.4 |
| words | bright sky band | 5.3 | 10.9 |
| words | black | 17.9 | 14.6 |
| chosen | white poster | 20.1 | 5.5 |
| chosen | bright poster | 19.9 | 5.6 |
| chosen | mid grey | 11.7 | 7.2 |
| chosen | white text under | 3.9 ✗ | 8.1 |
| chosen | bright sky band | 5.8 | 8.8 |
| chosen | black | 12.6 | 9.5 |
| icons | white poster | 14.2 | 5.5 |
| icons | bright poster | 14.2 | 5.6 |
| icons | mid grey | 6.3 | 8.8 |
| icons | white text under | 3.6 ✗ | 11.5 |
| icons | bright sky band | 4.2 ✗ | 11.8 |
| icons | black | 11.3 | 15.8 |
| quiet words | white text under | 3.7 ✗ | 11.3 |
| quiet words | bright sky band | 3.8 ✗ | 11.7 |
| quiet words | black | 11.9 | 16.2 |

### Peek sheet (desktop 1440)

| what | behind it | before | after |
|---|---|---:|---:|
| words | white poster | 3.9 ✗ | 12.7 |
| words | white text under | 10.0 | 13.3 |
| words | bright sky band | 10.8 | 13.3 |
| words | black | 15.5 | 13.7 |
| icons | white poster | 4.0 ✗ | 12.6 |
| icons | white text under | 10.4 | 13.3 |
| icons | bright sky band | 11.5 | 13.3 |
| icons | black | 15.8 | 13.7 |
| quiet words | white poster | 2.8 ✗ | 9.5 |
| quiet words | white text under | 7.5 | 10.6 |
| quiet words | bright sky band | 6.8 | 11.1 |
| quiet words | black | 11.3 | 11.4 |

### Peek sheet (phone 402)

| what | behind it | before | after |
|---|---|---:|---:|
| words | white poster | 3.9 ✗ | 12.6 |
| words | white text under | 11.0 | 13.4 |
| words | bright sky band | 5.0 | 12.8 |
| words | black | 11.6 | 13.5 |
| icons | white poster | 4.0 ✗ | 12.6 |
| icons | white text under | 8.4 | 13.3 |
| icons | bright sky band | 4.8 | 12.8 |
| icons | black | 8.8 | 13.5 |
| quiet words | white poster | 2.8 ✗ | 9.5 |
| quiet words | white text under | 7.9 | 11.0 |
| quiet words | bright sky band | 3.6 ✗ | 9.9 |
| quiet words | black | 11.3 | 11.4 |

### Settings panes (desktop 1440)

| what | behind it | before | after |
|---|---|---:|---:|
| words | bright sky band | 1.2 ✗ | 6.2 |
| words | the sky | 3.8 ✗ | 11.3 |
| chosen | bright sky band | 1.2 ✗ | 6.2 |
| chosen | the sky | 4.5 | 11.7 |
| icons | bright sky band | 1.3 ✗ | 4.3 ✗ |
| icons | the sky | 3.0 ✗ | 8.1 |
| quiet words | bright sky band | 1.3 ✗ | 5.0 |
| quiet words | the sky | 2.8 ✗ | 9.3 |

### Settings panes (phone 402)

| what | behind it | before | after |
|---|---|---:|---:|
| words | bright sky band | 1.2 ✗ | 6.5 |
| words | the sky | 4.6 | 12.7 |
| icons | bright sky band | 1.3 ✗ | 4.2 ✗ |
| icons | the sky | 2.7 ✗ | 8.4 |
| quiet words | bright sky band | 1.2 ✗ | 4.9 |
| quiet words | the sky | 3.0 ✗ | 9.5 |

### Confirm sheet (desktop 1440)

| what | behind it | before | after |
|---|---|---:|---:|
| words | white poster | 3.7 ✗ | 12.0 |
| words | white text under | 10.1 | 13.5 |
| words | bright sky band | 11.5 | 13.4 |
| words | black | 15.9 | 13.7 |
| quiet words | white poster | 2.5 ✗ | 9.4 |
| quiet words | white text under | 7.0 | 11.1 |
| quiet words | bright sky band | 6.6 | 11.1 |
| quiet words | black | 10.9 | 12.1 |

### Confirm sheet (phone 402)

| what | behind it | before | after |
|---|---|---:|---:|
| words | white poster | 3.7 ✗ | 12.0 |
| words | white text under | 11.2 | 13.4 |
| words | bright sky band | 5.1 | 12.8 |
| words | black | 15.9 | 13.7 |
| quiet words | white poster | 2.5 ✗ | 9.4 |
| quiet words | white text under | 7.3 | 11.3 |
| quiet words | bright sky band | 3.5 ✗ | 10.3 |
| quiet words | black | 10.9 | 12.1 |

### Search suggestions (desktop 1440)

| what | behind it | before | after |
|---|---|---:|---:|
| words | bright sky band | 7.6 | 7.7 |
| words | the sky | 11.4 | 11.1 |
| icons | bright sky band | 1.2 ✗ | 3.8 ✗ |
| icons | the sky | 3.6 ✗ | 6.7 |
| quiet words | bright sky band | 2.5 ✗ | 4.3 ✗ |
| quiet words | the sky | 3.9 ✗ | 6.2 |

### Tab bar (phone 402)

| what | behind it | before | after |
|---|---|---:|---:|
| chosen | white poster | 5.4 | 5.5 |
| chosen | bright poster | 5.5 | 5.7 |
| chosen | mid grey | 6.5 | 7.2 |
| chosen | white text under | 7.4 | 8.3 |
| chosen | bright sky band | 6.4 | 6.8 |
| chosen | black | 8.3 | 9.5 |
| icons | white poster | 6.9 | 5.6 |
| icons | bright poster | 7.1 | 5.9 |
| icons | mid grey | 8.3 | 9.0 |
| icons | white text under | 9.5 | 11.9 |
| icons | bright sky band | 7.9 | 7.7 |
| icons | black | 10.4 | 16.0 |
| quiet words | white poster | 5.6 | 5.8 |
| quiet words | bright poster | 5.8 | 6.1 |
| quiet words | mid grey | 6.9 | 9.2 |
| quiet words | white text under | 8.0 | 11.0 |
| quiet words | bright sky band | 6.8 | 7.3 |
| quiet words | black | 9.0 | 16.4 |

### Tab bar (phone 320)

| what | behind it | before | after |
|---|---|---:|---:|
| chosen | white poster | 5.5 | 5.5 |
| chosen | bright poster | 5.6 | 5.7 |
| chosen | mid grey | 6.5 | 7.2 |
| chosen | white text under | 7.4 | 8.2 |
| chosen | bright sky band | 7.0 | 7.8 |
| chosen | black | 8.4 | 9.5 |
| icons | white poster | 6.9 | 5.6 |
| icons | bright poster | 7.1 | 5.9 |
| icons | mid grey | 8.3 | 9.0 |
| icons | white text under | 10.3 | 16.0 |
| icons | bright sky band | 9.1 | 11.0 |
| icons | black | 10.4 | 16.0 |
| quiet words | white poster | 5.7 | 5.8 |
| quiet words | bright poster | 5.9 | 6.1 |
| quiet words | mid grey | 7.0 | 9.2 |
| quiet words | white text under | 7.9 | 10.8 |
| quiet words | bright sky band | 7.6 | 10.1 |
| quiet words | black | 9.1 | 16.4 |

### Buttons on a title page (desktop 1440)

| what | behind it | before | after |
|---|---|---:|---:|
| words | white picture | 8.1 | 11.6 |
| icons | white picture | 7.6 | 11.4 |
| quiet words | white picture | 2.6 ✗ | 6.5 |

### Buttons on a title page (phone 402)

| what | behind it | before | after |
|---|---|---:|---:|
| icons | white picture | 7.0 | 7.0 |
| quiet words | white picture | 5.7 | 5.7 |

### Toast (desktop 1440)

| what | behind it | before | after |
|---|---|---:|---:|
| words | white poster | 5.8 | 5.8 |
| words | bright poster | 5.9 | 6.0 |
| words | mid grey | 7.7 | 7.9 |
| words | white text under | 9.2 | 9.7 |
| words | bright sky band | 6.6 | 6.6 |
| words | black | 11.4 | 12.1 |

### Toast (phone 402)

| what | behind it | before | after |
|---|---|---:|---:|
| words | white poster | 5.9 | 5.8 |
| words | bright poster | 6.1 | 6.0 |
| words | mid grey | 8.0 | 7.9 |
| words | white text under | 9.8 | 10.0 |
| words | bright sky band | 9.5 | 9.7 |
| words | black | 11.9 | 12.2 |

### Top buttons: settings (phone 402)

| what | behind it | before | after |
|---|---|---:|---:|
| icons | white poster | 14.3 | 5.5 |
| icons | bright poster | 14.2 | 5.7 |
| icons | mid grey | 6.3 | 8.8 |
| icons | white text under | 4.6 | 12.0 |
| icons | bright sky band | 4.7 | 9.2 |
| icons | black | 11.4 | 15.9 |

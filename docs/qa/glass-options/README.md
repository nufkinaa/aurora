# Glass versions to choose from (2026-11-11)

elia: "can you please work on better glass for the website and everything, and send me examples of it and then I'll choose, search online see how other people do it, see how Apple does it how figma does it and give me a few versions to choose from".

Five versions of the website's glass, the same moments photographed in each. **A is today's glass and stays the default.** The other four are review-only and load only when a tab asks for them:

- `https://<server>/?glass=b` (or `c`, `d`, `e`) shows that version in that tab. The choice is kept for the tab (sessionStorage) until `?glass=a`.
- Nobody else sees anything different. Without the query, no extra file is fetched (test/ui/glass-options.test.js checks this).

## The sheets

| file | what it shows |
|---|---|
| `00-overview.png` | One row per version: phone Home, the phone tab bar at 2×, the desktop profile menu, the player's menu over a bright frame |
| `01-phone-home.png` | Phone 390 × 844, Home: the picture, the greeting, the tab bar (real posters) |
| `02-phone-more.png` | Phone, the More menu open |
| `03-phone-title.png` | Phone, a film's page: the buttons |
| `04-phone-sheet.png` | Phone, the Recommend sheet open (private test server) |
| `05-desktop-home.png` | Desktop 1440 × 900, Home: the top bar over the picture |
| `06-desktop-menu.png` | Desktop, the profile menu open |
| `07-desktop-title.png` | Desktop, a film's page |
| `08-player-menu.png` | The player's Settings menu over a bright frame (private test server) |
| `09-phone-toast.png` | Phone, a message (toast) over bright posters |
| `10-phone-bright.png` | Phone, the tab bar over white posters (the worst case) |
| `11-liquid-light.png` | Version C: the light on the top bar following the pointer (six frames) |

Each scene sheet has the whole screens on top and the glass parts at 2× underneath. Scenes 01–03 and 05–07 come from this PC's own server, only looked at, as the test profile "Claude QA", with real posters. The rest come from a private test server with made-up art. In both, the sky is painted still and the hero does not rotate, so only the glass differs.

## The versions

**A · today (1.15.28).** A dark neutral grey body at 72 % with a 6 px blur and a lit rim. It reads over anything, but it carries no colour of its own.

**B · Aurora.** Today's glass in weight and blur, with a body tinted Aurora's deep violet-indigo. The room's violet comes in from the top-left and the aurora green from the foot, as the TV's menus are painted, with a soft violet glow on the rim and a faint violet light in the shadow. The phone's More menu becomes a see-through pane of the same colours.

**C · Liquid.** The closest to Apple's Liquid Glass. The body is much clearer (34 % of near-black), and the picture behind is dimmed to 60 % before it is laid under the glass (Apple's "dimming layer"), so colour comes through but brightness does not. The light catches the top-left of the rim and, more faintly, the bottom-right. The chosen tab is a lighter capsule with its own rim. On Chrome and Edge, what is behind a bar bends at its edge (refraction, `js/glass-lens.js`), and on a desktop the light on the top bar follows the pointer. The More menu floats as a rounded pane.

**D · Frost.** Figma's Glass effect, with its dials set as follows:
- Frost: 12 px of blur on the bars and 18 px on menus, over a cool blue-grey body at 50 %.
- Light angle: −45°, a glare in the top-left corner.
- Depth: a thicker inner edge and a deeper, softer shadow.
- Dispersion: a faint cyan and rose split on the far edges.
- Grain: a fine noise over the body.

It looks the same in every browser.

**E · Clear.** The most see-through: a fifth of black and a 3 px blur, with the picture behind dimmed hard (55 %), so a poster stays a poster. A strong edge draws the shape: a light line all round, a dark hairline outside, and a small close shadow. Words carry a soft dark shadow of their own. Menus and sheets frost more (10 px).

Files: `public/css/glass-opt-b.css` … `glass-opt-e.css` (each is one self-contained block; its head says how to make it the default), `public/js/glass-lens.js` (C only), and the switch in `public/index.html`'s boot script.

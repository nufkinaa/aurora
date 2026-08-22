"""Generate the card focus HALO — the site's `.card::before`.

Run from tv-native/:  python tools/gen_card_aura.py

WHY THIS IS A BAKED IMAGE AND NOT A BOX-SHADOW
----------------------------------------------
The previous build approximated the halo with a third white box-shadow layer.
That was the only thing available at the time, but it is not what the site draws
and it shows: a box-shadow is a hard-edged silhouette with a gaussian falloff
applied by the compositor, so it reads as a *rim* — the light is concentrated in
the first few px and gone by 10. The site's halo is the card's own rounded
rectangle blurred by 13px at 0.92 white and then held at opacity 0.55, which puts
real light 25-30px out. Standing in front of the TV the difference is not subtle:
the shadow version outlines the poster, the real one lights the wall behind it.

So this bakes the actual thing. It is the same trick as every other gradient in
this app (tools/gen-gradients.js, gen_side_scrim.py): RN has no blur filter and
no mask-image, but it renders a PNG just fine.

  card-aura.png       portrait  2:3, for poster cards
  card-aura-wide.png  landscape 16:9, for Continue Watching / episode cards

Two files rather than one stretched file ON PURPOSE. A blur is isotropic — the
light travels the same distance on every side — which is exactly why the site
blurs the silhouette instead of using a radial-gradient (its own comment says a
radial gradient "landed at a different distance on the long sides than the short
ones"). Stretching ONE halo bitmap across two aspect ratios reintroduces that
exact bug: the 2:3 halo squashed into a 16:9 box has light that is thin top and
bottom and fat on the sides. Nine-patch stretching would solve it in the general
case, but RN's Image has no nine-patch support for arbitrary assets, and there
are only two card shapes in the app.

The noise mask IS ported here, unlike in the box-shadow version where it was
impossible. It is cheap (one multiply into the alpha channel at bake time, zero
cost at runtime) and it is what stops a large soft white glow from banding on an
8-bit panel — the same reason the site's body::before grain exists.
"""
import os
import random

from PIL import Image, ImageDraw, ImageFilter

ASSETS = os.path.join(os.path.dirname(__file__), '..', 'src', 'assets')
os.makedirs(ASSETS, exist_ok=True)

# Card geometry in dp, from components/Card.tsx. Baked at 2x so the halo still
# resolves on a 4K panel without a second asset.
SCALE = 2
CARD_W, CARD_H = 124, 186        # CARD_W, CARD_W * 1.5
WIDE_W, WIDE_H = 176, 99        # WIDE_W, round(WIDE_W * 9 / 16)
RADIUS = 12                      # radius.m

# --card-aura-reach. How far the light travels past the card edge. The site uses
# 38px on a ~200px card; 26 is the value theme.ts already publishes as
# cardAura.reach and every row pads by (FOCUS_OVERHANG), so keeping it means no
# layout anywhere has to change.
REACH = 16
# filter: blur(13px), as a true sigma (CSS's blur() radius is ~2*sigma).
#
# But the site's 13px is tuned against a ~200px-wide card with `inset:
# -1.1*reach` at reach=38 — i.e. the blur is only ever asked to carry light about
# a third of the way to the layer's edge. Baking the same sigma against
# reach=26 put the light at zero by 13dp (measured off the first bake: alpha 38
# at the card edge, 1 at 13dp, 0 beyond). That is a rim, which is the exact
# failure the box-shadow version had and the reason for replacing it.
#
# Sigma is therefore derived from the distance the light must actually travel
# rather than copied. A gaussian is ~0 at 3 sigma, so sigma = REACH/3 puts the
# visible falloff exactly at the reach the layout already reserves.
SIGMA = 16 / 3
# background-color: rgba(255,255,255,0.92), before the .card:focus opacity: 0.55
# that the runtime applies. Both are folded in here: the view draws the PNG at
# full opacity, so what is baked has to be the FINAL light.
#
# GAIN was 2.0, "to restore the edge brightness lost to the punch-out". That was
# wrong, and it is the same mistake the ambient bake made: measured against the
# live site the halo came out about twice as bright as the real one, and a big
# soft over-bright smudge is not the tvOS look — the site's focus reads as a
# CRISP hairline edge with light behind it, not as a glow.
#
# So: no gain. What the site draws is what gets baked. The apparent dimness at
# the card edge is correct — the bright half of the gaussian genuinely does sit
# under the poster, on the site too.
FILL_A = 0.92
FOCUS_OPACITY = 0.55
GAIN = 1.0


def halo(w_dp: int, h_dp: int) -> Image.Image:
    """The card's silhouette, blurred, with the grain mask over it."""
    w, h = w_dp * SCALE, h_dp * SCALE
    # 1.15x the reach, mirroring the site's `inset: calc(-1.1 * reach)`: the
    # bitmap has to be slightly bigger than the light it carries, or the tail is
    # cut off square by the bitmap edge and the "clipped light" artefact moves
    # from the row's bounds into the asset itself.
    pad = round(REACH * 1.15) * SCALE
    # The canvas reaches `pad` past the card on all four sides. Blur needs room
    # to fall off inside the bitmap or the light is sliced by the bitmap edge —
    # the same clipping problem the rows pad for, one level down.
    W, H = w + pad * 2, h + pad * 2

    img = Image.new('L', (W, H), 0)
    ImageDraw.Draw(img).rounded_rectangle(
        [pad, pad, pad + w - 1, pad + h - 1],
        radius=RADIUS * SCALE,
        fill=int(255 * FILL_A),
    )
    img = img.filter(ImageFilter.GaussianBlur(SIGMA * SCALE))

    # The card itself sits ON TOP of this layer at runtime, so the light under
    # the poster is never seen — but it still costs fill rate, and on a dark
    # panel any leak around a poster's own rounded corners reads as a grey halo
    # rather than a white one. background-clip: content-box is how the site
    # removes it; punching the silhouette back out is the same thing.
    hole = Image.new('L', (W, H), 0)
    ImageDraw.Draw(hole).rounded_rectangle(
        [pad, pad, pad + w - 1, pad + h - 1],
        radius=RADIUS * SCALE,
        fill=255,
    )
    img = Image.composite(Image.new('L', (W, H), 0), img, hole)

    # feTurbulence, near enough. The site masks with fractalNoise at
    # baseFrequency 1.1 / 1 octave, transferred through slope 0.9 + intercept
    # 0.45 — i.e. the mask never goes below 0.45, so the grain TEXTURES the light
    # rather than punching holes in it. Same range here.
    random.seed(7)  # deterministic: regenerating must not change the asset
    grain = Image.new('L', (W, H))
    grain.putdata([random.randint(115, 255) for _ in range(W * H)])

    # alpha = blurred_silhouette * grain * focus_opacity, all in 0..1.
    alpha = Image.new('L', (W, H))
    alpha.putdata([
        min(255, int(a * (g / 255.0) * FOCUS_OPACITY * GAIN))
        for a, g in zip(img.getdata(), grain.getdata())
    ])

    # White light: the site's fill is pure white, and whatever warmth it picks up
    # comes from the artwork behind it.
    out = Image.new('RGBA', (W, H), (255, 255, 255, 0))
    out.paste((255, 255, 255), (0, 0, W, H), alpha)
    return out


for name, (w, h) in {
    'card-aura.png': (CARD_W, CARD_H),
    'card-aura-wide.png': (WIDE_W, WIDE_H),
}.items():
    path = os.path.join(ASSETS, name)
    halo(w, h).save(path, optimize=True)
    print(f'{name}: {os.path.getsize(path) / 1024:.1f} KB')

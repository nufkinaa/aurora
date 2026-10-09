# Aurora brand builder. Beam is the logo; Curtain and Horizon are kept as the proposals they were.
#
#   python docs/brand/tools/build.py            every SVG + preview in docs/brand, overview.png and
#                                               beam-background-options.png (touches nothing outside docs/brand)
#   python docs/brand/tools/build.py install    the above for Beam, then every INSTALLED asset: the web icons and
#                                               badge, the favicon and nav-mark data URIs, the Android TV launcher
#                                               icons, banner and nav-rail mark (list: INSTALLED, below)
#
# Everything is drawn in tools/concepts.py, rasterised from the SVG by headless Chrome (or Edge) at 1024 px
# and Lanczos-downscaled. Needs Pillow. Nothing here builds the app or bumps a version.
import os, re, subprocess, sys, pathlib
from PIL import Image, ImageDraw, ImageFont

HERE = pathlib.Path(__file__).parent
OUT = HERE.parent                      # docs/brand
ROOT = OUT.parent.parent                # the repo
WEB = ROOT / "public"
RES = ROOT / "tv-native/android/app/src/main/res"
TV_ASSETS = ROOT / "tv-native/src/assets"
import tempfile
TMP = pathlib.Path(tempfile.gettempdir()) / "aurora-brand"; TMP.mkdir(exist_ok=True)
CHROME = next(p for p in ("C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe") if os.path.exists(p))

NAVY = "#0b0c14"; NAVY2 = "#161a33"; TEXT = "#f3f4f8"

sys.path.insert(0, str(HERE))
import concepts
CONCEPTS = concepts.CONCEPTS
TITLES = concepts.TITLES


# ---------------------------------------------------------------- wordmark (monoline, drawn - no font)
def wordmark(x, base, scale, color=TEXT, sw=14):
    k = concepts.KERN
    A = "M0 0L62 -142L124 0M25 -48H99"
    u = "M0 -100V-40A40 40 0 0 0 80 -40M80 -100V0"
    r = "M0 -100V0M0 -56A44 44 0 0 1 72.3 -89.7"
    o = "M0 -50A50 50 0 1 0 100 -50A50 50 0 1 0 0 -50Z"
    a = o + "M100 -100V0"
    L = [A, u, r, o, r, a]
    s = "".join(f'\n    <path transform="translate({k[i]} 0)" d="{L[i]}"/>' for i in range(6))
    return (f'<g transform="translate({x} {base}) scale({scale})" fill="none" stroke="{color}" stroke-width="{sw}" '
            f'stroke-linejoin="miter" stroke-miterlimit="8">{s}\n  </g>')


SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}"{extra}>\n{body}\n</svg>\n'


def tile_defs(cx=256, cy=120, r=460):
    return (f'<radialGradient id="tile" gradientUnits="userSpaceOnUse" cx="{cx}" cy="{cy}" r="{r}">'
            f'<stop offset="0" stop-color="{NAVY2}"/><stop offset="1" stop-color="{NAVY}"/></radialGradient>')


def write(name, fn):
    d, s = fn("mark")
    (OUT / f"{name}-mark.svg").write_text(SVG.format(w=512, h=512, extra="", body=f"  <defs>{d}</defs>\n  {s}"))
    # app-icon form: full-bleed square (launchers round it themselves)
    ic = fn("icon")
    if ic:
        body = f'  <defs>{ic[0]}</defs>\n  {ic[1]}'
    else:
        sc = concepts.ICON_SCALE.get(name, .82)
        body = (f'  <defs>{tile_defs()}{d}</defs>\n  <rect width="512" height="512" fill="url(#tile)"/>\n'
                f'  <g transform="translate(256 256) scale({sc}) translate(-256 -256)">\n  {s}\n  </g>')
    (OUT / f"{name}-icon.svg").write_text(beam_icon_svg() if name == "beam" else SVG.format(w=512, h=512, extra="", body=body))
    md, m = fn("mono")
    (OUT / f"{name}-mono.svg").write_text(SVG.format(w=512, h=512, extra=' color="#f3f4f8"', body=f"  {md}\n  {m}".replace("  \n", "")))
    tile = ic is not None      # a mark that is its own tile sits a little smaller beside the word
    k, off = (.43, 24) if tile else (.5078, concepts.LOCKUP_OFF.get(name, 4))
    wm = wordmark(300, 205, 1.0)
    (OUT / f"{name}-lockup.svg").write_text(SVG.format(w=1030, h=280, extra="",
        body=f'  <defs>{d}</defs>\n  <g transform="translate({20 + (260 - 512 * k) / 2:.1f} {off}) scale({k})">\n  {s}\n  </g>\n  {wm}'))
    if name == "beam":
        (OUT / "beam-tv-banner.svg").write_text(beam_banner_svg())
        return
    k = .168 if tile else .195
    wm = wordmark(136, 107, .23, sw=14.5)
    (OUT / f"{name}-tv-banner.svg").write_text(SVG.format(w=320, h=180, extra="",
        body=f'  <defs>{tile_defs(90, 30, 330)}{d}</defs>\n'
             f'  <rect width="320" height="180" fill="url(#tile)"/>\n'
             f'  <g transform="translate({24 + (100 - 512 * k) / 2:.1f} {90 - 256 * k + concepts.LOCKUP_OFF.get(name, 0) * .2:.1f}) scale({k})">\n  {s}\n  </g>\n  {wm}'))


def shot(svg, png, w, h, bg="transparent"):
    html = TMP / "r.html"
    html.write_text(f'<!doctype html><html><body style="margin:0;background:{bg};overflow:hidden">'
                    f'<img src="{pathlib.Path(svg).as_uri()}" width="{w}" height="{h}" style="display:block"></body></html>')
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--default-background-color=00000000",
                    "--force-device-scale-factor=1", f"--window-size={w},{h}", f"--screenshot={png}", html.as_uri()],
                   check=True, capture_output=True, timeout=120)
    im = Image.open(png).convert("RGBA")
    assert im.size == (w, h), im.size
    return im


def render(name):
    big = shot(OUT / f"{name}-icon.svg", TMP / f"{name}-icon.png", 1024, 1024)
    big.resize((512, 512), Image.LANCZOS).convert("RGB").save(OUT / f"{name}-512.png")
    big.resize((64, 64), Image.LANCZOS).convert("RGB").save(OUT / f"{name}-64.png")
    big.resize((32, 32), Image.LANCZOS).convert("RGB").save(OUT / f"{name}-32.png")
    b = shot(OUT / f"{name}-tv-banner.svg", TMP / f"{name}-banner.png", 1280, 720)
    b.resize((320, 180), Image.LANCZOS).convert("RGB").save(OUT / f"{name}-tv-banner.png")
    shot(OUT / f"{name}-mark.svg", TMP / f"{name}-mark.png", 768, 768)
    shot(OUT / f"{name}-mono.svg", TMP / f"{name}-mono.png", 768, 768)
    shot(OUT / f"{name}-lockup.svg", TMP / f"{name}-lockup.png", 1030, 280)


def font(sz, bold=False):
    try:
        return ImageFont.truetype(r"C:\Windows\Fonts\segoeuib.ttf" if bold else r"C:\Windows\Fonts\segoeui.ttf", sz)
    except Exception:
        return ImageFont.load_default()


def rounded(im, rad):
    im = im.convert("RGBA")
    k = 4
    m = Image.new("L", (im.size[0] * k, im.size[1] * k), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, m.size[0] - 1, m.size[1] - 1], rad * k, fill=255)
    im.putalpha(m.resize(im.size, Image.LANCZOS))
    return im


def paste(S, im, xy):
    S.paste(im, xy, im)


def sheet(names, titles):
    W, pad = 1800, 30
    colw = (W - pad * (len(names) + 1)) // len(names)
    S = Image.new("RGB", (W, 1700), "#07080f"); D = ImageDraw.Draw(S)
    D.text((pad, 20), "Aurora - logo proposals", font=font(34, True), fill=TEXT)
    D.text((pad, 70), "Per column: app icon on navy; 64 / 32 / 16 px and launcher tiles on mid-grey; one-colour; lockup; Android TV banner at actual size.",
           font=font(18), fill="#9aa1b5")
    for i, n in enumerate(names):
        x = pad + i * (colw + pad); y = 120
        D.text((x, y), titles[i], font=font(26, True), fill=TEXT); y += 48
        icon = Image.open(TMP / f"{n}-icon.png")
        paste(S, rounded(icon.resize((colw, colw), Image.LANCZOS), 36), (x, y)); y += colw + 20
        # small sizes on navy
        half = 250
        D.rectangle([x, y, x + half, y + 124], fill="#0b0c14", outline="#1b1e30")
        paste(S, rounded(Image.open(OUT / f"{n}-64.png"), 14), (x + 28, y + 22))
        paste(S, rounded(Image.open(OUT / f"{n}-32.png"), 7), (x + 122, y + 38))
        paste(S, rounded(icon.resize((16, 16), Image.LANCZOS), 3), (x + 186, y + 46))
        D.text((x + 50, y + 96), "64", font=font(12), fill="#616880"); D.text((x + 131, y + 96), "32", font=font(12), fill="#616880")
        D.text((x + 187, y + 96), "16", font=font(12), fill="#616880")
        # mid-grey launcher
        D.rectangle([x + half + 14, y, x + colw, y + 124], fill="#6b6f7a")
        paste(S, rounded(icon.resize((84, 84), Image.LANCZOS), 20), (x + half + 40, y + 20))
        paste(S, rounded(icon.resize((84, 84), Image.LANCZOS), 42), (x + half + 148, y + 20))
        y += 144
        # one colour: light on dark, dark on light
        h2 = colw // 2
        D.rectangle([x, y, x + h2 - 7, y + 150], fill="#0b0c14", outline="#1b1e30"); D.rectangle([x + h2 + 7, y, x + colw, y + 150], fill="#e9eaf0")
        mo = Image.open(TMP / f"{n}-mono.png")
        m120 = mo.resize((120, 120), Image.LANCZOS); paste(S, m120, (x + 50, y + 15))
        paste(S, mo.resize((24, 24), Image.LANCZOS), (x + 200, y + 63))
        dk = Image.new("RGBA", mo.size, "#0b0c14"); dk.putalpha(mo.split()[3])
        paste(S, dk.resize((120, 120), Image.LANCZOS), (x + h2 + 57, y + 15))
        paste(S, dk.resize((24, 24), Image.LANCZOS), (x + h2 + 207, y + 63))
        y += 170
        D.rectangle([x, y, x + colw, y + 170], fill="#0b0c14", outline="#1b1e30")
        lk = Image.open(TMP / f"{n}-lockup.png"); lw = colw - 100
        paste(S, lk.resize((lw, int(lw * 280 / 1030)), Image.LANCZOS), (x + 50, y + (170 - int(lw * 280 / 1030)) // 2))
        y += 190
        D.rectangle([x, y, x + colw, y + 232], fill="#3a3d47")
        paste(S, rounded(Image.open(OUT / f"{n}-tv-banner.png"), 10), (x + (colw - 320) // 2, y + 26))
        y += 252
    S.crop((0, 0, W, y + 10)).save(OUT / "overview.png")


# ================================================================ BEAM, the chosen logo
# Geometry of the mark inside its 512 box: the triangle spans x 136..442, y 88..424.
MARK_BOX = (117, 84, 344)          # the tightest square around it (x, y, side) - nav mark
ICON_K = concepts.ICON_SCALE["beam"]   # mark scale in a full-bleed icon: inside the maskable 80% circle
ADAPT = 2 / 3                      # an adaptive-icon layer is 108dp, the launcher shows the middle 72dp
TILE_K = .96                       # mark scale in the small rounded tile (favicon, TV nav rail)
RADIUS = 8 / 26                    # the tile's corner radius, as the nav mark has always had


def placed(shapes, k, cx=256, cy=256):
    return f'<g transform="translate({cx} {cy}) scale({k:.4f}) translate(-256 -256)">\n  {shapes}\n  </g>'


def beam_icon_svg(level=None, k=ICON_K):
    """Full-bleed square: hue background + mark. Launchers and the PWA mask round it themselves."""
    d, s = concepts.beam("mark"); bd, bs = concepts.glow_bg(512, 512, level)
    return SVG.format(w=512, h=512, extra="", body=f'  <defs>{bd}{d}</defs>\n  {bs}\n  {placed(s, k)}')


def beam_old_icon_svg():
    """Yesterday's near-flat navy tile - only for the comparison sheet."""
    d, s = concepts.beam("mark")
    return SVG.format(w=512, h=512, extra="", body=f'  <defs>{tile_defs()}{d}</defs>\n  <rect width="512" height="512" fill="url(#tile)"/>\n  {placed(s, ICON_K)}')


def beam_adaptive_bg_svg():
    """Adaptive-icon background layer: the same glow, hung off the corners of the visible middle two thirds."""
    o, side = 256 * (1 - ADAPT), 512 * ADAPT
    bd, bs = concepts.glow_bg(512, 512, None, (o, o, side, side))
    return SVG.format(w=512, h=512, extra="", body=f'  <defs>{bd}</defs>\n  {bs}')


def beam_adaptive_fg_svg():
    """Adaptive-icon foreground layer: the mark alone, the size it has in the legacy icon (well inside the 66dp circle)."""
    d, s = concepts.beam("mark")
    return SVG.format(w=512, h=512, extra="", body=f'  <defs>{d}</defs>\n  {placed(s, ICON_K * ADAPT)}')


def beam_tile_svg(rounded_clip=False):
    """The small tile: hue background, the mark nearly filling it. The favicon rounds it in the SVG itself."""
    d, s = concepts.beam("mark"); bd, bs = concepts.glow_bg(512, 512)
    clip = f'\n    <clipPath id="r"><rect width="512" height="512" rx="{RADIUS * 512:.0f}"/></clipPath>' if rounded_clip else ""
    inner = f'{bs}\n  {placed(s, TILE_K)}'
    if rounded_clip:
        inner = f'<g clip-path="url(#r)">\n  {inner}\n  </g>'
    return SVG.format(w=512, h=512, extra="", body=f'  <defs>{bd}{d}{clip}</defs>\n  {inner}')


def beam_banner_svg(level=None, old=False):
    """320x180 Android TV banner: mark + wordmark, centred as one lockup."""
    d, s = concepts.beam("mark")
    k, ws, gap = .22, .255, 20
    mw, ww = 306 * k, (concepts.KERN[-1] + 100) * ws
    x0 = (320 - (mw + gap + ww)) / 2
    if old:
        bd, bs = tile_defs(90, 30, 330), '<rect width="320" height="180" fill="url(#tile)"/>'
    else:
        bd, bs = concepts.glow_bg(320, 180, level)
    mark = f'<g transform="translate({x0 - 136 * k:.1f} {90 - 256 * k:.1f}) scale({k})">\n  {s}\n  </g>'
    return SVG.format(w=320, h=180, extra="", body=f'  <defs>{bd}{d}</defs>\n  {bs}\n  {mark}\n  {wordmark(round(x0 + mw + gap, 1), 108, ws, sw=14.5)}')


def beam_badge_svg():
    """One colour, white on transparent, with the breathing room a notification badge wants."""
    d, s = concepts.beam("mono")
    x, y, side = MARK_BOX; pad = 28
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{x - pad} {y - pad} {side + 2 * pad} {side + 2 * pad}" color="#ffffff">\n  {d}\n  {s}\n</svg>\n')


def data_uri(svg):
    """An SVG as a data: URI that is safe inside href="..." and inside CSS url("...")."""
    s = re.sub(r">\s+<", "><", svg.strip()).replace("\n", " ").replace('"', "'")
    s = re.sub(r"\s{2,}", " ", s)
    return "data:image/svg+xml," + s.replace("%", "%25").replace("#", "%23").replace("<", "%3C").replace(">", "%3E")


def mark_uri():
    """The mark alone, cropped tight - the CSS `.logo-mark` background (site nav, admin, in-app browser)."""
    d, s = concepts.beam("mark"); x, y, side = MARK_BOX
    return data_uri(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{x} {y} {side} {side}"><defs>{d}</defs>{s}</svg>')


def beam_mark_svg():
    """The mark alone on a transparent square (the TV rail's picture; mark_uri is the same, as a data: URI)."""
    d, s = concepts.beam("mark"); x, y, side = MARK_BOX
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{x} {y} {side} {side}"><defs>{d}</defs>{s}</svg>'


def favicon_uri():
    return data_uri(beam_tile_svg(rounded_clip=True))


def save(im, path, alpha):
    """Write a PNG - opaque images as RGB, always optimised."""
    (im.convert("RGBA") if alpha else im.convert("RGB")).save(path, optimize=True)


def mask(im, radius):
    """Round a square: radius as a fraction of the side (.5 = circle)."""
    return rounded(im, radius * im.size[0])


def svg_shot(name, svg, w=1024, h=1024):
    p = TMP / f"{name}.svg"; p.write_text(svg)
    return shot(p, TMP / f"{name}.png", w, h)


DENSITIES = [("mdpi", 48, 108), ("hdpi", 72, 162), ("xhdpi", 96, 216), ("xxhdpi", 144, 324), ("xxxhdpi", 192, 432)]

# The TV rail's mark, pre-rendered at the exact pixel size each screen density draws it (React Native picks
# the @Nx file): closed rail 28dp, open rail 36dp (elia, 2026-10-09: "a bit smaller"); @2x is a 1080p panel,
# @4x a 4K one. No runtime rescaling.
TV_MARKS = (("logo-mark", 28), ("logo-mark-open", 36))
TV_SCALES = ((1, ""), (2, "@2x"), (3, "@3x"), (4, "@4x"))

# Every bitmap `install` writes (and nothing else). The sizes are fixed and checked after writing.
INSTALLED = (
    [(WEB / f"icon-{n}.png", n, n) for n in (180, 192, 512)] + [(WEB / "badge-96.png", 96, 96)] +
    [(RES / f"mipmap-{d}/ic_launcher{suf}.png", n, n) for d, a, b in DENSITIES
     for suf, n in (("", a), ("_round", a), ("_background", b), ("_foreground", b))] +
    [(RES / "drawable/banner.png", 320, 180)] +
    [(TV_ASSETS / f"{name}{suf}.png", dp * k, dp * k) for name, dp in TV_MARKS for k, suf in TV_SCALES])

# Text that carries the logo as a data: URI. `install` rewrites the URI in place and nothing around it:
# the favicon <link> in index.html, and every CSS declaration that ends with the comment /* brand:mark */.
FAVICON_RE = re.compile(rb'(<link rel="icon" href=")data:image/svg\+xml,[^"]*(")')
MARK_RE = re.compile(rb'url\("data:image/svg\+xml,[^"]*"\)(?=[^;{}]*;[ \t]*/\* brand:mark \*/)')
URI_FILES = [(WEB / "index.html", FAVICON_RE), (WEB / "css/components.css", MARK_RE),
             (WEB / "admin.html", MARK_RE), (WEB / "browser.html", MARK_RE)]


def install():
    icon = svg_shot("i-icon", beam_icon_svg())
    for n in (180, 192, 512):
        save(icon.resize((n, n), Image.LANCZOS), WEB / f"icon-{n}.png", alpha=False)
    save(svg_shot("i-badge", beam_badge_svg(), 768, 768).resize((96, 96), Image.LANCZOS), WEB / "badge-96.png", alpha=True)

    bg = svg_shot("i-abg", beam_adaptive_bg_svg()); fg = svg_shot("i-afg", beam_adaptive_fg_svg())
    for d, a, b in DENSITIES:
        dst = RES / f"mipmap-{d}"
        small = icon.resize((a, a), Image.LANCZOS)
        save(mask(small, RADIUS), dst / "ic_launcher.png", alpha=True)
        save(mask(small, .5), dst / "ic_launcher_round.png", alpha=True)
        save(bg.resize((b, b), Image.LANCZOS), dst / "ic_launcher_background.png", alpha=False)
        save(fg.resize((b, b), Image.LANCZOS), dst / "ic_launcher_foreground.png", alpha=True)
    banner = svg_shot("i-banner", beam_banner_svg(), 1280, 720)
    save(banner.resize((320, 180), Image.LANCZOS), RES / "drawable/banner.png", alpha=False)
    # The TV nav rail draws this at 28dp (36dp when open): the BARE mark on a transparent square, the same
    # picture the site's `.logo-mark` shows - not the tile (elia, 2026-10-09: "the logo should be just it").
    # Rendered big and brought down, so the gradient edges stay clean at every density.
    mark = svg_shot("i-mark", beam_mark_svg())
    for name, dp in TV_MARKS:
        for k, suf in TV_SCALES:
            n = dp * k
            save(mark.resize((n, n), Image.LANCZOS), TV_ASSETS / f"{name}{suf}.png", alpha=True)

    for path, w, h in INSTALLED:
        im = Image.open(path)
        assert im.size == (w, h), (path, im.size)
        print(f"  {path.relative_to(ROOT).as_posix():<72} {w}x{h}  {path.stat().st_size / 1024:5.1f} KB")

    for path, rx in URI_FILES:
        raw = path.read_bytes()            # bytes: keeps each file's own line endings, adds no BOM
        if rx is FAVICON_RE:
            new, n = rx.subn(lambda m: m.group(1) + favicon_uri().encode() + m.group(2), raw)
        else:
            new, n = rx.subn(lambda m: ('url("' + mark_uri() + '")').encode(), raw)
        if not n:
            print(f"  !! {path.relative_to(ROOT).as_posix()}: logo data URI not found - see docs/brand/README.md")
            continue
        if new != raw:
            path.write_bytes(new)
        print(f"  {path.relative_to(ROOT).as_posix():<72} data URI {'updated' if new != raw else 'up to date'} (x{n})")


def options():
    """beam-background-options.png: yesterday's background and the three intensities, at 512 / 96 / 48 and as the banner."""
    cols = [("old", "Before - near-flat navy")] + [(lv, lv.capitalize()) for lv in concepts.BG_LEVELS]
    pad, cw = 28, 512
    W = pad + len(cols) * (cw + pad)
    S = Image.new("RGB", (W, 1140), "#07080f"); D = ImageDraw.Draw(S)
    D.text((pad, 18), "Beam - background options", font=font(32, True), fill=TEXT)
    D.text((pad, 64), "Violet bloom from the top-left, aurora green from the bottom-right, on the page navy. Per column: 512 px icon; 96 / 48 / 32 px as a "
           "launcher tile and under a round mask, on mid-grey; the 320x180 Android TV banner at actual size.", font=font(17), fill="#9aa1b5")
    for i, (lv, label) in enumerate(cols):
        x, y = pad + i * (cw + pad), 112
        pick = lv == concepts.BG_CHOSEN
        if pick:
            D.rounded_rectangle([x - 12, y - 8, x + cw + 12, 1128], 18, outline="#8cffbe", width=3)
            label += "  -  CHOSEN"
        D.text((x, y), label, font=font(24, True), fill="#8cffbe" if pick else TEXT); y += 44
        icon = svg_shot(f"o-icon-{lv}", beam_old_icon_svg() if lv == "old" else beam_icon_svg(lv))
        paste(S, icon.resize((cw, cw), Image.LANCZOS), (x, y)); y += cw + 16
        D.rectangle([x, y, x + cw, y + 136], fill="#6b6f7a")
        i96, i48 = icon.resize((96, 96), Image.LANCZOS), icon.resize((48, 48), Image.LANCZOS)
        paste(S, mask(i96, RADIUS), (x + 24, y + 20)); paste(S, mask(i96, .5), (x + 140, y + 20))
        paste(S, mask(i48, RADIUS), (x + 280, y + 44)); paste(S, mask(i48, .5), (x + 348, y + 44))
        paste(S, mask(icon.resize((32, 32), Image.LANCZOS), RADIUS), (x + 440, y + 52))
        y += 136
        D.text((x + 24, y + 4), "96", font=font(13), fill="#616880"); D.text((x + 280, y + 4), "48", font=font(13), fill="#616880")
        D.text((x + 440, y + 4), "32", font=font(13), fill="#616880"); y += 30
        D.rectangle([x, y, x + cw, y + 232], fill="#3a3d47")
        b = svg_shot(f"o-banner-{lv}", beam_banner_svg(None if lv == "old" else lv, old=lv == "old"), 1280, 720)
        paste(S, rounded(b.resize((320, 180), Image.LANCZOS), 10), (x + (cw - 320) // 2, y + 26))
    S.save(OUT / "beam-background-options.png", optimize=True)


if __name__ == "__main__":
    args = sys.argv[1:]
    do_install = "install" in args
    names = [a for a in args if a != "install"] or (["beam"] if do_install else list(CONCEPTS))
    for n in names:
        write(n, CONCEPTS[n]); render(n)
    al = list(CONCEPTS)
    if all((OUT / f"{n}-512.png").exists() and (TMP / f"{n}-lockup.png").exists() for n in al):
        sheet(al, TITLES)
    if "beam" in names:
        options()
    print("ok", names)
    if do_install:
        print("installed:")
        install()

# Aurora brand proposal builder.  python docs/brand/tools/build.py
# Writes every SVG in docs/brand from tools/concepts.py, rasterises them with headless Chrome (or Edge)
# and lays out overview.png. PNGs below 1024 px are Lanczos downscales of the 1024 px Chrome render.
import os, subprocess, sys, pathlib
from PIL import Image, ImageDraw, ImageFont

HERE = pathlib.Path(__file__).parent
OUT = HERE.parent                      # docs/brand
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
    (OUT / f"{name}-icon.svg").write_text(SVG.format(w=512, h=512, extra="", body=body))
    md, m = fn("mono")
    (OUT / f"{name}-mono.svg").write_text(SVG.format(w=512, h=512, extra=' color="#f3f4f8"', body=f"  {md}\n  {m}".replace("  \n", "")))
    tile = ic is not None      # a mark that is its own tile sits a little smaller beside the word
    k, off = (.43, 24) if tile else (.5078, concepts.LOCKUP_OFF.get(name, 4))
    wm = wordmark(300, 205, 1.0)
    (OUT / f"{name}-lockup.svg").write_text(SVG.format(w=1030, h=280, extra="",
        body=f'  <defs>{d}</defs>\n  <g transform="translate({20 + (260 - 512 * k) / 2:.1f} {off}) scale({k})">\n  {s}\n  </g>\n  {wm}'))
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


if __name__ == "__main__":
    names = [a for a in sys.argv[1:]] or list(CONCEPTS)
    for n in names:
        write(n, CONCEPTS[n]); render(n)
    al = list(CONCEPTS)
    if all((OUT / f"{n}-512.png").exists() for n in al):
        sheet(al, TITLES)
    print("ok", names)

GREEN = "#46c896"; MINT = "#8cffbe"; CYAN = "#7fd1e8"; VIOLET = "#8b7bff"; DEEP = "#6856e2"
NAVY = "#0b0c14"; LILAC = "#d9d4ff"

KERN = [0, 152, 282, 366, 502, 588]
ICON_SCALE = {"curtain": .80, "beam": .80}


def f(v):
    s = f"{v:.1f}"
    return s[:-2] if s.endswith(".0") else s


def P(pts):
    return " ".join(f"{f(x)} {f(y)}" for x, y in pts)


def grad(i, x1, y1, x2, y2, *stops):
    s = "".join(f'<stop offset="{o}" stop-color="{c}"/>' for o, c in stops)
    return f'\n    <linearGradient id="{i}" gradientUnits="userSpaceOnUse" x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}">{s}</linearGradient>'


def split(p, t0, t1):
    """sub-segment of cubic p (4 points) between t0 and t1"""
    def lerp(a, b, t): return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
    def cut(p, t):
        a, b, c = lerp(p[0], p[1], t), lerp(p[1], p[2], t), lerp(p[2], p[3], t)
        d, e = lerp(a, b, t), lerp(b, c, t)
        m = lerp(d, e, t)
        return [p[0], a, d, m], [m, e, c, p[3]]
    _, right = cut(p, t0)
    left, _ = cut(right, (t1 - t0) / (1 - t0))
    return left


# ------------------------------------------------------------------ 1. CURTAIN
# An A made of two hanging blades of light. The left blade runs the full height
# and owns the apex; the right one tucks in behind it with 15 units of air.
def curtain(kind):
    AP = (262, 58)
    outer = [AP, (228, 190), (152, 350), (52, 448)]
    inner = [(184, 448), (246, 384), (320, 238), AP]            # bottom -> apex
    left = f"M{P([AP])}C{P(outer[1:])}H{f(inner[0][0])}C{P(inner[1:])}Z"
    seg = [(x + 15, y) for x, y in split(inner, .44, .85)]
    right = (f"M{P([seg[3]])}C334 224 398 360 462 448H334C306 412 286 372 {P([seg[0]])}C{P(seg[1:])}Z")
    if kind == "mono":
        return "", f'<path fill="currentColor" d="{left}"/>\n  <path fill="currentColor" d="{right}"/>'
    if kind == "icon":
        return None
    defs = (grad("a", 120, 448, 290, 70, (0, GREEN), (1, MINT)) +
            grad("b", 300, 130, 410, 448, (0, CYAN), (1, VIOLET)) + "\n  ")
    return defs, f'<path fill="url(#a)" d="{left}"/>\n  <path fill="url(#b)" d="{right}"/>'


# ------------------------------------------------------------------ 2. HORIZON
# The aurora seen from orbit, framed by the app's own rounded tile: the planet's
# dark limb, a thin line of atmosphere, the green arc above it, violet sky.
def horizon(kind):
    CY, RP, RI, RO, OFF = 650, 296, 350, 404, 22
    rx = 0 if kind == "icon" else 116
    clip = f'\n    <clipPath id="k"><rect width="512" height="512" rx="{rx}"/></clipPath>\n  '
    if kind == "mono":
        g = 16
        return f"<defs>{clip}</defs>", (
            f'<g clip-path="url(#k)" fill="currentColor">\n'
            f'    <path fill-rule="evenodd" d="M0 0H512V512H0ZM{256-RO-g} {CY-OFF}A{RO+g} {RO+g} 0 1 0 {256+RO+g} {CY-OFF}A{RO+g} {RO+g} 0 1 0 {256-RO-g} {CY-OFF}Z"/>\n'
            f'    <path fill-rule="evenodd" d="M{256-RO} {CY-OFF}A{RO} {RO} 0 1 0 {256+RO} {CY-OFF}A{RO} {RO} 0 1 0 {256-RO} {CY-OFF}ZM{256-RI} {CY}A{RI} {RI} 0 1 0 {256+RI} {CY}A{RI} {RI} 0 1 0 {256-RI} {CY}Z"/>\n'
            f'    <circle cx="256" cy="{CY}" r="{RP+8}"/>\n  </g>')
    defs = (grad("s", 0, 0, 0, 512, (0, "#15153a"), (".34", "#4337b4"), (".6", DEEP)) + grad("p", 0, 360, 0, 512, (0, "#2b2a6a"), (1, "#15162f")) +
            grad("a", 0, 0, 512, 0, (0, GREEN), (".42", MINT), (".72", CYAN), (1, VIOLET)) + clip)
    shapes = (f'<g clip-path="url(#k)">\n'
              f'    <rect width="512" height="512" fill="url(#s)"/>\n'
              f'    <circle cx="256" cy="{CY-OFF}" r="{RO}" fill="url(#a)"/>\n'
              f'    <circle cx="256" cy="{CY}" r="{RI}" fill="#0d0d22"/>\n'
              f'    <circle cx="256" cy="{CY}" r="{RP+8}" fill="{LILAC}"/>\n'
              f'    <circle cx="256" cy="{CY+5}" r="{RP+4}" fill="url(#p)"/>\n  </g>')
    return defs, shapes


# ------------------------------------------------------------------ 3. BEAM
# A play triangle made of three bands of light, parted by the curtain's wavy hem.
def beam(kind):
    tri = "M136 122A34 34 0 0 1 187 92.6L425 227A34 34 0 0 1 425 285L187 419.4A34 34 0 0 1 136 390Z"
    def wave(dy):   # one S-curve, moved straight down by dy
        k = dy / 114   # 0 for the upper hem, 1 for the lower: the lower one climbs more, so the bands converge on the tip
        return [(96, 240 + dy), (214, 292 + dy), (288, 190 + dy - 30 * k), (480, 226 + dy - 44 * k)]
    def above(dy):
        w = wave(dy); return f"M{P(w[:1])}C{P(w[1:])}V60H96Z"
    def between(d0, d1):
        a, b = wave(d0), wave(d1)[::-1]; return f"M{P(a[:1])}C{P(a[1:])}V{f(b[0][1])}C{P(b[1:])}Z"
    def below(dy):
        w = wave(dy); return f"M{P(w[:1])}C{P(w[1:])}V452H96Z"
    G, STEP = 20, 94
    top, mid, bot = above(0), between(G, STEP), below(STEP + G)
    clip = f'\n    <clipPath id="k"><path d="{tri}"/></clipPath>\n  '
    if kind == "mono":
        return f"<defs>{clip}</defs>", (f'<g clip-path="url(#k)" fill="currentColor">\n    <path d="{top}"/>\n    <path d="{mid}"/>\n    <path d="{bot}"/>\n  </g>')
    if kind == "icon":
        return None
    defs = (grad("a", 140, 250, 400, 110, (0, GREEN), (1, MINT)) +
            grad("b", 136, 0, 440, 0, (0, "#5fc4d8"), (1, "#9be4f2")) +
            grad("c", 140, 430, 390, 300, (0, DEEP), (1, VIOLET)) + clip)
    return defs, (f'<g clip-path="url(#k)">\n    <path fill="url(#a)" d="{top}"/>\n    <path fill="url(#b)" d="{mid}"/>\n'
                  f'    <path fill="url(#c)" d="{bot}"/>\n  </g>')


CONCEPTS = {"curtain": curtain, "horizon": horizon, "beam": beam}
TITLES = ["1. Curtain", "2. Horizon", "3. Beam"]
LOCKUP_OFF = {"curtain": -15}

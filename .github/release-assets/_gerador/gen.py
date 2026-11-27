#!/usr/bin/env python3
"""Gera os SVG da release no tema VOR (Zenith): preto #151515, glass branco, acento branco sólido."""
import re, pathlib
ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "assets"; OUT.mkdir(exist_ok=True)
REPO = pathlib.Path("/workspace/swiftwheel")
SI = pathlib.Path("/tmp/si/package/icons")

def path_of(name):
    return re.search(r'<path d="([^"]+)"', (SI / f"{name}.svg").read_text()).group(1)
APPLE, LINUX = path_of("apple"), path_of("linux")

def logo(x, y, size, pfx="lg"):
    s = (REPO / "public/logo.svg").read_text()
    s = re.sub(r'<!--.*?-->', '', s, flags=re.S)
    inner = re.search(r'<svg[^>]*>(.*)</svg>', s, re.S).group(1)
    for i in ("bg", "tl", "cur", "sh"):
        inner = inner.replace(f'id="{i}"', f'id="{pfx}{i}"').replace(f'url(#{i})', f'url(#{pfx}{i})')
    return f'<svg x="{x}" y="{y}" width="{size}" height="{size}" viewBox="0 0 512 512">{inner}</svg>'

# Anel de 8 segmentos do logo, para decoração em linha fina.
SEGS = re.findall(r'<path d="(M[^"]+Z)"', (REPO / "public/logo.svg").read_text())[:8]

FONT_D = "Space Grotesk"; FONT_UI = "Inter"
T1, T2, T3 = "rgba(255,255,255,.93)", "rgba(255,255,255,.58)", "rgba(255,255,255,.38)"

def win_glyph(x, y, s, fill):
    g = s * 0.08; c = (s - g) / 2
    return "".join(f'<rect x="{x+dx}" y="{y+dy}" width="{c}" height="{c}" rx="{s*0.04}" fill="{fill}"/>'
                   for dx in (0, c + g) for dy in (0, c + g))

def si_glyph(d, x, y, s, fill):
    return f'<path transform="translate({x} {y}) scale({s/24})" d="{d}" fill="{fill}"/>'

def glass_defs(pfx):
    return f'''
    <linearGradient id="{pfx}g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#262626"/><stop offset="1" stop-color="#161616"/></linearGradient>
    <linearGradient id="{pfx}hl" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity=".10"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient>'''

# ── Banner ──────────────────────────────────────────────────────────────
def tile(x, y, s, kind, lift=0):
    y -= lift
    body = f'<rect x="{x}" y="{y}" width="{s}" height="{s}" rx="{s*0.26}" fill="url(#tile)"/>' \
           f'<rect x="{x+.5}" y="{y+.5}" width="{s-1}" height="{s-1}" rx="{s*0.26}" fill="none" stroke="#fff" stroke-opacity=".10"/>'
    cx, cy = x + s/2, y + s/2
    if kind == "logo":
        return logo(x, y, s, "dk")
    if kind == "folder":
        body += f'<path d="M{x+s*.24} {y+s*.34} h{s*.18} l{s*.06} {s*.07} h{s*.28} v{s*.33} h-{s*.52}z" fill="#d9d9d9"/>'
    elif kind == "web":
        body += f'<circle cx="{cx}" cy="{cy}" r="{s*.23}" fill="none" stroke="#d9d9d9" stroke-width="{s*.05}"/>' \
                f'<ellipse cx="{cx}" cy="{cy}" rx="{s*.10}" ry="{s*.23}" fill="none" stroke="#d9d9d9" stroke-width="{s*.04}"/>' \
                f'<line x1="{cx-s*.23}" y1="{cy}" x2="{cx+s*.23}" y2="{cy}" stroke="#d9d9d9" stroke-width="{s*.04}"/>'
    elif kind == "term":
        body += f'<path d="M{x+s*.27} {y+s*.36} l{s*.13} {s*.13} l-{s*.13} {s*.13}" fill="none" stroke="#d9d9d9" stroke-width="{s*.06}" stroke-linecap="round" stroke-linejoin="round"/>' \
                f'<line x1="{x+s*.48}" y1="{y+s*.64}" x2="{x+s*.72}" y2="{y+s*.64}" stroke="#d9d9d9" stroke-width="{s*.06}" stroke-linecap="round"/>'
    elif kind == "code":
        body += f'<path d="M{x+s*.38} {y+s*.33} l-{s*.15} {s*.17} l{s*.15} {s*.17} M{x+s*.62} {y+s*.33} l{s*.15} {s*.17} l-{s*.15} {s*.17}" fill="none" stroke="#d9d9d9" stroke-width="{s*.06}" stroke-linecap="round" stroke-linejoin="round"/>'
    elif kind == "music":
        body += f'<path d="M{x+s*.42} {y+s*.66} v-{s*.36} l{s*.26} -{s*.06} v{s*.36}" fill="none" stroke="#d9d9d9" stroke-width="{s*.055}" stroke-linejoin="round"/>' \
                f'<circle cx="{x+s*.36}" cy="{y+s*.67}" r="{s*.075}" fill="#d9d9d9"/><circle cx="{x+s*.62}" cy="{y+s*.61}" r="{s*.075}" fill="#d9d9d9"/>'
    elif kind == "chat":
        body += f'<path d="M{x+s*.26} {y+s*.30} h{s*.48} a{s*.06} {s*.06} 0 0 1 {s*.06} {s*.06} v{s*.24} a{s*.06} {s*.06} 0 0 1 -{s*.06} {s*.06} h-{s*.30} l-{s*.12} {s*.10} v-{s*.10} h-{s*.06} a{s*.06} {s*.06} 0 0 1 -{s*.06} -{s*.06} v-{s*.24} a{s*.06} {s*.06} 0 0 1 {s*.06} -{s*.06}z" fill="#d9d9d9"/>'
    return body

def banner():
    W, H = 1280, 400
    ring = "".join(f'<path d="{d}" fill="none" stroke="#fff" stroke-opacity="{.05 + .012*i}" stroke-width="2.2" stroke-linejoin="round"/>' for i, d in enumerate(SEGS))
    # pílula da Dock
    s, gap, pad = 52, 12, 12
    kinds = ["logo", "folder", "web", "term", "code", "music", "chat"]
    pw = pad*2 + len(kinds)*s + (len(kinds)-1)*gap + 118
    px, py = W - 64 - pw, 284
    ph = s + pad*2
    tiles, dots = "", ""
    for i, k in enumerate(kinds):
        tx = px + pad + i*(s+gap); lift = 10 if i == 2 else 0
        tiles += tile(tx, py + pad, s, k, lift)
        if i in (0, 2, 3):
            dots += f'<rect x="{tx + s/2 - (7 if i==2 else 3)}" y="{py+ph-6}" width="{14 if i==2 else 6}" height="3" rx="1.5" fill="#fff" fill-opacity="{.9 if i==2 else .45}"/>'
    lx = px + pad + 2*(s+gap) + s/2
    tip = f'''<g><rect x="{lx-44}" y="{py-48}" width="88" height="28" rx="14" fill="#fff"/>
      <text x="{lx}" y="{py-29.5}" text-anchor="middle" font-family="{FONT_UI}" font-size="13" font-weight="600" fill="#0a0a0b">↑ 6 px</text></g>'''
    sep_x = px + pad + len(kinds)*(s+gap) - gap/2 + 6
    tray = f'''<line x1="{sep_x}" y1="{py+18}" x2="{sep_x}" y2="{py+ph-18}" stroke="#fff" stroke-opacity=".13"/>
      <text x="{sep_x+60}" y="{py+ph/2-2}" text-anchor="middle" font-family="{FONT_D}" font-size="20" font-weight="600" fill="{T1}">09:45</text>
      <text x="{sep_x+60}" y="{py+ph/2+18}" text-anchor="middle" font-family="{FONT_UI}" font-size="12" fill="{T3}">27/11/2026</text>'''
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">
  <defs>
    <linearGradient id="bgl" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1d1d1d"/><stop offset=".55" stop-color="#151515"/><stop offset="1" stop-color="#0d0d0d"/></linearGradient>
    <radialGradient id="glow" cx=".12" cy="0" r=".8"><stop offset="0" stop-color="#fff" stop-opacity=".09"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
    <radialGradient id="glow2" cx=".82" cy=".55" r=".45"><stop offset="0" stop-color="#fff" stop-opacity=".06"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
    <linearGradient id="tile" x1="0" y1="0" x2=".3" y2="1"><stop offset="0" stop-color="#4a4a4a"/><stop offset=".5" stop-color="#2c2c2c"/><stop offset="1" stop-color="#1b1b1b"/></linearGradient>
    <linearGradient id="pill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a2a2a" stop-opacity=".92"/><stop offset="1" stop-color="#151515" stop-opacity=".92"/></linearGradient>
    <filter id="elev" x="-20%" y="-60%" width="140%" height="240%"><feDropShadow dx="0" dy="12" stdDeviation="16" flood-color="#000" flood-opacity=".55"/></filter>
    <clipPath id="card"><rect width="{W}" height="{H}" rx="24"/></clipPath>
  </defs>
  <g clip-path="url(#card)">
    <rect width="{W}" height="{H}" fill="url(#bgl)"/>
    <rect width="{W}" height="{H}" fill="url(#glow)"/>
    <rect width="{W}" height="{H}" fill="url(#glow2)"/>
    <g transform="translate(1010 150) scale(1.55) translate(-256 -256)">{ring}</g>
    <circle cx="1010" cy="150" r="190" fill="none" stroke="#fff" stroke-opacity=".035"/>
    <circle cx="1010" cy="150" r="330" fill="none" stroke="#fff" stroke-opacity=".03"/>
  </g>
  <rect x=".5" y=".5" width="{W-1}" height="{H-1}" rx="23.5" fill="none" stroke="#fff" stroke-opacity=".10"/>

  {logo(72, 72, 88)}
  <text x="72" y="236" font-family="{FONT_D}" font-size="68" font-weight="600" letter-spacing="-2" fill="{T1}">SwiftWheel<tspan dx="16" fill="{T3}" font-weight="500">0.2.17</tspan></text>
  <text x="74" y="278" font-family="{FONT_UI}" font-size="21" fill="{T2}">O SwiftWheel agora tem uma Dock própria no Windows.</text>
  <g>
    <rect x="72" y="310" width="168" height="38" rx="19" fill="#fff"/>
    <text x="156" y="335" text-anchor="middle" font-family="{FONT_UI}" font-size="15" font-weight="650" fill="#0a0a0b">Módulo Dock</text>
    <rect x="252.5" y="310.5" width="135" height="37" rx="18.5" fill="#fff" fill-opacity=".06" stroke="#fff" stroke-opacity=".16"/>
    <circle cx="272" cy="329" r="4" fill="#fff" fill-opacity=".7"/>
    <text x="330" y="335" text-anchor="middle" font-family="{FONT_UI}" font-size="15" font-weight="550" fill="{T2}">Pré-release</text>
  </g>

  <g filter="url(#elev)"><rect x="{px}" y="{py}" width="{pw}" height="{ph}" rx="{ph/2}" fill="url(#pill)"/></g>
  <rect x="{px+.5}" y="{py+.5}" width="{pw-1}" height="{ph-1}" rx="{ph/2}" fill="none" stroke="#fff" stroke-opacity=".13"/>
  {tiles}{dots}{tip}{tray}
</svg>'''

# ── Botões ──────────────────────────────────────────────────────────────
def arrow(cx, cy, r, bg, fg):
    return f'''<circle cx="{cx}" cy="{cy}" r="{r}" fill="{bg}"/>
      <path d="M{cx} {cy-7} v13 M{cx-6} {cy+1} l6 6 l6 -6" fill="none" stroke="{fg}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>'''

def btn_primary():
    W, H = 560, 84
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">
  <defs><linearGradient id="p" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#e9e9e9"/></linearGradient></defs>
  <rect width="{W}" height="{H}" rx="20" fill="url(#p)"/>
  <rect x=".5" y=".5" width="{W-1}" height="{H-1}" rx="19.5" fill="none" stroke="#000" stroke-opacity=".08"/>
  <rect x="18" y="18" width="48" height="48" rx="13" fill="#0a0a0b"/>
  {win_glyph(30, 30, 24, "#fff")}
  <text x="84" y="39" font-family="{FONT_D}" font-size="22" font-weight="600" letter-spacing="-.4" fill="#0a0a0b">Baixar SwiftWheel para Windows</text>
  <text x="84" y="61" font-family="{FONT_UI}" font-size="14" fill="rgba(0,0,0,.55)">Instalador .exe · 96 MB · inclui o módulo Dock</text>
  {arrow(W-42, H/2, 20, "#0a0a0b", "#fff")}
</svg>'''

def btn_secondary(glyph, title, sub, pfx):
    W, H = 272, 68
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">
  <defs>{glass_defs(pfx)}</defs>
  <rect width="{W}" height="{H}" rx="17" fill="url(#{pfx}g)"/>
  <rect width="{W}" height="{H}" rx="17" fill="url(#{pfx}hl)"/>
  <rect x=".5" y=".5" width="{W-1}" height="{H-1}" rx="16.5" fill="none" stroke="#fff" stroke-opacity=".13"/>
  <rect x="14" y="14" width="40" height="40" rx="11" fill="#fff" fill-opacity=".07"/>
  {glyph}
  <text x="68" y="31" font-family="{FONT_UI}" font-size="15" font-weight="600" fill="{T1}">{title}</text>
  <text x="68" y="50" font-family="{FONT_UI}" font-size="12.5" fill="{T3}">{sub}</text>
  {arrow(W-30, H/2, 14, "rgba(255,255,255,.08)", "rgba(255,255,255,.8)")}
</svg>'''

def buttons():
    ap = lambda: si_glyph(APPLE, 23, 22, 22, "#f2f2f2")
    lx = lambda: si_glyph(LINUX, 23, 22, 22, "#f2f2f2")
    return {
        "btn-windows": btn_primary(),
        "btn-macos-arm64": btn_secondary(ap(), "macOS · Apple Silicon", "SwiftWheel .dmg · 122 MB", "a"),
        "btn-macos-x64": btn_secondary(ap(), "macOS · Intel", "SwiftWheel .dmg · 126 MB", "b"),
        "btn-linux-appimage": btn_secondary(lx(), "Linux · AppImage", "SwiftWheel · 145 MB", "c"),
        "btn-linux-deb": btn_secondary(lx(), "Linux · .deb", "SwiftWheel · 92 MB", "d"),
    }

# ── Card de novidades ───────────────────────────────────────────────────
def ico(kind, x, y):
    st = 'fill="none" stroke="#e6e6e6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
    c = {
      "pill": f'<rect x="{x+3}" y="{y+13}" width="26" height="10" rx="5" {st}/><circle cx="{x+10}" cy="{y+18}" r="1.6" fill="#e6e6e6"/><circle cx="{x+16}" cy="{y+18}" r="1.6" fill="#e6e6e6"/><circle cx="{x+22}" cy="{y+18}" r="1.6" fill="#e6e6e6"/>',
      "lift": f'<rect x="{x+9}" y="{y+12}" width="14" height="14" rx="4" {st}/><path d="M{x+16} {y+8} v-4 M{x+12.5} {y+7.5} l3.5 -3.5 l3.5 3.5" {st}/>',
      "fast": f'<path d="M{x+18} {y+3} l-10 15 h8 l-2 11 l10 -15 h-8z" {st}/>',
      "tray": f'<circle cx="{x+16}" cy="{y+16}" r="11" {st}/><path d="M{x+16} {y+10} v6 l4 3" {st}/>',
      "multi": f'<rect x="{x+2}" y="{y+7}" width="16" height="12" rx="2.5" {st}/><rect x="{x+14}" y="{y+12}" width="16" height="12" rx="2.5" {st}/>',
      "safe": f'<path d="M{x+16} {y+3} l10 4 v8 c0 7 -5 11 -10 13 c-5 -2 -10 -6 -10 -13 v-8z" {st}/><path d="M{x+11.5} {y+16} l3 3 l6 -6" {st}/>',
    }
    return c[kind]

def features():
    items = [
        ("pill", "Dock do SwiftWheel", "Pílula no tema VOR no lugar", "da barra de tarefas do Windows."),
        ("lift", "Ícones sobem 6 px", "Levantadinha no hover, com", "magnificação opcional."),
        ("fast", "Some em 150 ms", "Auto-hide rápido ao tirar", "o mouse, configurável."),
        ("tray", "Mini bandeja", "Relógio, volume, rede, bateria e", "notificações dentro do SwiftWheel."),
        ("multi", "Multi-monitor", "Segue o ponteiro ou fica no", "principal. Embaixo ou nas laterais."),
        ("safe", "Desliga sem susto", "A barra do Windows volta na hora,", "mesmo se o SwiftWheel travar."),
    ]
    W, cols, cw, ch, g, top = 1120, 3, 352, 132, 16, 76
    H = top + 2*ch + g + 24
    cards = ""
    for i, (k, t, l1, l2) in enumerate(items):
        x = 24 + (i % cols)*(cw+g); y = top + (i//cols)*(ch+g)
        cards += f'''<rect x="{x}" y="{y}" width="{cw}" height="{ch}" rx="16" fill="#fff" fill-opacity=".035"/>
      <rect x="{x+.5}" y="{y+.5}" width="{cw-1}" height="{ch-1}" rx="15.5" fill="none" stroke="#fff" stroke-opacity=".08"/>
      <rect x="{x+20}" y="{y+20}" width="40" height="40" rx="11" fill="#fff" fill-opacity=".07"/>
      {ico(k, x+24, y+24)}
      <text x="{x+76}" y="{y+46}" font-family="{FONT_UI}" font-size="16.5" font-weight="600" fill="{T1}">{t}</text>
      <text x="{x+20}" y="{y+90}" font-family="{FONT_UI}" font-size="14" fill="{T2}">{l1}</text>
      <text x="{x+20}" y="{y+111}" font-family="{FONT_UI}" font-size="14" fill="{T2}">{l2}</text>'''
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b1b1b"/><stop offset="1" stop-color="#121212"/></linearGradient></defs>
  <rect width="{W}" height="{H}" rx="22" fill="url(#bg)"/>
  <rect x=".5" y=".5" width="{W-1}" height="{H-1}" rx="21.5" fill="none" stroke="#fff" stroke-opacity=".10"/>
  <text x="24" y="50" font-family="{FONT_UI}" font-size="12.5" font-weight="600" letter-spacing="1.4" fill="{T3}">NOVIDADES DO SWIFTWHEEL 0.2.17 · MÓDULO DOCK</text>
  <text x="{W-24}" y="50" text-anchor="end" font-family="{FONT_UI}" font-size="13" fill="{T3}">Issue #53 · PR #57</text>
  {cards}
</svg>'''

files = {"banner": banner(), "novidades": features(), **buttons()}
for name, svg in files.items():
    (OUT / f"{name}.svg").write_text(svg)
print(" ".join(files))

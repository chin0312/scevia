"""Build web icons from the brand marks. Run from the repo root: python3 design-system/brand/make-icons.py
Background = canvas token (--color-bg-canvas, neutral.1000) so the white mark reads in dark tabs and light tabs alike."""
import json
from PIL import Image, ImageDraw

tokens = json.load(open('design-system/tokens/tokens.json'))
CANVAS = tokens['primitive']['color']['neutral']['1000']['$value']

def rgb(h):
    h = h.lstrip('#'); return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))

mark = Image.open('design-system/brand/scevia-mark-on-dark.png').convert('RGBA')
mark = mark.crop(mark.getchannel('A').getbbox())

def icon(size, pad=0.16, radius=0.22):
    im = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(im).rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * radius), fill=rgb(CANVAS) + (255,))
    inner = int(size * (1 - 2 * pad))
    m = mark.copy(); m.thumbnail((inner, inner), Image.LANCZOS)
    im.alpha_composite(m, ((size - m.width) // 2, (size - m.height) // 2))
    return im

out = 'web/public'
icon(512).save(f'{out}/icon-512.png')
icon(192).save(f'{out}/icon-192.png')
icon(180, radius=0).save(f'{out}/apple-touch-icon.png')
icon(32).save(f'{out}/favicon-32.png')
icon(48).save(f'{out}/favicon.ico', sizes=[(16, 16), (32, 32), (48, 48)])
print('icons written')

#!/usr/bin/env python3
"""Genera Assets/glyph_metrics.json con datos de Pillow/FreeType que la web
usa para medir texto exactamente igual que escritorio.

Para cada fuente y cada tamaño en píxeles (1..MAX_PX) guarda:
  [ascent, descent, top_A, bottom_A]
- ascent, descent: font.getmetrics() (FreeType redondea con su aritmética
  de punto fijo; la tabla evita diferencias de 1 px).
- top_A, bottom_A: font.getbbox('A') (con hinting). renderer.text_centered_y()
  centra todo el texto de la UI con estos valores.

Uso: python3 tools/make_glyph_metrics.py      (requiere Pillow)
"""
import json
import os

from PIL import ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONTS = [
    "NotoSans-Regular.ttf",
    "DejaVuSansMono.ttf",
    "NotoSansArabic-Regular.ttf",
    "NotoSansJP-Regular.ttf",
]
MAX_PX = 600


def main():
    out = {"max_px": MAX_PX, "fonts": {}}
    for name in FONTS:
        path = os.path.join(ROOT, "Assets", name)
        table = [None]  # índice 0 sin uso
        for px in range(1, MAX_PX + 1):
            font = ImageFont.truetype(path, px)
            asc, desc = font.getmetrics()
            _left, top, _right, bottom = font.getbbox("A")
            table.append([asc, desc, top, bottom])
        out["fonts"][name] = table
        print(name, "ok")
    dst = os.path.join(ROOT, "Assets", "glyph_metrics.json")
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"-> {dst} ({os.path.getsize(dst)} bytes)")


if __name__ == "__main__":
    main()

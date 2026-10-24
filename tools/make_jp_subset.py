#!/usr/bin/env python3
"""Genera Assets/NotoSansJP-Subset.otf con los caracteres CJK de la UI.

La web carga este subset al inicio. Si aparece un carácter CJK que no está
en el subset (por ejemplo, escrito en un comentario del código), la web baja
NotoSansJP-Regular.ttf completo en segundo plano.

Rango CJK = el mismo que usa _font_for_char(): cp >= 0x3000 o 0x4E00..0x9FFF.
Fuentes de caracteres: todos los lang/*.json y los textos fijos de js/*.js.

Uso: python3 tools/make_jp_subset.py      (requiere fonttools)
"""
import glob
import json
import os

from fontTools import subset

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "Assets", "NotoSansJP-Regular.ttf")
DST = os.path.join(ROOT, "Assets", "NotoSansJP-Subset.otf")


def is_cjk(cp):
    return cp >= 0x3000 or 0x4E00 <= cp <= 0x9FFF


def main():
    chars = set()
    for path in glob.glob(os.path.join(ROOT, "lang", "*.json")):
        if os.path.basename(path) == "index.json":
            continue
        with open(path, encoding="utf-8") as f:
            for value in json.load(f).values():
                if isinstance(value, str):
                    chars.update(value)
    for path in glob.glob(os.path.join(ROOT, "js", "*.js")):
        with open(path, encoding="utf-8") as f:
            chars.update(f.read())

    codepoints = sorted(ord(c) for c in chars if is_cjk(ord(c)))

    options = subset.Options()
    options.layout_features = ["*"]
    options.name_IDs = ["*"]
    options.notdef_outline = True
    options.glyph_names = False
    options.hinting = True
    options.desubroutinize = False

    font = subset.load_font(SRC, options)
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=codepoints)
    subsetter.subset(font)
    subset.save_font(font, DST, options)
    print(f"{len(codepoints)} caracteres -> {DST} ({os.path.getsize(DST)} bytes)")


if __name__ == "__main__":
    main()

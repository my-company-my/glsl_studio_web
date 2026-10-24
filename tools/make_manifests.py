#!/usr/bin/env python3
"""Genera lang/index.json y Themes/index.json.

Escritorio lista las carpetas lang/ y Themes/ con os.listdir(). Un sitio
estático no puede listar carpetas, así que la web lee estos índices.
Correr este script después de agregar o quitar un idioma o un tema.

Uso: python3 tools/make_manifests.py
"""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def write(path, items):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)
    print(f"{path}: {items}")


def main():
    langs = sorted(f[:-5] for f in os.listdir(os.path.join(ROOT, "lang"))
                   if f.endswith(".json") and f != "index.json")
    write(os.path.join(ROOT, "lang", "index.json"), langs)

    themes = sorted(f for f in os.listdir(os.path.join(ROOT, "Themes"))
                    if f.lower().endswith(".glst"))
    write(os.path.join(ROOT, "Themes", "index.json"), themes)


if __name__ == "__main__":
    main()

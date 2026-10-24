# GLSL Studio Web

> Versión web de [GLSL Studio](https://github.com/my-company-my/glsl_studio): editor visual de shaders GLSL con sistema de nodos y preview en tiempo real.
> Web version of GLSL Studio: visual GLSL shader editor with node graph system and real-time preview.

---

## Español

### ¿Qué es?

Es el mismo GLSL Studio de escritorio, portado 1:1 al navegador con WebGL2 y JavaScript puro (sin build). La interfaz, los nodos, el compilador/descompilador de grafos, los temas, los idiomas, el formato `.glss` y la exportación funcionan igual que en escritorio.

### Requisitos

- Un navegador moderno con **WebGL2** (probado en Chromium).
- Video como iChannel0 y exportar video: navegador con **WebCodecs** (Chrome/Edge 94+, Safari 16.4+, Firefox 130+ de escritorio; Firefox para Android no lo tiene).

### Ejecución

La página usa módulos ES y `fetch`, así que necesita un servidor HTTP (abrir `index.html` con `file://` no funciona):

```bash
git clone <url-del-repo>
cd glsl_studio_web
python3 -m http.server 8000
# abrir http://localhost:8000
```

Para publicarla con **GitHub Pages**: *Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)`*.

### Atajos de teclado

`Cmd` es `Ctrl` en Windows/Linux.

| Atajo | Acción |
|---|---|
| `F1` | Vista de código (editor de texto) |
| `F2` | Vista de nodos |
| `Cmd+S` | Guardar: modo nodos → `proyecto.glss`; modo texto → archivo abierto o `shader.frag` |
| `Cmd+Shift+S` | Descargar el archivo actual (solo web) |
| `Cmd+L` | Cargar grafo de nodos (`proyecto.glss`) |
| `Alt+T` | Abrir selector de temas (en escritorio es `Cmd+T`; el navegador usa `Cmd+T` para abrir pestañas) |
| `Cmd+Shift+L` | Abrir selector de idioma |
| `Cmd+E` | Opciones de exportación |
| `Cmd+=` / `Cmd+-` / `Cmd+0` | Tamaño de fuente |

En el editor de nodos:

| Atajo | Acción |
|---|---|
| `A` | Menú para agregar nodo |
| `F` | Con nodo seleccionado: enfocarlo. Sin selección: ajustar todo |
| `+` / `=` / `-` | Zoom (un paso, centrado en el mouse) |
| `Cmd+D` / `Shift+D` | Duplicar nodo (+40 / +100) |
| `Cmd+C` / `Cmd+V` | Copiar nodo / pegar en el mouse |
| `P` | Propiedades del nodo |
| `S` / `T` / `H` | Link seleccionado: ir al origen / ir al destino / resaltar camino |
| `Supr` / `Retroceso` | Borrar nodo o link seleccionado |
| `Espacio` | Play/pausa del video |
| `Esc` | Cerrar menú/panel, quitar selección y resaltado |

Pantallas táctiles: tocar = clic, mantener = clic derecho, dos dedos = mover/zoom (nodos) o scroll (texto). El teclado en pantalla solo aparece al tocar el editor de texto.

### Archivos

- **Guardar/cargar** (`Cmd+S` / `Cmd+L`) usa una carpeta interna del navegador (IndexedDB). Para sacar un archivo usa `Cmd+Shift+S`.
- **Abrir**: arrastra y suelta sobre la ventana un `.glss` (grafo), un `.glst` (tema), un shader de texto, una imagen (`png`, `jpg`, `bmp`, `gif`, `tga`, `webp`) o un video (`mp4`, `webm`, `mov`, `mkv`; el codec debe estar en el navegador. `avi` no se puede leer en la web).
- **Exportar** (`Cmd+E`) descarga `export.png` o `export.mp4`.
- Idioma y tema (también un tema externo soltado) se guardan en el navegador (`localStorage`).

### Diferencias con escritorio

- Los shaders son **GLSL ES 3.00**: el código empieza con `#version 300 es` y `precision highp float;`. Un shader de escritorio con `#version 330` se convierte al abrirlo.
- El video se exporta en MP4 con H.264 (o VP9/AV1 si el navegador no tiene H.264); escritorio usa `mp4v`. Los navegadores no decodifican `mp4v`, así que un video exportado por escritorio no se puede usar como iChannel0 en la web.
- Los mensajes de error de compilación vienen del driver de GPU del navegador, así que su texto es distinto al de escritorio.
- `Cmd+Q` no hace nada (una página no puede cerrar su pestaña).

### Estructura del proyecto

```
glsl_studio_web/
├── index.html              # Página (canvas + textarea para teclado/IME)
├── js/
│   ├── main.js             # Entrada: eventos del navegador → callbacks tipo GLFW
│   ├── app.js              # App: bucle principal y UI (app.py)
│   ├── editor.js           # Editor de texto (editor.py)
│   ├── renderer.js         # Renderizador WebGL2, atlas de glifos, video (renderer.py)
│   ├── fontinfo.js         # Lectura de fuentes TrueType/OpenType (métricas como FreeType)
│   ├── node_editor.js      # Vista del editor de nodos (node_editor.py)
│   ├── nodes.js            # Tipos de nodos, compilador y descompilador (nodes.py)
│   ├── menu_system.js      # Sistema de menús (menu_system.py)
│   ├── syntax.js           # Resaltado de sintaxis (syntax.py)
│   ├── theme.js            # Temas (theme.py)
│   ├── file_mngr.js        # Formato .glss (file_mngr.py)
│   ├── lang.js             # i18n (lang.py)
│   ├── storage.js          # IndexedDB, localStorage y descargas
│   ├── glfw.js             # Constantes y teclas de GLFW
│   └── pyutil.js           # Semántica de Python (format, round, str, set...)
├── lang/                   # Traducciones (+ index.json)
├── Themes/                 # Temas (+ index.json)
├── Assets/                 # Fuentes y glyph_metrics.json
├── test_assets/            # Textura iChannel0 por defecto
├── vendor/mediabunny/      # Mediabunny (lectura/escritura de video)
└── tools/                  # Scripts para regenerar archivos (Python)
```

### Herramientas

- `python3 tools/make_manifests.py`: regenera `lang/index.json` y `Themes/index.json` (después de agregar un idioma o tema).
- `python3 tools/make_jp_subset.py`: regenera `Assets/NotoSansJP-Subset.otf` con los caracteres CJK de la UI (requiere `fonttools`). Si falta un carácter, la web carga la fuente completa.
- `python3 tools/make_glyph_metrics.py`: regenera `Assets/glyph_metrics.json` (requiere `Pillow`).

---

## English

### What is it?

It is the same desktop GLSL Studio, ported 1:1 to the browser with WebGL2 and plain JavaScript (no build). The UI, nodes, graph compiler/decompiler, themes, languages, the `.glss` format and export work the same as on desktop.

### Requirements

- A modern browser with **WebGL2** (tested on Chromium).
- Video as iChannel0 and video export: a browser with **WebCodecs** (Chrome/Edge 94+, Safari 16.4+, desktop Firefox 130+; Firefox for Android does not have it).

### Running

The page uses ES modules and `fetch`, so it needs an HTTP server (opening `index.html` with `file://` does not work):

```bash
git clone <repo-url>
cd glsl_studio_web
python3 -m http.server 8000
# open http://localhost:8000
```

To publish it with **GitHub Pages**: *Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)`*.

### Keyboard Shortcuts

`Cmd` is `Ctrl` on Windows/Linux.

| Shortcut | Action |
|---|---|
| `F1` | Code view (text editor) |
| `F2` | Node graph view |
| `Cmd+S` | Save: node mode → `proyecto.glss`; text mode → open file or `shader.frag` |
| `Cmd+Shift+S` | Download the current file (web only) |
| `Cmd+L` | Load node graph (`proyecto.glss`) |
| `Alt+T` | Open theme picker (desktop uses `Cmd+T`; the browser uses `Cmd+T` for new tabs) |
| `Cmd+Shift+L` | Open language picker |
| `Cmd+E` | Export options |
| `Cmd+=` / `Cmd+-` / `Cmd+0` | Font size |

In the node editor:

| Shortcut | Action |
|---|---|
| `A` | Add-node menu |
| `F` | With a selected node: focus it. No selection: fit all |
| `+` / `=` / `-` | Zoom (one step, centered on the mouse) |
| `Cmd+D` / `Shift+D` | Duplicate node (+40 / +100) |
| `Cmd+C` / `Cmd+V` | Copy node / paste at the mouse |
| `P` | Node properties |
| `S` / `T` / `H` | Selected link: go to source / go to target / highlight path |
| `Del` / `Backspace` | Delete selected node or link |
| `Space` | Play/pause video |
| `Esc` | Close menu/panel, clear selection and highlight |

Touch screens: tap = click, long press = right click, two fingers = pan/zoom (nodes) or scroll (text). The on-screen keyboard only shows when you tap the text editor.

### Files

- **Save/load** (`Cmd+S` / `Cmd+L`) uses an internal browser folder (IndexedDB). Use `Cmd+Shift+S` to get a file out.
- **Open**: drag and drop onto the window a `.glss` (graph), a `.glst` (theme), a text shader, an image (`png`, `jpg`, `bmp`, `gif`, `tga`, `webp`) or a video (`mp4`, `webm`, `mov`, `mkv`; the codec must be in the browser. `avi` cannot be read on the web).
- **Export** (`Cmd+E`) downloads `export.png` or `export.mp4`.
- Language and theme (also a dropped external theme) are saved in the browser (`localStorage`).

### Differences from desktop

- Shaders are **GLSL ES 3.00**: code starts with `#version 300 es` and `precision highp float;`. A desktop shader with `#version 330` is converted when opened.
- Video is exported as MP4 with H.264 (or VP9/AV1 if the browser has no H.264); desktop uses `mp4v`. Browsers cannot decode `mp4v`, so a video exported by desktop cannot be used as iChannel0 on the web.
- Compile error messages come from the browser's GPU driver, so their text differs from desktop.
- `Cmd+Q` does nothing (a page cannot close its tab).

### Project Structure

```
glsl_studio_web/
├── index.html              # Page (canvas + textarea for keyboard/IME)
├── js/
│   ├── main.js             # Entry: browser events → GLFW-style callbacks
│   ├── app.js              # App: main loop and UI (app.py)
│   ├── editor.js           # Text editor (editor.py)
│   ├── renderer.js         # WebGL2 renderer, glyph atlas, video (renderer.py)
│   ├── fontinfo.js         # TrueType/OpenType reader (FreeType-like metrics)
│   ├── node_editor.js      # Node editor view (node_editor.py)
│   ├── nodes.js            # Node types, compiler and decompiler (nodes.py)
│   ├── menu_system.js      # Menu system (menu_system.py)
│   ├── syntax.js           # Syntax highlighting (syntax.py)
│   ├── theme.js            # Themes (theme.py)
│   ├── file_mngr.js        # .glss format (file_mngr.py)
│   ├── lang.js             # i18n (lang.py)
│   ├── storage.js          # IndexedDB, localStorage and downloads
│   ├── glfw.js             # GLFW constants and keys
│   └── pyutil.js           # Python semantics (format, round, str, set...)
├── lang/                   # Translations (+ index.json)
├── Themes/                 # Themes (+ index.json)
├── Assets/                 # Fonts and glyph_metrics.json
├── test_assets/            # Default iChannel0 texture
├── vendor/mediabunny/      # Mediabunny (video reading/writing)
└── tools/                  # Scripts to regenerate files (Python)
```

### Tools

- `python3 tools/make_manifests.py`: regenerates `lang/index.json` and `Themes/index.json` (after adding a language or theme).
- `python3 tools/make_jp_subset.py`: regenerates `Assets/NotoSansJP-Subset.otf` with the UI's CJK characters (requires `fonttools`). If a character is missing, the web loads the full font.
- `python3 tools/make_glyph_metrics.py`: regenerates `Assets/glyph_metrics.json` (requires `Pillow`).

---

## Licencias / Licenses

- Código / Code: MIT © 2026 [Jaco Patiño Tello](LICENSE)
- Noto Sans, Noto Sans Arabic, Noto Sans JP: SIL Open Font License 1.1 ([Assets/OFL.txt](Assets/OFL.txt))
- DejaVu Sans Mono: Bitstream Vera / DejaVu license ([Assets/DejaVuSansMono-LICENSE.txt](Assets/DejaVuSansMono-LICENSE.txt))
- Mediabunny: Mozilla Public License 2.0 ([vendor/mediabunny/LICENSE](vendor/mediabunny/LICENSE))

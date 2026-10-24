// Port de renderer.py a WebGL2.
//
// - Mismo pipeline de batches (rects, quads, triángulos, texto) y mismo shader.
// - Atlas de glifos: cada glifo se rasteriza con Canvas 2D usando las mismas
//   fuentes, se le aplica el mismo Gaussian blur de Pillow (port exacto de
//   BoxBlur.c) y se empaqueta igual que en escritorio. Las métricas (ascent,
//   descent, avances, bbox de 'A') son las de Pillow/FreeType (ver fontinfo.js
//   y Assets/glyph_metrics.json).
// - Preview: el shader del usuario se dibuja en un FBO del tamaño del preview
//   y luego se compone en pantalla (igual que escritorio).
// - Video (entrada y exportación): Mediabunny (WebCodecs).

import { _ } from "./lang.js";
import { FontInfo, load_font_info } from "./fontinfo.js";
import { monotonic, pyInt } from "./pyutil.js";

// ======================
// CONFIG - ADVANCED TEXT RENDERING
// ======================

export const FONT_CHAR_W = 14;
export const FONT_CHAR_H = 26;

// Rendering mode
export const RENDER_MODE = "sdf";

// Buffer and quads config
export const MAX_QUADS = 16384;
export const VERTS_PER_QUAD = 6;
export const FLOATS_PER_VERT = 10; // pos(2) + uv(2) + color(4) + sdf_size(1) + effect(1)

// Glyph atlas
export const ATLAS_SIZE = 2048;
export const ATLAS_PAD = 2;
export const SDF_SPREAD = 2;
export const TEXT_GAMMA = 2.0;

const MEDIABUNNY_URL = "../vendor/mediabunny/mediabunny.min.mjs";

// ======================
// SHADERS (GLSL ES 3.00)
// ======================

export const BATCH_VS = `#version 300 es
in vec2 in_pos;
in vec2 in_uv;
in vec4 in_color;
in float in_sdf_size;
in float in_effect;

out vec2 v_uv;
out vec4 v_color;
out float v_sdf_size;
out float v_effect;

uniform mat4 u_proj;

void main() {
    gl_Position = u_proj * vec4(in_pos, 0.0, 1.0);
    v_uv = in_uv;
    v_color = in_color;
    v_sdf_size = in_sdf_size;
    v_effect = in_effect;
}
`;

export const BATCH_FS = `#version 300 es
precision highp float;

in vec2 v_uv;
in vec4 v_color;
in float v_sdf_size;
in float v_effect;

out vec4 fragColor;

uniform sampler2D u_tex;
uniform int u_use_tex;
uniform float u_screen_ratio;

void main() {
    if (u_use_tex == 1) {
        // El atlas se sube sin voltear (fila 0 arriba), por eso no hay 1.0 - v
        float alpha = texture(u_tex, v_uv).r;
        fragColor = vec4(v_color.rgb, v_color.a * alpha);
    } else {
        fragColor = v_color;
    }
}
`;

export const PREVIEW_VS = `#version 300 es
in vec2 in_pos;
out vec2 v_uv;
void main() {
    v_uv = in_pos * 0.5 + 0.5;
    gl_Position = vec4(in_pos, 0.0, 1.0);
}
`;

export const BLIT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_tex;
void main() {
    fragColor = texture(u_tex, v_uv);
}
`;

export const DEFAULT_PREVIEW_FS = `#version 300 es
precision highp float;
uniform float iTime;
uniform vec2 iResolution;
uniform vec2 iMouse;
uniform sampler2D iChannel0;
out vec4 fragColor;
void main() {
    vec2 uv = gl_FragCoord.xy / iResolution.xy;
    fragColor = texture(iChannel0, uv);
}
`;

// ======================
// FUENTES
// ======================

const FONT_FILES = {
    latin_ui:   { file: "NotoSans-Regular.ttf",       family: "GS NotoSans" },
    latin_mono: { file: "DejaVuSansMono.ttf",         family: "GS DejaVuSansMono" },
    arabic:     { file: "NotoSansArabic-Regular.ttf", family: "GS NotoSansArabic" },
    cjk_sub:    { file: "NotoSansJP-Subset.otf",      family: "GS NotoSansJP Subset", metrics_key: "NotoSansJP-Regular.ttf" },
    cjk_full:   { file: "NotoSansJP-Regular.ttf",     family: "GS NotoSansJP" },
};

const _fonts = {};          // key -> { info, family, metrics_key }
let _glyph_metrics = null;  // Assets/glyph_metrics.json
let _cjk_full_state = "none"; // none | loading | ready | error
const _cjk_listeners = [];

function _assets_path(name) {
    return `Assets/${name}`;
}

async function _load_font(key) {
    const def = FONT_FILES[key];
    const { buffer, info } = await load_font_info(_assets_path(def.file));
    const face = new FontFace(def.family, buffer);
    await face.load();
    document.fonts.add(face);
    _fonts[key] = { info, family: def.family, metrics_key: def.metrics_key || def.file };
}

/** Carga las fuentes de la UI y la tabla de métricas. Llamar antes de crear el Renderer. */
export async function load_fonts() {
    const res = await fetch(_assets_path("glyph_metrics.json"));
    _glyph_metrics = await res.json();
    await Promise.all(["latin_ui", "latin_mono", "arabic", "cjk_sub"].map(_load_font));
}

/** Descarga NotoSansJP completo en segundo plano (la primera vez que hace falta) */
function _request_full_cjk() {
    if (_cjk_full_state !== "none") return;
    _cjk_full_state = "loading";
    _load_font("cjk_full").then(() => {
        _cjk_full_state = "ready";
        for (const fn of _cjk_listeners) fn();
    }).catch((e) => {
        _cjk_full_state = "error";
        console.log(`[renderer] Error cargando NotoSansJP completo: ${e}`);
    });
}

function _cjk_font() {
    return _cjk_full_state === "ready" ? _fonts.cjk_full : _fonts.cjk_sub;
}

// _fit_font_height(path, max_h): tamaño máximo cuyo ascent+descent cabe en max_h
const _fit_font_cache = new Map();

function _fit_font_height(font, max_h) {
    const key = `${font.family}|${max_h}`;
    const cached = _fit_font_cache.get(key);
    if (cached !== undefined) return cached;
    for (let sz = max_h; sz > 4; sz--) {
        const [asc, desc] = font.info.metrics(sz);
        if (asc + desc <= max_h) {
            _fit_font_cache.set(key, sz);
            return sz;
        }
    }
    const result = Math.max(4, Math.floor(max_h / 2));
    _fit_font_cache.set(key, result);
    return result;
}

/** Fuente concreta (familia + tamaño) como ImageFont.truetype(path, size) */
class PilFont {
    constructor(font, px) {
        this.font = font;
        this.px = px;
        this.css = `${px}px "${font.family}"`;
        const [asc, desc] = font.info.metrics(px);
        this.ascent = asc;
        this.descent = desc;
    }

    getmetrics() {
        return [this.ascent, this.descent];
    }
}

const _font_cache = new Map();

/** Devuelve las fuentes para un tamaño dado y rol de texto (como _get_pil_fonts). */
function _get_pil_fonts(font_px, font_role = "ui") {
    const key = `${font_px}|${font_role}|${_cjk_full_state === "ready" ? "full" : "sub"}`;
    const cached = _font_cache.get(key);
    if (cached) return cached;

    const pil_fonts = {};
    pil_fonts.latin = new PilFont(font_role === "mono" ? _fonts.latin_mono : _fonts.latin_ui, font_px);

    const arab = _fonts.arabic;
    let arab_px = _fit_font_height(arab, font_px);
    // Make Arabic letters significantly thicker by increasing font size
    arab_px = pyInt(arab_px * 1.4);
    pil_fonts.arabic = new PilFont(arab, arab_px);

    const cjk = _cjk_font();
    pil_fonts.cjk = new PilFont(cjk, _fit_font_height(cjk, font_px));

    _font_cache.set(key, pil_fonts);
    return pil_fonts;
}

const RE_DEFAULT_IGNORABLE = /^\p{Default_Ignorable_Code_Point}$/u;
const RE_MARK = /^\p{M}$/u;

function _is_arabic(cp) {
    return (cp >= 0x0600 && cp <= 0x06FF) || (cp >= 0x0750 && cp <= 0x077F) || (cp >= 0xFE70 && cp <= 0xFEFF);
}

function _font_for_char(ch, pil_fonts) {
    /** Selecciona la fuente correcta para un caracter. */
    const cp = ch.codePointAt(0);
    let order;
    if (_is_arabic(cp)) order = ["arabic", "latin", "cjk"];
    else if (cp >= 0x3000 || (cp >= 0x4E00 && cp <= 0x9FFF)) order = ["cjk", "latin"];
    else order = ["latin", "arabic", "cjk"];
    for (const key of order) {
        const f = pil_fonts[key];
        if (f) return f;
    }
    return Object.values(pil_fonts)[0] || null;
}

// ======================
// GAUSSIAN BLUR DE PILLOW (port exacto de libImaging/BoxBlur.c)
// ======================

const f32 = Math.fround;

function _gaussian_blur_radius(radius, passes) {
    radius = f32(radius);
    const sigma2 = f32(f32(radius * radius) / passes);
    const L = f32(Math.sqrt(12.0 * sigma2 + 1.0));
    const l = f32(Math.floor((L - 1.0) / 2.0));
    let a = f32(f32(f32(2 * l) + 1) * f32(f32(l * f32(l + 1)) - f32(3 * sigma2)));
    a = f32(a / f32(6 * f32(sigma2 - f32(f32(l + 1) * f32(l + 1)))));
    return f32(l + a);
}

function _line_box_blur8(out, inp, lastx, radius, edgeA, edgeB, ww, fw) {
    const SAVE = (x, bulk) => { out[x] = Math.floor((bulk + 8388608) / 16777216) & 0xFF; };
    let acc = inp[0] * (radius + 1);
    for (let x = 0; x < edgeA - 1; x++) acc += inp[x];
    acc += inp[lastx] * (radius - edgeA + 1);

    let x;
    if (edgeA <= edgeB) {
        for (x = 0; x < edgeA; x++) {
            acc += inp[x + radius] - inp[0];
            SAVE(x, acc * ww + (inp[0] + inp[x + radius + 1]) * fw);
        }
        for (x = edgeA; x < edgeB; x++) {
            acc += inp[x + radius] - inp[x - radius - 1];
            SAVE(x, acc * ww + (inp[x - radius - 1] + inp[x + radius + 1]) * fw);
        }
        for (x = edgeB; x <= lastx; x++) {
            acc += inp[lastx] - inp[x - radius - 1];
            SAVE(x, acc * ww + (inp[x - radius - 1] + inp[lastx]) * fw);
        }
    } else {
        for (x = 0; x < edgeB; x++) {
            acc += inp[x + radius] - inp[0];
            SAVE(x, acc * ww + (inp[0] + inp[x + radius + 1]) * fw);
        }
        for (x = edgeB; x < edgeA; x++) {
            acc += inp[lastx] - inp[0];
            SAVE(x, acc * ww + (inp[0] + inp[lastx]) * fw);
        }
        for (x = edgeA; x <= lastx; x++) {
            acc += inp[lastx] - inp[x - radius - 1];
            SAVE(x, acc * ww + (inp[x - radius - 1] + inp[lastx]) * fw);
        }
    }
}

function _horizontal_box_blur(data, w, h, floatRadius) {
    const radius = Math.trunc(floatRadius);
    const ww = Math.trunc(f32(16777216 / f32(f32(floatRadius * 2) + 1)));
    const fw = Math.floor((16777216 - (radius * 2 + 1) * ww) / 2);
    const edgeA = Math.min(radius + 1, w);
    const edgeB = Math.max(w - radius - 1, 0);
    const lineIn = new Float64Array(w);
    const lineOut = new Uint8Array(w);
    for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) lineIn[x] = data[row + x];
        _line_box_blur8(lineOut, lineIn, w - 1, radius, edgeA, edgeB, ww, fw);
        data.set(lineOut, row);
    }
}

function _transpose(data, w, h) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) out[x * h + y] = data[y * w + x];
    }
    return out;
}

/** ImageFilter.GaussianBlur(radius) sobre una imagen "L" (Uint8Array w*h) */
export function pil_gaussian_blur(data, w, h, radius, passes = 3) {
    if (w === 0 || h === 0) return data;
    const r = _gaussian_blur_radius(radius, passes);
    const out = new Uint8Array(data);
    if (r !== 0) {
        for (let i = 0; i < passes; i++) _horizontal_box_blur(out, w, h, r);
        let t = _transpose(out, w, h);
        for (let i = 0; i < passes; i++) _horizontal_box_blur(t, h, w, r);
        t = _transpose(t, h, w);
        out.set(t);
    }
    return out;
}

// ======================
// GLYPH INFO
// ======================

class _GlyphInfo {
    /** Metricas de un glifo cacheado en el atlas. */
    constructor(u0, v0, u1, v1, log_w, log_h, advance, bear_x, bear_y, is_sdf = true) {
        this.u0 = u0;
        this.v0 = v0;
        this.u1 = u1;
        this.v1 = v1;
        this.log_w = log_w;
        this.log_h = log_h;
        this.advance = advance;
        this.bear_x = bear_x;
        this.bear_y = bear_y;
        this.is_sdf = is_sdf;
    }
}

const _EMPTY_GLYPH = new _GlyphInfo(0, 0, 0, 0, 0, 0, 0, 0, 0);

// Canvas auxiliar para rasterizar glifos
let _scratch = null;
let _scratch_ctx = null;

function _scratch_context(w, h) {
    if (!_scratch || _scratch.width < w || _scratch.height < h) {
        const nw = Math.max(w, _scratch ? _scratch.width : 0, 256);
        const nh = Math.max(h, _scratch ? _scratch.height : 0, 256);
        _scratch = typeof OffscreenCanvas !== "undefined"
            ? new OffscreenCanvas(nw, nh) : Object.assign(document.createElement("canvas"), { width: nw, height: nh });
        _scratch_ctx = _scratch.getContext("2d", { willReadFrequently: true });
    }
    return _scratch_ctx;
}

// ======================
// GLYPH ATLAS
// ======================

class _GlyphAtlas {
    /** Atlas de glifos con antialiasing y suavidad. */

    constructor(gl, font_px, pixel_ratio, font_role = "ui") {
        this._gl = gl;
        this._font_px = font_px;
        this._pixel_ratio = pixel_ratio;
        this._font_role = font_role;
        this._pil_fonts = _get_pil_fonts(font_px, font_role);
        this._main_font = this._pil_fonts.latin;

        const [asc, desc] = this._main_font.getmetrics();
        this._ascent = asc;
        this._descent = desc;
        this._line_h = (asc + desc) / pixel_ratio;

        // Atlas "L" inicializado en 0 (transparente)
        this._img = new Uint8Array(ATLAS_SIZE * ATLAS_SIZE);

        // Textura GPU (lazy)
        this._tex = null;
        this._dirty = true;
        this._dirty_y0 = ATLAS_SIZE;
        this._dirty_y1 = 0;

        // Empaquetado por filas
        this._pack_x = 0;
        this._pack_y = 0;
        this._row_h = 0;

        // Cache de glifos
        this._glyphs = new Map();
    }

    get line_height() {
        return this._line_h;
    }

    get_glyph(ch) {
        const g = this._glyphs.get(ch);
        if (g !== undefined) return g;
        return this._rasterize(ch);
    }

    /** bbox de Pillow para un glifo: [left, top, right, bottom].
     *  dc_adv26: avance del círculo punteado si se insertó antes de una marca. */
    _pil_bbox(ch, font, has, gid, adv26, dc_adv26 = null) {
        const asc = font.ascent;
        const ctx = _scratch_context(1, 1);
        ctx.font = font.css;
        const measure = (text) => {
            const m = ctx.measureText(text);
            return [Math.floor(-m.actualBoundingBoxLeft), Math.floor(-m.actualBoundingBoxDescent),
                    Math.ceil(m.actualBoundingBoxRight), Math.ceil(m.actualBoundingBoxAscent)];
        };
        let x_min, x_max, y_min, y_max;
        if (dc_adv26 !== null) {
            const a = measure("◌");
            const off = Math.floor((dc_adv26 + 32) / 64);
            const b = has ? measure(ch) : _glyph_bbox(font.font.info, gid, font.px);
            x_min = Math.min(a[0], b[0] + off);
            y_min = Math.min(a[1], b[1]);
            x_max = Math.max(a[2], b[2] + off);
            y_max = Math.max(a[3], b[3]);
        } else if (has) {
            [x_min, y_min, x_max, y_max] = measure(ch);
        } else {
            [x_min, y_min, x_max, y_max] = _glyph_bbox(font.font.info, gid, font.px);
        }
        // Una caja vacía (espacio) no extiende el bbox
        if (x_max <= x_min || y_max <= y_min) {
            x_min = x_max = y_min = y_max = 0;
        }
        const advanced = Math.floor((adv26 + 32) / 64); // PIXEL(position)
        const left = Math.min(0, x_min);
        const right = Math.max(advanced, x_max, 0);
        let top = asc - Math.max(0, y_max);
        let bottom = asc - Math.min(0, y_min);

        // 'A': valores exactos de Pillow (centrado vertical de text_centered_y)
        if (ch === "A" && _glyph_metrics) {
            const t = _glyph_metrics.fonts[font.font.metrics_key];
            if (t && font.px >= 1 && font.px <= _glyph_metrics.max_px) {
                top = t[font.px][2];
                bottom = t[font.px][3];
            }
        }
        return [left, top, right, bottom];
    }

    _rasterize(ch) {
        /** Rasteriza un glifo con anti-aliasing suave. */
        const font = _font_for_char(ch, this._pil_fonts);
        if (font === null) {
            this._glyphs.set(ch, _EMPTY_GLYPH);
            return _EMPTY_GLYPH;
        }

        const cp = ch.codePointAt(0);
        const info = font.font.info;
        const has = info.has_char(cp);
        const gid = info.glyph_id(cp);
        if (!has && font.font === _fonts.cjk_sub && (cp >= 0x3000 || (cp >= 0x4E00 && cp <= 0x9FFF))) {
            _request_full_cjk();
        }

        const pr = this._pixel_ratio;

        // Default ignorables (ZWJ, BOM, SHY, ...): HarfBuzz los oculta con avance 0
        if (RE_DEFAULT_IGNORABLE.test(ch)) {
            const g = new _GlyphInfo(0, 0, 0, 0, 0, 0, 0, 0, 0);
            this._glyphs.set(ch, g);
            return g;
        }

        // Marca combinante sola: HarfBuzz inserta un círculo punteado (U+25CC)
        // antes; la marca queda con avance 0 (si falta, va .notdef con su avance)
        const dotted = RE_MARK.test(ch) && info.has_char(0x25CC);
        let adv26 = info.advance_26_6(gid, font.px);
        let dc_adv26 = 0;
        if (dotted) {
            dc_adv26 = info.advance_26_6(info.glyph_id(0x25CC), font.px);
            adv26 = dc_adv26 + (has ? 0 : info.advance_26_6(0, font.px));
        }
        const advance = adv26 / 64;

        // "\n": ImageDraw.text lo trata como salto de línea y no dibuja nada,
        // pero el avance es el de getlength() (.notdef si la fuente no lo tiene)
        if (ch === "\n") {
            const g = new _GlyphInfo(0, 0, 0, 0, 0, 0, advance / pr, 0, 0);
            this._glyphs.set(ch, g);
            return g;
        }

        const [left, top, right, bottom] = this._pil_bbox(ch, font, has, gid, adv26, dotted ? dc_adv26 : null);
        const gw = right - left;
        const gh = bottom - top;

        // Glifos invisibles (espacio, tabulación, etc.)
        if (gw <= 0 || gh <= 0) {
            const g = new _GlyphInfo(0, 0, 0, 0, 0, 0, advance / pr, 0, 0);
            this._glyphs.set(ch, g);
            return g;
        }

        // Padding para anti-aliasing/blur
        const pad = ATLAS_PAD;
        const cell_w = gw + pad * 2;
        const cell_h = gh + pad * 2;

        // Chequear si cabe en la fila actual
        if (this._pack_x + cell_w > ATLAS_SIZE) {
            this._pack_x = 0;
            this._pack_y += this._row_h;
            this._row_h = 0;
        }

        // Chequear si el atlas está lleno
        if (this._pack_y + cell_h > ATLAS_SIZE) {
            const g = new _GlyphInfo(0, 0, 0, 0, 0, 0, advance / pr, 0, 0);
            this._glyphs.set(ch, g);
            return g;
        }

        // Rasterizar en blanco sobre transparente; la cobertura es el alfa
        const ctx = _scratch_context(cell_w, cell_h);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, cell_w, cell_h);
        ctx.fillStyle = "#fff";
        ctx.textAlign = "left";
        ctx.textBaseline = "alphabetic";
        ctx.font = font.css;
        if ("fontKerning" in ctx) ctx.fontKerning = "none";

        // El glifo empieza en (pad - left, pad - top) con ancla "la" (ascender)
        const draw_x = pad - left;
        const baseline = pad - top + font.ascent;

        const is_arabic = _is_arabic(cp);
        const notdef = has ? null : info.glyph_path(0, font.px);
        const draw_at = (dx, dy) => {
            // Con círculo punteado, la marca va en el pen después del círculo
            // (sin enganche GPOS, igual que el resultado de Pillow)
            let x = draw_x + dx;
            if (dotted) {
                ctx.fillText("◌", x, baseline + dy);
                x += dc_adv26 / 64;
            }
            if (has) {
                ctx.fillText(ch, x, baseline + dy);
            } else if (notdef) {
                ctx.setTransform(1, 0, 0, 1, x, baseline + dy);
                ctx.fill(notdef);
                ctx.setTransform(1, 0, 0, 1, 0, 0);
            } else {
                ctx.fillText(ch, x, baseline + dy);
            }
        };

        if (is_arabic) {
            // Para árabe: dibujar múltiples veces con offset para crear efecto de stroke
            const offset = 1;
            for (let dx = -offset; dx <= offset; dx++) {
                for (let dy = -offset; dy <= offset; dy++) draw_at(dx, dy);
            }
        } else {
            draw_at(0, 0);
        }

        const rgba = ctx.getImageData(0, 0, cell_w, cell_h).data;
        let cov = new Uint8Array(cell_w * cell_h);
        for (let i = 0; i < cov.length; i++) cov[i] = rgba[i * 4 + 3];

        // Aplicar suavidad: mínima para árabe para preservar nitidez
        const blur_radius = is_arabic ? 0.3 : 0.5;
        cov = pil_gaussian_blur(cov, cell_w, cell_h, blur_radius);

        // Pegar en el atlas
        for (let y = 0; y < cell_h; y++) {
            this._img.set(cov.subarray(y * cell_w, (y + 1) * cell_w), (this._pack_y + y) * ATLAS_SIZE + this._pack_x);
        }
        this._dirty_y0 = Math.min(this._dirty_y0, this._pack_y);
        this._dirty_y1 = Math.max(this._dirty_y1, this._pack_y + cell_h);

        // Coordenadas UV normalizadas
        const inv = 1.0 / ATLAS_SIZE;
        const u0 = this._pack_x * inv;
        const u1 = (this._pack_x + cell_w) * inv;
        const v0 = this._pack_y * inv;
        const v1 = (this._pack_y + cell_h) * inv;

        const g = new _GlyphInfo(
            u0, v0, u1, v1,
            cell_w / pr, cell_h / pr,
            advance / pr,
            (left - pad) / pr,
            (top - pad) / pr,
            false,
        );

        this._pack_x += cell_w;
        this._row_h = Math.max(this._row_h, cell_h);
        this._glyphs.set(ch, g);
        this._dirty = true;

        return g;
    }

    get_texture() {
        const gl = this._gl;
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        if (this._tex === null) {
            this._tex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, this._tex);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, ATLAS_SIZE, ATLAS_SIZE, 0, gl.RED, gl.UNSIGNED_BYTE, this._img);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            this._dirty = false;
            this._dirty_y0 = ATLAS_SIZE;
            this._dirty_y1 = 0;
        } else if (this._dirty) {
            gl.bindTexture(gl.TEXTURE_2D, this._tex);
            const y0 = this._dirty_y0, y1 = this._dirty_y1;
            if (y1 > y0) {
                gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y0, ATLAS_SIZE, y1 - y0, gl.RED, gl.UNSIGNED_BYTE,
                                 this._img.subarray(y0 * ATLAS_SIZE, y1 * ATLAS_SIZE));
            }
            this._dirty = false;
            this._dirty_y0 = ATLAS_SIZE;
            this._dirty_y1 = 0;
        }
        return this._tex;
    }

    measure_text(text) {
        /** Devuelve [width, height] lógicos del texto. */
        if (!text) return [0.0, 0.0];
        let width = 0.0;
        for (const ch of text) width += this.get_glyph(ch).advance;
        return [width, this._line_h];
    }

    release() {
        if (this._tex) {
            this._gl.deleteTexture(this._tex);
            this._tex = null;
        }
    }
}

/** bbox en píxeles (FT_GLYPH_BBOX_PIXELS) del glifo gid, desde la tabla glyf */
function _glyph_bbox(info, gid, px) {
    if (!info.tables["glyf"] || !info.tables["loca"]) return [0, 0, 0, 0];
    const [a, b] = info._glyph_offset(gid);
    if (b <= a) return [0, 0, 0, 0];
    const o = info.tables["glyf"].offset + a;
    const s = px / info.units_per_em;
    const v = info.view;
    return [
        Math.floor(v.getInt16(o + 2) * s), Math.floor(v.getInt16(o + 4) * s),
        Math.ceil(v.getInt16(o + 6) * s), Math.ceil(v.getInt16(o + 8) * s),
    ];
}

// ======================
// BATCH BUILDER
// ======================

export class BatchBuilder {
    /** Constructor de batches para renderizado de UI y texto. */
    constructor() {
        this._data = new Float32Array(MAX_QUADS * VERTS_PER_QUAD * FLOATS_PER_VERT);
        this._len = 0;
        this._count = 0;
    }

    clear() {
        this._len = 0;
        this._count = 0;
    }

    get quad_count() {
        return this._count;
    }

    _ensure(n) {
        if (this._len + n <= this._data.length) return;
        const nd = new Float32Array(Math.max(this._data.length * 2, this._len + n));
        nd.set(this._data.subarray(0, this._len));
        this._data = nd;
    }

    _v(x, y, u, v, r, g, b, a, s, e) {
        const d = this._data;
        let i = this._len;
        d[i++] = x; d[i++] = y; d[i++] = u; d[i++] = v;
        d[i++] = r; d[i++] = g; d[i++] = b; d[i++] = a;
        d[i++] = s; d[i++] = e;
        this._len = i;
    }

    add_rect(x, y, w, h, r, g, b, a) {
        this._ensure(60);
        this._v(x,     y,     0.0, 0.0, r, g, b, a, 1.0, 0.0);
        this._v(x + w, y,     1.0, 0.0, r, g, b, a, 1.0, 0.0);
        this._v(x,     y + h, 0.0, 1.0, r, g, b, a, 1.0, 0.0);
        this._v(x + w, y,     1.0, 0.0, r, g, b, a, 1.0, 0.0);
        this._v(x + w, y + h, 1.0, 1.0, r, g, b, a, 1.0, 0.0);
        this._v(x,     y + h, 0.0, 1.0, r, g, b, a, 1.0, 0.0);
        this._count += 1;
    }

    add_rect_uv(x, y, w, h, u0, v0, u1, v1, r, g, b, a, sdf_size = 1.0, effect = 0.0) {
        /** Agrega un quad con UV personalizadas para atlas. */
        this._ensure(60);
        this._v(x,     y,     u0, v0, r, g, b, a, sdf_size, effect);
        this._v(x + w, y,     u1, v0, r, g, b, a, sdf_size, effect);
        this._v(x,     y + h, u0, v1, r, g, b, a, sdf_size, effect);
        this._v(x + w, y,     u1, v0, r, g, b, a, sdf_size, effect);
        this._v(x + w, y + h, u1, v1, r, g, b, a, sdf_size, effect);
        this._v(x,     y + h, u0, v1, r, g, b, a, sdf_size, effect);
        this._count += 1;
    }

    add_quad(x0, y0, x1, y1, x2, y2, x3, y3, r, g, b, a) {
        /** Agrega un quad arbitrario (2 triángulos). */
        this._ensure(60);
        this._v(x0, y0, 0.0, 0.0, r, g, b, a, 1.0, 0.0);
        this._v(x1, y1, 0.0, 0.0, r, g, b, a, 1.0, 0.0);
        this._v(x2, y2, 0.0, 0.0, r, g, b, a, 1.0, 0.0);
        this._v(x1, y1, 0.0, 0.0, r, g, b, a, 1.0, 0.0);
        this._v(x3, y3, 0.0, 0.0, r, g, b, a, 1.0, 0.0);
        this._v(x2, y2, 0.0, 0.0, r, g, b, a, 1.0, 0.0);
        this._count += 1;
    }

    add_tri(x0, y0, x1, y1, x2, y2, r, g, b, a) {
        /** Agrega un triángulo único (6 vértices, como escritorio). */
        this._ensure(60);
        this._v(x0, y0, 0.0, 0.0, r, g, b, a, 1.0, 0.0);
        this._v(x1, y1, 0.0, 0.0, r, g, b, a, 1.0, 0.0);
        this._v(x2, y2, 0.0, 0.0, r, g, b, a, 1.0, 0.0);
        this._v(x2, y2, 0.0, 0.0, r, g, b, a, 1.0, 0.0);
        this._v(x2, y2, 0.0, 0.0, r, g, b, a, 1.0, 0.0);
        this._v(x2, y2, 0.0, 0.0, r, g, b, a, 1.0, 0.0);
        this._count += 1;
    }

    get_array() {
        return this._data.subarray(0, this._len);
    }
}

// ======================
// GL CONTEXT (equivalente mínimo al contexto de moderngl)
// ======================

class GLContext {
    constructor(gl) {
        this.gl = gl;
        this._viewport = [0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight];
        this._scissor = null;
        const self = this;
        this.screen = {
            use() { gl.bindFramebuffer(gl.FRAMEBUFFER, null); },
        };
        void self;
    }

    get viewport() {
        return [...this._viewport];
    }

    set viewport(v) {
        this._viewport = [v[0], v[1], v[2], v[3]];
        this.gl.viewport(v[0], v[1], v[2], v[3]);
    }

    /** ctx.scissor de moderngl: null desactiva el scissor test */
    get scissor() {
        return this._scissor ? [...this._scissor] : null;
    }

    set scissor(v) {
        const gl = this.gl;
        if (v === null || v === undefined) {
            this._scissor = null;
            gl.disable(gl.SCISSOR_TEST);
        } else {
            this._scissor = [v[0], v[1], v[2], v[3]];
            gl.enable(gl.SCISSOR_TEST);
            gl.scissor(v[0], v[1], v[2], v[3]);
        }
    }

    clear(r, g, b, a = 0.0) {
        const gl = this.gl;
        gl.clearColor(r, g, b, a);
        gl.clear(gl.COLOR_BUFFER_BIT);
    }
}

function _compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh) || "";
        gl.deleteShader(sh);
        const name = type === gl.VERTEX_SHADER ? "vertex_shader" : "fragment_shader";
        // Mismo formato que el error de moderngl
        throw new Error(`GLSL Compiler failed\n\n${name}\n${"=".repeat(name.length)}\n${log}\n`);
    }
    return sh;
}

function _program(gl, vs_src, fs_src) {
    const vs = _compile(gl, gl.VERTEX_SHADER, vs_src);
    let fs;
    try {
        fs = _compile(gl, gl.FRAGMENT_SHADER, fs_src);
    } catch (e) {
        gl.deleteShader(vs);
        throw e;
    }
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(prog) || "";
        gl.deleteProgram(prog);
        throw new Error(`GLSL Linker failed\n\n${log}\n`);
    }
    return prog;
}

/** Programa con acceso a uniforms como moderngl (`"iTime" in prog`) */
class Program {
    constructor(gl, vs, fs) {
        this.gl = gl;
        this.prog = _program(gl, vs, fs);
        this._loc = new Map();
        const n = gl.getProgramParameter(this.prog, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < n; i++) {
            const info = gl.getActiveUniform(this.prog, i);
            const name = info.name.replace(/\[0\]$/, "");
            this._loc.set(name, { loc: gl.getUniformLocation(this.prog, info.name), type: info.type });
        }
    }

    has(name) {
        return this._loc.has(name);
    }

    set(name, ...values) {
        const u = this._loc.get(name);
        if (!u) return;
        const gl = this.gl;
        switch (u.type) {
            case gl.FLOAT: gl.uniform1f(u.loc, values[0]); break;
            case gl.FLOAT_VEC2: gl.uniform2f(u.loc, values[0], values[1]); break;
            case gl.FLOAT_VEC3: gl.uniform3f(u.loc, values[0], values[1], values[2] ?? 0); break;
            case gl.FLOAT_VEC4: gl.uniform4f(u.loc, values[0], values[1], values[2] ?? 0, values[3] ?? 0); break;
            case gl.INT: case gl.SAMPLER_2D: case gl.BOOL: gl.uniform1i(u.loc, values[0]); break;
            case gl.FLOAT_MAT4: gl.uniformMatrix4fv(u.loc, false, values[0]); break;
            default: break;
        }
    }

    release() {
        this.gl.deleteProgram(this.prog);
    }
}

// ======================
// TEXTURAS DESDE ARCHIVOS
// ======================

function _decode_tga(buf) {
    /** Decodificador TGA (tipos 1, 2, 3, 9, 10, 11), como lo lee Pillow. Retorna ImageData RGBA. */
    const d = new Uint8Array(buf);
    const id_len = d[0], cmap_type = d[1], type = d[2];
    const cmap_first = d[3] | (d[4] << 8), cmap_len = d[5] | (d[6] << 8), cmap_bits = d[7];
    const w = d[12] | (d[13] << 8), h = d[14] | (d[15] << 8);
    const bpp = d[16], desc = d[17];
    if (![1, 2, 3, 9, 10, 11].includes(type) || !w || !h) throw new Error("TGA no soportado");
    let p = 18 + id_len;
    let cmap = null;
    if (cmap_type === 1) {
        const cb = Math.ceil(cmap_bits / 8);
        cmap = [];
        for (let i = 0; i < cmap_len; i++) {
            cmap.push(_tga_pixel(d, p + i * cb, cmap_bits));
        }
        p += cmap_len * cb;
    }
    const bytes = Math.ceil(bpp / 8);
    const out = new Uint8ClampedArray(w * h * 4);
    const total = w * h;
    const read = (off) => {
        if (type === 1 || type === 9) {
            const idx = bytes === 2 ? (d[off] | (d[off + 1] << 8)) : d[off];
            return cmap[idx - cmap_first] || [0, 0, 0, 255];
        }
        if (type === 3 || type === 11) {
            const g = d[off];
            return [g, g, g, bpp === 16 ? d[off + 1] : 255];
        }
        return _tga_pixel(d, off, bpp);
    };
    const pixels = [];
    if (type >= 9) {
        while (pixels.length < total && p < d.length) {
            const c = d[p++];
            const n = (c & 0x7F) + 1;
            if (c & 0x80) {
                const px = read(p);
                p += bytes;
                for (let i = 0; i < n; i++) pixels.push(px);
            } else {
                for (let i = 0; i < n; i++) { pixels.push(read(p)); p += bytes; }
            }
        }
    } else {
        for (let i = 0; i < total; i++) { pixels.push(read(p)); p += bytes; }
    }
    const top_down = (desc & 0x20) !== 0;
    const right_left = (desc & 0x10) !== 0;
    for (let i = 0; i < total; i++) {
        const sx = i % w, sy = Math.floor(i / w);
        const x = right_left ? w - 1 - sx : sx;
        const y = top_down ? sy : h - 1 - sy;
        const px = pixels[i] || [0, 0, 0, 255];
        out.set(px, (y * w + x) * 4);
    }
    return new ImageData(out, w, h);
}

function _tga_pixel(d, o, bits) {
    if (bits === 32) return [d[o + 2], d[o + 1], d[o], d[o + 3]];
    if (bits === 24) return [d[o + 2], d[o + 1], d[o], 255];
    if (bits === 16 || bits === 15) {
        const v = d[o] | (d[o + 1] << 8);
        const r = (v >> 10) & 31, g = (v >> 5) & 31, b = v & 31;
        return [(r << 3) | (r >> 2), (g << 3) | (g >> 2), (b << 3) | (b >> 2), 255];
    }
    return [d[o], d[o], d[o], 255];
}

const _BITMAP_OPTIONS = { premultiplyAlpha: "none", colorSpaceConversion: "none", imageOrientation: "flipY" };

// PNG 1x2 con gAMA 1.0: arriba (200,100,50,3), abajo (128,64,32,255)
const _PROBE_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAACCAYAAACZgbYnAAAABGdBTUEAAYagMeiWXwAAABJJREFUeNpjOJFixMwsw8f+DwANVwKUE2LqzAAAAABJRU5ErkJggg==";
let _bitmap_ok = null; // ¿el navegador respeta _BITMAP_OPTIONS?

async function _check_bitmap_options(gl) {
    /** Prueba una vez si createImageBitmap voltea, no premultiplica y no corrige color. */
    if (_bitmap_ok !== null) return _bitmap_ok;
    _bitmap_ok = false;
    let tex = null, fb = null;
    try {
        const bin = atob(_PROBE_PNG);
        const u = Uint8Array.from(bin, (c) => c.charCodeAt(0));
        const bmp = await createImageBitmap(new Blob([u], { type: "image/png" }), _BITMAP_OPTIONS);
        tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
        fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        const px = new Uint8Array(8);
        gl.readPixels(0, 0, 1, 2, gl.RGBA, gl.UNSIGNED_BYTE, px);
        _bitmap_ok = px.join() === "128,64,32,255,200,100,50,3";
    } catch (e) {
        _bitmap_ok = false;
    } finally {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        if (fb) gl.deleteFramebuffer(fb);
        if (tex) gl.deleteTexture(tex);
    }
    return _bitmap_ok;
}

/** Decodifica una imagen (Blob/File) como la abre PIL: primer frame, RGBA, sin
 *  perfil de color. Usa ImageBitmap (ya volteado en Y) si el navegador respeta
 *  sus opciones; si no, <img>, que WebGL sube sin premultiplicar y sin
 *  corrección de color con UNPACK_* (ver _upload_image). */
async function _decode_image(gl, blob, name = "") {
    if (/\.tga$/i.test(name)) {
        return _decode_tga(await blob.arrayBuffer());
    }
    if (await _check_bitmap_options(gl)) {
        return await createImageBitmap(blob, _BITMAP_OPTIONS);
    }
    const url = URL.createObjectURL(blob);
    try {
        const img = new Image();
        img.src = url;
        await img.decode();
        return img;
    } finally {
        URL.revokeObjectURL(url);
    }
}

let _mediabunny = null;
async function _mb() {
    if (!_mediabunny) _mediabunny = await import(MEDIABUNNY_URL);
    return _mediabunny;
}

// --- fps como cv2 (CAP_PROP_FPS = avg_frame_rate de ffmpeg) ---

function _av_reduce(num, den, max) {
    /** av_reduce de libavutil/rational.c (BigInt). Retorna [num, den]. */
    const abs = (v) => (v < 0n ? -v : v);
    const sign = (num < 0n) !== (den < 0n);
    let a0n = 0n, a0d = 1n, a1n = 1n, a1d = 0n;
    let g = abs(num), h = abs(den);
    while (h) [g, h] = [h, g % h];
    if (g) {
        num = abs(num) / g;
        den = abs(den) / g;
    }
    if (num <= max && den <= max) {
        a1n = num;
        a1d = den;
        den = 0n;
    }
    while (den) {
        let x = num / den;
        const next_den = num - den * x;
        const a2n = x * a1n + a0n;
        const a2d = x * a1d + a0d;
        if (a2n > max || a2d > max) {
            if (a1n) x = (max - a0n) / a1n;
            if (a1d) {
                const y = (max - a0d) / a1d;
                if (y < x) x = y;
            }
            if (den * (2n * x * a1d + a0d) > num * a1d) {
                [a1n, a1d] = [x * a1n + a0n, x * a1d + a0d];
            }
            break;
        }
        [a0n, a0d] = [a1n, a1d];
        [a1n, a1d] = [a2n, a2d];
        num = den;
        den = next_den;
    }
    return [sign ? -a1n : a1n, a1d];
}

function _av_d2q(d, max) {
    /** av_d2q de libavutil/rational.c. Retorna [num, den] (Number). */
    if (Number.isNaN(d)) return [0, 0];
    if (Math.abs(d) > 2147483647 + 3) return [d < 0 ? -1 : 1, 0];
    const exponent = Math.max(Math.floor(Math.log2(Math.abs(d))), 0); // exponente de frexp(d) - 1
    const den = 1n << BigInt(61 - exponent);
    const num = BigInt(Math.floor(d * Number(den) + 0.5));
    let [n, q] = _av_reduce(num, den, BigInt(max));
    if ((!n || !q) && d && max > 0 && max < 2147483647) [n, q] = _av_reduce(num, den, 2147483647n);
    return [Number(n), Number(q)];
}

function _std_framerate(i) {
    /** get_std_framerate de libavformat (en unidades de 1/(12*1001) fps) */
    if (i < 30 * 12) return (i + 1) * 1001;
    i -= 30 * 12;
    if (i < 30) return (i + 31) * 1001 * 12;
    i -= 30;
    if (i < 3) return [80, 120, 240][i] * 1001 * 12;
    i -= 3;
    return [24, 30, 60, 12, 15, 48][i] * 1000 * 12;
}
const _MAX_STD_TIMEBASES = 30 * 12 + 30 + 3 + 6;

function _round_std_fps(fps, max_error = 0.01) {
    /** Como ffmpeg: usa el fps "estándar" más cercano si está a menos de 1%. */
    const [n, d] = _av_d2q(fps, 60000);
    const q = n / d;
    let best = 0, best_error = max_error;
    for (let j = 0; j < _MAX_STD_TIMEBASES; j++) {
        const std = _std_framerate(j) / (12 * 1001);
        const error = Math.abs(q / std - 1);
        if (error < best_error) {
            best_error = error;
            best = _std_framerate(j);
        }
    }
    return best ? best / (12 * 1001) : fps;
}

async function _video_stats(mb, input, track) {
    /**
     * fps y número de frames como cv2 (avg_frame_rate de ffmpeg):
     * - mp4/mov: frames / duración total (ffmpeg lo calcula con enteros; aquí
     *   se quita el ruido de coma flotante si es un fps estándar, como 30000/1001).
     * - Matroska/WebM: los timestamps están redondeados a ms, así que el
     *   promedio se lleva al fps estándar más cercano (como ffmpeg).
     */
    const sink = new mb.EncodedPacketSink(track);
    let count = 0, start = Infinity, end = -Infinity;
    for await (const p of sink.packets(undefined, undefined, { metadataOnly: true })) {
        count += 1;
        start = Math.min(start, p.timestamp);
        end = Math.max(end, p.timestamp + p.duration);
    }
    let fps = count && end > start ? count / (end - start) : 0;
    if (fps) {
        const mkv = (await input.getFormat()) instanceof mb.MatroskaInputFormat;
        fps = _round_std_fps(fps, mkv ? 0.01 : 1e-9);
    }
    return { fps: fps || 30.0, frame_count: count };
}

// ======================
// RENDERER
// ======================

export class Renderer {
    /** Renderizador WebGL2 (port de Renderer de escritorio). Crear con Renderer.create(). */

    constructor(gl, pixel_ratio = 1.0) {
        this.gl = gl;
        this.ctx = new GLContext(gl);
        this.pixel_ratio = pixel_ratio;
        this._init_pipeline();
        this._init_preview();

        this.start_time = monotonic();
        this.mouse_x = 0.0;
        this.mouse_y = 0.0;

        // Video playback
        this._video = null;            // { input, track, sink, file }
        this._video_fps = 30.0;
        this._video_frame_count = 0;
        this._video_current_frame = 0;
        this._video_playing = false;
        this._video_start_time = 0.0;
        this._video_width = 0;
        this._video_height = 0;
        this._video_path = "";
        this._video_iter = null;
        this._video_busy = null;
        this._video_canvas = null;

        // Batches reutilizables
        this._rect_batch = new BatchBuilder();
        this._text_batch = new BatchBuilder();

        // Glyph atlas cache: "font_px|role" -> _GlyphAtlas
        this._atlases = new Map();
        this._current_atlas = null;

        // Cache para _get_font_px
        this._font_px_cache = new Map();

        // Si llega NotoSansJP completo, re-rasterizar el texto
        _cjk_listeners.push(() => this._reset_atlases());
    }

    static async create(gl, pixel_ratio = 1.0) {
        const r = new Renderer(gl, pixel_ratio);
        await r._load_channel0();
        return r;
    }

    _reset_atlases() {
        for (const atlas of this._atlases.values()) atlas.release();
        this._atlases.clear();
        _font_cache.clear();
    }

    _init_pipeline() {
        /** Inicializa el pipeline gráfico. */
        const gl = this.gl;
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        this.prog = new Program(gl, BATCH_VS, BATCH_FS);

        const buf_size = MAX_QUADS * VERTS_PER_QUAD * FLOATS_PER_VERT * 4;
        this._buf = gl.createBuffer();
        this._buf_size = buf_size;
        gl.bindBuffer(gl.ARRAY_BUFFER, this._buf);
        gl.bufferData(gl.ARRAY_BUFFER, buf_size, gl.DYNAMIC_DRAW);

        this._vao = gl.createVertexArray();
        gl.bindVertexArray(this._vao);
        const stride = FLOATS_PER_VERT * 4;
        const attrs = [["in_pos", 2, 0], ["in_uv", 2, 2], ["in_color", 4, 4], ["in_sdf_size", 1, 8], ["in_effect", 1, 9]];
        for (const [name, size, off] of attrs) {
            const loc = gl.getAttribLocation(this.prog.prog, name);
            if (loc < 0) continue;
            gl.enableVertexAttribArray(loc);
            gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, off * 4);
        }
        gl.bindVertexArray(null);
    }

    _quad_vao(prog) {
        const gl = this.gl;
        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.preview_vbo);
        const loc = gl.getAttribLocation(prog.prog, "in_pos");
        if (loc >= 0) {
            gl.enableVertexAttribArray(loc);
            gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 8, 0);
        }
        gl.bindVertexArray(null);
        return vao;
    }

    _init_preview() {
        /** Inicializa el preview shader. */
        const gl = this.gl;
        this.preview_prog = null;
        this.preview_vao = null;
        this.preview_error = null;

        this.preview_vbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.preview_vbo);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

        // FBO del preview: el shader se renderiza aquí para que gl_FragCoord
        // empiece en (0, 0) del preview (igual que en la exportación)
        this.blit_prog = new Program(gl, PREVIEW_VS, BLIT_FS);
        this.blit_vao = this._quad_vao(this.blit_prog);
        this._preview_tex = null;
        this._preview_fbo = null;
        this._preview_size = [0, 0];
        this.last_error = "";

        this.channel0_tex = null;
        this._compile_preview(DEFAULT_PREVIEW_FS);
    }

    _new_texture(filter = "linear") {
        const gl = this.gl;
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        const f = filter === "nearest" ? gl.NEAREST : gl.LINEAR;
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
        return tex;
    }

    _upload_image(tex, image, mipmaps) {
        /** Sube una imagen volteada en Y (como ImageOps.flip + texture de escritorio). */
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        // ImageBitmap ya viene volteado (_decode_image) y WebGL ignora UNPACK_*
        // con ImageBitmap; el resto se voltea aquí
        const is_bitmap = typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap;
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, !is_bitmap);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        if (mipmaps) gl.generateMipmap(gl.TEXTURE_2D);
    }

    async _load_channel0() {
        /** Carga test_assets/test.png como iChannel0. */
        try {
            const res = await fetch("test_assets/test.png");
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const img = await _decode_image(this.gl, await res.blob(), "test.png");
            const tex = this._new_texture();
            this._upload_image(tex, img, true);
            this.channel0_tex = tex;
        } catch (e) {
            console.log(`[renderer] ${_("error_load_channel", String(e))}`);
        }
    }

    async load_texture(file) {
        /** Carga una imagen (File/Blob) como iChannel0. */
        try {
            const img = await _decode_image(this.gl, file, file.name || "");
            const tex = this._new_texture();
            this._upload_image(tex, img, true);
            if (this.channel0_tex) this.gl.deleteTexture(this.channel0_tex);
            this.channel0_tex = tex;
            return true;
        } catch (e) {
            this.last_error = String(e && e.message ? e.message : e);
            console.log(`[renderer] ${_("error_load_texture", file.name || "", this.last_error)}`);
            return false;
        }
    }

    // ---- Video support ----

    async load_video(file) {
        /** Carga un video (File) como iChannel0 animado. */
        let input = null;
        try {
            const mb = await _mb();
            input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
            const track = await input.getPrimaryVideoTrack();
            if (!track || !(await track.canDecode())) {
                input.dispose?.();
                return false;
            }
            const stats = await _video_stats(mb, input, track);

            await this.close_video();

            this._video = { input, track, sink: new mb.VideoSampleSink(track), file };
            this._video_fps = stats.fps;
            this._video_frame_count = stats.frame_count;
            this._video_width = await track.getDisplayWidth?.() ?? track.displayWidth;
            this._video_height = await track.getDisplayHeight?.() ?? track.displayHeight;
            this._video_current_frame = 0;
            this._video_playing = true;
            this._video_start_time = monotonic();
            this._video_path = file.name || "";

            await this._advance_video_frame();
            return true;
        } catch (e) {
            console.log(`[renderer] ${e}`);
            try { input?.dispose?.(); } catch (_e) { /* nada */ }
            return false;
        }
    }

    _upload_video_sample(sample) {
        const w = sample.displayWidth, h = sample.displayHeight;
        if (!this._video_canvas || this._video_canvas.width !== w || this._video_canvas.height !== h) {
            this._video_canvas = typeof OffscreenCanvas !== "undefined"
                ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h });
        }
        const c2d = this._video_canvas.getContext("2d");
        c2d.clearRect(0, 0, w, h);
        sample.draw(c2d, 0, 0);
        if (!this.channel0_tex || this._channel0_is_video !== `${w}x${h}`) {
            if (this.channel0_tex) this.gl.deleteTexture(this.channel0_tex);
            this.channel0_tex = this._new_texture();
            this._channel0_is_video = `${w}x${h}`;
        }
        this._upload_image(this.channel0_tex, this._video_canvas, false);
    }

    async _advance_video_frame() {
        /** Lee el siguiente frame del video y lo sube como iChannel0. */
        const v = this._video;
        if (!v) return;
        if (!this._video_iter) {
            this._video_iter = v.sink.samples(this._video_current_frame / this._video_fps);
        }
        let r = await this._video_iter.next();
        if (r.done) {
            this._video_iter = v.sink.samples(0);
            this._video_current_frame = 0;
            r = await this._video_iter.next();
            if (r.done) return;
        }
        if (this._video !== v) {
            r.value.close();
            return;
        }
        this._upload_video_sample(r.value);
        r.value.close();
        this._video_current_frame += 1;
    }

    update_video() {
        /** Avanza el video según el tiempo. Llamar una vez por frame. */
        if (!this._video || !this._video_playing || this._video_busy) return;
        const elapsed = monotonic() - this._video_start_time;
        const n = Math.max(1, this._video_frame_count);
        const target = pyInt(elapsed * this._video_fps) % n;
        const cur = this._video_current_frame % n;
        if (target !== cur) {
            if (Math.abs(target - cur) > 2) {
                if (this._video_iter) this._video_iter.return?.();
                this._video_iter = null;
                this._video_current_frame = target;
            }
            this._video_busy = this._advance_video_frame()
                .catch((e) => console.log(`[renderer] video: ${e}`))
                .finally(() => { this._video_busy = null; });
        }
    }

    has_video() {
        return this._video !== null;
    }

    video_playing() {
        return this._video_playing;
    }

    video_toggle_play() {
        if (!this._video) return;
        this._video_playing = !this._video_playing;
        if (this._video_playing) {
            this._video_start_time = monotonic() - this._video_current_frame / Math.max(1, this._video_fps);
        }
    }

    video_time() {
        if (!this._video) return 0.0;
        return this._video_current_frame / Math.max(1, this._video_fps);
    }

    video_duration() {
        if (!this._video) return 0.0;
        return this._video_frame_count / Math.max(1, this._video_fps);
    }

    async close_video() {
        if (this._video) {
            const v = this._video;
            this._video = null;
            this._video_playing = false;
            try { this._video_iter?.return?.(); } catch (_e) { /* nada */ }
            this._video_iter = null;
            try { v.input.dispose?.(); } catch (_e) { /* nada */ }
        }
    }

    // ---- Export support ----

    _render_export_frame(fbo, width, height, time_val, mouse_x, mouse_y, channel_tex) {
        /** Dibuja el shader en el FBO de exportación (con blending, como escritorio). */
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        this.ctx.viewport = [0, 0, width, height];
        const prog = this.preview_prog;
        gl.useProgram(prog.prog);
        if (prog.has("iTime")) prog.set("iTime", time_val);
        if (prog.has("iResolution")) prog.set("iResolution", width, height);
        if (prog.has("iMouse")) prog.set("iMouse", mouse_x, mouse_y);
        if (channel_tex && prog.has("iChannel0")) {
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, channel_tex);
            prog.set("iChannel0", 0);
        }
        gl.bindVertexArray(this.preview_vao);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindVertexArray(null);
    }

    _create_fbo(width, height) {
        const gl = this.gl;
        const tex = this._new_texture();
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        const fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        return { fbo, tex };
    }

    _read_fbo_top_down(width, height, out = null) {
        /** fbo.read(components=4) + flip vertical: filas de arriba hacia abajo */
        const gl = this.gl;
        const raw = new Uint8Array(width * height * 4);
        gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, raw);
        const res = out || new Uint8Array(width * height * 4);
        const row = width * 4;
        for (let y = 0; y < height; y++) {
            res.set(raw.subarray((height - 1 - y) * row, (height - y) * row), y * row);
        }
        return res;
    }

    render_to_image(width, height, time_val = 0.0, mouse_x = 0.0, mouse_y = 0.0) {
        /** Renderiza el shader actual a una imagen RGBA (Uint8Array, filas arriba-abajo). */
        if (!this.preview_prog) return null;
        const gl = this.gl;
        const { fbo, tex } = this._create_fbo(width, height);
        this._render_export_frame(fbo, width, height, time_val, mouse_x, mouse_y, this.channel0_tex);
        const data = this._read_fbo_top_down(width, height);
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(tex);
        this.ctx.screen.use();
        return data;
    }

    async export_image(width, height, time_val = 0.0, mouse_x = 0.0, mouse_y = 0.0) {
        /** Exporta la salida del shader como PNG. Retorna un Blob o null. */
        const data = this.render_to_image(width, height, time_val, mouse_x, mouse_y);
        if (!data) return null;
        const canvas = typeof OffscreenCanvas !== "undefined"
            ? new OffscreenCanvas(width, height) : Object.assign(document.createElement("canvas"), { width, height });
        const c2d = canvas.getContext("2d");
        c2d.putImageData(new ImageData(new Uint8ClampedArray(data.buffer), width, height), 0, 0);
        if (canvas.convertToBlob) return await canvas.convertToBlob({ type: "image/png" });
        return await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    }

    async _make_video_output(width, height, fps) {
        const mb = await _mb();
        const codec = await mb.getFirstEncodableVideoCodec(["avc", "vp9", "av1", "hevc"],
                                                           { width, height, frameRate: fps, quality: mb.QUALITY_HIGH });
        if (!codec) throw new Error("No hay un codec de video disponible en este navegador");
        const target = new mb.BufferTarget();
        const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: "in-memory" }), target });
        const source = new mb.VideoSampleSource({ codec, quality: mb.QUALITY_HIGH });
        output.addVideoTrack(source, { frameRate: fps });
        await output.start();
        return { mb, output, source, target };
    }

    async _encode_frame(enc, data, width, height, timestamp, duration) {
        const sample = new enc.mb.VideoSample(data, {
            format: "RGBX", codedWidth: width, codedHeight: height, timestamp, duration,
        });
        try {
            await enc.source.add(sample);
        } finally {
            sample.close();
        }
    }

    async export_video(width, height, fps = 30.0, duration = 10.0, mouse_x = 0.0, mouse_y = 0.0, progress_cb = null) {
        /** Exporta la animación del shader como video MP4 (sin video de entrada). Retorna Blob o null. */
        if (!this.preview_prog) return null;
        let enc;
        try {
            enc = await this._make_video_output(width, height, fps);
        } catch (e) {
            console.log(`[renderer] ${e}`);
            return null;
        }
        const gl = this.gl;
        const { fbo, tex } = this._create_fbo(width, height);
        const total_frames = pyInt(duration * fps);
        const frame = new Uint8Array(width * height * 4);
        try {
            for (let i = 0; i < total_frames; i++) {
                const t = i / fps;
                this._render_export_frame(fbo, width, height, t, mouse_x, mouse_y, this.channel0_tex);
                this._read_fbo_top_down(width, height, frame);
                this.ctx.screen.use();
                await this._encode_frame(enc, frame, width, height, t, 1 / fps);
                if (progress_cb) progress_cb(i + 1, total_frames);
            }
            await enc.output.finalize();
        } catch (e) {
            console.log(`[renderer] ${e}`);
            try { await enc.output.cancel(); } catch (_e) { /* nada */ }
            return null;
        } finally {
            gl.deleteFramebuffer(fbo);
            gl.deleteTexture(tex);
            this.ctx.screen.use();
        }
        return new Blob([enc.target.buffer], { type: "video/mp4" });
    }

    async export_video_filtered(file, width, height, mouse_x = 0.0, mouse_y = 0.0, progress_cb = null) {
        /** Exporta el video de entrada con el shader aplicado a cada frame. Retorna Blob o null. */
        if (!this.preview_prog) return null;
        let input = null;
        let enc = null;
        const gl = this.gl;
        const { fbo, tex } = this._create_fbo(width, height);
        const src_tex = this._new_texture();
        let canvas = null;
        try {
            const mb = await _mb();
            input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
            const track = await input.getPrimaryVideoTrack();
            if (!track) return null;
            const { fps, frame_count } = await _video_stats(mb, input, track);
            enc = await this._make_video_output(width, height, fps);
            const sink = new mb.VideoSampleSink(track);
            const frame = new Uint8Array(width * height * 4);

            let i = 0;
            for await (const sample of sink.samples()) {
                if (i >= frame_count) {
                    sample.close();
                    break;
                }
                const w = sample.displayWidth, h = sample.displayHeight;
                if (!canvas || canvas.width !== w || canvas.height !== h) {
                    canvas = typeof OffscreenCanvas !== "undefined"
                        ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h });
                }
                const c2d = canvas.getContext("2d");
                c2d.clearRect(0, 0, w, h);
                sample.draw(c2d, 0, 0);
                sample.close();
                this._upload_image(src_tex, canvas, false);

                const t = i / fps;
                this._render_export_frame(fbo, width, height, t, mouse_x, mouse_y, src_tex);
                this._read_fbo_top_down(width, height, frame);
                this.ctx.screen.use();
                await this._encode_frame(enc, frame, width, height, t, 1 / fps);
                i += 1;
                if (progress_cb) progress_cb(i, frame_count);
            }
            await enc.output.finalize();
        } catch (e) {
            console.log(`[renderer] ${e}`);
            try { await enc?.output.cancel(); } catch (_e) { /* nada */ }
            return null;
        } finally {
            try { input?.dispose?.(); } catch (_e) { /* nada */ }
            gl.deleteFramebuffer(fbo);
            gl.deleteTexture(tex);
            gl.deleteTexture(src_tex);
            this.ctx.screen.use();
        }
        return new Blob([enc.target.buffer], { type: "video/mp4" });
    }

    _compile_preview(frag_src) {
        /** Compila y valida el shader de preview. Retorna el error o null. */
        try {
            const prog = new Program(this.gl, PREVIEW_VS, frag_src);
            if (this.preview_prog) this.preview_prog.release();
            if (this.preview_vao) this.gl.deleteVertexArray(this.preview_vao);
            this.preview_prog = prog;
            this.preview_vao = this._quad_vao(prog);
            this.preview_error = null;
            return null;
        } catch (e) {
            this.preview_error = String(e.message || e);
            return this.preview_error;
        }
    }

    compile_shader(source) {
        /** Compila un shader de preview. */
        return this._compile_preview(source);
    }

    _ortho(w, h) {
        /** Genera matriz de proyección ortográfica (column-major). */
        return new Float32Array([
            2.0 / w, 0, 0, 0,
            0, -2.0 / h, 0, 0,
            0, 0, -1, 0,
            -1, 1, 0, 1,
        ]);
    }

    _draw_batch(batch, proj, use_tex, tex = null) {
        const gl = this.gl;
        const data = batch.get_array();
        gl.useProgram(this.prog.prog);
        this.prog.set("u_proj", proj);
        this.prog.set("u_use_tex", use_tex);
        if (tex) {
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, tex);
            this.prog.set("u_tex", 0);
        }
        gl.bindVertexArray(this._vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this._buf);
        // Escritorio escribe todo el batch en un buffer de MAX_QUADS; si el batch
        // es más grande, aquí se dibuja en partes en vez de fallar.
        const per = MAX_QUADS * VERTS_PER_QUAD * FLOATS_PER_VERT;
        for (let off = 0; off < data.length; off += per) {
            const chunk = data.subarray(off, Math.min(off + per, data.length));
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, chunk);
            gl.drawArrays(gl.TRIANGLES, 0, chunk.length / FLOATS_PER_VERT);
        }
        gl.bindVertexArray(null);
        batch.clear();
    }

    _flush_batch(batch, proj, use_tex) {
        /** Renderiza un batch de UI sin textura. */
        if (batch.quad_count === 0) return;
        this._draw_batch(batch, proj, use_tex);
    }

    _flush_batch_with_tex(batch, proj, tex) {
        /** Renderiza un batch de texto con la textura del atlas. */
        if (batch.quad_count === 0) return;
        this._draw_batch(batch, proj, 1, tex);
    }

    _get_font_px(scale, font_role = "ui") {
        /** Calcula el tamaño de fuente en píxeles para un scale dado. */
        const cell_h = pyInt(FONT_CHAR_H * scale * this.pixel_ratio);
        const key = `${cell_h}|${font_role}`;
        const cached = this._font_px_cache.get(key);
        if (cached !== undefined) return cached;
        const probe = font_role === "mono" ? _fonts.latin_mono : _fonts.latin_ui;
        const result = _fit_font_height(probe, cell_h);
        this._font_px_cache.set(key, result);
        return result;
    }

    _get_atlas(font_px, font_role = "ui") {
        /** Obtiene o crea un atlas de glifos para el tamaño dado. */
        const key = `${font_px}|${font_role}`;
        let atlas = this._atlases.get(key);
        if (atlas) return atlas;
        atlas = new _GlyphAtlas(this.gl, font_px, this.pixel_ratio, font_role);
        this._atlases.set(key, atlas);
        return atlas;
    }

    measure_text(text, scale = 1.0, font_role = "ui") {
        /** Devuelve [width, height] lógicos del texto sin renderizar a GPU. */
        if (!text) return [0.0, 0.0];
        const atlas = this._get_atlas(this._get_font_px(scale, font_role), font_role);
        return atlas.measure_text(text);
    }

    text_centered_y(box_y, box_h, scale = 1.0, font_role = "ui") {
        /** Y a pasar a draw_text para centrar el texto visualmente en un box. */
        const atlas = this._get_atlas(this._get_font_px(scale, font_role), font_role);
        const glyph = atlas.get_glyph("A");
        const line_h_eighth = -atlas.line_height / 8;
        return box_y + (box_h - glyph.log_h) / 2 - glyph.bear_y - line_h_eighth;
    }

    draw_rect(x, y, w, h, color, proj) {
        /** Dibuja un rectángulo simple. */
        this._rect_batch.clear();
        this._rect_batch.add_rect(x, y, w, h, color[0], color[1], color[2], color[3]);
        this._flush_batch(this._rect_batch, proj, 0);
    }

    draw_rounded_rect(x, y, w, h, radius, color, proj) {
        /** Dibuja un rectángulo con esquinas redondeadas. */
        const r = Math.min(radius, w / 2, h / 2);
        if (r < 1) return this.draw_rect(x, y, w, h, color, proj);
        this._rect_batch.clear();
        const [cr, cg, cb, ca] = color;
        this._rect_batch.add_rect(x + r, y, w - 2 * r, h, cr, cg, cb, ca);
        this._rect_batch.add_rect(x, y + r, r, h - 2 * r, cr, cg, cb, ca);
        this._rect_batch.add_rect(x + w - r, y + r, r, h - 2 * r, cr, cg, cb, ca);
        const steps = Math.max(6, pyInt(r));
        const corners = [
            [x + r,     y + r,     Math.PI,       Math.PI * 1.5],
            [x + w - r, y + r,     Math.PI * 1.5, Math.PI * 2.0],
            [x + w - r, y + h - r, 0.0,           Math.PI * 0.5],
            [x + r,     y + h - r, Math.PI * 0.5, Math.PI],
        ];
        for (const [cx, cy, a_start, a_end] of corners) {
            for (let i = 0; i < steps; i++) {
                const a0 = a_start + (a_end - a_start) * i / steps;
                const a1 = a_start + (a_end - a_start) * (i + 1) / steps;
                this._rect_batch.add_tri(
                    cx, cy,
                    cx + Math.cos(a0) * r, cy + Math.sin(a0) * r,
                    cx + Math.cos(a1) * r, cy + Math.sin(a1) * r,
                    cr, cg, cb, ca,
                );
            }
        }
        this._flush_batch(this._rect_batch, proj, 0);
    }

    draw_char(x, y, ch, color, proj, scale = 1.0, font_role = "ui") {
        /** Dibuja un carácter individual. */
        if (!ch) return 0.0;
        return this.draw_text(x, y, ch, color, proj, scale, font_role);
    }

    is_cjka(char) {
        const code = char.codePointAt(0);
        return (
            (code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF) ||
            (code >= 0x20000 && code <= 0x2A6DF) ||
            (code >= 0x3040 && code <= 0x309F) || (code >= 0x30A0 && code <= 0x30FF) ||
            (code >= 0xAC00 && code <= 0xD7AF) ||
            _is_arabic(code)
        );
    }

    draw_text(x, y, text, color, proj, scale = 1.0, font_role = "ui") {
        /** Renderiza texto. Retorna el ancho lógico del texto renderizado. */
        if (!text) return 0.0;

        const atlas = this._get_atlas(this._get_font_px(scale, font_role), font_role);
        const [r, g, b, a] = color;

        this._text_batch.clear();
        let pen_x = x;

        // Centrado vertical: ajuste mínimo
        const line_height_eighth = -atlas.line_height / 8;
        const sdf_size = Math.max(1.0, scale / 1.5);

        for (const ch of text) {
            const glyph = atlas.get_glyph(ch);
            if (glyph.log_w > 0) {
                const qx = pen_x + glyph.bear_x;
                const qy = y + glyph.bear_y + line_height_eighth;
                this._text_batch.add_rect_uv(
                    qx, qy, glyph.log_w, glyph.log_h,
                    glyph.u0, glyph.v0, glyph.u1, glyph.v1,
                    r, g, b, a, sdf_size, 0.0,
                );
            }
            pen_x += glyph.advance;
        }

        const tex = atlas.get_texture();
        this._flush_batch_with_tex(this._text_batch, proj, tex);

        return pen_x - x;
    }

    begin_rects() {
        /** Inicia un batch de rectángulos. */
        this._rect_batch.clear();
    }

    batch_rect(x, y, w, h, color) {
        /** Agrega un rectángulo al batch actual. */
        this._rect_batch.add_rect(x, y, w, h, color[0], color[1], color[2], color[3]);
    }

    batch_quad(x0, y0, x1, y1, x2, y2, x3, y3, color) {
        /** Agrega un quad al batch actual. */
        this._rect_batch.add_quad(x0, y0, x1, y1, x2, y2, x3, y3, color[0], color[1], color[2], color[3]);
    }

    batch_tri(x0, y0, x1, y1, x2, y2, color) {
        /** Agrega un triángulo al batch actual. */
        this._rect_batch.add_tri(x0, y0, x1, y1, x2, y2, color[0], color[1], color[2], color[3]);
    }

    flush_rects(proj) {
        /** Renderiza todos los rectángulos batched. */
        this._flush_batch(this._rect_batch, proj, 0);
    }

    begin_text() {
        /** Inicia un batch de texto. */
        this._text_batch.clear();
        this._current_atlas = null;
    }

    batch_char(x, y, ch_code, scale, color, font_role = "ui") {
        /** Agrega un carácter al batch de texto actual. */
        let ch;
        try {
            ch = String.fromCodePoint(ch_code);
        } catch (e) {
            return;
        }

        const atlas = this._get_atlas(this._get_font_px(scale, font_role), font_role);
        this._current_atlas = atlas;

        const glyph = atlas.get_glyph(ch);
        if (glyph.log_w > 0) {
            const [r, g, b, a] = color;
            const qx = x + glyph.bear_x;
            // Centrado vertical: ajuste mínimo
            const line_height_eighth = atlas.line_height / 8;
            const qy = y + glyph.bear_y + line_height_eighth;
            const sdf_size = Math.max(1.0, scale / 1.5);
            this._text_batch.add_rect_uv(
                qx, qy, glyph.log_w, glyph.log_h,
                glyph.u0, glyph.v0, glyph.u1, glyph.v1,
                r, g, b, a, sdf_size, 0.0,
            );
        }
    }

    flush_text(proj) {
        /** Renderiza todo el texto batched. */
        if (this._text_batch.quad_count === 0 || this._current_atlas === null) {
            this._text_batch.clear();
            this._current_atlas = null;
            return;
        }
        const tex = this._current_atlas.get_texture();
        this._flush_batch_with_tex(this._text_batch, proj, tex);
        this._current_atlas = null;
    }

    render_preview(x, y, w, h, fb_width, fb_height) {
        /**
         * Renderiza el preview del shader en una región.
         * El shader se dibuja primero en un FBO del tamaño del preview, así
         * gl_FragCoord va de (0, 0) a (w, h) igual que en la exportación.
         * Después el FBO se compone en pantalla con blending.
         */
        if (!this.preview_prog) return;
        const gl = this.gl;

        const vx = pyInt(x), vy = pyInt(fb_height - y - h), vw = pyInt(w), vh = pyInt(h);
        if (vw <= 0 || vh <= 0) return;

        if (this._preview_size[0] !== vw || this._preview_size[1] !== vh) {
            if (this._preview_fbo) gl.deleteFramebuffer(this._preview_fbo);
            if (this._preview_tex) gl.deleteTexture(this._preview_tex);
            const { fbo, tex } = this._create_fbo(vw, vh);
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            this._preview_fbo = fbo;
            this._preview_tex = tex;
            this._preview_size = [vw, vh];
        }

        // 1) Shader del usuario -> FBO (sin blending: se guarda el RGBA tal cual)
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._preview_fbo);
        this.ctx.viewport = [0, 0, vw, vh];
        const old_scissor = this.ctx.scissor;
        if (old_scissor) gl.disable(gl.SCISSOR_TEST);
        gl.clearColor(0.0, 0.0, 0.0, 0.0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.disable(gl.BLEND);

        const prog = this.preview_prog;
        gl.useProgram(prog.prog);
        if (prog.has("iTime")) prog.set("iTime", monotonic() - this.start_time);
        if (prog.has("iResolution")) prog.set("iResolution", vw, vh);
        if (prog.has("iMouse")) prog.set("iMouse", this.mouse_x, this.mouse_y);
        if (this.channel0_tex && prog.has("iChannel0")) {
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.channel0_tex);
            prog.set("iChannel0", 0);
        }
        gl.bindVertexArray(this.preview_vao);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        // 2) FBO -> pantalla (con blending, igual que antes)
        gl.enable(gl.BLEND);
        this.ctx.screen.use();
        if (old_scissor) gl.enable(gl.SCISSOR_TEST);
        this.ctx.viewport = [vx, vy, vw, vh];
        gl.useProgram(this.blit_prog.prog);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this._preview_tex);
        this.blit_prog.set("u_tex", 0);
        gl.bindVertexArray(this.blit_vao);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindVertexArray(null);
    }

    get ui_prog() {
        return this.prog;
    }

    release() {
        /** Libera todos los recursos de GPU. */
        const gl = this.gl;
        this.close_video();
        for (const atlas of this._atlases.values()) atlas.release();
        this._atlases.clear();
        gl.deleteBuffer(this._buf);
        gl.deleteVertexArray(this._vao);
        this.prog.release();
        gl.deleteBuffer(this.preview_vbo);
        if (this.channel0_tex) gl.deleteTexture(this.channel0_tex);
        if (this.preview_prog) this.preview_prog.release();
        if (this._preview_fbo) gl.deleteFramebuffer(this._preview_fbo);
        if (this._preview_tex) gl.deleteTexture(this._preview_tex);
        gl.deleteVertexArray(this.blit_vao);
        this.blit_prog.release();
    }
}

export { FontInfo };

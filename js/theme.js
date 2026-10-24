// Port de theme.py: parser de temas .glst y clase Theme.
// Colores: arrays [r, g, b] (0..255), como las tuplas de Python.

import { PY_WS_CLASS, pyParseInt } from "./pyutil.js";

// ======================
// CONFIG
// ======================

export const THEME_EXT = ".glst";

export const DEFAULT_COLORS = {
    "editor.bg":              [30, 30, 46],
    "editor.fg":              [205, 214, 244],
    "editor.cursor":          [245, 224, 220],
    "editor.selection":       [88, 91, 112],
    "editor.line-highlight":  [49, 50, 68],
    "editor.font-size":       14,
    "editor.line-height":     20,

    "gutter.bg":              [24, 24, 37],
    "gutter.fg":              [108, 112, 134],
    "gutter.border":          [49, 50, 68],
    "gutter.width":           50,

    "preview.bg":             [17, 17, 27],
    "preview.border":         [49, 50, 68],

    "toolbar.bg":             [24, 24, 37],
    "toolbar.fg":             [205, 214, 244],
    "toolbar.border":         [49, 50, 68],
    "toolbar.height":         30,

    "status.bg":              [24, 24, 37],
    "status.fg":              [166, 173, 200],
    "status.error":           [243, 139, 168],
    "status.success":         [166, 227, 161],
    "status.height":          24,

    "scrollbar.bg":           [30, 30, 46],
    "scrollbar.thumb":        [88, 91, 112],
    "scrollbar.width":        12,

    "syntax.keyword":         [203, 166, 247],
    "syntax.type":            [137, 220, 235],
    "syntax.number":          [250, 179, 135],
    "syntax.string":          [166, 227, 161],
    "syntax.comment":         [108, 112, 134],
    "syntax.function":        [137, 180, 250],
    "syntax.preprocessor":    [243, 139, 168],
    "syntax.operator":        [148, 226, 213],
    "syntax.builtin":         [245, 194, 231],
    "syntax.identifier":      [205, 214, 244],
    "syntax.swizzle":         [249, 226, 175],

    "tab.bg":                 [24, 24, 37],
    "tab.active-bg":          [30, 30, 46],
    "tab.fg":                 [108, 112, 134],
    "tab.active-fg":          [205, 214, 244],
    "tab.border":             [49, 50, 68],
    "tab.height":             28,

    // Node editor
    "node.bg":                [40, 40, 55],
    "node.header":            [60, 60, 80],
    "node.fg":                [220, 220, 230],
    "node.border":            [70, 70, 90],
    "node.selection":         [242, 191, 51],
    "node.shadow":            [0, 0, 0],
    "node.grid-bg":           [25, 25, 33],
    "node.grid-line":         [31, 31, 41],
    "node.grid-major":        [38, 38, 51],
    "node.border-radius":     6,

    // Context menus
    "menu.bg":                [38, 38, 51],
    "menu.fg":                [217, 217, 230],
    "menu.hover":             [71, 89, 128],
    "menu.border":            [77, 77, 102],
    "menu.separator":         [64, 64, 89],
    "menu.category":          [153, 179, 217],
    "menu.shortcut":          [166, 179, 204],
    "menu.shadow":            [0, 0, 0],
    "menu.border-radius":     8,
    "menu.scroll-indicator":        2,           // 0=none, 1=line, 2=blur
    "menu.scroll-indicator-tint":   [38, 38, 51],  // matches menu.bg by default
    "menu.scroll-indicator-opacity": 85,         // 0-100
    "menu.scroll-indicator-height": 28,          // px for blur zone
    "menu.scroll-indicator-size":   2,           // px line thickness (mode 1)

    // Theme picker
    "picker.bg":              [30, 30, 46],
    "picker.fg":              [205, 214, 244],
    "picker.hover":           [71, 89, 128],
    "picker.active":          [88, 91, 112],
    "picker.border":          [49, 50, 68],
    "picker.border-radius":   10,

    // Global border radius
    "ui.border-radius":       4,
};

// Propiedades que son números, no colores
export const NUMERIC_PROPS = new Set([
    "editor.font-size", "editor.line-height",
    "gutter.width",
    "toolbar.height",
    "status.height",
    "scrollbar.width",
    "tab.height",
    "node.border-radius",
    "menu.border-radius",
    "menu.scroll-indicator",
    "menu.scroll-indicator-opacity",
    "menu.scroll-indicator-height",
    "menu.scroll-indicator-size",
    "picker.border-radius",
    "ui.border-radius",
]);

// Regex para tokens del parser (sticky = re.match en una posición)
const _RE_COMMENT = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;
const _RE_HEX     = /#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})/y;
const _RE_NUMBER  = /\p{Nd}+/uy;
const _RE_BOOL    = /(?<![\p{L}\p{N}_])(true|false)(?![\p{L}\p{N}_])/uy;
const _RE_IDENT   = /[a-zA-Z_][\p{L}\p{N}_-]*/uy;
const _RE_WS      = new RegExp(`[${PY_WS_CLASS}]+`, "uy");

function match(re, text, pos) {
    re.lastIndex = pos;
    return re.exec(text);
}

// ======================
// UTILS
// ======================

export function hex_to_rgb(h) {
    h = h.replace(/^#+/, "");
    if (h.length === 3) {
        h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    }
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function rgb_to_hex(r, g, b) {
    const h = (v) => v.toString(16).padStart(2, "0");
    return `#${h(r)}${h(g)}${h(b)}`;
}

export function normalize_color(value) {
    if (Array.isArray(value) && value.length === 3) return value;
    if (typeof value === "string") return hex_to_rgb(value);
    throw new Error(`Color inválido: ${value}`);
}

export function color_to_vec4(rgb, alpha = 1.0) {
    return [rgb[0] / 255.0, rgb[1] / 255.0, rgb[2] / 255.0, alpha];
}

export function lerp_color(a, b, t) {
    return [0, 1, 2].map((i) => Math.trunc(a[i] + (b[i] - a[i]) * t));
}

// ======================
// PARSER
// ======================

function _strip_comments(text) {
    return text.replace(_RE_COMMENT, "");
}

function _int(digits) {
    // int() de Python acepta cualquier dígito Unicode decimal
    return pyParseInt(digits);
}

export class SyntaxError_ extends Error {
    constructor(message) {
        super(message);
        this.name = "SyntaxError";
    }
}

export function parse(text) {
    text = _strip_comments(text);
    const props = {};
    let pos = 0;
    const length = text.length;
    let m;

    while (pos < length) {
        // Saltar espacios
        m = match(_RE_WS, text, pos);
        if (m) {
            pos = _RE_WS.lastIndex;
            continue;
        }

        if (pos >= length) break;

        // Selector: "editor", "syntax.keyword", etc.
        m = match(_RE_IDENT, text, pos);
        if (!m) {
            throw new SyntaxError_(`Token inesperado en posición ${pos}: '${text.slice(pos, pos + 20)}'`);
        }

        let selector = m[0];
        pos = _RE_IDENT.lastIndex;

        // Subselector con punto
        while (pos < length && text[pos] === ".") {
            pos += 1;
            m = match(_RE_IDENT, text, pos);
            if (!m) {
                throw new SyntaxError_(`Subselector esperado en posición ${pos}`);
            }
            selector += "." + m[0];
            pos = _RE_IDENT.lastIndex;
        }

        // Saltar espacios
        m = match(_RE_WS, text, pos);
        if (m) pos = _RE_WS.lastIndex;

        // Llave de apertura
        if (pos >= length || text[pos] !== "{") {
            throw new SyntaxError_(`'{' esperado en posición ${pos}`);
        }
        pos += 1;

        // Propiedades dentro del bloque
        while (pos < length) {
            m = match(_RE_WS, text, pos);
            if (m) pos = _RE_WS.lastIndex;

            if (pos >= length) break;

            if (text[pos] === "}") {
                pos += 1;
                break;
            }

            // Nombre de propiedad
            m = match(_RE_IDENT, text, pos);
            if (!m) {
                throw new SyntaxError_(`Propiedad esperada en posición ${pos}: '${text.slice(pos, pos + 20)}'`);
            }

            const prop_name = m[0];
            pos = _RE_IDENT.lastIndex;

            // Dos puntos
            m = match(_RE_WS, text, pos);
            if (m) pos = _RE_WS.lastIndex;

            if (pos >= length || text[pos] !== ":") {
                throw new SyntaxError_(`':' esperado en posición ${pos}`);
            }
            pos += 1;

            m = match(_RE_WS, text, pos);
            if (m) pos = _RE_WS.lastIndex;

            // Valor
            const full_key = `${selector}.${prop_name}`;

            // Hex color
            m = match(_RE_HEX, text, pos);
            if (m) {
                props[full_key] = hex_to_rgb(m[0]);
                pos = _RE_HEX.lastIndex;
            } else {
                // Boolean
                m = match(_RE_BOOL, text, pos);
                if (m) {
                    props[full_key] = m[0] === "true";
                    pos = _RE_BOOL.lastIndex;
                } else {
                    // Number
                    m = match(_RE_NUMBER, text, pos);
                    if (m) {
                        props[full_key] = _int(m[0]);
                        pos = _RE_NUMBER.lastIndex;
                    } else {
                        throw new SyntaxError_(`Valor inválido en posición ${pos}: '${text.slice(pos, pos + 20)}'`);
                    }
                }
            }

            // Punto y coma opcional
            m = match(_RE_WS, text, pos);
            if (m) pos = _RE_WS.lastIndex;

            if (pos < length && text[pos] === ";") pos += 1;
        }
    }

    return props;
}

// ======================
// THEME
// ======================

function isColor(val) {
    return Array.isArray(val);
}

export class Theme {
    constructor(props = null) {
        this._props = { ...DEFAULT_COLORS };
        if (props) Object.assign(this._props, props);
    }

    get(key, fallback = null) {
        if (Object.prototype.hasOwnProperty.call(this._props, key)) return this._props[key];
        if (fallback !== null && fallback !== undefined) return fallback;
        return null;
    }

    has(key) {
        return Object.prototype.hasOwnProperty.call(this._props, key);
    }

    color(key) {
        const val = this.get(key);
        if (val === null) return [255, 255, 255];
        if (isColor(val)) return val;
        return [255, 255, 255];
    }

    vec4(key, fallback = null, alpha = 1.0) {
        const val = this.get(key);
        if (val === null && fallback !== null && fallback !== undefined) return fallback;
        return color_to_vec4(this.color(key), alpha);
    }

    integer(key, fallback = 0) {
        const val = this.get(key);
        // En Python bool es subclase de int: True cuenta como 1
        if (typeof val === "boolean") return val ? 1 : 0;
        if (typeof val === "number" && Number.isInteger(val)) return val;
        return fallback;
    }

    boolean(key, fallback = false) {
        const val = this.get(key);
        if (typeof val === "boolean") return val;
        return fallback;
    }

    syntax_color(token_type) {
        return this.color(`syntax.${token_type}`);
    }

    syntax_vec4(token_type, alpha = 1.0) {
        return this.vec4(`syntax.${token_type}`, null, alpha);
    }

    syntax_bold(token_type) {
        return this.boolean(`syntax.${token_type}.bold`);
    }

    syntax_italic(token_type) {
        return this.boolean(`syntax.${token_type}.italic`);
    }

    keys() {
        return Object.keys(this._props);
    }

    update(props) {
        Object.assign(this._props, props);
    }

    toString() {
        return `Theme(${Object.keys(this._props).length} propiedades)`;
    }
}

// ======================
// REMAP (aliases CSS -> interno)
// ======================

const _ALIASES = {
    "background":    "bg",
    "foreground":    "fg",
    "color":         "fg",
    "background-color": "bg",
    "border-color":  "border",
    "cursor-color":  "cursor",
    "font-size":     "font-size",
    "line-height":   "line-height",
};

function _remap_key(key) {
    const i = key.lastIndexOf(".");
    if (i >= 0) {
        const prefix = key.slice(0, i);
        const prop = key.slice(i + 1);
        if (prop in _ALIASES) return `${prefix}.${_ALIASES[prop]}`;
    }
    return key;
}

// ======================
// LOAD / SAVE
// ======================

/** load() de escritorio, pero desde el texto del archivo */
export function load_text(text) {
    const raw_props = parse(text);

    // Remapear aliases
    const props = {};
    for (const [k, v] of Object.entries(raw_props)) {
        props[_remap_key(k)] = v;
    }

    return new Theme(props);
}

/** load(path): descarga el .glst y lo parsea */
export async function load(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    return load_text(await res.text());
}

/** save() de escritorio: retorna el texto del .glst en vez de escribir un archivo */
export function save_text(theme) {
    // Agrupar por selector
    const groups = {};
    for (const key of [...theme.keys()].sort()) {
        const i = key.lastIndexOf(".");
        if (i < 0) continue;
        const selector = key.slice(0, i);
        const prop = key.slice(i + 1);
        // Verificar si es sub-propiedad de estilo (bold/italic)
        const j = selector.lastIndexOf(".");
        if (j >= 0 && ["bold", "italic"].includes(selector.slice(j + 1))) {
            const real_selector = selector.slice(0, j);
            const real_prop = selector.slice(j + 1);
            (groups[real_selector] ||= []).push([real_prop, theme.get(key)]);
            continue;
        }
        (groups[selector] ||= []).push([prop, theme.get(key)]);
    }

    const lines = ["/* GLSL Studio Theme */\n"];

    for (const selector of Object.keys(groups).sort()) {
        lines.push(`${selector} {`);
        const entries = groups[selector].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
        for (const [prop, val] of entries) {
            if (Array.isArray(val) && val.length === 3) {
                lines.push(`    ${prop}: ${rgb_to_hex(...val)};`);
            } else if (typeof val === "boolean") {
                lines.push(`    ${prop}: ${val ? "true" : "false"};`);
            } else if (typeof val === "number") {
                lines.push(`    ${prop}: ${val};`);
            }
        }
        lines.push("}\n");
    }

    return lines.join("\n");
}

export function default_() {
    return new Theme();
}

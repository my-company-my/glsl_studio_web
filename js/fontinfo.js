// Lector mínimo de fuentes TrueType/OpenType.
//
// Escritorio mide el texto con Pillow + FreeType. Aquí se reproducen esas
// mismas cuentas leyendo las tablas de la fuente:
//   - avance de cada glifo: hmtx escalado con la aritmética de punto fijo de
//     FreeType (FT_DivFix / FT_MulDiv) y redondeado a 26.6 como HarfBuzz.
//   - cmap: saber si la fuente tiene el carácter (si no, Pillow dibuja .notdef).
//   - contorno de .notdef (glyf) para dibujarlo igual que Pillow.

export class FontInfo {
    constructor(buffer) {
        this.buffer = buffer;
        this.view = new DataView(buffer);
        this.tables = {};
        this._parse_directory();
        this._parse_head();
        this._parse_hhea();
        this._parse_maxp();
        this._parse_hmtx();
        this._parse_cmap();
    }

    // --- Lectura ---

    _u16(o) { return this.view.getUint16(o); }
    _i16(o) { return this.view.getInt16(o); }
    _u32(o) { return this.view.getUint32(o); }

    _parse_directory() {
        const num = this._u16(4);
        for (let i = 0; i < num; i++) {
            const rec = 12 + i * 16;
            const tag = String.fromCharCode(
                this.view.getUint8(rec), this.view.getUint8(rec + 1),
                this.view.getUint8(rec + 2), this.view.getUint8(rec + 3));
            this.tables[tag] = { offset: this._u32(rec + 8), length: this._u32(rec + 12) };
        }
    }

    _parse_head() {
        const o = this.tables["head"].offset;
        this.units_per_em = this._u16(o + 18);
        this.index_to_loc_format = this._i16(o + 50);
    }

    _parse_hhea() {
        const o = this.tables["hhea"].offset;
        this.ascender = this._i16(o + 4);
        this.descender = this._i16(o + 6);
        this.num_hmetrics = this._u16(o + 34);
    }

    _parse_maxp() {
        this.num_glyphs = this._u16(this.tables["maxp"].offset + 4);
    }

    _parse_hmtx() {
        const o = this.tables["hmtx"].offset;
        this.advances = new Uint16Array(this.num_glyphs);
        let last = 0;
        for (let g = 0; g < this.num_glyphs; g++) {
            if (g < this.num_hmetrics) last = this._u16(o + g * 4);
            this.advances[g] = last;
        }
    }

    _parse_cmap() {
        const base = this.tables["cmap"].offset;
        const n = this._u16(base + 2);
        const subtables = [];
        for (let i = 0; i < n; i++) {
            const rec = base + 4 + i * 8;
            const platform = this._u16(rec);
            const encoding = this._u16(rec + 2);
            const offset = base + this._u32(rec + 4);
            subtables.push({ platform, encoding, offset, format: this._u16(offset) });
        }
        // Preferencia: Unicode completo (3,10 / 0,4 / 0,6) y luego BMP (3,1 / 0,x)
        const pick = (pred) => subtables.find(pred);
        const st =
            pick((s) => s.format === 12 && ((s.platform === 3 && s.encoding === 10) || s.platform === 0)) ||
            pick((s) => s.format === 4 && ((s.platform === 3 && s.encoding === 1) || s.platform === 0)) ||
            pick((s) => s.format === 4);
        this._cmap = new Map();
        if (!st) return;
        if (st.format === 4) this._read_cmap4(st.offset);
        else this._read_cmap12(st.offset);
    }

    _read_cmap4(o) {
        const segX2 = this._u16(o + 6);
        const seg = segX2 / 2;
        const ends = o + 14;
        const starts = ends + segX2 + 2;
        const deltas = starts + segX2;
        const ranges = deltas + segX2;
        for (let i = 0; i < seg; i++) {
            const end = this._u16(ends + i * 2);
            const start = this._u16(starts + i * 2);
            const delta = this._i16(deltas + i * 2);
            const rangeOffset = this._u16(ranges + i * 2);
            for (let c = start; c <= end && c !== 0xFFFF; c++) {
                let g;
                if (rangeOffset === 0) {
                    g = (c + delta) & 0xFFFF;
                } else {
                    const addr = ranges + i * 2 + rangeOffset + (c - start) * 2;
                    g = this._u16(addr);
                    if (g !== 0) g = (g + delta) & 0xFFFF;
                }
                if (g !== 0) this._cmap.set(c, g);
            }
        }
    }

    _read_cmap12(o) {
        const groups = this._u32(o + 12);
        for (let i = 0; i < groups; i++) {
            const rec = o + 16 + i * 12;
            const start = this._u32(rec);
            const end = this._u32(rec + 4);
            const gid = this._u32(rec + 8);
            for (let c = start; c <= end; c++) this._cmap.set(c, gid + (c - start));
        }
    }

    // --- Consultas ---

    glyph_id(cp) {
        return this._cmap.get(cp) || 0;
    }

    has_char(cp) {
        return this._cmap.has(cp);
    }

    /** Avance en unidades 26.6 (1/64 px), como lo da HarfBuzz sobre FreeType
     *  sin hinting (lo que usa Pillow con raqm). */
    advance_26_6(gid, px) {
        const x_scale = ft_div_fix(px * 64, this.units_per_em);
        const v = ft_mul_div(this.advances[gid] || 0, x_scale, 64); // 16.16
        return Math.floor((v + 512) / 1024);
    }

    /** Ascent/descent de FreeType (size->metrics) en píxeles enteros */
    metrics(px) {
        const y_scale = ft_div_fix(px * 64, this.units_per_em);
        const asc = ft_pix_ceil(ft_mul_fix(this.ascender, y_scale));
        const desc = ft_pix_floor(ft_mul_fix(this.descender, y_scale));
        return [Math.floor((asc + 32) / 64), Math.floor((-desc + 32) / 64)];
    }

    // --- Contornos (solo glyf/TrueType) ---

    /** Retorna el contorno del glifo como Path2D en píxeles, origen en la línea
     *  base (y hacia abajo), o null si la fuente no es TrueType. */
    glyph_path(gid, px) {
        if (!this.tables["glyf"] || !this.tables["loca"]) return null;
        const contours = this._glyph_contours(gid, 0);
        const s = px / this.units_per_em;
        const path = new Path2D();
        for (const pts of contours) {
            if (!pts.length) continue;
            // Contorno cuadrático de TrueType: puntos on/off-curve
            let start = pts.findIndex((p) => p.on);
            let first;
            if (start < 0) {
                const a = pts[0], b = pts[1 % pts.length];
                first = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, on: true };
                start = 0;
            } else {
                first = pts[start];
            }
            path.moveTo(first.x * s, -first.y * s);
            let prev = first;
            for (let k = 1; k <= pts.length; k++) {
                const p = pts[(start + k) % pts.length];
                if (p.on) {
                    if (prev.on) path.lineTo(p.x * s, -p.y * s);
                    else path.quadraticCurveTo(prev.x * s, -prev.y * s, p.x * s, -p.y * s);
                    prev = p;
                } else {
                    if (!prev.on) {
                        const mx = (prev.x + p.x) / 2, my = (prev.y + p.y) / 2;
                        path.quadraticCurveTo(prev.x * s, -prev.y * s, mx * s, -my * s);
                    }
                    prev = p;
                }
            }
            if (!prev.on) path.quadraticCurveTo(prev.x * s, -prev.y * s, first.x * s, -first.y * s);
            path.closePath();
        }
        return path;
    }

    _glyph_offset(gid) {
        const loca = this.tables["loca"].offset;
        if (this.index_to_loc_format === 0) {
            return [this._u16(loca + gid * 2) * 2, this._u16(loca + gid * 2 + 2) * 2];
        }
        return [this._u32(loca + gid * 4), this._u32(loca + gid * 4 + 4)];
    }

    _glyph_contours(gid, depth) {
        const [a, b] = this._glyph_offset(gid);
        if (b <= a || depth > 8) return [];
        const o = this.tables["glyf"].offset + a;
        const n = this._i16(o);
        if (n >= 0) return this._simple_glyph(o, n);
        return this._composite_glyph(o, depth);
    }

    _simple_glyph(o, n) {
        const ends = [];
        for (let i = 0; i < n; i++) ends.push(this._u16(o + 10 + i * 2));
        const count = n ? ends[n - 1] + 1 : 0;
        let p = o + 10 + n * 2;
        const ins = this._u16(p);
        p += 2 + ins;
        const flags = [];
        while (flags.length < count) {
            const f = this.view.getUint8(p++);
            flags.push(f);
            if (f & 8) {
                let r = this.view.getUint8(p++);
                while (r-- > 0) flags.push(f);
            }
        }
        const xs = [], ys = [];
        let v = 0;
        for (const f of flags) {
            if (f & 2) { const d = this.view.getUint8(p++); v += (f & 16) ? d : -d; }
            else if (!(f & 16)) { v += this._i16(p); p += 2; }
            xs.push(v);
        }
        v = 0;
        for (const f of flags) {
            if (f & 4) { const d = this.view.getUint8(p++); v += (f & 32) ? d : -d; }
            else if (!(f & 32)) { v += this._i16(p); p += 2; }
            ys.push(v);
        }
        const contours = [];
        let s = 0;
        for (const e of ends) {
            const pts = [];
            for (let i = s; i <= e; i++) pts.push({ x: xs[i], y: ys[i], on: (flags[i] & 1) === 1 });
            contours.push(pts);
            s = e + 1;
        }
        return contours;
    }

    _composite_glyph(o, depth) {
        let p = o + 10;
        const out = [];
        for (;;) {
            const flags = this._u16(p);
            const gid = this._u16(p + 2);
            p += 4;
            let dx, dy;
            if (flags & 1) { dx = this._i16(p); dy = this._i16(p + 2); p += 4; }
            else { dx = this.view.getInt8(p); dy = this.view.getInt8(p + 1); p += 2; }
            let a = 1, b = 0, c = 0, d = 1;
            const f2 = (q) => this._i16(q) / 16384;
            if (flags & 8) { a = d = f2(p); p += 2; }
            else if (flags & 0x40) { a = f2(p); d = f2(p + 2); p += 4; }
            else if (flags & 0x80) { a = f2(p); b = f2(p + 2); c = f2(p + 4); d = f2(p + 6); p += 8; }
            for (const pts of this._glyph_contours(gid, depth + 1)) {
                out.push(pts.map((q) => ({ x: a * q.x + c * q.y + dx, y: b * q.x + d * q.y + dy, on: q.on })));
            }
            if (!(flags & 0x20)) break;
        }
        return out;
    }
}

// ======================
// ARITMÉTICA DE PUNTO FIJO DE FREETYPE
// ======================

/** FT_DivFix(a, b): (a << 16) / b redondeado */
export function ft_div_fix(a, b) {
    let s = 1;
    if (a < 0) { a = -a; s = -s; }
    if (b < 0) { b = -b; s = -s; }
    const q = b > 0 ? Number((BigInt(a) * 65536n + BigInt(b >> 1)) / BigInt(b)) : 0x7FFFFFFF;
    return s < 0 ? -q : q;
}

/** FT_MulDiv(a, b, c): a * b / c redondeado */
export function ft_mul_div(a, b, c) {
    let s = 1;
    if (a < 0) { a = -a; s = -s; }
    if (b < 0) { b = -b; s = -s; }
    if (c < 0) { c = -c; s = -s; }
    const d = c > 0 ? Number((BigInt(a) * BigInt(b) + BigInt(c >> 1)) / BigInt(c)) : 0x7FFFFFFF;
    return s < 0 ? -d : d;
}

/** FT_MulFix(a, b): a * b / 65536 redondeado */
export function ft_mul_fix(a, b) {
    let s = 1;
    if (a < 0) { a = -a; s = -s; }
    if (b < 0) { b = -b; s = -s; }
    const c = Number((BigInt(a) * BigInt(b) + 0x8000n) >> 16n);
    return s < 0 ? -c : c;
}

export function ft_pix_ceil(x) {
    return Math.ceil(x / 64) * 64;
}

export function ft_pix_floor(x) {
    return Math.floor(x / 64) * 64;
}

export async function load_font_info(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    const buffer = await res.arrayBuffer();
    return { buffer, info: new FontInfo(buffer) };
}

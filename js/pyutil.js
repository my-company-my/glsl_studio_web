// Funciones que reproducen la semántica exacta de Python que usa la versión
// de escritorio (formato de floats, float(), str.strip(), isprintable(), ...).
// Así la web genera el mismo texto y los mismos números que escritorio.

// ======================
// ERRORES
// ======================

export class ValueError extends Error {
    constructor(message) {
        super(message);
        this.name = "ValueError";
    }
}

// ======================
// CARACTERES (str.isspace, isalnum, isprintable)
// ======================

// Caracteres donde str.isspace() de Python es True
const PY_SPACE = new Set([
    0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x1C, 0x1D, 0x1E, 0x1F, 0x20, 0x85, 0xA0,
    0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
    0x2008, 0x2009, 0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000,
]);

export function pyIsSpace(ch) {
    return ch.length > 0 && PY_SPACE.has(ch.codePointAt(0));
}

/** Clase de regex equivalente a \s de Python (para usar dentro de [...]) */
export const PY_WS_CLASS =
    "\\t\\n\\x0B\\x0C\\r\\x1C-\\x1F \\x85\\xA0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000";

/** Clase de regex equivalente a \w de Python 3 (Unicode) */
export const PY_W_CLASS = "\\p{L}\\p{N}_";

/** str.strip() de Python (solo quita espacios Unicode, no el BOM) */
export function pyStrip(s) {
    const cps = Array.from(s);
    let a = 0;
    let b = cps.length;
    while (a < b && PY_SPACE.has(cps[a].codePointAt(0))) a++;
    while (b > a && PY_SPACE.has(cps[b - 1].codePointAt(0))) b--;
    return cps.slice(a, b).join("");
}

const RE_ALNUM = /^[\p{L}\p{N}]$/u;
/** str.isalnum() de Python para un solo carácter */
export function pyIsAlnum(ch) {
    return RE_ALNUM.test(ch);
}

const RE_NOT_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;
/** str.isprintable() de Python para un solo carácter */
export function pyIsPrintable(ch) {
    if (ch === " ") return true;
    return !RE_NOT_PRINTABLE.test(ch);
}

const RE_CASED = /[\p{Lu}\p{Ll}\p{Lt}]/u;
/** str.title() de Python */
export function pyTitle(s) {
    let out = "";
    let prevCased = false;
    for (const ch of s) {
        const cased = RE_CASED.test(ch);
        if (cased) {
            out += prevCased ? ch.toLowerCase() : ch.toUpperCase();
        } else {
            out += ch;
        }
        prevCased = cased;
    }
    return out;
}

// ======================
// TEXTO POR CODE POINTS (Python indexa por code point, JS por UTF-16)
// ======================

const RE_SURROGATE = /[\uD800-\uDFFF]/;

/** len(s) de Python */
export function cpLen(s) {
    if (!RE_SURROGATE.test(s)) return s.length;
    let n = 0;
    for (const _c of s) n++;
    return n;
}

/** s[a:b] de Python (a, b >= 0) */
export function cpSlice(s, a, b) {
    if (!RE_SURROGATE.test(s)) return b === undefined ? s.slice(a) : s.slice(a, b);
    const cps = Array.from(s);
    return (b === undefined ? cps.slice(a) : cps.slice(a, b)).join("");
}

/** s[i] de Python (i >= 0) */
export function cpAt(s, i) {
    if (!RE_SURROGATE.test(s)) return s[i];
    return Array.from(s)[i];
}

// ======================
// NÚMEROS
// ======================

const _f64 = new Float64Array(1);
const _u32 = new Uint32Array(_f64.buffer);
const LITTLE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** Descompone un double finito en (negativo, mantisa entera, exponente base 2) */
function decompose(x) {
    _f64[0] = x;
    const lo = LITTLE ? _u32[0] : _u32[1];
    const hi = LITTLE ? _u32[1] : _u32[0];
    const neg = (hi >>> 31) === 1;
    const exp = (hi >>> 20) & 0x7FF;
    let mant = (BigInt(hi & 0xFFFFF) << 32n) | BigInt(lo);
    let e2;
    if (exp === 0) {
        e2 = -1074; // subnormal
    } else {
        mant |= 1n << 52n;
        e2 = exp - 1075;
    }
    return [neg, mant, e2];
}

/** format(x, f".{d}f") de Python: redondeo half-even sobre el valor binario exacto */
export function pyFormatFixed(x, d) {
    if (Number.isNaN(x)) return "nan";
    if (x === Infinity) return "inf";
    if (x === -Infinity) return "-inf";
    const [neg, mant, e2] = decompose(x);
    const p10 = 10n ** BigInt(d);
    let q;
    if (e2 >= 0) {
        q = (mant << BigInt(e2)) * p10;
    } else {
        const num = mant * p10;
        const den = 1n << BigInt(-e2);
        q = num / den;
        const r2 = (num % den) * 2n;
        if (r2 > den || (r2 === den && (q & 1n) === 1n)) q += 1n;
    }
    let digits = q.toString();
    if (d > 0) {
        if (digits.length <= d) digits = "0".repeat(d - digits.length + 1) + digits;
        digits = digits.slice(0, digits.length - d) + "." + digits.slice(digits.length - d);
    }
    return (neg ? "-" : "") + digits;
}

/** round(x, d) de Python para floats */
export function pyRound(x, d) {
    if (!Number.isFinite(x)) return x;
    return parseFloat(pyFormatFixed(x, d));
}

/** repr(x) / str(x) de Python para floats */
export function pyFloatRepr(x) {
    if (Number.isNaN(x)) return "nan";
    if (x === Infinity) return "inf";
    if (x === -Infinity) return "-inf";
    if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
    const neg = x < 0;
    const [mantStr, expStr] = Math.abs(x).toExponential().split("e");
    const digits = mantStr.replace(".", "");
    const exp = parseInt(expStr, 10);
    let out;
    if (exp >= -4 && exp < 16) {
        if (exp < 0) {
            out = "0." + "0".repeat(-exp - 1) + digits;
        } else if (digits.length <= exp + 1) {
            out = digits + "0".repeat(exp + 1 - digits.length) + ".0";
        } else {
            out = digits.slice(0, exp + 1) + "." + digits.slice(exp + 1);
        }
    } else {
        const m = digits.length > 1 ? digits[0] + "." + digits.slice(1) : digits;
        const sign = exp < 0 ? "-" : "+";
        const e = String(Math.abs(exp)).padStart(2, "0");
        out = m + "e" + sign + e;
    }
    return (neg ? "-" : "") + out;
}

/** str(v) de Python para los tipos que usa la app */
export function pyStr(v) {
    if (typeof v === "number") return pyFloatRepr(v);
    if (typeof v === "boolean") return v ? "True" : "False";
    if (v === null || v === undefined) return "None";
    return String(v);
}

/** str(int) de Python */
export function pyIntStr(v) {
    return String(Math.trunc(v));
}

const RE_PY_FLOAT = /^[+-]?(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?$/;
const RE_PY_SPECIAL = /^([+-]?)(inf|infinity|nan)$/i;
const RE_ND_CHAR = /^\p{Nd}$/u;
const RE_ND_ANY = /\p{Nd}/gu;

/** Valor de un dígito Unicode decimal (Nd). Unicode garantiza que los Nd
 *  vienen en rangos contiguos de 10 (0..9): el valor es la distancia al
 *  inicio del rango, módulo 10. */
export function pyDigitValue(ch) {
    const cp = ch.codePointAt(0);
    if (cp >= 48 && cp <= 57) return cp - 48;
    let k = 0;
    while (RE_ND_CHAR.test(String.fromCodePoint(cp - k - 1))) k++;
    return k % 10;
}

/** Cambia dígitos Unicode (ej. '٣') por ASCII, como hacen int()/float() de Python */
export function pyNormalizeDigits(s) {
    return s.replace(RE_ND_ANY, (ch) => String(pyDigitValue(ch)));
}

/** int(s) de Python para texto de dígitos (ya validado por una regex \d+) */
export function pyParseInt(s) {
    return parseInt(pyNormalizeDigits(s), 10);
}

/** float(s) de Python para texto. Lanza ValueError si no es válido. */
export function pyFloat(s) {
    const t = pyNormalizeDigits(pyStrip(String(s)));
    if (RE_PY_FLOAT.test(t)) return Number(t.replace(/_/g, ""));
    const m = RE_PY_SPECIAL.exec(t);
    if (m) {
        if (m[2].toLowerCase() === "nan") return NaN;
        return m[1] === "-" ? -Infinity : Infinity;
    }
    throw new ValueError(`could not convert string to float: '${s}'`);
}

/** round(x) de Python sin decimales: entero más cercano, empates al par */
export function pyRoundInt(x) {
    if (!Number.isFinite(x)) return x;
    const f = Math.floor(x);
    const diff = x - f;
    if (diff > 0.5) return f + 1;
    if (diff < 0.5) return f;
    return (f % 2 === 0) ? f : f + 1;
}

/** str.split() de Python sin argumentos (separa por espacios Unicode, sin vacíos) */
export function pySplitWs(s) {
    const out = [];
    let cur = "";
    for (const ch of s) {
        if (PY_SPACE.has(ch.codePointAt(0))) {
            if (cur) out.push(cur);
            cur = "";
        } else {
            cur += ch;
        }
    }
    if (cur) out.push(cur);
    return out;
}

/** int(x) de Python para floats (trunca hacia cero) */
export function pyInt(x) {
    return Math.trunc(x);
}

/** x % m de Python (el resultado toma el signo del divisor) */
export function pyMod(x, m) {
    const r = x % m;
    return (r !== 0 && (r < 0) !== (m < 0)) ? r + m : r;
}

/** Compara dos tuplas (arrays) como Python: (a, b) > (c, d) */
export function tupleGreater(a, b) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
        if (a[i] !== b[i]) return a[i] > b[i];
    }
    return a.length > b.length;
}

// ======================
// HASH Y SET DE CPYTHON (para reproducir el orden de iteración de set())
// ======================

const HASH_BITS = 61n;
const HASH_MODULUS = (1n << HASH_BITS) - 1n;
const U64 = (1n << 64n) - 1n;
const HASH_INF = 314159n;

/** frexp(v) de C: [m, e] con v = m * 2**e y 0.5 <= |m| < 1 */
function frexp(v) {
    if (v === 0 || !Number.isFinite(v)) return [v, 0];
    const [neg, mant, e2] = decompose(v);
    const bits = mant.toString(2).length;
    const m = Number(mant) / 2 ** bits;
    return [neg ? -m : m, e2 + bits];
}

/** hash(x) de Python para números, como size_t (BigInt sin signo de 64 bits).
 *  Port de _Py_HashDouble (pyhash.c). Para enteros da lo mismo que hash(int). */
export function pyHash(v) {
    if (Number.isNaN(v)) return 0n;
    if (v === Infinity) return HASH_INF;
    if (v === -Infinity) return (U64 + 1n - HASH_INF) & U64;

    let [m, e] = frexp(v);
    let sign = 1n;
    if (m < 0) {
        sign = -1n;
        m = -m;
    }

    // process 28 bits at a time
    let x = 0n;
    while (m) {
        x = ((x << 28n) & HASH_MODULUS) | (x >> (HASH_BITS - 28n));
        m *= 268435456.0; // 2**28
        e -= 28;
        const y = Math.trunc(m); // pull out integer part
        m -= y;
        x += BigInt(y);
        if (x >= HASH_MODULUS) x -= HASH_MODULUS;
    }

    // adjust for the exponent; first reduce it modulo HASH_BITS
    e = e >= 0 ? e % 61 : 61 - 1 - ((-1 - e) % 61);
    x = ((x << BigInt(e)) & HASH_MODULUS) | (x >> (HASH_BITS - BigInt(e)));

    if (sign < 0n) x = (U64 + 1n - x) & U64; // x * sign en Py_uhash_t
    if (x === U64) x = U64 - 1n;              // -1 -> -2
    return x;
}

const LINEAR_PROBES = 9;
const PERTURB_SHIFT = 5n;
const PYSET_MINSIZE = 8;

/** set() de CPython 3.13 para claves numéricas: misma tabla hash, mismo
 *  sondeo y mismo orden de iteración. Port de setobject.c (solo add). */
export class PySet {
    constructor(iterable = null) {
        this._mask = PYSET_MINSIZE - 1;
        this._keys = new Array(PYSET_MINSIZE);
        this._hashes = new Array(PYSET_MINSIZE);
        this._fill = 0;
        this._used = 0;
        this._members = new Set(); // == de Python: 1 == 1.0, -0.0 == 0.0
        if (iterable) for (const k of iterable) this.add(k);
    }

    get size() {
        return this._used;
    }

    has(key) {
        return this._members.has(key);
    }

    add(key) {
        if (this._members.has(key)) return; // found_active
        const hash = pyHash(key);
        const mask = this._mask;
        let i = Number(hash & BigInt(mask));
        let perturb = hash;

        for (;;) {
            let idx = i;
            let probes = (i + LINEAR_PROBES <= mask) ? LINEAR_PROBES : 0;
            do {
                if (this._keys[idx] === undefined) {
                    // found_unused
                    this._fill++;
                    this._used++;
                    this._keys[idx] = key;
                    this._hashes[idx] = hash;
                    this._members.add(key);
                    if (this._fill * 5 < mask * 3) return;
                    this._resize(this._used > 50000 ? this._used * 2 : this._used * 4);
                    return;
                }
                idx++;
            } while (probes--);
            perturb >>= PERTURB_SHIFT;
            i = Number((BigInt(i) * 5n + 1n + perturb) & BigInt(mask));
        }
    }

    _resize(minused) {
        let newsize = PYSET_MINSIZE;
        while (newsize <= minused) newsize <<= 1;
        if (newsize === PYSET_MINSIZE && this._mask === PYSET_MINSIZE - 1 && this._fill === this._used) {
            return; // No dummies, so no point doing anything.
        }
        const oldKeys = this._keys;
        const oldHashes = this._hashes;
        this._mask = newsize - 1;
        this._keys = new Array(newsize);
        this._hashes = new Array(newsize);
        for (let j = 0; j < oldKeys.length; j++) {
            if (oldKeys[j] !== undefined) this._insert_clean(oldKeys[j], oldHashes[j]);
        }
    }

    _insert_clean(key, hash) {
        const mask = this._mask;
        let perturb = hash;
        let i = Number(hash & BigInt(mask));
        for (;;) {
            if (this._keys[i] === undefined) {
                this._keys[i] = key;
                this._hashes[i] = hash;
                return;
            }
            if (i + LINEAR_PROBES <= mask) {
                for (let j = 1; j <= LINEAR_PROBES; j++) {
                    if (this._keys[i + j] === undefined) {
                        this._keys[i + j] = key;
                        this._hashes[i + j] = hash;
                        return;
                    }
                }
            }
            perturb >>= PERTURB_SHIFT;
            i = Number((BigInt(i) * 5n + 1n + perturb) & BigInt(mask));
        }
    }

    *[Symbol.iterator]() {
        for (let j = 0; j < this._keys.length; j++) {
            if (this._keys[j] !== undefined) yield this._keys[j];
        }
    }
}

/** time.monotonic() en segundos */
export function monotonic() {
    return performance.now() / 1000;
}

/** time.time() en segundos */
export function timeNow() {
    return Date.now() / 1000;
}

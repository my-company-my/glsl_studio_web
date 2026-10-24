// Port de syntax.py: tokenizador/resaltado de sintaxis GLSL.
// Las regex usan clases Unicode para que \w, \d, \s y \b se comporten igual
// que en Python 3.

import { PY_WS_CLASS, PY_W_CLASS } from "./pyutil.js";

// ======================
// CONFIG
// ======================

// Tipos de token
export const T_KEYWORD      = "keyword";
export const T_TYPE         = "type";
export const T_BUILTIN      = "builtin";
export const T_NUMBER       = "number";
export const T_STRING       = "string";
export const T_COMMENT      = "comment";
export const T_PREPROCESSOR = "preprocessor";
export const T_FUNCTION     = "function";
export const T_OPERATOR     = "operator";
export const T_IDENTIFIER   = "identifier";
export const T_SWIZZLE      = "swizzle";
export const T_WHITESPACE   = "whitespace";
export const T_NEWLINE      = "newline";

// Palabras clave GLSL
export const KEYWORDS = new Set([
    "attribute", "const", "uniform", "varying", "layout",
    "centroid", "flat", "smooth", "noperspective",
    "break", "continue", "do", "for", "while",
    "switch", "case", "default",
    "if", "else",
    "in", "out", "inout",
    "discard", "return",
    "lowp", "mediump", "highp", "precision",
    "struct", "subroutine",
    "true", "false",
    "invariant", "precise",
    "coherent", "volatile", "restrict", "readonly", "writeonly",
    "buffer", "shared",
]);

// Tipos GLSL
export const TYPES = new Set([
    "void", "bool", "int", "uint", "float", "double",
    "vec2", "vec3", "vec4",
    "dvec2", "dvec3", "dvec4",
    "bvec2", "bvec3", "bvec4",
    "ivec2", "ivec3", "ivec4",
    "uvec2", "uvec3", "uvec4",
    "mat2", "mat3", "mat4",
    "mat2x2", "mat2x3", "mat2x4",
    "mat3x2", "mat3x3", "mat3x4",
    "mat4x2", "mat4x3", "mat4x4",
    "sampler1D", "sampler2D", "sampler3D",
    "samplerCube", "sampler2DRect",
    "sampler1DShadow", "sampler2DShadow",
    "samplerCubeShadow", "sampler2DRectShadow",
    "sampler1DArray", "sampler2DArray",
    "sampler1DArrayShadow", "sampler2DArrayShadow",
    "samplerBuffer", "sampler2DMS", "sampler2DMSArray",
    "image1D", "image2D", "image3D",
    "imageCube", "image2DRect",
    "image1DArray", "image2DArray",
    "imageBuffer", "image2DMS", "image2DMSArray",
]);

// Funciones built-in GLSL
export const BUILTINS = new Set([
    "radians", "degrees", "sin", "cos", "tan",
    "asin", "acos", "atan", "sinh", "cosh", "tanh",
    "asinh", "acosh", "atanh",
    "pow", "exp", "log", "exp2", "log2",
    "sqrt", "inversesqrt",
    "abs", "sign", "floor", "trunc", "round",
    "roundEven", "ceil", "fract", "mod", "modf",
    "min", "max", "clamp", "mix", "step", "smoothstep",
    "isnan", "isinf",
    "length", "distance", "dot", "cross", "normalize",
    "faceforward", "reflect", "refract",
    "matrixCompMult", "outerProduct", "transpose",
    "determinant", "inverse",
    "lessThan", "lessThanEqual", "greaterThan",
    "greaterThanEqual", "equal", "notEqual",
    "any", "all", "not",
    "texture", "textureProj", "textureLod",
    "textureOffset", "texelFetch", "texelFetchOffset",
    "textureGrad", "textureGradOffset",
    "textureProjLod", "textureProjGrad",
    "textureSize", "textureQueryLod", "textureQueryLevels",
    "dFdx", "dFdy", "fwidth",
    "noise1", "noise2", "noise3", "noise4",
    "EmitVertex", "EndPrimitive",
    "barrier",
    "memoryBarrier", "memoryBarrierAtomicCounter",
    "memoryBarrierBuffer", "memoryBarrierShared",
    "memoryBarrierImage", "groupMemoryBarrier",
    "gl_Position", "gl_FragCoord", "gl_FragColor",
    "gl_VertexID", "gl_InstanceID", "gl_FragDepth",
    "gl_PointSize", "gl_PointCoord",
    "gl_FrontFacing", "gl_SampleID", "gl_SamplePosition",
]);

// Operadores
export const OPERATORS = new Set([
    "+", "-", "*", "/", "%",
    "=", "==", "!=", "<", ">", "<=", ">=",
    "&&", "||", "!",
    "&", "|", "^", "~",
    "<<", ">>",
    "+=", "-=", "*=", "/=", "%=",
    "&=", "|=", "^=",
    "<<=", ">>=",
    "++", "--",
    "?", ":",
    ".", ",", ";",
    "(", ")", "[", "]", "{", "}",
]);

// ======================
// REGEX PATTERNS
// ======================

const W = `[${PY_W_CLASS}]`;
// \b de Python (Unicode)
const B = `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`;
const D = "\\p{Nd}";

const _PATTERNS = [
    ["comment_block", new RegExp("/\\*[\\s\\S]*?\\*/", "uy")],
    ["comment_line",  new RegExp("//[^\\n]*", "uy")],
    ["preprocessor",  new RegExp(`#[${PY_WS_CLASS}]*${W}+[^\\n]*`, "uy")],
    ["number",        new RegExp(`${B}(?:0[xX][0-9a-fA-F]+|(?:${D}+\\.?${D}*|\\.${D}+)(?:[eE][+-]?${D}+)?)[uUfFlL]?${B}`, "uy")],
    ["string",        new RegExp('"(?:[^"\\\\]|\\\\[^\\n])*"', "uy")],
    ["identifier",    new RegExp(`[a-zA-Z_]${W}*`, "uy")],
    ["operator",      new RegExp("[+\\-*/%=!<>&|^~?:.,;()\\[\\]{}]+", "uy")],
    ["whitespace",    new RegExp(`[${PY_WS_CLASS.replace("\\n", "")}]+`, "uy")],
    ["newline",       new RegExp("\\n", "uy")],
];

// ======================
// LEXER
// ======================

export class Token {
    constructor(type, value, pos) {
        this.type = type;
        this.value = value;
        this.pos = pos;
    }

    toString() {
        return `Token(${this.type}, ${JSON.stringify(this.value)})`;
    }
}

const SWIZZLE_CHARS = "xyzwrgbastpq";

export function tokenize(text) {
    let pos = 0;
    const length = text.length;
    const tokens = [];

    while (pos < length) {
        let matched = false;

        for (const [name, pattern] of _PATTERNS) {
            pattern.lastIndex = pos;
            const m = pattern.exec(text);
            if (!m) continue;

            const value = m[0];
            const end = pattern.lastIndex;
            matched = true;

            if (name === "comment_block" || name === "comment_line") {
                tokens.push(new Token(T_COMMENT, value, pos));

            } else if (name === "preprocessor") {
                tokens.push(new Token(T_PREPROCESSOR, value, pos));

            } else if (name === "number") {
                tokens.push(new Token(T_NUMBER, value, pos));

            } else if (name === "string") {
                tokens.push(new Token(T_STRING, value, pos));

            } else if (name === "identifier") {
                // Chequear si es swizzle (después de .)
                const last = tokens[tokens.length - 1];
                if (last && last.type === T_OPERATOR && last.value === ".") {
                    if ([...value].length <= 4 && [...value].every((c) => SWIZZLE_CHARS.includes(c))) {
                        tokens.push(new Token(T_SWIZZLE, value, pos));
                    } else {
                        tokens.push(new Token(T_IDENTIFIER, value, pos));
                    }
                } else if (KEYWORDS.has(value)) {
                    tokens.push(new Token(T_KEYWORD, value, pos));
                } else if (TYPES.has(value)) {
                    tokens.push(new Token(T_TYPE, value, pos));
                } else if (BUILTINS.has(value)) {
                    tokens.push(new Token(T_BUILTIN, value, pos));
                } else {
                    // Lookahead para funciones: identifier seguido de (
                    let next_pos = end;
                    while (next_pos < length && (text[next_pos] === " " || text[next_pos] === "\t")) {
                        next_pos += 1;
                    }
                    if (next_pos < length && text[next_pos] === "(") {
                        tokens.push(new Token(T_FUNCTION, value, pos));
                    } else {
                        tokens.push(new Token(T_IDENTIFIER, value, pos));
                    }
                }

            } else if (name === "operator") {
                tokens.push(new Token(T_OPERATOR, value, pos));

            } else if (name === "whitespace") {
                tokens.push(new Token(T_WHITESPACE, value, pos));

            } else if (name === "newline") {
                tokens.push(new Token(T_NEWLINE, value, pos));
            }

            pos = end;
            break;
        }

        if (!matched) {
            // Caracter desconocido, avanzar (un code point, como Python)
            const ch = String.fromCodePoint(text.codePointAt(pos));
            tokens.push(new Token(T_IDENTIFIER, ch, pos));
            pos += ch.length;
        }
    }

    return tokens;
}

export function tokenize_line(line) {
    return tokenize(line);
}

// ======================
// HIGHLIGHT
// ======================

export function highlight(text) {
    return tokenize(text).map((tok) => [tok.type, tok.value]);
}

export function highlight_lines(lines) {
    return lines.map((line) => highlight(line));
}

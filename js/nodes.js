// Port de nodes.py: tipos de nodo, compilador (grafo -> GLSL) y
// decompilador (GLSL -> grafo).
// Diferencia web: el shader generado empieza con "#version 300 es" +
// "precision highp float;" (WebGL2 usa GLSL ES 3.00).

import {
    pyFormatFixed, pyFloatRepr, pyFloat, pyStrip, pyParseInt, pyInt, PY_WS_CLASS, PySet,
} from "./pyutil.js";

// ======================
// CONFIG
// ======================

// Tipos de datos de slots
export const SLOT_FLOAT = "float";
export const SLOT_VEC2  = "vec2";
export const SLOT_VEC3  = "vec3";
export const SLOT_VEC4  = "vec4";

// Colores por tipo de slot (para el renderer)
export const SLOT_COLORS = {
    [SLOT_FLOAT]: [0.6, 0.6, 0.6, 1.0],
    [SLOT_VEC2]:  [0.4, 0.8, 0.4, 1.0],
    [SLOT_VEC3]:  [0.3, 0.5, 0.9, 1.0],
    [SLOT_VEC4]:  [0.8, 0.3, 0.8, 1.0],
};

// Dimensiones visuales de nodos
export const NODE_W = 160;
export const NODE_H_HEADER = 24;
export const NODE_H_SLOT = 22;
export const NODE_H_DESC = NODE_H_SLOT; // fila de la descripción, debajo de los slots
export const NODE_SLOT_RADIUS = 9;
export const NODE_ROUND = 4;

// Cabecera GLSL de los shaders generados
export const GLSL_VERSION_LINES = ["#version 300 es", "precision highp float;"];

const f4 = (v) => pyFormatFixed(v, 4);

// ======================
// SLOT
// ======================

export class SlotDef {
    constructor(name, dtype, default_ = null, desc_key = null) {
        this.name = name;
        this.dtype = dtype;
        this.default = default_;
        this.desc_key = desc_key; // clave i18n para descripción del slot
    }

    default_str() {
        const d = this.default;
        if (d === null) {
            if (this.dtype === SLOT_FLOAT) return "0.0";
            if (this.dtype === SLOT_VEC2) return "vec2(0.0)";
            if (this.dtype === SLOT_VEC3) return "vec3(0.0)";
            if (this.dtype === SLOT_VEC4) return "vec4(0.0)";
        }
        if (Array.isArray(d)) {
            const s = d.map(pyFloatRepr);
            if (this.dtype === SLOT_VEC2) return `vec2(${s[0]}, ${s[1]})`;
            if (this.dtype === SLOT_VEC3) return `vec3(${s[0]}, ${s[1]}, ${s[2]})`;
            if (this.dtype === SLOT_VEC4) return `vec4(${s[0]}, ${s[1]}, ${s[2]}, ${s[3]})`;
        }
        return Array.isArray(d) ? `[${d.map(pyFloatRepr).join(", ")}]` : pyFloatRepr(d);
    }
}

// ======================
// NODE DEF (tipo de nodo)
// ======================

export class NodeDef {
    constructor(type_id, title, category, inputs, outputs, code_fn,
                params = null, color = null, description = null) {
        this.type_id = type_id;
        this.title = title;
        this.category = category;
        this.inputs = inputs;      // lista de SlotDef
        this.outputs = outputs;    // lista de SlotDef
        this.code_fn = code_fn;    // fn(var_name, input_vars, params) -> str
        this.params = params || []; // lista de [name, type, default]
        this.color = color || [0.25, 0.25, 0.35];
        this.desc_key = description || ""; // clave i18n para descripción
    }

    get_description(localize_fn = null) {
        if (!this.desc_key) return "";
        if (localize_fn) return localize_fn(this.desc_key);
        return this.desc_key;
    }

    height() {
        const slots = Math.max(this.inputs.length, this.outputs.length);
        return NODE_H_HEADER + Math.max(slots, 1) * NODE_H_SLOT + NODE_H_DESC + 8;
    }
}

// ======================
// AUTO CAST
// ======================

export function auto_cast(expr, from_type, to_type) {
    if (from_type === to_type) return expr;
    // float -> vecN
    if (from_type === SLOT_FLOAT) return `${to_type}(${expr})`;
    // vecN -> float
    if (to_type === SLOT_FLOAT) return `(${expr}).x`;
    // vec2 -> vec3
    if (from_type === SLOT_VEC2 && to_type === SLOT_VEC3) return `vec3(${expr}, 0.0)`;
    // vec2 -> vec4
    if (from_type === SLOT_VEC2 && to_type === SLOT_VEC4) return `vec4(${expr}, 0.0, 1.0)`;
    // vec3 -> vec4
    if (from_type === SLOT_VEC3 && to_type === SLOT_VEC4) return `vec4(${expr}, 1.0)`;
    // vec4 -> vec3
    if (from_type === SLOT_VEC4 && to_type === SLOT_VEC3) return `(${expr}).xyz`;
    // vec4 -> vec2
    if (from_type === SLOT_VEC4 && to_type === SLOT_VEC2) return `(${expr}).xy`;
    // vec3 -> vec2
    if (from_type === SLOT_VEC3 && to_type === SLOT_VEC2) return `(${expr}).xy`;
    return expr;
}

// ======================
// CODE GENERATORS
// ======================

const get = (params, key, def) => (key in params ? params[key] : def);

function _code_output(v, ins, p) { return `    fragColor = ${ins[0]};`; }
function _code_color(v, ins, p) {
    return `    vec3 ${v} = vec3(${f4(get(p, "r", 1.0))}, ${f4(get(p, "g", 1.0))}, ${f4(get(p, "b", 1.0))});`;
}
function _code_float(v, ins, p) { return `    float ${v} = ${f4(get(p, "value", 0.0))};`; }
function _code_vec2(v, ins, p) { return `    vec2 ${v} = vec2(${f4(get(p, "x", 0.0))}, ${f4(get(p, "y", 0.0))});`; }
function _code_time(v, ins, p) { return `    float ${v} = iTime;`; }
function _code_uv(v, ins, p) { return `    vec2 ${v} = gl_FragCoord.xy / iResolution.xy;`; }
function _code_resolution(v, ins, p) { return `    vec2 ${v} = iResolution;`; }
function _code_mouse(v, ins, p) { return `    vec2 ${v} = iMouse / iResolution;`; }
function _code_fragcoord(v, ins, p) { return `    vec2 ${v} = gl_FragCoord.xy;`; }
function _code_texture(v, ins, p) { return `    vec4 ${v} = texture(iChannel0, ${ins[0]});`; }
function _code_add(v, ins, p) { return `    vec3 ${v} = ${ins[0]} + ${ins[1]};`; }
function _code_sub(v, ins, p) { return `    vec3 ${v} = ${ins[0]} - ${ins[1]};`; }
function _code_mul(v, ins, p) { return `    vec3 ${v} = ${ins[0]} * ${ins[1]};`; }
function _code_div(v, ins, p) { return `    vec3 ${v} = ${ins[0]} / max(${ins[1]}, vec3(0.0001));`; }
function _code_mix(v, ins, p) { return `    vec3 ${v} = mix(${ins[0]}, ${ins[1]}, ${ins[2]});`; }
function _code_step(v, ins, p) { return `    vec3 ${v} = step(${ins[0]}, ${ins[1]});`; }
function _code_smoothstep(v, ins, p) { return `    vec3 ${v} = smoothstep(${ins[0]}, ${ins[1]}, ${ins[2]});`; }
function _code_clamp(v, ins, p) { return `    vec3 ${v} = clamp(${ins[0]}, ${ins[1]}, ${ins[2]});`; }
function _code_sin(v, ins, p) { return `    vec3 ${v} = sin(${ins[0]});`; }
function _code_cos(v, ins, p) { return `    vec3 ${v} = cos(${ins[0]});`; }
function _code_abs(v, ins, p) { return `    vec3 ${v} = abs(${ins[0]});`; }
function _code_fract(v, ins, p) { return `    vec3 ${v} = fract(${ins[0]});`; }
function _code_floor(v, ins, p) { return `    vec3 ${v} = floor(${ins[0]});`; }
function _code_pow(v, ins, p) { return `    vec3 ${v} = pow(${ins[0]}, ${ins[1]});`; }
function _code_sqrt(v, ins, p) { return `    vec3 ${v} = sqrt(max(${ins[0]}, vec3(0.0)));`; }
function _code_mod(v, ins, p) { return `    vec3 ${v} = mod(${ins[0]}, ${ins[1]});`; }
function _code_length(v, ins, p) { return `    float ${v} = length(${ins[0]});`; }
function _code_normalize(v, ins, p) { return `    vec3 ${v} = normalize(${ins[0]});`; }
function _code_dot(v, ins, p) { return `    float ${v} = dot(${ins[0]}, ${ins[1]});`; }
function _code_cross(v, ins, p) { return `    vec3 ${v} = cross(${ins[0]}, ${ins[1]});`; }
function _code_reflect(v, ins, p) { return `    vec3 ${v} = reflect(${ins[0]}, ${ins[1]});`; }
function _code_distance(v, ins, p) { return `    float ${v} = distance(${ins[0]}, ${ins[1]});`; }
function _code_combine3(v, ins, p) { return `    vec3 ${v} = vec3(${ins[0]}, ${ins[1]}, ${ins[2]});`; }
function _code_combine4(v, ins, p) { return `    vec4 ${v} = vec4(${ins[0]}, ${ins[1]}, ${ins[2]}, ${ins[3]});`; }
function _code_split(v, ins, p) {
    // Split genera múltiples outputs - caso especial
    return (
        `    float ${v}_x = (${ins[0]}).x;\n` +
        `    float ${v}_y = (${ins[0]}).y;\n` +
        `    float ${v}_z = (${ins[0]}).z;\n` +
        `    float ${v}_w = (${ins[0]}).w;`
    );
}
function _code_remap(v, ins, p) { return `    vec3 ${v} = ${ins[0]} * ${ins[1]} + ${ins[2]};`; }
function _code_one_minus(v, ins, p) { return `    vec3 ${v} = vec3(1.0) - ${ins[0]};`; }
function _code_negate(v, ins, p) { return `    vec3 ${v} = -${ins[0]};`; }
function _code_min(v, ins, p) { return `    vec3 ${v} = min(${ins[0]}, ${ins[1]});`; }
function _code_max(v, ins, p) { return `    vec3 ${v} = max(${ins[0]}, ${ins[1]});`; }
function _code_noise_simple(v, ins, p) {
    // Pseudo-noise usando sin (no es noise real, pero funcional sin extensiones)
    return `    vec3 ${v} = fract(sin(dot(${ins[0]}.xy, vec2(12.9898, 78.233))) * 43758.5453);\n`;
}

// ======================
// REGISTRY
// ======================

// Categorías
export const CAT_OUTPUT   = "Salida";
export const CAT_INPUT    = "Entrada";
export const CAT_CONSTANT = "Constante";
export const CAT_MATH     = "Matemática";
export const CAT_TRIG     = "Trigonometría";
export const CAT_VECTOR   = "Vector";
export const CAT_UTIL     = "Utilidad";

export const NODE_REGISTRY = new Map();

function _reg(type_id, title, category, inputs, outputs, code_fn,
              { params = null, color = null, description = null } = {}) {
    const nd = new NodeDef(type_id, title, category, inputs, outputs, code_fn,
                           params, color, description);
    NODE_REGISTRY.set(type_id, nd);
    return nd;
}

const S = (name, dtype, def = null, desc = null) => new SlotDef(name, dtype, def, desc);

// --- Salida ---
_reg(0, "Output", CAT_OUTPUT,
     [S("color", SLOT_VEC4, [0.0, 0.0, 0.0, 1.0], "slot_desc_output_color")],
     [],
     _code_output,
     { color: [0.6, 0.15, 0.15], description: "node_desc_output" });

// --- Entradas ---
_reg(1, "Time", CAT_INPUT, [],
     [S("t", SLOT_FLOAT, null, "slot_desc_time_t")],
     _code_time, { color: [0.15, 0.4, 0.15], description: "node_desc_time" });

_reg(2, "UV", CAT_INPUT, [],
     [S("uv", SLOT_VEC2, null, "slot_desc_uv_uv")],
     _code_uv, { color: [0.15, 0.4, 0.15], description: "node_desc_uv" });

_reg(3, "Resolution", CAT_INPUT, [],
     [S("res", SLOT_VEC2, null, "slot_desc_resolution_res")],
     _code_resolution, { color: [0.15, 0.4, 0.15], description: "node_desc_resolution" });

_reg(4, "Mouse", CAT_INPUT, [],
     [S("mouse", SLOT_VEC2, null, "slot_desc_mouse_mouse")],
     _code_mouse, { color: [0.15, 0.4, 0.15], description: "node_desc_mouse" });

_reg(5, "FragCoord", CAT_INPUT, [],
     [S("coord", SLOT_VEC2, null, "slot_desc_fragcoord_coord")],
     _code_fragcoord, { color: [0.15, 0.4, 0.15], description: "node_desc_fragcoord" });

_reg(6, "Texture", CAT_INPUT,
     [S("uv", SLOT_VEC2, null, "slot_desc_texture_uv")],
     [S("color", SLOT_VEC4, null, "slot_desc_texture_color")],
     _code_texture, { color: [0.15, 0.4, 0.15], description: "node_desc_texture" });

// --- Constantes ---
_reg(10, "Color", CAT_CONSTANT, [],
     [S("rgb", SLOT_VEC3, [1.0, 1.0, 1.0], "slot_desc_color_rgb")],
     _code_color,
     { params: [["r", "float", 1.0], ["g", "float", 1.0], ["b", "float", 1.0]],
       color: [0.5, 0.3, 0.1], description: "node_desc_color" });

_reg(11, "Float", CAT_CONSTANT, [],
     [S("val", SLOT_FLOAT, 0.0, "slot_desc_float_val")],
     _code_float,
     { params: [["value", "float", 0.0]], color: [0.5, 0.3, 0.1], description: "node_desc_float" });

_reg(12, "Vec2", CAT_CONSTANT, [],
     [S("vec", SLOT_VEC2, [0.0, 0.0], "slot_desc_vec2_vec")],
     _code_vec2,
     { params: [["x", "float", 0.0], ["y", "float", 0.0]], color: [0.5, 0.3, 0.1], description: "node_desc_vec2" });

// --- Matemática ---
const MATH = { color: [0.2, 0.2, 0.5] };
_reg(20, "Add", CAT_MATH,
     [S("A", SLOT_VEC3, null, "slot_desc_generic_A"), S("B", SLOT_VEC3, null, "slot_desc_generic_B")],
     [S("out", SLOT_VEC3, null, "slot_desc_math_out")],
     _code_add, { ...MATH, description: "node_desc_add" });

_reg(21, "Subtract", CAT_MATH,
     [S("A", SLOT_VEC3, null, "slot_desc_generic_A"), S("B", SLOT_VEC3, null, "slot_desc_generic_B")],
     [S("out", SLOT_VEC3, null, "slot_desc_math_out")],
     _code_sub, { ...MATH, description: "node_desc_subtract" });

_reg(22, "Multiply", CAT_MATH,
     [S("A", SLOT_VEC3, null, "slot_desc_generic_A"), S("B", SLOT_VEC3, null, "slot_desc_generic_B")],
     [S("out", SLOT_VEC3, null, "slot_desc_math_out")],
     _code_mul, { ...MATH, description: "node_desc_multiply" });

_reg(23, "Divide", CAT_MATH,
     [S("A", SLOT_VEC3, null, "slot_desc_generic_A"), S("B", SLOT_VEC3, null, "slot_desc_generic_B")],
     [S("out", SLOT_VEC3, null, "slot_desc_math_out")],
     _code_div, { ...MATH, description: "node_desc_divide" });

_reg(24, "Mix", CAT_MATH,
     [S("A", SLOT_VEC3, null, "slot_desc_mix_A"),
      S("B", SLOT_VEC3, null, "slot_desc_mix_B"),
      S("t", SLOT_FLOAT, 0.5, "slot_desc_mix_t")],
     [S("out", SLOT_VEC3, null, "slot_desc_math_out")],
     _code_mix, { ...MATH, description: "node_desc_mix" });

_reg(25, "Step", CAT_MATH,
     [S("edge", SLOT_VEC3, null, "slot_desc_step_edge"), S("x", SLOT_VEC3, null, "slot_desc_unary_x")],
     [S("out", SLOT_VEC3, null, "slot_desc_math_out")],
     _code_step, { ...MATH, description: "node_desc_step" });

_reg(26, "Smoothstep", CAT_MATH,
     [S("e0", SLOT_VEC3, null, "slot_desc_smoothstep_e0"),
      S("e1", SLOT_VEC3, null, "slot_desc_smoothstep_e1"),
      S("x", SLOT_VEC3, null, "slot_desc_unary_x")],
     [S("out", SLOT_VEC3, null, "slot_desc_math_out")],
     _code_smoothstep, { ...MATH, description: "node_desc_smoothstep" });

_reg(27, "Clamp", CAT_MATH,
     [S("x", SLOT_VEC3, null, "slot_desc_unary_x"),
      S("min", SLOT_VEC3, [0.0, 0.0, 0.0], "slot_desc_clamp_min"),
      S("max", SLOT_VEC3, [1.0, 1.0, 1.0], "slot_desc_clamp_max")],
     [S("out", SLOT_VEC3, null, "slot_desc_math_out")],
     _code_clamp, { ...MATH, description: "node_desc_clamp" });

_reg(28, "Power", CAT_MATH,
     [S("base", SLOT_VEC3, null, "slot_desc_pow_base"), S("exp", SLOT_VEC3, null, "slot_desc_pow_exp")],
     [S("out", SLOT_VEC3, null, "slot_desc_math_out")],
     _code_pow, { ...MATH, description: "node_desc_power" });

_reg(29, "Sqrt", CAT_MATH,
     [S("x", SLOT_VEC3, null, "slot_desc_unary_x")],
     [S("out", SLOT_VEC3, null, "slot_desc_math_out")],
     _code_sqrt, { ...MATH, description: "node_desc_sqrt" });

_reg(30, "Mod", CAT_MATH,
     [S("x", SLOT_VEC3, null, "slot_desc_unary_x"), S("y", SLOT_VEC3, null, "slot_desc_mod_y")],
     [S("out", SLOT_VEC3, null, "slot_desc_math_out")],
     _code_mod, { ...MATH, description: "node_desc_mod" });

_reg(31, "Min", CAT_MATH,
     [S("A", SLOT_VEC3, null, "slot_desc_generic_A"), S("B", SLOT_VEC3, null, "slot_desc_generic_B")],
     [S("out", SLOT_VEC3, null, "slot_desc_math_out")],
     _code_min, { ...MATH, description: "node_desc_min" });

_reg(32, "Max", CAT_MATH,
     [S("A", SLOT_VEC3, null, "slot_desc_generic_A"), S("B", SLOT_VEC3, null, "slot_desc_generic_B")],
     [S("out", SLOT_VEC3, null, "slot_desc_math_out")],
     _code_max, { ...MATH, description: "node_desc_max" });

// --- Trigonometría ---
const TRIG = { color: [0.15, 0.35, 0.45] };
_reg(40, "Sin", CAT_TRIG,
     [S("x", SLOT_VEC3, null, "slot_desc_trig_x")],
     [S("out", SLOT_VEC3, null, "slot_desc_trig_out")],
     _code_sin, { ...TRIG, description: "node_desc_sin" });

_reg(41, "Cos", CAT_TRIG,
     [S("x", SLOT_VEC3, null, "slot_desc_trig_x")],
     [S("out", SLOT_VEC3, null, "slot_desc_trig_out")],
     _code_cos, { ...TRIG, description: "node_desc_cos" });

_reg(42, "Abs", CAT_TRIG,
     [S("x", SLOT_VEC3, null, "slot_desc_unary_x")],
     [S("out", SLOT_VEC3, null, "slot_desc_math_out")],
     _code_abs, { ...TRIG, description: "node_desc_abs" });

_reg(43, "Fract", CAT_TRIG,
     [S("x", SLOT_VEC3, null, "slot_desc_unary_x")],
     [S("out", SLOT_VEC3, null, "slot_desc_math_out")],
     _code_fract, { ...TRIG, description: "node_desc_fract" });

_reg(44, "Floor", CAT_TRIG,
     [S("x", SLOT_VEC3, null, "slot_desc_unary_x")],
     [S("out", SLOT_VEC3, null, "slot_desc_math_out")],
     _code_floor, { ...TRIG, description: "node_desc_floor" });

// --- Vector ---
const VEC = { color: [0.4, 0.2, 0.4] };
_reg(50, "Length", CAT_VECTOR,
     [S("v", SLOT_VEC3, null, "slot_desc_vec_v")],
     [S("len", SLOT_FLOAT, null, "slot_desc_length_out")],
     _code_length, { ...VEC, description: "node_desc_length" });

_reg(51, "Normalize", CAT_VECTOR,
     [S("v", SLOT_VEC3, null, "slot_desc_vec_v")],
     [S("out", SLOT_VEC3, null, "slot_desc_normalize_out")],
     _code_normalize, { ...VEC, description: "node_desc_normalize" });

_reg(52, "Dot", CAT_VECTOR,
     [S("A", SLOT_VEC3, null, "slot_desc_dot_A"), S("B", SLOT_VEC3, null, "slot_desc_dot_B")],
     [S("out", SLOT_FLOAT, null, "slot_desc_dot_out")],
     _code_dot, { ...VEC, description: "node_desc_dot" });

_reg(53, "Cross", CAT_VECTOR,
     [S("A", SLOT_VEC3, null, "slot_desc_cross_A"), S("B", SLOT_VEC3, null, "slot_desc_cross_B")],
     [S("out", SLOT_VEC3, null, "slot_desc_cross_out")],
     _code_cross, { ...VEC, description: "node_desc_cross" });

_reg(54, "Reflect", CAT_VECTOR,
     [S("I", SLOT_VEC3, null, "slot_desc_reflect_I"), S("N", SLOT_VEC3, null, "slot_desc_reflect_N")],
     [S("out", SLOT_VEC3, null, "slot_desc_reflect_out")],
     _code_reflect, { ...VEC, description: "node_desc_reflect" });

_reg(55, "Distance", CAT_VECTOR,
     [S("A", SLOT_VEC3, null, "slot_desc_dist_A"), S("B", SLOT_VEC3, null, "slot_desc_dist_B")],
     [S("out", SLOT_FLOAT, null, "slot_desc_dist_out")],
     _code_distance, { ...VEC, description: "node_desc_distance" });

// --- Utilidad ---
const UTIL = { color: [0.35, 0.35, 0.2] };
_reg(60, "Combine XYZ", CAT_UTIL,
     [S("X", SLOT_FLOAT, 0.0, "slot_desc_combine_X"),
      S("Y", SLOT_FLOAT, 0.0, "slot_desc_combine_Y"),
      S("Z", SLOT_FLOAT, 0.0, "slot_desc_combine_Z")],
     [S("vec", SLOT_VEC3, null, "slot_desc_combine3_out")],
     _code_combine3, { ...UTIL, description: "node_desc_combine_xyz" });

_reg(61, "Combine XYZW", CAT_UTIL,
     [S("X", SLOT_FLOAT, 0.0, "slot_desc_combine_X"),
      S("Y", SLOT_FLOAT, 0.0, "slot_desc_combine_Y"),
      S("Z", SLOT_FLOAT, 0.0, "slot_desc_combine_Z"),
      S("W", SLOT_FLOAT, 1.0, "slot_desc_combine_W")],
     [S("vec", SLOT_VEC4, null, "slot_desc_combine4_out")],
     _code_combine4, { ...UTIL, description: "node_desc_combine_xyzw" });

_reg(62, "Split", CAT_UTIL,
     [S("vec", SLOT_VEC4, null, "slot_desc_split_in")],
     [S("x", SLOT_FLOAT, null, "slot_desc_split_x"),
      S("y", SLOT_FLOAT, null, "slot_desc_split_y"),
      S("z", SLOT_FLOAT, null, "slot_desc_split_z"),
      S("w", SLOT_FLOAT, null, "slot_desc_split_w")],
     _code_split, { ...UTIL, description: "node_desc_split" });

_reg(63, "Remap", CAT_UTIL,
     [S("x", SLOT_VEC3, null, "slot_desc_remap_x"),
      S("scale", SLOT_VEC3, [1.0, 1.0, 1.0], "slot_desc_remap_scale"),
      S("offset", SLOT_VEC3, null, "slot_desc_remap_offset")],
     [S("out", SLOT_VEC3, null, "slot_desc_math_out")],
     _code_remap, { ...UTIL, description: "node_desc_remap" });

_reg(64, "One Minus", CAT_UTIL,
     [S("x", SLOT_VEC3, null, "slot_desc_unary_x")],
     [S("out", SLOT_VEC3, null, "slot_desc_math_out")],
     _code_one_minus, { ...UTIL, description: "node_desc_one_minus" });

_reg(65, "Negate", CAT_UTIL,
     [S("x", SLOT_VEC3, null, "slot_desc_unary_x")],
     [S("out", SLOT_VEC3, null, "slot_desc_math_out")],
     _code_negate, { ...UTIL, description: "node_desc_negate" });

_reg(66, "Noise", CAT_UTIL,
     [S("pos", SLOT_VEC3, null, "slot_desc_noise_pos")],
     [S("out", SLOT_VEC3, null, "slot_desc_math_out")],
     _code_noise_simple, { ...UTIL, description: "node_desc_noise" });

// Lista ordenada por categoría para el menú
export function get_node_menu() {
    const cats = new Map();
    for (const nd of NODE_REGISTRY.values()) {
        if (nd.type_id === 0) continue; // Output no se muestra en menú
        if (!cats.has(nd.category)) cats.set(nd.category, []);
        cats.get(nd.category).push(nd);
    }
    // Orden fijo
    const order = [CAT_INPUT, CAT_CONSTANT, CAT_MATH, CAT_TRIG, CAT_VECTOR, CAT_UTIL];
    const result = [];
    for (const cat of order) {
        if (cats.has(cat)) {
            result.push([cat, [...cats.get(cat)].sort((a, b) => a.type_id - b.type_id)]);
        }
    }
    return result;
}

// Mapping de node type_id a localization key
export const NODE_LOCALIZATION_MAP = {
    0: "node_name_output",
    1: "node_name_time",
    2: "node_name_uv",
    3: "node_name_resolution",
    4: "node_name_mouse",
    5: "node_name_fragcoord",
    6: "node_name_texture",
    10: "node_name_color",
    11: "node_name_float",
    12: "node_name_vec2",
    20: "node_name_add",
    21: "node_name_subtract",
    22: "node_name_multiply",
    23: "node_name_divide",
    24: "node_name_mix",
    25: "node_name_step",
    26: "node_name_smoothstep",
    27: "node_name_clamp",
    28: "node_name_power",
    29: "node_name_sqrt",
    30: "node_name_mod",
    31: "node_name_min",
    32: "node_name_max",
    40: "node_name_sin",
    41: "node_name_cos",
    42: "node_name_abs",
    43: "node_name_fract",
    44: "node_name_floor",
    50: "node_name_length",
    51: "node_name_normalize",
    52: "node_name_dot",
    53: "node_name_cross",
    54: "node_name_reflect",
    55: "node_name_distance",
    60: "node_name_combine_xyz",
    61: "node_name_combine_xyzw",
    62: "node_name_split",
    63: "node_name_remap",
    64: "node_name_one_minus",
    65: "node_name_negate",
    66: "node_name_noise",
};

// Mapping de category name a localization key
export const CATEGORY_LOCALIZATION_MAP = {
    "Salida": "category_output",
    "Entrada": "category_input",
    "Constante": "category_constant",
    "Matemática": "category_math",
    "Trigonometría": "category_trigonometry",
    "Vector": "category_vector",
    "Utilidad": "category_utility",
    // English fallback
    "Output": "category_output",
    "Input": "category_input",
    "Constant": "category_constant",
    "Math": "category_math",
    "Trigonometry": "category_trigonometry",
};

export function get_localized_node_name(node_def, localize_fn = null) {
    /** Nombre traducido del nodo. Sin localize_fn retorna el título. */
    if (localize_fn === null) return node_def.title;
    const key = NODE_LOCALIZATION_MAP[node_def.type_id] || "";
    if (key) return localize_fn(key);
    return node_def.title;
}

export function get_localized_category_name(category, localize_fn = null) {
    /** Nombre traducido de la categoría. Sin localize_fn retorna el nombre. */
    if (localize_fn === null) return category;
    const key = CATEGORY_LOCALIZATION_MAP[category] || "";
    if (key) return localize_fn(key);
    return category;
}

// ======================
// NODE INSTANCE
// ======================

export class NodeInstance {
    static _next_id = 1;

    constructor(type_id, x = 0, y = 0, node_id = null) {
        if (node_id !== null && node_id !== undefined) {
            this.id = node_id;
            NodeInstance._next_id = Math.max(NodeInstance._next_id, node_id + 1);
        } else {
            this.id = NodeInstance._next_id;
            NodeInstance._next_id += 1;
        }

        this.type_id = type_id;
        this.x = x;
        this.y = y;
        this.params = {};

        // Cargar defaults
        const nd = NODE_REGISTRY.get(type_id);
        if (nd && nd.params.length) {
            for (const [pname, , pdefault] of nd.params) this.params[pname] = pdefault;
        }
    }

    get node_def() {
        return NODE_REGISTRY.get(this.type_id) || null;
    }

    get title() {
        const nd = this.node_def;
        return nd ? nd.title : "???";
    }

    get width() {
        return NODE_W;
    }

    get height() {
        const nd = this.node_def;
        return nd ? nd.height() : 50;
    }

    input_slot_pos(slot_idx) {
        const nd = this.node_def;
        if (!nd || slot_idx >= nd.inputs.length) return [this.x, this.y];
        const y = this.y + NODE_H_HEADER + slot_idx * NODE_H_SLOT + Math.floor(NODE_H_SLOT / 2);
        return [this.x, y];
    }

    output_slot_pos(slot_idx) {
        const nd = this.node_def;
        if (!nd || slot_idx >= nd.outputs.length) return [this.x + NODE_W, this.y];
        const y = this.y + NODE_H_HEADER + slot_idx * NODE_H_SLOT + Math.floor(NODE_H_SLOT / 2);
        return [this.x + NODE_W, y];
    }

    hit_test(mx, my) {
        return (this.x <= mx && mx <= this.x + this.width &&
                this.y <= my && my <= this.y + this.height);
    }

    hit_input_slot(mx, my) {
        const nd = this.node_def;
        if (!nd) return -1;
        for (let i = 0; i < nd.inputs.length; i++) {
            const [sx, sy] = this.input_slot_pos(i);
            if ((mx - sx) ** 2 + (my - sy) ** 2 < (NODE_SLOT_RADIUS + 6) ** 2) return i;
        }
        return -1;
    }

    hit_output_slot(mx, my) {
        const nd = this.node_def;
        if (!nd) return -1;
        for (let i = 0; i < nd.outputs.length; i++) {
            const [sx, sy] = this.output_slot_pos(i);
            if ((mx - sx) ** 2 + (my - sy) ** 2 < (NODE_SLOT_RADIUS + 6) ** 2) return i;
        }
        return -1;
    }

    to_tuple() {
        const configs = [];
        const nd = this.node_def;
        if (nd && nd.params.length && Object.keys(this.params).length) {
            nd.params.forEach(([pname, , pdefault], i) => {
                const val = this.params[pname];
                if (val !== null && val !== undefined && val !== pdefault) {
                    configs.push([i, Number(val)]);
                }
            });
        }
        return [this.id, this.type_id, pyInt(this.x), pyInt(this.y), configs];
    }

    static from_tuple(t) {
        const n = new NodeInstance(t[1], t[2], t[3], t[0]);
        const configs = t.length > 4 ? t[4] : [];
        if (configs && configs.length) {
            const nd = NODE_REGISTRY.get(t[1]);
            if (nd && nd.params.length) {
                for (const [idx, val] of configs) {
                    if (idx < nd.params.length) {
                        n.params[nd.params[idx][0]] = val;
                    }
                }
            }
        }
        return n;
    }
}

// ======================
// LINK INSTANCE
// ======================

export class LinkInstance {
    constructor(from_node, to_node, from_slot, to_slot) {
        this.from_node = from_node; // node id
        this.to_node = to_node;     // node id
        this.from_slot = from_slot; // output slot index
        this.to_slot = to_slot;     // input slot index
    }

    to_tuple() {
        return [this.from_node, this.to_node, this.from_slot, this.to_slot];
    }

    static from_tuple(t) {
        return new LinkInstance(t[0], t[1], t[2], t[3]);
    }
}

// ======================
// COMPILER (node graph -> GLSL)
// ======================

export class GraphCompiler {
    constructor(nodes, links) {
        this.nodes = new Map();
        for (const n of nodes) this.nodes.set(n.id, n);
        this.links = links;
        this._var_counter = 0;
    }

    compile() {
        // Encontrar nodo Output
        let output_node = null;
        for (const n of this.nodes.values()) {
            if (n.type_id === 0) {
                output_node = n;
                break;
            }
        }

        if (!output_node) return this._fallback_shader();

        // Orden topológico desde output hacia atrás
        const order = [];
        const visited = new Set();
        this._topo_visit(output_node.id, visited, order);

        // Generar código
        const lines = [
            ...GLSL_VERSION_LINES,
            "",
            "uniform float iTime;",
            "uniform vec2 iResolution;",
            "uniform vec2 iMouse;",
            "uniform sampler2D iChannel0;",
            "",
            "out vec4 fragColor;",
            "",
            "void main() {",
        ];

        const var_map = new Map(); // node_id -> var_name

        for (const nid of order) {
            const node = this.nodes.get(nid);
            const nd = node.node_def;
            if (!nd) continue;

            const var_name = `_n${nid}`;

            // Resolver inputs
            const input_vars = [];
            nd.inputs.forEach((slot, si) => {
                const connected = this._find_link_to(nid, si);
                if (connected) {
                    const src_node = this.nodes.get(connected.from_node);
                    const src_nd = src_node.node_def;
                    let src_var = var_map.has(connected.from_node)
                        ? var_map.get(connected.from_node) : `_n${connected.from_node}`;
                    let src_type;

                    // Manejar Split (outputs múltiples)
                    if (src_nd && src_nd.type_id === 62) {
                        const suffixes = ["_x", "_y", "_z", "_w"];
                        if (connected.from_slot < suffixes.length) {
                            src_var = `${src_var}${suffixes[connected.from_slot]}`;
                            src_type = SLOT_FLOAT;
                        } else {
                            src_type = slot.dtype;
                        }
                    } else if (src_nd && connected.from_slot < src_nd.outputs.length) {
                        src_type = src_nd.outputs[connected.from_slot].dtype;
                    } else {
                        src_type = slot.dtype;
                    }

                    input_vars.push(auto_cast(src_var, src_type, slot.dtype));
                } else {
                    input_vars.push(slot.default_str());
                }
            });

            // Generar línea de código
            const code = nd.code_fn(var_name, input_vars, node.params);
            if (code) {
                for (const line of pyStrip(code).split("\n")) lines.push(line);
            }

            var_map.set(nid, var_name);
        }

        lines.push("}");
        lines.push("");

        return lines.join("\n");
    }

    _topo_visit(nid, visited, order) {
        if (visited.has(nid)) return;
        visited.add(nid);

        // Visitar dependencias primero
        for (const link of this.links) {
            if (link.to_node === nid && this.nodes.has(link.from_node)) {
                this._topo_visit(link.from_node, visited, order);
            }
        }

        order.push(nid);
    }

    _find_link_to(node_id, slot_idx) {
        for (const link of this.links) {
            if (link.to_node === node_id && link.to_slot === slot_idx) return link;
        }
        return null;
    }

    _fallback_shader() {
        return (
            GLSL_VERSION_LINES.join("\n") + "\n" +
            "uniform float iTime;\n" +
            "uniform vec2 iResolution;\n" +
            "uniform sampler2D iChannel0;\n" +
            "out vec4 fragColor;\n" +
            "void main() {\n" +
            "    vec2 uv = gl_FragCoord.xy / iResolution.xy;\n" +
            "    fragColor = texture(iChannel0, uv);\n" +
            "}\n"
        );
    }
}

// ======================
// DECOMPILER (GLSL -> node graph)
// ======================

// Equivalentes a \s y \d de Python; '.' de Python = cualquier carácter menos \n
const s_ = `[${PY_WS_CLASS}]`;
const d_ = "\\p{Nd}";
const ANY = "[^\\n]";

/** Compila una regex escrita con la sintaxis de nodes.py (\s, \d, .) */
function R(src) {
    const out = src
        .replace(/\\s/g, s_)
        .replace(/\\d/g, d_)
        .replace(/(^|[^\\])\.(?=[+*?])/g, `$1${ANY}`);
    return new RegExp(out, "u");
}

// Regex helpers
const _VAR = "_n(\\d+)"; // captura node id

export function _extract_refs(expr) {
    /** Extrae todas las referencias _nX de una expresión: [[node_id, suffix], ...] */
    const refs = [];
    const re = new RegExp(`_n(${d_}+)(_[xyzw])?`, "gu");
    let m;
    while ((m = re.exec(expr)) !== null) refs.push([pyParseInt(m[1]), m[2] || ""]);
    return refs;
}

function _float() {
    /** Regex pattern for a float literal. */
    return "-?[\\d]+\\.[\\d]+";
}

function _is_float_literal(s) {
    /** Check if string is a pure float literal. */
    try {
        pyFloat(s);
    } catch (e) {
        return false;
    }
    return !new RegExp(`_n${d_}+`, "u").test(s);
}

function _resolve_ref(expr) {
    /** Dada una expresión de input, extrae la referencia al nodo fuente.
     *  Maneja auto-cast wrappers como vec3(_nX), (_nX).xy, etc.
     *  Retorna [node_id, suffix] o null. */
    expr = pyStrip(expr);
    let m;

    // Referencia directa: _nX
    m = R("^_n(\\d+)$").exec(expr);
    if (m) return [pyParseInt(m[1]), ""];

    // Split reference: _nX_x, _nX_y, etc.
    m = R("^_n(\\d+)(_[xyzw])$").exec(expr);
    if (m) return [pyParseInt(m[1]), m[2]];

    // Auto-cast vec3(_nX) o vec2(_nX) o vec4(_nX)
    m = R("^vec[234]\\((_n\\d+)\\)$").exec(expr);
    if (m) {
        const m2 = R("^_n(\\d+)$").exec(m[1]);
        if (m2) return [pyParseInt(m2[1]), ""];
    }

    // Auto-cast vec3(_nX, 0.0) / vec4(_nX, 0.0, 1.0) etc
    m = R("^vec[234]\\((_n\\d+)(?:,\\s*[\\d.]+)*\\)$").exec(expr);
    if (m) {
        const m2 = R("^_n(\\d+)$").exec(m[1]);
        if (m2) return [pyParseInt(m2[1]), ""];
    }

    // Auto-cast (_nX).xyz, (_nX).xy, (_nX).x
    m = R("^\\((_n\\d+)\\)\\.[xyzwrgba]+$").exec(expr);
    if (m) {
        const m2 = R("^_n(\\d+)$").exec(m[1]);
        if (m2) return [pyParseInt(m2[1]), ""];
    }

    // Cast complejo: vec4(_nX, 1.0) etc
    m = R("^vec[234]\\((_n\\d+(?:_[xyzw])?),?\\s*.*\\)$").exec(expr);
    if (m) {
        const m2 = R("^_n(\\d+)(_[xyzw])?$").exec(m[1]);
        if (m2) return [pyParseInt(m2[1]), m2[2] || ""];
    }

    return null;
}

export class GraphDecompiler {
    /** Parsea código GLSL generado por GraphCompiler y reconstruye nodos + links. */

    constructor() {
        this._patterns = this._build_patterns();
    }

    _build_patterns() {
        const V = _VAR;
        const F = _float();
        const p = [];

        // ORDEN: más específicos primero para evitar ambigüedades

        // --- Output (type_id=0) ---
        p.push([R("^\\s*fragColor\\s*=\\s*(.+);$"), 0, "output"]);

        // --- Inputs (literal, sin ambigüedad) ---
        p.push([R(`^\\s*float\\s+${V}\\s*=\\s*iTime\\s*;$`), 1, "simple"]);
        p.push([R(`^\\s*vec2\\s+${V}\\s*=\\s*gl_FragCoord\\.xy\\s*/\\s*iResolution\\.xy\\s*;$`), 2, "simple"]);
        p.push([R(`^\\s*vec2\\s+${V}\\s*=\\s*iResolution\\s*;$`), 3, "simple"]);
        p.push([R(`^\\s*vec2\\s+${V}\\s*=\\s*iMouse\\s*/\\s*iResolution\\s*;$`), 4, "simple"]);
        p.push([R(`^\\s*vec2\\s+${V}\\s*=\\s*gl_FragCoord\\.xy\\s*;$`), 5, "simple"]);

        // --- Texture (type_id=6): vec4 _nX = texture(iChannel0, uv_expr); ---
        p.push([R(`^\\s*vec4\\s+${V}\\s*=\\s*texture\\(iChannel0,\\s*(.+?)\\)\\s*;$`), 6, "unary"]);

        // --- Constants (literales float, sin ambigüedad) ---
        p.push([R(`^\\s*vec3\\s+${V}\\s*=\\s*vec3\\((${F}),\\s*(${F}),\\s*(${F})\\)\\s*;$`), 10, "color"]);
        p.push([R(`^\\s*float\\s+${V}\\s*=\\s*(${F})\\s*;$`), 11, "float_const"]);
        p.push([R(`^\\s*vec2\\s+${V}\\s*=\\s*vec2\\((${F}),\\s*(${F})\\)\\s*;$`), 12, "vec2_const"]);

        // --- Funciones nombradas (sin ambigüedad) ---
        // Noise (66) ANTES de fract — patrón más largo y específico
        p.push([R(`^\\s*vec3\\s+${V}\\s*=\\s*fract\\(sin\\(dot\\((.+?)\\.xy,\\s*vec2\\(12\\.9898,\\s*78\\.233\\)\\)\\)\\s*\\*\\s*43758\\.5453\\)\\s*;?$`), 66, "unary"]);
        // Sqrt (29) ANTES de max — patrón específico sqrt(max(...))
        p.push([R(`^\\s*vec3\\s+${V}\\s*=\\s*sqrt\\(max\\((.+?),\\s*vec3\\(0\\.0\\)\\)\\)\\s*;$`), 29, "unary"]);
        // Div (23) ANTES de operadores — patrón específico / max(..., vec3(0.0001))
        p.push([R(`^\\s*vec3\\s+${V}\\s*=\\s*(.+?)\\s*/\\s*max\\((.+?),\\s*vec3\\(0\\.0001\\)\\)\\s*;$`), 23, "binary"]);

        // Funciones con nombre explícito (mix, step, smoothstep, clamp, pow, mod)
        p.push([R(`^\\s*vec3\\s+${V}\\s*=\\s*mix\\((.+?),\\s*(.+?),\\s*(.+?)\\)\\s*;$`), 24, "ternary"]);
        p.push([R(`^\\s*vec3\\s+${V}\\s*=\\s*step\\((.+?),\\s*(.+?)\\)\\s*;$`), 25, "binary_fn"]);
        p.push([R(`^\\s*vec3\\s+${V}\\s*=\\s*smoothstep\\((.+?),\\s*(.+?),\\s*(.+?)\\)\\s*;$`), 26, "ternary"]);
        p.push([R(`^\\s*vec3\\s+${V}\\s*=\\s*clamp\\((.+?),\\s*(.+?),\\s*(.+?)\\)\\s*;$`), 27, "ternary"]);
        p.push([R(`^\\s*vec3\\s+${V}\\s*=\\s*pow\\((.+?),\\s*(.+?)\\)\\s*;$`), 28, "binary_fn"]);
        p.push([R(`^\\s*vec3\\s+${V}\\s*=\\s*mod\\((.+?),\\s*(.+?)\\)\\s*;$`), 30, "binary_fn"]);

        // min/max como funciones (31/32) — no ambiguo
        p.push([R(`^\\s*vec3\\s+${V}\\s*=\\s*min\\((.+?),\\s*(.+?)\\)\\s*;$`), 31, "binary_fn"]);
        p.push([R(`^\\s*vec3\\s+${V}\\s*=\\s*max\\((.+?),\\s*(.+?)\\)\\s*;$`), 32, "binary_fn"]);

        // Trig/unary con nombre (sin, cos, abs, fract, floor)
        p.push([R(`^\\s*vec3\\s+${V}\\s*=\\s*sin\\((.+?)\\)\\s*;$`), 40, "unary"]);
        p.push([R(`^\\s*vec3\\s+${V}\\s*=\\s*cos\\((.+?)\\)\\s*;$`), 41, "unary"]);
        p.push([R(`^\\s*vec3\\s+${V}\\s*=\\s*abs\\((.+?)\\)\\s*;$`), 42, "unary"]);
        p.push([R(`^\\s*vec3\\s+${V}\\s*=\\s*fract\\((.+?)\\)\\s*;$`), 43, "unary"]);
        p.push([R(`^\\s*vec3\\s+${V}\\s*=\\s*floor\\((.+?)\\)\\s*;$`), 44, "unary"]);

        // Vector con nombre (length, normalize, dot, cross, reflect, distance)
        p.push([R(`^\\s*float\\s+${V}\\s*=\\s*length\\((.+?)\\)\\s*;$`), 50, "unary"]);
        p.push([R(`^\\s*vec3\\s+${V}\\s*=\\s*normalize\\((.+?)\\)\\s*;$`), 51, "unary"]);
        p.push([R(`^\\s*float\\s+${V}\\s*=\\s*dot\\((.+?),\\s*(.+?)\\)\\s*;$`), 52, "binary_fn"]);
        p.push([R(`^\\s*vec3\\s+${V}\\s*=\\s*cross\\((.+?),\\s*(.+?)\\)\\s*;$`), 53, "binary_fn"]);
        p.push([R(`^\\s*vec3\\s+${V}\\s*=\\s*reflect\\((.+?),\\s*(.+?)\\)\\s*;$`), 54, "binary_fn"]);
        p.push([R(`^\\s*float\\s+${V}\\s*=\\s*distance\\((.+?),\\s*(.+?)\\)\\s*;$`), 55, "binary_fn"]);

        // --- Utility con constructores ---
        // Combine XYZW (61): vec4(_nX, _nY, _nZ, _nW) — ANTES de combine3
        p.push([R(`^\\s*vec4\\s+${V}\\s*=\\s*vec4\\((.+?),\\s*(.+?),\\s*(.+?),\\s*(.+?)\\)\\s*;$`), 61, "combine4"]);
        // Combine XYZ (60) / Color (10): vec3(A, B, C) — desambiguación en handler
        p.push([R(`^\\s*vec3\\s+${V}\\s*=\\s*vec3\\((.+?),\\s*(.+?),\\s*(.+?)\\)\\s*;$`), 60, "combine3"]);

        // --- One Minus (64) ANTES de Sub: vec3(1.0) - X ---
        p.push([R(`^\\s*vec3\\s+${V}\\s*=\\s*vec3\\(1\\.0\\)\\s*-\\s*(.+?)\\s*;$`), 64, "unary"]);

        // --- Remap (63) ANTES de Add/Mul: A * B + C ---
        p.push([R(`^\\s*vec3\\s+${V}\\s*=\\s*(.+?)\\s*\\*\\s*(.+?)\\s*\\+\\s*(.+?)\\s*;$`), 63, "ternary"]);

        // --- Negate (65) ANTES de Sub: -A ---
        p.push([R(`^\\s*vec3\\s+${V}\\s*=\\s*-(.+?)\\s*;$`), 65, "unary"]);

        // --- Operadores aritméticos genéricos (últimos, son los más ambiguos) ---
        p.push([R(`^\\s*vec3\\s+${V}\\s*=\\s*(.+?)\\s*\\+\\s*(.+?)\\s*;$`), 20, "binary"]);
        p.push([R(`^\\s*vec3\\s+${V}\\s*=\\s*(.+?)\\s*-\\s*(.+?)\\s*;$`), 21, "binary"]);
        p.push([R(`^\\s*vec3\\s+${V}\\s*=\\s*(.+?)\\s*\\*\\s*(.+?)\\s*;$`), 22, "binary"]);

        return p;
    }

    decompile(source, existing_nodes = null) {
        /**
         * Parsea código GLSL y retorna [nodes_list, links_list].
         * existing_nodes: Map {node_id: [x, y, type_id]} para preservar posiciones.
         * Retorna null si no puede parsear (código no generado por GraphCompiler).
         */
        const lines = pyStrip(source).split("\n");

        // Verificar que tiene la estructura básica del shader generado
        let has_main = false;
        const main_lines = [];
        let in_main = false;
        for (const line of lines) {
            const stripped = pyStrip(line);
            if (stripped.startsWith("void main()")) {
                has_main = true;
                in_main = true;
                continue;
            }
            if (in_main) {
                if (stripped === "}") {
                    in_main = false;
                    continue;
                }
                if (stripped) main_lines.push(stripped);
            }
        }

        if (!has_main || !main_lines.length) return null;

        // Parsear cada línea del main
        const parsed_nodes = new Map(); // node_id -> [type_id, params, input_exprs]
        const node_order = [];          // orden de aparición

        const RE_SPLIT_X = R("^\\s*float\\s+_n(\\d+)_x\\s*=\\s*\\((.+?)\\)\\.x\\s*;$");

        let i = 0;
        while (i < main_lines.length) {
            const line = main_lines[i];
            let parsed = false;

            // Caso especial: Split (multi-línea)
            const split_m = RE_SPLIT_X.exec(line);
            if (split_m) {
                const nid = pyParseInt(split_m[1]);
                const input_expr = split_m[2];
                // Consumir las líneas _y, _z, _w
                let consumed = 1;
                for (const suffix of ["_y", "_z", "_w"]) {
                    if (i + consumed < main_lines.length) {
                        const next_re = R(`^\\s*float\\s+_n${nid}${suffix}\\s*=\\s*\\(.+?\\)\\.${suffix[suffix.length - 1]}\\s*;$`);
                        if (next_re.exec(main_lines[i + consumed])) consumed += 1;
                    }
                }
                parsed_nodes.set(nid, [62, {}, [input_expr]]);
                node_order.push(nid);
                i += consumed;
                continue;
            }

            // Probar cada patrón
            for (const [regex, type_id, handler] of this._patterns) {
                const m = regex.exec(line);
                if (!m) continue;

                if (handler === "output") {
                    // fragColor = expr;
                    const input_expr = m[1];
                    let out_id = null;
                    if (existing_nodes) {
                        for (const [eid, [, , etid]] of existing_nodes) {
                            if (etid === 0) {
                                out_id = eid;
                                break;
                            }
                        }
                    }
                    if (out_id === null) out_id = 0; // placeholder
                    parsed_nodes.set(out_id, [0, {}, [input_expr]]);
                    node_order.push(out_id);
                    parsed = true;
                    break;

                } else if (handler === "simple") {
                    const nid = pyParseInt(m[1]);
                    parsed_nodes.set(nid, [type_id, {}, []]);
                    node_order.push(nid);
                    parsed = true;
                    break;

                } else if (handler === "color") {
                    const nid = pyParseInt(m[1]);
                    parsed_nodes.set(nid, [type_id, { r: pyFloat(m[2]), g: pyFloat(m[3]), b: pyFloat(m[4]) }, []]);
                    node_order.push(nid);
                    parsed = true;
                    break;

                } else if (handler === "float_const") {
                    const nid = pyParseInt(m[1]);
                    parsed_nodes.set(nid, [type_id, { value: pyFloat(m[2]) }, []]);
                    node_order.push(nid);
                    parsed = true;
                    break;

                } else if (handler === "vec2_const") {
                    const nid = pyParseInt(m[1]);
                    parsed_nodes.set(nid, [type_id, { x: pyFloat(m[2]), y: pyFloat(m[3]) }, []]);
                    node_order.push(nid);
                    parsed = true;
                    break;

                } else if (handler === "unary") {
                    const nid = pyParseInt(m[1]);
                    parsed_nodes.set(nid, [type_id, {}, [m[2]]]);
                    node_order.push(nid);
                    parsed = true;
                    break;

                } else if (handler === "binary" || handler === "binary_fn") {
                    const nid = pyParseInt(m[1]);
                    parsed_nodes.set(nid, [type_id, {}, [m[2], m[3]]]);
                    node_order.push(nid);
                    parsed = true;
                    break;

                } else if (handler === "ternary") {
                    const nid = pyParseInt(m[1]);
                    parsed_nodes.set(nid, [type_id, {}, [m[2], m[3], m[4]]]);
                    node_order.push(nid);
                    parsed = true;
                    break;

                } else if (handler === "combine3") {
                    const nid = pyParseInt(m[1]);
                    const args = [m[2], m[3], m[4]];
                    // Distinguir Color vs Combine XYZ:
                    // Color usa literales float, Combine usa refs a _nX
                    const all_literal = args.every((a) => _is_float_literal(pyStrip(a)));
                    if (all_literal) {
                        parsed_nodes.set(nid, [10, {
                            r: pyFloat(pyStrip(args[0])),
                            g: pyFloat(pyStrip(args[1])),
                            b: pyFloat(pyStrip(args[2])),
                        }, []]);
                    } else {
                        parsed_nodes.set(nid, [60, {}, args]);
                    }
                    node_order.push(nid);
                    parsed = true;
                    break;

                } else if (handler === "combine4") {
                    const nid = pyParseInt(m[1]);
                    parsed_nodes.set(nid, [type_id, {}, [m[2], m[3], m[4], m[5]]]);
                    node_order.push(nid);
                    parsed = true;
                    break;
                }
            }

            if (!parsed) {
                // Línea no reconocida - no podemos decompilarlo
                console.log(`[decompile] línea no reconocida: ${JSON.stringify(line)}`);
                return null;
            }

            i += 1;
        }

        if (!parsed_nodes.size) return null;

        // --- Construir links primero para poder calcular layout ---
        const links = [];
        // deps[nid] = set de nids que lo alimentan (sus inputs)
        // PySet: mismo orden de iteración que set() de Python (importa con ciclos)
        const deps = new Map();
        for (const nid of node_order) deps.set(nid, new PySet());
        for (const nid of node_order) {
            const [type_id, , input_exprs] = parsed_nodes.get(nid);
            const nd = NODE_REGISTRY.get(type_id);
            if (nd) {
                for (let slot_idx = 0; slot_idx < input_exprs.length; slot_idx++) {
                    if (slot_idx >= nd.inputs.length) break;
                    const ref = _resolve_ref(pyStrip(input_exprs[slot_idx]));
                    if (ref !== null) {
                        const [src_nid, src_suffix] = ref;
                        let from_slot = 0;
                        if (src_suffix) {
                            const suffix_map = { _x: 0, _y: 1, _z: 2, _w: 3 };
                            from_slot = suffix_map[src_suffix] ?? 0;
                        }
                        links.push(new LinkInstance(src_nid, nid, from_slot, slot_idx));
                        deps.get(nid).add(src_nid);
                    }
                }
            }
        }

        // --- Layout topológico ALAP (inputs cerca de consumidores) ---
        // Paso 1: ASAP - profundidad mínima desde las raíces (sin deps).
        const asap = new Map();
        const get_asap = (nid, visited = null) => {
            if (asap.has(nid)) return asap.get(nid);
            if (visited === null) visited = new Set();
            if (visited.has(nid)) return 0;
            visited.add(nid);
            const ds = deps.get(nid);
            if (!ds || !ds.size) {
                asap.set(nid, 0);
            } else {
                let mx = -Infinity;
                for (const d of ds) mx = Math.max(mx, get_asap(d, visited));
                asap.set(nid, mx + 1);
            }
            return asap.get(nid);
        };

        for (const nid of node_order) get_asap(nid);

        const non_output_asap = node_order
            .filter((nid) => parsed_nodes.get(nid)[0] !== 0)
            .map((nid) => asap.get(nid));
        const rightmost = non_output_asap.length ? Math.max(...non_output_asap) + 1 : 0;

        // Paso 2: invertir deps para obtener consumidores.
        const consumers = new Map();
        for (const nid of node_order) consumers.set(nid, new PySet());
        for (const nid of node_order) {
            for (const d of (deps.get(nid) || [])) {
                if (consumers.has(d)) consumers.get(d).add(nid);
            }
        }

        // Paso 3: ALAP - cada nodo lo más a la derecha posible, justo antes de
        // su consumidor más temprano. El nodo Output queda en la columna rightmost.
        const col = new Map();
        const get_alap = (nid, visited = null) => {
            if (col.has(nid)) return col.get(nid);
            if (visited === null) visited = new Set();
            if (visited.has(nid)) return col.has(nid) ? col.get(nid) : 0;
            visited.add(nid);
            if (parsed_nodes.get(nid)[0] === 0) { // Output node
                col.set(nid, rightmost);
                return col.get(nid);
            }
            const cs = consumers.get(nid) || new PySet();
            if (!cs.size) {
                col.set(nid, asap.get(nid));
            } else {
                let mn = Infinity;
                for (const c of cs) mn = Math.min(mn, get_alap(c, visited));
                col.set(nid, mn - 1);
            }
            return col.get(nid);
        };

        for (const nid of node_order) get_alap(nid);

        // Agrupar nodos por columna
        const col_order = new Map();
        for (const nid of node_order) {
            const c = col.get(nid);
            if (!col_order.has(c)) col_order.set(c, []);
            col_order.get(c).push(nid);
        }

        const LAYOUT_X_STEP = 240;
        // Espacio vertical entre nodos de una columna (un nodo de 2 slots,
        // 98 de alto, queda a 130 del siguiente)
        const LAYOUT_Y_GAP = 32;
        const LAYOUT_START_X = 0;
        const LAYOUT_START_Y = 0;

        // Calcular Y procesando columnas de derecha a izquierda
        const node_positions = new Map();
        const existing_pos = existing_nodes || new Map();

        const preferred_y = (nid) => {
            const ys = [];
            for (const c2 of (consumers.get(nid) || [])) {
                if (node_positions.has(c2)) ys.push(node_positions.get(c2)[1]);
            }
            return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : LAYOUT_START_Y;
        };

        const sorted_cols = [...col_order.keys()].sort((a, b) => b - a);
        for (const c of sorted_cols) {
            const nids_in_col = col_order.get(c);
            const x = LAYOUT_START_X + c * LAYOUT_X_STEP;

            // Nodos con posición existente: se respetan tal cual.
            for (const nid of nids_in_col) {
                if (existing_pos.has(nid)) {
                    const e = existing_pos.get(nid);
                    node_positions.set(nid, [e[0], e[1]]);
                }
            }

            const to_place = nids_in_col.filter((n) => !existing_pos.has(n));
            if (!to_place.length) continue;

            // Ordenar por Y preferida (media de consumidores ya colocados).
            const keyed = to_place.map((n) => [preferred_y(n), n]);
            keyed.sort((a, b) => a[0] - b[0]);
            const sorted_place = keyed.map((k) => k[1]);

            // Colocar en Y preferida, empujando hacia abajo si hay solape
            // con el nodo anterior (según su altura real).
            const placed_ys = [];
            let prev_h = 0;
            for (const nid of sorted_place) {
                let py = preferred_y(nid);
                if (placed_ys.length && py < placed_ys[placed_ys.length - 1] + prev_h + LAYOUT_Y_GAP) {
                    py = placed_ys[placed_ys.length - 1] + prev_h + LAYOUT_Y_GAP;
                }
                placed_ys.push(py);
                const nd = NODE_REGISTRY.get(parsed_nodes.get(nid)[0]);
                prev_h = nd ? nd.height() : 50;
            }

            // Recentrar la columna en el promedio de las Y preferidas
            const ideal_center = sorted_place.reduce((a, n) => a + preferred_y(n), 0) / sorted_place.length;
            const actual_center = placed_ys.reduce((a, b) => a + b, 0) / placed_ys.length;
            const offset = ideal_center - actual_center;

            sorted_place.forEach((nid, k) => {
                node_positions.set(nid, [x, placed_ys[k] + offset]);
            });
        }

        // --- Construir nodos con posiciones calculadas ---
        const nodes = [];
        for (const nid of node_order) {
            const [type_id, params] = parsed_nodes.get(nid);
            const [x, y] = node_positions.get(nid);
            const node = new NodeInstance(type_id, x, y, nid);
            for (const [k, v] of Object.entries(params)) node.params[k] = v;
            nodes.push(node);
        }

        return [nodes, links];
    }
}

export { _resolve_ref, _is_float_literal };

// Port de file_mngr.py: formato binario .glss (compatible con escritorio).
// Diferencia web: trabaja con bytes (Uint8Array) en vez de rutas, y es async
// porque usa CompressionStream("deflate") (formato zlib, igual que zlib.compress).

import { _ } from "./lang.js";

// ======================
// CONFIG
// ======================

export const MAGIC = [0x47, 0x4C, 0x53, 0x53]; // b"GLSS"
export const VERSION = 2;

export const FLAG_COMPRESSED = 1;

const NODE_HEADER_SIZE = 16;  // "<IIii": id, type_id, x, y
const CONFIG_COUNT_SIZE = 4;  // "<I": num configs
const CONFIG_ENTRY_SIZE = 6;  // "<Hf": param_index (u16), value (float)
const LINK_STRUCT_SIZE = 16;  // "<IIII"

export const MAX_NODES = 1_000_000;
export const MAX_LINKS = 2_000_000;
export const MAX_CONFIGS_PER_NODE = 256;

// ======================
// UTILS
// ======================

export class FileError extends Error {
    constructor(message) {
        super(message);
        this.name = "FileError";
    }
}

let _crc_table = null;

/** zlib.crc32(data) & 0xFFFFFFFF */
export function crc32(data) {
    if (!_crc_table) {
        _crc_table = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            _crc_table[n] = c >>> 0;
        }
    }
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
        crc = _crc_table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

async function _stream_bytes(data, stream) {
    const out = new Response(new Blob([data]).stream().pipeThrough(stream));
    return new Uint8Array(await out.arrayBuffer());
}

/** zlib.compress(data) */
export function zlib_compress(data) {
    return _stream_bytes(data, new CompressionStream("deflate"));
}

/** zlib.decompress(data) */
export function zlib_decompress(data) {
    return _stream_bytes(data, new DecompressionStream("deflate"));
}

/** Escritor binario little-endian que crece solo */
class Writer {
    constructor() {
        this.buf = new Uint8Array(1024);
        this.view = new DataView(this.buf.buffer);
        this.len = 0;
    }

    _grow(n) {
        if (this.len + n <= this.buf.length) return;
        let size = this.buf.length * 2;
        while (size < this.len + n) size *= 2;
        const nb = new Uint8Array(size);
        nb.set(this.buf.subarray(0, this.len));
        this.buf = nb;
        this.view = new DataView(nb.buffer);
    }

    u16(v) { _check_int(v, 0, 0xFFFF); this._grow(2); this.view.setUint16(this.len, v, true); this.len += 2; }
    u32(v) { _check_int(v, 0, 0xFFFFFFFF); this._grow(4); this.view.setUint32(this.len, v, true); this.len += 4; }
    i32(v) { _check_int(v, -0x80000000, 0x7FFFFFFF); this._grow(4); this.view.setInt32(this.len, v, true); this.len += 4; }
    f32(v) { this._grow(4); this.view.setFloat32(this.len, v, true); this.len += 4; }
    bytes(b) { this._grow(b.length); this.buf.set(b, this.len); this.len += b.length; }

    result() { return this.buf.slice(0, this.len); }
}

function _check_int(v, lo, hi) {
    // struct.pack lanza struct.error si el entero no cabe en el formato
    if (!Number.isInteger(v) || v < lo || v > hi) {
        throw new FileError(`argument out of range: ${v}`);
    }
}

// ======================
// SAVE
// ======================

/** save(): retorna los bytes del archivo .glss */
export async function save(nodes, links, compress = false) {
    if (nodes.length > MAX_NODES) throw new FileError(_("error_too_many_nodes"));
    if (links.length > MAX_LINKS) throw new FileError(_("error_too_many_links"));

    const w = new Writer();

    // Nodes
    w.u32(nodes.length);
    for (const n of nodes) {
        const [node_id, type_id, x, y] = n;
        const configs = n.length > 4 ? n[4] : [];
        w.u32(node_id);
        w.u32(type_id);
        w.i32(x);
        w.i32(y);
        w.u32(configs.length);
        for (const [idx, val] of configs) {
            w.u16(idx);
            w.f32(val);
        }
    }

    // Links
    w.u32(links.length);
    for (const l of links) {
        if (l.length !== 4) throw new FileError(_("error_invalid_link"));
        for (const v of l) w.u32(v);
    }

    let payload = w.result();

    let flags = 0;
    if (compress) {
        payload = await zlib_compress(payload);
        flags |= FLAG_COMPRESSED;
    }

    const crc = crc32(payload);

    const f = new Writer();
    f.bytes(MAGIC);
    f.u32(VERSION);
    f.u32(flags);
    f.u32(payload.length);
    f.bytes(payload);
    f.u32(crc);
    return f.result();
}

// ======================
// LOAD
// ======================

/** load(): recibe los bytes del archivo. Retorna [version, nodes, links] */
export async function load(data) {
    const file = data instanceof Uint8Array ? data : new Uint8Array(data);
    let fpos = 0;

    function read_exact(size) {
        if (fpos + size > file.length) throw new FileError(_("error_file_corrupt"));
        const out = file.subarray(fpos, fpos + size);
        fpos += size;
        return out;
    }
    function u32_of(bytes) {
        return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
    }

    // Header
    const magic = read_exact(4);
    if (!MAGIC.every((b, i) => magic[i] === b)) throw new FileError(_("error_invalid_format"));

    const version = u32_of(read_exact(4));
    if (version !== 1 && version !== 2) {
        throw new FileError(_("error_unsupported_version").replace("@0", String(version)));
    }

    const flags = u32_of(read_exact(4));
    const payload_size = u32_of(read_exact(4));

    if (payload_size > 10 ** 9) throw new FileError(_("error_payload_too_large"));

    let payload = read_exact(payload_size);
    const stored_crc = u32_of(read_exact(4));

    // CRC check
    if (crc32(payload) !== stored_crc) throw new FileError(_("error_invalid_crc"));

    // Decompress
    if (flags & FLAG_COMPRESSED) payload = await zlib_decompress(payload);

    // Parse
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    let offset = 0;
    const size = payload.length;

    function require(n) {
        if (offset + n > size) throw new FileError(_("error_file_overflow"));
    }

    // Nodes
    require(4);
    const node_count = view.getUint32(offset, true);
    offset += 4;

    if (node_count > MAX_NODES) throw new FileError(_("error_possible_corruption"));

    const nodes = [];

    if (version === 1) {
        // V1: fixed-size nodes, no configs
        const expected = offset + node_count * NODE_HEADER_SIZE;
        if (expected > size) throw new FileError(_("error_incomplete_node_data"));
        for (let i = 0; i < node_count; i++) {
            nodes.push([
                view.getUint32(offset, true), view.getUint32(offset + 4, true),
                view.getInt32(offset + 8, true), view.getInt32(offset + 12, true), [],
            ]);
            offset += NODE_HEADER_SIZE;
        }
    } else {
        // V2: header + variable configs
        for (let i = 0; i < node_count; i++) {
            require(NODE_HEADER_SIZE);
            const hdr = [
                view.getUint32(offset, true), view.getUint32(offset + 4, true),
                view.getInt32(offset + 8, true), view.getInt32(offset + 12, true),
            ];
            offset += NODE_HEADER_SIZE;

            require(CONFIG_COUNT_SIZE);
            const num_cfg = view.getUint32(offset, true);
            offset += CONFIG_COUNT_SIZE;

            if (num_cfg > MAX_CONFIGS_PER_NODE) throw new FileError(_("error_too_many_configs"));

            const configs = [];
            for (let j = 0; j < num_cfg; j++) {
                require(CONFIG_ENTRY_SIZE);
                configs.push([view.getUint16(offset, true), view.getFloat32(offset + 2, true)]);
                offset += CONFIG_ENTRY_SIZE;
            }

            nodes.push([hdr[0], hdr[1], hdr[2], hdr[3], configs]);
        }
    }

    // Links
    require(4);
    const link_count = view.getUint32(offset, true);
    offset += 4;

    if (link_count > MAX_LINKS) throw new FileError(_("error_too_many_links"));

    const expected = offset + link_count * LINK_STRUCT_SIZE;
    if (expected > size) throw new FileError(_("error_incomplete_link_data"));

    const links = [];
    for (let i = 0; i < link_count; i++) {
        links.push([
            view.getUint32(offset, true), view.getUint32(offset + 4, true),
            view.getUint32(offset + 8, true), view.getUint32(offset + 12, true),
        ]);
        offset += LINK_STRUCT_SIZE;
    }

    // Final check
    if (offset !== size) throw new FileError(_("error_unexpected_data"));

    return [version, nodes, links];
}

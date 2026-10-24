// Port de editor.py: buffer de texto, cursor, undo/redo y editor.
// Las columnas se cuentan en code points (igual que los str de Python).

import { _ } from "./lang.js";
import { cpLen, cpSlice, cpAt, pyIsAlnum, tupleGreater, monotonic } from "./pyutil.js";

// ======================
// CONFIG
// ======================

export const TAB_SIZE = 4;
export const MAX_UNDO = 500;
export const BLINK_RATE = 0.53;

// Web: WebGL2 usa GLSL ES 3.00 (escritorio usa "#version 330 core")
export const DEFAULT_SHADER = `#version 300 es
precision highp float;

uniform float iTime;
uniform vec2 iResolution;
uniform vec2 iMouse;

out vec4 fragColor;

void main() {
    vec2 uv = gl_FragCoord.xy / iResolution.xy;
    vec3 col = 0.5 + 0.5 * cos(iTime + uv.xyx + vec3(0.0, 2.0, 4.0));
    fragColor = vec4(col, 1.0);
}
`;

// ======================
// UTILS
// ======================

export function clamp(val, lo, hi) {
    return Math.max(lo, Math.min(val, hi));
}

function isWordChar(ch) {
    return pyIsAlnum(ch) || ch === "_";
}

// ======================
// BUFFER
// ======================

export class TextBuffer {
    constructor(text = "") {
        if (text) {
            this.lines = text.split("\n");
        } else {
            this.lines = [""];
        }
    }

    get line_count() {
        return this.lines.length;
    }

    get_line(row) {
        if (row >= 0 && row < this.lines.length) return this.lines[row];
        return "";
    }

    get_text() {
        return this.lines.join("\n");
    }

    set_text(text) {
        this.lines = text.split("\n");
    }

    set_text_diff(text) {
        /** Como set_text pero preserva líneas que no cambiaron.
         *  Diff O(n) por bloques: compara desde el inicio y desde el final,
         *  luego reemplaza solo el bloque central que difiere. */
        const new_lines = text.split("\n");
        const old_lines = this.lines;

        if (old_lines.length === new_lines.length && old_lines.every((l, i) => l === new_lines[i])) {
            return; // nada que hacer
        }

        let lo = 0;
        while (lo < old_lines.length && lo < new_lines.length && old_lines[lo] === new_lines[lo]) {
            lo += 1;
        }

        let hi_old = old_lines.length;
        let hi_new = new_lines.length;
        while (hi_old > lo && hi_new > lo && old_lines[hi_old - 1] === new_lines[hi_new - 1]) {
            hi_old -= 1;
            hi_new -= 1;
        }

        // Reemplazar solo el rango [lo, hi_old) con new_lines[lo:hi_new]
        this.lines.splice(lo, hi_old - lo, ...new_lines.slice(lo, hi_new));
    }

    insert_char(row, col, ch) {
        const line = this.get_line(row);
        this.lines[row] = cpSlice(line, 0, col) + ch + cpSlice(line, col);
    }

    insert_newline(row, col) {
        const line = this.get_line(row);
        const before = cpSlice(line, 0, col);
        const after = cpSlice(line, col);

        // Auto-indent: copiar espacios del inicio de la línea
        let indent = "";
        for (const c of line) {
            if (c === " " || c === "\t") indent += c;
            else break;
        }

        this.lines[row] = before;
        this.lines.splice(row + 1, 0, indent + after);
        return indent.length;
    }

    delete_char(row, col) {
        if (col > 0) {
            const line = this.get_line(row);
            this.lines[row] = cpSlice(line, 0, col - 1) + cpSlice(line, col);
            return [row, col - 1];
        } else if (row > 0) {
            const prev_len = cpLen(this.lines[row - 1]);
            this.lines[row - 1] += this.lines[row];
            this.lines.splice(row, 1);
            return [row - 1, prev_len];
        }
        return [row, col];
    }

    delete_forward(row, col) {
        const line = this.get_line(row);
        if (col < cpLen(line)) {
            this.lines[row] = cpSlice(line, 0, col) + cpSlice(line, col + 1);
            return [row, col];
        } else if (row < this.lines.length - 1) {
            this.lines[row] += this.lines[row + 1];
            this.lines.splice(row + 1, 1);
        }
        return [row, col];
    }

    delete_range(r1, c1, r2, c2) {
        if (tupleGreater([r1, c1], [r2, c2])) {
            [r1, c1, r2, c2] = [r2, c2, r1, c1];
        }

        const start_line = cpSlice(this.get_line(r1), 0, c1);
        const end_line = cpSlice(this.get_line(r2), c2);

        this.lines[r1] = start_line + end_line;
        this.lines.splice(r1 + 1, r2 - r1);
        return [r1, c1];
    }

    insert_text(row, col, text) {
        const text_lines = text.split("\n");

        if (text_lines.length === 1) {
            const line = this.get_line(row);
            this.lines[row] = cpSlice(line, 0, col) + text_lines[0] + cpSlice(line, col);
            return [row, col + cpLen(text_lines[0])];
        }

        const orig = this.get_line(row);
        const before = cpSlice(orig, 0, col);
        const after = cpSlice(orig, col);

        this.lines[row] = before + text_lines[0];

        for (let i = 1; i < text_lines.length - 1; i++) {
            this.lines.splice(row + i, 0, text_lines[i]);
        }

        const last_idx = row + text_lines.length - 1;
        this.lines.splice(last_idx, 0, text_lines[text_lines.length - 1] + after);

        return [last_idx, cpLen(text_lines[text_lines.length - 1])];
    }

    get_range(r1, c1, r2, c2) {
        if (tupleGreater([r1, c1], [r2, c2])) {
            [r1, c1, r2, c2] = [r2, c2, r1, c1];
        }

        if (r1 === r2) return cpSlice(this.get_line(r1), c1, c2);

        const result = [cpSlice(this.get_line(r1), c1)];
        for (let r = r1 + 1; r < r2; r++) result.push(this.get_line(r));
        result.push(cpSlice(this.get_line(r2), 0, c2));
        return result.join("\n");
    }

    snapshot() {
        return [...this.lines];
    }

    restore(snap) {
        this.lines = [...snap];
    }
}

// ======================
// CURSOR
// ======================

export class Cursor {
    constructor() {
        this.row = 0;
        this.col = 0;
        this.sel_row = -1;
        this.sel_col = -1;
        this.target_col = 0;
        this.blink_time = 0.0;
    }

    get has_selection() {
        return this.sel_row >= 0 && !(this.sel_row === this.row && this.sel_col === this.col);
    }

    selection_range() {
        if (!this.has_selection) return null;
        let r1 = this.sel_row, c1 = this.sel_col;
        let r2 = this.row, c2 = this.col;
        if (tupleGreater([r1, c1], [r2, c2])) {
            [r1, c1, r2, c2] = [r2, c2, r1, c1];
        }
        return [r1, c1, r2, c2];
    }

    start_selection() {
        if (!this.has_selection) {
            this.sel_row = this.row;
            this.sel_col = this.col;
        }
    }

    clear_selection() {
        this.sel_row = -1;
        this.sel_col = -1;
    }

    move_to(row, col, buf) {
        this.row = clamp(row, 0, buf.line_count - 1);
        this.col = clamp(col, 0, cpLen(buf.get_line(this.row)));
        this.target_col = this.col;
        this.reset_blink();
    }

    move_up(buf, select = false) {
        if (select) this.start_selection();
        else this.clear_selection();
        if (this.row > 0) {
            this.row -= 1;
            this.col = Math.min(this.target_col, cpLen(buf.get_line(this.row)));
        }
        this.reset_blink();
    }

    move_down(buf, select = false) {
        if (select) this.start_selection();
        else this.clear_selection();
        if (this.row < buf.line_count - 1) {
            this.row += 1;
            this.col = Math.min(this.target_col, cpLen(buf.get_line(this.row)));
        }
        this.reset_blink();
    }

    move_left(buf, select = false) {
        if (select) {
            this.start_selection();
        } else if (this.has_selection) {
            const sel = this.selection_range();
            this.clear_selection();
            this.move_to(sel[0], sel[1], buf);
            return;
        }
        if (this.col > 0) {
            this.col -= 1;
        } else if (this.row > 0) {
            this.row -= 1;
            this.col = cpLen(buf.get_line(this.row));
        }
        this.target_col = this.col;
        this.reset_blink();
    }

    move_right(buf, select = false) {
        if (select) {
            this.start_selection();
        } else if (this.has_selection) {
            const sel = this.selection_range();
            this.clear_selection();
            this.move_to(sel[2], sel[3], buf);
            return;
        }
        const line = buf.get_line(this.row);
        if (this.col < cpLen(line)) {
            this.col += 1;
        } else if (this.row < buf.line_count - 1) {
            this.row += 1;
            this.col = 0;
        }
        this.target_col = this.col;
        this.reset_blink();
    }

    move_home(buf, select = false) {
        if (select) this.start_selection();
        else this.clear_selection();
        const line = buf.get_line(this.row);
        let indent = 0;
        for (const c of line) {
            if (c === " " || c === "\t") indent += 1;
            else break;
        }
        if (this.col === indent) this.col = 0;
        else this.col = indent;
        this.target_col = this.col;
        this.reset_blink();
    }

    move_end(buf, select = false) {
        if (select) this.start_selection();
        else this.clear_selection();
        this.col = cpLen(buf.get_line(this.row));
        this.target_col = this.col;
        this.reset_blink();
    }

    move_word_left(buf, select = false) {
        if (select) this.start_selection();
        else this.clear_selection();
        const line = buf.get_line(this.row);
        if (this.col === 0 && this.row > 0) {
            this.row -= 1;
            this.col = cpLen(buf.get_line(this.row));
        } else {
            let col = this.col - 1;
            // line[col - 1] con col - 1 = -1 en Python es el último carácter
            const at = (i) => cpAt(line, i < 0 ? cpLen(line) + i : i);
            while (col > 0 && !isWordChar(at(col - 1))) col -= 1;
            while (col > 0 && isWordChar(at(col - 1))) col -= 1;
            this.col = Math.max(0, col);
        }
        this.target_col = this.col;
        this.reset_blink();
    }

    move_word_right(buf, select = false) {
        if (select) this.start_selection();
        else this.clear_selection();
        const line = buf.get_line(this.row);
        const len = cpLen(line);
        if (this.col >= len && this.row < buf.line_count - 1) {
            this.row += 1;
            this.col = 0;
        } else {
            let col = this.col;
            while (col < len && isWordChar(cpAt(line, col))) col += 1;
            while (col < len && !isWordChar(cpAt(line, col))) col += 1;
            this.col = col;
        }
        this.target_col = this.col;
        this.reset_blink();
    }

    reset_blink() {
        this.blink_time = monotonic();
    }

    is_visible() {
        const elapsed = monotonic() - this.blink_time;
        return (elapsed % (BLINK_RATE * 2)) < BLINK_RATE;
    }
}

// ======================
// UNDO
// ======================

export class UndoEntry {
    constructor(snapshot, crow, ccol) {
        this.snapshot = snapshot;
        this.cursor_row = crow;
        this.cursor_col = ccol;
    }
}

export class UndoManager {
    constructor() {
        this.stack = [];
        this.redo_stack = [];
    }

    push(buf, cursor) {
        this.stack.push(new UndoEntry(buf.snapshot(), cursor.row, cursor.col));
        if (this.stack.length > MAX_UNDO) this.stack.shift();
        this.redo_stack.length = 0;
    }

    undo(buf, cursor) {
        if (!this.stack.length) return false;
        // Guardar estado actual en redo
        this.redo_stack.push(new UndoEntry(buf.snapshot(), cursor.row, cursor.col));
        const entry = this.stack.pop();
        buf.restore(entry.snapshot);
        cursor.row = entry.cursor_row;
        cursor.col = entry.cursor_col;
        cursor.target_col = cursor.col;
        return true;
    }

    redo(buf, cursor) {
        if (!this.redo_stack.length) return false;
        this.stack.push(new UndoEntry(buf.snapshot(), cursor.row, cursor.col));
        const entry = this.redo_stack.pop();
        buf.restore(entry.snapshot);
        cursor.row = entry.cursor_row;
        cursor.col = entry.cursor_col;
        cursor.target_col = cursor.col;
        return true;
    }
}

// ======================
// EDITOR
// ======================

export class Editor {
    constructor(text = "") {
        this.buffer = new TextBuffer(text || DEFAULT_SHADER);
        this.cursor = new Cursor();
        this.undo_mgr = new UndoManager();
        this.scroll_x = 0;
        this.scroll_y = 0;
        this.modified = false;
        this.file_path = null;

        // Estado de compilación
        this.compile_error = null;
        this.compile_success = false;
        this.needs_compile = true;
        this._last_compile_text = "";
    }

    _save_undo() {
        this.undo_mgr.push(this.buffer, this.cursor);
    }

    _mark_modified() {
        this.modified = true;
        const text = this.buffer.get_text();
        if (text !== this._last_compile_text) this.needs_compile = true;
    }

    mark_compiled(error = null) {
        this._last_compile_text = this.buffer.get_text();
        this.needs_compile = false;
        this.compile_error = error;
        this.compile_success = error === null;
    }

    // --- Entrada de texto ---

    insert_char(ch) {
        this._save_undo();
        if (this.cursor.has_selection) {
            const sel = this.cursor.selection_range();
            this.buffer.delete_range(...sel);
            [this.cursor.row, this.cursor.col] = [sel[0], sel[1]];
            this.cursor.clear_selection();
        }

        this.buffer.insert_char(this.cursor.row, this.cursor.col, ch);
        this.cursor.col += cpLen(ch);
        this.cursor.target_col = this.cursor.col;
        this.cursor.reset_blink();
        this._mark_modified();
    }

    insert_newline() {
        this._save_undo();
        if (this.cursor.has_selection) {
            const sel = this.cursor.selection_range();
            this.buffer.delete_range(...sel);
            [this.cursor.row, this.cursor.col] = [sel[0], sel[1]];
            this.cursor.clear_selection();
        }

        const indent_len = this.buffer.insert_newline(this.cursor.row, this.cursor.col);
        this.cursor.row += 1;
        this.cursor.col = indent_len;
        this.cursor.target_col = this.cursor.col;
        this.cursor.reset_blink();
        this._mark_modified();
    }

    insert_tab() {
        this.insert_char(" ".repeat(TAB_SIZE));
    }

    backspace() {
        this._save_undo();
        if (this.cursor.has_selection) {
            const sel = this.cursor.selection_range();
            this.buffer.delete_range(...sel);
            [this.cursor.row, this.cursor.col] = [sel[0], sel[1]];
            this.cursor.clear_selection();
        } else {
            [this.cursor.row, this.cursor.col] = this.buffer.delete_char(this.cursor.row, this.cursor.col);
        }
        this.cursor.target_col = this.cursor.col;
        this.cursor.reset_blink();
        this._mark_modified();
    }

    delete() {
        this._save_undo();
        if (this.cursor.has_selection) {
            const sel = this.cursor.selection_range();
            this.buffer.delete_range(...sel);
            [this.cursor.row, this.cursor.col] = [sel[0], sel[1]];
            this.cursor.clear_selection();
        } else {
            this.buffer.delete_forward(this.cursor.row, this.cursor.col);
        }
        this.cursor.target_col = this.cursor.col;
        this.cursor.reset_blink();
        this._mark_modified();
    }

    paste(text) {
        if (!text) return;
        this._save_undo();
        if (this.cursor.has_selection) {
            const sel = this.cursor.selection_range();
            this.buffer.delete_range(...sel);
            [this.cursor.row, this.cursor.col] = [sel[0], sel[1]];
            this.cursor.clear_selection();
        }

        [this.cursor.row, this.cursor.col] = this.buffer.insert_text(this.cursor.row, this.cursor.col, text);
        this.cursor.target_col = this.cursor.col;
        this.cursor.reset_blink();
        this._mark_modified();
    }

    copy() {
        if (this.cursor.has_selection) {
            const sel = this.cursor.selection_range();
            return this.buffer.get_range(...sel);
        }
        return "";
    }

    cut() {
        const text = this.copy();
        if (text) {
            this._save_undo();
            const sel = this.cursor.selection_range();
            this.buffer.delete_range(...sel);
            [this.cursor.row, this.cursor.col] = [sel[0], sel[1]];
            this.cursor.clear_selection();
            this._mark_modified();
        }
        return text;
    }

    select_all() {
        this.cursor.sel_row = 0;
        this.cursor.sel_col = 0;
        const last = this.buffer.line_count - 1;
        this.cursor.row = last;
        this.cursor.col = cpLen(this.buffer.get_line(last));
    }

    undo() {
        this.undo_mgr.undo(this.buffer, this.cursor);
        this._mark_modified();
    }

    redo() {
        this.undo_mgr.redo(this.buffer, this.cursor);
        this._mark_modified();
    }

    // --- Archivo ---
    // Web: el contenido llega como texto (drop o IndexedDB); file_path es el nombre.

    load_file(path, text) {
        this.buffer.set_text(text);
        this.cursor.row = 0;
        this.cursor.col = 0;
        this.cursor.clear_selection();
        this.scroll_x = 0;
        this.scroll_y = 0;
        this.file_path = path;
        this.modified = false;
        this.needs_compile = true;
        this.undo_mgr = new UndoManager();
    }

    /** save_file de escritorio. `write(path, text)` guarda el archivo (IndexedDB en la web). */
    async save_file(path = null, write) {
        path = path || this.file_path;
        if (!path) throw new Error(_("error_no_file_path"));
        await write(path, this.buffer.get_text());
        this.file_path = path;
        this.modified = false;
    }

    get_status_text() {
        const parts = [];
        if (this.file_path) parts.push(this.file_path);
        else parts.push(_("status_unsaved"));
        if (this.modified) parts.push(_("status_modified"));

        parts.push(`${_("status_line")} ${this.cursor.row + 1}, ${_("status_col")} ${this.cursor.col + 1}`);

        if (this.compile_error) {
            parts.push(`${_("status_error_prefix")}: ${this.compile_error}`);
        } else if (this.compile_success) {
            parts.push(_("compile_ok"));
        }

        return parts.join("  |  ");
    }
}

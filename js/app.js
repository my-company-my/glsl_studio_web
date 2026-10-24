// Port de app.py: aplicación, layout, entrada y render de la UI.
//
// Diferencias web (acordadas):
// - Archivos en IndexedDB (proyecto.glss, shader.frag, ...). Cmd+Shift+S descarga.
// - Temas: Alt+T (Cmd+T lo toma el navegador). Cmd+Q no hace nada.
// - Exportar descarga export.png / export.mp4.
// - Shaders de escritorio "#version 330 core" se convierten a "#version 300 es" al abrir.
// - Preferencias (idioma, tema) en localStorage.

import * as glfw from "./glfw.js";
import { Editor, DEFAULT_SHADER } from "./editor.js";
import { Renderer, FONT_CHAR_W, FONT_CHAR_H } from "./renderer.js";
import { Theme, load_text as load_theme_text, default_ as default_theme } from "./theme.js";
import { tokenize, T_NEWLINE } from "./syntax.js";
import { NodeEditorView, NodeGraph } from "./node_editor.js";
import { MenuSystem, MenuConfig, MenuItem } from "./menu_system.js";
import * as file_mngr from "./file_mngr.js";
import { init_languages, set_language, get_available_languages, get_current_language, _ } from "./lang.js";
import * as storage from "./storage.js";
import { pyFormatFixed, pyTitle, pyInt, pyRound, monotonic, cpLen } from "./pyutil.js";

// ======================
// CONFIG
// ======================

export const WINDOW_W = 1280;
export const WINDOW_H = 720;
export const WINDOW_TITLE = "GLSL Studio";

export const COMPILE_DELAY = 0.5;
export const SPLIT_RATIO = 0.5;

export const MIN_FONT_SCALE = 0.75;
export const MAX_FONT_SCALE = 3.0;

// Archivos por defecto (IndexedDB en la web)
export const PROJECT_FILE = "proyecto.glss";
export const SHADER_FILE = "shader.frag";

// Duración de los mensajes temporales del status (segundos)
export const MSG_DURATION = 4.0;

// Modos de vista
export const MODE_TEXT = 0;
export const MODE_NODES = 1;

// Tabs (se cargan desde idiomas)
let TAB_TEXT_LABEL = null;
let TAB_NODE_LABEL = null;

// Shader de escritorio: "#version 330 core" -> "#version 300 es" + precision
const RE_DESKTOP_VERSION = /^[ \t]*#[ \t]*version[ \t]+330(?:[ \t]+core)?[ \t]*\r?$/m;

export function convert_desktop_shader(text) {
    /** Convierte la línea de versión de escritorio a GLSL ES 3.00. Retorna [texto, cambió]. */
    if (!RE_DESKTOP_VERSION.test(text)) return [text, false];
    return [text.replace(RE_DESKTOP_VERSION, "#version 300 es\nprecision highp float;"), true];
}

// ======================
// APP
// ======================

export class App {
    // Constantes para UI. En escritorio se asignan dos veces en el cuerpo de
    // la clase (28/16/32 y luego 32/4/48); valen las últimas.
    static PICKER_PADDING = 4;
    static PICKER_TITLE_H = 48;
    static PICKER_ITEM_H = 32;
    static PICKER_W = 280;

    static _IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".bmp", ".gif", ".tga", ".webp"]);
    static _VIDEO_EXTS = new Set([".mp4", ".avi", ".mov", ".mkv", ".webm"]);

    /** Crea la app: carga idiomas y temas (escritorio lo hace de forma síncrona) */
    static async create(platform) {
        // Inicializar idiomas (español por defecto)
        await init_languages("es_mx");
        const themes = await App._fetch_themes();
        return new App(platform, themes);
    }

    static async _fetch_themes() {
        const texts = new Map();
        try {
            const res = await fetch("Themes/index.json");
            const names = await res.json();
            await Promise.all(names.map(async (n) => {
                const r = await fetch(`Themes/${n}`);
                if (r.ok) texts.set(n, await r.text());
            }));
        } catch (e) {
            console.log(`Error cargando temas: ${e}`);
        }
        return texts;
    }

    constructor(platform, theme_texts) {
        this.platform = platform;
        this._theme_texts = theme_texts;

        this.editor = new Editor(DEFAULT_SHADER);
        this.theme = default_theme();
        this.renderer = null;
        this.ctx = null;

        // Theme support
        this.theme_files = [];
        this.current_theme_index = 0;

        // Theme picker using MenuSystem
        this.theme_picker = new MenuSystem({
            config: new MenuConfig({
                item_height: App.PICKER_ITEM_H,
                width: 280,
                padding: App.PICKER_PADDING,
                title_height: App.PICKER_TITLE_H,
                title: _("theme_title"),
                has_overlay: true,
                theme_prefix: "picker",
                marker_fn: (idx, hover) => this._get_theme_marker(idx, hover),
            }),
            renderer: null,
            theme: this.theme,
            items_provider: () => this._get_theme_items(),
            on_select: (item, idx) => this._on_theme_select(item, idx),
            pixel_ratio: 1.0,
        });

        // Language support
        this.available_languages = get_available_languages();
        const cur = get_current_language();
        this.current_language_index = this.available_languages.includes(cur) ? this.available_languages.indexOf(cur) : 2;
        // save=false: no sobrescribir las preferencias antes de leerlas en init()
        this._set_language_index(this.current_language_index, false);

        // Language picker using MenuSystem
        this.language_picker = new MenuSystem({
            config: new MenuConfig({
                item_height: App.PICKER_ITEM_H,
                width: 280,
                padding: App.PICKER_PADDING,
                title_height: App.PICKER_TITLE_H,
                title: _("lang_title"),
                has_overlay: true,
                theme_prefix: "picker",
                marker_fn: (idx, hover) => this._get_language_marker(idx, hover),
            }),
            renderer: null,
            theme: this.theme,
            items_provider: () => this._get_language_items(),
            on_select: (item, idx) => this._on_language_select(item, idx),
            pixel_ratio: 1.0,
        });

        // Node editor
        this.node_graph = new NodeGraph();
        this.node_view = new NodeEditorView(this.node_graph, this.theme);

        // Modo de vista
        this.mode = MODE_NODES;

        // Estado de ventana
        this.fb_width = WINDOW_W;
        this.fb_height = WINDOW_H;
        this.win_width = WINDOW_W;
        this.win_height = WINDOW_H;
        this.pixel_ratio = 1.0;

        // Layout
        this.split_ratio = SPLIT_RATIO;
        this.dragging_split = false;
        this.font_scale = 1.0;

        // Compilación
        this._last_edit_time = 0.0;
        this._pending_compile = false;

        // Input
        this._ctrl_held = false;
        this._shift_held = false;
        this._super_held = false;
        this._text_dragging = false;

        // Carga diferida
        this._deferred_glss = null;

        // Video mode
        this._video_name = "";
        this._texture_name = "";

        // Export options panel
        this._export_open = false;
        this._export_cursor = 0;
        this._export_mode = 0; // 0=image, 1=video
        this._export_width = 1920;
        this._export_height = 1080;
        this._export_time = 0.0;
        this._export_mouse_x = 0.0;
        this._export_mouse_y = 0.0;
        this._export_duration = 10.0;
        this._export_fps = 30;
        this._export_msg = "";
        this._export_msg_time = 0.0;
        this._exporting = false; // bloquea la entrada mientras se exporta
    }

    // --- Inicialización ---

    async init() {
        const p = this.platform;
        [this.fb_width, this.fb_height] = p.get_framebuffer_size();
        [this.win_width, this.win_height] = p.get_window_size();
        this.pixel_ratio = this.fb_width / Math.max(this.win_width, 1);

        // pixel_ratio antes de crear el Renderer para que el atlas se genere al
        // tamaño correcto según el DPI real de la pantalla
        this.renderer = await Renderer.create(p.gl, this.pixel_ratio);
        this.ctx = this.renderer.ctx;

        // Portapapeles del sistema para copiar/pegar nodos
        this.node_view.clipboard_get = () => this._clipboard_get();
        this.node_view.clipboard_set = (t) => this._clipboard_set(t);
        this.node_view.clipboard_read_async = () => p.clipboard_read_async();

        // Cargar temas disponibles y tema inicial (el guardado, o default)
        this._discover_themes();
        this._load_theme_preference();

        // Cargar idioma guardado y actualizar UI
        this._load_language_preference();
        this._update_ui_strings();

        // Compilar shader inicial
        this._compile_from_nodes();
    }

    // --- Themes ---

    _discover_themes() {
        this.theme_files = [...this._theme_texts.keys()].filter((f) => f.toLowerCase().endsWith(".glst")).sort();
        if (this.theme_files.length && this.theme_files.includes("default.glst")) {
            this.current_theme_index = this.theme_files.indexOf("default.glst");
        }
    }

    _apply_theme(theme) {
        /** Asigna el tema a todos los componentes que dibujan con él. */
        this.theme = theme;
        this.node_view.theme = theme;
        this.node_view.menu_system.theme = theme;
        this.node_view.props_menu_system.theme = theme;
        this.theme_picker.theme = theme;
        this.language_picker.theme = theme;
    }

    _load_theme_file(file_name, save = true) {
        const text = this._theme_texts.get(file_name);
        if (text === undefined) {
            console.log(`Tema no encontrado: ${file_name}`);
            return false;
        }
        try {
            this._apply_theme(load_theme_text(text));
            if (this.theme_files.includes(file_name)) this.current_theme_index = this.theme_files.indexOf(file_name);
            if (save) this._save_prefs({ theme: file_name });
            console.log(`Tema cargado: ${file_name}`);
            return true;
        } catch (e) {
            console.log(`Error cargando tema ${file_name}: ${e.message || e}`);
            return false;
        }
    }

    _load_external_theme(name, text, save = true) {
        /** Carga un .glst arrastrado (escritorio: cualquier ruta). Se guarda su texto. */
        try {
            this._apply_theme(load_theme_text(text));
            this.current_theme_index = -1; // externo: ningún item marcado en el picker
            if (save) this._save_prefs({ theme: { name, text } });
            console.log(`Tema cargado: ${name}`);
            return true;
        } catch (e) {
            console.log(`Error cargando tema: ${e.message || e}`);
            return false;
        }
    }

    _load_theme_preference() {
        /** Carga el tema guardado en las preferencias, o default.glst. */
        const theme_pref = this._read_prefs().theme;
        if (theme_pref) {
            if (typeof theme_pref === "string" && this.theme_files.includes(theme_pref)) {
                if (this._load_theme_file(theme_pref, false)) return;
            } else if (typeof theme_pref === "object" && typeof theme_pref.text === "string") {
                if (this._load_external_theme(theme_pref.name || "", theme_pref.text, false)) return;
            }
        }
        if (this.theme_files.length) this._load_theme_file(this.theme_files[this.current_theme_index], false);
    }

    _load_next_theme() {
        if (!this.theme_files.length) return;
        this.current_theme_index = (this.current_theme_index + 1) % this.theme_files.length;
        this._load_theme_file(this.theme_files[this.current_theme_index]);
    }

    _load_previous_theme() {
        if (!this.theme_files.length) return;
        const n = this.theme_files.length;
        this.current_theme_index = ((this.current_theme_index - 1) % n + n) % n;
        this._load_theme_file(this.theme_files[this.current_theme_index]);
    }

    // --- Languages ---

    _update_ui_strings() {
        /** Actualiza todos los strings de la UI según el idioma actual */
        TAB_TEXT_LABEL = _("tab_code");
        TAB_NODE_LABEL = _("tab_nodes");
        if (this.theme_picker) this.theme_picker.config.title = _("theme_title");
        if (this.language_picker) this.language_picker.config.title = _("lang_title");
    }

    _set_language_index(index, save = true) {
        /** Cambia el idioma por índice */
        if (index < 0 || index >= this.available_languages.length) return false;
        const lang_code = this.available_languages[index];
        this.current_language_index = index;
        set_language(lang_code);
        this._update_ui_strings();
        // Guardar preferencia
        if (save) this._save_prefs({ language: get_current_language() });
        return true;
    }

    _load_language_preference() {
        /** Carga la preferencia de idioma guardada */
        const lang = this._read_prefs().language;
        if (this.available_languages.includes(lang)) {
            this._set_language_index(this.available_languages.indexOf(lang), false);
        }
    }

    // --- Preferencias (localStorage; escritorio: user_prefs.json) ---

    _read_prefs() {
        return storage.read_prefs();
    }

    _save_prefs(updates) {
        /** Actualiza solo las claves dadas y conserva las demás. */
        const prefs = this._read_prefs();
        Object.assign(prefs, updates);
        storage.write_prefs(prefs);
    }

    // --- Mensajes temporales del status ---

    _show_msg(text) {
        this._export_msg = text;
        this._export_msg_time = monotonic();
    }

    // --- Portapapeles ---

    _clipboard_get() {
        return this.platform.clipboard_get() || "";
    }

    _clipboard_set(text) {
        this.platform.clipboard_set(text);
    }

    // --- Menu System Callbacks ---

    _get_theme_items() {
        /** Lista de items para el picker de temas */
        return this.theme_files.map((fname) => {
            const name = pyTitle(fname.replace(".glst", "").replace(/_/g, " "));
            return new MenuItem(name, { action: fname });
        });
    }

    _get_theme_marker(idx, hover_idx) {
        /** Marker para mostrar tema activo */
        return idx === this.current_theme_index ? "•  " : "    ";
    }

    _on_theme_select(item, idx) {
        if (typeof item.action === "string") this._load_theme_file(item.action);
    }

    _get_language_items() {
        /** Lista de items para el picker de idiomas */
        const lang_names = {
            ar: "العربية",
            de: "Deutsch",
            en: "English",
            es: "Español",
            es_mx: "Español (México)",
            fr: "Français",
            it: "Italiano",
            ja: "日本語",
            pt: "Português",
            ru: "Русский",
            zh_cn: "中文（简体）",
        };
        return this.available_languages.map((code) => new MenuItem(lang_names[code] || code, { action: code }));
    }

    _get_language_marker(idx, hover_idx) {
        return idx === this.current_language_index ? "•  " : "    ";
    }

    _on_language_select(item, idx) {
        if (typeof item.action === "string") {
            this._set_language_index(this.available_languages.indexOf(item.action));
        }
    }

    // --- Layout ---

    _tab_height() {
        return this.theme.integer("tab.height", 28) * this.pixel_ratio;
    }

    _toolbar_height() {
        return this.theme.integer("toolbar.height", 30) * this.pixel_ratio;
    }

    _status_height() {
        return this.theme.integer("status.height", 24) * this.pixel_ratio;
    }

    _gutter_width() {
        return this.theme.integer("gutter.width", 50) * this.pixel_ratio;
    }

    _char_w() {
        const scale = this.font_scale * this.pixel_ratio;
        if (this.renderer) {
            const [width] = this.renderer.measure_text("M", scale, "mono");
            if (width > 0) return width;
        }
        return FONT_CHAR_W * scale;
    }

    _char_h() {
        const scale = this.font_scale * this.pixel_ratio;
        if (this.renderer) {
            const [, height] = this.renderer.measure_text("M", scale, "mono");
            if (height > 0) return height;
        }
        return FONT_CHAR_H * scale;
    }

    _content_top() {
        return this._toolbar_height() + this._tab_height();
    }

    _editor_rect() {
        const top = this._content_top();
        const sb = this._status_height();
        const ew = this.fb_width * this.split_ratio;
        return [0, top, ew, this.fb_height - top - sb];
    }

    _preview_rect() {
        const top = this._content_top();
        const sb = this._status_height();
        const ew = this.fb_width * this.split_ratio;
        return [ew, top, this.fb_width - ew, this.fb_height - top - sb];
    }

    _preview_draw_rect() {
        /** Rect donde se dibuja el shader (preview menos el borde izquierdo). */
        const [px, py, pw, ph] = this._preview_rect();
        const margin = 2 * this.pixel_ratio;
        return [px + margin, py, pw - margin, ph];
    }

    _visible_lines() {
        const [, , , h] = this._editor_rect();
        const ch = this._char_h();
        return ch > 0 ? Math.max(1, pyInt(h / ch)) : 1;
    }

    _visible_cols() {
        const [, , w] = this._editor_rect();
        const gw = this._gutter_width();
        const cw = this._char_w();
        return cw > 0 ? Math.max(1, pyInt((w - gw) / cw)) : 1;
    }

    // --- Compilación ---

    _do_compile() {
        const source = this.editor.buffer.get_text();
        const error = this.renderer.compile_shader(source);
        this.editor.mark_compiled(error);
        this._pending_compile = false;
    }

    _compile_from_nodes() {
        const source = this.node_graph.compile();
        this.editor.buffer.set_text_diff(source);
        const error = this.renderer.compile_shader(source);
        this.editor.mark_compiled(error);
        this.node_graph.mark_compiled();
        this._pending_compile = false;
    }

    _switch_to_text() {
        if (this.mode === MODE_NODES) this._compile_from_nodes();
        this.mode = MODE_TEXT;
    }

    _switch_to_nodes() {
        if (this.mode === MODE_TEXT) {
            const source = this.editor.buffer.get_text();
            if (this.node_graph.sync_from_source(source)) {
                const error = this.renderer.compile_shader(source);
                this.editor.mark_compiled(error);
                this.node_graph.mark_compiled();
                this._pending_compile = false;
                this.node_view.request_fit();
            } else {
                this._show_msg(_("decompile_error"));
            }
        }
        this.mode = MODE_NODES;
    }

    // --- Save / Load con file_mngr ---

    async _graph_bytes() {
        const nodes = this.node_graph.get_node_tuples();
        const links = this.node_graph.get_link_tuples();
        return await file_mngr.save(nodes, links, true);
    }

    async _save_graph(path) {
        await storage.write_file(path, await this._graph_bytes());
    }

    async _load_graph(data, path) {
        const [version, nodes, links] = await file_mngr.load(data);
        this.node_graph.load_from_tuples(nodes, links);

        // Compat: cargar params de .glsp si existe (V1)
        if (version === 1 && path) {
            const param_path = path.replace(/\.[^.]*$/, "") + ".glsp";
            const raw = await storage.read_file(param_path);
            if (raw) this._load_params_legacy(new TextDecoder().decode(raw));
        }

        this._compile_from_nodes();
        this.node_view.request_fit();
    }

    async _cmd_save() {
        /** Cmd+S: modo nodos -> proyecto.glss, modo texto -> archivo abierto o shader.frag. */
        try {
            let path;
            if (this.mode === MODE_NODES) {
                path = PROJECT_FILE;
                await this._save_graph(path);
            } else {
                path = this.editor.file_path || SHADER_FILE;
                await this.editor.save_file(path, (p, text) => storage.write_file(p, text));
            }
            this._show_msg(_("success_file_saved", path));
        } catch (e) {
            this._show_msg(_("file_error", e.message || String(e)));
        }
    }

    async _cmd_load() {
        /** Cmd+L: carga proyecto.glss (IndexedDB). */
        try {
            const data = await storage.read_file(PROJECT_FILE);
            if (data === null) {
                this._show_msg(_("file_error", `${PROJECT_FILE}: ${_("error_file_not_found")}`));
                return;
            }
            await this._load_graph(data, PROJECT_FILE);
            this._show_msg(_("success_file_loaded", PROJECT_FILE));
        } catch (e) {
            this._show_msg(_("file_error", e.message || String(e)));
        }
    }

    async _cmd_download() {
        /** Cmd+Shift+S (solo web): descarga el archivo actual. */
        try {
            if (this.mode === MODE_NODES) {
                storage.download(PROJECT_FILE, await this._graph_bytes());
            } else {
                const name = this.editor.file_path || SHADER_FILE;
                storage.download(name, this.editor.buffer.get_text(), "text/plain");
            }
        } catch (e) {
            this._show_msg(_("file_error", e.message || String(e)));
        }
    }

    _load_params_legacy(text) {
        for (let line of text.split("\n")) {
            line = line.trim();
            if (!line) continue;
            const parts = line.split("\t");
            if (parts.length === 3) {
                const nid = parseInt(parts[0], 10), key = parts[1], val = parseFloat(parts[2]);
                const node = this.node_graph.get_node(nid);
                if (node) node.params[key] = val;
            }
        }
    }

    // --- Callbacks de Input ---

    _on_resize(fb_w, fb_h, win_w, win_h) {
        this.fb_width = fb_w;
        this.fb_height = fb_h;
        this.win_width = win_w;
        this.win_height = win_h;
        this.pixel_ratio = this.fb_width / Math.max(this.win_width, 1);
    }

    _on_key(key, scancode, action, mods) {
        // Ignorar teclas inválidas (como cuando solo presionas modificadores)
        if (key === -1) return;

        // Durante una exportación no se acepta entrada
        if (this._exporting) return;

        if (action === glfw.RELEASE) {
            this._ctrl_held = (mods & glfw.MOD_CONTROL) !== 0;
            this._shift_held = (mods & glfw.MOD_SHIFT) !== 0;
            this._super_held = (mods & glfw.MOD_SUPER) !== 0;
            return;
        }

        this._ctrl_held = (mods & glfw.MOD_CONTROL) !== 0;
        this._shift_held = (mods & glfw.MOD_SHIFT) !== 0;
        this._super_held = (mods & glfw.MOD_SUPER) !== 0;

        const cmd = this._ctrl_held || this._super_held;
        const alt = (mods & glfw.MOD_ALT) !== 0;

        // --- Export options panel ---
        if (this._export_open) {
            if (this._export_on_key(key, action, mods)) return;
        }

        // --- Globales ---

        // Cmd+Q: en la web no hace nada (una página no puede cerrar su pestaña)
        if (cmd && key === glfw.KEY_Q) return;

        // F1 / F2 - cambiar modo
        if (key === glfw.KEY_F1 && action === glfw.PRESS) {
            this._switch_to_text();
            return;
        }

        if (key === glfw.KEY_F2 && action === glfw.PRESS) {
            this._switch_to_nodes();
            return;
        }

        // Cmd+Shift+S - descargar el archivo actual (solo web)
        if (cmd && this._shift_held && key === glfw.KEY_S) {
            if (action === glfw.PRESS) this._cmd_download();
            return;
        }

        // Cmd+S - guardar
        if (cmd && key === glfw.KEY_S) {
            this._cmd_save();
            return;
        }

        // Cmd+Shift+L - abrir/cerrar selector de idiomas (antes que Cmd+L)
        if (cmd && this._shift_held && key === glfw.KEY_L && action === glfw.PRESS) {
            if (this.language_picker.is_open()) this.language_picker.close();
            else this.language_picker.open();
            return;
        }

        // Cmd+L - cargar grafo (sin Shift)
        if (cmd && !this._shift_held && key === glfw.KEY_L) {
            this._cmd_load();
            return;
        }

        // Cmd+E - export options
        if (cmd && key === glfw.KEY_E && action === glfw.PRESS) {
            this._export_open = !this._export_open;
            if (this._export_open) this._export_cursor = 0;
            return;
        }

        // Space - play/pausa del video (solo en modo nodos)
        if (key === glfw.KEY_SPACE && action === glfw.PRESS && !cmd && this.mode === MODE_NODES) {
            if (this.renderer && this.renderer.has_video()) {
                this.renderer.video_toggle_play();
                return;
            }
        }

        // Alt+T (y Cmd+T si el navegador lo deja pasar) - selector de temas
        if ((cmd || alt) && key === glfw.KEY_T && action === glfw.PRESS) {
            if (this.theme_picker.is_open()) this.theme_picker.close();
            else this.theme_picker.open();
            return;
        }

        // Navegación del theme picker
        if (this.theme_picker.is_open()) {
            if (this.theme_picker.on_key(key, action, mods)) return;
        }

        // Navegación del language picker
        if (this.language_picker.is_open()) {
            if (this.language_picker.on_key(key, action, mods)) return;
        }

        // Zoom
        if (cmd && key === glfw.KEY_EQUAL) {
            this.font_scale = Math.min(MAX_FONT_SCALE, this.font_scale + 0.125);
            return;
        }
        if (cmd && key === glfw.KEY_MINUS) {
            this.font_scale = Math.max(MIN_FONT_SCALE, this.font_scale - 0.125);
            return;
        }
        if (cmd && key === glfw.KEY_0) {
            this.font_scale = 1.0;
            return;
        }

        // --- Modo nodos ---
        if (this.mode === MODE_NODES) {
            this.node_view.on_key(key, action, mods);
            return;
        }

        // --- Modo texto ---
        const ed = this.editor;
        const buf = ed.buffer;

        if (cmd && key === glfw.KEY_Z) {
            if (this._shift_held) ed.redo();
            else ed.undo();
            return;
        }
        if (cmd && key === glfw.KEY_Y) {
            ed.redo();
            return;
        }
        if (cmd && key === glfw.KEY_A) {
            ed.select_all();
            return;
        }
        if (cmd && key === glfw.KEY_C) {
            const text = ed.copy();
            if (text) this._clipboard_set(text);
            return;
        }
        if (cmd && key === glfw.KEY_X) {
            const text = ed.cut();
            if (text) this._clipboard_set(text);
            return;
        }
        if (cmd && key === glfw.KEY_V) {
            const text = this._clipboard_get();
            if (text) {
                ed.paste(text);
                this._last_edit_time = monotonic();
                this._pending_compile = true;
            }
            return;
        }

        const select = this._shift_held;

        if (key === glfw.KEY_UP) {
            if (cmd) ed.cursor.move_to(0, 0, buf);
            else ed.cursor.move_up(buf, select);
            return;
        }
        if (key === glfw.KEY_DOWN) {
            if (cmd) {
                const last = buf.line_count - 1;
                ed.cursor.move_to(last, cpLen(buf.get_line(last)), buf);
            } else {
                ed.cursor.move_down(buf, select);
            }
            return;
        }
        if (key === glfw.KEY_LEFT) {
            if (cmd) ed.cursor.move_home(buf, select);
            else if (mods & glfw.MOD_ALT) ed.cursor.move_word_left(buf, select);
            else ed.cursor.move_left(buf, select);
            return;
        }
        if (key === glfw.KEY_RIGHT) {
            if (cmd) ed.cursor.move_end(buf, select);
            else if (mods & glfw.MOD_ALT) ed.cursor.move_word_right(buf, select);
            else ed.cursor.move_right(buf, select);
            return;
        }
        if (key === glfw.KEY_HOME) {
            ed.cursor.move_home(buf, select);
            return;
        }
        if (key === glfw.KEY_END) {
            ed.cursor.move_end(buf, select);
            return;
        }
        if (key === glfw.KEY_PAGE_UP) {
            for (let i = 0; i < this._visible_lines(); i++) ed.cursor.move_up(buf, select);
            return;
        }
        if (key === glfw.KEY_PAGE_DOWN) {
            for (let i = 0; i < this._visible_lines(); i++) ed.cursor.move_down(buf, select);
            return;
        }
        if (key === glfw.KEY_ENTER || key === glfw.KEY_KP_ENTER) {
            ed.insert_newline();
            this._last_edit_time = monotonic();
            this._pending_compile = true;
            return;
        }
        if (key === glfw.KEY_TAB) {
            ed.insert_tab();
            this._last_edit_time = monotonic();
            this._pending_compile = true;
            return;
        }
        if (key === glfw.KEY_BACKSPACE) {
            ed.backspace();
            this._last_edit_time = monotonic();
            this._pending_compile = true;
            return;
        }
        if (key === glfw.KEY_DELETE) {
            ed.delete();
            this._last_edit_time = monotonic();
            this._pending_compile = true;
        }
    }

    _on_char(codepoint) {
        if (this._exporting) return;

        if (this.mode === MODE_NODES) {
            // Editando un valor del panel: todos los caracteres van al campo
            if (this.node_view.panel_edit_idx >= 0) {
                this.node_view.on_char(codepoint);
                return;
            }
            // Zoom: un solo paso, centrado en el mouse ('+' y '=' acercan, '-' aleja)
            if (codepoint === 43 || codepoint === 61 || codepoint === 45) {
                const [mx, my] = this.platform.get_cursor_pos();
                const px = mx * this.pixel_ratio;
                const py = my * this.pixel_ratio;
                this.node_view.zoom_by(codepoint === 45 ? -0.1 : 0.1, px, py);
                return;
            }
            this.node_view.on_char(codepoint);
            return;
        }

        const ch = String.fromCodePoint(codepoint);
        if (this.platform.is_printable(ch) && !this._ctrl_held && !this._super_held) {
            this.editor.insert_char(ch);
            this._last_edit_time = monotonic();
            this._pending_compile = true;
        }
    }

    _on_mouse_button(button, action, mods) {
        if (this._exporting) return;

        const [mx, my] = this.platform.get_cursor_pos();
        const px = mx * this.pixel_ratio;
        const py = my * this.pixel_ratio;

        // Theme picker interaction
        if (this.theme_picker.is_open()) {
            if (this.theme_picker.on_mouse_button(px, py, button, action)) return;
            this.theme_picker.close();
            return;
        }

        // Language picker interaction
        if (this.language_picker.is_open()) {
            if (this.language_picker.on_mouse_button(px, py, button, action)) return;
            this.language_picker.close();
            return;
        }

        // Export panel blocks interaction
        if (this._export_open) return;

        // Click en tabs
        if (action === glfw.PRESS && button === glfw.MOUSE_BUTTON_LEFT) {
            const tab_y = this._toolbar_height();
            const tab_h = this._tab_height();
            if (tab_y <= py && py < tab_y + tab_h) {
                const half = this.fb_width * this.split_ratio / 2;
                if (px < half) this._switch_to_text();
                else this._switch_to_nodes();
                return;
            }
        }

        const [ex, ey, ew, eh] = this._editor_rect();
        const split_x = ex + ew;

        // Arrastrar divisor
        if (action === glfw.PRESS && button === glfw.MOUSE_BUTTON_LEFT) {
            if (Math.abs(px - split_x) < 6 * this.pixel_ratio) {
                this.dragging_split = true;
                return;
            }
        }

        if (action === glfw.RELEASE && button === glfw.MOUSE_BUTTON_LEFT) {
            if (this.dragging_split) {
                this.dragging_split = false;
                return;
            }
        }

        // Modo nodos: delegar al node editor
        if (this.mode === MODE_NODES) {
            if (ex <= px && px < split_x && ey <= py && py < ey + eh) {
                const btn_map = { [glfw.MOUSE_BUTTON_LEFT]: 0, [glfw.MOUSE_BUTTON_RIGHT]: 1, [glfw.MOUSE_BUTTON_MIDDLE]: 2 };
                const btn = btn_map[button] ?? 0;
                if (action === glfw.PRESS) this.node_view.on_mouse_press(px, py, btn, mods);
                else if (action === glfw.RELEASE) this.node_view.on_mouse_release(px, py, btn);
            }
            return;
        }

        // Modo texto: click en editor
        if (this.mode === MODE_TEXT && button === glfw.MOUSE_BUTTON_LEFT) {
            if (action === glfw.PRESS) {
                if (ex <= px && px < split_x && ey <= py && py < ey + eh) {
                    const gw = this._gutter_width();
                    const char_w = this._char_w();
                    const char_h = this._char_h();

                    let col = pyInt((px - ex - gw) / char_w) + this.editor.scroll_x;
                    let row = pyInt((py - ey) / char_h) + this.editor.scroll_y;

                    row = Math.max(0, Math.min(row, this.editor.buffer.line_count - 1));
                    col = Math.max(0, Math.min(col, cpLen(this.editor.buffer.get_line(row))));

                    if (mods & glfw.MOD_SHIFT) this.editor.cursor.start_selection();
                    else this.editor.cursor.clear_selection();

                    this.editor.cursor.move_to(row, col, this.editor.buffer);
                    this._text_dragging = true;
                }
            } else if (action === glfw.RELEASE) {
                this._text_dragging = false;
            }
        }
    }

    _on_cursor_pos(mx, my) {
        if (this._exporting) return;

        const px = mx * this.pixel_ratio;
        const py = my * this.pixel_ratio;

        // iMouse: píxeles del preview, origen abajo-izquierda (como gl_FragCoord).
        // Fuera del preview se conserva el último valor.
        const [dx, dy, dw, dh] = this._preview_draw_rect();
        if (dx <= px && px < dx + dw && dy <= py && py < dy + dh) {
            this.renderer.mouse_x = px - pyInt(dx);
            this.renderer.mouse_y = (this.fb_height - py) - pyInt(this.fb_height - dy - dh);
        }

        // Pickers hover
        if (this.theme_picker.is_open()) this.theme_picker.on_mouse_move(px, py);
        if (this.language_picker.is_open()) this.language_picker.on_mouse_move(px, py);

        if (this.dragging_split) {
            this.split_ratio = Math.max(0.2, Math.min(0.8, px / this.fb_width));
            return;
        }

        if (this.mode === MODE_NODES) this.node_view.on_mouse_move(px, py);

        // Text mode drag selection
        if (this._text_dragging && this.mode === MODE_TEXT) {
            const [ex, ey] = this._editor_rect();
            const gw = this._gutter_width();
            const char_w = this._char_w();
            const char_h = this._char_h();

            let col = pyInt((px - ex - gw) / char_w) + this.editor.scroll_x;
            let row = pyInt((py - ey) / char_h) + this.editor.scroll_y;

            row = Math.max(0, Math.min(row, this.editor.buffer.line_count - 1));
            col = Math.max(0, Math.min(col, cpLen(this.editor.buffer.get_line(row))));

            this.editor.cursor.start_selection();
            this.editor.cursor.row = row;
            this.editor.cursor.col = col;
            this.editor.cursor.target_col = col;
            this.editor.cursor.reset_blink();
        }
    }

    _on_scroll(xoff, yoff) {
        if (this._exporting) return;

        const [mx, my] = this.platform.get_cursor_pos();
        const px = mx * this.pixel_ratio;
        const py = my * this.pixel_ratio;

        // Delegar scroll a pickers si están abiertos
        if (this.theme_picker.is_open()) {
            this.theme_picker.on_scroll(yoff);
            return;
        }
        if (this.language_picker.is_open()) {
            this.language_picker.on_scroll(yoff);
            return;
        }

        if (this._ctrl_held || this._super_held) {
            this.font_scale = Math.max(MIN_FONT_SCALE, Math.min(MAX_FONT_SCALE, this.font_scale + yoff * 0.0625));
            return;
        }

        if (this.mode === MODE_NODES) {
            const [ex, ey, ew, eh] = this._editor_rect();
            if (ex <= px && px < ex + ew && ey <= py && py < ey + eh) this.node_view.on_scroll(xoff, yoff, px, py);
        } else {
            this.editor.scroll_y = Math.max(0, this.editor.scroll_y - pyInt(yoff * 3));
        }
    }

    async _on_drop(files) {
        /** Archivo soltado sobre la ventana (File de la web). */
        if (this._exporting) return;
        if (!files || !files.length) return;
        const file = files[0];
        const path = file.name;
        const dot = path.lastIndexOf(".");
        const ext = dot > 0 ? path.slice(dot).toLowerCase() : "";

        if (path.endsWith(".glst")) {
            this._load_external_theme(path, await file.text());
        } else if (path.endsWith(".glss")) {
            try {
                await this._load_graph(new Uint8Array(await file.arrayBuffer()), null);
                this._show_msg(_("success_file_loaded", path));
            } catch (e) {
                console.log(`Error abriendo archivo: ${e.message || e}`);
                this._show_msg(_("file_error", e.message || String(e)));
            }
        } else if (App._VIDEO_EXTS.has(ext)) {
            if (this.renderer && await this.renderer.load_video(file)) {
                this._video_name = path;
                this._show_msg(_("video_loaded", this._video_name));
                console.log(`Video cargado: ${path}`);
            } else {
                this._show_msg(_("error_load_video", path));
            }
        } else if (App._IMAGE_EXTS.has(ext)) {
            if (this.renderer && await this.renderer.load_texture(file)) {
                this._texture_name = path;
                console.log(`Textura cargada: ${path}`);
            } else {
                this._show_msg(_("error_load_texture", path, this.renderer ? this.renderer.last_error : ""));
            }
        } else {
            try {
                const [text, converted] = convert_desktop_shader(await file.text());
                this.editor.load_file(path, text);
                if (converted) this.editor.modified = true;
                this.mode = MODE_TEXT;
                this._do_compile();
                this._show_msg(_("success_file_loaded", path));
            } catch (e) {
                console.log(`Error abriendo archivo: ${e.message || e}`);
                this._show_msg(_("file_error", e.message || String(e)));
            }
        }
    }

    // --- Export options panel ---

    _export_fields_list() {
        /** [key, label, display_value] para el panel de exportación. */
        const mode_label = this._export_mode === 0 ? _("export_mode_image") : _("export_mode_video");
        const fields = [
            ["mode", _("export_mode"), mode_label],
            ["width", _("export_width"), String(this._export_width)],
            ["height", _("export_height"), String(this._export_height)],
            ["time", _("export_time"), pyFormatFixed(this._export_time, 2)],
            ["mouse_x", _("export_mouse_x"), pyFormatFixed(this._export_mouse_x, 1)],
            ["mouse_y", _("export_mouse_y"), pyFormatFixed(this._export_mouse_y, 1)],
        ];
        if (this._export_mode === 1) {
            const has_vid = this.renderer && this.renderer.has_video();
            if (!has_vid) {
                fields.push(["duration", _("export_duration"), `${pyFormatFixed(this._export_duration, 1)}s`]);
                fields.push(["fps", _("export_fps"), String(this._export_fps)]);
            }
        }
        fields.push(["export", _("export_button"), ""]);
        return fields;
    }

    _export_on_key(key, action, mods) {
        /** Teclado del panel de exportación. */
        if (action !== glfw.PRESS && action !== glfw.REPEAT) return key === glfw.KEY_ESCAPE;

        if (key === glfw.KEY_ESCAPE) {
            this._export_open = false;
            return true;
        }

        const fields = this._export_fields_list();
        const n = fields.length;

        if (key === glfw.KEY_UP) {
            this._export_cursor = ((this._export_cursor - 1) % n + n) % n;
            return true;
        }
        if (key === glfw.KEY_DOWN) {
            this._export_cursor = (this._export_cursor + 1) % n;
            return true;
        }
        if (key === glfw.KEY_ENTER || key === glfw.KEY_KP_ENTER) {
            if (fields[this._export_cursor][0] === "export") this._do_export();
            return true;
        }

        const shift = (mods & glfw.MOD_SHIFT) !== 0;
        if (key !== glfw.KEY_LEFT && key !== glfw.KEY_RIGHT) return false;

        const d = key === glfw.KEY_RIGHT ? 1 : -1;
        const fkey = fields[this._export_cursor][0];

        if (fkey === "mode") {
            this._export_mode = 1 - this._export_mode;
        } else if (fkey === "width") {
            this._export_width = Math.max(64, Math.min(7680, this._export_width + d * (shift ? 100 : 10)));
        } else if (fkey === "height") {
            this._export_height = Math.max(64, Math.min(4320, this._export_height + d * (shift ? 100 : 10)));
        } else if (fkey === "time") {
            this._export_time = Math.max(0.0, pyRound(this._export_time + d * (shift ? 1.0 : 0.1), 2));
        } else if (fkey === "mouse_x") {
            this._export_mouse_x = pyRound(this._export_mouse_x + d * (shift ? 10.0 : 1.0), 1);
        } else if (fkey === "mouse_y") {
            this._export_mouse_y = pyRound(this._export_mouse_y + d * (shift ? 10.0 : 1.0), 1);
        } else if (fkey === "duration") {
            this._export_duration = Math.max(0.5, pyRound(this._export_duration + d * (shift ? 5.0 : 0.5), 1));
        } else if (fkey === "fps") {
            this._export_fps = Math.max(1, Math.min(120, this._export_fps + d * (shift ? 10 : 1)));
        }
        return true;
    }

    async _do_export() {
        /** Exporta según las opciones del panel (descarga el archivo). */
        if (!this.renderer) return;
        const w = this._export_width;
        const h = this._export_height;
        const mx = this._export_mouse_x;
        const my = this._export_mouse_y;

        // Cerrar el panel antes de exportar para que no tape el progreso
        this._export_open = false;

        if (this._export_mode === 0) {
            // Image export
            const path = "export.png";
            const blob = await this.renderer.export_image(w, h, this._export_time, mx, my);
            if (blob) {
                storage.download(path, blob);
                this._show_msg(_("export_ok_image", path));
            } else {
                this._show_msg(_("export_error"));
            }
        } else {
            // Video export
            const has_vid = this.renderer.has_video();
            const path = "export.mp4";
            const progress = (cur, tot) => this._export_progress(cur, tot);
            let blob = null;
            this._exporting = true;
            try {
                if (has_vid) {
                    blob = await this.renderer.export_video_filtered(this.renderer._video.file, w, h, mx, my, progress);
                } else {
                    blob = await this.renderer.export_video(w, h, this._export_fps, this._export_duration, mx, my, progress);
                }
            } finally {
                this._exporting = false;
                this.ctx.screen.use();
            }
            if (blob) {
                storage.download(path, blob);
                this._show_msg(_("export_ok_video", path));
            } else {
                this._show_msg(_("export_error"));
            }
        }
    }

    _export_progress(cur, tot) {
        /** Progreso en la consola y en el status (la UI sigue dibujando). */
        console.log(`Exporting ${cur}/${tot}...`);
        this._show_msg(_("export_progress", cur, tot));
    }

    _render_export_panel(proj) {
        /** Panel de opciones de exportación. */
        const r = this.renderer;
        if (!r) return;

        const pr = this.pixel_ratio;
        const fields = this._export_fields_list();
        const item_h = 32 * pr;
        const pad = 16 * pr;
        const title_h = 40 * pr;
        const panel_w = 360 * pr;
        const panel_h = title_h + fields.length * item_h + pad * 2;
        const border_radius = 10 * pr;

        const cx = (this.fb_width - panel_w) / 2;
        const cy = (this.fb_height - panel_h) / 2;

        // Overlay
        r.draw_rect(0, 0, this.fb_width, this.fb_height, [0.0, 0.0, 0.0, 0.5], proj);

        // Shadow + border + background
        const shadow_c = [0.0, 0.0, 0.0, 0.5];
        const border_c = this.theme.vec4("picker.border", [0.3, 0.3, 0.4, 1.0]);
        const bg_c = this.theme.vec4("picker.bg", [0.12, 0.12, 0.18, 0.98]);

        r.draw_rounded_rect(cx + 3, cy + 3, panel_w, panel_h, border_radius, shadow_c, proj);
        const bw = 2 * pr;
        r.draw_rounded_rect(cx - bw, cy - bw, panel_w + bw * 2, panel_h + bw * 2, border_radius + bw, border_c, proj);
        r.draw_rounded_rect(cx, cy, panel_w, panel_h, border_radius, bg_c, proj);

        // Title
        const scale = this.font_scale * pr;
        const title = _("export_title");
        const [tw, th] = r.measure_text(title, scale * 1.2);
        const title_c = this.theme.vec4("picker.title", [0.85, 0.85, 0.9, 1.0]);
        r.draw_text(cx + (panel_w - tw) / 2, cy + (title_h - th) / 2, title, title_c, proj, scale * 1.2);

        // Fields
        const fg_c = this.theme.vec4("picker.fg", [0.85, 0.85, 0.9, 1.0]);
        const hover_c = this.theme.vec4("picker.hover", [0.28, 0.35, 0.5, 1.0]);
        const val_c = [0.55, 0.75, 1.0, 1.0];
        const hint_c = [0.45, 0.45, 0.55, 0.8];

        fields.forEach(([fkey, label, value], i) => {
            const iy = cy + title_h + pad + i * item_h;

            // Hover highlight
            if (i === this._export_cursor) {
                r.draw_rounded_rect(cx + 4, iy + 1, panel_w - 8, item_h - 2, border_radius * 0.4, hover_c, proj);
            }

            if (fkey === "export") {
                // Export button centered
                const btn_text = "[ " + label + " ]";
                const [bw2, bh] = r.measure_text(btn_text, scale);
                r.draw_text(cx + (panel_w - bw2) / 2, iy + (item_h - bh) / 2, btn_text, fg_c, proj, scale);
            } else {
                // Label on left
                r.draw_text(cx + pad, iy + 4, label, fg_c, proj, scale * 0.9);
                // Value on right
                const [vw] = r.measure_text(value, scale * 0.9);
                r.draw_text(cx + panel_w - pad - vw, iy + 4, value, val_c, proj, scale * 0.9);

                // Arrow hints for selected field
                if (i === this._export_cursor) {
                    const hint = "<  >";
                    const [hw] = r.measure_text(hint, scale * 0.7);
                    r.draw_text(cx + panel_w - pad - vw - hw - 8 * pr, iy + 6, hint, hint_c, proj, scale * 0.7);
                }
            }
        });
    }

    // --- Render ---

    _render_toolbar(proj) {
        const r = this.renderer;
        const th = this._toolbar_height();
        const bg = this.theme.vec4("toolbar.bg");
        const fg = this.theme.vec4("toolbar.fg");
        const border = this.theme.vec4("toolbar.border");

        r.draw_rect(0, 0, this.fb_width, th, bg, proj);
        r.draw_rect(0, th - this.pixel_ratio, this.fb_width, this.pixel_ratio, border, proj);

        const title = "GLSL Studio";
        const scale = this.font_scale * this.pixel_ratio;
        const [, title_h] = r.measure_text(title, scale);
        r.draw_text(10 * this.pixel_ratio, (th - title_h) / 2, title, fg, proj, scale);

        // Atajos en la derecha (traducidos). Web: temas con Alt+T
        const hints = _("hints").replace("Cmd+T", "Alt+T");
        const [hint_w, hint_h] = r.measure_text(hints, scale * 0.75);
        r.draw_text(this.fb_width - hint_w - 10 * this.pixel_ratio, (th - hint_h) / 2,
                    hints, [0.45, 0.45, 0.55, 1.0], proj, scale * 0.75);
    }

    _render_tabs(proj) {
        const r = this.renderer;
        const th = this._toolbar_height();
        const tab_h = this._tab_height();
        const y = th;
        const half_w = this.fb_width * this.split_ratio / 2;
        const scale = this.font_scale * this.pixel_ratio * 0.85;

        const border = this.theme.vec4("tab.border");

        // Tab Código
        let bg, fg;
        if (this.mode === MODE_TEXT) {
            bg = this.theme.vec4("tab.active-bg");
            fg = this.theme.vec4("tab.active-fg");
        } else {
            bg = this.theme.vec4("tab.bg");
            fg = this.theme.vec4("tab.fg");
        }

        r.draw_rect(0, y, half_w, tab_h, bg, proj);
        const [, tab_text_h] = r.measure_text(TAB_TEXT_LABEL, scale);
        r.draw_text(10 * this.pixel_ratio, y + (tab_h - tab_text_h) / 2, TAB_TEXT_LABEL, fg, proj, scale);

        // Tab Nodos
        if (this.mode === MODE_NODES) {
            bg = this.theme.vec4("tab.active-bg");
            fg = this.theme.vec4("tab.active-fg");
        } else {
            bg = this.theme.vec4("tab.bg");
            fg = this.theme.vec4("tab.fg");
        }

        r.draw_rect(half_w, y, half_w, tab_h, bg, proj);
        const [, tab_node_h] = r.measure_text(TAB_NODE_LABEL, scale);
        r.draw_text(half_w + 10 * this.pixel_ratio, y + (tab_h - tab_node_h) / 2, TAB_NODE_LABEL, fg, proj, scale);

        // Bordes
        r.draw_rect(0, y + tab_h - this.pixel_ratio, this.fb_width * this.split_ratio, this.pixel_ratio, border, proj);
        r.draw_rect(half_w, y, this.pixel_ratio, tab_h, border, proj);
    }

    _render_status(proj) {
        const r = this.renderer;
        const sh = this._status_height();
        const y = this.fb_height - sh;
        const bg = this.theme.vec4("status.bg");
        const border = this.theme.vec4("toolbar.border");

        r.draw_rect(0, y, this.fb_width, sh, bg, proj);
        r.draw_rect(0, y, this.fb_width, this.pixel_ratio, border, proj);

        const scale = this.font_scale * this.pixel_ratio * 0.85;

        // Mensaje temporal (export, guardar, cargar, errores)
        let status;
        if (this._export_msg && monotonic() - this._export_msg_time < MSG_DURATION) {
            status = this._export_msg;
        } else if (this.mode === MODE_NODES) {
            status = _("status", this.node_graph.nodes.length, this.node_graph.links.length);
            if (this.editor.compile_error) status += `  |  ${_("compile_error", this.editor.compile_error)}`;
            else if (this.editor.compile_success) status += `  |  ${_("compile_ok")}`;
            status += `  |  ${_("status_nav")}`;
        } else {
            status = this.editor.get_status_text();
        }

        // Video info
        if (this.renderer && this.renderer.has_video()) {
            const vt = this.renderer.video_time();
            const vd = this.renderer.video_duration();
            const state = this.renderer.video_playing() ? ">" : "||";
            status += `  |  Video [${state}] ${pyFormatFixed(vt, 1)}s / ${pyFormatFixed(vd, 1)}s  (Space: play/pause)`;
        }

        const fg = this.editor.compile_error ? this.theme.vec4("status.error") : this.theme.vec4("status.fg");

        const [, status_h] = r.measure_text(status, scale);
        r.draw_text(10 * this.pixel_ratio, y + (sh - status_h) / 2, status, fg, proj, scale);
    }

    _render_gutter(proj, ex, ey, eh) {
        const r = this.renderer;
        const gw = this._gutter_width();
        const char_h = this._char_h();
        const scale = this.font_scale * this.pixel_ratio;

        const bg = this.theme.vec4("gutter.bg");
        const fg = this.theme.vec4("gutter.fg");
        const border = this.theme.vec4("gutter.border");
        const active_fg = this.theme.vec4("editor.fg");

        r.draw_rect(ex, ey, gw, eh, bg, proj);
        r.draw_rect(ex + gw - this.pixel_ratio, ey, this.pixel_ratio, eh, border, proj);

        const visible = this._visible_lines();
        r.begin_text();
        for (let i = 0; i < visible; i++) {
            const line_num = this.editor.scroll_y + i;
            if (line_num >= this.editor.buffer.line_count) break;

            const y = ey + i * char_h;
            const num_str = String(line_num + 1);
            const [num_w, num_h] = r.measure_text(num_str, scale);
            let tx = ex + gw - num_w - 8 * this.pixel_ratio;

            const color = line_num === this.editor.cursor.row ? active_fg : fg;
            const cy = y + (char_h - num_h) / 2;
            for (const ch of num_str) {
                const [ch_w] = r.measure_text(ch, scale);
                r.batch_char(tx, cy, ch.codePointAt(0), scale, color);
                tx += ch_w;
            }
        }
        r.flush_text(proj);
    }

    _render_editor_content(proj, ex, ey, ew, eh) {
        const r = this.renderer;
        const gw = this._gutter_width();
        const char_w = this._char_w();
        const char_h = this._char_h();
        const scale = this.font_scale * this.pixel_ratio;
        const ed = this.editor;

        const editor_bg = this.theme.vec4("editor.bg");
        r.draw_rect(ex + gw, ey, ew - gw, eh, editor_bg, proj);

        const visible = this._visible_lines();
        const text_x = ex + gw + 4 * this.pixel_ratio;

        // Línea activa highlight
        const active_y = ey + (ed.cursor.row - ed.scroll_y) * char_h;
        if (ey <= active_y && active_y < ey + eh) {
            r.draw_rect(ex + gw, active_y, ew - gw, char_h, this.theme.vec4("editor.line-highlight"), proj);
        }

        // Selección (batched)
        if (ed.cursor.has_selection) {
            const sel = ed.cursor.selection_range();
            const sel_color = this.theme.vec4("editor.selection");
            r.begin_rects();
            for (let i = 0; i < visible; i++) {
                const line_num = ed.scroll_y + i;
                if (line_num < sel[0] || line_num > sel[2]) continue;
                const y = ey + i * char_h;
                let sx, sw;
                if (line_num === sel[0] && line_num === sel[2]) {
                    sx = text_x + (sel[1] - ed.scroll_x) * char_w;
                    sw = (sel[3] - sel[1]) * char_w;
                } else if (line_num === sel[0]) {
                    sx = text_x + (sel[1] - ed.scroll_x) * char_w;
                    sw = ew - (sx - ex);
                } else if (line_num === sel[2]) {
                    sx = text_x;
                    sw = (sel[3] - ed.scroll_x) * char_w;
                } else {
                    sx = text_x;
                    sw = ew - gw;
                }
                r.batch_rect(Math.max(sx, text_x), y, Math.max(0, sw), char_h, sel_color);
            }
            r.flush_rects(proj);
        }

        // Texto con syntax highlighting (todo en un batch)
        r.begin_text();
        const max_col = ed.scroll_x + this._visible_cols() + 2;
        const [, ref_text_h] = r.measure_text("M", scale, "mono");

        for (let i = 0; i < visible; i++) {
            const line_num = ed.scroll_y + i;
            if (line_num >= ed.buffer.line_count) break;

            const line = ed.buffer.get_line(line_num);
            const y = ey + i * char_h;
            const text_y = y + (char_h - ref_text_h) / 2;

            let col_offset = 0;
            let stop = false;
            for (const tok of tokenize(line)) {
                if (tok.type === T_NEWLINE) continue;
                const color = this.theme.syntax_vec4(tok.type);
                for (const ch of tok.value) {
                    if (col_offset >= max_col) break;
                    const screen_col = col_offset - ed.scroll_x;
                    if (screen_col >= 0) {
                        const cx = text_x + screen_col * char_w;
                        r.batch_char(cx, text_y, ch.codePointAt(0), scale, color, "mono");
                    }
                    col_offset += 1;
                }
                if (col_offset >= max_col) {
                    stop = true;
                    break;
                }
            }
            void stop;
        }

        r.flush_text(proj);

        // Cursor
        if (ed.cursor.is_visible()) {
            const cy = ey + (ed.cursor.row - ed.scroll_y) * char_h;
            const cx = text_x + (ed.cursor.col - ed.scroll_x) * char_w;
            if (ey <= cy && cy < ey + eh && cx >= text_x) {
                r.draw_rect(cx, cy, 2 * this.pixel_ratio, char_h, this.theme.vec4("editor.cursor"), proj);
            }
        }
    }

    _render_preview(proj) {
        const r = this.renderer;
        const [px, py, pw, ph] = this._preview_rect();

        r.draw_rect(px, py, pw, ph, this.theme.vec4("preview.bg"), proj);
        r.draw_rect(px, py, 2 * this.pixel_ratio, ph, this.theme.vec4("preview.border"), proj);

        if (r.preview_prog && !r.preview_error) {
            const [dx, dy, dw, dh] = this._preview_draw_rect();
            r.render_preview(dx, dy, dw, dh, this.fb_width, this.fb_height);
            this.ctx.viewport = [0, 0, this.fb_width, this.fb_height];
        }
    }

    _render_node_editor(proj, ex, ey, ew, eh) {
        // Actualizar viewport del node editor
        this.node_view.vp_x = ex;
        this.node_view.vp_y = ey;
        this.node_view.vp_w = ew;
        this.node_view.vp_h = eh;
        this.node_view.render(this.renderer, proj, this.pixel_ratio);
    }

    _render() {
        this.ctx.screen.use();
        this.ctx.viewport = [0, 0, this.fb_width, this.fb_height];

        const bg = this.theme.vec4("editor.bg");
        this.ctx.clear(...bg);

        const proj = this.renderer._ortho(this.fb_width, this.fb_height);

        // Toolbar y tabs
        this._render_toolbar(proj);
        this._render_tabs(proj);

        const [ex, ey, ew, eh] = this._editor_rect();

        if (this.mode === MODE_TEXT) {
            this._render_gutter(proj, ex, ey, eh);
            this._render_editor_content(proj, ex, ey, ew, eh);
        } else {
            this._render_node_editor(proj, ex, ey, ew, eh);
        }

        // Preview siempre visible
        this._render_preview(proj);

        // Status bar
        this._render_status(proj);

        // Pickers overlay (encima de todo) - actualizar viewport cada frame
        if (this.theme_picker.renderer === null) this.theme_picker.renderer = this.renderer;
        this.theme_picker.set_pixel_ratio(this.pixel_ratio);
        this.theme_picker.set_viewport(this.fb_width, this.fb_height);

        if (this.language_picker.renderer === null) this.language_picker.renderer = this.renderer;
        this.language_picker.set_pixel_ratio(this.pixel_ratio);
        this.language_picker.set_viewport(this.fb_width, this.fb_height);

        this.theme_picker.render(proj);
        this.language_picker.render(proj);

        // Export options panel
        if (this._export_open) this._render_export_panel(proj);
    }

    // --- Loop principal ---

    async run() {
        await this.init();

        if (this._deferred_glss) {
            try {
                await this._load_graph(this._deferred_glss.data, this._deferred_glss.name);
            } catch (e) {
                console.log(`Error abriendo archivo: ${e.message || e}`);
            }
        }

        const frame = () => {
            // Video frame update
            if (this.renderer && this.renderer.has_video()) this.renderer.update_video();

            // Auto-compilar
            if (this.mode === MODE_NODES && this.node_graph.needs_compile) {
                this._compile_from_nodes();
            } else if (this.mode === MODE_TEXT && this._pending_compile && this.editor.needs_compile) {
                if (monotonic() - this._last_edit_time > COMPILE_DELAY) this._do_compile();
            }

            this._render();
            requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
    }
}

export { Theme, MenuConfig };

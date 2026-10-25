// Punto de entrada web: equivale a glfw + main() de app.py.
//
// Traduce los eventos del navegador a los callbacks que usa App
// (_on_key, _on_char, _on_mouse_button, _on_cursor_pos, _on_scroll, _on_drop,
// _on_resize), con los mismos valores que GLFW.

import * as glfw from "./glfw.js";
import { App, MODE_TEXT, MODE_NODES } from "./app.js";
import { load_fonts } from "./renderer.js";
import { pyIsPrintable } from "./pyutil.js";

const canvas = document.getElementById("gl");
const ime = document.getElementById("ime");
const loading = document.getElementById("loading");

const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

function fail(msg) {
    loading.textContent = msg;
    loading.classList.add("error");
}

// ======================
// PLATAFORMA (lo que App le pide a "glfw")
// ======================

class Platform {
    constructor(gl) {
        this.gl = gl;
        this.cursor_x = 0;
        this.cursor_y = 0;
        this._pending_copy = null;   // texto que App quiere copiar en este Cmd+C/X
        this._in_copy_key = false;
        this._paste_text = null;     // texto del evento paste en curso
        this._last_copied = "";      // respaldo si no se puede leer el portapapeles
        this.is_mac = IS_MAC;        // atajos con Cmd (Mac/iPad) o Ctrl
        this.touch_input = false;    // el último puntero fue un dedo (sin hover)
    }

    get_framebuffer_size() {
        return [canvas.width, canvas.height];
    }

    get_window_size() {
        return [canvas.clientWidth, canvas.clientHeight];
    }

    get_cursor_pos() {
        return [this.cursor_x, this.cursor_y];
    }

    is_printable(ch) {
        return pyIsPrintable(ch);
    }

    clipboard_get() {
        return this._paste_text;
    }

    clipboard_set(text) {
        this._last_copied = text;
        if (this._in_copy_key) {
            // Se escribe en el evento "copy"/"cut" que el navegador lanza después
            this._pending_copy = text;
        } else if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).catch(() => {});
        }
    }

    async clipboard_read_async() {
        try {
            if (navigator.clipboard && navigator.clipboard.readText) {
                return await navigator.clipboard.readText();
            }
        } catch (e) {
            // Permiso denegado: usar lo último copiado en esta página
        }
        return this._last_copied;
    }
}

// ======================
// TAMAÑO DEL CANVAS
// ======================

function resize_canvas() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const fw = Math.max(1, Math.round(w * dpr));
    const fh = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== fw || canvas.height !== fh) {
        canvas.width = fw;
        canvas.height = fh;
        return true;
    }
    return false;
}

// ======================
// INICIO
// ======================

async function start() {
    document.title = "GLSL Studio";

    const gl = canvas.getContext("webgl2", {
        antialias: true,   // glfw.SAMPLES = 4
        alpha: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
    });
    if (!gl) {
        fail("WebGL2 no está disponible en este navegador. / WebGL2 is not available in this browser.");
        return;
    }

    resize_canvas();

    let app;
    try {
        await load_fonts();
        const platform = new Platform(gl);
        app = await App.create(platform);
        app.node_view.request_fit();
        await app.run();
        install_input(app, platform);
    } catch (e) {
        console.error(e);
        fail(`Error: ${e.message || e}`);
        return;
    }

    loading.remove();
    ime.focus({ preventScroll: true });

    window.__glsl_studio = app; // para depurar desde la consola
}

// ======================
// ENTRADA
// ======================

function install_input(app, platform) {
    const pos_of = (e) => {
        const r = canvas.getBoundingClientRect();
        return [e.clientX - r.left, e.clientY - r.top];
    };

    const set_cursor = (x, y) => {
        platform.cursor_x = x;
        platform.cursor_y = y;
        app._on_cursor_pos(x, y);
    };

    // --- Resize ---
    const on_resize = () => {
        resize_canvas();
        app._on_resize(canvas.width, canvas.height, canvas.clientWidth, canvas.clientHeight);
    };
    window.addEventListener("resize", on_resize);
    let dpr_query = null;
    const watch_dpr = () => {
        if (dpr_query) dpr_query.removeEventListener("change", on_dpr);
        dpr_query = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
        dpr_query.addEventListener("change", on_dpr);
    };
    const on_dpr = () => {
        on_resize();
        watch_dpr();
    };
    watch_dpr();
    on_resize();

    // --- Teclado ---
    // Teclas que no producen texto y que el navegador usaría para otra cosa
    const NO_TEXT = new Set([
        glfw.KEY_ESCAPE, glfw.KEY_ENTER, glfw.KEY_KP_ENTER, glfw.KEY_TAB, glfw.KEY_BACKSPACE,
        glfw.KEY_DELETE, glfw.KEY_INSERT, glfw.KEY_UP, glfw.KEY_DOWN, glfw.KEY_LEFT, glfw.KEY_RIGHT,
        glfw.KEY_HOME, glfw.KEY_END, glfw.KEY_PAGE_UP, glfw.KEY_PAGE_DOWN, glfw.KEY_F1, glfw.KEY_F2,
    ]);
    // Combinaciones con Cmd/Ctrl que usa la app
    const CMD_KEYS = new Set([
        glfw.KEY_S, glfw.KEY_L, glfw.KEY_E, glfw.KEY_EQUAL, glfw.KEY_MINUS, glfw.KEY_0,
        glfw.KEY_Z, glfw.KEY_Y, glfw.KEY_A, glfw.KEY_D, glfw.KEY_KP_ADD, glfw.KEY_KP_SUBTRACT,
    ]);

    let paste_mods = 0;
    let copy_from_key = false; // el evento copy/cut viene de nuestro Cmd+C/X
    let paste_action = glfw.PRESS;

    // El textarea siempre queda con " " seleccionado (así Retroceso y los
    // botones Copiar/Cortar del teclado en pantalla siempre tienen algo).
    // Con execCommand el cambio entra al historial nativo: así el iPad activa
    // sus botones Deshacer/Rehacer (llegan como input historyUndo/historyRedo).
    let resetting = false;
    const reset_ime = () => {
        resetting = true;
        try {
            let ok = false;
            if (document.activeElement === ime && ime.value !== " ") {
                ime.select();
                try {
                    ok = document.execCommand("insertText", false, " ");
                } catch (e) {
                    ok = false;
                }
            }
            if (!ok || ime.value !== " ") ime.value = " ";
            ime.setSelectionRange(0, 1);
        } finally {
            resetting = false;
        }
    };
    reset_ime();

    ime.addEventListener("keydown", (e) => {
        copy_from_key = false;
        if (e.isComposing || e.keyCode === 229) return; // IME: llega por composition/input
        const key = glfw.CODE_TO_KEY[e.code] ?? glfw.KEY_UNKNOWN;
        const mods = glfw.mods_of(e);
        const action = e.repeat ? glfw.REPEAT : glfw.PRESS;
        const cmd = e.ctrlKey || e.metaKey;

        // Copiar/cortar: App decide el texto; el navegador lanza "copy"/"cut" después
        if (cmd && !e.altKey && !e.shiftKey && (key === glfw.KEY_C || key === glfw.KEY_X)) {
            platform._in_copy_key = true;
            platform._pending_copy = null;
            try {
                app._on_key(key, 0, action, mods);
            } finally {
                platform._in_copy_key = false;
            }
            copy_from_key = true;
            return; // sin preventDefault: el navegador lanza el evento copy/cut
        }

        // Pegar: el texto solo está disponible en el evento "paste"
        if (cmd && !e.altKey && !e.shiftKey && key === glfw.KEY_V) {
            paste_mods = mods;
            paste_action = action;
            return; // sin preventDefault: el navegador lanza el evento paste
        }

        app._on_key(key, 0, action, mods);

        const prevent =
            NO_TEXT.has(key) ||
            (cmd && (CMD_KEYS.has(key) || key === glfw.KEY_L || key === glfw.KEY_S)) ||
            (e.altKey && key === glfw.KEY_T);
        if (prevent) e.preventDefault();
    });

    ime.addEventListener("keyup", (e) => {
        const key = glfw.CODE_TO_KEY[e.code] ?? glfw.KEY_UNKNOWN;
        app._on_key(key, 0, glfw.RELEASE, glfw.mods_of(e));
    });

    // Copiar/cortar sin Cmd+C/X (botones del teclado en pantalla, menú del
    // navegador): App decide el texto aquí mismo
    const on_copy_cut = (e, key) => {
        e.preventDefault();
        if (!copy_from_key) {
            platform._in_copy_key = true;
            platform._pending_copy = null;
            try {
                app._on_key(key, 0, glfw.PRESS, IS_MAC ? glfw.MOD_SUPER : glfw.MOD_CONTROL);
                app._on_key(key, 0, glfw.RELEASE, 0);
            } finally {
                platform._in_copy_key = false;
            }
        }
        copy_from_key = false;
        if (platform._pending_copy !== null) {
            e.clipboardData.setData("text/plain", platform._pending_copy);
            platform._pending_copy = null;
        }
    };
    ime.addEventListener("copy", (e) => on_copy_cut(e, glfw.KEY_C));
    ime.addEventListener("cut", (e) => on_copy_cut(e, glfw.KEY_X));

    ime.addEventListener("paste", (e) => {
        e.preventDefault();
        platform._paste_text = e.clipboardData.getData("text/plain");
        try {
            app._on_key(glfw.KEY_V, 0, paste_action, paste_mods || (IS_MAC ? glfw.MOD_SUPER : glfw.MOD_CONTROL));
        } finally {
            platform._paste_text = null;
            paste_mods = 0;
        }
    });

    // Texto (equivale al char callback de glfw)
    const send_text = (text) => {
        for (const ch of text) app._on_char(ch.codePointAt(0));
    };

    let composing = false;
    ime.addEventListener("compositionstart", () => { composing = true; });
    ime.addEventListener("compositionend", (e) => {
        composing = false;
        if (e.data) send_text(e.data);
        reset_ime();
    });

    ime.addEventListener("input", (e) => {
        if (resetting || composing || e.isComposing) return;
        const t = e.inputType;
        // Deshacer/Rehacer del teclado en pantalla (iPad). No se resetea el
        // textarea para que el navegador conserve su Rehacer.
        if (t === "historyUndo" || t === "historyRedo") {
            const mods = (IS_MAC ? glfw.MOD_SUPER : glfw.MOD_CONTROL) | (t === "historyRedo" ? glfw.MOD_SHIFT : 0);
            app._on_key(glfw.KEY_Z, 0, glfw.PRESS, mods);
            app._on_key(glfw.KEY_Z, 0, glfw.RELEASE, 0);
            return;
        }
        if (t === "insertText" || t === "insertReplacementText") {
            if (e.data) send_text(e.data);
        } else if (t === "insertLineBreak" || t === "insertParagraph") {
            // Teclado en pantalla: Enter sin keydown utilizable
            app._on_key(glfw.KEY_ENTER, 0, glfw.PRESS, 0);
            app._on_key(glfw.KEY_ENTER, 0, glfw.RELEASE, 0);
        } else if (t === "deleteContentBackward") {
            app._on_key(glfw.KEY_BACKSPACE, 0, glfw.PRESS, 0);
            app._on_key(glfw.KEY_BACKSPACE, 0, glfw.RELEASE, 0);
        } else if (t === "deleteContentForward") {
            app._on_key(glfw.KEY_DELETE, 0, glfw.PRESS, 0);
            app._on_key(glfw.KEY_DELETE, 0, glfw.RELEASE, 0);
        }
        reset_ime();
    });

    // --- Mouse ---
    const BUTTON = { 0: glfw.MOUSE_BUTTON_LEFT, 1: glfw.MOUSE_BUTTON_MIDDLE, 2: glfw.MOUSE_BUTTON_RIGHT, 3: 3, 4: 4 };

    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    canvas.addEventListener("pointerdown", (e) => {
        if (e.pointerType === "touch") return touch_down(e);
        e.preventDefault();
        platform.touch_input = false;
        if (ime.inputMode === "none") ime.inputMode = ""; // mouse: modo normal
        ime.focus({ preventScroll: true });
        canvas.setPointerCapture(e.pointerId);
        const [x, y] = pos_of(e);
        set_cursor(x, y);
        app._on_mouse_button(BUTTON[e.button] ?? e.button, glfw.PRESS, glfw.mods_of(e));
    });

    canvas.addEventListener("pointermove", (e) => {
        if (e.pointerType === "touch") return touch_move(e);
        platform.touch_input = false;
        const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
        for (const ev of (events.length ? events : [e])) {
            const [x, y] = pos_of(ev);
            set_cursor(x, y);
        }
    });

    canvas.addEventListener("pointerup", (e) => {
        if (e.pointerType === "touch") return touch_up(e);
        const [x, y] = pos_of(e);
        set_cursor(x, y);
        app._on_mouse_button(BUTTON[e.button] ?? e.button, glfw.RELEASE, glfw.mods_of(e));
    });

    canvas.addEventListener("pointercancel", (e) => {
        if (e.pointerType === "touch") return touch_up(e, true);
    });

    // --- Rueda (scroll callback de glfw) ---
    canvas.addEventListener("wheel", (e) => {
        e.preventDefault();
        let k;
        if (e.deltaMode === 1) k = 1 / 3;          // líneas: 3 por paso de rueda
        else if (e.deltaMode === 2) k = 1;         // páginas
        else k = IS_MAC ? 0.1 : 1 / 100;            // píxeles (macOS: como glfw con trackpad)
        const [x, y] = pos_of(e);
        set_cursor(x, y);
        // Ctrl/Cmd con la rueda = tamaño de fuente (como escritorio)
        const held_ctrl = app._ctrl_held, held_super = app._super_held;
        app._ctrl_held = e.ctrlKey;
        app._super_held = e.metaKey;
        app._on_scroll(-e.deltaX * k, -e.deltaY * k);
        app._ctrl_held = held_ctrl;
        app._super_held = held_super;
    }, { passive: false });

    // --- Táctil (básico) ---
    // Toque = clic izquierdo, mantener = clic derecho, dos dedos = pan/zoom.
    const touches = new Map(); // pointerId -> {x, y, sx, sy, t}
    let one = null;            // estado del dedo único
    let gesture = null;        // estado de dos dedos
    const MOVE_TOL = 8;
    const LONG_PRESS = 500;

    const editor_area_hit = (x, y) => {
        const pr = app.pixel_ratio;
        const [ex, ey, ew, eh] = app._editor_rect();
        return ex <= x * pr && x * pr < ex + ew && ey <= y * pr && y * pr < ey + eh;
    };

    // Teclado en pantalla solo al tocar el editor de texto. El textarea no
    // pierde el foco (inputmode="none") para que un teclado físico siga
    // funcionando en pantallas táctiles (atajos, F1/F2, Supr...).
    const set_virtual_keyboard = (mode) => {
        if (ime.inputMode !== mode) {
            ime.inputMode = mode;
            ime.blur(); // al volver a enfocar el navegador aplica el nuevo modo
        }
        ime.focus({ preventScroll: true });
    };

    // Después de un toque: barra superior = el teclado queda igual; editar un
    // valor del panel de parámetros = teclado numérico; editor de texto =
    // teclado normal; lo demás = sin teclado.
    const keyboard_after_tap = (x, y) => {
        const pr = app.pixel_ratio;
        if (y * pr < app._toolbar_height()) return;
        if (app.mode === MODE_NODES && app.node_view.panel_edit_idx >= 0) set_virtual_keyboard("decimal");
        else set_virtual_keyboard(app.mode === MODE_TEXT && editor_area_hit(x, y) ? "text" : "none");
    };

    // Al terminar de editar un valor (Enter, Esc...) se cierra el teclado numérico
    const close_decimal_keyboard = () => {
        if (ime.inputMode === "decimal" && app.node_view.panel_edit_idx < 0) set_virtual_keyboard("none");
    };
    ime.addEventListener("keyup", close_decimal_keyboard);
    ime.addEventListener("input", close_decimal_keyboard);

    // Menú abierto bajo el punto (px del framebuffer), para el scroll con el dedo
    const menu_at = (px, py) => {
        const nv = app.node_view;
        const menus = [app.theme_picker, app.language_picker];
        if (app.mode === MODE_NODES) {
            if (nv.props_open) menus.push(nv.props_menu_system);
            menus.push(nv.menu_system);
        }
        for (const m of menus) {
            if (!m.is_open()) continue;
            const [mx, my, mw, mh] = m._calculate_rect();
            if (mx <= px && px <= mx + mw && my <= py && py <= my + mh) return m;
        }
        return null;
    };

    function touch_down(e) {
        e.preventDefault();
        canvas.setPointerCapture(e.pointerId);
        const [x, y] = pos_of(e);
        touches.set(e.pointerId, { x, y });
        platform.touch_input = true;

        if (touches.size === 1) {
            const pr = app.pixel_ratio;
            const menu = menu_at(x * pr, y * pr);
            one = { id: e.pointerId, sx: x, sy: y, started: false, long: false, timer: null,
                    menu, last_y: y, scroll_acc: 0 };
            // Dentro de un menú: arrastrar = scroll, tocar = elegir, mantener = nada
            if (menu) return;
            one.timer = setTimeout(() => {
                if (!one || one.started) return;
                one.long = true;
                set_cursor(one.sx, one.sy);
                app._on_mouse_button(glfw.MOUSE_BUTTON_RIGHT, glfw.PRESS, 0);
                app._on_mouse_button(glfw.MOUSE_BUTTON_RIGHT, glfw.RELEASE, 0);
            }, LONG_PRESS);
        } else if (touches.size === 2) {
            if (one) {
                clearTimeout(one.timer);
                if (one.started && !one.menu) app._on_mouse_button(glfw.MOUSE_BUTTON_LEFT, glfw.RELEASE, 0);
                one = null;
            }
            const [a, b] = [...touches.values()];
            gesture = {
                mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2,
                dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
                scroll_acc: 0,
            };
        }
    }

    function touch_move(e) {
        if (!touches.has(e.pointerId)) return;
        e.preventDefault();
        const [x, y] = pos_of(e);
        touches.set(e.pointerId, { x, y });

        if (gesture && touches.size >= 2) {
            const [a, b] = [...touches.values()];
            const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
            const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
            const pr = app.pixel_ratio;
            const dx = (mx - gesture.mx) * pr, dy = (my - gesture.my) * pr;
            if (app.mode === MODE_NODES && editor_area_hit(mx, my)) {
                const nv = app.node_view;
                nv.cam_x -= dx / nv.zoom;
                nv.cam_y -= dy / nv.zoom;
                nv.zoom_to(nv.zoom * dist / gesture.dist, mx * pr, my * pr);
            } else if (app.mode === MODE_TEXT && editor_area_hit(mx, my)) {
                gesture.scroll_acc += dy;
                const ch = app._char_h();
                const lines = Math.trunc(gesture.scroll_acc / ch);
                if (lines) {
                    app.editor.scroll_y = Math.max(0, app.editor.scroll_y - lines);
                    gesture.scroll_acc -= lines * ch;
                }
            }
            gesture.mx = mx;
            gesture.my = my;
            gesture.dist = dist;
            return;
        }

        if (one && one.id === e.pointerId && one.menu) {
            if (!one.started && Math.hypot(x - one.sx, y - one.sy) > MOVE_TOL) one.started = true;
            if (one.started) {
                const m = one.menu;
                const item_h = m.config.item_height * m.pixel_ratio;
                one.scroll_acc += (y - one.last_y) * app.pixel_ratio;
                const lines = Math.trunc(one.scroll_acc / item_h);
                if (lines) {
                    m.on_scroll(lines);
                    one.scroll_acc -= lines * item_h;
                }
            }
            one.last_y = y;
            return;
        }

        if (one && one.id === e.pointerId && !one.long) {
            if (!one.started && Math.hypot(x - one.sx, y - one.sy) > MOVE_TOL) {
                clearTimeout(one.timer);
                one.started = true;
                set_cursor(one.sx, one.sy);
                app._on_mouse_button(glfw.MOUSE_BUTTON_LEFT, glfw.PRESS, 0);
            }
            if (one.started) set_cursor(x, y);
        }
    }

    function touch_up(e, cancelled = false) {
        if (!touches.has(e.pointerId)) return;
        touches.delete(e.pointerId);
        const [x, y] = pos_of(e);

        if (one && one.id === e.pointerId && one.menu) {
            // Toque sin arrastrar dentro del menú = clic (elige el item)
            if (!one.started && !cancelled) {
                set_cursor(x, y);
                app._on_mouse_button(glfw.MOUSE_BUTTON_LEFT, glfw.PRESS, 0);
                app._on_mouse_button(glfw.MOUSE_BUTTON_LEFT, glfw.RELEASE, 0);
                keyboard_after_tap(x, y);
            }
            one = null;
        } else if (one && one.id === e.pointerId) {
            clearTimeout(one.timer);
            if (!one.long && !cancelled) {
                if (!one.started) {
                    // Toque = clic
                    set_cursor(x, y);
                    app._on_mouse_button(glfw.MOUSE_BUTTON_LEFT, glfw.PRESS, 0);
                    app._on_mouse_button(glfw.MOUSE_BUTTON_LEFT, glfw.RELEASE, 0);
                    keyboard_after_tap(x, y);
                } else {
                    set_cursor(x, y);
                    app._on_mouse_button(glfw.MOUSE_BUTTON_LEFT, glfw.RELEASE, 0);
                }
            } else if (one.started) {
                app._on_mouse_button(glfw.MOUSE_BUTTON_LEFT, glfw.RELEASE, 0);
            }
            one = null;
        }
        if (touches.size < 2) gesture = null;
    }

    // --- Soltar archivos (drop callback de glfw) ---
    window.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
    });
    window.addEventListener("drop", (e) => {
        e.preventDefault();
        const files = e.dataTransfer && e.dataTransfer.files;
        if (files && files.length) app._on_drop(files);
    });

    // Mantener el foco del textarea con mouse (los atajos y el texto llegan ahí)
    window.addEventListener("focus", () => ime.focus({ preventScroll: true }));
}

start();

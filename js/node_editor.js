// Port de node_editor.py: grafo de nodos y vista del editor de nodos.

import * as glfw from "./glfw.js";
import { color_to_vec4 } from "./theme.js";
import { MenuSystem, MenuConfig, MenuItem } from "./menu_system.js";
import { _ } from "./lang.js";
import {
    NodeInstance, LinkInstance, GraphCompiler, GraphDecompiler,
    NODE_REGISTRY, NODE_W, NODE_H_HEADER, NODE_H_SLOT, NODE_H_DESC, NODE_SLOT_RADIUS,
    SLOT_COLORS, get_node_menu, get_localized_node_name, get_localized_category_name,
} from "./nodes.js";
import {
    pyFormatFixed, pyRound, pyFloat, pyInt, pyMod, pyStrip, cpLen, pySplitWs, pyRoundInt,
    PySet, timeNow, pyFloatRepr,
} from "./pyutil.js";

// ======================
// CONFIG
// ======================

export const PAN_SPEED = 1.0;
export const ZOOM_MIN = 0.3;
export const ZOOM_MAX = 3.0;
export const ZOOM_STEP = 0.1;

export const GRID_SIZE = 40;
export const GRID_COLOR = [0.12, 0.12, 0.16, 1.0];
export const GRID_COLOR_MAJOR = [0.15, 0.15, 0.20, 1.0];
export const BG_COLOR = [0.10, 0.10, 0.13, 1.0];

export const LINK_THICKNESS = 3.0;
export const LINK_CURVATURE = 0.4;

export const MENU_ITEM_H = 24;
export const MENU_W = 220;

export const SELECTION_COLOR = [0.95, 0.75, 0.2, 1.0];

export const TOOLTIP_DELAY = 0.9; // segundos de hover para mostrar tooltip

// Panel de configuración
export const PANEL_W = 200;
export const PANEL_PAD = 8;
export const PANEL_ROW_H = 26;
export const PANEL_HEADER_H = 30;
export const PANEL_BG = [0.12, 0.12, 0.16, 0.95];
export const PANEL_HEADER_BG = [0.18, 0.18, 0.24, 1.0];
export const PANEL_FIELD_BG = [0.08, 0.08, 0.12, 1.0];
export const PANEL_FIELD_EDIT_BG = [0.15, 0.18, 0.28, 1.0];
export const PANEL_LABEL_FG = [0.6, 0.65, 0.75, 1.0];
export const PANEL_VALUE_FG = [0.85, 0.9, 0.85, 1.0];
export const PANEL_BORDER = [0.25, 0.25, 0.35, 0.8];
export const PANEL_SLIDER_BG = [0.2, 0.2, 0.28, 1.0];
export const PANEL_SLIDER_FG = [0.4, 0.55, 0.8, 1.0];

const rgb_a = (c, a) => [c[0], c[1], c[2], a];

// ======================
// NODE GRAPH
// ======================

export class NodeGraph {
    constructor() {
        this.nodes = [];
        this.links = [];
        this.modified = false;
        this._needs_compile = true;

        // Crear nodo Output por defecto
        this.add_node(0, 400, 200);
    }

    get needs_compile() {
        return this._needs_compile;
    }

    mark_compiled() {
        this._needs_compile = false;
    }

    _mark_dirty() {
        this.modified = true;
        this._needs_compile = true;
    }

    add_node(type_id, x, y, node_id = null) {
        const n = new NodeInstance(type_id, x, y, node_id);
        this.nodes.push(n);
        this._mark_dirty();
        return n;
    }

    remove_node(node_id) {
        // No borrar Output si es el único
        const node = this.get_node(node_id);
        if (node && node.type_id === 0) {
            const outputs = this.nodes.filter((n) => n.type_id === 0);
            if (outputs.length <= 1) return false;
        }
        this.nodes = this.nodes.filter((n) => n.id !== node_id);
        this.links = this.links.filter((l) => l.from_node !== node_id && l.to_node !== node_id);
        this._mark_dirty();
        return true;
    }

    add_link(from_node, to_node, from_slot, to_slot) {
        // Eliminar link existente al mismo input
        this.links = this.links.filter((l) => !(l.to_node === to_node && l.to_slot === to_slot));
        // No permitir ciclos simples
        if (from_node === to_node) return null;
        const link = new LinkInstance(from_node, to_node, from_slot, to_slot);
        this.links.push(link);
        this._mark_dirty();
        return link;
    }

    remove_link(link) {
        const i = this.links.indexOf(link);
        if (i >= 0) {
            this.links.splice(i, 1);
            this._mark_dirty();
        }
    }

    get_node(node_id) {
        for (const n of this.nodes) if (n.id === node_id) return n;
        return null;
    }

    compile() {
        return new GraphCompiler(this.nodes, this.links).compile();
    }

    get_node_tuples() {
        return this.nodes.map((n) => n.to_tuple());
    }

    get_link_tuples() {
        return this.links.map((l) => l.to_tuple());
    }

    load_from_tuples(nodes_t, links_t) {
        NodeInstance._next_id = 1;
        this.nodes = nodes_t.map((t) => NodeInstance.from_tuple(t));
        this.links = links_t.map((t) => LinkInstance.from_tuple(t));
        this._mark_dirty();
    }

    clear() {
        this.nodes.length = 0;
        this.links.length = 0;
        NodeInstance._next_id = 1;
        this.add_node(0, 400, 200);
    }

    sync_from_source(source) {
        /** Intenta reconstruir el grafo desde código GLSL. Preserva posiciones
         *  de nodos existentes que coincidan en ID. Retorna true si pudo. */
        // Excluir nodo Output para que el autolayout lo reposicione siempre a la derecha
        const existing = new Map();
        const old_params = new Map();
        for (const n of this.nodes) {
            if (n.type_id !== 0) existing.set(n.id, [n.x, n.y, n.type_id]);
            if (Object.keys(n.params).length) old_params.set(n.id, { ...n.params });
        }

        const result = new GraphDecompiler().decompile(source, existing);
        if (result === null) return false;

        const [new_nodes, new_links] = result;

        // Reemplazar grafo
        NodeInstance._next_id = 1;
        this.nodes = new_nodes;
        this.links = new_links;

        // Restaurar parámetros de nodos existentes que no cambiaron de tipo
        for (const n of this.nodes) {
            if (existing.has(n.id) && existing.get(n.id)[2] === n.type_id) {
                if (old_params.has(n.id) && !Object.keys(n.params).length) {
                    n.params = old_params.get(n.id);
                }
            }
        }

        // Actualizar _next_id
        if (this.nodes.length) {
            const max_id = Math.max(...this.nodes.map((n) => n.id));
            NodeInstance._next_id = Math.max(NodeInstance._next_id, max_id + 1);
        }

        this._mark_dirty();
        return true;
    }
}

// ======================
// EDITOR VIEW
// ======================

export class NodeEditorView {
    constructor(graph, theme = null) {
        this.graph = graph;
        this.theme = theme;

        // Cámara
        this.cam_x = 0.0;
        this.cam_y = 0.0;
        this.zoom = 1.0;

        // Interacción
        this.selected_node = null;
        this.selected_link = null;
        this.dragging_node = false;
        this.drag_offset_x = 0;
        this.drag_offset_y = 0;

        // Creación de links
        this.linking = false;
        this.link_from_node = null;
        this.link_from_slot = -1;
        this.link_is_output = true;
        this.link_end_x = 0;
        this.link_end_y = 0;

        // Pan
        this.panning = false;
        this.pan_start_x = 0;
        this.pan_start_y = 0;

        // Menú contextual
        this.menu_x = 0;
        this.menu_y = 0;
        this.menu_world_x = 0;
        this.menu_world_y = 0;
        this.menu_context = null; // 'node', 'link', or 'empty'

        this.menu_system = new MenuSystem({
            config: new MenuConfig({
                item_height: MENU_ITEM_H,
                width: MENU_W,
                has_overlay: false,
                theme_prefix: "menu",
                centered: false,
            }),
            renderer: null,
            theme,
            items_provider: () => this._get_menu_items(),
            on_select: (item, idx) => this._handle_menu_select(item, idx),
            pixel_ratio: 1.0,
        });

        // Edición de parámetros (inline en nodo — legacy)
        this.editing_param = false;
        this.edit_node = null;
        this.edit_param_name = "";
        this.edit_param_buf = "";

        // Panel de configuración
        this.panel_open = false;
        this.panel_edit_idx = -1;
        this.panel_edit_buf = "";
        this.panel_dragging = -1;
        this.panel_drag_start_x = 0;
        this.panel_drag_start_val = 0.0;
        this._pixel_ratio = 1.0;

        // Tooltip de descripción (hover prolongado)
        this._hover_node_id = null;
        this._hover_start = 0.0;
        this._tooltip_visible = false;
        this._tooltip_mx = 0;
        this._tooltip_my = 0;

        // Tooltip de slot
        this._hover_slot = null; // [node_id, 'in'/'out', slot_idx] | null
        this._hover_slot_start = 0.0;
        this._slot_tooltip_visible = false;
        this._slot_tooltip_mx = 0;
        this._slot_tooltip_my = 0;

        // Panel de propiedades (click derecho > propiedades)
        this.props_open = false;
        this.props_node_id = null;
        this.props_selected_slot = null; // ['in', idx] | ['out', idx] | null

        this.props_menu_system = new MenuSystem({
            config: new MenuConfig({
                item_height: 24,
                width: 320,
                padding: 8,
                has_overlay: false,
                theme_prefix: "menu",
                centered: false,
                anchor_bottom: true,
                anchor_bottom_margin: 16,
                header_height: 80,
                footer_height: 120,
                max_visible_height_ratio: 0.6,
            }),
            renderer: null,
            theme,
            items_provider: () => this._props_get_menu_items(),
            on_select: (item, idx) => this._props_handle_menu_select(item, idx),
            pixel_ratio: 1.0,
        });

        // Viewport
        this.vp_x = 0;
        this.vp_y = 0;
        this.vp_w = 100;
        this.vp_h = 100;

        // Ajuste diferido: _fit_all() se hace en el próximo render
        this._fit_pending = true;

        // Última posición del mouse (coords de pantalla) para pegar con Ctrl+V
        this._mouse_x = null;
        this._mouse_y = null;

        // Portapapeles (los asigna App). get(): texto del pegado actual (Ctrl+V);
        // read_async(): lectura del portapapeles (menú Pegar); set(text)
        this.clipboard_get = null;
        this.clipboard_set = null;
        this.clipboard_read_async = null;

        // Resaltado de camino (menú de link > Resaltar camino)
        this.highlight_links = new Set();
        this.highlight_nodes = new Set();
    }

    // --- Theme helpers ---

    _tv4(key, fallback_rgba = null) {
        /** Color del tema como vec4, con fallback fijo. */
        if (this.theme) {
            const c = this.theme.color(key);
            if (!(c[0] === 255 && c[1] === 255 && c[2] === 255) || this.theme.has(key)) {
                return color_to_vec4(c, fallback_rgba ? fallback_rgba[3] : 1.0);
            }
        }
        return fallback_rgba || [0.5, 0.5, 0.5, 1.0];
    }

    _tint(key, fallback = 0) {
        if (this.theme) return this.theme.integer(key, fallback);
        return fallback;
    }

    // --- Coordenadas ---

    screen_to_world(sx, sy) {
        const wx = (sx - this.vp_x - this.vp_w / 2) / this.zoom + this.cam_x;
        const wy = (sy - this.vp_y - this.vp_h / 2) / this.zoom + this.cam_y;
        return [wx, wy];
    }

    world_to_screen(wx, wy) {
        const sx = (wx - this.cam_x) * this.zoom + this.vp_x + this.vp_w / 2;
        const sy = (wy - this.cam_y) * this.zoom + this.vp_y + this.vp_h / 2;
        return [sx, sy];
    }

    request_fit() {
        /** Pide un _fit_all() en el próximo render (viewport ya conocido). */
        this._fit_pending = true;
    }

    _mouse_in_viewport() {
        if (this._mouse_x === null) return false;
        return (this.vp_x <= this._mouse_x && this._mouse_x < this.vp_x + this.vp_w &&
                this.vp_y <= this._mouse_y && this._mouse_y < this.vp_y + this.vp_h);
    }

    zoom_by(delta, sx = null, sy = null) {
        const old_zoom = this.zoom;
        // Punto del mundo bajo el cursor ANTES de cambiar el zoom
        let wx, wy;
        if (sx !== null && sy !== null) [wx, wy] = this.screen_to_world(sx, sy);
        // Escalar delta proporcional al zoom actual
        this.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.zoom + delta * this.zoom));
        if (this.zoom !== old_zoom && sx !== null && sy !== null) {
            // Mover la cámara para que ese punto quede bajo el cursor
            this.cam_x = wx - (sx - this.vp_x - this.vp_w / 2) / this.zoom;
            this.cam_y = wy - (sy - this.vp_y - this.vp_h / 2) / this.zoom;
        }
    }

    /** Web (pellizco táctil): fija el zoom a un valor, centrado en (sx, sy) */
    zoom_to(new_zoom, sx, sy) {
        const [wx, wy] = this.screen_to_world(sx, sy);
        this.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, new_zoom));
        this.cam_x = wx - (sx - this.vp_x - this.vp_w / 2) / this.zoom;
        this.cam_y = wy - (sy - this.vp_y - this.vp_h / 2) / this.zoom;
    }

    // --- Input ---

    _panel_rect() {
        /** [px, py, pw, ph] del panel de config en coords de pantalla. */
        const pw = PANEL_W * this._pixel_ratio;
        const ph = this.vp_h;
        const px = this.vp_x + this.vp_w - pw;
        const py = this.vp_y;
        return [px, py, pw, ph];
    }

    _panel_node() {
        /** Nodo seleccionado con params, o null. */
        if (this.selected_node === null) return null;
        const node = this.graph.get_node(this.selected_node);
        if (!node) return null;
        const nd = node.node_def;
        if (!nd || !nd.params.length) return null;
        return node;
    }

    on_mouse_press(mx, my, button, mods) {
        // Cualquier click oculta los tooltips
        this._tooltip_visible = false;
        this._hover_node_id = null;
        this._slot_tooltip_visible = false;
        this._hover_slot = null;

        // Panel de propiedades - pasar eventos al menú
        if (this.props_open && this.props_menu_system.is_open()) {
            if (this.props_menu_system.on_mouse_button(mx, my, button, 1)) return true;
            // Click fuera del menú cierra el panel
            this.props_open = false;
            this.props_menu_system.close();
            return button === 0;
        }

        // Cerrar menú si se clickea fuera (MenuSystem maneja los clicks dentro)
        if (this.menu_system.is_open()) {
            if (this.menu_system.on_mouse_button(mx, my, button, 1)) return true;
            this.menu_system.close();
            return button === 0; // Left click cierra el menú
        }

        // Panel de config: interceptar clicks
        if (button === 0 && this.panel_open) {
            if (this._panel_handle_click(mx, my)) return true;
        }

        // Cerrar edición de parámetro del panel
        if (this.panel_edit_idx >= 0) this._panel_commit_edit();

        const [wx, wy] = this.screen_to_world(mx, my);

        if (button === 0) { // Left click
            // Verificar click en slots PRIMERO (mayor prioridad que cables)
            for (const node of [...this.graph.nodes].reverse()) {
                const oslot = node.hit_output_slot(wx, wy);
                if (oslot >= 0) {
                    this.linking = true;
                    this.link_from_node = node.id;
                    this.link_from_slot = oslot;
                    this.link_is_output = true;
                    this.link_end_x = mx;
                    this.link_end_y = my;
                    this.selected_link = null;
                    return true;
                }
                const islot = node.hit_input_slot(wx, wy);
                if (islot >= 0) {
                    this.linking = true;
                    this.link_from_node = node.id;
                    this.link_from_slot = islot;
                    this.link_is_output = false;
                    this.link_end_x = mx;
                    this.link_end_y = my;
                    this.selected_link = null;
                    return true;
                }
            }

            // Verificar click en links (menor prioridad que slots)
            const hit_link = this._hit_link(wx, wy);
            if (hit_link) {
                this.selected_link = hit_link;
                this.selected_node = null;
                this.panel_open = false;
                return true;
            }

            // Verificar click en nodo (seleccionar/arrastrar)
            for (const node of [...this.graph.nodes].reverse()) {
                if (node.hit_test(wx, wy)) {
                    this.selected_node = node.id;
                    this.selected_link = null;
                    this.dragging_node = true;
                    this.drag_offset_x = wx - node.x;
                    this.drag_offset_y = wy - node.y;

                    // Mover al frente
                    this.graph.nodes.splice(this.graph.nodes.indexOf(node), 1);
                    this.graph.nodes.push(node);

                    // Abrir panel si tiene params
                    const nd = node.node_def;
                    if (nd && nd.params.length) {
                        this.panel_open = true;
                        this.panel_edit_idx = -1;
                    } else {
                        this.panel_open = false;
                    }
                    return true;
                }
            }

            // Click en vacío: deseleccionar y quitar resaltado
            this.selected_node = null;
            this.selected_link = null;
            this.panel_open = false;
            this._clear_highlight();
            return false;

        } else if (button === 1) { // Right click - menú contextual
            this.menu_x = mx;
            this.menu_y = my;
            this.menu_world_x = wx;
            this.menu_world_y = wy;
            this.menu_system.open_at(mx, my);
            return true;

        } else if (button === 2) { // Middle click - pan
            this.panning = true;
            this.pan_start_x = mx;
            this.pan_start_y = my;
            return true;
        }

        return false;
    }

    on_mouse_release(mx, my, button) {
        if (button === 0) {
            if (this.panel_dragging >= 0) {
                this._panel_handle_release(mx, my);
                return true;
            }
            if (this.linking) {
                this._finish_link(mx, my);
                this.linking = false;
                return true;
            }
            this.dragging_node = false;
            return false;
        } else if (button === 2) {
            this.panning = false;
            return false;
        }
        return false;
    }

    on_mouse_move(mx, my) {
        this._mouse_x = mx;
        this._mouse_y = my;

        // Propagar eventos al menú de propiedades si está abierto
        if (this.props_open && this.props_menu_system.is_open()) {
            this.props_menu_system.on_mouse_move(mx, my);
        }

        if (this.panel_dragging >= 0) {
            this._panel_handle_drag(mx, my);
            return true;
        }

        if (this.panning) {
            const dx = (mx - this.pan_start_x) / this.zoom;
            const dy = (my - this.pan_start_y) / this.zoom;
            this.cam_x -= dx;
            this.cam_y -= dy;
            this.pan_start_x = mx;
            this.pan_start_y = my;
            return true;
        }

        if (this.dragging_node && this.selected_node !== null) {
            const [wx, wy] = this.screen_to_world(mx, my);
            const node = this.graph.get_node(this.selected_node);
            if (node) {
                node.x = wx - this.drag_offset_x;
                node.y = wy - this.drag_offset_y;
                this.graph._mark_dirty();
            }
            return true;
        }

        if (this.linking) {
            this.link_end_x = mx;
            this.link_end_y = my;
            return true;
        }

        // Actualizar hover del menú
        if (this.menu_system.is_open()) {
            this.menu_system.on_mouse_move(mx, my);
            return false;
        }

        // Rastrear nodo y slot bajo el cursor para tooltip
        const [wx, wy] = this.screen_to_world(mx, my);
        let hovered = null;
        let hovered_slot = null;
        for (const node of [...this.graph.nodes].reverse()) {
            if (node.hit_test(wx, wy)) {
                hovered = node.id;
                const islot = node.hit_input_slot(wx, wy);
                if (islot >= 0) {
                    hovered_slot = [node.id, "in", islot];
                } else {
                    const oslot = node.hit_output_slot(wx, wy);
                    if (oslot >= 0) hovered_slot = [node.id, "out", oslot];
                }
                break;
            }
        }

        // Tooltip de nodo
        if (hovered !== this._hover_node_id) {
            this._hover_node_id = hovered;
            this._hover_start = timeNow();
            this._tooltip_visible = false;
        } else if (hovered !== null && !this._tooltip_visible) {
            if (timeNow() - this._hover_start >= TOOLTIP_DELAY) {
                this._tooltip_visible = true;
                this._tooltip_mx = mx;
                this._tooltip_my = my;
            }
        }

        // Tooltip de slot
        const same_slot = (a, b) => (a === null && b === null) ||
            (a !== null && b !== null && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]);
        if (!same_slot(hovered_slot, this._hover_slot)) {
            this._hover_slot = hovered_slot;
            this._hover_slot_start = timeNow();
            this._slot_tooltip_visible = false;
        } else if (hovered_slot !== null && !this._slot_tooltip_visible) {
            if (timeNow() - this._hover_slot_start >= TOOLTIP_DELAY) {
                this._slot_tooltip_visible = true;
                this._slot_tooltip_mx = mx;
                this._slot_tooltip_my = my;
            }
        }

        return false;
    }

    on_scroll(xoff, yoff, mx, my) {
        if (this.menu_system.is_open()) {
            this.menu_system.on_scroll(yoff);
            return true;
        }
        // Pan con scroll (adaptado al zoom)
        const pan_amount = 40.0 * PAN_SPEED / this.zoom;
        this.cam_x -= xoff * pan_amount;
        this.cam_y -= yoff * pan_amount;
        return true;
    }

    on_key(key, action, mods) {
        if (this.panel_edit_idx >= 0) return this._panel_handle_key(key, action, mods);

        // Navegación en panel de propiedades
        if (this.props_open && this.props_menu_system.is_open()) {
            if (this.props_menu_system.on_key(key, action, mods)) {
                // Si el menú se cerró (Esc), el panel también queda cerrado
                if (!this.props_menu_system.is_open()) this.props_open = false;
                return true;
            }
            // ESC cierra el panel
            if (key === 256 && action === 1) {
                this.props_open = false;
                this.props_menu_system.close();
                return true;
            }
        }

        // Zoom con +/-/=: lo maneja App con los caracteres (un paso, en el mouse)

        // Navegación del menú con flechas
        if (this.menu_system.is_open()) {
            if (this.menu_system.on_key(key, action, mods)) return true;
        }

        // Atajos que muestra el menú contextual
        if (action === glfw.PRESS) {
            const shortcut_action = this._shortcut_action(key, mods);
            if (shortcut_action) {
                if (this.menu_system.is_open()) this.menu_system.close();
                this._handle_menu_action(shortcut_action);
                return true;
            }
        }

        // Delete - eliminar nodo o link seleccionado
        if (key === 261 && (action === 1 || action === 2)) {
            if (this.menu_system.is_open()) {
                this.menu_system.close();
                return true;
            }
            if (this.selected_node !== null) {
                this.graph.remove_node(this.selected_node);
                this.selected_node = null;
                return true;
            }
            if (this.selected_link !== null) {
                this.graph.remove_link(this.selected_link);
                this.selected_link = null;
                return true;
            }
        }

        // Backspace también borra
        if (key === 259 && (action === 1 || action === 2)) {
            if (this.selected_node !== null) {
                this.graph.remove_node(this.selected_node);
                this.selected_node = null;
                return true;
            }
            if (this.selected_link !== null) {
                this.graph.remove_link(this.selected_link);
                this.selected_link = null;
                return true;
            }
        }

        // A - abrir menú add en el centro
        if (key === 65 && action === 1 && !mods) {
            this.menu_x = this.vp_x + this.vp_w / 2;
            this.menu_y = this.vp_y + this.vp_h / 2;
            const [wx, wy] = this.screen_to_world(this.menu_x, this.menu_y);
            this.menu_world_x = wx;
            this.menu_world_y = wy;
            this.menu_system.open_at(this.menu_x, this.menu_y);
            return true;
        }

        // F - con nodo seleccionado: enfocarlo; sin selección: ajustar todo
        if (key === 70 && action === 1) {
            if (this.selected_node !== null) this._handle_menu_action("focus");
            else this._fit_all();
            return true;
        }

        // Escape
        if (key === 256 && action === 1) {
            if (this.menu_system.is_open()) {
                this.menu_system.close();
                return true;
            }
            if (this.props_open) {
                this.props_open = false;
                return true;
            }
            if (this.panel_open) {
                this.panel_open = false;
                this.panel_edit_idx = -1;
                return true;
            }
            this.selected_node = null;
            this.selected_link = null;
            this._clear_highlight();
            return true;
        }

        return false;
    }

    _shortcut_action(key, mods) {
        /** Traduce una tecla a la acción del menú contextual que la muestra. */
        const cmd = (mods & (glfw.MOD_CONTROL | glfw.MOD_SUPER)) !== 0;
        const shift = (mods & glfw.MOD_SHIFT) !== 0;

        if (this.selected_node !== null) {
            if (cmd && !shift && key === glfw.KEY_D) return "duplicate";
            if (shift && !cmd && key === glfw.KEY_D) return "duplicate_nearby";
            if (cmd && !shift && key === glfw.KEY_C) return "copy";
            if (!mods && key === glfw.KEY_P) return "properties";
        }

        if (this.selected_link !== null && !mods) {
            if (key === glfw.KEY_S) return "link_origin";
            if (key === glfw.KEY_T) return "link_end";
            if (key === glfw.KEY_H) return "link_highlight";
        }

        if (cmd && !shift && key === glfw.KEY_V) return "paste_mouse";

        return null;
    }

    on_char(codepoint) {
        if (this.panel_edit_idx >= 0) return this._panel_handle_char(codepoint);
        return false;
    }

    // --- Link creation ---

    _finish_link(mx, my) {
        const [wx, wy] = this.screen_to_world(mx, my);
        for (const node of [...this.graph.nodes].reverse()) {
            if (this.link_is_output) {
                // Arrastramos desde un output -> buscar input destino
                const islot = node.hit_input_slot(wx, wy);
                if (islot >= 0 && node.id !== this.link_from_node) {
                    this.graph.add_link(this.link_from_node, node.id, this.link_from_slot, islot);
                    return;
                }
            } else {
                // Arrastramos desde un input -> buscar output origen
                const oslot = node.hit_output_slot(wx, wy);
                if (oslot >= 0 && node.id !== this.link_from_node) {
                    this.graph.add_link(node.id, this.link_from_node, oslot, this.link_from_slot);
                    return;
                }
            }
        }
    }

    // --- Menú contextual ---

    _get_menu_items() {
        /** Generar items del menú basado en contexto */
        const items = [];

        // Si tenemos un nodo seleccionado
        if (this.selected_node !== null) {
            this.menu_context = "node";
            const node = this.graph.get_node(this.selected_node);
            if (node) {
                items.push(new MenuItem(_("menu_separator_selected"), { separator: true }));
                items.push(new MenuItem(_("menu_duplicate"), { action: "duplicate", shortcut: "Ctrl+D" }));
                items.push(new MenuItem(_("menu_duplicate_nearby"), { action: "duplicate_nearby", shortcut: "Shift+D" }));
                items.push(new MenuItem(_("menu_copy_node"), { action: "copy", shortcut: "Ctrl+C" }));
                items.push(new MenuItem("---", { separator: true }));
                items.push(new MenuItem(_("menu_focus_node"), { action: "focus", shortcut: "F" }));
                items.push(new MenuItem(_("menu_properties_node"), { action: "properties", shortcut: "P" }));
                items.push(new MenuItem("---", { separator: true }));
                items.push(new MenuItem(_("menu_delete_node"), { action: "delete", shortcut: "Del" }));
            }
            return items;
        }

        // Si tenemos un link seleccionado
        if (this.selected_link !== null) {
            this.menu_context = "link";
            items.push(new MenuItem(_("menu_separator_selected"), { separator: true }));
            items.push(new MenuItem(_("menu_go_to_source"), { action: "link_origin", shortcut: "S" }));
            items.push(new MenuItem(_("menu_go_to_target"), { action: "link_end", shortcut: "T" }));
            items.push(new MenuItem(_("menu_highlight_path"), { action: "link_highlight", shortcut: "H" }));
            items.push(new MenuItem("---", { separator: true }));
            items.push(new MenuItem(_("menu_delete_node"), { action: "link_delete", shortcut: "Del" }));
            return items;
        }

        // Menú normal: opciones de agregar nodos + paste
        this.menu_context = "empty";
        items.push(new MenuItem(_("menu_paste"), { action: "paste", shortcut: "Ctrl+V" }));
        items.push(new MenuItem("---", { separator: true }));

        const menu = get_node_menu();
        menu.forEach(([cat, nodes], cat_idx) => {
            const localized_cat = get_localized_category_name(cat, _);
            items.push(new MenuItem(`‣ ${localized_cat}`, { category: true }));
            for (const nd of nodes) {
                items.push(new MenuItem(get_localized_node_name(nd, _), { action: nd.type_id }));
            }
            if (cat_idx < menu.length - 1) items.push(new MenuItem("---", { separator: true }));
        });

        return items;
    }

    _handle_menu_select(item, idx) {
        /** Callback cuando se selecciona un item del menú */
        if (typeof item.action === "number") {
            // Agregar nodo
            this.graph.add_node(item.action, this.menu_world_x, this.menu_world_y);
        } else if (typeof item.action === "string") {
            this._handle_menu_action(item.action);
        }
    }

    // --- Sistema de menú para panel de propiedades ---

    _props_get_menu_items() {
        /** Items del menú de propiedades basados en slots del nodo */
        if (!this.props_open || this.props_node_id === null) return [];

        const node = this.graph.get_node(this.props_node_id);
        if (!node || !node.node_def) return [];

        const nd = node.node_def;
        const items = [];

        if (nd.inputs.length) {
            items.push(new MenuItem(_("props_inputs"), { category: true }));
            nd.inputs.forEach((slot, i) => {
                items.push(new MenuItem(slot.name, {
                    action: ["slot", "in", i],
                    meta: { slot_type: "input", slot_index: i, slot_obj: slot, dtype: slot.dtype },
                }));
            });
        }

        if (nd.outputs.length) {
            items.push(new MenuItem(_("props_outputs"), { category: true }));
            nd.outputs.forEach((slot, i) => {
                items.push(new MenuItem(slot.name, {
                    action: ["slot", "out", i],
                    meta: { slot_type: "output", slot_index: i, slot_obj: slot, dtype: slot.dtype },
                }));
            });
        }

        return items;
    }

    _props_handle_menu_select(item, idx) {
        /** Callback cuando se selecciona un slot en el panel de propiedades */
        if (Array.isArray(item.action) && item.action.length === 3) {
            const [action_type, slot_kind, slot_idx] = item.action;
            if (action_type === "slot") this.props_selected_slot = [slot_kind, slot_idx];
        }
    }

    _props_panel_header_fn(renderer, proj, mx, my, mw, pixel_ratio) {
        /** Header con descripción del nodo en el panel de propiedades */
        if (!this.props_open || this.props_node_id === null) return 0;

        const node = this.graph.get_node(this.props_node_id);
        if (!node || !node.node_def) return 0;

        const nd = node.node_def;
        const pr = pixel_ratio;
        const ts = pr * 1.0;
        const pad = 8 * pr;
        const line_h = 16 * pr;

        // Título
        const title = get_localized_node_name(nd, _);
        const title_h = pr * 16;
        renderer.draw_text(mx + pad, my, title, [1.0, 1.0, 1.0, 1.0], proj, ts * 1.15);

        // Descripción
        const desc = nd.get_description(_) || _("props_no_desc");
        const chars_per_line = Math.max(1, pyInt((mw - pad * 4) / (7 * pr)));
        const lines = NodeEditorView._wrap_text(desc, chars_per_line);

        lines.forEach((line, i) => {
            renderer.draw_text(mx + pad, my + pad + title_h + i * line_h * 0.9,
                               line, [0.82, 0.84, 0.90, 0.8], proj, ts * 0.85);
        });

        return Math.min(80 * pr, (lines.length + 2) * line_h + pad * 2);
    }

    _props_panel_footer_fn(renderer, proj, mx, my, mw, pixel_ratio) {
        /** Footer con detalle del slot seleccionado */
        if (!this.props_open || this.props_node_id === null) return 0;

        const node = this.graph.get_node(this.props_node_id);
        if (!node || !node.node_def) return 0;

        const nd = node.node_def;
        const sel = this.props_selected_slot;
        if (!sel) return 0;

        const [kind, idx] = sel;
        let sel_slot = null;
        if (kind === "in" && idx < nd.inputs.length) sel_slot = nd.inputs[idx];
        else if (kind === "out" && idx < nd.outputs.length) sel_slot = nd.outputs[idx];

        if (!sel_slot) return 0;

        const pr = pixel_ratio;
        const ts = pr * 0.65;
        const pad = 8 * pr;
        const line_h = 16 * pr;

        let y = my + pad + line_h; // empezar debajo del header

        // Separador
        renderer.draw_rect(mx, y, mw, 1 * pr, [0.25, 0.25, 0.35, 0.5], proj);
        y += 2 * pr;

        // Tipo + Componentes
        const [type_str, comp_str] = NodeEditorView._slot_type_info(sel_slot.dtype);
        const slot_title = `${sel_slot.name}  ·  ${type_str}`;
        renderer.draw_text(mx + pad, y, slot_title, [0.95, 0.95, 1.0, 1.0], proj, ts * 1.1);
        y += line_h + pad;

        const comp_label = `${_("props_slot_components")}: ${comp_str}`;
        const dot_col = SLOT_COLORS[sel_slot.dtype] || [0.5, 0.5, 0.5, 1.0];
        renderer.draw_text(mx + pad, y, comp_label, rgb_a(dot_col, 0.85), proj, ts);
        y += line_h + pad;

        // Descripción del slot
        const slot_desc = sel_slot.desc_key ? _(sel_slot.desc_key) : "";
        if (slot_desc) {
            const chars_per_line = Math.max(1, pyInt((mw - pad * 2) / (6 * pr)));
            for (const line of NodeEditorView._wrap_text(slot_desc, chars_per_line)) {
                renderer.draw_text(mx + pad, y, line, [0.75, 0.80, 0.87, 0.9], proj, ts * 0.9);
                y += line_h;
            }
        }

        return Math.min(120 * pr, y - my + pad);
    }

    _props_slot_item_renderer_fn(renderer, proj, item, mx, my, mw, mh, is_hover, pixel_ratio) {
        /** Render custom de items de slots con color y tipo */
        if (!item.meta || !("dtype" in item.meta)) return false;

        const pr = pixel_ratio;
        const pad = 8 * pr;
        const text_scale = pr * 0.85;
        const type_scale = pr * 0.65;

        const dtype = item.meta.dtype;

        // Fondo hover
        if (is_hover) {
            const border_radius = this.theme ? this.theme.integer("menu.border-radius", 8) * pr : 8 * pr;
            const hover_color = this.theme ? this.theme.vec4("menu.hover", [0.28, 0.35, 0.50, 1.0]) : [0.28, 0.35, 0.50, 1.0];
            renderer.draw_rounded_rect(mx + 4, my + 1, mw - 8, mh - 2, border_radius * 0.5, hover_color, proj);
        }

        // Dot de color del tipo
        const dot_col = SLOT_COLORS[dtype] || [0.5, 0.5, 0.5, 1.0];
        const dot_x = mx + pad;
        const dot_y = my + (mh - 6 * pr) / 2;
        renderer.draw_rect(dot_x, dot_y, 6 * pr, 6 * pr, dot_col, proj);

        // Nombre del slot
        const name_x = dot_x + 12 * pr;
        const text_y = renderer.text_centered_y(my, mh, text_scale);
        const fg_color = this.theme ? this.theme.vec4("menu.fg", [0.85, 0.85, 0.90, 1.0]) : [0.85, 0.85, 0.90, 1.0];
        renderer.draw_text(name_x, text_y, item.label, fg_color, proj, text_scale);

        // Tipo (alineado a la derecha)
        const type_str = NodeEditorView._slot_type_info(dtype)[0];
        const [type_w] = renderer.measure_text(type_str, type_scale);
        renderer.draw_text(mx + mw - type_w - pad, text_y, type_str, rgb_a(dot_col, 0.7), proj, type_scale);

        return true;
    }

    _init_props_panel() {
        /** Inicializa el panel de propiedades cuando se abre */
        if (!this.props_open || this.props_node_id === null) return;
        this.props_menu_system.set_viewport(pyInt(this.vp_w), pyInt(this.vp_h), pyInt(this.vp_x), pyInt(this.vp_y));
        this.props_menu_system.open();
        this.props_selected_slot = null;
    }

    // --- Panel de configuración ---

    _panel_handle_click(mx, my) {
        /** Maneja click en el panel. Retorna true si el click fue consumido. */
        const node = this._panel_node();
        if (!node) return false;

        const [px, py, pw, ph] = this._panel_rect();

        // Fuera del panel?
        if (!(px <= mx && mx <= px + pw && py <= my && my <= py + ph)) return false;

        const nd = node.node_def;
        const pr = this._pixel_ratio;
        const row_h = PANEL_ROW_H * pr;
        const header_h = PANEL_HEADER_H * pr;

        // Qué fila?
        const rel_y = my - py - header_h;
        if (rel_y < 0) return true; // click en header, consumir

        const row = pyInt(rel_y / row_h);
        if (row < 0 || row >= nd.params.length) return true;

        // Commit edición anterior
        if (this.panel_edit_idx >= 0 && this.panel_edit_idx !== row) this._panel_commit_edit();

        // Zona del valor (mitad derecha)
        const field_x = px + pw * 0.42;
        const field_w = pw * 0.53;

        if (field_x <= mx && mx <= field_x + field_w) {
            const [pname, , pdefault] = nd.params[row];
            const val = pname in node.params ? node.params[pname] : pdefault;

            // Doble-uso: click inicia slider drag
            this.panel_dragging = row;
            this.panel_drag_start_x = mx;
            this.panel_drag_start_val = Number(val);
            this.panel_edit_idx = -1;
            return true;
        }

        return true;
    }

    _panel_handle_release(mx, my) {
        /** Maneja release en el panel. Distingue click de drag. */
        if (this.panel_dragging < 0) return false;

        const dx = Math.abs(mx - this.panel_drag_start_x);
        const row = this.panel_dragging;
        this.panel_dragging = -1;

        if (dx < 3) {
            // Fue un click, no drag: abrir edición de texto
            const node = this._panel_node();
            if (node) {
                const nd = node.node_def;
                if (nd && row < nd.params.length) {
                    const [pname, , pdefault] = nd.params[row];
                    const val = pname in node.params ? node.params[pname] : pdefault;
                    this.panel_edit_idx = row;
                    this.panel_edit_buf = typeof val === "number" ? pyFormatFixed(val, 4) : String(val);
                }
            }
            return true;
        }
        return true;
    }

    _panel_handle_drag(mx, my) {
        /** Maneja drag en slider del panel. */
        if (this.panel_dragging < 0) return false;

        const node = this._panel_node();
        if (!node) {
            this.panel_dragging = -1;
            return false;
        }

        const nd = node.node_def;
        const row = this.panel_dragging;
        if (row >= nd.params.length) {
            this.panel_dragging = -1;
            return false;
        }

        const [pname] = nd.params[row];
        const dx = mx - this.panel_drag_start_x;

        const sensitivity = 0.005;
        const new_val = this.panel_drag_start_val + dx * sensitivity;
        node.params[pname] = pyRound(new_val, 4);
        this.graph._mark_dirty();
        return true;
    }

    _panel_commit_edit() {
        /** Confirma edición de texto del panel. */
        if (this.panel_edit_idx < 0) return;
        const node = this._panel_node();
        if (node) {
            const nd = node.node_def;
            if (nd && this.panel_edit_idx < nd.params.length) {
                const pname = nd.params[this.panel_edit_idx][0];
                try {
                    node.params[pname] = pyFloat(this.panel_edit_buf);
                    this.graph._mark_dirty();
                } catch (e) {
                    // ValueError: se ignora como en escritorio
                }
            }
        }
        this.panel_edit_idx = -1;
        this.panel_edit_buf = "";
    }

    _panel_handle_key(key, action, mods) {
        /** Maneja teclado cuando se edita un param en el panel. */
        if (this.panel_edit_idx < 0) return false;
        if (action !== 1 && action !== 2) return false;

        if (key === 257 || key === 335) { // ENTER
            this._panel_commit_edit();
            return true;
        }
        if (key === 256) { // ESCAPE
            this.panel_edit_idx = -1;
            this.panel_edit_buf = "";
            return true;
        }
        if (key === 259) { // BACKSPACE
            if (this.panel_edit_buf) this.panel_edit_buf = this.panel_edit_buf.slice(0, -1);
            return true;
        }
        return false;
    }

    _panel_handle_char(codepoint) {
        /** Maneja input de caracter en el panel. */
        if (this.panel_edit_idx < 0) return false;
        const ch = String.fromCodePoint(codepoint);
        if ("0123456789.-+eE".includes(ch)) this.panel_edit_buf += ch;
        return true;
    }

    // --- Fit ---

    _fit_all() {
        if (!this.graph.nodes.length) {
            this.cam_x = 0;
            this.cam_y = 0;
            this.zoom = 1.0;
            return;
        }

        const min_x = Math.min(...this.graph.nodes.map((n) => n.x));
        const min_y = Math.min(...this.graph.nodes.map((n) => n.y));
        const max_x = Math.max(...this.graph.nodes.map((n) => n.x + n.width));
        const max_y = Math.max(...this.graph.nodes.map((n) => n.y + n.height));

        const cx = (min_x + max_x) / 2;
        const cy = (min_y + max_y) / 2;
        const w = max_x - min_x + 100;
        const h = max_y - min_y + 100;

        this.cam_x = cx;
        this.cam_y = cy;

        const zx = this.vp_w / Math.max(w, 1);
        const zy = this.vp_h / Math.max(h, 1);
        this.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.min(zx, zy) * 0.9));
    }

    // --- Render ---

    render(renderer, proj, pixel_ratio) {
        const r = renderer;
        this._pixel_ratio = pixel_ratio;
        const scale = pixel_ratio * 0.7;

        // Ajuste pendiente (el viewport ya tiene el tamaño real aquí)
        if (this._fit_pending) {
            this._fit_pending = false;
            this._fit_all();
        }

        // Actualizar renderer y viewport del menu_system cada frame
        if (this.menu_system.renderer === null) this.menu_system.renderer = renderer;
        this.menu_system.set_pixel_ratio(pixel_ratio);
        this.menu_system.set_viewport(this.vp_w, this.vp_h, this.vp_x, this.vp_y);

        if (this.props_menu_system.renderer === null) this.props_menu_system.renderer = renderer;
        this.props_menu_system.set_pixel_ratio(pixel_ratio);
        this.props_menu_system.set_viewport(this.vp_w, this.vp_h, this.vp_x, this.vp_y);

        // Fondo
        const bg = this._tv4("node.grid-bg", BG_COLOR);
        r.draw_rect(this.vp_x, this.vp_y, this.vp_w, this.vp_h, bg, proj);

        // Grid
        this._render_grid(r, proj);

        // Links
        this._render_all_links(r, proj, pixel_ratio);

        // Link en progreso
        if (this.linking) this._render_temp_link(r, proj, pixel_ratio);

        // Nodos
        for (const node of this.graph.nodes) this._render_node(r, proj, node, pixel_ratio, scale);

        // Panel de configuración
        if (this.panel_open) this._render_panel(r, proj, pixel_ratio);

        // Menú contextual
        this.menu_system.render(proj);

        // Panel de propiedades
        if (this.props_open) {
            this.props_menu_system.set_viewport(pyInt(this.vp_w), pyInt(this.vp_h), pyInt(this.vp_x), pyInt(this.vp_y));
            this.props_menu_system.config.header_fn = (...a) => this._props_panel_header_fn(...a);
            this.props_menu_system.config.footer_fn = (...a) => this._props_panel_footer_fn(...a);
            this.props_menu_system.config.item_renderer_fn = (...a) => this._props_slot_item_renderer_fn(...a);
            this.props_menu_system.render(proj);
        }

        // Tooltips
        this._render_slot_tooltip(r, proj, pixel_ratio);
        this._render_tooltip(r, proj, pixel_ratio);
    }

    _render_grid(r, proj) {
        const step = GRID_SIZE * this.zoom;
        if (step < 8) return;

        const grid_color = this._tv4("node.grid-line", GRID_COLOR);
        const grid_major = this._tv4("node.grid-major", GRID_COLOR_MAJOR);

        const ox = this.vp_x + this.vp_w / 2 - this.cam_x * this.zoom;
        const oy = this.vp_y + this.vp_h / 2 - this.cam_y * this.zoom;

        const start_x = pyMod(ox, step);
        const start_y = pyMod(oy, step);

        let x = this.vp_x + start_x;
        while (x < this.vp_x + this.vp_w) {
            const world_x = (x - ox) / this.zoom;
            const is_major = Math.abs(world_x) < 1 || Math.abs(pyMod(world_x, GRID_SIZE * 5)) < GRID_SIZE * 0.5;
            r.draw_rect(x, this.vp_y, 1, this.vp_h, is_major ? grid_major : grid_color, proj);
            x += step;
        }

        let y = this.vp_y + start_y;
        while (y < this.vp_y + this.vp_h) {
            const world_y = (y - oy) / this.zoom;
            const is_major = Math.abs(world_y) < 1 || Math.abs(pyMod(world_y, GRID_SIZE * 5)) < GRID_SIZE * 0.5;
            r.draw_rect(this.vp_x, y, this.vp_w, 1, is_major ? grid_major : grid_color, proj);
            y += step;
        }
    }

    _render_node(r, proj, node, pixel_ratio, scale) {
        const nd = node.node_def;
        if (!nd) return;

        const [sx, sy] = this.world_to_screen(node.x, node.y);
        const sw = NODE_W * this.zoom;
        const sh = nd.height() * this.zoom;
        const hh = NODE_H_HEADER * this.zoom;
        const slot_h = NODE_H_SLOT * this.zoom;

        // Culling
        if (sx + sw < this.vp_x || sx > this.vp_x + this.vp_w) return;
        if (sy + sh < this.vp_y || sy > this.vp_y + this.vp_h) return;

        // Colores del tema
        const node_radius = this._tint("node.border-radius", 6) * this.zoom;
        let shadow_col = this._tv4("node.shadow", [0.0, 0.0, 0.0, 0.3]);
        shadow_col = [shadow_col[0], shadow_col[1], shadow_col[2], 0.3];
        const sel_col = this._tv4("node.selection", SELECTION_COLOR);

        // Sombra
        const sh_off = 3 * pixel_ratio;
        r.draw_rounded_rect(sx + sh_off, sy + sh_off, sw, sh, node_radius, shadow_col, proj);

        // Cuerpo
        const body_color = [nd.color[0] * 0.7, nd.color[1] * 0.7, nd.color[2] * 0.7, 0.95];
        r.draw_rounded_rect(sx, sy, sw, sh, node_radius, body_color, proj);

        // Header
        r.draw_rounded_rect(sx, sy, sw, hh, node_radius, [...nd.color, 1.0], proj);

        // Selección (o nodo dentro del camino resaltado)
        if (this.selected_node === node.id || this.highlight_nodes.has(node.id)) {
            const t = 2 * pixel_ratio;
            r.draw_rounded_rect(sx - t, sy - t, sw + t * 2, t, node_radius, sel_col, proj);
            r.draw_rounded_rect(sx - t, sy + sh, sw + t * 2, t, node_radius, sel_col, proj);
            r.draw_rect(sx - t, sy, t, sh, sel_col, proj);
            r.draw_rect(sx + sw, sy, t, sh, sel_col, proj);
        }

        // Título
        const text_scale = scale * this.zoom;
        const localized_title = get_localized_node_name(nd, _);
        r.draw_text(sx + 6 * this.zoom, r.text_centered_y(sy, hh, text_scale),
                    localized_title, [1.0, 1.0, 1.0, 1.0], proj, text_scale);

        // Contenido descriptivo del nodo (fila propia debajo de los slots)
        const n_slots = Math.max(nd.inputs.length, nd.outputs.length, 1);
        const desc_y = sy + hh + n_slots * slot_h;
        const content_y = r.text_centered_y(desc_y, NODE_H_DESC * this.zoom, text_scale * 0.8);
        const content_color = [0.9, 0.9, 0.95, 0.8];
        const cx = sx + 8 * this.zoom;
        const cs = text_scale * 0.8;

        if (nd.type_id === 0) { // Output
            r.draw_text(cx, content_y, "fragColor", content_color, proj, cs);
        } else if ([10, 11, 12].includes(nd.type_id)) { // Constantes
            if (nd.params.length) {
                const [pname, , pdefault] = nd.params[0];
                const val = pname in node.params ? node.params[pname] : pdefault;
                const val_str = typeof val === "number" ? pyFormatFixed(val, 2) : String(val);
                r.draw_text(cx, content_y, val_str, content_color, proj, cs);
            }
        } else if ([20, 21, 22, 23, 24].includes(nd.type_id)) { // Operaciones matemáticas
            const ops = { 20: "+", 21: "-", 22: "*", 23: "/" };
            const op = ops[nd.type_id] || "?";
            r.draw_text(cx, content_y, `A ${op} B`, content_color, proj, cs);
        } else if ([40, 41, 42, 43, 44].includes(nd.type_id)) { // Funciones trigonométricas
            const funcs = { 40: "sin", 41: "cos", 42: "abs", 43: "fract", 44: "floor" };
            r.draw_text(cx, content_y, funcs[nd.type_id] || "?", content_color, proj, cs);
        } else if (nd.type_id === 50) {
            r.draw_text(cx, content_y, "length(v)", content_color, proj, cs);
        } else if (nd.type_id === 51) {
            r.draw_text(cx, content_y, "normalize(v)", content_color, proj, cs);
        } else if (nd.type_id === 52) {
            r.draw_text(cx, content_y, "dot(A,B)", content_color, proj, cs);
        } else {
            // Para otros nodos, mostrar el título en minúscula
            r.draw_text(cx, content_y, localized_title.toLowerCase(), content_color, proj, cs);
        }

        // Input slots
        nd.inputs.forEach((slot, i) => {
            const slot_y = sy + hh + i * slot_h + slot_h / 2;
            const slot_x = sx;
            const color = SLOT_COLORS[slot.dtype] || [0.5, 0.5, 0.5, 1.0];

            const sr = NODE_SLOT_RADIUS * this.zoom;
            r.draw_rect(slot_x - sr, slot_y - sr, sr * 2, sr * 2, color, proj);

            r.draw_text(slot_x + sr + 4 * this.zoom,
                        r.text_centered_y(slot_y - slot_h / 2, slot_h, text_scale),
                        slot.name, [0.8, 0.8, 0.85, 1.0], proj, text_scale);
        });

        // Output slots
        nd.outputs.forEach((slot, i) => {
            const slot_y = sy + hh + i * slot_h + slot_h / 2;
            const slot_x = sx + sw;
            const color = SLOT_COLORS[slot.dtype] || [0.5, 0.5, 0.5, 1.0];

            const sr = NODE_SLOT_RADIUS * this.zoom;
            r.draw_rect(slot_x - sr, slot_y - sr, sr * 2, sr * 2, color, proj);

            const name_w = r.measure_text(slot.name, text_scale)[0];
            r.draw_text(slot_x - sr - 4 * this.zoom - name_w,
                        r.text_centered_y(slot_y - slot_h / 2, slot_h, text_scale),
                        slot.name, [0.8, 0.8, 0.85, 1.0], proj, text_scale);
        });
    }

    _render_panel(r, proj, pixel_ratio) {
        const node = this._panel_node();
        if (!node) {
            this.panel_open = false;
            return;
        }

        const nd = node.node_def;
        const pr = pixel_ratio;
        const [px, py, pw, ph] = this._panel_rect();
        const row_h = PANEL_ROW_H * pr;
        const header_h = PANEL_HEADER_H * pr;
        const pad = PANEL_PAD * pr;
        const text_scale = pr * 0.7;

        const total_h = header_h + nd.params.length * row_h + pad;
        const panel_h = Math.min(total_h, ph);

        // Sombra
        r.draw_rect(px - 2 * pr, py, 2 * pr, panel_h, [0.0, 0.0, 0.0, 0.3], proj);
        // Fondo
        r.draw_rect(px, py, pw, panel_h, PANEL_BG, proj);
        // Borde izquierdo
        r.draw_rect(px, py, 1 * pr, panel_h, PANEL_BORDER, proj);

        // Header
        r.draw_rect(px, py, pw, header_h, PANEL_HEADER_BG, proj);
        const localized_title = get_localized_node_name(nd, _);
        r.draw_text(px + pad, r.text_centered_y(py, header_h, text_scale * 1.1),
                    localized_title, [1.0, 1.0, 1.0, 1.0], proj, text_scale * 1.1);

        // Línea bajo header
        r.draw_rect(px, py + header_h - 1 * pr, pw, 1 * pr, PANEL_BORDER, proj);

        // Params
        nd.params.forEach(([pname, , pdefault], i) => {
            const ry = py + header_h + i * row_h;
            const val = pname in node.params ? node.params[pname] : pdefault;
            const is_editing = this.panel_edit_idx === i;
            const is_dragging = this.panel_dragging === i;

            // Fondo alternado
            if (i % 2 === 1) r.draw_rect(px, ry, pw, row_h, [0.14, 0.14, 0.19, 0.5], proj);

            // Highlight si se está editando o arrastrando
            if (is_editing || is_dragging) r.draw_rect(px, ry, pw, row_h, [0.18, 0.22, 0.32, 0.6], proj);

            // Label
            r.draw_text(px + pad, r.text_centered_y(ry, row_h, text_scale), pname, PANEL_LABEL_FG, proj, text_scale);

            // Campo de valor
            const field_x = px + pw * 0.42;
            const field_w = pw * 0.53;
            const field_y = ry + (row_h - 18 * pr) / 2;
            const field_h = 18 * pr;

            r.draw_rect(field_x, field_y, field_w, field_h, is_editing ? PANEL_FIELD_EDIT_BG : PANEL_FIELD_BG, proj);

            // Slider bar (proporción visual 0..1)
            if (!is_editing && typeof val === "number") {
                const frac = Math.max(0.0, Math.min(1.0, val));
                const bar_w = field_w * frac;
                if (bar_w > 0) r.draw_rect(field_x, field_y, bar_w, field_h, PANEL_SLIDER_FG, proj);
            }

            // Texto del valor
            if (is_editing) {
                const display = this.panel_edit_buf + "_";
                r.draw_text(field_x + 4 * pr, r.text_centered_y(field_y, field_h, text_scale),
                            display, [0.9, 1.0, 0.9, 1.0], proj, text_scale);
            } else {
                const val_str = typeof val === "number" ? pyFormatFixed(val, 3) : String(val);
                r.draw_text(field_x + 4 * pr, r.text_centered_y(field_y, field_h, text_scale),
                            val_str, PANEL_VALUE_FG, proj, text_scale);
            }
        });

        // Borde inferior
        const bottom_y = py + header_h + nd.params.length * row_h;
        r.draw_rect(px, bottom_y, pw, 1 * pr, PANEL_BORDER, proj);
    }

    // --- Panel de propiedades ---

    _props_rect_hit(mx, my) {
        const pr = this._pixel_ratio;
        const pw = 300 * pr;
        const px = this.vp_x + (this.vp_w - pw) / 2;
        const ph_max = 400 * pr;
        const py = this.vp_y + this.vp_h - ph_max - 20 * pr;
        return px <= mx && mx <= px + pw && py <= my && my <= py + ph_max;
    }

    static _wrap_text(text, chars_per_line) {
        /** Divide text en líneas de máximo chars_per_line caracteres. */
        if (!text) return [];
        const words = pySplitWs(text);
        const lines = [];
        let cur = "";
        for (const w of words) {
            if (cpLen(cur) + cpLen(w) + 1 <= chars_per_line) {
                cur = pyStrip(cur + " " + w);
            } else {
                if (cur) lines.push(cur);
                cur = w;
            }
        }
        if (cur) lines.push(cur);
        return lines;
    }

    static _slot_type_info(dtype) {
        /** [tipo_str, componentes_str] para un dtype de slot. */
        const info = {
            float: ["float", "1  (escalar)"],
            vec2: ["vec2", "2  (X, Y)"],
            vec3: ["vec3", "3  (X, Y, Z)"],
            vec4: ["vec4", "4  (X, Y, Z, W)"],
        };
        return info[dtype] || [dtype, "?"];
    }

    // --- Tooltip de hover ---

    _render_slot_tooltip(r, proj, pixel_ratio) {
        /** Tooltip al hacer hover sobre un slot de entrada/salida. */
        if (!this._slot_tooltip_visible || this._hover_slot === null) return;
        const [node_id, kind, slot_idx] = this._hover_slot;
        const node = this.graph.get_node(node_id);
        if (!node || !node.node_def) return;
        const nd = node.node_def;
        const slots = kind === "in" ? nd.inputs : nd.outputs;
        if (slot_idx >= slots.length) return;
        const slot = slots[slot_idx];

        const pr = pixel_ratio;
        const ts = pr * 0.65;
        const pad = 8 * pr;
        const line_h = 18 * pr;
        const max_w = 220 * pr;

        const [type_str, comp_str] = NodeEditorView._slot_type_info(slot.dtype);
        const header = `${slot.name}  ·  ${type_str}`;
        const desc = slot.desc_key ? _(slot.desc_key) : "";

        const chars_per_line = Math.max(1, pyInt((max_w - pad * 2) / (6.5 * pr)));
        const desc_lines = desc ? NodeEditorView._wrap_text(desc, chars_per_line) : [];

        const dot_col = SLOT_COLORS[slot.dtype] || [0.5, 0.5, 0.5, 1.0];
        const header_h = 20 * pr;
        const comp_h = line_h;
        const body_h = comp_h + (desc_lines.length ? desc_lines.length * line_h : 0) + pad;
        const tw = max_w;
        const th = header_h + body_h + pad * 0.5;

        const mx = this._slot_tooltip_mx;
        const my = this._slot_tooltip_my;
        let tx = mx + 14 * pr;
        let ty = my - th / 2;
        if (tx + tw > this.vp_x + this.vp_w - 4 * pr) tx = mx - tw - 14 * pr;
        if (ty < this.vp_y + 4 * pr) ty = this.vp_y + 4 * pr;
        if (ty + th > this.vp_y + this.vp_h - 4 * pr) ty = this.vp_y + this.vp_h - th - 4 * pr;

        // Sombra y fondo
        r.draw_rect(tx + 2 * pr, ty + 2 * pr, tw, th, [0, 0, 0, 0.4], proj);
        r.draw_rect(tx, ty, tw, th, [0.10, 0.11, 0.16, 0.96], proj);
        r.draw_rect(tx, ty, tw, header_h, rgb_a(dot_col, 0.6), proj);
        r.draw_rect(tx, ty, tw, 2 * pr, rgb_a(dot_col, 1.0), proj);

        // Nombre · tipo
        r.draw_text(tx + pad, r.text_centered_y(ty, header_h, ts * 1.05),
                    header, [1.0, 1.0, 1.0, 1.0], proj, ts * 1.05);

        // Componentes
        let y = ty + header_h + pad * 0.5;
        r.draw_text(tx + pad, y, `${_("props_slot_components")}: ${comp_str}`,
                    rgb_a(dot_col, 0.85), proj, ts * 0.9);
        y += line_h;

        // Descripción
        for (const line of desc_lines) {
            r.draw_text(tx + pad, y, line, [0.78, 0.82, 0.88, 0.9], proj, ts * 0.9);
            y += line_h;
        }

        // Borde
        const border_col = rgb_a(dot_col, 0.4);
        r.draw_rect(tx, ty, tw, 1 * pr, border_col, proj);
        r.draw_rect(tx, ty, 1 * pr, th, border_col, proj);
        r.draw_rect(tx + tw - pr, ty, 1 * pr, th, border_col, proj);
        r.draw_rect(tx, ty + th - pr, tw, 1 * pr, border_col, proj);
    }

    _render_tooltip(r, proj, pixel_ratio) {
        /** Tooltip flotante al mantener el cursor sobre un nodo. */
        if (!this._tooltip_visible || this._hover_node_id === null) return;
        // No mostrar tooltip de nodo si ya se muestra el de slot
        if (this._slot_tooltip_visible) return;
        const node = this.graph.get_node(this._hover_node_id);
        if (!node) return;
        const nd = node.node_def;
        if (!nd || !nd.desc_key) return;

        const pr = pixel_ratio;
        const ts = pr * 0.65;
        const pad = 8 * pr;
        const line_h = 18 * pr;
        const max_w = 240 * pr;

        const title = get_localized_node_name(nd, _);
        const desc = nd.get_description(_);
        if (!desc) return;

        const chars_per_line = Math.max(1, pyInt((max_w - pad * 2) / (6.5 * pr)));
        const lines = NodeEditorView._wrap_text(desc, chars_per_line);

        const title_h = 20 * pr;
        const body_h = lines.length * line_h + pad;
        const tw = max_w;
        const th = title_h + body_h + pad;

        let tx = this._tooltip_mx + 14 * pr;
        let ty = this._tooltip_my - th / 2;
        if (tx + tw > this.vp_x + this.vp_w - 4 * pr) tx = this._tooltip_mx - tw - 14 * pr;
        if (ty < this.vp_y + 4 * pr) ty = this.vp_y + 4 * pr;
        if (ty + th > this.vp_y + this.vp_h - 4 * pr) ty = this.vp_y + this.vp_h - th - 4 * pr;

        // Sombra y fondo
        r.draw_rect(tx + 2 * pr, ty + 2 * pr, tw, th, [0, 0, 0, 0.4], proj);
        r.draw_rect(tx, ty, tw, th, [0.10, 0.11, 0.16, 0.96], proj);
        r.draw_rect(tx, ty, tw, title_h, [...nd.color, 0.75], proj);
        r.draw_rect(tx, ty, tw, 2 * pr, [...nd.color, 1.0], proj);

        // Título
        r.draw_text(tx + pad, r.text_centered_y(ty, title_h, ts * 1.05),
                    title, [1.0, 1.0, 1.0, 1.0], proj, ts * 1.05);

        // Descripción
        lines.forEach((line, i) => {
            r.draw_text(tx + pad, ty + title_h + pad * 0.5 + i * line_h,
                        line, [0.80, 0.83, 0.88, 0.95], proj, ts);
        });

        // Borde
        const border_col = [0.3, 0.3, 0.45, 0.6];
        r.draw_rect(tx, ty, tw, 1 * pr, border_col, proj);
        r.draw_rect(tx, ty, 1 * pr, th, border_col, proj);
        r.draw_rect(tx + tw - pr, ty, 1 * pr, th, border_col, proj);
        r.draw_rect(tx, ty + th - pr, tw, 1 * pr, border_col, proj);
    }

    _render_all_links(r, proj, pixel_ratio) {
        /** Calcula rutas ortogonales separando carriles paralelos. */
        if (!this.graph.links.length) return;

        const SNAP = 4.0;
        const LANE_W = LINK_THICKNESS * 2.8; // separación entre carriles (mundo)

        // ── Paso 1: calcular rutas brutas ──
        const all_routes = []; // [link, pts | null]
        for (const link of this.graph.links) {
            const fn = this.graph.get_node(link.from_node);
            const tn = this.graph.get_node(link.to_node);
            if (!fn || !tn) {
                all_routes.push([link, null]);
                continue;
            }
            const [fx, fy] = fn.output_slot_pos(link.from_slot);
            const [tx, ty] = tn.input_slot_pos(link.to_slot);
            const rects = this._get_node_rects(link.from_node, link.to_node);
            all_routes.push([link, this._route_link(fx, fy, tx, ty, rects)]);
        }

        // ── Paso 2: agrupar por puerto compartido y asignar carril ──
        const out_groups = new Map(); // "from_node,from_slot" -> [ri]
        const in_groups = new Map();  // "to_node,to_slot" -> [ri]
        all_routes.forEach(([link, pts], ri) => {
            if (pts === null) return;
            const ok = `${link.from_node},${link.from_slot}`;
            const ik = `${link.to_node},${link.to_slot}`;
            if (!out_groups.has(ok)) out_groups.set(ok, []);
            if (!in_groups.has(ik)) in_groups.set(ik, []);
            out_groups.get(ok).push(ri);
            in_groups.get(ik).push(ri);
        });

        const lane_x = new Map(); // ri -> offset X del segmento vertical

        const assign_lanes = (group_ris, sort_by_dest = true) => {
            const n = group_ris.length;
            if (n <= 1) return;
            const key = (ri) => {
                const pts = all_routes[ri][1];
                if (pts === null) return 0.0;
                return sort_by_dest ? pts[pts.length - 1][1] : pts[0][1];
            };
            const sorted = [...group_ris].sort((a, b) => key(a) - key(b));
            sorted.forEach((ri, lane_i) => {
                lane_x.set(ri, (lane_i - (n - 1) / 2.0) * LANE_W);
            });
        };

        for (const g of out_groups.values()) assign_lanes(g, true);
        for (const g of in_groups.values()) assign_lanes(g, false);

        // ── Paso 3: separación entre cables que NO comparten puerto ──
        const snap_x = (pts) => (pts && pts.length >= 3 ? pts[1][0] : null);

        const vert_groups = new Map();
        all_routes.forEach(([link, pts], ri) => {
            if (pts === null) return;
            const vx = snap_x(pts);
            if (vx === null) return;
            const key = pyRoundInt(vx / SNAP) * SNAP;
            if (!vert_groups.has(key)) vert_groups.set(key, []);
            vert_groups.get(key).push(ri);
        });

        for (const group_ris of vert_groups.values()) {
            const free = group_ris.filter((ri) => !lane_x.has(ri));
            if (!free.length) continue;
            const fixed_offsets = new Set(group_ris.filter((ri) => lane_x.has(ri)).map((ri) => lane_x.get(ri)));
            const total = group_ris.length;
            let lane_i = 0;
            const sorted_free = [...free].sort((a, b) => {
                const la = all_routes[a][0], lb = all_routes[b][0];
                return (la.from_node - lb.from_node) || (la.from_slot - lb.from_slot);
            });
            for (const ri of sorted_free) {
                let off = (lane_i - (total - 1) / 2.0) * LANE_W;
                while (fixed_offsets.has(off)) {
                    lane_i += 1;
                    off = (lane_i - (total - 1) / 2.0) * LANE_W;
                }
                lane_x.set(ri, off);
                fixed_offsets.add(off);
                lane_i += 1;
            }
        }

        // ── Paso 4: reconstruir waypoints aplicando lane_x ──
        const apply_lane = (pts, ri) => {
            const off = lane_x.has(ri) ? lane_x.get(ri) : 0.0;
            if (off === 0.0 || pts.length < 3) return pts;
            const x_start = pts[0][0];
            const x_end = pts[pts.length - 1][0];
            let first_turn = null;
            for (let i = 1; i < pts.length; i++) {
                if (Math.abs(pts[i][0] - x_start) > SNAP) {
                    first_turn = i;
                    break;
                }
            }
            let last_turn = null;
            for (let i = pts.length - 2; i > -1; i--) {
                if (Math.abs(pts[i][0] - x_end) > SNAP) {
                    last_turn = i;
                    break;
                }
            }
            if (first_turn === null || last_turn === null) return pts;
            const new_pts = pts.map((p) => [p[0], p[1]]);
            for (let i = first_turn; i <= last_turn; i++) new_pts[i] = [pts[i][0] + off, pts[i][1]];
            return new_pts;
        };

        // ── Paso 5: renderizar ──
        all_routes.forEach(([link, pts], ri) => {
            if (pts === null) return;

            const fn = this.graph.get_node(link.from_node);
            const fnd = fn ? fn.node_def : null;
            let color;
            if (fnd && link.from_slot < fnd.outputs.length) {
                color = SLOT_COLORS[fnd.outputs[link.from_slot].dtype] || [0.5, 0.5, 0.5, 1.0];
            } else {
                color = [0.5, 0.5, 0.5, 1.0];
            }

            let thickness = LINK_THICKNESS * pixel_ratio;
            if (this.selected_link === link) {
                color = SELECTION_COLOR;
                thickness *= 1.8;
            } else if (this.highlight_links.has(link)) {
                color = SELECTION_COLOR;
            }

            const final_pts = apply_lane(pts, ri);
            const screen_pts = final_pts.map(([wx, wy]) => this.world_to_screen(wx, wy));

            this._draw_routed_link(r, proj, screen_pts, [0.0, 0.0, 0.0, 0.3], thickness * 1.2);
            this._draw_routed_link(r, proj, screen_pts, color, thickness);
        });
    }

    _render_link(r, proj, link, pixel_ratio) {
        /** Renderiza un único enlace (usado externamente si hace falta). */
        const from_node = this.graph.get_node(link.from_node);
        const to_node = this.graph.get_node(link.to_node);
        if (!from_node || !to_node) return;

        const [fx, fy] = from_node.output_slot_pos(link.from_slot);
        const [tx, ty] = to_node.input_slot_pos(link.to_slot);

        const fnd = from_node.node_def;
        let color;
        if (fnd && link.from_slot < fnd.outputs.length) {
            color = SLOT_COLORS[fnd.outputs[link.from_slot].dtype] || [0.5, 0.5, 0.5, 1.0];
        } else {
            color = [0.5, 0.5, 0.5, 1.0];
        }

        let thickness = LINK_THICKNESS * pixel_ratio;
        if (this.selected_link === link) {
            color = SELECTION_COLOR;
            thickness *= 1.8;
        }

        const node_rects = this._get_node_rects(link.from_node, link.to_node);
        const world_pts = this._route_link(fx, fy, tx, ty, node_rects);
        const screen_pts = world_pts.map(([wx, wy]) => this.world_to_screen(wx, wy));

        this._draw_routed_link(r, proj, screen_pts, [0.0, 0.0, 0.0, 0.3], thickness * 1.2);
        this._draw_routed_link(r, proj, screen_pts, color, thickness);
    }

    _render_temp_link(r, proj, pixel_ratio) {
        const node = this.graph.get_node(this.link_from_node);
        if (!node) return;

        const [wx, wy] = this.link_is_output
            ? node.output_slot_pos(this.link_from_slot)
            : node.input_slot_pos(this.link_from_slot);

        const [sx0, sy0] = this.world_to_screen(wx, wy);

        if (this.link_is_output) {
            this._draw_bezier_link(r, proj, sx0, sy0, this.link_end_x, this.link_end_y,
                                   [0.0, 0.0, 0.0, 0.2], LINK_THICKNESS * pixel_ratio * 1.2);
            this._draw_bezier_link(r, proj, sx0, sy0, this.link_end_x, this.link_end_y,
                                   [1.0, 1.0, 1.0, 0.6], LINK_THICKNESS * pixel_ratio);
        } else {
            this._draw_bezier_link(r, proj, this.link_end_x, this.link_end_y, sx0, sy0,
                                   [0.0, 0.0, 0.0, 0.2], LINK_THICKNESS * pixel_ratio * 1.2);
            this._draw_bezier_link(r, proj, this.link_end_x, this.link_end_y, sx0, sy0,
                                   [1.0, 1.0, 1.0, 0.6], LINK_THICKNESS * pixel_ratio);
        }
    }

    // --- Enrutamiento de enlaces ---

    _get_node_rects(exclude_from = null, exclude_to = null) {
        /** [x, y, w, h] en coordenadas mundo para todos los nodos (con margen). */
        const margin = 12;
        const rects = [];
        for (const node of this.graph.nodes) {
            // Python: "if exclude_from and node.id == exclude_from" (id 0 no se excluye)
            if (exclude_from && node.id === exclude_from) continue;
            if (exclude_to && node.id === exclude_to) continue;
            rects.push([node.x - margin, node.y - margin, node.width + margin * 2, node.height + margin * 2]);
        }
        return rects;
    }

    static _rect_intersects_segment(rx, ry, rw, rh, ax, ay, bx, by) {
        /** true si el segmento AB intersecta el rectángulo. */
        if (rx <= ax && ax <= rx + rw && ry <= ay && ay <= ry + rh) return true;
        if (rx <= bx && bx <= rx + rw && ry <= by && by <= ry + rh) return true;
        // Cohen-Sutherland simplificado
        const outcode = (x, y) => {
            let code = 0;
            if (x < rx) code |= 1;
            else if (x > rx + rw) code |= 2;
            if (y < ry) code |= 4;
            else if (y > ry + rh) code |= 8;
            return code;
        };
        let c0 = outcode(ax, ay), c1 = outcode(bx, by);
        for (;;) {
            if (!(c0 | c1)) return true;
            if (c0 & c1) return false;
            const c = c0 ? c0 : c1;
            const dx = bx - ax, dy = by - ay;
            let x, y;
            if (c & 8) {
                x = dy ? ax + dx * (ry + rh - ay) / dy : ax;
                y = ry + rh;
            } else if (c & 4) {
                x = dy ? ax + dx * (ry - ay) / dy : ax;
                y = ry;
            } else if (c & 2) {
                y = dx ? ay + dy * (rx + rw - ax) / dx : ay;
                x = rx + rw;
            } else {
                y = dx ? ay + dy * (rx - ax) / dx : ay;
                x = rx;
            }
            if (c === c0) {
                ax = x; ay = y; c0 = outcode(x, y);
            } else {
                bx = x; by = y; c1 = outcode(x, y);
            }
        }
    }

    _route_link(x0, y0, x1, y1, node_rects) {
        /** Waypoints ortogonales (mundo) de (x0,y0) a (x1,y1) evitando nodos. */
        const GAP = 30;

        const segments_clear = (pts) => {
            for (let i = 0; i < pts.length - 1; i++) {
                const [ax, ay] = pts[i];
                const [bx, by] = pts[i + 1];
                for (const [rx, ry, rw, rh] of node_rects) {
                    if (NodeEditorView._rect_intersects_segment(rx, ry, rw, rh, ax, ay, bx, by)) return false;
                }
            }
            return true;
        };

        const EXIT_MIN = GAP;
        const ENTER_MIN = GAP;

        const exit_x_base = x0 + EXIT_MIN;
        const enter_x_base = x1 - ENTER_MIN;

        const mid_x = (exit_x_base + enter_x_base) / 2;

        const base_route = enter_x_base > exit_x_base
            ? [[x0, y0], [mid_x, y0], [mid_x, y1], [x1, y1]]
            : null; // Cable hacia atrás: hacen falta 5 segmentos

        if (base_route && segments_clear(base_route)) return base_route;

        // Intentar desplazar mid_x para evitar nodos
        const candidates = new Set();
        for (const [rx, , rw] of node_rects) {
            candidates.add(rx - GAP);
            candidates.add(rx + rw + GAP);
        }
        if (enter_x_base > exit_x_base) {
            for (const frac of [0.1, 0.25, 0.5, 0.75, 0.9]) {
                candidates.add(exit_x_base + (enter_x_base - exit_x_base) * frac);
            }
        }
        for (const off of [GAP, GAP * 2, GAP * 3, -GAP, -GAP * 2]) {
            candidates.add(x0 + off);
            candidates.add(x1 + off);
        }

        let best = null;
        let best_cost = Infinity;
        const ref_mid = (exit_x_base + enter_x_base) / 2;
        for (const mx of [...candidates].sort((a, b) => a - b)) {
            if (mx < exit_x_base || mx > enter_x_base) continue;
            const route = [[x0, y0], [mx, y0], [mx, y1], [x1, y1]];
            if (segments_clear(route)) {
                const cost = Math.abs(mx - ref_mid);
                if (cost < best_cost) {
                    best_cost = cost;
                    best = route;
                }
            }
        }

        if (best) return best;

        // Ruta de 5 segmentos: H → V parcial → H bypass → V parcial → H
        // PySet: mismo orden que set() de Python (los empates del sort dependen de él)
        const y_candidates = new PySet();
        for (const [, ry, , rh] of node_rects) {
            y_candidates.add(ry - GAP);
            y_candidates.add(ry + rh + GAP);
        }
        y_candidates.add(y0);
        y_candidates.add(y1);
        y_candidates.add((y0 + y1) / 2);

        const mid_y = (y0 + y1) / 2;
        const keyed = [...y_candidates].map((y) => [Math.abs(y - mid_y), y]);
        keyed.sort((a, b) => a[0] - b[0]);
        for (const [, bypass_y] of keyed) {
            const route5 = [
                [x0, y0],
                [exit_x_base, y0],
                [exit_x_base, bypass_y],
                [enter_x_base, bypass_y],
                [enter_x_base, y1],
                [x1, y1],
            ];
            if (segments_clear(route5)) return route5;
        }

        // Sin ruta limpia → fallback que respeta la dirección de los puertos
        const fallback = [
            [x0, y0],
            [exit_x_base, y0],
            [exit_x_base, (y0 + y1) / 2],
            [enter_x_base, (y0 + y1) / 2],
            [enter_x_base, y1],
            [x1, y1],
        ];
        if (base_route !== null) return base_route;
        return fallback;
    }

    _draw_routed_link(r, proj, waypoints, color, thickness) {
        /** Polilínea ortogonal con esquinas redondeadas (coords de pantalla). */
        if (waypoints.length < 2) return;

        const CORNER_R = Math.min(thickness * 4, 10.0 * this._pixel_ratio); // radio de curva en esquinas

        // Expandir waypoints a puntos de curva (insertar puntos de tangencia)
        const pts = [];
        const n = waypoints.length;
        waypoints.forEach(([wx, wy], i) => {
            if (i === 0 || i === n - 1) {
                pts.push([wx, wy]);
            } else {
                const [px, py] = waypoints[i - 1];
                const [nx, ny] = waypoints[i + 1];
                const d0x = wx - px, d0y = wy - py;
                const d1x = nx - wx, d1y = ny - wy;
                const l0 = Math.sqrt(d0x * d0x + d0y * d0y);
                const l1 = Math.sqrt(d1x * d1x + d1y * d1y);
                if (l0 < 0.001 || l1 < 0.001) {
                    pts.push([wx, wy]);
                    return;
                }
                const r0 = Math.min(CORNER_R, l0 / 2);
                const r1 = Math.min(CORNER_R, l1 / 2);
                pts.push([wx - d0x / l0 * r0, wy - d0y / l0 * r0]);
                pts.push([wx, wy]);
                pts.push([wx + d1x / l1 * r1, wy + d1y / l1 * r1]);
            }
        });

        if (pts.length < 2) return;

        const in_waypoints = (p) => waypoints.some((w) => w[0] === p[0] && w[1] === p[1]);

        // Generar puntos finales con curvas bezier en esquinas
        const curve_pts = [];
        let i = 0;
        while (i < pts.length) {
            if (i + 2 < pts.length && i > 0 && !in_waypoints(pts[i])) {
                // Bezier cuadrático: antes → esquina → después
                const p0 = pts[i], p1 = pts[i + 1], p2 = pts[i + 2];
                const segs = 8;
                for (let j = 0; j <= segs; j++) {
                    const t = j / segs;
                    const mt = 1 - t;
                    curve_pts.push([
                        mt * mt * p0[0] + 2 * mt * t * p1[0] + t * t * p2[0],
                        mt * mt * p0[1] + 2 * mt * t * p1[1] + t * t * p2[1],
                    ]);
                }
                i += 3;
            } else {
                curve_pts.push(pts[i]);
                i += 1;
            }
        }

        if (curve_pts.length < 2) return;

        this._draw_polyline(r, proj, curve_pts, color, thickness);
    }

    _draw_polyline(r, proj, points, color, thickness) {
        /** Quads orientados a lo largo de la línea + caps redondeados (igual que escritorio). */
        const hw = thickness / 2;

        const normals = [];
        for (let i = 0; i < points.length; i++) {
            let nx = 0.0, ny = 0.0;
            if (i > 0) {
                const sdx = points[i][0] - points[i - 1][0];
                const sdy = points[i][1] - points[i - 1][1];
                const sl = Math.sqrt(sdx * sdx + sdy * sdy);
                if (sl > 0.001) {
                    nx += -sdy / sl;
                    ny += sdx / sl;
                }
            }
            if (i < points.length - 1) {
                const sdx = points[i + 1][0] - points[i][0];
                const sdy = points[i + 1][1] - points[i][1];
                const sl = Math.sqrt(sdx * sdx + sdy * sdy);
                if (sl > 0.001) {
                    nx += -sdy / sl;
                    ny += sdx / sl;
                }
            }
            const nl = Math.sqrt(nx * nx + ny * ny);
            if (nl > 0.001) {
                nx /= nl;
                ny /= nl;
            } else {
                nx = 0.0;
                ny = 1.0;
            }
            normals.push([nx, ny]);
        }

        r.begin_rects();
        for (let i = 0; i < points.length - 1; i++) {
            const [px, py] = points[i];
            const [qx, qy] = points[i + 1];
            const [n0x, n0y] = normals[i];
            const [n1x, n1y] = normals[i + 1];
            r.batch_quad(
                px + n0x * hw, py + n0y * hw,
                px - n0x * hw, py - n0y * hw,
                qx + n1x * hw, qy + n1y * hw,
                qx - n1x * hw, qy - n1y * hw,
                color,
            );
        }

        // Caps redondeados
        const cap_segs = 6;
        for (const [end_idx, direction] of [[0, -1], [points.length - 1, 1]]) {
            const [ex, ey] = points[end_idx];
            const [enx, eny] = normals[end_idx];
            const base_angle = Math.atan2(eny * direction, enx * direction);
            for (let j = 0; j < cap_segs; j++) {
                const a0 = base_angle + Math.PI * j / cap_segs - Math.PI / 2;
                const a1 = base_angle + Math.PI * (j + 1) / cap_segs - Math.PI / 2;
                r.batch_tri(
                    ex, ey,
                    ex + Math.cos(a0) * hw, ey + Math.sin(a0) * hw,
                    ex + Math.cos(a1) * hw, ey + Math.sin(a1) * hw,
                    color,
                );
            }
        }
        r.flush_rects(proj);
    }

    _draw_bezier_link(r, proj, x0, y0, x1, y1, color, thickness) {
        /** Curva Bezier con quads orientados. */
        const raw_dx = x1 - x0;
        let dx;
        if (raw_dx >= 0) {
            dx = Math.max(raw_dx * LINK_CURVATURE, 60);
        } else {
            const gap = Math.abs(raw_dx);
            const dy = Math.abs(y1 - y0);
            dx = Math.max(gap * 0.5 + dy * 0.3, 120);
        }

        const segments = Math.max(16, pyInt((Math.abs(raw_dx) + Math.abs(y1 - y0)) / 6));

        const cp1x = x0 + dx, cp1y = y0;
        const cp2x = x1 - dx, cp2y = y1;

        const points = [];
        for (let i = 0; i <= segments; i++) {
            const t = i / segments;
            const t2 = t * t, t3 = t2 * t;
            const mt = 1 - t;
            const mt2 = mt * mt, mt3 = mt2 * mt;
            points.push([
                mt3 * x0 + 3 * mt2 * t * cp1x + 3 * mt * t2 * cp2x + t3 * x1,
                mt3 * y0 + 3 * mt2 * t * cp1y + 3 * mt * t2 * cp2y + t3 * y1,
            ]);
        }

        if (points.length < 2) return;
        this._draw_polyline(r, proj, points, color, thickness);
    }

    // --- Link selection & actions ---

    _hit_link(wx, wy) {
        /** LinkInstance bajo el punto (mundo), o null. */
        const hit_world = (LINK_THICKNESS * 4) / this.zoom;

        for (const link of [...this.graph.links].reverse()) {
            const from_node = this.graph.get_node(link.from_node);
            const to_node = this.graph.get_node(link.to_node);
            if (!from_node || !to_node) continue;

            const [fx, fy] = from_node.output_slot_pos(link.from_slot);
            const [tx, ty] = to_node.input_slot_pos(link.to_slot);

            const node_rects = this._get_node_rects(link.from_node, link.to_node);
            const waypoints = this._route_link(fx, fy, tx, ty, node_rects);

            for (let i = 0; i < waypoints.length - 1; i++) {
                const [ax, ay] = waypoints[i];
                const [bx, by] = waypoints[i + 1];
                if (this._point_to_line_distance(wx, wy, ax, ay, bx, by) <= hit_world) return link;
            }
        }
        return null;
    }

    _point_to_line_distance(px, py, x0, y0, x1, y1) {
        const dx = x1 - x0, dy = y1 - y0;
        if (dx === 0 && dy === 0) return Math.sqrt((px - x0) ** 2 + (py - y0) ** 2);
        const t = Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / (dx * dx + dy * dy)));
        const cx = x0 + t * dx, cy = y0 + t * dy;
        return Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
    }

    _handle_menu_action(action) {
        /** Acciones del menú contextual. */
        if (action === "duplicate") {
            if (this.selected_node !== null) {
                const node = this.graph.get_node(this.selected_node);
                if (node) {
                    const new_node = this.graph.add_node(node.type_id, node.x + 40, node.y + 40);
                    new_node.params = { ...node.params };
                    this.selected_node = new_node.id;
                }
            }

        } else if (action === "duplicate_nearby") {
            if (this.selected_node !== null) {
                const node = this.graph.get_node(this.selected_node);
                if (node) {
                    const new_node = this.graph.add_node(node.type_id, node.x + 100, node.y + 100);
                    new_node.params = { ...node.params };
                    this.selected_node = new_node.id;
                }
            }

        } else if (action === "copy") {
            if (this.selected_node !== null && this.clipboard_set) {
                const node = this.graph.get_node(this.selected_node);
                if (node) {
                    this.clipboard_set(node_clipboard_json(node.to_tuple()));
                }
            }

        } else if (action === "focus") {
            if (this.selected_node !== null) {
                const node = this.graph.get_node(this.selected_node);
                if (node) {
                    this.cam_x = node.x + NODE_W / 2;
                    this.cam_y = node.y + 50;
                    this.zoom = 1.0;
                }
            }

        } else if (action === "properties") {
            if (this.selected_node !== null) {
                this.props_node_id = this.selected_node;
                this.props_open = true;
                this._init_props_panel();
            }

        } else if (action === "delete") {
            if (this.selected_node !== null) {
                this.graph.remove_node(this.selected_node);
                this.selected_node = null;
            }

        } else if (action === "link_delete") {
            if (this.selected_link !== null) {
                this.graph.remove_link(this.selected_link);
                this.selected_link = null;
            }

        } else if (action === "link_origin") {
            if (this.selected_link !== null) {
                const from_node = this.graph.get_node(this.selected_link.from_node);
                if (from_node) {
                    this.selected_node = from_node.id;
                    this.cam_x = from_node.x + NODE_W / 2;
                    this.cam_y = from_node.y + 50;
                    this.zoom = 1.0;
                }
            }

        } else if (action === "link_end") {
            if (this.selected_link !== null) {
                const to_node = this.graph.get_node(this.selected_link.to_node);
                if (to_node) {
                    this.selected_node = to_node.id;
                    this.cam_x = to_node.x + NODE_W / 2;
                    this.cam_y = to_node.y + 50;
                    this.zoom = 1.0;
                }
            }

        } else if (action === "link_highlight") {
            if (this.selected_link !== null) this._highlight_path(this.selected_link);

        } else if (action === "paste") {
            // Menú: donde se abrió el menú contextual. El navegador solo deja
            // leer el portapapeles de forma asíncrona.
            const wx = this.menu_world_x, wy = this.menu_world_y;
            if (this.clipboard_read_async) {
                this.clipboard_read_async().then((text) => this._paste_node(text, wx, wy));
            }

        } else if (action === "paste_mouse") {
            // Ctrl+V: en el mouse, o en el centro si el mouse está fuera
            let wx, wy;
            if (this._mouse_in_viewport()) {
                [wx, wy] = this.screen_to_world(this._mouse_x, this._mouse_y);
            } else {
                [wx, wy] = this.screen_to_world(this.vp_x + this.vp_w / 2, this.vp_y + this.vp_h / 2);
            }
            if (this.clipboard_get) this._paste_node(this.clipboard_get(), wx, wy);
        }
    }

    _paste_node(text, wx, wy) {
        /** Crea un nodo nuevo desde el JSON del portapapeles: ID nuevo, mismos parámetros, sin links. */
        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            return;
        }
        if (!data || typeof data !== "object" || Array.isArray(data) || data.type !== "node") return;
        const t = data.node;
        if (!Array.isArray(t) || t.length < 2) return;
        const type_id = typeof t[1] === "number" ? Math.trunc(t[1]) : Number.parseInt(t[1], 10);
        if (!Number.isFinite(type_id)) return;
        const nd = NODE_REGISTRY.get(type_id);
        if (!nd) return;
        const node = this.graph.add_node(type_id, wx, wy);
        const configs = t.length > 4 && Array.isArray(t[4]) ? t[4] : [];
        for (const cfg of configs) {
            if (!Array.isArray(cfg) || cfg.length < 2) continue;
            const idx = Math.trunc(Number(cfg[0]));
            const val = Number(cfg[1]);
            if (!Number.isFinite(idx) || Number.isNaN(val)) continue;
            if (idx >= 0 && idx < nd.params.length) node.params[nd.params[idx][0]] = val;
        }
        this.selected_node = node.id;
        this.selected_link = null;
    }

    _highlight_path(link) {
        /** Resalta el camino completo del link: hacia atrás hasta las entradas
         *  y hacia adelante hasta Output. */
        const links = new Set([link]);

        const up_seen = new Set([link.from_node]);
        let stack = [link.from_node];
        while (stack.length) {
            const nid = stack.pop();
            for (const l of this.graph.links) {
                if (l.to_node === nid) {
                    links.add(l);
                    if (!up_seen.has(l.from_node)) {
                        up_seen.add(l.from_node);
                        stack.push(l.from_node);
                    }
                }
            }
        }

        const down_seen = new Set([link.to_node]);
        stack = [link.to_node];
        while (stack.length) {
            const nid = stack.pop();
            for (const l of this.graph.links) {
                if (l.from_node === nid) {
                    links.add(l);
                    if (!down_seen.has(l.to_node)) {
                        down_seen.add(l.to_node);
                        stack.push(l.to_node);
                    }
                }
            }
        }

        this.highlight_links = links;
        this.highlight_nodes = new Set([...up_seen, ...down_seen]);
    }

    _clear_highlight() {
        this.highlight_links = new Set();
        this.highlight_nodes = new Set();
    }
}

/** json.dumps({'type': 'node', 'node': node.to_tuple()}) de Python, byte a
 *  byte: enteros sin decimales y valores de parámetros como float ("2.0"),
 *  así el portapapeles es compatible entre escritorio y web. */
export function node_clipboard_json(t) {
    const pyjson_float = (v) => {
        if (Number.isNaN(v)) return "NaN";
        if (v === Infinity) return "Infinity";
        if (v === -Infinity) return "-Infinity";
        return pyFloatRepr(v);
    };
    const configs = (t[4] || []).map(([i, v]) => `[${i}, ${pyjson_float(v)}]`).join(", ");
    return `{"type": "node", "node": [${t[0]}, ${t[1]}, ${t[2]}, ${t[3]}, [${configs}]]}`;
}

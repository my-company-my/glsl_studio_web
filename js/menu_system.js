/**
 * Sistema unificado y configurable de menús para GLSL Studio.
 * Port de menu_system.py.
 */

import * as glfw from "./glfw.js";
import { pyInt } from "./pyutil.js";

export class MenuItem {
    /** Descriptor de un item de menú */
    constructor(label, {
        action = null, shortcut = null, disabled = false, category = false, separator = false, meta = null,
    } = {}) {
        this.label = label;
        this.action = action;     // función, número (type_id), string (comando) o null
        this.shortcut = shortcut;
        this.disabled = disabled;
        this.category = category;
        this.separator = separator;
        this.meta = meta;         // datos extra (color, tipo, etc.)
    }
}

export class MenuConfig {
    /** Configuración de comportamiento y estilo de menú */
    constructor(opts = {}) {
        this.item_height = 24;
        this.width = 220;
        this.padding = 4;
        this.title_height = null;   // null = sin título
        this.title = null;
        this.has_overlay = false;   // fondo oscuro semi-transparente
        this.overlay_color = [0.0, 0.0, 0.0, 0.45];
        this.theme_prefix = "menu"; // ej "picker" o "menu"
        this.max_visible_height_ratio = 0.8;
        this.marker_fn = null;      // (idx, hover_idx) -> str
        this.centered = true;       // true = centrar, false = en el anchor
        // --- Extensiones de panel ---
        this.header_fn = null;      // (renderer, proj, mx, my, mw, pixel_ratio) -> altura
        this.header_height = 0;
        this.footer_fn = null;
        this.footer_height = 0;
        this.item_renderer_fn = null; // (renderer, proj, item, x, y, w, h, is_hover, pixel_ratio) -> bool
        this.anchor_bottom = false;
        this.anchor_bottom_margin = 16;
        Object.assign(this, opts);
    }
}

export class MenuSystem {
    /** Sistema de menú unificado y configurable */

    constructor({ config, renderer, theme, items_provider = null, on_select = null, pixel_ratio = 1.0 }) {
        this.config = config;
        this.renderer = renderer;
        this.theme = theme;
        this.items_provider = items_provider;
        this.on_select = on_select;
        this.pixel_ratio = pixel_ratio;

        // Estado
        this._open = false;
        this._items = [];
        this._hover_idx = -1;
        this._nav_idx = -1;
        this._scroll = 0;
        this._viewport_width = 1280;
        this._viewport_height = 720;
        this._vp_offset_x = 0;
        this._vp_offset_y = 0;
        this._anchor_x = 0.0;
        this._anchor_y = 0.0;
    }

    // ==================== API Pública ====================

    open() {
        /** Abre el menú (centrado o en última posición anchor) */
        this._open = true;
        this._update_items();
        this._hover_idx = this._first_selectable();
        this._scroll = 0;
        this._nav_idx = -1;
    }

    open_at(x, y) {
        /** Abre el menú en una posición específica (para menús contextuales) */
        this._anchor_x = x;
        this._anchor_y = y;
        this.open();
    }

    close() {
        this._open = false;
    }

    is_open() {
        return this._open;
    }

    set_viewport(width, height, offset_x = 0, offset_y = 0) {
        /** Actualiza el área disponible para el menú */
        this._viewport_width = width;
        this._viewport_height = height;
        this._vp_offset_x = offset_x;
        this._vp_offset_y = offset_y;
    }

    set_items(items) {
        this._items = items;
        this._scroll = 0;
        this._hover_idx = this._first_selectable();
    }

    set_hover(idx) {
        if (idx >= 0 && idx < this._items.length) {
            this._hover_idx = idx;
            this._ensure_visible(idx);
        }
    }

    get_hover_index() {
        return this._hover_idx;
    }

    get_items() {
        return this._items;
    }

    execute_selected() {
        /** Ejecuta la acción del item en hover */
        if (this._hover_idx >= 0 && this._hover_idx < this._items.length) {
            const item = this._items[this._hover_idx];
            if (!(item.separator || item.category)) {
                if (this.on_select) {
                    const result = this.on_select(item, this._hover_idx);
                    this.close();
                    return result;
                }
            }
        }
        return null;
    }

    set_pixel_ratio(ratio) {
        this.pixel_ratio = ratio;
    }

    // ==================== Eventos ====================

    on_key(key, action, mods) {
        /** Maneja evento de teclado. Retorna true si fue procesado. */
        if (!this._open) return false;
        if (action !== glfw.PRESS && action !== glfw.REPEAT) return false;

        if (key === glfw.KEY_ESCAPE) {
            this.close();
            return true;
        }
        if (key === glfw.KEY_UP) {
            this._navigate_previous();
            return true;
        }
        if (key === glfw.KEY_DOWN) {
            this._navigate_next();
            return true;
        }
        if (key === glfw.KEY_ENTER || key === glfw.KEY_KP_ENTER) {
            this.execute_selected();
            return true;
        }
        return false;
    }

    on_mouse_move(mx, my) {
        /** Maneja movimiento de mouse. Retorna true si está dentro del menú. */
        if (!this._open) return false;

        const [menu_x, menu_y, menu_w, menu_h] = this._calculate_rect();
        const in_menu = menu_x <= mx && mx <= menu_x + menu_w && menu_y <= my && my <= menu_y + menu_h;

        const idx = this._hit_detect(mx, my);
        if (idx >= 0) {
            const item = this._items[idx];
            if (!(item.separator || item.category)) this._hover_idx = idx;
        }
        return in_menu;
    }

    on_mouse_button(mx, my, button, action) {
        /** Maneja clicks de mouse. Retorna true si fue procesado. */
        if (!this._open || button !== glfw.MOUSE_BUTTON_LEFT || action !== glfw.PRESS) return false;

        // Click dentro del menú consume el evento aunque no sea en un item
        const [menu_x, menu_y, menu_w, menu_h] = this._calculate_rect();
        if (menu_x <= mx && mx <= menu_x + menu_w && menu_y <= my && my <= menu_y + menu_h) {
            const idx = this._hit_detect(mx, my);
            if (idx >= 0) {
                const item = this._items[idx];
                if (!(item.separator || item.category)) {
                    this._hover_idx = idx;
                    this.execute_selected();
                }
            }
            return true;
        }
        return false;
    }

    on_scroll(yoff) {
        /** Maneja scroll de mouse. Retorna true si fue procesado. */
        if (!this._open) return false;
        const visible = this._get_visible_count();
        const max_scroll = Math.max(0, this._items.length - visible);
        this._scroll = Math.max(0, Math.min(max_scroll, this._scroll - pyInt(yoff)));
        return true;
    }

    // ==================== Renderizado ====================

    render(proj) {
        /** Renderiza el menú */
        if (!this._open || !this._items.length) return;

        this._update_items();

        const ctx = this.renderer.ctx;
        const pad = this.config.padding * this.pixel_ratio;

        // Overlay oscuro si está configurado
        if (this.config.has_overlay) {
            const ow = this._vp_offset_x + this._viewport_width;
            const oh = this._vp_offset_y + this._viewport_height;
            this.renderer.draw_rect(0, 0, ow, oh, this.config.overlay_color, proj);
        }

        // Calcular geometría
        const [mx, my, mw, mh] = this._calculate_rect();

        // Obtener colores del tema
        const tp = this.config.theme_prefix;
        const border_color = this.theme.vec4(`${tp}.border`, [0.3, 0.3, 0.4, 1.0]);
        const bg_color = this.theme.vec4(`${tp}.bg`, [0.15, 0.15, 0.20, 0.98]);
        const border_radius = this.theme.integer(`${tp}.border-radius`, 8) * this.pixel_ratio;
        const shadow_color = this.theme.vec4(`${tp}.shadow`, [0.0, 0.0, 0.0, 0.5]);

        // Sombra
        const sh_off = 3 * this.pixel_ratio;
        this.renderer.draw_rounded_rect(mx + sh_off, my + sh_off, mw, mh, border_radius, shadow_color, proj);

        // Borde
        const bw = 2 * this.pixel_ratio;
        this.renderer.draw_rounded_rect(mx - bw, my - bw, mw + bw * 2, mh + bw * 2,
                                        border_radius + bw, border_color, proj);

        // Fondo
        this.renderer.draw_rounded_rect(mx, my, mw, mh, border_radius, bg_color, proj);

        // Título
        let item_start_y;
        if (this.config.title_height) {
            this._render_title(mx, my, mw, proj);
            item_start_y = my + this.config.title_height * this.pixel_ratio;
        } else {
            item_start_y = my + pad;
        }

        // Header fijo (debajo del título)
        if (this.config.header_fn) {
            const header_h = this.config.header_height * this.pixel_ratio;
            this.config.header_fn(this.renderer, proj, mx, item_start_y, mw, this.pixel_ratio);
            item_start_y += header_h;
        }

        // Footer fijo (encima del padding inferior)
        const footer_h = this.config.footer_fn ? this.config.footer_height * this.pixel_ratio : 0;

        // Área de items con clipping
        const items_end_y = my + mh - pad - footer_h;
        const items_area_h = items_end_y - item_start_y;

        if (items_area_h > 0) {
            // Habilitar scissor para evitar overflow de items
            const old_scissor = ctx.scissor;
            const vp = ctx.viewport;
            const fb_h = vp[1] + vp[3];

            const sx = Math.max(0, pyInt(mx));
            const sy = Math.max(0, pyInt(fb_h - items_end_y));
            const sw = pyInt(mw) + 1;
            const sh = Math.max(0, pyInt(items_area_h)) + 1;
            ctx.scissor = [sx, sy, sw, sh];

            this._render_items(mx, item_start_y, mw, items_area_h, proj);

            // Restaurar scissor
            ctx.scissor = old_scissor;
        }

        // Indicadores de scroll
        this._render_scroll_indicators(mx, my, mw, mh, pad, item_start_y, items_end_y, proj);

        // Footer fijo
        if (this.config.footer_fn && footer_h > 0) {
            const footer_y = my + mh - pad - footer_h;
            this.config.footer_fn(this.renderer, proj, mx, footer_y, mw, this.pixel_ratio);
        }
    }

    // ==================== Métodos Privados ====================

    _update_items() {
        if (this.items_provider) this._items = this.items_provider();
    }

    _first_selectable() {
        for (let i = 0; i < this._items.length; i++) {
            const item = this._items[i];
            if (!(item.separator || item.category)) return i;
        }
        return -1;
    }

    _compute_width() {
        /** Calcula el ancho del menú basado en el texto más largo de los items */
        // Escalas y márgenes en píxeles lógicos (x pixel_ratio para pantallas HiDPI)
        const text_scale = 1.0 * this.pixel_ratio;
        const shortcut_scale = 0.75 * this.pixel_ratio;
        const pad_x = 10 + 8;
        const gap = 16 * this.pixel_ratio;
        let max_w = 0.0;

        for (const item of this._items) {
            if (item.separator || item.category) continue;
            let marker = "";
            if (this.config.marker_fn) marker = this.config.marker_fn(0, -1) || "";
            const [label_w] = this.renderer.measure_text(marker + item.label, text_scale);
            let shortcut_w = 0.0;
            if (item.shortcut) {
                [shortcut_w] = this.renderer.measure_text(item.shortcut, shortcut_scale);
                shortcut_w += gap;
            }
            max_w = Math.max(max_w, label_w + shortcut_w);
        }

        const computed = max_w + pad_x * this.pixel_ratio;
        const min_w = this.config.width * this.pixel_ratio;
        return Math.max(computed, min_w);
    }

    _calculate_rect() {
        /** Calcula posición y tamaño del menú [x, y, w, h] */
        const mw = this._compute_width();
        const item_h = this.config.item_height * this.pixel_ratio;
        const pad = this.config.padding * this.pixel_ratio;

        const top_offset = this.config.title_height ? this.config.title_height * this.pixel_ratio : pad;

        const header_h = this.config.header_fn ? this.config.header_height * this.pixel_ratio : 0;
        const footer_h = this.config.footer_fn ? this.config.footer_height * this.pixel_ratio : 0;

        const items_h = this._items.length * item_h;

        // Limitar altura máxima (header y footer no se recortan)
        const max_h = this._viewport_height * this.config.max_visible_height_ratio;
        const fixed_h = top_offset + header_h + footer_h + pad;
        const items_h_clamped = Math.min(items_h, max_h - fixed_h);
        const total_h = fixed_h + Math.max(0, items_h_clamped);

        const right = this._vp_offset_x + this._viewport_width;
        const bottom = this._vp_offset_y + this._viewport_height;

        let mx, my;
        if (this.config.anchor_bottom) {
            const margin = this.config.anchor_bottom_margin * this.pixel_ratio;
            mx = this._vp_offset_x + (this._viewport_width - mw) / 2;
            my = bottom - total_h - margin;
            mx = Math.max(this._vp_offset_x, Math.min(mx, right - mw));
            my = Math.max(this._vp_offset_y, my);
        } else if (this.config.centered) {
            mx = this._vp_offset_x + (this._viewport_width - mw) / 2;
            my = this._vp_offset_y + (this._viewport_height - total_h) / 2;
        } else {
            mx = this._anchor_x;
            my = this._anchor_y;
            if (mx + mw > right) mx = right - mw;
            if (my + total_h > bottom) my = bottom - total_h;
            mx = Math.max(this._vp_offset_x, mx);
            my = Math.max(this._vp_offset_y, my);
        }

        return [mx, my, mw, total_h];
    }

    _get_visible_count() {
        /** Calcula cuántos items caben en el área visible */
        const item_h = this.config.item_height * this.pixel_ratio;
        const pad = this.config.padding * this.pixel_ratio;
        const [, , , mh] = this._calculate_rect();

        const top_offset = this.config.title_height ? this.config.title_height * this.pixel_ratio : pad;
        const header_h = this.config.header_fn ? this.config.header_height * this.pixel_ratio : 0;
        const footer_h = this.config.footer_fn ? this.config.footer_height * this.pixel_ratio : 0;
        const available_h = mh - top_offset - header_h - footer_h - pad;
        return Math.max(1, pyInt(available_h / item_h));
    }

    _hit_detect(mx, my) {
        /** Índice del item bajo el punto (mx, my). -1 si no hay hit. */
        const [mx_menu, my_menu, mw, mh] = this._calculate_rect();
        const pad = this.config.padding * this.pixel_ratio;
        const item_h = this.config.item_height * this.pixel_ratio;

        let items_start_y = this.config.title_height
            ? my_menu + this.config.title_height * this.pixel_ratio
            : my_menu + pad;

        if (this.config.header_fn) items_start_y += this.config.header_height * this.pixel_ratio;

        const footer_h = this.config.footer_fn ? this.config.footer_height * this.pixel_ratio : 0;
        const items_end_y = my_menu + mh - pad - footer_h;

        if (mx < mx_menu || mx > mx_menu + mw) return -1;
        if (my < items_start_y || my > items_end_y) return -1;

        const relative_y = my - items_start_y;
        const visible_idx = pyInt(relative_y / item_h);
        const idx = visible_idx + this._scroll;

        if (idx < 0 || idx >= this._items.length) return -1;
        return idx;
    }

    _navigate_next() {
        const start_idx = this._hover_idx >= 0 ? this._hover_idx + 1 : 0;
        for (let i = start_idx; i < this._items.length; i++) {
            if (!(this._items[i].separator || this._items[i].category)) {
                this._hover_idx = i;
                this._ensure_visible(i);
                return;
            }
        }
        for (let i = 0; i < start_idx; i++) {
            if (!(this._items[i].separator || this._items[i].category)) {
                this._hover_idx = i;
                this._ensure_visible(i);
                return;
            }
        }
    }

    _navigate_previous() {
        const start_idx = this._hover_idx >= 0 ? this._hover_idx - 1 : this._items.length - 1;
        for (let i = start_idx; i > -1; i--) {
            if (!(this._items[i].separator || this._items[i].category)) {
                this._hover_idx = i;
                this._ensure_visible(i);
                return;
            }
        }
        for (let i = this._items.length - 1; i > start_idx; i--) {
            if (!(this._items[i].separator || this._items[i].category)) {
                this._hover_idx = i;
                this._ensure_visible(i);
                return;
            }
        }
    }

    _ensure_visible(idx) {
        const visible = this._get_visible_count();
        if (idx < this._scroll) this._scroll = idx;
        else if (idx >= this._scroll + visible) this._scroll = idx - visible + 1;
        const max_scroll = Math.max(0, this._items.length - visible);
        this._scroll = Math.max(0, Math.min(this._scroll, max_scroll));
    }

    _render_title(mx, my, mw, proj) {
        /** Renderiza el título centrado y escalado al máximo posible sin salirse */
        if (!this.config.title) return;

        const title_h = this.config.title_height * this.pixel_ratio;
        const pad_x = 8 * this.pixel_ratio;
        const available_w = mw - pad_x * 2;
        const max_h = title_h - pad_x;

        let scale = 2.0 * this.pixel_ratio;
        let [text_w, text_h] = this.renderer.measure_text(this.config.title, scale);
        if (text_w > available_w && text_w > 0) scale = Math.min(scale, scale * available_w / text_w);
        if (text_h > max_h && text_h > 0) scale = Math.min(scale, scale * max_h / text_h);

        [text_w, text_h] = this.renderer.measure_text(this.config.title, scale);
        const tx = mx + (mw - text_w) / 2;
        const ty = my + (title_h - text_h) / 2;

        this.renderer.draw_text(
            tx, ty, this.config.title,
            this.theme.vec4(`${this.config.theme_prefix}.title`, [0.85, 0.85, 0.90, 1.0]),
            proj, scale,
        );
    }

    _render_items(mx, item_start_y, mw, items_area_h, proj) {
        /** Renderiza los items del menú (con scissor activo) */
        const pr = this.pixel_ratio;
        const item_h = this.config.item_height * pr;
        const text_scale = 1.0 * pr;
        const shortcut_scale = 0.75 * pr;
        const visible_count = Math.max(1, pyInt(items_area_h / item_h));

        const tp = this.config.theme_prefix;
        const fg_color = this.theme.vec4(`${tp}.fg`, [0.85, 0.85, 0.90, 1.0]);
        const hover_color = this.theme.vec4(`${tp}.hover`, [0.28, 0.35, 0.50, 1.0]);
        const sep_color = this.theme.vec4(`${tp}.separator`, [0.25, 0.25, 0.35, 1.0]);
        const category_color = this.theme.vec4(`${tp}.category`, [0.60, 0.70, 0.85, 1.0]);
        const shortcut_color = this.theme.vec4(`${tp}.shortcut`, [0.65, 0.70, 0.80, 0.8]);
        const border_radius = this.theme.integer(`${tp}.border-radius`, 8) * this.pixel_ratio;

        // Solo items visibles (+1 para item parcial al final, recortado por scissor)
        for (let vi = 0; vi < visible_count + 1; vi++) {
            const i = this._scroll + vi;
            if (i >= this._items.length) break;

            const y = item_start_y + vi * item_h;
            const item = this._items[i];

            if (item.separator) {
                this.renderer.draw_rect(mx + 8 * pr, y + item_h / 2 - 0.5 * pr, mw - 16 * pr, 1 * pr, sep_color, proj);
            } else if (item.category) {
                const cat_scale = text_scale * 0.85;
                const cty = this.renderer.text_centered_y(y, item_h, cat_scale);
                this.renderer.draw_text(mx + 8 * pr, cty, item.label, category_color, proj, cat_scale);
            } else {
                const is_hover = i === this._hover_idx;

                let custom_handled = false;
                if (this.config.item_renderer_fn) {
                    custom_handled = this.config.item_renderer_fn(
                        this.renderer, proj, item, mx, y, mw, item_h, is_hover, this.pixel_ratio);
                }

                if (!custom_handled) {
                    if (is_hover) {
                        this.renderer.draw_rounded_rect(mx + 4 * pr, y + 1 * pr, mw - 8 * pr, item_h - 2 * pr,
                                                        border_radius * 0.5, hover_color, proj);
                    }

                    let marker = "";
                    if (this.config.marker_fn) marker = this.config.marker_fn(i, this._hover_idx) || "";

                    const text = marker + item.label;
                    const ty = this.renderer.text_centered_y(y, item_h, text_scale);
                    this.renderer.draw_text(mx + 10 * pr, ty, text, fg_color, proj, text_scale);

                    if (item.shortcut) {
                        const [shortcut_w] = this.renderer.measure_text(item.shortcut, shortcut_scale);
                        const sty = this.renderer.text_centered_y(y, item_h, shortcut_scale);
                        this.renderer.draw_text(mx + mw - 8 * pr - shortcut_w, sty,
                                                item.shortcut, shortcut_color, proj, shortcut_scale);
                    }
                }
            }
        }
    }

    _render_scroll_indicators(mx, my, mw, mh, pad, item_start_y, items_end_y, proj) {
        /** Indicadores de scroll cuando hay items ocultos.
         *  Modos ({prefix}.scroll-indicator): 0 = none, 1 = line, 2 = blur */
        const visible = this._get_visible_count();
        const total = this._items.length;
        if (total <= visible) return;

        const tp = this.config.theme_prefix;
        const mode = this.theme.integer(`${tp}.scroll-indicator`, 2);
        if (mode === 0) return;

        const has_above = this._scroll > 0;
        const has_below = this._scroll + visible < total;

        if (mode === 1) {
            const ind_color = this.theme.vec4(`${tp}.separator`, [0.25, 0.25, 0.35, 0.8]);
            const ind_h = this.theme.integer(`${tp}.scroll-indicator-size`, 2) * this.pixel_ratio;
            const inset = 8 * this.pixel_ratio;
            if (has_above) {
                this.renderer.draw_rect(mx + inset, item_start_y, mw - inset * 2, ind_h, ind_color, proj);
            }
            if (has_below) {
                this.renderer.draw_rect(mx + inset, items_end_y - ind_h, mw - inset * 2, ind_h, ind_color, proj);
            }
        } else if (mode === 2) {
            // El tint por defecto es el bg del menú
            const bg = this.theme.vec4(`${tp}.bg`, [0.15, 0.15, 0.20, 1.0]);
            const tint = this.theme.vec4(`${tp}.scroll-indicator-tint`, bg);
            const max_alpha = this.theme.integer(`${tp}.scroll-indicator-opacity`, 85) / 100.0;
            let zone_h = this.theme.integer(`${tp}.scroll-indicator-height`, 28) * this.pixel_ratio;

            // Limitar la zona para que los dos indicadores no se solapen
            const max_zone = (items_end_y - item_start_y) * 0.4;
            zone_h = Math.min(zone_h, max_zone);

            const steps = Math.max(3, pyInt(zone_h / (2 * this.pixel_ratio)));
            const step_h = zone_h / steps;

            if (has_above) {
                for (let s = 0; s < steps; s++) {
                    const t = 1.0 - s / (steps - 1);
                    const alpha = max_alpha * t * t;
                    this.renderer.draw_rect(mx, item_start_y + s * step_h, mw, step_h + 1,
                                            [tint[0], tint[1], tint[2], alpha], proj);
                }
            }
            if (has_below) {
                for (let s = 0; s < steps; s++) {
                    const t = 1.0 - s / (steps - 1);
                    const alpha = max_alpha * t * t;
                    this.renderer.draw_rect(mx, items_end_y - (s + 1) * step_h, mw, step_h + 1,
                                            [tint[0], tint[1], tint[2], alpha], proj);
                }
            }
        }
    }
}

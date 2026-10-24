/**
 * Sistema de internacionalización (i18n) para GLSL Studio
 * Carga y gestiona strings traducidos desde archivos JSON
 *
 * Port de lang.py. Diferencia web: los idiomas se descargan con fetch()
 * usando lang/index.json (un sitio estático no puede listar carpetas).
 */

import { pyStr } from "./pyutil.js";

const LANG_DIR = "lang";

export class LanguageManager {
    /** Gestor centralizado de idiomas y traducciones */

    constructor(default_lang = "en") {
        this.translations = {};
        this.current_lang = default_lang;
        this.default_lang = default_lang;
        this.available_langs = [];
    }

    async _load_all_languages() {
        /** Carga todos los archivos de idioma disponibles */
        let codes;
        try {
            const res = await fetch(`${LANG_DIR}/index.json`);
            codes = await res.json();
        } catch (e) {
            console.log(`Advertencia: Directorio de idiomas no encontrado: ${LANG_DIR}`);
            return;
        }

        const loaded = await Promise.all(codes.map(async (lang_code) => {
            try {
                const res = await fetch(`${LANG_DIR}/${lang_code}.json`);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return [lang_code, await res.json()];
            } catch (e) {
                console.log(`Error cargando idioma ${lang_code}: ${e}`);
                return null;
            }
        }));

        for (const entry of loaded) {
            if (!entry) continue;
            this.translations[entry[0]] = entry[1];
            this.available_langs.push(entry[0]);
        }

        this.available_langs.sort();
    }

    set_language(lang_code) {
        /** Cambia el idioma actual. Retorna true si fue exitoso */
        if (lang_code in this.translations) {
            this.current_lang = lang_code;
            return true;
        }
        console.log(`Idioma no disponible: ${lang_code}`);
        return false;
    }

    get_text(key, ...args) {
        /**
         * Obtiene un string traducido.
         * args: argumentos posicionales para formateo (reemplaza @0, @1, etc)
         * Retorna el string traducido, o la clave si no se encuentra
         */
        // Intenta obtener del idioma actual
        if (this.current_lang in this.translations) {
            const text = this.translations[this.current_lang][key];
            if (text) return this._format_string(text, args);
        }

        // Intenta obtener del idioma por defecto
        if (this.default_lang in this.translations) {
            const text = this.translations[this.default_lang][key];
            if (text) return this._format_string(text, args);
        }

        // Si no existe, retorna la clave
        console.log(`Clave de idioma no encontrada: ${key}`);
        return key;
    }

    _format_string(text, args) {
        /** Formatea un string con argumentos (@0, @1, etc) */
        if (!args.length) return text;
        for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            // str() de Python: los enteros se muestran sin ".0"
            const s = (typeof arg === "number" && Number.isInteger(arg) && !Object.is(arg, -0))
                ? String(arg) : pyStr(arg);
            text = text.split(`@${i}`).join(s);
        }
        return text;
    }

    get_all_keys() {
        /** Obtiene todas las claves del idioma actual */
        if (this.current_lang in this.translations) {
            return { ...this.translations[this.current_lang] };
        }
        return {};
    }

    get_all_languages() {
        /** Retorna lista de idiomas disponibles */
        return [...this.available_langs];
    }
}

// Instancia global del gestor de idiomas
let _language_manager = null;

export async function init_languages(default_lang = "en") {
    /** Inicializa el sistema de idiomas */
    _language_manager = new LanguageManager(default_lang);
    await _language_manager._load_all_languages();
    return _language_manager;
}

export function get_language_manager() {
    /** Obtiene la instancia global del gestor de idiomas */
    if (_language_manager === null) {
        _language_manager = new LanguageManager();
    }
    return _language_manager;
}

export function _(key, ...args) {
    /** Función de conveniencia para obtener strings traducidos */
    return get_language_manager().get_text(key, ...args);
}

export function set_language(lang_code) {
    /** Cambia el idioma actual */
    return get_language_manager().set_language(lang_code);
}

export function get_available_languages() {
    /** Retorna lista de idiomas disponibles */
    return get_language_manager().get_all_languages();
}

export function get_current_language() {
    /** Retorna el código del idioma actual */
    return get_language_manager().current_lang;
}

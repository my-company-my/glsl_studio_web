// Almacenamiento web.
// - Archivos (proyecto.glss, shader.frag, ...): IndexedDB, como una carpeta
//   interna del navegador (escritorio usa la carpeta actual).
// - Preferencias (idioma, tema): localStorage (escritorio usa user_prefs.json).

const DB_NAME = "glsl_studio";
const STORE = "files";
const PREFS_KEY = "glsl_studio.user_prefs";

let _db = null;

function _open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => {
            _db = req.result;
            resolve(_db);
        };
        req.onerror = () => reject(req.error);
    });
}

function _tx(mode, fn) {
    return _open().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const store = tx.objectStore(STORE);
        const req = fn(store);
        tx.oncomplete = () => resolve(req ? req.result : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    }));
}

/** Guarda un archivo (Uint8Array o string) */
export function write_file(name, data) {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    return _tx("readwrite", (s) => s.put({ name, data: bytes, mtime: Date.now() }, name));
}

/** Lee un archivo. Retorna Uint8Array o null si no existe */
export async function read_file(name) {
    const rec = await _tx("readonly", (s) => s.get(name));
    return rec ? new Uint8Array(rec.data) : null;
}

export async function file_exists(name) {
    const key = await _tx("readonly", (s) => s.getKey(name));
    return key !== undefined;
}

// --- Preferencias ---

export function read_prefs() {
    try {
        const raw = localStorage.getItem(PREFS_KEY);
        if (!raw) return {};
        const prefs = JSON.parse(raw);
        return prefs && typeof prefs === "object" && !Array.isArray(prefs) ? prefs : {};
    } catch (e) {
        return {};
    }
}

export function write_prefs(prefs) {
    try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(prefs, null, 2));
    } catch (e) {
        // Sin almacenamiento (modo privado, etc.): se ignora como en escritorio
    }
}

// --- Descargas ---

export function download(name, data, type = "application/octet-stream") {
    const blob = data instanceof Blob ? data : new Blob([data], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

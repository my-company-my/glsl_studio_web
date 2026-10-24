// Constantes de GLFW (glfw3.h) para que el código portado use los mismos
// valores que escritorio, y la tabla KeyboardEvent.code -> tecla GLFW.
// GLFW identifica las teclas por posición física (como KeyboardEvent.code).

export const RELEASE = 0;
export const PRESS = 1;
export const REPEAT = 2;

export const MOD_SHIFT = 0x0001;
export const MOD_CONTROL = 0x0002;
export const MOD_ALT = 0x0004;
export const MOD_SUPER = 0x0008;

export const MOUSE_BUTTON_LEFT = 0;
export const MOUSE_BUTTON_RIGHT = 1;
export const MOUSE_BUTTON_MIDDLE = 2;

export const KEY_UNKNOWN = -1;
export const KEY_SPACE = 32;
export const KEY_APOSTROPHE = 39;
export const KEY_COMMA = 44;
export const KEY_MINUS = 45;
export const KEY_PERIOD = 46;
export const KEY_SLASH = 47;
export const KEY_0 = 48;
export const KEY_1 = 49;
export const KEY_2 = 50;
export const KEY_3 = 51;
export const KEY_4 = 52;
export const KEY_5 = 53;
export const KEY_6 = 54;
export const KEY_7 = 55;
export const KEY_8 = 56;
export const KEY_9 = 57;
export const KEY_SEMICOLON = 59;
export const KEY_EQUAL = 61;
export const KEY_A = 65;
export const KEY_B = 66;
export const KEY_C = 67;
export const KEY_D = 68;
export const KEY_E = 69;
export const KEY_F = 70;
export const KEY_G = 71;
export const KEY_H = 72;
export const KEY_I = 73;
export const KEY_J = 74;
export const KEY_K = 75;
export const KEY_L = 76;
export const KEY_M = 77;
export const KEY_N = 78;
export const KEY_O = 79;
export const KEY_P = 80;
export const KEY_Q = 81;
export const KEY_R = 82;
export const KEY_S = 83;
export const KEY_T = 84;
export const KEY_U = 85;
export const KEY_V = 86;
export const KEY_W = 87;
export const KEY_X = 88;
export const KEY_Y = 89;
export const KEY_Z = 90;
export const KEY_LEFT_BRACKET = 91;
export const KEY_BACKSLASH = 92;
export const KEY_RIGHT_BRACKET = 93;
export const KEY_GRAVE_ACCENT = 96;
export const KEY_WORLD_1 = 161;
export const KEY_WORLD_2 = 162;
export const KEY_ESCAPE = 256;
export const KEY_ENTER = 257;
export const KEY_TAB = 258;
export const KEY_BACKSPACE = 259;
export const KEY_INSERT = 260;
export const KEY_DELETE = 261;
export const KEY_RIGHT = 262;
export const KEY_LEFT = 263;
export const KEY_DOWN = 264;
export const KEY_UP = 265;
export const KEY_PAGE_UP = 266;
export const KEY_PAGE_DOWN = 267;
export const KEY_HOME = 268;
export const KEY_END = 269;
export const KEY_CAPS_LOCK = 280;
export const KEY_SCROLL_LOCK = 281;
export const KEY_NUM_LOCK = 282;
export const KEY_PRINT_SCREEN = 283;
export const KEY_PAUSE = 284;
export const KEY_F1 = 290;
export const KEY_F2 = 291;
export const KEY_F3 = 292;
export const KEY_F4 = 293;
export const KEY_F5 = 294;
export const KEY_F6 = 295;
export const KEY_F7 = 296;
export const KEY_F8 = 297;
export const KEY_F9 = 298;
export const KEY_F10 = 299;
export const KEY_F11 = 300;
export const KEY_F12 = 301;
export const KEY_KP_0 = 320;
export const KEY_KP_1 = 321;
export const KEY_KP_2 = 322;
export const KEY_KP_3 = 323;
export const KEY_KP_4 = 324;
export const KEY_KP_5 = 325;
export const KEY_KP_6 = 326;
export const KEY_KP_7 = 327;
export const KEY_KP_8 = 328;
export const KEY_KP_9 = 329;
export const KEY_KP_DECIMAL = 330;
export const KEY_KP_DIVIDE = 331;
export const KEY_KP_MULTIPLY = 332;
export const KEY_KP_SUBTRACT = 333;
export const KEY_KP_ADD = 334;
export const KEY_KP_ENTER = 335;
export const KEY_KP_EQUAL = 336;
export const KEY_LEFT_SHIFT = 340;
export const KEY_LEFT_CONTROL = 341;
export const KEY_LEFT_ALT = 342;
export const KEY_LEFT_SUPER = 343;
export const KEY_RIGHT_SHIFT = 344;
export const KEY_RIGHT_CONTROL = 345;
export const KEY_RIGHT_ALT = 346;
export const KEY_RIGHT_SUPER = 347;
export const KEY_MENU = 348;

/** KeyboardEvent.code -> tecla GLFW */
export const CODE_TO_KEY = {
    Space: KEY_SPACE, Quote: KEY_APOSTROPHE, Comma: KEY_COMMA, Minus: KEY_MINUS,
    Period: KEY_PERIOD, Slash: KEY_SLASH, Semicolon: KEY_SEMICOLON, Equal: KEY_EQUAL,
    BracketLeft: KEY_LEFT_BRACKET, Backslash: KEY_BACKSLASH, BracketRight: KEY_RIGHT_BRACKET,
    Backquote: KEY_GRAVE_ACCENT, IntlBackslash: KEY_WORLD_2,
    Escape: KEY_ESCAPE, Enter: KEY_ENTER, Tab: KEY_TAB, Backspace: KEY_BACKSPACE,
    Insert: KEY_INSERT, Delete: KEY_DELETE, ArrowRight: KEY_RIGHT, ArrowLeft: KEY_LEFT,
    ArrowDown: KEY_DOWN, ArrowUp: KEY_UP, PageUp: KEY_PAGE_UP, PageDown: KEY_PAGE_DOWN,
    Home: KEY_HOME, End: KEY_END, CapsLock: KEY_CAPS_LOCK, ScrollLock: KEY_SCROLL_LOCK,
    NumLock: KEY_NUM_LOCK, PrintScreen: KEY_PRINT_SCREEN, Pause: KEY_PAUSE,
    NumpadDecimal: KEY_KP_DECIMAL, NumpadDivide: KEY_KP_DIVIDE, NumpadMultiply: KEY_KP_MULTIPLY,
    NumpadSubtract: KEY_KP_SUBTRACT, NumpadAdd: KEY_KP_ADD, NumpadEnter: KEY_KP_ENTER,
    NumpadEqual: KEY_KP_EQUAL,
    ShiftLeft: KEY_LEFT_SHIFT, ControlLeft: KEY_LEFT_CONTROL, AltLeft: KEY_LEFT_ALT,
    MetaLeft: KEY_LEFT_SUPER, OSLeft: KEY_LEFT_SUPER,
    ShiftRight: KEY_RIGHT_SHIFT, ControlRight: KEY_RIGHT_CONTROL, AltRight: KEY_RIGHT_ALT,
    MetaRight: KEY_RIGHT_SUPER, OSRight: KEY_RIGHT_SUPER, ContextMenu: KEY_MENU,
};
for (let i = 0; i < 10; i++) {
    CODE_TO_KEY[`Digit${i}`] = KEY_0 + i;
    CODE_TO_KEY[`Numpad${i}`] = KEY_KP_0 + i;
}
for (let i = 0; i < 26; i++) {
    CODE_TO_KEY[`Key${String.fromCharCode(65 + i)}`] = KEY_A + i;
}
for (let i = 1; i <= 12; i++) {
    CODE_TO_KEY[`F${i}`] = KEY_F1 + i - 1;
}

/** Mods de GLFW desde un evento del navegador */
export function mods_of(e) {
    let m = 0;
    if (e.shiftKey) m |= MOD_SHIFT;
    if (e.ctrlKey) m |= MOD_CONTROL;
    if (e.altKey) m |= MOD_ALT;
    if (e.metaKey) m |= MOD_SUPER;
    return m;
}

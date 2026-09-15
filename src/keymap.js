// src/keymap.js
// ---------------------------------------------------------------------------
// Key resolution for `browser_press`.
//
// Maps a key name (or single printable character) plus a modifier list into
// the fields `Input.dispatchKeyEvent` needs: key, code, keyCode (Windows
// virtual key code), optional text, and a modifier bitmask.
//
// `text` is present only for keys that should produce a character. Enter, Tab
// and Space carry control/space text so the browser fires keypress/input and
// default actions (form submit, focus traversal); other named keys omit it and
// are dispatched as rawKeyDown.
// ---------------------------------------------------------------------------

export const MODIFIER_BITS = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8
};

export const NAMED_KEYS = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9, text: '\t' },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  Shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16 },
  Control: { key: 'Control', code: 'ControlLeft', keyCode: 17 },
  Alt: { key: 'Alt', code: 'AltLeft', keyCode: 18 },
  Meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91 },
  CapsLock: { key: 'CapsLock', code: 'CapsLock', keyCode: 20 }
};

for (let i = 1; i <= 12; i++) {
  NAMED_KEYS[`F${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i };
}

const SYMBOL_CODES = {
  '-': 'Minus',
  '=': 'Equal',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '\\': 'Backslash',
  ';': 'Semicolon',
  "'": 'Quote',
  '`': 'Backquote',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash'
};

export const SUPPORTED_KEYS = Object.keys(NAMED_KEYS).sort();

function keyError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function modifierMask(modifiers) {
  if (modifiers === undefined || modifiers === null) return 0;
  if (!Array.isArray(modifiers)) {
    throw keyError('"modifiers" must be an array', 'INVALID_ARGS');
  }
  let mask = 0;
  for (const mod of modifiers) {
    const bit = MODIFIER_BITS[mod];
    if (bit === undefined) {
      throw keyError(
        `Unknown modifier: ${mod}. Supported: ${Object.keys(MODIFIER_BITS).join(', ')}`,
        'INVALID_ARGS'
      );
    }
    mask |= bit;
  }
  return mask;
}

/**
 * Resolve a key name or single printable character into dispatch fields.
 *
 * @param {string} key
 * @param {string[]} [modifiers]
 * @returns {{ key: string, code: string, keyCode: number, text?: string, modifiers: number }}
 * @throws {Error} with code KEY_NOT_SUPPORTED for unknown keys, INVALID_ARGS for bad modifiers
 */
export function resolveKey(key, modifiers = []) {
  const mask = modifierMask(modifiers);

  if (typeof key !== 'string' || key.length === 0) {
    throw keyError('"key" must be a non-empty string', 'INVALID_ARGS');
  }

  const named = NAMED_KEYS[key];
  if (named) {
    const resolved = {
      key: named.key,
      code: named.code,
      keyCode: named.keyCode,
      modifiers: mask
    };
    if (named.text !== undefined) resolved.text = named.text;
    return resolved;
  }

  if (key.length === 1) {
    let code;
    if (/[a-zA-Z]/.test(key)) {
      code = `Key${key.toUpperCase()}`;
    } else if (/[0-9]/.test(key)) {
      code = `Digit${key}`;
    } else {
      code = SYMBOL_CODES[key] || '';
    }
    return {
      key,
      code,
      keyCode: key.toUpperCase().charCodeAt(0),
      text: key,
      modifiers: mask
    };
  }

  throw keyError(
    `Unsupported key: "${key}". Supported named keys: ${SUPPORTED_KEYS.join(', ')} ` +
      '(or a single character)',
    'KEY_NOT_SUPPORTED'
  );
}

export default {
  MODIFIER_BITS,
  NAMED_KEYS,
  SUPPORTED_KEYS,
  resolveKey
};

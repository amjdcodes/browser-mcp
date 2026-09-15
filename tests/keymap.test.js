import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveKey, MODIFIER_BITS, SUPPORTED_KEYS } from '../src/keymap.js';

describe('keymap.js — named keys', () => {
  it('resolves Enter with carriage-return text', () => {
    const k = resolveKey('Enter');
    assert.equal(k.key, 'Enter');
    assert.equal(k.code, 'Enter');
    assert.equal(k.keyCode, 13);
    assert.equal(k.text, '\r');
  });

  it('resolves Tab with tab text', () => {
    const k = resolveKey('Tab');
    assert.equal(k.key, 'Tab');
    assert.equal(k.keyCode, 9);
    assert.equal(k.text, '\t');
  });

  it('resolves Escape and its alias', () => {
    assert.equal(resolveKey('Escape').keyCode, 27);
    assert.equal(resolveKey('Esc').keyCode, 27);
    assert.equal(resolveKey('Esc').key, 'Escape');
  });

  it('resolves arrows and navigation keys', () => {
    assert.equal(resolveKey('ArrowUp').keyCode, 38);
    assert.equal(resolveKey('ArrowDown').keyCode, 40);
    assert.equal(resolveKey('ArrowLeft').keyCode, 37);
    assert.equal(resolveKey('ArrowRight').keyCode, 39);
    assert.equal(resolveKey('Home').keyCode, 36);
    assert.equal(resolveKey('End').keyCode, 35);
    assert.equal(resolveKey('PageUp').keyCode, 33);
    assert.equal(resolveKey('PageDown').keyCode, 34);
    assert.equal(resolveKey('Backspace').keyCode, 8);
    assert.equal(resolveKey('Delete').keyCode, 46);
  });

  it('resolves Space to a space character', () => {
    const k = resolveKey('Space');
    assert.equal(k.key, ' ');
    assert.equal(k.keyCode, 32);
    assert.equal(k.text, ' ');
  });

  it('resolves function keys', () => {
    assert.equal(resolveKey('F1').keyCode, 112);
    assert.equal(resolveKey('F12').keyCode, 123);
  });

  it('named keys without text omit the text field', () => {
    assert.equal(resolveKey('Escape').text, undefined);
    assert.equal(resolveKey('ArrowUp').text, undefined);
  });
});

describe('keymap.js — characters', () => {
  it('resolves lowercase letters to Key codes', () => {
    const k = resolveKey('a');
    assert.equal(k.key, 'a');
    assert.equal(k.code, 'KeyA');
    assert.equal(k.keyCode, 65);
    assert.equal(k.text, 'a');
  });

  it('resolves uppercase letters with their own key value', () => {
    const k = resolveKey('A');
    assert.equal(k.key, 'A');
    assert.equal(k.code, 'KeyA');
    assert.equal(k.keyCode, 65);
    assert.equal(k.text, 'A');
  });

  it('resolves digits to Digit codes', () => {
    const k = resolveKey('1');
    assert.equal(k.code, 'Digit1');
    assert.equal(k.keyCode, 49);
    assert.equal(k.text, '1');
  });

  it('resolves common symbols', () => {
    assert.equal(resolveKey('-').code, 'Minus');
    assert.equal(resolveKey('/').code, 'Slash');
    assert.equal(resolveKey('.').code, 'Period');
    const k = resolveKey('-');
    assert.equal(k.keyCode, 45);
    assert.equal(k.text, '-');
  });
});

describe('keymap.js — modifiers', () => {
  it('computes the modifier bitmask', () => {
    assert.equal(resolveKey('a', ['Control']).modifiers, MODIFIER_BITS.Control);
    assert.equal(resolveKey('a', ['Control', 'Shift']).modifiers, MODIFIER_BITS.Control | MODIFIER_BITS.Shift);
    assert.equal(resolveKey('a', ['Alt', 'Meta']).modifiers, MODIFIER_BITS.Alt | MODIFIER_BITS.Meta);
  });

  it('defaults to no modifiers', () => {
    assert.equal(resolveKey('Enter').modifiers, 0);
    assert.equal(resolveKey('a', []).modifiers, 0);
  });

  it('rejects unknown modifiers', () => {
    assert.throws(
      () => resolveKey('a', ['Hyper']),
      (err) => err.code === 'INVALID_ARGS' && /Unknown modifier/.test(err.message)
    );
  });

  it('rejects non-array modifiers', () => {
    assert.throws(
      () => resolveKey('a', 'Control'),
      (err) => err.code === 'INVALID_ARGS'
    );
  });
});

describe('keymap.js — rejection', () => {
  it('rejects unknown named keys with KEY_NOT_SUPPORTED', () => {
    assert.throws(
      () => resolveKey('Nope'),
      (err) => err.code === 'KEY_NOT_SUPPORTED' && /Unsupported key/.test(err.message)
    );
  });

  it('lists supported keys in the error message', () => {
    assert.ok(SUPPORTED_KEYS.includes('Enter'));
    try {
      resolveKey('MadeUpKey');
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('Enter'));
    }
  });

  it('rejects empty and non-string keys', () => {
    assert.throws(() => resolveKey(''), (err) => err.code === 'INVALID_ARGS');
    assert.throws(() => resolveKey(undefined), (err) => err.code === 'INVALID_ARGS');
  });
});

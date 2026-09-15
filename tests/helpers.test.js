import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeWhitespace,
  waitForCondition,
  IN_PAGE
} from '../src/helpers.js';

describe('helpers.js — Node-side utilities', () => {
  describe('normalizeWhitespace', () => {
    it('collapses repeated whitespace into a single space', () => {
      assert.equal(normalizeWhitespace('hello   world\n\n  again'), 'hello world again');
    });

    it('trims leading and trailing whitespace', () => {
      assert.equal(normalizeWhitespace('   padded   '), 'padded');
    });

    it('preserves non-whitespace characters exactly (no diacritic changes)', () => {
      assert.equal(normalizeWhitespace('héllo  wörld'), 'héllo wörld');
    });

    it('handles non-string input as empty string', () => {
      assert.equal(normalizeWhitespace(null), '');
      assert.equal(normalizeWhitespace(undefined), '');
    });
  });

  describe('waitForCondition validation', () => {
    it('rejects when neither selector nor text is provided', async () => {
      await assert.rejects(
        waitForCondition({}, {}),
        (err) => err.code === 'INVALID_ARGS' &&
          /at least one/.test(err.message)
      );
    });

    it('rejects when called with no arguments at all', async () => {
      await assert.rejects(
        waitForCondition({}),
        (err) => err.code === 'INVALID_ARGS'
      );
    });
  });

  describe('IN_PAGE helpers are static strings (security)', () => {
    const names = Object.keys(IN_PAGE);

    it('defines all required helpers', () => {
      for (const required of [
        'queryElement',
        'isElementVisible',
        'scrollIntoView',
        'getClickablePoint',
        'focusElement',
        'isTypeable',
        'clearInput',
        'typeText',
        'normalizeWhitespace',
        'findTextInPage',
        'getElementInfo',
        'isHovered',
        'serializeValue'
      ]) {
        assert.ok(IN_PAGE[required], `missing helper: ${required}`);
      }
    });

    it('every helper is a plain function string', () => {
      for (const name of names) {
        assert.equal(typeof IN_PAGE[name], 'string', `${name} must be a string`);
        assert.match(IN_PAGE[name], /^\s*function\s*\(/, `${name} must be a function declaration`);
      }
    });

    it('never embeds user data via template interpolation', () => {
      for (const name of names) {
        // Helper source must not contain template-literal interpolation:
        // user values are only ever passed through CDP `arguments`.
        assert.ok(!IN_PAGE[name].includes('${'), `${name} contains interpolation`);
      }
    });
  });
});

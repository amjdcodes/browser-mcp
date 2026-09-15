import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  VIEWPORT_PRESETS,
  PRESET_NAMES,
  resolveViewportParams
} from '../src/viewport.js';

function assertInvalid(args, pattern) {
  assert.throws(
    () => resolveViewportParams(args),
    (err) => err.code === 'INVALID_ARGS' && (!pattern || pattern.test(err.message)),
    `expected INVALID_ARGS for ${JSON.stringify(args)}`
  );
}

describe('viewport.js — presets', () => {
  it('defines the three documented presets', () => {
    assert.deepEqual(PRESET_NAMES.sort(), ['desktop', 'mobile', 'tablet']);
    assert.deepEqual(VIEWPORT_PRESETS.mobile, { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    assert.deepEqual(VIEWPORT_PRESETS.tablet, { width: 768, height: 1024, deviceScaleFactor: 2, mobile: true });
    assert.deepEqual(VIEWPORT_PRESETS.desktop, { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  });
});

describe('resolveViewportParams — reset mode', () => {
  it('accepts reset alone', () => {
    assert.deepEqual(resolveViewportParams({ reset: true }), { mode: 'reset' });
  });

  it('rejects reset combined with other options', () => {
    assertInvalid({ reset: true, width: 500, height: 700 }, /cannot be combined/);
    assertInvalid({ reset: true, preset: 'mobile' }, /cannot be combined/);
    assertInvalid({ reset: true, device_scale_factor: 2 }, /cannot be combined/);
  });

  it('rejects reset:false alone (nothing requested)', () => {
    assertInvalid({ reset: false }, /No viewport change/);
  });

  it('rejects reset:false combined with other options', () => {
    assertInvalid({ reset: false, preset: 'mobile' }, /cannot be combined/);
  });
});

describe('resolveViewportParams — explicit mode', () => {
  it('accepts width + height and applies overrides', () => {
    const result = resolveViewportParams({ width: 500, height: 700 });
    assert.equal(result.mode, 'apply');
    assert.equal(result.preset, null);
    assert.deepEqual(result.viewport, {
      width: 500,
      height: 700,
      deviceScaleFactor: 1,
      mobile: false
    });
  });

  it('honours device_scale_factor and mobile overrides', () => {
    const result = resolveViewportParams({ width: 500, height: 700, device_scale_factor: 2, mobile: true });
    assert.equal(result.viewport.deviceScaleFactor, 2);
    assert.equal(result.viewport.mobile, true);
  });

  it('rejects width without height', () => {
    assertInvalid({ width: 500 }, /Both "width" and "height"/);
  });

  it('rejects height without width', () => {
    assertInvalid({ height: 700 }, /Both "width" and "height"/);
  });

  it('rejects out-of-range dimensions', () => {
    assertInvalid({ width: 50, height: 700 }, /"width"/);
    assertInvalid({ width: 500, height: 20000 }, /"height"/);
  });

  it('rejects non-integer dimensions', () => {
    assertInvalid({ width: 500.5, height: 700 }, /"width"/);
  });
});

describe('resolveViewportParams — preset mode', () => {
  it('resolves each preset to its documented values', () => {
    for (const name of PRESET_NAMES) {
      const result = resolveViewportParams({ preset: name });
      assert.equal(result.mode, 'apply');
      assert.equal(result.preset, name);
      assert.deepEqual(result.viewport, VIEWPORT_PRESETS[name]);
    }
  });

  it('allows overrides on top of a preset', () => {
    const result = resolveViewportParams({ preset: 'mobile', device_scale_factor: 1, mobile: false });
    assert.equal(result.viewport.width, 390);
    assert.equal(result.viewport.height, 844);
    assert.equal(result.viewport.deviceScaleFactor, 1);
    assert.equal(result.viewport.mobile, false);
  });

  it('rejects preset combined with width/height', () => {
    assertInvalid({ preset: 'mobile', width: 500 }, /cannot be combined/);
    assertInvalid({ preset: 'mobile', height: 500 }, /cannot be combined/);
  });

  it('rejects unknown presets', () => {
    assertInvalid({ preset: 'watch' }, /Unknown preset/);
  });
});

describe('resolveViewportParams — empty and override-only', () => {
  it('rejects an empty call', () => {
    assertInvalid({}, /No viewport change/);
  });

  it('rejects overrides without a size', () => {
    assertInvalid({ device_scale_factor: 2 }, /require a "preset"/);
    assertInvalid({ mobile: true }, /require a "preset"/);
  });

  it('rejects non-object input', () => {
    assertInvalid(null);
    assertInvalid([]);
    assertInvalid('mobile');
  });
});

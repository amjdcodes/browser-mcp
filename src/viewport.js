// src/viewport.js
// ---------------------------------------------------------------------------
// Viewport parameter handling for `browser_resize`.
//
// Validation runs on the RAW tool arguments (what the client actually sent),
// NOT on a Zod-normalized object. Zod `.default()` values would otherwise
// always reach the handler, making it impossible to tell "reset" from
// "default" and turning an empty `{}` call into a valid request.
//
// Three mutually exclusive modes are accepted:
//   - reset: true
//   - preset: 'mobile' | 'tablet' | 'desktop'  (with optional overrides)
//   - width + height                            (with optional overrides)
// ---------------------------------------------------------------------------

export const MIN_VIEWPORT_DIM = 100;
export const MAX_VIEWPORT_DIM = 10000;
export const MIN_DEVICE_SCALE_FACTOR = 1;
export const MAX_DEVICE_SCALE_FACTOR = 4;

export const VIEWPORT_PRESETS = {
  mobile: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
  tablet: { width: 768, height: 1024, deviceScaleFactor: 2, mobile: true },
  desktop: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }
};

export const PRESET_NAMES = Object.keys(VIEWPORT_PRESETS);

function invalid(message) {
  const err = new Error(message);
  err.code = 'INVALID_ARGS';
  return err;
}

function validateBounds(viewport) {
  const { width, height, deviceScaleFactor } = viewport;

  if (!Number.isInteger(width) || width < MIN_VIEWPORT_DIM || width > MAX_VIEWPORT_DIM) {
    throw invalid(
      `"width" must be an integer between ${MIN_VIEWPORT_DIM} and ${MAX_VIEWPORT_DIM}`
    );
  }
  if (!Number.isInteger(height) || height < MIN_VIEWPORT_DIM || height > MAX_VIEWPORT_DIM) {
    throw invalid(
      `"height" must be an integer between ${MIN_VIEWPORT_DIM} and ${MAX_VIEWPORT_DIM}`
    );
  }
  if (
    typeof deviceScaleFactor !== 'number' ||
    deviceScaleFactor < MIN_DEVICE_SCALE_FACTOR ||
    deviceScaleFactor > MAX_DEVICE_SCALE_FACTOR
  ) {
    throw invalid(
      `"device_scale_factor" must be between ${MIN_DEVICE_SCALE_FACTOR} and ${MAX_DEVICE_SCALE_FACTOR}`
    );
  }
}

/**
 * Validate raw `browser_resize` arguments and resolve them into a concrete
 * action. Throws an error with code `INVALID_ARGS` on any violation.
 *
 * @param {object} args - the raw arguments object from the tool call
 * @returns {{ mode: 'reset' } | { mode: 'apply', viewport: object, preset: string|null }}
 */
export function resolveViewportParams(args = {}) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw invalid('Resize arguments must be an object');
  }

  const { preset, width, height, device_scale_factor, mobile, reset } = args;

  const hasPreset = preset !== undefined;
  const hasWidth = width !== undefined;
  const hasHeight = height !== undefined;
  const hasDsf = device_scale_factor !== undefined;
  const hasMobile = mobile !== undefined;
  const hasOther = hasPreset || hasWidth || hasHeight || hasDsf || hasMobile;

  // --- reset mode (exclusive) ---
  if (reset !== undefined) {
    if (reset !== true) {
      if (hasOther) {
        throw invalid('"reset" cannot be combined with other options');
      }
      throw invalid(
        'No viewport change requested. Provide "preset", "width"+"height", or "reset": true'
      );
    }
    if (hasOther) {
      throw invalid('"reset" cannot be combined with other options');
    }
    return { mode: 'reset' };
  }

  // --- preset mode ---
  if (hasPreset) {
    if (hasWidth || hasHeight) {
      throw invalid('"preset" cannot be combined with "width"/"height"');
    }
    const base = VIEWPORT_PRESETS[preset];
    if (!base) {
      throw invalid(
        `Unknown preset: ${preset}. Supported: ${PRESET_NAMES.join(', ')}`
      );
    }
    const viewport = {
      width: base.width,
      height: base.height,
      deviceScaleFactor: hasDsf ? device_scale_factor : base.deviceScaleFactor,
      mobile: hasMobile ? mobile : base.mobile
    };
    validateBounds(viewport);
    if (typeof viewport.mobile !== 'boolean') {
      throw invalid('"mobile" must be a boolean');
    }
    return { mode: 'apply', viewport, preset };
  }

  // --- explicit width + height mode ---
  if (hasWidth || hasHeight) {
    if (!hasWidth || !hasHeight) {
      throw invalid('Both "width" and "height" must be provided together');
    }
    const viewport = {
      width,
      height,
      deviceScaleFactor: hasDsf ? device_scale_factor : 1,
      mobile: hasMobile ? mobile : false
    };
    validateBounds(viewport);
    if (typeof viewport.mobile !== 'boolean') {
      throw invalid('"mobile" must be a boolean');
    }
    return { mode: 'apply', viewport, preset: null };
  }

  // --- overrides without a size, or nothing at all ---
  if (hasDsf || hasMobile) {
    throw invalid(
      '"device_scale_factor"/"mobile" require a "preset" or "width"+"height"'
    );
  }

  throw invalid(
    'No viewport change requested. Provide "preset", "width"+"height", or "reset": true'
  );
}

export default {
  VIEWPORT_PRESETS,
  PRESET_NAMES,
  MIN_VIEWPORT_DIM,
  MAX_VIEWPORT_DIM,
  MIN_DEVICE_SCALE_FACTOR,
  MAX_DEVICE_SCALE_FACTOR,
  resolveViewportParams
};

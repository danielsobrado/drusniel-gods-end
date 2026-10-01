// Phones and tablets: touch is the primary input and nothing can hover. A
// desktop in a narrow window, or a touch-screen laptop driven by its mouse or
// trackpad, does not match, so its camera stays under full mouse control.
const TOUCH_PRIMARY_QUERY = '(hover: none) and (pointer: coarse)';

export function isTouchPrimary(runtime = globalThis) {
  return Boolean(runtime.matchMedia?.(TOUCH_PRIMARY_QUERY)?.matches);
}

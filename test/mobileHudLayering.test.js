// The bug this guards is invisible to every other kind of test: MobileControls lays a
// transparent, full-viewport touch surface over the page to capture look-drags, so any
// HUD control stacked below it is simply untappable on a phone -- the markup, the
// listeners and the desktop behaviour all stay correct. It is only a z-index ordering.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function mobileControlsZ() {
  const source = read('src/player/MobileControls.js');
  const declared = source.match(/const MOBILE_CONTROLS_Z = (\d+);/);
  assert.ok(declared, 'MobileControls no longer declares MOBILE_CONTROLS_Z');
  assert.match(
    source,
    /z-index: \$\{MOBILE_CONTROLS_Z\};/,
    'the mobile control root no longer uses MOBILE_CONTROLS_Z for its z-index',
  );
  return Number(declared[1]);
}

function overlayZ() {
  const rule = read('src/styles.css').match(/^\.overlay \{([^}]*)\}/m);
  assert.ok(rule, '.overlay rule not found in styles.css');
  const z = rule[1].match(/z-index:\s*(\d+)/);
  assert.ok(z, '.overlay no longer sets a z-index');
  assert.match(rule[1], /pointer-events:\s*none/, '.overlay must stay click-through by default');
  return Number(z[1]);
}

test('the HUD overlay stacks above the mobile look-capture layer', () => {
  assert.ok(
    overlayZ() > mobileControlsZ(),
    `HUD z-index ${overlayZ()} must exceed the mobile touch layer's ${mobileControlsZ()}, `
    + 'or the scenic-tour, free-fly and scene-settings buttons stop responding to taps',
  );
});

test('the scene buttons opt back into pointer events the overlay switches off', () => {
  const cinematic = read('src/cinematic.css');
  const rule = cinematic.match(/\.scene-actions \{([^}]*)\}/);
  assert.ok(rule, '.scene-actions rule not found');
  assert.match(rule[1], /pointer-events:\s*auto/, '.scene-actions must re-enable pointer events');

  // The toggle is a child of .scene-actions but the mobile rule repositions it out of
  // that flow, so it carries its own pointer-events and would regress independently.
  const toggle = read('src/styles.css').match(/\.mobile-panel-toggle \{[^}]*position: absolute;[^}]*\}/);
  assert.ok(toggle, 'mobile .mobile-panel-toggle rule not found');
  assert.match(toggle[0], /pointer-events:\s*auto/, 'the mobile panel toggle must accept taps');
});

test('every HUD control the mobile layer covers sits inside the raised overlay', () => {
  const markup = read('src/ui/DemoUi.js');
  // All three reported-dead buttons live in one overlay subtree; if a future control is
  // added outside it, it inherits no stacking fix and this catches the split.
  for (const hook of ['data-tour', 'data-free-fly', 'data-panel-toggle']) {
    assert.ok(markup.includes(hook), `${hook} button is missing from the HUD markup`);
  }
  assert.match(markup, /overlay\.className = 'overlay cinematic-hud'/, 'HUD root lost the .overlay class');
});

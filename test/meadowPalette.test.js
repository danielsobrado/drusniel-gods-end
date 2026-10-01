import assert from 'node:assert/strict';
import test from 'node:test';
import { Color } from 'three/webgpu';
import { getMeadowPalette, setMeadowPalette } from '../src/rendering/MeadowPalette.js';

const config = () => ({ ui: { initialPreset: 'day' }, grass: { blade: { baseColor: '#223311', tipColor: '#557733' } },
  presets: { day: { grass: { blade: { baseColor: '#50852b', tipColor: '#a6bf65' } } } } });

test('ground and grass retain shared uniform identities through weather transitions', () => {
  const sceneConfig = config();
  const ground = getMeadowPalette(sceneConfig);
  const grass = getMeadowPalette(sceneConfig);
  assert.equal(ground, grass);
  assert.ok(ground.base.value.equals(new Color('#50852b')));
  const base = ground.base, tip = ground.tip;
  setMeadowPalette(sceneConfig, { baseColor: new Color('#193f20'), tipColor: new Color('#4f9b35') });
  assert.equal(grass.base, base);
  assert.equal(grass.tip, tip);
  assert.ok(ground.base.value.equals(new Color('#193f20')));
  assert.ok(ground.tip.value.equals(new Color('#4f9b35')));
});

test('weather palette changes stay isolated between scene configurations', () => {
  const first = config(), second = config();
  setMeadowPalette(first, { baseColor: '#111111', tipColor: '#222222' });
  assert.ok(getMeadowPalette(second).base.value.equals(new Color('#50852b')));
});

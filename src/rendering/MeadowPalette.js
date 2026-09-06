import { Color } from 'three/webgpu';
import { Fn, dot, floor, fract, mix, sin, smoothstep, uniform, vec2, vec3 } from 'three/tsl';

const palettes = new WeakMap();

export function getMeadowPalette(config) {
  let palette = palettes.get(config);
  if (!palette) {
    const grass = config.presets?.[config.ui.initialPreset]?.grass?.blade ?? config.grass.blade;
    palette = { base: uniform(new Color(grass.baseColor)), tip: uniform(new Color(grass.tipColor)) };
    palettes.set(config, palette);
  }
  return palette;
}

export function setMeadowPalette(config, grass) {
  const palette = getMeadowPalette(config);
  palette.base.value.set(grass.baseColor);
  palette.tip.value.set(grass.tipColor);
}

// Smooth, stationary world-space patches. Both surfaces sample the same field;
// grass samples at its root, so wind and LOD changes cannot move its pigment.
const meadowNoise = Fn(([p]) => {
  const cell = floor(p);
  const local = fract(p);
  const weight = local.mul(local).mul(local.mul(-2).add(3));
  const hash = offset => fract(sin(dot(cell.add(offset), vec2(127.1, 311.7))).mul(43758.5453));
  return mix(mix(hash(vec2(0, 0)), hash(vec2(1, 0)), weight.x),
    mix(hash(vec2(0, 1)), hash(vec2(1, 1)), weight.x), weight.y);
}, 'float');

export function meadowColors(worldXZ, config) {
  const style = config.cinematic.style;
  const palette = getMeadowPalette(config);
  const scale = style.meadowPatchScale ?? 0.035;
  const patch = meadowNoise(worldXZ.mul(scale)).mul(0.8)
    .add(meadowNoise(worldXZ.mul(scale * 2.7).add(19.3)).mul(0.2));
  const tint = mix(vec3(0.84, 0.97, 1.03), vec3(1.13, 1.04, 0.77), smoothstep(0.15, 0.85, patch));
  return {
    root: mix(palette.base, palette.tip, style.groundTipMix ?? 0.12).mul(tint),
    tip: palette.tip.mul(tint),
  };
}

export function meadowRootColor(worldXZ, config) { return meadowColors(worldXZ, config).root; }

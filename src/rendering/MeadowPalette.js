import { Color } from 'three/webgpu';
import { getPresetAppearance, sampleReferenceField } from './PresetAppearance.js';
import { color, dot, floor, fract, mix, sin, smoothstep, uniform, vec2, vec3 } from 'three/tsl';

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

const meadowNoise = (([p]) => {
  const cell = floor(p);
  const local = fract(p);
  const weight = local.mul(local).mul(local.mul(-2).add(3));
  const hash = offset => fract(sin(dot(cell.add(offset), vec2(127.1, 311.7))).mul(43758.5453));
  return mix(mix(hash(vec2(0, 0)), hash(vec2(1, 0)), weight.x),
    mix(hash(vec2(0, 1)), hash(vec2(1, 1)), weight.x), weight.y);
});

export function meadowColors(worldXZ, config, reference = false) {
  const style = config.cinematic.style;
  const palette = getMeadowPalette(config);
  const appearance = getPresetAppearance(config);
  if (reference) {
    const field = sampleReferenceField(worldXZ, config);
    const base = mix(palette.base, appearance.dryRoot, field.r);
    const tip = mix(palette.tip, appearance.dryTip, field.r);
    return { root: mix(base, tip, appearance.groundTipMix).mul(mix(0.9, 1.05, field.g)), tip };
  }

  const scale = style.meadowPatchScale ?? 0.035;
  const patch = meadowNoise(worldXZ.mul(scale)).mul(0.8)
    .add(meadowNoise(worldXZ.mul(scale * 2.7).add(19.3)).mul(0.2));
  const cool = style.meadowTintCool ?? [0.84, 0.97, 1.03];
  const warm = style.meadowTintWarm ?? [1.13, 1.04, 0.77];
  const tint = mix(
    vec3(Number(cool[0]), Number(cool[1]), Number(cool[2])),
    vec3(Number(warm[0]), Number(warm[1]), Number(warm[2])),
    smoothstep(0.15, 0.85, patch),
  ).toVar();

  const dryPatch = meadowNoise(worldXZ.mul(style.meadowDryPatchScale ?? 0.011).add(53.7));
  const dryAmount = smoothstep(
    style.meadowDryPatchStart ?? 0.56,
    style.meadowDryPatchEnd ?? 0.84,
    dryPatch,
  ).mul(style.meadowDryStrength ?? 0);
  const dryColor = color(style.meadowDryTint ?? '#777455');
  const root = mix(palette.base, palette.tip, appearance.groundTipMix).mul(tint);
  const tip = palette.tip.mul(tint);

  return {
    root: mix(root, dryColor, dryAmount),
    tip: mix(tip, dryColor.mul(1.06), dryAmount.mul(0.45)),
  };
}

export function meadowRootColor(worldXZ, config) {
  const appearance = getPresetAppearance(config);
  const legacy = meadowColors(worldXZ, config, false).root;
  const reference = meadowColors(worldXZ, config, true).root;
  return mix(legacy, reference, appearance.enabled);
}

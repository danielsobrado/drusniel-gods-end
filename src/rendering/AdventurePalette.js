import { color, dot, mix, smoothstep, vec3 } from 'three/tsl';

// Shared by detailed leaves and their impostors so the palette survives LODs.
export function adventureCanopyColor(sample, config) {
  const style = config.cinematic?.style;
  if (!config.cinematic?.enabled || !style?.enabled) return sample;
  const luminance = dot(sample, vec3(0.2126, 0.7152, 0.0722));
  const light = smoothstep(0.03, 0.8, luminance);
  const palette = mix(color(style.canopyShadow), color(style.canopyLight), light);
  // Retain dark branch detail in the billboard texture.
  return mix(sample, palette, smoothstep(0.025, 0.14, luminance).mul(style.canopyTint));
}

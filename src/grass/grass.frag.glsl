uniform vec3 uBaseColor;
uniform vec3 uTipColor;
uniform float uShadeVariation;

varying float vHeight;
varying float vShade;
varying float vFacing;

void main() {
  vec3 color = mix(uBaseColor, uTipColor, smoothstep(0.05, 1.0, vHeight));
  float shade = mix(1.0 - uShadeVariation, 1.0 + uShadeVariation, vShade);
  color *= shade * vFacing;
  gl_FragColor = vec4(color, 1.0);
}

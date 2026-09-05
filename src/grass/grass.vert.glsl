uniform float uTime;
uniform float uBladeHeight;
uniform float uWindStrength;
uniform float uWindSpeed;
uniform vec2 uWindDirection;
uniform vec3 uPlayerPosition;
uniform float uInteractionRadius;
uniform float uFieldSize;
uniform sampler2D uGrassMask;
uniform float uMaskThreshold;
uniform float uMaskInvert;

attribute vec3 aOffset;
attribute float aScale;
attribute float aRotation;
attribute float aPhase;
attribute float aShade;

varying float vHeight;
varying float vShade;
varying float vFacing;

mat2 rotate2d(float angle) {
  float s = sin(angle);
  float c = cos(angle);
  return mat2(c, -s, s, c);
}

void main() {
  vec3 transformed = position;
  float heightRatio = clamp(transformed.y / uBladeHeight, 0.0, 1.0);
  vec2 maskUv = aOffset.xz / uFieldSize + 0.5;
  float rawMask = texture2D(uGrassMask, maskUv).r;
  float maskValue = mix(rawMask, 1.0 - rawMask, uMaskInvert);
  float maskVisibility = smoothstep(uMaskThreshold, uMaskThreshold + 0.08, maskValue);
  transformed *= maskVisibility;

  float windWave = sin(
    uTime * uWindSpeed +
    aPhase +
    dot(aOffset.xz, vec2(0.11, 0.085))
  );
  vec2 wind = normalize(uWindDirection + vec2(0.0001)) * windWave * uWindStrength;
  transformed.xz += wind * heightRatio * heightRatio;

  vec2 fromPlayer = aOffset.xz - uPlayerPosition.xz;
  float playerDistance = length(fromPlayer);
  float influence = 1.0 - smoothstep(uInteractionRadius * 0.25, uInteractionRadius, playerDistance);
  vec2 pushDirection = normalize(fromPlayer + vec2(0.0001));
  transformed.xz += pushDirection * influence * heightRatio * heightRatio * 0.95;
  transformed.y *= mix(1.0, 0.42, influence * heightRatio);

  transformed.xz = rotate2d(aRotation) * transformed.xz;
  transformed *= vec3(aScale, aScale, aScale);
  transformed += aOffset;

  vec4 worldPosition = modelMatrix * vec4(transformed, 1.0);
  vec3 viewDirection = normalize(cameraPosition - worldPosition.xyz);
  vFacing = 0.55 + 0.45 * abs(dot(viewDirection.xz, normalize(vec2(cos(aRotation), sin(aRotation)))));
  vHeight = heightRatio;
  vShade = aShade;

  gl_Position = projectionMatrix * viewMatrix * worldPosition;
}

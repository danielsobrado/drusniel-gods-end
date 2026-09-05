# Water System

This document describes the water path recovered from the browser-delivered reference bundle and implemented on current `main`. For parity work, the recovered bundle is the source of truth; do not replace these formulas with a conventional ocean shader.

## Runtime construction

The reference does not render a `LakeWater` mesh from the GLB. It creates a dedicated plane:

```text
PlaneGeometry(400, 400, 128, 128)
rotation = [-PI/2, 0, 0]
position = [312.7059326171875, -17, 163.0625]
renderOrder = 1
```

The material is `MeshStandardNodeMaterial` with:

```text
side = FrontSide
transparent = true
depthWrite = false
name = LakeWater
```

`WaterCollider` remains the authored helper used for surface classification and the recovered Rapier collision path. It is not the visible lake.

## Effective reference parameters

These are the values passed by the recovered application bootstrap, after the water helper's defaults are overridden:

```yaml
water:
  size: 400
  segments: 128
  position: [312.7059326171875, -17, 163.0625]
  speed: 4
  waveHeight: 0.35
  swellHeight: 1
  swellLength: 26.7
  mediumHeight: 0.5
  mediumLength: 8.3
  smallHeight: 0.3
  smallLength: 4.6
  detailHeight: 0.085
  detailLength: 2.42
  microHeight: 0.05
  microLength: 2
  distortion: 1.45
  reflectionStrength: 0.9
  reflectionDistance: 1.2
  reflectionResolution: 1024
  reflectionNear: 0.1
  reflectionFar: 1000
  sunColor: '#ffffff'
  sunDirection: [0.707, 0.8, 0.25]
  sunStrength: 0
  deepColor: '#07344a'
  surfaceColor: '#033138'
  reflectionColor: '#1c9199'
  roughness: 0
  metalness: 0.48
  fresnelPower: 1
  fresnelStrength: 1
  rainRipples: true
  rainRippleStrength: 3
  rainRippleSize: 0.32
  rainRippleSpeed: 2.25
  rainRippleThickness: 0.08
  rainRippleFade: 0.55
  rainRippleDensity: 0.95
  rainRippleRandomness: 0.82
```

`distortion` is created as a uniform in the recovered material but is not consumed by the recovered shader graph. `reflectionDistance` is passed by the bootstrap but is not consumed by the material helper. They remain in configuration because that is what the original application passes.

## Reflection capture

The reference creates one cube reflection before adding the water mesh to the scene:

```text
CubeRenderTarget(1024)
generateMipmaps = true
minFilter = LinearMipmapLinearFilter
magFilter = LinearFilter
type = HalfFloatType
CubeCamera(0.1, 1000, target)
```

Capture sequence:

```text
scene.add(cubeCamera)
remember water.visible
water.visible = false
cubeCamera.position = water.getWorldPosition(...)
cubeCamera.update(renderer, scene)
restore water.visible
scene.remove(cubeCamera)
texture.mapping = CubeReflectionMapping
texture.colorSpace = SRGBColorSpace
```

The reflection is a one-time captured cube map, not a per-frame planar reflection.

## Wave function

Every component uses:

```text
k = 6.283185 / wavelength
phase = dot(point, direction) * k + scaledTime * phaseSpeed
s = sin(phase)
wave = (s * 0.75 + s^3 * 0.25) * amplitude
```

Eight literal directions are used without normalization:

```text
[ 1.00,  0.18]
[-0.35,  1.00]
[ 0.72,  0.65]
[-0.82,  0.28]
[ 0.35, -0.94]
[-0.62, -0.74]
[ 0.95, -0.28]
[-0.18,  0.98]
```

The ten components are:

```text
1  d1  swellLength       swellHeight       phase 0.42
2  d2  swellLength*1.35  swellHeight*0.55  phase 0.31
3  d3  mediumLength      mediumHeight      phase 0.64
4  d4  mediumLength*0.82 mediumHeight*0.52 phase 0.52
5  d5  smallLength       smallHeight*0.65  phase 0.91
6  d6  smallLength*0.72  smallHeight*0.42  phase 0.77
7  d7  detailLength      detailHeight      phase 1.45
8  d8  detailLength*0.72 detailHeight*0.55 phase 1.22
9  d1  microLength       microHeight       phase 2.15
10 d4  microLength*1.35  microHeight*0.45  phase 1.82
```

Their sum is multiplied by `waveHeight`.

Vertex displacement is exact:

```text
height = waves(positionLocal.xy, time * speed)
positionNode = positionLocal + vec3(0, 0, height)
```

Because the plane is rotated by `-PI/2`, local Z displacement becomes vertical displacement in world space.

## Wave normal

The non-rain normal is a finite difference of the same wave function:

```text
epsilon = 0.08
h  = waves(p, t)
hx = waves(p + [epsilon,0], t)
hy = waves(p + [0,epsilon], t)
dx = (hx-h)/epsilon
dy = (hy-h)/epsilon
normal = normalize([-dx,-dy,1])
```

It is converted with `transformNormalToView`.

## Rain ripple normal

When rain is active, the original builds a second TSL normal graph from procedural cell ripples:

```text
p = positionLocal.xy * rainRippleDensity
cell = floor(p)
local = fract(p) - 0.5
randomA = fract(sin(dot(cell,[127.1,311.7])) * 43758.5453)
randomB = fract(sin(dot(cell,[269.5,183.3])) * 43758.5453)
offset = ([randomA-0.5, randomB-0.5]) * rainRippleRandomness
delta = local - offset
distance = length(delta)
phase = fract(time * rainRippleSpeed + randomA)
radius = phase * rainRippleSize
ring = 1 - smoothstep(0, rainRippleThickness, abs(distance-radius))
fade = pow(1-phase, rainRippleFade)
strength = ring * fade * rainRippleStrength
direction = delta / max(distance, 0.001)
rippleNormal = normalize([-direction.x*strength, -direction.y*strength, 1])
```

The rain normal is:

```text
normalize(waveNormal + rippleNormal - [0,0,1])
```

then transformed to view space.

The environment transition continuously drives rain intensity. Water enables the rain-normal graph above `0.001` and interpolates `rainRippleThickness` from `0` to `0.08` with intensity.

## Fresnel, reflection and color

```text
n = normalize(normalWorld)
view = normalize(cameraPosition-positionWorld)
facing = max(dot(n,view),0)
fresnel = pow(1-facing, fresnelPower)
base = mix(deepColor, surfaceColor, fresnel*fresnelStrength)
```

When the cube reflection is present:

```text
reflectionDirection = normalize(reflect(-view,n))
reflectionRgb = cubeTexture.sample(reflectionDirection).rgb
```

Otherwise `reflectionColor` is used.

Sun terms are also present in the recovered graph:

```text
specular = pow(sunFacing,90) * sunColor * sunStrength
glint = pow(sunFacing,12) * sunColor * sunStrength * 0.15
diffuse = max(dot(sunDirection,n),0) * sunColor * 0.12
```

The runtime bootstrap sets `sunStrength = 0`, so specular/glint are disabled in the reference state while the diffuse term remains as written by the shader.

Final color:

```text
reflection = reflectionRgb * reflectionStrength
reflected = reflection + specular + glint
color = mix(base + diffuse, reflected, fresnel * reflectionStrength)
```

## Terrain-dependent opacity

Water opacity samples the same terrain-height texture used by grass:

```text
terrainUv = (positionWorld.xz - terrainBounds.min.xz) / terrainBoundsSize
terrainHeight = mix(minHeight, maxHeight, texture(heightTexture, terrainUv).r)
waterLevel = -17
depth = terrainHeight - waterLevel
shoreBlend = smoothstep(-3, 0, depth)
opacity = mix(1, 0.65, shoreBlend)
```

The recovered code does not clamp the terrain UV before sampling.

## Material response

The runtime material uses:

```text
roughness = 0
metalness = 0.48
```

Emissive edge response:

```text
facing = max(dot(normalize(normalWorld), normalize(cameraPosition-positionWorld)), 0)
edge = pow(1-facing,4)
emissive = [0.003,0.015,0.018] * edge
```

## Surface classification

`WaterCollider` is still resolved from the terrain GLB and converted to a world `Box3`. The current player surface priority remains:

```text
water -> grass -> mud
```

The classifier keeps the existing vertical allowance:

```text
position.y <= bounds.max.y + 1.5
```

## Lifecycle

The original demo is single-mount and does not expose disposal. Current `main` keeps the W4 lifecycle improvement: disposing the water removes the generated mesh and releases its geometry, node material and cube render target. This does not change rendered parity.

## Verification checklist

- visible lake is a generated 400x400 plane, not `LakeWater` from the GLB,
- plane has 128x128 segments and the exact recovered transform,
- reflection is a one-time 1024 cube capture,
- ten recovered wave components drive vertex displacement,
- finite-difference wave normals use epsilon 0.08,
- rain uses the recovered cell/ring normal formula,
- rain intensity continuously controls ripple thickness,
- color uses Fresnel plus the captured cube reflection,
- opacity samples terrain height and uses `smoothstep(-3,0,depth)`,
- roughness is 0 and metalness is 0.48,
- `FrontSide`, transparent, `depthWrite=false`, render order 1,
- `WaterCollider` remains the classifier/collision helper,
- no CPU `update()` is required because TSL `time` drives animation.

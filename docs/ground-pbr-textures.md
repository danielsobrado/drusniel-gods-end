# Ground PBR Textures

This document describes the recovered ground material and the default cinematic turf treatment, including the rain-ripple normal path.

## Cinematic turf

With cinematic rendering enabled, `src/rendering/GroundTurf.js` blends three grass texture samples with different rotations, offsets and scales. Smooth world-space noise varies the blend and bends the texture coordinates, breaking up the repeated square tiles without adding texture assets.

The styled meadow also uses irregular fibres and small tufts for pigment and surface normals. Smooth random heights replace the former crossed sine waves, which produced a woven grid. Each detail band fades with its screen-space footprint to keep distant ground from shimmering. The shared meadow palette, grass/soil mask and wet roughness remain in use.

The recovered UV scales below still set the texture density; disabling cinematic rendering retains the original single grass sample. `scripts/gpu/ground-check.html` checks close-range detail, distant filtering and dry/wet roughness on the GPU.

## Source files

```text
src/world/GroundMaterial.js
src/world/createWorld.js
src/world/EnvironmentController.js
public/ground-material.yaml
public/visual-parity.yaml
```

## Texture inputs

The recovered material loads exactly five textures:

```text
Assets/grass.jpg
Assets/ground/ground_0109_color_1k.jpg
Assets/blend2.jpg
Assets/ground/ground_0109_normal_directx_1k.jpg
Assets/ground/ground_0109_roughness_1k.jpg
```

Grass and ground colors use sRGB. Normal, roughness and the blend mask use `NoColorSpace`. Grass/color/normal/roughness textures repeat with mipmaps and anisotropy `16`; the blend mask is clamped, `flipY = false`, and uses mipmaps plus linear filtering.

## UVs and base PBR

Recovered UV scales are fixed:

```text
grass UV = uv * 150
ground UV = uv * 70
blend UV = uv
```

The base material is `MeshStandardNodeMaterial`:

```text
color = mix(grassColor.rgb, groundColor.rgb, blend.r)
baseNormal = normalMap(groundNormal, vec2(blend.r))
roughness = mix(1, groundRoughness.r, blend.r)
metalness = 0.5
```

Mask meaning:

```text
black -> grass-textured ground and procedural grass allowed
white -> exposed dirt PBR and procedural grass suppressed
```

`createWorld()` applies the same material to the configured `Landscape002` and `Landscape046` targets when present.

## Recovered rain-ripple configuration

<!-- effective-config: ground.rainRipple -->
```yaml
scale: 1.5
size: 0.38
thickness: 0.1
strength: 3
speed: 2
amount: 0.7
```

The material stores each value as a TSL uniform and exposes them through `material.userData`, together with `setRain(enabled)`.

## Impact-ring normal shader

When rain is enabled, world XZ is divided into procedural cells:

```text
p = positionWorld.xz * rippleScale
cell = floor(p)
local = fract(p) - 0.5
```

Two deterministic hashes are recovered:

```text
h1 = fract(sin(dot(cell, [127.1, 311.7])) * 43758.5453)
h2 = fract(sin(dot(cell, [269.5, 183.3])) * 43758.5453)
```

A cell participates only when:

```text
enabled = step(h1, rippleAmount)
```

This is why `rippleAmount` acts as spatial rain density rather than simply a strength multiplier.

Time evolves as:

```text
timer = time * rippleSpeed + h2
cycle = floor(timer)
phase = fract(timer)
```

Each cycle gets a new impact offset using two more recovered hashes:

```text
offsetX = fract(sin(dot(cell + cycle, [157.3, 271.9])) * 43758.5453)
offsetY = fract(sin(dot(cell + cycle, [381.7, 129.4])) * 43758.5453)
offset = ([offsetX, offsetY] - 0.5) * 0.65
```

The expanding ring is:

```text
delta = local - offset
distance = length(delta)
radius = phase * rippleSize
ring = 1 - smoothstep(0, rippleThickness, abs(distance - radius))
fade = 1 - phase
strength = ring * fade * rippleStrength * enabled
```

The perturbation is added to the existing ground normal and normalized:

```text
direction = delta / max(distance, 0.001)
perturbation = [-direction.x * strength, 0, -direction.y * strength]
rainNormal = normalize(baseNormal + perturbation)
```

This is a normal-only effect. It does not displace terrain geometry.

## Rain activation and transition

`EnvironmentController` drives two separate values:

```text
setRain(rainIntensity > 0.001)
rippleAmount = lerp(0, 0.7, rainIntensity)
```

`setRain(false)` restores the exact base normal node. `setRain(true)` switches to the recovered procedural ripple node and marks the node material for recompilation. The ripple node is built lazily and reused thereafter.

The continuously varying `rippleAmount` controls how many procedural cells are active during the five-second environment transition.

## Wet roughness

Ground ripple normals are only one part of the recovered rain response. The environment controller also traverses ordinary scene meshes and interpolates their scalar material roughness toward a wet target:

```text
roughness = lerp(originalRoughness, rainRoughness, rainIntensity)
```

Meshes can override the default wet target through `userData.rainRoughness`; otherwise the recovered fallback is `0.2`.

This roughness pass is separate from `GroundMaterial.roughnessNode`. The ground PBR node continues to use its recovered texture blend while scene materials that expose scalar `roughness` receive the wet interpolation.

## Painter relationship

GroundMaterial loads its own `blend2.jpg` texture. The grass painter maintains its own mask texture, so painting procedural grass does not currently rewrite this ground material's blend texture. That is existing behavior and is not silently changed by the rain parity pass.

## Reproduction checklist

- exact five texture inputs,
- sRGB/non-color assignments and wrapping/filtering,
- UV scales 150 / 70 / base mask,
- base color/normal/roughness/metalness formulas,
- procedural rain normal only while rain is active,
- exact four hash vectors and hash multiplier,
- cycle-dependent impact offset,
- `rippleAmount` continuously scaled `0..0.7`,
- no terrain vertex displacement from rain,
- base normal restored exactly when rain stops.

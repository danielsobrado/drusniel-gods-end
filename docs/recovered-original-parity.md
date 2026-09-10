# Recovered Original Parity Specification

This document records behavior recovered directly from the browser-delivered obfuscated JavaScript. For parity work, recovered behavior takes precedence over earlier clean-room assumptions.

## Evidence priority

When reproducing the reference demo, use this order:

1. recovered browser-delivered code,
2. recovered literal asset/object names and constants,
3. current executable code implementing that recovered behavior,
4. merged YAML configuration,
5. subsystem documentation,
6. visual inference from screenshots.

Do not replace a recovered formula with a more conventional implementation just because it looks cleaner.

## Ground material

The original loads exactly these five textures:

```text
/Assets/grass.jpg
/Assets/ground/ground_0008_color_1k2.jpg
/Assets/blend2.jpg
/Assets/ground/ground_0008_normal_directx_1k.jpg
/Assets/ground/ground_0008_roughness_1k.jpg
```

Texture setup:

```text
grass/color: sRGB, RepeatWrapping, mipmaps, linear mip filtering, anisotropy 16
ground/color: sRGB, RepeatWrapping, mipmaps, linear mip filtering, anisotropy 16
normal/roughness: NoColorSpace, RepeatWrapping, mipmaps, linear mip filtering, anisotropy 16
blend mask: NoColorSpace, flipY false, ClampToEdgeWrapping, mipmaps, linear filtering (the grass mask is a separate canvas texture with flipY true)
```

UVs:

```text
grass UV = uv * 150
ground UV = uv * 70
blend UV = uv
```

Material:

```text
color = mix(grassColor.rgb, groundColor.rgb, blend.r)
normal = normalMap(groundNormal, vec2(blend.r))
roughness = mix(1, groundRoughness.r, blend.r)
metalness = 0.5
```

Mask convention:

```text
black -> grass-textured ground + procedural grass
white -> exposed dirt PBR + procedural grass suppressed
```

The original assigns this material directly to `Landscape002` and `Landscape046`. It does not replace the GLB terrain with a newly generated visible plane.

The original also adds rain-ripple normal perturbation to the terrain material when rain is active. That path should be retained/recovered when rain parity is being validated.

## Blade geometry

Blade mode uses a segmented tapered strip.

For `detail = N`, segment `i` uses:

```text
ratio = i / N
nextRatio = (i + 1) / N
halfWidth = (1 - ratio) * 0.5
nextHalfWidth = (1 - nextRatio) * 0.5
```

Non-final segment vertices:

```text
(-halfWidth,     ratio,     0)
( halfWidth,     ratio,     0)
(-nextHalfWidth, nextRatio, 0)
( nextHalfWidth, nextRatio, 0)
```

The recovered generator stored the next-ring pair again on the following segment (`4N - 1` vertices at detail `N`). The current template indexes the same positions once (`2N + 1` vertices). Triangle count, winding and silhouette are unchanged. The final segment is a triangle. Vertex normals are generated with `computeVertexNormals()`.

Instance grid:

```text
gridCount = floor(tileSize * density)
```

Blade placement is deterministic:

```text
hash(x,y) = fract(sin(x*127.1 + y*311.7) * 43758.5453123)
jitterX = hash(gridX, gridZ)
jitterZ = hash(gridX + 1, gridZ)
rotation = hash(gridX + 2, gridZ) * 2PI
```

Per-instance attributes:

```text
instancePosition = [x, 0, z]
instanceRotation = [sin(rotation), cos(rotation)]
instanceData = [0, 0, noise(x*0.2,z*0.2)*2PI, noise(x*0.3,z*0.3)]
```

The original uses `StorageInstancedBufferAttribute` for instance position, rotation and data.

## Billboard geometry

The recovered original uses **one quad**, not two crossed quads.

Vertices:

```text
(-0.5, 0, 0)
( 0.5, 0, 0)
(-0.5, 1, 0)
( 0.5, 1, 0)
```

Indices:

```text
0,1,2, 2,1,3
```

Normals are `(0,0,1)`.

Billboard instance placement deliberately uses `Math.random()` rather than the deterministic blade hash:

```text
jitterX = Math.random()
jitterZ = Math.random()
rotation = Math.random() * 2PI
atlasVariant = floor(Math.random() * 4)
instanceData.z = noise(x*0.2,z*0.2)*2PI
instanceData.w = noise(x*0.1,z*0.1)
```

## Terrain sampling inside grass shader

The original grass materials sample a terrain height texture. World XZ is converted to terrain UV from terrain bounds; the red channel is mixed between `minHeight` and `maxHeight`.

The grass shader also receives the camera view-projection matrix and performs per-instance shader visibility checks in addition to CPU/tile-level management.

Invisible instances are moved to a very large position (`vec3(1e9)`).

## Grass mask

Grass strength is:

```text
grassStrength = 1 - grassMap.r
```

The recovered shader uses a hard cutoff:

```text
if grassStrength < 0.05:
    move instance to vec3(1e9)
```

Do not replace this with a soft `smoothstep` threshold when matching the original.

Blade width is multiplied by `sqrt(grassStrength)`. Vertical displacement from terrain is also multiplied by grass strength.

## Near/far detail split

For blade mode:

```text
detailMaxDistance = maxDistance * 0.5
windNoiseMaxDistance = maxDistance * 0.7
```

These are hard shader branches in the recovered code, not smooth transitions.

Near blade height variation:

```text
hA = fract(sin(dot(worldXZ*0.15, vec2(0.9898,0.2330))) * 43758.5453)
hB = fract(sin(dot(worldXZ,      vec2(0.3468,0.1357))) * 24634.6345)
n = pow(hA*0.7 + hB*0.3, 0.6)
heightVariation = mix(0.1, 0.5, n)
```

Outside that distance, height variation is `1`.

Billboard mode uses the same hashes but:

```text
heightVariation = mix(0.1, 1.8, n)
```

## Interaction

The interaction texture is sampled in player-centered world space.

```text
amount = smoothstep(0, 0.15, influence)
```

A deterministic bend direction is generated from world XZ.

Blade interaction uses a maximum curve of `3 * PI/2` over blade height. Billboard interaction uses `PI`.

The blade path guards interaction-map UVs to `[0,1]` before sampling. The billboard path clamps and samples directly.

## Blade wind

Near path (`distance <= maxDistance*0.7`):

- coherent 2D gradient noise,
- second sample offset by `(0.7, 0.3)`,
- noise centered from `[0,1]` to `[-1,1]`,
- rotated by configured wind direction,
- normalized direction,
- angle magnitude `noiseMagnitude * 0.3 * windIntensity * grassStrength * PI/2`.

Far path:

```text
clock = time * simulationSpeed * 2
waveA = sin(alongWind * windNoiseScale + clock)
waveB = cos(acrossWind * windNoiseScale * 0.5 + clock * 0.7)
gust = (waveA*0.5+0.5) * (waveB*0.25+0.75) * 0.3
windDirection = normalize(mix(globalWindDirection, randomBladeDirection, 0.2))
angle = gust * windIntensity * grassStrength * PI/2
```

Blade bend power is:

```text
pow(uv.y, bladeStiffness)
```

Static `baseBend` and dynamic wind are applied separately.

## Billboard wind

Billboard wind also uses hard near/far branching.

Differences from blade mode include:

```text
bend power = pow(uv.y, 3)
far gust multiplier = 0.2
near normalized wind direction is mixed 20% toward the instance random direction
```

## Blade color

Recovered procedural blade color:

```text
heightBrightness =
    (1 - pow(1-y, 1.8) * 0.6)
    * (smoothstep(0,0.08,y) * 0.7 + 0.3)

colorHeight = pow(clamp(y + (variation-0.5)*0.35, 0, 1), 3)
base = baseColor * mix(0.96,1.04,variation)
tip  = tipColor  * mix(0.98,1.02,variation)
tint = mix(vec3(0.98,0.99,0.96), vec3(1.02,1.01,1.0), variation)
color = mix(base,tip,colorHeight) * tint * heightBrightness
```

Sheen is a view-dependent **color highlight**, not a roughness override:

```text
sheen = pow(1-clamp(dot(normal,viewDirection),0,1),5)
      * smoothstep(0.8,1.0,y)
      * sheenAmount
color += vec3(sheen)
```

The recovered blade material does not assign a custom roughness node.

## Billboard color and atlas

Atlas defaults:

```text
columns = 2
rows = 2
padding = 0.03
alpha test = 0.5
```

If `useTextureColor` is enabled, atlas RGB is used. Otherwise the procedural billboard gradient uses:

```text
colorHeight shift = (variation-0.5)*0.2
colorHeight exponent = 3
base multiplier = mix(0.95,1.04,variation)
tip multiplier = mix(0.98,1.02,variation)
tint = mix(vec3(0.95,0.98,0.92), vec3(1.05,1.02,0.95), variation)
```

Billboard sheen uses a fixed recovered amount of `0.25` in the material constructor.

## Sunny baseline

Recovered Sunny blade values:

```yaml
bladeHeight: 1.5
bladeWidth: 0.2
bladeStiffness: 1
baseBend: 0
windIntensity: 1.7
windDirection: 0
windNoiseScale: 0.3
simulationSpeed: 1
baseColor: '#304f0b'
tipColor: '#74a116'
sheen: 0.25
```

Recovered High/Blade LOD:

```yaml
maxDistance: 140
high:    { detail: 5, density: 4.5, distance: 0.3 }
medium:  { detail: 2, density: 3,   distance: 0.5 }
low:     { detail: 1, density: 2,   distance: 0.9 }
veryLow: { detail: 1, density: 1,   distance: 1.0 }
```

## Documentation maintenance rule

When a subsystem is changed for reference parity:

1. compare it against recovered code first,
2. update implementation and subsystem documentation together,
3. remove earlier guessed behavior once the original behavior has been recovered,
4. do not describe a current fallback as original behavior.

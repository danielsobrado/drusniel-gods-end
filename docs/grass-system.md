# Grass System

This document describes the grass renderer exactly as implemented on current `main`. It is the master technical specification for reproducing the grass look: tile layout, instance generation, blade geometry, billboard geometry, terrain placement, mask semantics, TSL material deformation, LOD, CPU culling, interaction integration, quality switching, painter integration and current non-features.

For the detailed wind math, read `docs/wind-system.md`. For temporary foot deformation, read `docs/grass-interaction.md`. For editing the permanent mask, read `docs/grass-painter.md`.

## Source files

```text
src/grass/GrassField.js
src/grass/GrassGeometryFactory.js
src/grass/GrassGeometry.js
src/grass/GrassTile.js
src/grass/GrassMaterial.js
src/grass/GrassMask.js
src/grass/InteractionMap.js
src/grass/GrassPainter.js
src/world/TerrainSampler.js
src/world/EnvironmentController.js
src/app/GrassDemo.js
public/config.yaml
```

---

# Architecture

## 1. High-level pipeline

```text
terrain GLB
   |
   v
TerrainSampler
   |------------------------------+
   |                              |
   v                              v
CPU height grid              RGBA8 height texture
                                  |
blend2.jpg                        |
   |                              |
   v                              |
GrassMask CanvasTexture           |
   |                              |
   +-------------------+----------+
                       |
player influence points |
   |                    |
   v                    |
InteractionMap DataTexture
   |                    |
   +---------+----------+
             |
             v
       GrassMaterial TSL
             ^
             |
       GrassTile pool
             ^
             |
      four LOD geometries
             ^
             |
     GrassGeometryFactory
```

The field is not one world-sized mesh and does not create one Three.js object per blade.

The runtime uses a reusable square grid of tile meshes centered around the **camera**. Each tile references one of four shared `InstancedBufferGeometry` objects and all tiles share one node material.

---

## 2. GrassField construction

`GrassField` stores:

```text
scene
camera
renderer
config
terrainSampler
active type
active quality name
tile array
empty-tile key Set
current camera tile coordinate
Frustum
projectionView Matrix4
temporary tile Sphere
GrassMask
InteractionMap
GrassGeometryFactory
LOD geometry cache
GrassMaterial controller
optional GrassPainter
```

Initial type:

```yaml
grass:
  type: blade
```

Initial quality:

```yaml
ui:
  initialQuality: high
```

---

# Initialization

## 3. `GrassField.init()` exact order

```text
1. await GrassMask.load()
2. create GrassMaterial(config, terrainSampler, mask, interactionMap)
3. apply initial quality profile
   3a. rebuild four LOD geometries
   3b. rebuild tile pool
   3c. set material max distance
   3d. enable shadows globally
   3e. apply selected shadow-map size to DirectionalLight shadows
   3f. classify current tiles as empty/non-empty
4. return field
```

Painter is attached later by `GrassDemo` after grass initialization.

---

# Permanent Grass Mask

## 4. Mask asset and convention

Current asset:

```text
Assets/blend2.jpg
```

The mask is loaded into a canvas at painter resolution:

```yaml
painter:
  resolution: 512
```

Convention:

```text
black / red=0   -> full grass
white / red=255 -> no grass
```

CPU sample returns:

```text
grassStrength = 1 - red/255
```

This same black/white convention is coordinated with the ground blend material.

---

## 5. Mask texture settings

`GrassMask` exposes a `THREE.CanvasTexture` using:

```text
NoColorSpace
flipY = true
LinearFilter min/mag
ClampToEdgeWrapping S/T
```

`flipY = true` means row 0 of the backing canvas is the top of the image and therefore
the **maximum** world z. Any CPU sampler must apply the same inversion.

`GrassMask` owns a second, derived texture with identical settings, `VegetationMask`
(`vegetationTexture`): the painted mask dilated by `grass.pathClearance` and hardened by
`grass.vegetationCutoff`. The material samples that one; the ground blend material keeps
sampling the raw painted JPEG, so the visible dirt keeps its authored width while
vegetation recedes a further clearance from it.

The CPU side keeps refreshed `ImageData` for `sampleWorld()` and tile emptiness checks.

---

## 6. World-to-mask coordinates

`GrassMask.worldToUv(x,z)` delegates to `TerrainSampler.worldToUv()`:

```text
u = clamp((x - terrainMinX) / terrainSizeX, 0, 1)
v = clamp((z - terrainMinZ) / terrainSizeZ, 0, 1)
```

`GrassMask.sampleWorld()` does not use that helper. It samples the vegetation mask
directly, bilinearly and with the `flipY` inversion, so that the CPU and the shader
agree on where a path is:

```text
col = ((x - terrainMinX) / terrainSizeX) * (width  - 1)
row = (1 - (z - terrainMinZ) / terrainSizeZ) * (height - 1)
```

It returns 0 outside the terrain bounds.

Then optional painter flips are applied:

```text
if flipU -> u = 1-u
if flipV -> v = 1-v
```

Current:

```text
flipU = false
flipV = false
```

The grass TSL material itself samples terrain/mask UV from terrain bounds directly. With current no-flip configuration, CPU and GPU conventions align.

---

## 7. CPU mask sampling

Pixel coordinate:

```text
px = clamp(round(u * (resolution-1)), 0, resolution-1)
py = clamp(round(v * (resolution-1)), 0, resolution-1)
```

Then:

```text
raw = redByte / 255
return 1 - raw
```

This CPU value is used for surface classification and empty-tile checks.

---

## 8. Empty-tile classification

`GrassMask.createEmptyTileSet()` scans the vegetation mask pixel by pixel per terrain
tile and records tiles whose every pixel is above the cutoff, i.e. tiles that are
entirely path. `GrassField.remapEmptyTiles()` skips it when `cinematic.enabled`, where
per-instance compaction covers the same ground more precisely.

Legacy threshold, no longer read:

```text
0.08
```

This is a cheap CPU approximation. A tile can contain a very small black patch between those nine sample points and still be classified empty.

---

# Geometry Generation

## 9. GrassGeometryFactory

The factory is deliberately thin.

It forwards:

```text
type
detail
density
config.grass.tileSize
```

into `createGrassGeometry()`.

The same generator is used for all quality profiles and both grass modes.

---

## 10. Tile size

Current:

```yaml
grass:
  tileSize: 25
```

Every cached LOD geometry is generated for a local 25x25 tile footprint.

Tile mesh world position shifts that local geometry around the terrain.

---

## 11. Blade template construction

For blade type:

```text
segments = max(1, round(detail))
```

For every segment, local vertical ratios are:

```text
ratio = segment / segments
nextRatio = (segment+1) / segments
```

Half-width tapers linearly:

```text
halfWidth = (1-ratio) * 0.5
nextHalfWidth = (1-nextRatio) * 0.5
```

The base template is normalized to:

```text
height 0..1
width approximately -0.5..+0.5 at root
```

Actual configured width/height are applied later in the TSL material.

---

## 12. Blade template topology

For each segment except the last, geometry adds a quad-like two-triangle section.

The final segment terminates in one triangle at zero tip width.

For `segments = S`:

```text
unique stored vertices in generated template = 4S - 1
triangles per blade template = 2S - 1
```

Examples:

```text
detail 1 -> 3 vertices, 1 triangle
detail 2 -> 7 vertices, 3 triangles
detail 3 -> 11 vertices, 5 triangles
detail 4 -> 15 vertices, 7 triangles
detail 5 -> 19 vertices, 9 triangles
```

Higher detail provides more vertices for smooth wind/base/interactions bends.

---

## 13. Billboard template

Billboard mode ignores blade `detail` for template shape.

It creates two quads at angles:

```text
0
PI/2
```

Each quad has four vertices and two triangles.

Combined billboard template:

```text
8 vertices
4 triangles
```

This is a crossed-card shape, not a camera-facing sprite implemented in the shader.

---

## 14. Template attributes

Base geometry stores:

```text
position
uv
bladeSide
normal
index
```

`bladeSide` values are -1/+1 across the strip/card sides. `GrassMaterial.js` declares the attribute and consumes it in `normalNode`, where it flips the side direction so the two faces of a blade receive opposing normals.

Normals are computed with `computeVertexNormals()` before transferring into the instanced geometry.

---

# Instance Distribution

## 15. Density formula

Per LOD geometry:

```text
gridCount = max(1, floor(tileSize * density))
instanceCount = gridCount * gridCount
```

Density therefore has **quadratic** cost.

This exact formula is more important than the legacy config key `instancesPerDensityUnit`, which current `GrassGeometry.js` does not use.

---

## 16. Current High-quality blade instance counts per tile

With tile size 25:

```text
High LOD:
  density 4.5
  floor(25*4.5)=112
  112^2 = 12,544 instances/tile

Medium:
  density 3
  75^2 = 5,625

Low:
  density 2
  50^2 = 2,500

VeryLow:
  density 1
  25^2 = 625
```

A density change that looks small numerically can materially change triangle count.

---

## 17. Jittered deterministic grid

Instances are not placed with `Math.random()`.

For grid cell `(gridX,gridZ)`:

```text
x = -halfSize + (gridX + hash2d(gridX, gridZ)) / density
z = -halfSize + (gridZ + hash2d(gridX+1, gridZ)) / density
```

This creates a deterministic jittered grid.

Advantages for parity:

```text
same field after reload
stable screenshots
no clumping from unconstrained random placement
roughly even density
```

---

## 18. Deterministic instance rotation

Angle:

```text
angle = hash2d(gridX+2, gridZ) * 2PI
```

Stored as:

```text
instanceRotation.x = sin(angle)
instanceRotation.y = cos(angle)
```

The TSL material reconstructs a 2D Y-axis rotation from these values without evaluating sine/cosine per vertex.

---

## 19. Instance data vector

`instanceData` is a `vec4` per instance.

Current values:

```text
x = 0
y = 0
z = gradientNoise2d(x*0.2, z*0.2) * 2PI
w = gradientNoise2d(x*0.3, z*0.3)
```

Current material uses:

```text
instanceData.z -> deterministic random base-bend direction
instanceData.w -> color variation
```

X/Y components are currently reserved/unused in the material path.

---

## 20. Instanced geometry attributes

Each generated `InstancedBufferGeometry` receives:

```text
instancePosition : vec3
instanceRotation : vec2
instanceData     : vec4
```

It also stores:

```text
geometry.instanceCount
gometry.userData.instanceCount
geometry.userData.lod = { type, detail, density }
```

and computes a bounding sphere.

The base non-instanced template geometry is disposed after transfer.

---

# Grass Tiles

## 21. GrassTile mesh settings

Each tile is one:

```text
THREE.Mesh(instancedGeometry, sharedMaterial)
```

Current flags:

```text
frustumCulled = false
castShadow = false
receiveShadow = true
```

Frustum culling is deliberately handled by `GrassField` with a custom sphere rather than Three.js automatic mesh bounds.

User data initialized as:

```text
currentLOD = 'veryLow'
tileX = 0
tileZ = 0
```

---

## 22. Shared geometry/material model

Tiles do not own unique LOD geometry.

For active quality/type, `GrassField` builds exactly four cached geometries:

```text
high
medium
low
veryLow
```

Every tile swaps its `.geometry` reference to one of those shared objects.

All tiles share one `GrassMaterial.material`.

This is central to performance and should not be replaced by unique per-tile materials/geometries during parity work.

---

# Tile Pool Size

## 23. Grid-size formula

For current quality/type:

```text
gridSizeRaw = (maxDistance * 2) / tileSize
rounded = max(1, ceil(gridSizeRaw))
if rounded even -> rounded + 1
else rounded
```

The result is always odd so one logical tile sits at the center of the square pool.

Tile count:

```text
gridSize^2
```

---

## 24. Current grid sizes

### Blade

```text
Performance maxDistance 80
  (160/25)=6.4 -> ceil 7 -> grid 7x7 = 49 tiles

Balanced maxDistance 100
  200/25=8 -> even -> grid 9x9 = 81

High maxDistance 140
  280/25=11.2 -> ceil 12 -> oddify 13 -> 169

Ultra maxDistance 220
  440/25=17.6 -> ceil18 -> oddify19 -> 361
```

### Billboard

```text
Performance maxDistance 120
  240/25=9.6 -> ceil10 -> 11x11 = 121

Balanced maxDistance 140
  -> 13x13 = 169

High maxDistance 160
  320/25=12.8 -> ceil13 -> 13x13 = 169

Ultra maxDistance 220
  -> 19x19 = 361
```

Most pool tiles are not necessarily visible at once because distance/mask/bounds/frustum tests still apply.

---

# Camera-centered Repositioning

## 25. Terrain-centered tile coordinate system

Terrain center is:

```text
terrainSampler.bounds.getCenter()
```

Current camera logical tile coordinate:

```text
centerTileX = floor((camera.x - terrainCenter.x) / tileSize)
centerTileZ = floor((camera.z - terrainCenter.z) / tileSize)
```

The pool recenters only when either integer coordinate changes.

---

## 26. Reposition formula

For grid coordinates around the pool:

```text
half = floor(gridSize/2)
tileX = centerTileX + gridX - half
tileZ = centerTileZ + gridZ - half

worldX = terrainCenter.x + tileX * tileSize
worldZ = terrainCenter.z + tileZ * tileSize
```

Tile mesh position becomes:

```text
(worldX, 0, worldZ)
```

Individual blade Y is later produced by the terrain height texture in the material.

---

## 27. Empty-tile cache key

Each tile uses:

```text
`${tileX}:${tileZ}`
```

as the key in `emptyTiles`.

After a recenter, or after painter changes, all current tile positions are re-evaluated with the mask's 3x3 tile test.

---

# CPU Visibility and LOD

## 28. Maximum distance test

For each tile center:

```text
dx = tileXWorld - cameraX
dz = tileZWorld - cameraZ
distanceSquared = dx^2 + dz^2
```

Visible requires:

```text
distanceSquared <= maxDistance^2
```

Only X/Z distance is considered.

---

## 29. Terrain-bounds test

Visible also requires:

```text
terrainSampler.contains(tileWorldX, tileWorldZ, -tileSize)
```

Because padding is **negative**, this expands allowable center bounds by one tile size.

This intentionally permits edge tiles whose centers are slightly outside the strict terrain rectangle so blades near the border can still cover the edge.

---

## 30. Manual frustum sphere

Tile sphere center:

```text
(tileWorldX,
 terrainSampler.sampleHeight(tileWorldX,tileWorldZ) + 1.5,
 tileWorldZ)
```

Radius:

```text
tileSize * 0.82
```

For current tile size 25:

```text
radius = 20.5
```

Visible requires:

```text
cameraFrustum.intersectsSphere(tileSphere)
```

Before tests, camera world matrix is updated and frustum is built from:

```text
projectionMatrix * matrixWorldInverse
```

---

## 31. Full visible condition

```text
within distance
AND not in emptyTiles
AND terrain contains expanded tile center
AND frustum intersects tile sphere
```

Failure hides tile before any LOD geometry selection.

---

## 32. LOD normalized distance

For visible tile:

```text
normalizedDistance = sqrt(distanceSquared) / maxDistance
```

The system evaluates LOD names in exact order:

```text
high
medium
low
veryLow
```

It returns the first whose configured `distance` is >= normalizedDistance.

If none matches, returns `veryLow`.

---

## 33. Current High / Blade LOD bands

Configuration:

```yaml
high:     { detail: 5, density: 4.5, distance: 0.3 }
medium:   { detail: 2, density: 3,   distance: 0.5 }
low:      { detail: 1, density: 2,   distance: 0.9 }
veryLow:  { detail: 1, density: 1,   distance: 1.0 }
maxDistance: 140
```

Approximate world distance boundaries:

```text
High      <= 42
Medium    <= 70
Low       <= 126
VeryLow   <= 140
Culled    > 140
```

See `docs/lod-system.md` for every profile/type.

---

## 34. Painter LOD override

When painter is enabled:

```text
lodName = 'low'
```

for every visible tile, bypassing distance-based selection.

This makes editing cost/presentation more stable.

---

# Terrain Placement in the TSL Material

## 35. World XZ per grass instance

Inside `GrassMaterial`:

```text
worldXZ = modelPosition.xz + instancePosition.xz
```

`modelPosition` comes from tile mesh position.

Instance position is local within the 25x25 tile.

---

## 36. Terrain UV

```text
terrainUv = clamp(
  (worldXZ - terrainMin) / terrainSize,
  0,
  1
)
```

This texture-space convention matches the height texture generated by `TerrainSampler`.

---

## 37. Terrain height reconstruction

Height texture red channel is normalized 0..1.

Shader reconstructs:

```text
sampledHeight = heightTexture.r * heightRange + minHeight
```

where:

```text
heightRange = max(0.0001, maxHeight - minHeight)
```

The grass therefore uses the 8-bit GPU height texture, not CPU raycasts per blade.

---

# Mask Use in Material

## 38. Shader grass strength

```text
raw           = clamp(1 - vegetationTexture.r, 0, 1)
grassStrength = raw * smoothstep(vegetationCutoff, vegetationCutoff + maskSoftness, raw)
```

A blade whose `grassStrength` reaches 0 is pushed out of the world. Because this is a
gate rather than a rescale, strength above `vegetationCutoff + maskSoftness` is
unchanged and only the path fringe is removed.

Current values:

```text
vegetationCutoff 0.3
maskSoftness     0.12
```

`vegetationPolicy.vegetationStrength()` is the CPU twin of this expression, and both the
blade and billboard position nodes go through the same helper.

---

## 39. Hidden blade strategy

Instances are not rebuilt or removed when mask hides them.

The final Y includes:

```text
-(1 - visibility) * 1000
```

So fully hidden instances are moved far below terrain.

At the same time effectiveStrength reduces width/height/bending as the mask approaches the threshold.

---

# Blade Shape in Material

## 40. Width scale

```text
widthScale = bladeWidth * sqrt(effectiveStrength)
```

Local X begins as:

```text
positionLocal.x * widthScale
```

This means partially masked grass narrows nonlinearly as strength decreases.

---

## 41. Base local height

Before base-bend/wind vertical drop:

```text
localY = positionLocal.y
       * cos(interactionCurve)
       * bladeHeight
```

Interaction can therefore lower the blade before wind/base-drop are subtracted.

---

# Distance-dependent Height Detail

## 42. Deterministic detail hashes

Two hashes are generated from world position:

```text
detailHashA = fract(sin(dot(worldXZ*0.15, vec2(0.9898,0.2330))) * 43758.5453)
detailHashB = fract(sin(dot(worldXZ, vec2(0.3468,0.1357))) * 24634.6345)
```

Combined:

```text
detailNoise = (detailHashA*0.7 + detailHashB*0.3)^0.6
detailHeight = mix(0.1, 0.5, detailNoise)
```

---

## 43. Near-only height variation

Threshold:

```text
detailDistance = maxDistance * 0.5
```

Factor:

```text
detailFactor = 1 - smoothstep(
  detailDistance*0.98,
  detailDistance,
  distanceToCamera
)
```

Final height multiplier:

```text
heightVariation = mix(1, detailHeight, detailFactor)
```

Therefore:

```text
near camera -> multiplier approximately 0.1..0.5
farther than half maxDistance -> multiplier 1
```

This may appear counterintuitive, but it is exact current behavior. Do not invert it because a more typical implementation would make far detail smaller.

---

# Base Bend and Wind

## 44. Base bend

See `docs/wind-system.md` for full formulas.

Core behavior:

```text
heightRatio = bladeUv.y
bendPower = heightRatio ^ bladeStiffness
random bend direction from instanceData.z
baseAngle = baseBend * effectiveStrength * PI/2 * bendPower
horizontal = bladeHeight * sin(baseAngle) * heightRatio
drop = bladeHeight * abs(cos(baseAngle)-1) * heightRatio
```

Base bend is static and independent from dynamic wind.

---

## 45. Near/far wind split

Current material computes:

```text
near = detailed 2D gradient noise field
far = directional sine/cosine gust field
```

Transition occurs around:

```text
maxDistance * 0.7
```

The active quality therefore changes this transition in world units.

Do not use an old single-sine wind formula for current parity.

---

# Interaction Integration

## 46. Interaction texture sampling

`InteractionMap` is centered on player X/Z and default coverage is:

```text
256x256 pixels
75x75 world units
```

Material maps instance world XZ into this local texture, applies edge masks, samples red, and converts it with:

```text
smoothstep(0, 0.15, influence)
```

See `docs/grass-interaction.md` for exact deformation math.

---

## 47. Interaction + wind coexist

Interaction modifies local X/Z/Y first.

Then instance rotation is applied.

Then final position receives base-bend and wind horizontal offsets and vertical drops.

There is no branch that freezes wind under footprints.

---

# Color and Roughness

## 48. Per-instance color variation

```text
colorVariation = (instanceData.w - 0.5) * 0.35
colorHeight = clamp(bladeUv.y + colorVariation, 0, 1)^2
color = mix(baseColor, tipColor, colorHeight)
```

The squared colorHeight keeps more of the blade near base color before transitioning strongly toward tip color.

---

## 49. Sheen / roughness

Current node:

```text
roughness = 0.84 - sheen * 0.28 * bladeUv.y
```

So tips become less rough when sheen is nonzero.

Rain preset raises sheen substantially, especially billboard sheen `1`.

There is no dedicated specular texture on grass.

---

# Grass Type Switching

## 50. `setGrassType(type)`

Accepts only:

```text
blade
billboard
```

If unchanged/invalid, returns.

When changed:

```text
1. type = new type
2. rebuild all four geometries using new type quality values
3. set material maxDistance to new type's quality maxDistance
4. assign every tile veryLow geometry
5. reset cameraTile to NaN so next update remaps/reselects
```

Material object itself is reused.

---

# Quality Switching

## 51. `setQuality(name)`

If same profile, returns.

Otherwise:

```text
validate profile exists
set qualityName
rebuild geometry cache
rebuild tile pool
set material maxDistance
keep renderer shadows enabled
apply profile shadowMapSize to all DirectionalLight shadows
dispose existing shadow map on non-initial switch
remap empty tiles
```

Quality switching therefore allocates new grass geometry/tile meshes and is not a trivial uniform-only change.

---

## 52. Current blade quality summary

```text
Performance: max 80,  shadow 1024
Balanced:    max 100, shadow 2048
High:        max 140, shadow 4096
Ultra:       max 220, shadow 4096
```

High/Ultra can dramatically increase tile pool and instance counts.

---

# Environment Integration

## 53. Environment presets

`EnvironmentController` interpolates separate blade/billboard values over five seconds and calls:

```text
GrassField.setPreset({ grass: currentGrassStates })
```

Active material receives:

```text
bladeWidth
bladeHeight
bladeStiffness
baseBend
windIntensity
windDirection
windNoiseScale
simulationSpeed
sheen
baseColor
tipColor
```

Exact preset values are in `docs/environment-presets.md`.

---

## 54. Live grass sliders

UI can change:

```text
windIntensity
bladeHeight
simulationSpeed
```

Those are routed through `EnvironmentController.setGrassParameter()` and written into current/start/target states for both grass types.

`GrassField.setBladeHeight()` also exists as a direct material helper but the current primary UI path uses environment state.

---

# Painter Integration

## 55. Painter creation

After grass init:

```text
grass.attachPainter({
  terrain: world.terrainTarget,
  player
})
```

Painter edits the same `GrassMask` canvas/texture.

Its `onChange` callback is:

```text
GrassField.remapEmptyTiles()
```

so CPU whole-tile culling updates after edits.

---

# Per-frame Update

## 56. Exact `GrassField.update()` sequence

Every app frame:

```text
1. interactionMap.update(playerPosition, influencePoints)
2. material.setInteractionCenter(interactionMap.center)
3. material.setFrame(elapsedSeconds, camera.position)
4. painter.update(deltaSeconds) if attached
5. derive camera logical tile
6. if camera tile changed:
     reposition entire tile pool
     remap empty tiles
7. derive active maxDistance
8. update camera matrix
9. rebuild projection-view matrix
10. rebuild Frustum
11. for every tile:
      calculate XZ distance
      derive tile empty key
      sample tile-center terrain Y
      build/update culling sphere
      evaluate distance/mask/bounds/frustum visibility
      set visible
      if visible:
        painter enabled ? low : distance LOD
        assign shared geometry if changed
```

---

## 57. App-level update placement

Current `GrassDemo` performs:

```text
player.update
surface detection
grass.update
trees.update
...
environment.update
render
```

The grass update receives current player/influence positions before the environment controller applies that frame's newest interpolated grass preset values, but those uniforms are updated before render.

---

# Statistics and Disposal

## 58. Estimated blade count

`getEstimatedBladeCount()` sums:

```text
visible tile.geometry.userData.instanceCount
```

It counts instances for visible tile LODs.

It does not inspect mask strength per instance, so GPU-hidden blades pushed below terrain are still counted if their tile is visible.

---

## 59. Disposal

`GrassField.dispose()`:

```text
removes all tile meshes from scene
disposes all cached geometries
disposes grass material
disposes interaction texture
disposes mask texture
```

`GrassTile.dispose()` removes mesh from scene but does not dispose shared geometry/material itself, which is correct because those resources are shared and disposed centrally.

---

# Configuration Fields that Look Active but Are Not

## 60. Current unused/legacy grass fields

Present in YAML but not consumed by current main grass renderer:

```text
grass.maxDistance       active max comes from quality profile
grass.instancesPerDensityUnit
grass.yOffset
grass.maskThreshold      superseded by grass.vegetationCutoff
grass.initialLod         active LOD comes from quality profiles
```

`useTextureColor`, `atlasColumns` and `atlasRows` **are** consumed, by
`#configureBillboardMaterial()`, whenever grass type is `billboard` -- a UI-selectable mode.

Do not implement these merely because they exist when reproducing current behavior.

---

# Current Non-features

## 61. Not implemented in the current grass renderer

```text
blade texture atlas rendering
alpha-tested textured grass cards in blade mode
per-blade CPU objects
GPU compute instance generation
GPU terrain tessellation
slope-normal alignment of blade up vector
persistent world-sized footprint map
individual blade collision
grass shadows cast by tile meshes
seasonal texture variation
wetness accumulation
snow
procedural grass color from ground texture
```

The visible result comes from geometry, TSL base/tip color, mask, terrain height, deterministic variation, interaction and wind.

---

# Exact Reproduction Checklist

## 62. Architecture

A faithful recreation must:

- use camera-centered reusable tiles,
- tile size 25,
- share four LOD geometries between tiles,
- share one node material,
- manually cull tiles and keep `mesh.frustumCulled=false`,
- prevent grass tiles from casting shadows while receiving shadows.

## 63. Geometry

- deterministic jittered grid, not `Math.random()`,
- exact density formula `floor(tileSize*density)^2`,
- tapered segmented blade topology,
- two crossed quads for billboard,
- same instance rotation/data hash convention,
- retain quality-specific detail/density.

## 64. Placement/mask

- sample RGBA8 TerrainSampler height texture,
- map world XZ using terrain bounds,
- black mask means grass,
- threshold 0.08 with shader smooth span 0.01,
- CPU empty tile uses 3x3 samples at ±0.4/0,
- hidden instances pushed 1000 units down instead of rebuilding lists.

## 65. Deformation/material

- mask scales width/height/bend strength,
- interaction texture bends/lowers upper blade,
- static base bend retained,
- exact near/far wind implementation retained,
- distance-dependent detailHeight behavior retained even though it is unusual,
- deterministic base/tip color variation,
- exact roughness/sheens equation.

## 66. LOD/runtime

- active max distance comes from quality + grass type,
- tile pool odd-size formula retained,
- camera tile controls recentering,
- visibility uses distance + empty mask + expanded terrain bounds + frustum sphere,
- painter forces Low LOD,
- quality rebuilds geometry and tile pool,
- grass type rebuilds geometry but reuses material.

---

# Visual Validation

## 67. Sunny / High / Blade baseline

Use:

```text
preset Sunny
quality High
type Blade
painter off
interaction on
```

Current High blade:

```text
maxDistance 140
LOD high <=42 with 12,544 instances/tile, detail5
medium <=70 with 5,625, detail2
low <=126 with 2,500, detail1
veryLow <=140 with 625, detail1
```

Current Sunny blade material target:

```text
height 1.5
width .2
stiffness 1
base bend 0
wind intensity 1.7
direction 0
noise scale .3
speed 1
base #304f0b
tip #74a116
sheen .25
```

Verify:

```text
mask regions align with terrain
close grass is dense but deterministic
LOD transitions are tile-based and not visually catastrophic
roots follow terrain height
near blades vary in height according to current unusual near-detail formula
wind moves in coherent local patches nearby and broader waves farther out
player feet temporarily flatten grass
base-to-tip color is clearly visible
```

---

# Debugging Order

## 68. If grass looks unlike the target

Debug in this order:

```text
1. camera/FOV/scale first
2. terrain bounds/height texture mapping
3. blend2.jpg orientation and black/white convention
4. active quality and grass type
5. tile size and density formula
6. blade height/width
7. base/tip colors and environment lighting
8. mask threshold
9. wind formulas
10. interaction map
11. LOD/culling sphere
```

Do not compensate for an upside-down or misaligned mask by changing blade density/color.

---

## 69. Source-of-truth rule

This document describes exact current repository behavior. It does not claim the class structure or every clean-room algorithm is the unavailable original author's internal source implementation.

For reference-evidence distinctions, read `docs/reference-parity.md`.

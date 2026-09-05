# Performance

This document describes the performance strategy exactly as implemented on `main`.

It is not a target design; it records what the current code actually does and where the major costs are.

## Primary performance controls

The current runtime exposes or uses these main controls:

- renderer pixel ratio,
- grass quality profile,
- grass type (`blade` or `billboard`),
- grass distance-based LOD,
- grass tile culling,
- tree high/low LOD and distance culling,
- instanced falling leaves,
- local player-centered rain,
- cached terrain height sampling,
- shader warm-up before the first frame.

## Renderer pixel ratio

`getRendererPixelRatio()` uses:

```text
mobile viewport -> mobilePixelRatio
otherwise       -> min(devicePixelRatio, pixelRatioCap)
```

Current values:

```yaml
renderer:
  pixelRatioCap: 2
  mobileBreakpoint: 768
  mobilePixelRatio: 1
```

The UI also allows a runtime pixel-ratio override. `GrassDemo` clamps that override to:

```text
0.5 .. pixelRatioCap
```

Pixel ratio is one of the highest-impact GPU controls because render target pixel count changes quadratically with linear resolution.

## Grass quality profiles

Current profiles are:

| Profile | Fog multiplier | Shadow map | Blade max distance | Billboard max distance |
|---|---:|---:|---:|---:|
| Performance | 1.5 | 1024 | 80 | 120 |
| Balanced | 1.25 | 2048 | 100 | 140 |
| High | 1.0 | 4096 | 140 | 160 |
| Ultra | 0.9 | 4096 | 220 | 220 |

Changing quality rebuilds grass geometry and the tile pool and updates directional-light shadow-map size.

The environment controller separately uses the selected profile's fog multiplier.

## Grass tile pool size

Tile size is:

```yaml
grass:
  tileSize: 25
```

Pool width is:

```text
oddCeil((maxDistance * 2) / tileSize)
```

Examples for blade mode:

| Profile | Max distance | Grid width | Tile objects in pool |
|---|---:|---:|---:|
| Performance | 80 | 7 | 49 |
| Balanced | 100 | 9 | 81 |
| High | 140 | 13 | 169 |
| Ultra | 220 | 19 | 361 |

These are allocated tile objects, not necessarily visible tiles. CPU culling hides tiles before render.

## Grass instances per tile

`GrassGeometry.js` calculates:

```text
gridCount = floor(tileSize * density)
instanceCount = gridCount^2
```

This is why density is expensive: instance count grows quadratically.

For the current 25-unit tile:

| Density | Grid count | Instances/tile |
|---:|---:|---:|
| 1 | 25 | 625 |
| 2 | 50 | 2,500 |
| 3 | 75 | 5,625 |
| 4 | 100 | 10,000 |
| 4.5 | 112 | 12,544 |
| 5 | 125 | 15,625 |
| 5.5 | 137 | 18,769 |

The active instance count depends on LOD.

## Blade geometry cost

Blade `detail` controls the number of vertical segments.

The current blade template creates triangles per segment and uses fewer vertices on the final segment. Higher `detail` therefore increases per-instance vertex/triangle cost in addition to density.

The highest current blade detail is 5.

## Billboard mode

Billboard grass uses two crossed quads instead of a segmented blade.

It still uses instancing and the same tile/LOD infrastructure, but its geometry is fixed and cheaper than high-detail blade mode.

Billboard quality profiles also generally use different max distances and densities.

## Grass CPU culling

Before assigning LOD, each tile must pass all of these tests:

```text
within max XZ distance
not known-empty from grass mask
inside terrain bounds
intersects camera frustum sphere
```

Empty tiles are cached in `GrassField.emptyTiles`.

The cache is recomputed when tile positions are recentered and when the painter changes the mask.

This avoids rendering tiles whose mask contains no meaningful grass.

## Grass tile recycling

Tiles are reused instead of creating/destroying world grass as the camera moves.

The whole pool is repositioned only when the camera crosses into a different 25-unit tile coordinate.

This keeps normal per-frame allocation low.

## Grass geometry reuse

For the current grass type and quality, only four grass geometries are created:

```text
high
medium
low
veryLow
```

Every tile points to one of those shared geometry objects.

Changing type or quality rebuilds the four cached geometries; normal frame-to-frame LOD selection only swaps geometry references.

## Grass GPU work

The grass TSL material performs terrain, mask, interaction, color and wind work on the GPU.

It contains distance-dependent simplifications inside the shader:

- near blades receive detailed random height variation,
- that detail fades out around half of max distance,
- near wind uses gradient noise,
- far wind uses cheaper sine/cosine gusts,
- detailed wind fades toward the far path around 70% of max distance.

This reduces complex wind/detail work at long range without a separate material.

## Grass shadows

`GrassTile` currently uses:

```text
castShadow = false
receiveShadow = true
```

Not casting grass shadows is a major performance decision. With very high grass instance counts, shadow rendering would otherwise multiply grass geometry cost in the shadow pass.

## Terrain sampling

The terrain is raycast into a 192 x 192 CPU height grid once during startup.

Normal runtime height queries then use bilinear interpolation on that cached array.

Grass shaders use an 8-bit height `DataTexture` derived from the same grid.

This avoids:

- per-frame player raycasts,
- per-leaf terrain raycasts,
- per-grass-instance CPU raycasts.

Startup sampling yields every six rows to avoid blocking one long browser frame.

## Tree LOD

Runtime trees keep both high and low clones.

Current distances:

```yaml
highDistance: 170
billboardDistance: 500
```

Behavior:

```text
near highDistance -> high model
transition region -> opacity crossfade
farther -> low model facing camera
beyond billboardDistance -> both hidden
```

High tree clones cast shadows. Low clones do not.

### Tree performance limitation

Trees are cloned object hierarchies, not instanced meshes. Each runtime tree has a high and low clone and materials are cloned per tree.

This is significantly more expensive in object count, draw calls and material state than an instanced tree system would be.

The current code favors reference-behavior reconstruction over maximum tree batching.

## Falling leaves

Configured count:

```yaml
leaves:
  count: 1000
```

The implementation calculates:

```text
countPerZone = ceil(1000 / 3) = 334
```

so three `InstancedMesh` objects are created with capacity 334 each, for 1002 allocated instances total.

Only the current zone's mesh is visible and only particles from that zone are updated each frame.

Per-instance transforms are written into the active mesh's instance matrix.

## Rain

Configured count:

```yaml
rain:
  count: 10000
```

Rain is one `LineSegments` object with two vertices per drop.

When rain is inactive:

```text
lines.visible = false
```

and the update returns before iterating all drops.

When active, the CPU updates 10,000 heights and Y coordinates each frame, then marks the position attribute dirty.

The rain volume moves with the player, so only one local 20-unit area is simulated instead of world-scale precipitation.

## Birds

Current count is ten.

Each bird is a cloned scene hierarchy and can have an independent `AnimationMixer`. There is no LOD or distance culling in `BirdSystem`.

At the current count this is bounded, but it is not designed for hundreds of birds.

## Audio

Audio uses browser `Audio` elements and has little render cost. Ambient loops are always playing after unlock but volume-faded to targets.

## Sky and clouds

Sky and clouds each use one large sphere mesh with node materials.

They are not frustum culled, but object count is constant and small.

Cloud appearance is procedural TSL rather than a large particle system.

## Water

Water uses one mesh and procedural node shading. The current effect does not tessellate/displace the surface each frame and has no reflection/refraction render pass.

That keeps water comparatively inexpensive.

## Shadow quality

Quality profile changes directional-light shadow-map resolution:

```text
Performance -> 1024
Balanced    -> 2048
High        -> 4096
Ultra       -> 4096
```

When changing profile after initialization, the old shadow map is disposed so it can be rebuilt at the new resolution.

## Shader warm-up

Before the animation loop begins, the app runs:

```text
await renderer.compileAsync(scene, camera)
```

This intentionally moves major shader compilation work into the loading phase instead of allowing first-use compilation to cause visible frame stalls.

## FPS and triangle monitoring

When `ui.showStats` is true, `DemoUi` updates roughly every 0.5 seconds and displays:

```text
FPS
TRIS
```

Triangle count comes from:

```text
renderer.info.render.triangles
```

This is the most direct built-in feedback for comparing grass type, quality and pixel ratio in the current UI.

## Most expensive current knobs

In practical order, the settings with the largest likely impact are:

1. renderer pixel ratio,
2. grass max distance,
3. grass LOD density,
4. grass blade detail,
5. directional shadow-map resolution,
6. tree count / cloned tree complexity,
7. active rain CPU updates.

## Configuration fields that do not currently reduce cost

Several legacy/reference fields remain in YAML but do not currently control the active performance path, including `grass.instancesPerDensityUnit` and `grass.initialLod`.

Actual active grass LOD values come from `quality.<profile>.<blade|billboard>.lod`.

## Current architecture trade-offs

Strong performance choices already implemented:

```text
grass instancing
camera-centered tile reuse
grass tile/frustum/mask culling
shared LOD geometries
GPU grass deformation
cached terrain height field
no grass shadow casting
instanced falling leaves
local rain volume
shader precompilation
mobile pixel-ratio reduction
```

Current expensive/non-batched areas:

```text
tree hierarchy cloning
per-tree material cloning
animated bird hierarchy cloning
CPU-updated 10k rain drops when active
CPU-updated interaction texture
```

This is the exact current performance model; it should be used when profiling future changes.

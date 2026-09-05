# Rendering Architecture

This document describes the rendering stack exactly as implemented on `main`.

## Versions

`package.json` currently uses:

```json
"three": "^0.180.0"
```

The app is built with Vite.

## Renderer

`createWorld()` constructs:

```text
THREE.WebGPURenderer
```

from `three/webgpu` with:

```text
antialias: true
powerPreference: high-performance
forceWebGL: Boolean(config.renderer.forceWebGL)
```

Current configuration:

```yaml
renderer:
  forceWebGL: false
  pixelRatioCap: 2
  exposure: 1
```

The renderer is initialized asynchronously with:

```text
await renderer.init()
```

before the rest of the world is built.

## Output and tone mapping

Renderer settings:

```text
shadowMap.enabled = true
shadowMap.type = PCFSoftShadowMap
toneMapping = ACESFilmicToneMapping
toneMappingExposure = config.renderer.exposure
outputColorSpace = SRGBColorSpace
```

This means final displayed color is sRGB and scene luminance is tone-mapped with ACES Filmic.

## Pixel ratio

Initial and resize pixel ratio comes from `getRendererPixelRatio()`.

Current behavior:

```text
viewport width < 768 -> mobilePixelRatio = 1
otherwise            -> min(devicePixelRatio, pixelRatioCap)
```

The UI can set an explicit runtime override between 0.5 and `pixelRatioCap`.

## Scene fog

The scene is created with `FogExp2` using base world configuration. Once `EnvironmentController` is created, active preset fog color/density takes over and density is multiplied by the selected quality profile's `fogMultiplier`.

## Lighting

Three light sources are created:

```text
DirectionalLight
HemisphereLight
AmbientLight
```

The directional light casts shadows and has a large orthographic shadow camera:

```text
near 1
far 220
left/right -70/70
top/bottom 70/-70
```

Initial shadow-map size is 2048, but grass quality selection later applies `quality.<name>.shadowMapSize` to directional lights.

`EnvironmentController` changes light colors and intensities from presets.

The directional light follows the player by moving its position to `playerPosition + presetRelativePosition` and targeting the player.

## HDR environment lighting

`loadEnvironment()` loads:

```text
Assets/zwartkops_straight_morning_1k.hdr
```

using `RGBELoader`.

It sets:

```text
mapping = EquirectangularReflectionMapping
scene.environment = loaded HDR
```

`scene.environmentIntensity` is initialized from the active preset and later controlled by `EnvironmentController`.

The HDR is used for material environment lighting. It is not the normal visible background because the project has a procedural sky mesh.

## TSL / node materials

The project uses Three.js TSL for several high-value systems.

### Grass

`GrassMaterial` uses `MeshStandardNodeMaterial`.

TSL handles:

- terrain-height texture lookup,
- grass-mask lookup,
- player interaction texture lookup,
- blade width/height,
- base bend,
- near and far wind,
- distance-based micro detail,
- base/tip color,
- sheen-derived roughness.

The geometry remains instanced and the material's `positionNode` performs per-vertex deformation.

### Ground

`GroundMaterial` uses `MeshStandardNodeMaterial`.

It samples:

- grass color texture,
- ground color texture,
- blend mask,
- ground normal map,
- ground roughness map.

The mask blends grass-colored ground into exposed PBR ground.

### Water

`WaterSurface` uses `MeshPhysicalNodeMaterial`.

TSL time/world-position expressions generate base wave shading and rain ripple shading. The current water effect changes material color; it does not displace vertices.

### Sky

`SkySystem` uses `MeshBasicNodeMaterial` on the inside of a large sphere.

TSL computes:

- ground/horizon/zenith gradient,
- sun halo,
- sun disk.

### Clouds

`CloudSystem` uses a transparent `MeshBasicNodeMaterial` on a flattened inner sphere.

TSL combines multiple trigonometric noise frequencies, thresholding and time-based drift.

## Standard Three.js materials

Not every system is node-based.

Examples:

- procedural fallback ground: `MeshStandardMaterial`
- player placeholder: `MeshStandardMaterial`
- procedural tree fallback: `MeshStandardMaterial`
- falling leaves: `MeshBasicMaterial`
- fallback birds: `MeshStandardMaterial`
- rain: material defined by `RainSystem`

Imported GLB materials remain in use except where the runtime explicitly replaces them, such as configured ground targets and `LakeWater`.

## Ground texture color spaces

`GroundMaterial` explicitly configures:

```text
grass color -> sRGB
ground color -> sRGB
blend mask -> NoColorSpace
normal map -> NoColorSpace
roughness -> NoColorSpace
```

The grass mask uses `flipY = true`; only the ground blend mask uses `flipY = false`.

Ground color/normal/roughness textures use repeat wrapping. The blend mask uses clamp-to-edge wrapping.

## Grass data textures

`TerrainSampler` creates an 8-bit RGBA terrain-height `DataTexture` in `NoColorSpace`.

`InteractionMap` creates an 8-bit RGBA local interaction `DataTexture` in `NoColorSpace`.

`GrassMask` exposes a canvas-backed `CanvasTexture` in `NoColorSpace`.

All three are read by the grass node material.

## Instancing

Instancing is used heavily to reduce object/draw overhead.

### Grass

Each tile is one mesh containing an `InstancedBufferGeometry`. Four geometries are cached per grass type/quality combination and reused across tiles.

### Falling leaves

Each leaf color family uses one `InstancedMesh`; per-leaf transforms are written into the instance matrix.

Trees are currently cloned scene graphs rather than instanced meshes.

Birds are cloned scene graphs rather than instanced meshes because they may have independent animation mixers.

## Grass tile rendering

Grass uses a camera-centered reusable tile pool.

Before render, CPU checks:

- max distance,
- mask emptiness,
- terrain bounds,
- frustum sphere.

Only visible tiles get a distance-selected LOD geometry.

This avoids sending the whole terrain's grass to the renderer.

## Tree rendering

Trees use two cloned visual representations per runtime tree:

```text
high
low
```

At the high/low transition, opacity is cross-faded. Beyond `billboardDistance`, both are hidden.

The low representation is rotated toward the camera when active.

## Sky/cloud render ordering

Sky and cloud meshes disable frustum culling.

The sky has a very early render order and is rendered on the inside of a large sphere. Clouds are rendered after the sky but before normal scene geometry through their configured render order.

Both materials disable fog because they represent the atmosphere itself.

## Shadows

Terrain/material targets and imported player meshes receive shadows.

Player and high tree meshes cast shadows.

Grass tiles currently:

```text
castShadow = false
receiveShadow = true
```

Low tree LOD clones are prepared without shadow casting.

Quality selection changes directional-light shadow texture resolution.

## Shader compilation

After all major systems are constructed, `GrassDemo.start()` calls:

```text
await renderer.compileAsync(scene, camera)
```

This happens while the loading UI still shows `Compiling shaders...`.

Only after compilation and loading UI completion does the app call:

```text
renderer.setAnimationLoop(...)
```

## Graceful fallbacks

The current renderer/world path contains explicit fallbacks:

- terrain GLB failure -> flat terrain/fallback plane
- ground blend material failure -> simple standard material
- sky/cloud node setup failure -> solid scene background color
- player GLB failure -> capsule placeholder
- missing tree metadata -> procedural trees
- missing bird source -> triangle silhouettes
- missing lake mesh -> fallback plane

These fallbacks are intended to keep the demo renderable when optional/reference assets fail.

## Current implementation boundaries

- The project uses WebGPU/TSL where implemented, but still mixes regular Three.js materials/classes as appropriate.
- `forceWebGL` selects a renderer backend option; the application does not maintain separate hand-written WebGL and WebGPU scene implementations.
- There is no post-processing composer in the current code.
- No SSAO, bloom, SSR, TAA or screen-space water reflection pass is present.
- Grass does not cast shadows in the current `GrassTile` implementation.
- Water shading is procedural color modulation, not geometric displacement/reflection.

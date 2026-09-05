# AI Reproduction Playbook

This document is the implementation order and parity contract for an AI or developer recreating this project from scratch.

The goal is not to produce a vaguely similar Three.js nature scene. The goal is to reproduce the current `main` behavior, composition, controls, motion, environment transitions, and rendering decisions closely enough that the result looks and feels like the same application when the same assets are used.

The repository is a clean-room reconstruction of browser-observable behavior. Therefore there are two different meanings of "exact":

1. **Exact repository behavior** — every class, formula, asset name, configuration value, update order, fallback and UI value documented here should match the current implementation.
2. **Exact original reference internals** — not claimed. The original source structure was not recovered. Where the current project implements observed reference behavior with a new implementation, the current implementation is the reproducible source of truth.

Do not silently invent missing behavior. If a detail is not implemented, keep it absent or mark it as a deliberate extension.

---

## 1. Required reading order

An AI recreating the project should read the documentation in this order before writing code:

```text
1. docs/ai-reproduction-playbook.md
2. docs/visual-parity-checklist.md
3. docs/config-reference.md
4. docs/asset-contract.md
5. docs/runtime-lifecycle.md
6. docs/rendering-architecture.md
7. docs/terrain-system.md
8. docs/ground-pbr-textures.md
9. docs/player-controller.md
10. docs/camera-system.md
11. docs/grass-system.md
12. docs/grass-interaction.md
13. docs/lod-system.md
14. docs/wind-system.md
15. docs/tree-system.md
16. docs/leaf-system.md
17. docs/bird-system.md
18. docs/water-system.md
19. docs/rain-system.md
20. docs/sky-cloud-system.md
21. docs/environment-presets.md
22. docs/audio-system.md
23. docs/ui-look-and-feel.md
24. docs/performance.md
```

The subsystem documents intentionally overlap. That is useful for reproduction because a visual feature often depends on several systems at once.

---

## 2. Technology baseline

Use the same baseline unless deliberately making a new version:

```json
{
  "three": "^0.180.0",
  "js-yaml": "^4.1.0",
  "vite": "^7.1.4"
}
```

The application uses ES modules.

The renderer is `THREE.WebGPURenderer` imported from `three/webgpu`, with `forceWebGL` passed from configuration so the same renderer class can request the WebGL backend when required.

Use Three.js TSL/node materials for the systems that currently use them:

```text
grass
ground blend
sky
clouds
water
```

Do not replace these with unrelated shader libraries if parity is the objective. Small numerical differences in a deformation formula can materially change the look of the grass field.

---

## 3. Configuration must be merged exactly

The runtime loads four YAML files and deep-merges them in this exact order:

```text
public/config.yaml
public/ground-material.yaml
public/player-controls.yaml
public/visual-parity.yaml
```

Later values override earlier values.

Nested objects merge recursively. Arrays and scalar values replace the prior value.

Do not read only `config.yaml` and assume it contains the final values.

Important effective overrides include:

```yaml
renderer:
  pixelRatioCap: 2
  exposure: 1
  forceWebGL: false
  mobileBreakpoint: 768
  mobilePixelRatio: 1

camera:
  fov: 52
  near: 0.1
  far: 6000
  distance: 5
  minDistance: 1.5
  maxDistance: 24
  pitch: -0.25
  controls:
    initialYaw: 0
    targetHeight: 1
    cameraHeight: 4
    shoulderOffset: 1.2
    mobileBreakpoint: 768
    mobileDistance: 7
    desktopDistance: 5
    mobileTargetOffset: 0.8
    desktopTargetOffsetFactor: 0.001
    mouseSensitivity: 0.001
    dragSensitivityX: 0.005
    dragSensitivityY: 0.004
    minPitch: -0.8
    maxPitch: 0.7
    zoomSensitivity: 0.01
    followSharpness: 8
    zoomSharpness: 12
    terrainClearance: 0.4
    pointerLockOnClick: true

player:
  modelScale: 1
  modelOffsetY: 0
  modelRotationY: 0
  motion:
    acceleration: 10
    deceleration: 14
    stopSpeed: 0.06
    runStateThreshold: 0.85
    animationFadeSeconds: 0.16
    walkAnimationRate: 1
    runAnimationRate: 1
    minAnimationRate: 0.72
    maxAnimationRate: 1.18

ground:
  materialTargets:
    - Landscape002
    - Landscape046
  grassTextureScale: 150
  groundTextureScale: 70
  anisotropy: 16
  metalness: 0.5
  applyToTerrain: true
```

`ground.applyToTerrain` is retained in configuration, but the current material application path does not gate itself on that value.

---

## 4. Asset contract is part of the visual result

Use the same public asset layout during parity work:

```text
public/Assets/
```

Important assets include:

```text
terrain/**/*.glb   (the split parts of the authored terrain2.glb)
Drusniel_Dark_Elf.glb
blend2.jpg
grass.jpg
zwartkops_straight_morning_1k.hdr

ground/ground_0109_color_1k.jpg
ground/ground_0109_normal_directx_1k.jpg
ground/ground_0109_roughness_1k.jpg

leaf-yellow.png
leaf-green.png
leaf-whites.png

Audio/*
```

The GLB object names are also an API. Important names include:

```text
Landscape002
Landscape046
TreePositions
Tree1_High ... Tree9_High
Tree1_Low ... Tree9_Low
Leaves_LOD0 ... Leaves_LOD0005
Mesh_1001
Mesh_1003
Mesh_1004
YellowZone
GreenZone
WhiteZone
Birds
LakeWater
WaterCollider
```

Do not rename these casually. If assets are replaced later, either preserve the contract or update YAML/code and documentation together.

---

## 5. Build the renderer before gameplay systems

Create the scene and camera first.

Renderer contract:

```text
WebGPURenderer
antialias = true
powerPreference = high-performance
forceWebGL = Boolean(config.renderer.forceWebGL)
PCFSoftShadowMap
ACESFilmicToneMapping
exposure = config.renderer.exposure
outputColorSpace = SRGBColorSpace
```

Call `await renderer.init()` before continuing.

Initial pixel ratio must use the same helper logic:

```text
if width < renderer.mobileBreakpoint:
    mobilePixelRatio
else:
    min(devicePixelRatio, pixelRatioCap)
```

Do not use device pixel ratio unbounded; it changes performance and therefore the feel of the quality modes.

---

## 6. Create lighting exactly before environment interpolation

Initial world lights are:

```text
DirectionalLight
HemisphereLight
AmbientLight
```

The directional light casts shadows and its shadow camera currently uses:

```text
near 1
far 220
left/right +/-70
top/bottom +/-70
```

The initial light values come from YAML, but the active environment preset takes ownership of their runtime colors, intensities and relative sun position.

The sun is later kept near the player by:

```text
sun.position = playerPosition + presetRelativeSunPosition
sun.target.position = playerPosition
```

This is important. A world-fixed sun can eventually lose shadow precision as the player moves and does not reproduce the current implementation.

---

## 7. Load terrain before systems that depend on world height

Load every `assets.terrainParts` entry with `GLTFLoader` and a `DRACOLoader` using the configured decoder path, then reparent the loaded scenes under a single `TerrainRoot` group. The parts are a lossless split of the authored `terrain2.glb`, so the assembled root matches the original scene.

Apply the configured root transform, update world matrices, and make imported meshes cast and receive shadows.

The configured terrain target is:

<!-- effective: terrain.targetMeshName = Landscape002 -->

```text
Landscape002
```

If the target cannot be found, the terrain root becomes the sampling target.

Do not directly raycast the terrain for every blade or leaf every frame.

Instead, build `TerrainSampler` once.

---

## 8. TerrainSampler is a central data service

The sampler creates a `192 x 192` CPU height field by downward raycasting over the target bounds.

Rows are processed in chunks (`sampleChunkRows: 6`) and yield to `requestAnimationFrame()` periodically so startup remains responsive.

The sampler stores:

```text
world bounds
world size
Float32Array heights
RGBA8 height DataTexture
```

The height texture encodes normalized height from terrain minimum to maximum. Consumers reconstruct actual height using the same min/range.

The CPU path uses bilinear interpolation in `sampleHeight(x, z)`.

This sampler is used by:

```text
player grounding
camera clearance
grass shader placement
grass mask UV mapping
grass painter
interaction-map terrain intersection
falling leaves
surface/world bounds logic
```

If this coordinate mapping changes, many systems stop matching simultaneously.

---

## 9. Ground material is a blended TSL PBR material

Load all of these:

```text
grass.jpg
ground color
ground DirectX normal
ground roughness
blend2.jpg
```

Color textures are sRGB. Mask, normal and roughness are `NoColorSpace`.

Use mipmaps, linear filtering, configured anisotropy and correct wrapping.

TSL material behavior:

```text
grassUv = uv * 150
groundUv = uv * 70
blend = grassMask.r
color = mix(grassColor, groundColor, blend)
normal = normalMap(groundNormal, vec2(blend))
roughness = mix(1, groundRoughness, blend)
metalness = 0.5
```

The blend mask convention therefore serves both ground blending and grass placement:

```text
black -> grass-colored ground and strong grass
white -> exposed PBR ground and no grass
```

Apply the generated material to `Landscape002` and `Landscape046` when present.

---

## 10. Build the player before grass interaction

The player uses a gameplay root `THREE.Group` and a visual GLB child.

The root owns:

```text
world position
world facing
movement velocity
terrain grounding
camera target
```

The GLB child owns:

```text
skeleton
body
armour
embedded animation clips
```

Load `Drusniel_Dark_Elf.glb` with Draco support.

Animation mapping:

```yaml
idle: null
walk: Armature|walking_man|baselayer
run: Armature|running|baselayer
```

The single movement clip is shared by walking and running. It fades out to the static pose when the player becomes idle.

Movement is camera-yaw-relative and uses exponentially damped velocity rather than instant speed changes.

Do not add jumping or physics if reproducing the current behavior. They are not part of the current controller.

---

## 11. Reproduce camera feel before tuning grass

The camera is a third-person shoulder camera, not an OrbitControls gameplay camera.

Desktop defaults:

```text
distance 5
target height 1
camera height 4
shoulder offset 1.2
pitch -0.25
yaw 0
```

The camera supports:

```text
click -> pointer lock
mouse movement -> look
left-drag when not pointer locked -> look
wheel -> zoom
```

Pitch clamps to `[-0.8, 0.7]`.

Zoom and follow use exponential damping with separate sharpness values.

The desired camera Y is clamped to at least:

```text
terrainHeight + 0.4
```

This camera composition is a major part of the application's feel. Do not postpone it until the end and then approximate it with OrbitControls.

---

## 12. Build vegetation metadata before vegetation renderers

`ZoneIndex` converts hidden GLB zone geometry into world-space `Box3` lookup regions:

```text
YellowZone -> yellow
GreenZone -> green
WhiteZone -> white
```

The zone meshes are hidden after indexing.

Create `TreeSystem`, `LeafSystem`, and `BirdSystem` after the player and terrain sampler exist.

Tree placement is marker-driven from direct children of `TreePositions`.

Falling leaves are player-centered instanced planes.

Birds are clones of the `Birds` object when it exists and procedural triangle silhouettes otherwise.

---

## 13. Grass field architecture must remain tiled

Do not replace the grass with one giant instanced field if parity and behavior are the objective.

The current field uses:

```text
tileSize = 25
camera-centered reusable tile grid
four cached LOD geometries
one shared TSL material
CPU tile culling
GPU vertex placement/deformation
```

Quality profile and grass type select the effective `maxDistance`, density and geometry detail.

The tile pool recenters only when the camera enters a new tile coordinate.

Visible tile tests are:

```text
within max distance
mask indicates some grass
inside terrain bounds with one-tile allowance
frustum sphere intersection
```

Painter mode forces visible tiles to `low` LOD.

---

## 14. Grass geometry is deterministic

For a tile:

```text
gridCount = floor(tileSize * density)
instanceCount = gridCount^2
```

Instances use deterministic hash functions for jitter, rotation, bend phase and color/height variation.

Blade mode uses a segmented tapered strip.

Billboard mode uses two crossed quads.

Do not replace deterministic placement with `Math.random()` if reproducibility matters. It changes the field on every load and makes screenshots difficult to compare.

---

## 15. Grass material is the core visual effect

The TSL position pipeline must retain this order of concepts:

```text
world XZ
terrain UV
terrain height sample
grass mask sample
interaction texture sample
local width/height shaping
instance rotation
near/far detail variation
base bend
near/far wind field
final world-relative vertex position
```

Important current behavior:

- mask value controls existence and strength,
- near grass receives richer detail variation,
- near wind uses 2D gradient noise,
- far wind uses cheaper directional sine/cosine gusts,
- wind paths blend by camera distance,
- interaction bends and lowers blades,
- base bend is independent of animated wind,
- color interpolates base-to-tip with deterministic per-instance variation,
- sheen reduces roughness toward the tip.

Do not simplify all wind to one sine wave and still call the result parity-equivalent.

---

## 16. Interaction is a moving texture, not per-blade CPU state

Create a `256 x 256` RGBA8 `DataTexture` representing `75 x 75` world units around the player.

The red channel stores temporary influence.

Every frame:

```text
scroll texture as player moves
multiply old red values by 0.94
paint current influence points
upload texture
```

The current Warden has no foot helpers, so use the controller's two root-relative fallback influence points.

When interaction is disabled, recovery and map scrolling continue but new influences are not painted.

The current recovery is frame-dependent because it multiplies by `0.94` once per update rather than using delta time. Reproduce that behavior if exact parity with current `main` is required.

---

## 17. Grass mask editing must use the same convention

`GrassMask` stores a canvas-backed grayscale image.

Convention:

```text
0 / black = full grass
255 / white = no grass
```

The painter uses left mouse to paint, right mouse to rotate, middle mouse to dolly, `1`/`2` for add/erase, and brackets for brush size.

The runtime preview is `256 x 256` CSS display of the current mask while the backing painter resolution is `512 x 512` by default.

Painting also recomputes empty-tile classification so CPU culling follows the edited mask.

---

## 18. Tree behavior must preserve source/marker/LOD separation

Use source objects from the terrain GLB as hidden templates.

Use marker positions from `TreePositions`.

Filter source families by zone.

Clone a high and low representation for each tree entry.

Current LOD behavior:

```text
highDistance = 170
fixed transition width = 16
billboardDistance = 500
```

High and low are cross-faded around the transition. Low detail turns to face the camera once it participates in the blend. Both are hidden beyond 500.

The high tree receives a small shared Z sway:

```text
sin(elapsed * windSpeed) * windStrength * 0.0035
```

Do not claim the configured hysteresis and transition-duration keys are active; the current implementation uses the fixed transition width described above.

---

## 19. Leaves and birds are deliberately local/simple

Leaves:

```text
three zone-specific InstancedMesh sets
ceil(totalCount / 3) capacity per set
only current player zone visible
spawn around player
terrain-aware recycle
fixed leaf wind configuration, not environment wind
```

Birds:

```text
10 entries by default
source cloned with SkeletonUtils when available
seed = 1234
orbit radius 50..200
height 5..10 relative to orbit center
scale 3..5
speed 0.15..0.25
bobbing amount 0.4, speed 1.5
```

Do not make birds physically flock or leaves originate from tree canopies if reproducing current `main`; those would be extensions.

---

## 20. Water, rain and audio are coordinated but independent

Water uses `LakeWater` when present and `WaterCollider` for world-space water detection.

Water material is `MeshPhysicalNodeMaterial` with global TSL time waves and an extra procedural ripple term controlled by a binary rain uniform.

Rain uses one local `LineSegments` mesh with 10,000 drops, each represented by two vertices.

The rain object follows player XZ.

Rain intensity uses Three.js damping toward a target. It is not the same five-second interpolation used by the environment controller.

Audio uses browser `Audio` elements rather than `THREE.Audio`.

Ambient loops are unlocked on first pointer or keyboard interaction. Surface-specific footstep banks are selected from `water`, `grass`, or `mud` state.

---

## 21. Environment presets are coordinated snapshots

Current preset keys:

```text
sunny
goldenHour
rainy
windy
calm
bowed
moonlight
```

The environment controller keeps:

```text
current
start
target
```

Preset transition duration is a hard-coded five seconds.

The interpolation easing is:

```text
raw = elapsed / 5
t = raw * raw * (3 - 2 * raw)
```

It interpolates both blade and billboard grass parameter sets, lights, sky, fog and cloud coverage.

Rain target, water rain state and audio target are triggered when selecting the preset and use their own transitions/behavior.

The HDR image remains fixed; only `scene.environmentIntensity` changes.

---

## 22. Visible sky is not the HDR

The visible sky is a giant `SphereGeometry(radius=5000, 48, 24)` with a back-side `MeshBasicNodeMaterial`.

Sky gradient uses vertical view direction with exactly these blend regions:

```text
lower: smoothstep(-0.2, 0.12, y)
upper: smoothstep(0.02, 0.78, y)
```

Sun halo/disk use powers of the dot product between view direction and normalized configured sun direction.

Clouds use another back-side sphere, flattened to `scale.y = 0.2`, positioned at Y=120, with render order `-900`. Sky render order is `-1000`.

Cloud procedural noise is a weighted combination:

```text
0.52 * n1 + 0.31 * n2 + 0.17 * n3
```

Do not substitute a stock skybox or cloud texture and expect equivalent visual character.

---

## 23. UI is part of parity

The current UI is compact translucent green glass, not a generic debug GUI.

Important colors and values:

```text
page background      #091015
main text            #eef4e8
accent               #c5f15b / #b9e84d
panel background     rgba(45,75,34,.58)
panel border         rgba(229,247,218,.12)
panel radius         17px
panel blur           16px
controls width       218px
controls right       28px
controls top         45px
metrics top/right    16px / 28px
```

The exact responsive behavior and control layout are in `docs/ui-look-and-feel.md`.

Using lil-gui/dat.GUI instead of the custom interface materially changes the look and should not be considered parity.

---

## 24. Startup order is a visual feature

The loading screen and staged initialization prevent shader compilation and terrain sampling from appearing as a frozen blank page.

Keep this high-level order:

```text
loading UI
create renderer/world
load terrain
create/apply ground material
build terrain sampler
load HDR
create sky/clouds
create player
build zones/trees/leaves/birds
build grass and painter
create water/rain/audio/environment
create UI
compile shaders asynchronously
resize
finish loading screen
start animation loop
```

Changing the order can break dependencies or create visible popping during startup.

---

## 25. Per-frame order is also part of behavior

Current render-loop order:

```text
1. player.update
2. detect water/grass/mud surface
3. grass.update
4. trees.update
5. leaves.update
6. birds.update
7. rain.update
8. water.update
9. environment.update
10. environment.updateSunTarget
11. audio.update
12. renderer.render
13. UI stats update
```

Do not reorder systems casually. For example, surface detection must occur after player movement, and grass interaction needs current player/influence positions.

---

## 26. Error/fallback behavior must be retained

Parity includes graceful degradation:

```text
terrain load fails -> flat terrain sampler/fallback world
player GLB fails -> capsule placeholder
missing tree markers -> procedural tree fallback
missing bird source -> procedural bird silhouettes
missing water mesh -> fallback plane
TSL sky/cloud creation fails -> solid scene background
PBR texture load fails -> simple ground material
some audio fails -> log warning, scene continues
```

Do not turn optional visual asset failures into fatal startup errors.

---

## 27. Determinism rules

For reliable visual comparison:

- retain the seeded random generators,
- retain the same asset transforms,
- retain the same camera defaults,
- retain mask orientation (ground blend `flipY = false`, grass mask `flipY = true`),
- retain world-to-UV conventions,
- retain exact preset values,
- do not change density formula,
- do not introduce random values from current time,
- do not silently normalize configuration values into a new scale.

If deterministic output changes, screenshot comparisons become much less useful.

---

## 28. What another AI must not "improve" during parity work

Do not introduce these while the task is reproduction:

```text
Rapier physics
jumping
root-motion locomotion
volumetric clouds
physically based atmospheric scattering
GPU-compute rain
GPU-compute interaction texture
tree instancing rewrite
true tree-canopy leaf emitters
bird flocking AI
wet-ground shader
new postprocessing stack
new UI framework
new camera controller
procedural replacement assets
```

Any of these may be good later. They are not the same implementation and can mask parity problems.

---

## 29. Visual tuning order

When a screenshot does not match, tune in this order:

```text
1. camera transform and FOV
2. terrain/player scale and orientation
3. ground material and mask alignment
4. sun direction/intensity and HDR intensity
5. sky gradient/fog
6. grass height/width/density/LOD
7. grass color and wind
8. trees and zones
9. water
10. rain/leaves/birds
11. UI placement
```

Do not compensate for a wrong camera by changing model scale or grass size. That creates cascading inconsistencies.

---

## 30. Acceptance rule

A reproduction is not complete because it compiles.

It is complete only when:

- the same assets load under the same object-name contract,
- the same default camera composition is achieved,
- grass occupies the same mask regions and follows terrain height,
- the same presets visibly transition in the same direction,
- player interaction bends grass and recovers,
- tree LOD behavior occurs at the same distances,
- rain/water/audio coordination matches,
- the same controls operate with the same defaults,
- the UI layout matches desktop and mobile behavior,
- the frame loop remains stable under the configured quality profiles.

Use `docs/visual-parity-checklist.md` as the final verification list.

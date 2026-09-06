# Configuration Reference

This document records the effective configuration contract on current `main`. Recovered browser behavior remains the higher-priority parity source; configuration tells the runtime which recovered values and clean-room adapter settings to use.

## Merge order

`src/config/loadConfig.js` is the single runtime source for the file list:

```text
1. public/config.yaml
2. public/ground-material.yaml
3. public/player-controls.yaml
4. public/visual-parity.yaml
5. public/character-visual.yaml
6. public/cinematic-wind.yaml
7. public/cinematic-look.yaml
8. public/painter-cursor.yaml
9. public/characters.yaml
```

Merge rules:

```text
object + object -> recursive merge
array           -> complete replacement
scalar/null     -> replacement
```

`scripts/mergedConfig.mjs` imports that same `CONFIG_FILES` constant, so runtime, `npm run config:dump` and `npm run check:docs` cannot silently drift to different file lists.

Use:

```bash
npm run config:dump
npm run config:dump -- player
npm run config:dump -- --json
```

## Renderer and UI pixel ratio

<!-- effective-config: renderer -->
```yaml
pixelRatioCap: 2
exposure: 1
forceWebGL: false
```

<!-- effective-config: ui -->
```yaml
pixelRatio: 1
initialQuality: ultra
initialPreset: goldenHour
```

Initial renderer pixel ratio is `ui.pixelRatio` when it is finite, so the current reference starts at `1`. `renderer.pixelRatioCap` is used as the upper bound for the runtime pixel-ratio control.

There is no active `renderer.mobilePixelRatio` or `renderer.mobileBreakpoint` path.

## Camera

<!-- effective-config: camera -->
```yaml
fov: 45
near: 0.1
far: 10000
initialPosition: [11.7, 3, 11]
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
  minPitch: -0.8
  maxPitch: 0.7
  followSharpness: 8
  terrainClearance: 0.4
  pointerLockOnClick: true
  safariLookMultiplier: 8
  mobileLookSensitivity: 0.015
  mobileJoystickRadius: 55
```

Active gameplay camera distance comes from `controls.desktopDistance` / `mobileDistance`.

Retained but currently inert camera keys include:

```text
camera.distance
controls.dragSensitivityX
controls.dragSensitivityY
```

`controls.terrainClearance` is active: the third-person camera samples terrain under both the desired and smoothed camera positions and keeps the camera at least that distance above the terrain.

Wheel zoom is implemented and reads:

```text
controls.zoomSensitivity   world units per unit of wheel deltaY
controls.zoomSharpness     exponential damping rate toward the target distance
camera.minDistance         closest the camera may sit to the player
camera.maxDistance         furthest
```

The wheel sets a target distance, clamped to `[minDistance, maxDistance]`; the live `cameraDistance` damps toward it with `1 - exp(-zoomSharpness * dt)`, the same idiom the camera follow uses. Zoom is desktop-only -- the handler returns early when `this.mobile` is set, since mobile uses `controls.mobileDistance`.

`camera.distance` remains inert: initial distance comes from `controls.desktopDistance` / `controls.mobileDistance`.

## Player

<!-- effective-config: player -->
```yaml
start: [2, 5, -5]
modelScale: 1.35
modelOffsetY: 0
modelRotationY: 0
rainRoughness: 0.1
eyeHeight: 0.5
walkSpeed: 2.5
runSpeed: 15
jumpSpeed: 8
gravity: -25
turnSpeed: 18
boundsPadding: 2
groundOffset: 0.02
capsuleHalfHeight: 1
capsuleRadius: 0.7
animations:
  idle: null
  walk: Armature|walking_man|baselayer
  run: Armature|running|baselayer
motion:
  acceleration: 20
  deceleration: 16
  stopSpeed: 0.06
  runStateThreshold: 0.85
  animationFadeSeconds: 0.25
  walkAnimationRate: 1
  runAnimationRate: 1
  minAnimationRate: 0.72
  maxAnimationRate: 1.18
```

Active primary-path values are start/model transform, rain roughness, eye height, walk/run/gravity/turn speed, capsule dimensions, animation names, acceleration, deceleration and animation fade. `character-visual.yaml` owns the Warden-specific visual scale override.

`jumpSpeed` is configured but there is no jump mechanic. `motion.stopSpeed`, `runStateThreshold` and the animation-rate fields are retained but not used by the current recovered controller. `groundOffset` and `boundsPadding` belong to the TerrainSampler fallback path.

## Terrain

<!-- effective-config: terrain -->
```yaml
targetMeshName: Landscape002
scale: 1
position: [0, 0, 0]
rotationY: 0
heightResolution: 192
sampleChunkRows: 6
fallbackSize: 160
```

`Landscape002` is the gameplay/sampling target. `Landscape046` is a second ground-material target, not the player terrain.

The 192×192 CPU sampler remains a clean-room adapter for gameplay/fallback queries, camera clearance, and grass tile height ranges. Grass blade placement uses the separate recovered 1024×1024 GPU height render target. Primary player collision uses Rapier against the terrain geometry.

## Ground material

<!-- effective-config: ground -->
```yaml
materialTargets:
  - Landscape002
  - Landscape046
grassTextureScale: 150
groundTextureScale: 70
anisotropy: 16
metalness: 0
applyToTerrain: true
rainRipple:
  scale: 1.5
  size: 0.38
  thickness: 0.1
  strength: 3
  speed: 2
  amount: 0.7
```

`materialTargets` and `rainRipple.*` are active configuration inputs. The recovered constants for anisotropy, UV scales and metalness are intentionally hard-coded in `GroundMaterial.js`; the matching YAML fields are parity records, not runtime knobs. `ground.applyToTerrain` and legacy `ground.textureRepeat` are not active gates in the current material path.

## Grass and quality

Core active values include:

<!-- effective-config: grass -->
```yaml
tileSize: 25
type: blade
heightResolution: 1024
maskThreshold: 0.08
useTextureColor: false
atlasColumns: 2
atlasRows: 2
interaction:
  enabled: true
  resolution: 256
  worldSize: 75
  recoverySpeed: 0.94
  footRadius: 0.72
  strength: 1
```

`heightResolution: 1024` drives the recovered GPU terrain-height render target used by the grass TSL material.

Active draw distance, density and blade detail come from:

```text
quality.<performance|balanced|high|ultra>.<blade|billboard>.maxDistance
quality.<...>.lod.<high|medium|low|veryLow>
```

The current initial quality is `high`. The tile pool itself is created once from the recovered startup grass distance and terrain dimensions; switching quality replaces LOD geometries and shader distance without rebuilding that pool.

Retained but inactive legacy grass keys include:

```text
grass.instancesPerDensityUnit
grass.maskThreshold
grass.initialLod
```

Path clearance keys, all active:

```text
grass.pathClearance      metres of vegetation clearance beyond the painted path edge
grass.vegetationCutoff   mask strength at or below which nothing grows
grass.maskSoftness       width of the cutoff ramp
```

`grass.maxDistance` is the recovered startup tile-pool coverage distance. `grass.yOffset` is not part of the recovered height formula and is not consumed by the current material.

## Grass Painter

<!-- effective-config: painter -->
```yaml
enabled: false
resolution: 1024
flipU: false
flipV: false
brushRadius: 5
height: 5
showPreview: true
initialPaintValue: 83
orbitCameraHeight: 50
brush:
  minRadius: 1
  maxRadius: 100
  keyboardStep: 2
  terrainSpan: 370
  strokeSpacing: 0.3
heightControl:
  min: 1
  max: 10
  maskRange: 200
cursor:
  innerRadius: 0.9
  outerRadius: 1
  segments: 32
  opacity: 0.5
  color: '#ffffff'
preview:
  size: 256
  top: 20
  left: 20
```

The recovered painter/mask surface is 1024×1024. The initial Add value, orbit camera height, brush conversion, cursor and preview constants come from `painter-cursor.yaml`. `painter.paintValue` remains in base config but is not the recovered initial Add value.

## Trees

<!-- effective-config: trees -->
```yaml
highDistance: 170
billboardDistance: 500
highHysteresis: 8
billboardHysteresis: 10
transitionDuration: 1
lodUpdateInterval: 0.1
windSpeed: 3
windStrength: 1.2
windFrequency: 1
simulationSpeed: 1
```

The entire `trees.types` array from `visual-parity.yaml` replaces the older base array. It contains the nine recovered high/low/highLeaves/zone definitions plus per-type collider dimensions.

Authored tree placement comes from `assets.treeWorld: tree-world.json`; `positionsName: TreePositions`, `minScale` and `maxScale` are used only by the fallback marker path. Tree foliage consumes wind speed/strength/frequency/simulation speed, with environment updates replacing wind strength at runtime.

## Leaves

<!-- effective-config: leaves -->
```yaml
count: 240
spawnRadius: 20
despawnRadius: 30
minHeight: -2
maxHeight: 5
minSpeed: 0.5
maxSpeed: 1.5
minSize: 0.12
maxSize: 0.3
windStrength: 1.2
gravity: 0.08
simulationSpeed: 1
```

The three configured base PNGs are fallback asset paths. `src/generated/leafVariants.js` is generated from files present under `public/Assets` and currently adds numbered variants; that registry is not YAML configuration.

## Birds and zones

`zones.yellow/green/white` map to the GLB helper names `YellowZone`, `GreenZone`, `WhiteZone`.

Bird configuration is active: source `Birds`, count `10`, orbit center `[0,100,0]`, height `5..10`, radius `50..200`, speed `0.15..0.25`, scale `3..5`, bob `0.4` at `1.5`, seed `1234`.

## Sky and clouds

<!-- effective-config: sky -->
```yaml
radius: 5000
widthSegments: 64
heightSegments: 32
horizonStart: -0.15
horizonEnd: 0.45
```

<!-- effective-config: clouds -->
```yaml
size: 5000
height: 120
coverage: 0.52
softness: 0.16
density: 1.01
speed: 0.1
wind: [1, 0.2]
opacity: 0.85
followCamera: false
```

`clouds.windDirection: [1,0.3]` survives from base config but is not the active recovered key. The recovered cloud implementation reads `clouds.wind`, supplied by `visual-parity.yaml`.

## Environment presets

Seven preset keys are active:

```text
sunny
goldenHour
rainy
windy
calm
bowed
moonlight
```

Each supplies blade/billboard grass state, lighting, sky/fog, cloud coverage and `rain`. `EnvironmentController` converts the rain boolean to a numeric `rainIntensity` when an explicit intensity is not supplied and interpolates it over the same five-second transition.

See `environment-presets.md` for exact preset values.

## Rain

<!-- effective-config: rain -->
```yaml
count: 10000
area: 20
top: 100
bottom: -100
speed: -45
windX: 0.8
windZ: 0.25
windStrength: 10
windStrengthMultiplier: 10
windVariation: 0.6
turbulence: 0.8
dropLength: 1.8
dropWidth: 0.035
opacity: 2
colorLinear: [0.78, 0.86, 1]
defaultRoughness: 0.2
```

These drive the recovered GPU-instanced rain path. The old base values (`bottom: 0`, `speed: 30`, opacity `0.72`, hex color) are overridden and are not the effective reference state.

## Water

<!-- effective-config: water -->
```yaml
colliderName: WaterCollider
size: 400
segments: 128
position: [312.7059326171875, -17, 163.0625]
speed: 1.1
waveHeight: 0.15
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
reflectionStrength: 0.45
reflectionDistance: 1.2
reflectionResolution: 1024
reflectionNear: 0.1
reflectionFar: 1000
sunColor: '#ffffff'
sunDirection: [0.707, 0.8, 0.25]
sunStrength: 0.45
deepColor: '#18677d'
surfaceColor: '#5dbbb1'
reflectionColor: '#1c9199'
roughness: 0.24
metalness: 0
fresnelPower: 4
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

The visible lake is generated from these values. Legacy base keys such as `objectName`, fallback plane values, `color`, `opacity`, `waveStrength` and `waveSpeed` are no longer the recovered visible-water path. `distortion` is created but not consumed by the recovered shader graph; `reflectionDistance` is passed/configured but not consumed by the reflection helper.

## World props and collision

<!-- effective-config: props -->
```yaml
stoneSourceName: Stone
lanternSourceName: Lantern
rainRoughness: 0.1
anisotropy: 16
```

<!-- effective-config: collisions -->
```yaml
activeDistance: 50
inactiveDistance: 70
trimeshObjects:
  - WaterCollider
  - HouseCollider
```

Collision mapping:

```text
worldBounds                 -> boxes
tree type collider          -> scaled boxes
Lantern                     -> rotated boxes
Stone                       -> convex hulls
collisions.trimeshObjects   -> trimeshes
```

## Audio

Audio asset paths and volumes are active. Footstep intervals are:

<!-- effective-config: audio.footstepIntervals -->
```yaml
walk: 0.46
run: 0.3
```

Audio environment targets are changed immediately on preset selection and then volume-faded by `AudioSystem`; they do not use the visual transition curve frame-by-frame.

## Rule for adding configuration

Do not add a YAML key merely to document a constant. A configurable value should have a real runtime consumer. If recovered parity requires a literal constant, keeping that constant beside its implementation is preferable to creating a dead knob.

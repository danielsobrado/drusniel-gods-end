# Asset Contract

This document defines the asset paths, scene-object names, coordinate assumptions and failure behavior expected by current `main`. It is written as a handoff contract for another AI or artist replacing assets while preserving the same runtime behavior and look-and-feel.

The runtime intentionally depends on several GLB object names as metadata. A file can load successfully yet still produce the wrong world if those names, UVs, scales or animation clips do not match this contract.

## Source files

```text
public/config.yaml
public/ground-material.yaml
public/player-controls.yaml
public/visual-parity.yaml
public/character-visual.yaml
src/assets/assetUrl.js
src/world/loadTerrain.js
src/world/createWorld.js
src/world/TerrainSampler.js
src/world/GroundMaterial.js
src/world/TreeSystem.js
src/world/ZoneIndex.js
src/foliage/BirdSystem.js
src/foliage/LeafSystem.js
src/player/PlayerController.js
src/grass/GrassMask.js
src/water/WaterSurface.js
src/audio/AudioSystem.js
```

---

## 1. Public asset root and URL behavior

Files live under:

```text
public/Assets/
```

YAML paths deliberately omit `public/`:

```text
Assets/terrain/landscape/landscape.glb
```

`assetUrl()` resolves a configured asset path against `document.baseURI`.

That is important for Vite/static deployment under a subpath. Do not hard-code absolute `/Assets/...` URLs if preserving this deployment behavior.

File and folder case must be treated as case-sensitive for Linux/Cloudflare deployment.

---

## 2. Current expected asset tree

Relevant layout:

```text
public/
  Assets/
    terrain/            <- terrain2.glb split by object type, see section 3
      landscape/
      structures/
      zones/
      trees/
      props/
      colliders/
      fauna/
    Drusniel_Dark_Elf.glb
    blend2.jpg
    grass.jpg
    zwartkops_straight_morning_1k.hdr

    ground/
      ground_0109_color_1k.jpg
      ground_0109_normal_directx_1k.jpg
      ground_0109_roughness_1k.jpg

    leaf-yellow.png
    leaf-green.png
    leaf-whites.png

    Audio/
      wind-loop2.mp3
      rain.mp3
      insects.mp3
      lake2.mp3
      transition.mp3
      bird1.mp3 ... bird5.mp3
      grass-footstep1.mp3 ... grass-footstep6.mp3
      mud-footstep1.mp3 ... mud-footstep3.mp3
      water-footstep1.mp3 ... water-footstep3.mp3
```

The code does not require these exact filenames where the path is YAML-configured, but these are the current paths used for visual/audio parity.

---

# Terrain GLB Contract

## 3. Terrain asset

The authored source is a single scene, `assets-source/terrain2.glb`, which is not served. `npm run assets:split-terrain` subsets it into one GLB per object group, foldered by object type under `public/Assets/terrain/`, and the runtime lists those parts:

```yaml
assets:
  terrainParts:
    - landscape: Assets/terrain/landscape/landscape.glb
    - zones: Assets/terrain/zones/zones.glb
    - colliders: Assets/terrain/colliders/colliders.glb
    - structures/fence: Assets/terrain/structures/fence.glb
    - structures/sketchfab-world: Assets/terrain/structures/sketchfab-world.glb
    - props/stone: Assets/terrain/props/free_pack_-_rocks_stylized.glb
    - props/lantern: Assets/terrain/props/lantern.glb
    - fauna/birds: Assets/terrain/fauna/birds.glb
    - trees/tree1: Assets/terrain/trees/tree1.glb
    # ... through trees/tree9
```

Each part is loaded with `GLTFLoader` and optional `DRACOLoader`, in parallel, and the loaded scenes are reparented under one `TerrainRoot` group. The split is a lossless glTF subset -- node names, transforms and Draco payloads are unchanged -- so every system that resolves an object with `getObjectByName` on the terrain root behaves exactly as it did against the single file.

A part that fails to load is warned about and skipped; the systems that own its objects fall back on their own. `assets.terrain` is still honoured as a single-file source if `assets.terrainParts` is absent.

Current root transform:

```yaml
terrain:
  scale: 1
  position: [0, 0, 0]
  rotationY: 0
```

The runtime applies this transform to the full GLB root before extracting world-space bounds/markers/zones.

Asset scale/orientation should therefore be authored to work under identity runtime transform unless these YAML values are deliberately changed.

---

## 4. Terrain object names currently queried

The terrain GLB is expected to expose some or all of:

```text
Landscape002
Landscape046
TreePositions

Tree1_High
Tree1_Low
Leaves_LOD0
Tree2_High
Tree2_Low
Leaves_LOD0001
Tree3_High
Tree3_Low
Leaves_LOD0002
Tree4_High
Tree4_Low
Leaves_LOD0003
Tree5_High
Tree5_Low
Leaves_LOD0004
Tree6_High
Tree6_Low
Leaves_LOD0005
Tree7_High
Tree7_Low
Mesh_1001
Tree8_High
Tree8_Low
Mesh_1003
Tree9_High
Tree9_Low
Mesh_1004

YellowZone
GreenZone
WhiteZone

Birds
LakeWater
WaterCollider
```

These names are an application API even though they are embedded in a GLB.

---

## 5. Terrain sampling target

Preferred object:

```text
Landscape002
```

Configuration:

<!-- effective-config -->
```yaml
terrain:
  targetMeshName: Landscape002
```

`config.yaml` sets `Landscape046`, but `visual-parity.yaml` overrides it. `Landscape046` remains correct for `ground.materialTargets` below.

This object determines, when present:

```text
TerrainSampler world bounds
192x192 height-grid sampling region
CPU fallback height sampling
GPU grass height-texture bounds
world-to-UV mapping used by grass mask
Grass Painter mapping
terrain movement bounds
camera terrain clearance
```

If `Landscape002` changes scale, origin, rotation, topology or UV relationship, many downstream systems can become visually misaligned at once.

If it is absent, runtime falls back to the full terrain root as sampling target.

---

## 6. Ground material targets

Configured:

```yaml
ground:
  materialTargets:
    - Landscape002
    - Landscape046
```

`createWorld()` finds these names and traverses their mesh descendants.

Each mesh receives the same generated `GroundBlendMaterial` and `receiveShadow = true`.

If neither name exists, the target returned by `loadTerrain()` becomes the fallback material target.

---

## 7. UV requirement for terrain appearance

The generated ground material samples:

```text
base UV
UV * grassTextureScale (150)
UV * groundTextureScale (70)
base UV for blend2.jpg
```

Therefore the replacement target mesh needs meaningful UVs.

Most importantly, `blend2.jpg` must line up with the intended terrain regions in the same UV orientation used by the material and by the world-to-UV mapping expected for grass distribution.

The current mask is not a generic world-space triplanar texture.

---

# Tree Contract

## 8. `TreePositions`

`TreePositions` is an authoring/metadata group. Runtime uses authored world placement data when available and keeps the marker path as fallback behavior.

Replacement tree sources should preserve their logical origin and scale relationship because visible high/low/billboard representations must line up during LOD transitions.

---

## 9. Tree source definitions

Exact current mappings:

```text
Tree1_High / Tree1_Low / Leaves_LOD0    / yellow
Tree2_High / Tree2_Low / Leaves_LOD0001 / yellow
Tree3_High / Tree3_Low / Leaves_LOD0002 / yellow

Tree4_High / Tree4_Low / Leaves_LOD0003 / white
Tree5_High / Tree5_Low / Leaves_LOD0004 / white
Tree6_High / Tree6_Low / Leaves_LOD0005 / white

Tree7_High / Tree7_Low / Mesh_1001      / green
Tree8_High / Tree8_Low / Mesh_1003      / green
Tree9_High / Tree9_Low / Mesh_1004      / green
```

For a definition to be usable the high source must exist. If low is missing, the high source is used as fallback. Discovered source objects are hidden and used as templates.

---

## 10. Tree source orientation/scale expectations

High and low source variants should:

```text
share the same logical origin
share compatible forward/up orientation
represent approximately the same physical size
align trunk/root placement
```

If source origins differ, LOD transitions visibly jump even when runtime transforms match.

---

## 11. Tree foliage source name

The configured `leaves` source name identifies foliage-card meshes inside high-detail trees. Runtime applies the tree foliage material and wind deformation to those leaves.

Detached falling leaves are unrelated and use the PNG textures below.

---

# Zone Contract

## 12. Zone helper groups

Configured mappings:

```text
yellow -> YellowZone
green  -> GreenZone
white  -> WhiteZone
```

Zone containment is evaluated in each zone mesh's local geometry bounding box after transforming the queried world point with `worldToLocal()`. The helper meshes/groups are hidden from rendering.

---

## 13. Overlapping zone behavior

`ZoneIndex` checks zones in configuration insertion order:

```text
yellow
green
white
```

The first containing zone wins. A replacement GLB should avoid accidental overlap unless this priority is intended.

---

# Bird Contract

## 14. `Birds` source

Optional object:

```text
Birds
```

If present, it is hidden as an authored source and visible birds clone it. If absent, runtime creates a procedural fallback.

---

## 15. Bird animation contract

The recovered bird system starts animation clip 0 when clips are available. Terrain GLTF animations are also started by `TerrainAnimationSystem`.

---

# Water Contract

## 16. `LakeWater`

Configured visible water uses the authored/fallback water setup together with the procedural water shader and reflection path. Replacement water geometry and collider placement must remain aligned with the playable lake.

---

## 17. `WaterCollider`

Optional metadata object:

```text
WaterCollider
```

Its world bounds are used for water-footstep classification and it also participates in the world collision configuration where named.

---

# Player Contract

## 18. Player GLB

Current file:

```text
Assets/Drusniel_Dark_Elf.glb
```

Effective runtime visual transform:

<!-- effective-config -->
```yaml
player:
  modelScale: 1.35
  modelOffsetY: 0
  modelRotationY: 0
```

The replacement Warden GLB is authored smaller than the previous character, so `public/character-visual.yaml` supplies the visual scale correction after recovered parity configuration. A replacement character with different authored scale/origin/orientation should either be normalized in the asset or use deliberate YAML transform changes. Do not adjust camera, grass, terrain, or world scale to compensate.

---

## 19. Player animation mapping

Configured:

```yaml
idle: null
walk: Armature|walking_man|baselayer
run: Armature|running|baselayer
```

There is no retargeting system.

The Warden asset contains one 24-joint skinned mesh and one movement clip. Walking and running share that clip; entering idle fades it out to the asset's static pose. The controller uses exact clip-name lookup, so replacement clips must already animate the replacement skeleton correctly.

---

## 20. Rig and armour contract

The runtime does not split body and armour into separate equipment systems.

It keeps the imported hierarchy intact and creates one `AnimationMixer` on the GLB model root.

Therefore armour should already be authored in the GLB as either:

```text
skinned meshes bound to the skeleton
or rigid meshes/nodes parented appropriately in the rig hierarchy
```

No hard-coded bone names are required by the application.

---

## 21. Grass-interaction influence points

The Warden asset does not contain dedicated foot-helper meshes, so the current configuration leaves `player.influenceObjects` unset and uses the controller's two reusable root-relative fallback points.

Replacement assets may optionally configure helper mesh names. Meshes whose names contain `FootSphere` are hidden visually but remain attached to the rig. For each configured helper, the runtime reads world position, world scale and geometry bounding-sphere radius for grass interaction.

They are not collision capsules and do not affect player movement physics.

---

# Grass/Ground Texture Contract

## 22. `blend2.jpg`

Current:

```text
Assets/blend2.jpg
```

Convention:

```text
black = strong grass / grass-colored ground
white = no grass / exposed PBR ground
```

Runtime creates independent grass-mask and ground-material texture representations from this file. The painter edits the grass mask; exported mask changes must be persisted/reloaded if the ground blend should use the same edited asset.

---

## 23. Grass color texture

Current:

```text
Assets/grass.jpg
```

Used by `GroundMaterial` as the grassy-ground color source. Blade grass itself uses the current grass material path rather than this ground texture.

---

## 24. Ground PBR set

Current:

```text
Assets/ground/ground_0109_color_1k.jpg
Assets/ground/ground_0109_normal_directx_1k.jpg
Assets/ground/ground_0109_roughness_1k.jpg
```

Color is sRGB. Normal and roughness are numeric data.

All required ground inputs must load or `createGroundMaterial()` falls back to the simpler material path.

---

# Leaf Texture Contract

## 25. Falling-leaf textures

```text
Assets/leaf-yellow.png
Assets/leaf-green.png
Assets/leaf-whites.png
```

The falling-leaf system uses these sources and generated variants with alpha-tested/double-sided cards. Textures need usable alpha information to avoid visible rectangular cards.

---

# HDR Contract

## 26. Environment HDR

Current:

```text
Assets/zwartkops_straight_morning_1k.hdr
```

Loaded with `RGBELoader` and assigned to `scene.environment` with equirectangular reflection mapping. Visible atmosphere comes from the procedural sky/cloud system.

Changing the HDR can change PBR lighting dramatically even with identical sun/sky colors.

---

# Audio Contract

## 27. Ambient / transition audio

```text
Assets/Audio/wind-loop2.mp3
Assets/Audio/rain.mp3
Assets/Audio/insects.mp3
Assets/Audio/lake2.mp3
Assets/Audio/transition.mp3
```

The current audio system uses Three.js audio/listener infrastructure and world-aware emitters where applicable. Asset paths remain configuration-driven.

---

## 28. Audio banks

Configured banks include bird, grass-footstep, mud-footstep and water-footstep samples. Preserve bank membership and intended surface classification when replacing audio.

---

# Failure and Fallback Matrix

## 29. Expected behavior when assets are missing

```text
terrain GLB missing/fails
  -> root/target fallback behavior

Ground PBR texture set incomplete/fails
  -> simple ground material fallback

player GLB missing/fails
  -> capsule placeholder remains

TreePositions/world data missing
  -> tree fallback placement path

Birds missing
  -> procedural bird fallback

water source missing
  -> fallback water geometry

HDR missing/fails
  -> scene continues without expected environment lighting

TSL sky/cloud creation fails
  -> solid configured scene background

audio clip fails
  -> warning/ignored play failure; rendering continues
```

A reproduction should preserve graceful degradation and not make optional visual failures fatal.

---

# Exact Replacement Workflow

## 30. Terrain replacement procedure

Before swapping `assets-source/terrain2.glb` and re-running `npm run assets:split-terrain`, verify:

```text
1. intended physical scale
2. world up axis and origin
3. Landscape002 exists or update targetMeshName
4. Landscape002/046 material targets exist or update config
5. terrain UVs align with blend2.jpg
6. TreePositions / authored tree placement data are correct
7. all desired tree high/low sources exist
8. zone helpers exist and local bounds are sensible
9. Birds source/animation ordering is understood
10. water source is correct
11. WaterCollider bounds are correct
12. export retains names exactly/case-sensitively
```

Then validate TerrainSampler, grass mask alignment, camera clearance and player scale before tuning shaders.

---

## 31. Player replacement procedure

Verify:

```text
1. asset scale and local origin
2. forward direction relative to modelRotationY 0
3. skeleton/skin relationships preserved
4. available movement clips exist and animation mappings are updated
5. armour is bound/parented correctly
6. optional influence helpers exist or fallback interaction is accepted
7. configured helper world transforms follow feet during animation
8. player model does not require root-motion world translation
```

Current controller drives world movement itself.

---

## 32. Texture replacement procedure

For the ground/mask:

```text
1. preserve dimensions/aspect needed by terrain mapping
2. preserve black/white mask convention
3. preserve orientation; do not accidentally vertically flip blend2.jpg
4. keep color maps as color data and normal/roughness as linear numeric data
5. visually validate UV scale 150 vs 70
6. ensure alpha exists on leaf PNGs
7. compare HDR exposure/lighting before changing preset values
```

---

## 33. Exact reproduction checklist

Another AI recreating the project should not stop at "the files load". Verify:

- all paths resolve through `document.baseURI`,
- folder/file case matches deployment,
- terrain object names match exact config,
- terrain sampling target and ground targets are correct,
- mask aligns in world space with visible terrain,
- tree high/low origins align during LOD transitions,
- zone helpers produce intended regions,
- bird source/animation behavior is understood,
- water mesh/collider are aligned,
- player clip/helper names and character scale are correct,
- HDR is the same lighting environment,
- audio banks retain intended membership.

---

## 34. Contract rule

When replacing an asset, update **either** the asset to satisfy this contract **or** the YAML/code/docs to intentionally define a new contract.

Do not silently rename GLB nodes or alter mask conventions and then tune unrelated systems to compensate. That makes reproduction brittle and hides the real mismatch.

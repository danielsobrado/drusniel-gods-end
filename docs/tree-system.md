# Tree System

This document describes the recovered tree contract and the current `TreeSystem` implementation on `main`.

## Source files

```text
src/world/TreeSystem.js
src/world/TreeLeafMaterial.js
src/world/loadTreeWorldData.js
public/tree-world.json
public/visual-parity.yaml
public/tree-rendering.yaml
```

Falling detached leaves are handled separately by `LeafSystem`.

## Current model upgrades

The active GLBs are `Assets/terrain/fantasy/tree1.glb` through `tree9.glb`, generated offline by `npm run assets:fantasy` from the preserved tree splits. Each high-detail model adds a flared trunk base, seven tapered, curved roots, and a gentle trunk/branch sweep. Roots reuse the bark texture and are merged into the bark primitive, keeping two high-detail meshes and the existing shared materials. The nine GLBs total about 5.28 MB versus 5.08 MB before the new textures (4.85 MB for the original models).

`trees.shapeVariation` in `tree-rendering.yaml` gives each placement stable, independent width, depth and height proportions. This varies meadow crowns without duplicating geometry or shader materials. The same proportions apply to billboard transforms and trunk collider dimensions. The asset review page is `/scripts/debug/fantasy-assets.html`.

Seven user-supplied paintings are preserved in `assets-source/stylized-textures`. The texture preparation script exports 512-square JPEG bark and transparent indexed PNG foliage, about 0.83 MB combined. Four bark patterns and three leaf palettes replace the photographic maps; leaf UVs turn to match the new sprig attachment. Distant atlases are rebaked from the upgraded geometry and colors, with updated quad bounds. To regenerate after artwork changes: run `npm run assets:fantasy`, start Vite on port 5173, run `npm run assets:tree-billboards`, then run `npm run assets:fantasy` again to embed the atlases. The baker requires the browser harness dependencies (`npm ci --prefix scripts/browser`). Atlas metadata includes a source hash; stale atlases are not embedded.

## Original placement source

### Snow-region additions

Types 10 and 11 are original procedural conifers: a tall, layered snow spruce and a broader windswept mountain pine. Each has six exposed roots, textured bark, evergreen branch clusters and modeled snow caps. Three shared near materials and a two-card distant atlas keep instance costs bounded. The existing deterministic shape variation changes width, height, depth and orientation across placements.

`AlpineTrees.js` seeds these species only in the alpine region, from the existing treeline up to 28 meters above the basin floor. It rejects steep ground and leaves a four-meter clearance sample around paths. Ordinary meadow trees retain their existing alpine exclusion. Generate with `npm run assets:alpine-trees`, bake types 10–11 using `TREE_BAKE_START=10 TREE_BAKE_END=11 npm run assets:tree-billboards` (environment syntax varies by shell), then rerun the alpine generator. Review both species with the Snow trees button on the fantasy asset review page.

The recovered demo supplies an authored world-data array. Each tree record is:

```text
[x, y, z, rotationY, scale, typeIndex]
```

The repository stores those records in:

```text
public/tree-world.json
```

The authored Y value is part of the recovered transform and must be preserved. Do not replace it with `TerrainSampler.sampleHeight()`.

`TreePositions` remains available as a fallback marker source when authored world data cannot be loaded, but reference parity uses the recovered world data.

## Tree definitions

The original uses nine high/low source pairs from `terrain2.glb`:

```yaml
- { high: Tree1_High, low: Tree1_Low, highLeaves: Leaves_LOD0,    zones: [yellow] }
- { high: Tree2_High, low: Tree2_Low, highLeaves: Leaves_LOD0001, zones: [yellow] }
- { high: Tree3_High, low: Tree3_Low, highLeaves: Leaves_LOD0002, zones: [yellow] }
- { high: Tree4_High, low: Tree4_Low, highLeaves: Leaves_LOD0003, zones: [white] }
- { high: Tree5_High, low: Tree5_Low, highLeaves: Leaves_LOD0004, zones: [white] }
- { high: Tree6_High, low: Tree6_Low, highLeaves: Leaves_LOD0005, zones: [white] }
- { high: Tree7_High, low: Tree7_Low, highLeaves: Mesh_1001, zones: [green] }
- { high: Tree8_High, low: Tree8_Low, highLeaves: Mesh_1003, zones: [green] }
- { high: Tree9_High, low: Tree9_Low, highLeaves: Mesh_1004, zones: [green] }
```

The recovered per-type collider dimensions in `visual-parity.yaml` are consumed by `GrassDemo.#registerTreeColliders()`, which registers a box collider per tree into the Rapier world via `WorldCollisionSystem`. Box size is `collider.{width,height,length}` scaled by the tree's own scale, centred at half the collider height above the tree origin.

## Source preparation

`TreeSystem` looks up the high and low objects in the terrain GLB. The optional `highLeaves` name is used to recognize the corresponding foliage mesh inside high-detail clones.

Source objects are templates and are hidden after setup.

High-detail runtime trees are cloned with `SkeletonUtils.clone()` so animated/skinned hierarchies remain safe if present.

## High-detail foliage

When a cloned mesh name matches the recovered `highLeaves` name, `TreeLeafMaterialFactory` supplies a TSL foliage material shared by clones of that source material. Bark materials are also shared by source. Each tree stores its own tint and transition opacity in `userData.treeAppearance`; shader object references read those values without baking a different shader graph per tree.

The material:

- keeps the source map,
- is double-sided,
- uses alpha testing rather than transparent blending,
- keeps depth writes,
- applies procedural vertex wind,
- applies an alpha-aware shadow mask.

This is separate from the falling-leaf particle system.

## LOD distances

The recovered reference used a 170-unit high-detail radius and hid far trees after 500 units. That distance is too short for free-fly and elevated overview cameras because large parts of the forest disappear at once.

The current exploration tuning is layered in `tree-rendering.yaml` after the recovered parity values:

```yaml
trees:
  highDistance: 170
  billboardDistance: 4000
  highHysteresis: 8
  billboardHysteresis: 200
  transitionDuration: 1
  lodUpdateInterval: 0.1
  billboard:
    alphaTest: 0.4
    anisotropy: 4
```

The high-detail radius remains unchanged. Only the cheap far representation receives the long visibility range.

## Current runtime representations

Each authored tree gets:

1. a high-detail cloned hierarchy,
2. a far representation placed into an instanced billboard group for its tree type.

The far geometry is baked from the corresponding low source into the high source's local coordinate context before instancing.

Billboard instances keep the authored position, rotation and scale. Far groups do not cast or receive shadows.

The far material is an unlit `MeshBasicNodeMaterial`, so long-range trees avoid per-pixel PBR lighting. It keeps the alpha-tested source texture, cinematic palette mapping, fog, depth writes and per-instance transition opacity.

## LOD states

Current `TreeSystem` uses three states:

```text
HIGH
BILLBOARD
HIDDEN
```

Initial state is chosen from horizontal camera distance:

```text
distance < 170     -> HIGH
170..4000          -> BILLBOARD
>= 4000            -> HIDDEN
```

Using horizontal distance is intentional for elevated cameras: gaining altitude does not by itself make nearby terrain trees disappear.

`resetLod()` sets visibility and both representation opacities immediately during initialization and again after the initial camera placement, before shader warm-up. This avoids compiling thousands of distant high-detail meshes during loading.

State changes use hysteresis:

```text
high threshold hysteresis: 8
billboard threshold hysteresis: 200
```

LOD checks are throttled to approximately every 0.1 seconds.

## Transition

A state change starts a one-second smooth transition. The per-tree high-detail opacity and per-instance billboard opacity are interpolated rather than swapped instantly. Shared materials stay unchanged, so a fading tree cannot change the opacity of neighboring trees.

The billboard groups store a dynamic per-instance opacity attribute, allowing many far trees of one source type to share one instanced draw path while transitioning independently.

## Authored transforms

For world-data placement:

```text
position = [record[0], record[1], record[2]]
rotationY = record[3]
scale = record[4]
typeIndex = record[5]
```

No terrain-height correction or arbitrary ground offset is applied.

If a tree appears to float after this path is active, first verify that:

- the GLB root transform matches the original,
- the correct tree source hierarchy is being cloned,
- the gameplay/visible terrain is the original GLB terrain,
- no generated replacement terrain has shifted the visual ground.

Do not mutate authored tree Y values to hide a coordinate-system bug.

## Fallback marker placement

If `tree-world.json` is unavailable, `TreePositions` can be used as a fallback. Marker mode performs zone lookup and deterministic random source/scale/rotation selection.

That fallback is useful for resilience but is not the recovered reference placement path.

## Wind

High foliage wind is applied in `TreeLeafMaterialFactory` with TSL vertex displacement. Environment preset changes feed tree wind strength from the current grass wind value.

The far billboard material is intentionally unlit and does not run the high-detail foliage wind shader.

## Collision status

Tree collider sizes are registered into the Rapier world by `WorldCollisionSystem`, alongside authored world bounds and named trimesh objects. Colliders are distance-gated: enabled within `collisions.activeDistance` of the player and disabled beyond `collisions.inactiveDistance`, with the gap acting as hysteresis.

## Runtime checklist

- load `public/tree-world.json` successfully,
- preserve authored Y values,
- use all nine recovered source definitions,
- use `highLeaves` names exactly,
- high-detail distance remains 170,
- cheap billboards remain visible to 4000 units,
- billboard hysteresis is wide enough for fast flight,
- transition duration is one second,
- LOD checks are throttled to 0.1 seconds,
- source objects stay hidden,
- high foliage uses alpha-tested TSL leaf materials,
- far trees use unlit instanced materials with no shadows,
- no arbitrary terrain resampling is applied to authored tree transforms.

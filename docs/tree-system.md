# Tree System

This document describes the recovered tree contract and the current `TreeSystem` implementation on `main`.

## Source files

```text
src/world/TreeSystem.js
src/world/TreeLeafMaterial.js
src/world/loadTreeWorldData.js
public/tree-world.json
public/visual-parity.yaml
```

Falling detached leaves are handled separately by `LeafSystem`.

## Original placement source

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

When a cloned mesh name matches the recovered `highLeaves` name, `TreeLeafMaterialFactory` supplies a dedicated TSL foliage material.

The material:

- keeps the source map,
- is double-sided,
- uses alpha testing rather than transparent blending,
- keeps depth writes,
- applies procedural vertex wind,
- applies an alpha-aware shadow mask.

This is separate from the falling-leaf particle system.

## Recovered effective LOD distances

The TreeSystem class has internal defaults, but the delivered demo's main code explicitly instantiates it with:

```yaml
trees:
  highDistance: 170
  billboardDistance: 500
  highHysteresis: 8
  billboardHysteresis: 10
  transitionDuration: 1
  lodUpdateInterval: 0.1
```

For parity, **170 / 500 are the effective reference values**. Do not replace them with the smaller constructor defaults.

## Current runtime representations

Each authored tree gets:

1. a high-detail cloned hierarchy,
2. a far representation placed into an instanced billboard group for its tree type.

The far geometry is baked from the corresponding low source into the high source's local coordinate context before instancing.

Billboard instances keep the authored position, rotation and scale.

## LOD states

Current `TreeSystem` uses three states:

```text
HIGH
BILLBOARD
HIDDEN
```

Initial state is chosen from horizontal camera distance:

```text
distance < 170   -> HIGH
170..500         -> BILLBOARD
>= 500           -> HIDDEN
```

State changes use hysteresis:

```text
high threshold hysteresis: 8
billboard threshold hysteresis: 10
```

LOD checks are throttled to approximately every 0.1 seconds.

## Transition

A state change starts a one-second smooth transition. The high-detail material opacity and per-instance billboard opacity are interpolated rather than swapped instantly.

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

The far billboard material is intentionally simpler.

## Collision status

Tree collider sizes are now registered into the Rapier world by `WorldCollisionSystem`, alongside authored world bounds and named trimesh objects. Colliders are distance-gated: enabled within `collisions.activeDistance` of the player and disabled beyond `collisions.inactiveDistance`, with the gap acting as hysteresis.

This is a gameplay parity gap, not a reason to alter the visible authored transforms.

## Parity checklist

- load `public/tree-world.json` successfully,
- preserve authored Y values,
- use all nine recovered source definitions,
- use `highLeaves` names exactly,
- effective LOD distances are 170 / 500,
- hysteresis is 8 / 10,
- transition duration is one second,
- LOD checks are throttled to 0.1 seconds,
- source objects stay hidden,
- high foliage uses alpha-tested TSL leaf materials,
- no arbitrary terrain resampling is applied to authored tree transforms.

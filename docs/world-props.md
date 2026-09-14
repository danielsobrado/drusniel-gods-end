# Recovered World Props

This subsystem reproduces the Stone and Lantern instances created by the browser-delivered reference demo.

## Source files

```text
src/world/WorldPropSystem.js
src/world/loadWorldPropData.js
public/world-props.json
public/visual-parity.yaml
```

## Evidence

The recovered original reads `Stone` and `Lantern` source objects from the terrain scene (now `Assets/terrain/props/stone.glb` and `Assets/terrain/props/lantern.glb`), prepares their mapped textures, clones them using authored transform arrays and adds the clones to the scene.

The current runtime loads `Assets/terrain/fantasy/rocks.glb`, derived from the preserved stylized rock pack. Large pack meshes (`SM_Rocks_01`–`05`, `08`, `09`) replace the recovered Stone clones at the same authored transforms; the four small meshes become meadow path pebbles and river details. The original `Stone` object name remains a fallback if the pack is absent.

Variants 10 and 11 originally sampled tiny, flat brown patches of the atlas. Assigning the same material did not fix that UV problem. They now use the painted 06/07 geometry and UV islands, reshaped to the original variant bounds. This retains coherent painted surfaces and one shared texture/material across the pack.

`Assets/terrain/fantasy/lantern.glb` replaces the old lantern with a wrought-iron hooked post, hanging chain, hexagonal cage, brass fittings and emissive amber glass. All 20 placed lanterns in the expanded scene share three material batches; no extra lights or texture downloads are added. The source template is hidden after cloning, so it does not appear as an extra lantern at the origin.

Regenerate these GLBs with `npm run assets:fantasy`. Original assets remain intact. Derivative source records are in `public/Assets/terrain/fantasy/manifest.json`; the interactive review is `/scripts/debug/fantasy-assets.html`.

The recovered arrays contain:

```text
80 Stone instances
21 Lantern instances
```

Those exact transforms are stored in `public/world-props.json` rather than procedurally regenerated.

## Stone records

Each Stone record is:

```text
[x, y, z, rotationY, scale]
```

Runtime creation is equivalent to:

```text
stone = Stone.clone()
stone.position = [x,y,z]
stone.rotation.y = rotationY
stone.scale = scale
scene.add(stone)
```

The original also adds a convex-hull collider from each Stone object. Full collider parity is not yet implemented in the clean-room repository.

## Lantern records

Each Lantern record is:

```text
[x, y, z, rotationY]
```

Runtime creation is equivalent to:

```text
lantern = Lantern.clone()
lantern.position = [x,y,z]
lantern.rotation.y = rotationY
scene.add(lantern)
```

The original also adds a box collider centered approximately at:

```text
[x, y + 0.5, z]
```

with size:

```text
[0.8, 2, 0.8]
```

and the same Y rotation. Collision parity remains a TODO for the Rapier/collision pass.

## Source preparation

Both recovered source objects use:

```text
userData.rainRoughness = 0.1
```

When a source material map exists, the original prepares it with:

```text
generateMipmaps = true
minFilter = LinearMipmapLinearFilter
magFilter = LinearFilter
anisotropy = 16
```

The Lantern path also marks the texture for update after changing these settings.

`WorldPropSystem` reproduces the visual/material preparation and exact authored transforms.

## Coordinate rule

Do not resample Stone or Lantern Y values against `TerrainSampler`.

The values in `world-props.json` are recovered authored transforms in the same world coordinate system as the original terrain GLB. Replacing Y with sampled terrain height can move props away from their intended placement.

## Initialization

`GrassDemo` loads tree and prop world data in parallel during the foliage stage, then initializes world props before tree/leaves/birds setup.

The prop system prefers the stylized rock pack meshes (`SM_Rocks_*`) when they are present, and otherwise looks up `Stone` and `Lantern` by exact name. The root is the assembled `TerrainRoot` group, so the lookup is unaffected by which part each object came from.

## Configuration

```yaml
assets:
  worldProps: world-props.json

props:
  stoneSourceName: Stone
  lanternSourceName: Lantern
  rainRoughness: 0.1
  anisotropy: 16
  stonePackScale: 7
  pebbleMaxSize: 0.8
```

## Fallback behavior

If `world-props.json` cannot be loaded, the app logs a warning and continues without recovered props.

If either source object is missing from the GLB, that prop type is skipped and a warning is logged.

This fallback behavior is a clean-room resilience feature, not evidence of original behavior.

## Parity checklist

- exactly 80 recovered Stone records are loaded,
- exactly 21 recovered Lantern records are loaded,
- source names are `Stone` and `Lantern` as the lantern/fallback contract; landscape stones currently instance `SM_Rocks_*` pack variants,
- authored X/Y/Z values are preserved,
- Stone scale is preserved,
- source maps use mipmaps/linear mip filtering/anisotropy 16,
- `rainRoughness` is 0.1,
- no terrain-height correction is applied,
- missing collision parity is tracked separately rather than altering visual transforms.

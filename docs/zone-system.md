# Zone System

This document describes the zone lookup system exactly as implemented on `main`.

## File

`src/world/ZoneIndex.js`

The zone system converts hidden helper geometry from the terrain GLB into simple world-space spatial lookup regions.

## Configured zones

Current configuration:

```yaml
zones:
  yellow: YellowZone
  green: GreenZone
  white: WhiteZone
```

The left side is the runtime zone key. The right side is the object name expected inside the terrain GLB.

## Construction

`GrassDemo` creates the zone index after the player loads and before tree/leaf systems are created:

```text
new ZoneIndex(world.terrain, config)
```

If no terrain root exists, the constructor returns with an empty zone map.

## GLB lookup

For each configured zone, `ZoneIndex` calls:

```text
terrainRoot.getObjectByName(configuredName)
```

If the object does not exist, that zone is skipped.

If it exists:

1. its world matrices are updated,
2. the whole group is traversed,
3. every mesh below it gets a world-space `Box3`,
4. non-empty boxes are stored for that zone,
5. each helper mesh is hidden,
6. the zone group itself is hidden.

The runtime does not retain polygon-level zone geometry for queries. It retains only axis-aligned bounding boxes.

## Data structure

Internally:

```text
Map<zoneKey, Box3[]>
```

For the current configuration, possible keys are:

```text
yellow
green
white
```

A zone may contain several boxes if its helper group contains several meshes.

## Lookup

`getZone(position)` iterates the stored zones in insertion order and returns the first key for which any box contains the supplied point.

Conceptually:

```text
for each zone:
    for each box:
        if box.containsPoint(position):
            return zone
return null
```

The full 3D point is tested, including Y.

## Tree use

`TreeSystem` queries the zone at each `TreePositions` marker.

Tree type definitions contain a `zone` field. Examples:

```yaml
- { high: Tree1_High, low: Tree1_Low, leaves: Leaves_LOD0, zone: yellow }
- { high: Tree4_High, low: Tree4_Low, leaves: Leaves_LOD0003, zone: white }
- { high: Tree7_High, low: Tree7_Low, leaves: Mesh_1001, zone: green }
```

When a marker lies inside a known zone, the tree system prefers source definitions matching that zone.

If no zone is found for a marker, tree candidates are not filtered by zone.

See `docs/tree-system.md`.

## Falling-leaf use

`LeafSystem` checks the player's current position every frame:

```text
currentZone = zoneIndex.getZone(playerPosition) ?? currentZone
```

Only the instanced leaf mesh matching `currentZone` is visible and only particles belonging to that zone are simulated in that update.

The leaf system starts with:

```text
currentZone = green
```

If the player is not inside any known zone, the previous zone remains active rather than switching to `null`.

See `docs/leaf-system.md`.

## Why helper geometry is hidden

Zone meshes exist as authoring metadata, not visible world geometry.

After their `Box3` values are extracted, the code sets both the traversed helper meshes and containing group invisible so they do not appear in the rendered scene.

## Authoring contract

To author zones in the terrain GLB:

1. Create objects/groups named exactly as configured (`YellowZone`, `GreenZone`, `WhiteZone`).
2. Put one or more mesh volumes under each group.
3. Export them with the terrain GLB.
4. They may be simple boxes or other geometry, but the runtime converts each mesh to an axis-aligned world-space bounding box.

Because the runtime uses `Box3`, the precise mesh shape inside the box is ignored.

## Overlapping zones

If zone boxes overlap, `getZone()` returns the first matching zone according to the iteration order of `config.zones`.

With the current YAML that order is:

```text
yellow -> green -> white
```

No priority field or overlap-resolution rule exists beyond that order.

## Current implementation boundaries

- Zones are static after `ZoneIndex` construction.
- Moving or animating helper geometry later does not update stored boxes.
- Queries use axis-aligned bounding boxes, not exact mesh containment.
- Full XYZ containment is tested, not only XZ.
- Missing configured zone objects are silently skipped.
- Zones currently drive tree source selection and falling-leaf family selection.
- Grass distribution, water classification and player movement do not use `ZoneIndex`.

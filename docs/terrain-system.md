# Terrain System

This document separates recovered reference behavior from the clean-room adapter used by this repository.

## Evidence priority

For parity work, use `docs/recovered-original-parity.md` and the browser-delivered recovered code before older assumptions. Do not change terrain targets or material behavior from screenshot inference.

## Original terrain asset

```yaml
assets:
  terrainParts: [ Assets/terrain/landscape/landscape.glb, ... ]
```

The original demo loads `terrain2.glb` and uses two named landscape meshes for different purposes:

```text
Landscape002 -> gameplay terrain passed to player and grass systems
Landscape046 -> second visible terrain mesh receiving the same ground material
```

The current merged configuration therefore uses:

```yaml
terrain:
  targetMeshName: Landscape002

ground:
  materialTargets:
    - Landscape002
    - Landscape046
```

`Landscape046` must not be substituted for the gameplay terrain merely because it is also a ground-material target.

## Original GLB preprocessing

After load, the original traverses the terrain scene and configures every mesh to:

```text
castShadow = true
receiveShadow = true
userData.rainRoughness = 0.1
```

The object named `Sketchfab_model003` receives texture filtering preparation for any mapped mesh below it:

```text
generateMipmaps = true
minFilter = LinearMipmapLinearFilter
magFilter = LinearFilter
anisotropy = 16
```

`src/world/loadTerrain.js` reproduces that preprocessing before the scene is used by the remaining systems.

## Original ground-material assignment

The recovered demo creates the blended PBR ground material and assigns it directly to:

```text
Landscape002
Landscape046
```

It does not replace the visible GLB terrain with a generated plane or height-field mesh.

Ground material details are documented in `ground-pbr-textures.md` and `recovered-original-parity.md`.

## Clean-room terrain sampler

The browser-delivered demo has its own gameplay/collision pipeline. This repository additionally maintains `TerrainSampler` as a practical adapter for the reconstructed player, grass height texture, leaf grounding and camera clearance.

`TerrainSampler` samples **Landscape002** because it is the configured gameplay target.

Current reconstruction settings:

```yaml
terrain:
  targetMeshName: Landscape002
  heightResolution: 192
  sampleChunkRows: 6
```

The sampler:

1. calculates a world-space `Box3` for `Landscape002`,
2. raycasts downward over a 192x192 grid during startup,
3. keeps CPU heights as `Float32Array`,
4. creates an 8-bit grayscale `DataTexture` for TSL grass sampling,
5. exposes the same XZ bounds to the player, grass mask and painter.

This adapter is current repository behavior; it is not evidence that the original demo internally used this exact 192x192 CPU grid.

## CPU height lookup

`sampleHeight(x, z)` bilinearly interpolates four cached values. It is used by the reconstructed player and camera rather than raycasting every frame.

The player root is grounded with:

```text
root.y = sampleHeight(root.x, root.z) + player.groundOffset
```

The camera enforces endpoint clearance with:

```text
cameraY >= sampleHeight(cameraX, cameraZ) + terrainClearance
```

## GPU height texture

The TSL grass shader receives:

```text
texture
boundsMin
boundsSize
minHeight
maxHeight
```

World XZ is converted to 0..1 terrain UV and the red texture channel reconstructs height between `minHeight` and `maxHeight`.

The logical terrain UV convention is shared with `blend2.jpg`, which is essential for grass/dirt alignment.

## World props are not terrain samples

Recovered Stones, Lanterns and Trees use authored transforms recovered from the original code/data. Their authored Y values are not replaced with `TerrainSampler.sampleHeight()`.

See:

- `world-props.md`
- `tree-system.md`

This distinction matters: resampling those authored transforms was an earlier reconstruction mistake and produced visibly floating/misaligned objects.

## Fallback

If the GLB or configured target is unavailable, the reconstruction can create a flat logical/visible fallback terrain. This is a resilience path only and is not original-demo behavior.

## Parity checklist

Before tuning grass or tree offsets, verify all of the following:

- `terrain.targetMeshName` is `Landscape002`.
- `Landscape002` and `Landscape046` both receive the recovered blended ground material.
- no generated terrain surface is replacing the visible GLB terrain.
- terrain meshes cast/receive shadows.
- `rainRoughness` metadata is `0.1` on terrain meshes.
- the gameplay sampler bounds come from `Landscape002`.
- recovered tree/stone/lantern authored Y values are preserved.

If any of these fail, visual tuning on top of the wrong terrain coordinate system is invalid.

# Terrain System

The default expanded cinematic map is described in [Expanded landscape](expanded-landscape.md). It samples the source terrain, creates a larger carved runtime mesh, and hides the old backdrop. The reference reconstruction described below remains historical context and the unexpanded path.

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

The browser-delivered demo has its own gameplay/collision pipeline. This repository additionally maintains `TerrainSampler` as a practical adapter for the reconstructed player, camera clearance, CPU terrain queries and the fallback grass height texture.

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
2. builds a 192x192 CPU height grid from the mesh: cinematic mode rasterizes terrain triangles directly into the grid, while the non-cinematic path samples the mesh with downward raycasts,
3. keeps CPU heights as a `Float32Array`,
4. creates an 8-bit grayscale `DataTexture` from those CPU heights for use only when the preferred GPU grass height texture cannot be created,
5. exposes the same XZ bounds to the player and procedural vegetation system.

This adapter is current repository behavior; it is not evidence that the original demo internally used this exact 192x192 CPU grid.

## CPU height lookup

`sampleHeight(x, z)` bilinearly interpolates four cached values. It is used by the reconstructed player, camera and procedural ecology rather than raycasting every frame.

The player root is grounded with:

```text
root.y = sampleHeight(root.x, root.z) + player.groundOffset
```

The camera enforces endpoint clearance with:

```text
cameraY >= sampleHeight(cameraX, cameraZ) + terrainClearance
```

The procedural vegetation field also samples neighboring heights to estimate local slope and normalized elevation. Those terrain signals influence grass density, growth and understory selection.

## GPU grass height texture

Grass normally does **not** sample the 192x192 8-bit `TerrainSampler` texture.

During `GrassField.init()`, `createGrassTerrainData()` renders `Landscape002` from above into a dedicated GPU height target using the configured grass resolution:

```yaml
grass:
  heightResolution: 1024
```

The generated texture is a 1024x1024 `HalfFloat` render target. An orthographic camera covers the gameplay terrain bounds and the temporary material writes normalized world-space height:

```text
normalizedHeight = (positionWorld.y - minHeight) / (maxHeight - minHeight)
```

The grass shader receives:

```text
texture
boundsMin
boundsSize
minHeight
maxHeight
```

World XZ is converted to 0..1 terrain UV, the red texture channel is sampled, and height is reconstructed between `minHeight` and `maxHeight`.

If GPU height generation fails, `GrassField` logs a warning and falls back to `TerrainSampler`, whose 192x192 8-bit `DataTexture` implements the same shader-data contract.

Both height textures are derived at runtime from the `Landscape002` GLB geometry. There is no authored PNG/JPG heightmap asset that controls terrain elevation.

## Dirt ways versus vegetation

`Assets/blend2.jpg` remains an authored **ground-surface blend** so the recovered dirt ways still line up with the original terrain material. It is not a vegetation mask.

The procedural vegetation builder reads only the dirt-way classification from that ground blend, converts it into world-space distance-to-path, and combines that distance with terrain height, slope, water proximity, tree shade/trunk proximity and deterministic noise. Grass coverage and height are generated from those signals at startup.

The effective configuration explicitly sets the legacy `assets.grassMask` key to `null`; no painted mask or grass painter participates in runtime vegetation placement.

See `docs/procedural-vegetation.md` for the ecology pipeline.

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
- the preferred grass height texture is generated from `Landscape002` at `grass.heightResolution` and the CPU sampler is only its fallback.
- dirt-way surface classification and procedural vegetation are separate systems.
- recovered tree/stone/lantern authored Y values are preserved.

If any of these fail, visual tuning on top of the wrong terrain coordinate system is invalid.

# Coastal jungle v2 source reference

These files are **SOURCE REFERENCE MATERIAL**.

They are **not** loaded by Grass Test.

They exist so a later Grass Test runtime pass can reproduce the Codex-and-Blender forest behavior without guessing. The second-round source contains the performance architecture to adapt: spatial chunking, frustum and distance culling, grass thinning, tree LOD hysteresis, and shared instanced GPU batches.

Do not copy `output/browser/app.js`, `index.html`, or `serve.mjs` into Grass Test. Do not treat this folder as a second application.

## Provenance

- Source: https://github.com/danielsobrado/Codex-and-Blender
- Source commit: `54ac4d9f0cd7168051b1604aa48170a34c550198`
- Source commit message: `second round of assets and improvements`
- License: MIT (see Codex-and-Blender `LICENSE`)

## Files in this folder

| File | Source path |
| --- | --- |
| `forest-world.js` | `web/forest-world.js` |
| `main.js` | `web/main.js` |
| `asset-loader.js` | `web/asset-loader.js` |
| `forest_workflow.yaml` | `config/forest_workflow.yaml` |
| `browser_optimization.yaml` | `config/browser_optimization.yaml` |
| `BROWSER_PACKAGE.md` | `docs/BROWSER_PACKAGE.md` |
| `COASTAL_JUNGLE.md` | `docs/COASTAL_JUNGLE.md` |
| `world_config.json` | `output/forest/world_config.json` |
| `optimization_report.json` | `output/browser/optimization_report.json` |
| `asset_validation.json` | `output/browser/asset_validation.json` |
| `browser_validation.json` | `output/browser/browser_validation.json` |

Matching visual oracles and authored scene evidence also live at:

`public/Assets/terrain/coastal-jungle/reference/v2/`

The v2 combined scene is staged at:

`public/Assets/terrain/coastal-jungle/scenes/coastal_jungle_v2_reference.glb`

The currently active Grass Test scene remains:

`public/Assets/terrain/coastal-jungle/scenes/coastal_jungle_reference.glb`

## Exact source runtime recipe

Do not reinterpret these values. They are copied from `output/forest/world_config.json` and `config/forest_workflow.yaml`.

- `extent: 128` → 256 × 256 m world
- `plant_extent: 22`
- `chunk_size: 16`
- `grass_per_chunk: 540`
- `groundcover_per_chunk: 100`
- `undergrowth_per_chunk: 7`
- `grass_distance: 34`
- `groundcover_distance: 28`
- `undergrowth_distance: 72`
- `tree_distance: 180`
- `tree_lod_distance: 48`
- `max_instances_per_asset: 4500`
- `fog_density: 0.006`
- `seed: 941`

Source runtime behavior also uses:

- chunk frustum rejection
- individual bounding-sphere rejection
- distance rejection
- dense near grass
- progressive grass thinning after ~14 m
- tree LOD hysteresis of approximately ±4 m
- `tree_01..06` → `tree_lod_01..03` mapping
- dynamic InstancedMesh batches
- update-range-limited instance uploads
- no reculling when camera movement/rotation is negligible

Primary forest objects are Meshopt-compressed GLBs. `GLTFLoader` must use `MeshoptDecoder` when those files are loaded.

# Textured coastal jungle

The combined scene follows the latest tropical reference: an uphill clearing, dense green grass, ferns and broad leaves, foreground palms, taller canopy trees and hanging vines. The earlier dry hillside kit is preserved. Dry grass, cactus skin and agave textures are optimized but intentionally not scattered into the tropical biome.

## Files

For browser delivery, use `output/coastal_jungle_browser.zip`. It contains only the runtime, shared textures and compressed geometry, with bundled JavaScript and precompressed Brotli files. `output/coastal_jungle_objects_optimized.zip` contains the 32 reusable Meshopt GLBs. The original authoring outputs below remain available. See [browser package instructions](BROWSER_PACKAGE.md) for building, serving and decoder setup.

- `output/forest/coastal_jungle.blend`: editable Blender scene with packed textures and linked mesh instances.
- `output/forest/coastal_jungle.glb`: combined scene with embedded WebP textures and `EXT_mesh_gpu_instancing`.
- `output/textures/`: thirteen semantically named optimized PNGs and WebPs, a derived feathered path texture, and the filename/size/hash manifest.
- `assets/textures/`: full-resolution source copies, preserved byte-for-byte under descriptive names.
- `web/`: local Three.js viewer, pinned dependencies and browser verification.
- `output/forest/objects/`: 32 individually exported plant variants, including three distant tree LODs, and their dimensions/triangle-count manifest.
- `output/forest/world_config.json`: generated runtime scatter, extent and culling settings.
- `output/coastal_jungle_objects.zip`: individual reusable GLBs.
- `output/coastal_jungle_web_pack.zip`: the scene, assets and runnable local viewer.
- `output/forest_previous/`: saved scene and render snapshot from before the asset improvements.

The refined kit includes three grass variants, two ground-cover patches, two ferns, three broad-leaf plants, two palms, six canopy trees, two shrubs, two hanging vines, two trunk climbers, three background trees, three tree LODs and two split-leaf plants. Canopy forms include wide crowns, shorter spreading trees and taller slender trees. Tree crowns use rounded groups of small-leaf branch sprays, connected secondary twigs, curved trunks, smooth bark normals and integrated hanging vines. Their custom foliage normals soften lighting across each crown. Broad-leaf variants distinguish upright banana-like leaves from wider heart-shaped leaves. Split-leaf silhouettes are modeled in the mesh. Vines export with a top attachment pivot; the other assets use ground origins.

The terrain is now 256 × 256 metres, compared with the original 44 × 44 metre ground patch: about 34 times the ground area. Blender contains the full terrain, over 1,200 distant trees, scattered shrubs and the detailed central vegetation. The viewer deterministically adds grass, low cover, ferns and broad leaves outside that central area, using the same exported meshes and terrain elevation. Its complete population is about 176,000 instances, indexed into 256 spatial chunks. Only a subset is sent to the GPU for the current view. Parameters and variant profiles live in `config/forest_workflow.yaml`; the plant builders are in `blender/jobs/forest_plants.py`. The scene remains an approximation of the reference, with no character or logo.

Square textures are 1024 x 1024; the agave leaf is 512 x 1024 to preserve its aspect ratio. Transparent images retain alpha. PNG copies are available for broad tool compatibility. WebP reduces download size but is not GPU texture compression; mipmapped RGBA texture memory is still approximately 5.33 MiB per 1024-square texture. The forest uses nine maps. KTX2 is not included.

The new uploads are preserved as `assets/textures/canopy_branch_atlas_new.png` and `assets/textures/tropical_bark_basecolor.png`. Their optimized copies now supply the canopy and mossy broadleaf bark. Palms retain their separate palm bark. The earlier procedural atlas builder remains available in `blender/jobs/forest_atlas.py` but is no longer a dependency of the forest build. All source artwork was supplied by the user.

The latest uploads are named `jungle_ground_basecolor`, `jungle_path_basecolor`, and `jungle_grass_reference_atlas`. The original `jungle_grass_atlas` remains available. Ground and path textures repeat at a two-meter scale. `ForestPath` is a terrain-following ribbon using a derived irregular feathered alpha edge, so its soil fades into the surrounding forest floor in both Blender and the GLB. Surface filenames, texture scale and path width are configured under `forest.surface_textures`.

## Run

```powershell
cd web
npm ci
npm run dev
```

Open http://127.0.0.1:4173. Drag to orbit, scroll to move closer, use WASD to travel and Shift to move faster. Reference view, Forest interior and Forest overview reset the camera. Wind changes vertex positions only in the Three.js viewer. Lighting, fog and shadows are configured by the viewer because scene GLB exports do not transfer the entire Blender rendering setup. The sky uses a procedural cloud shader. Sun shadows are cached and refreshed after substantial camera travel; small wind motion does not refresh shadows each frame.

For another Three.js application, use `web/forest-world.js` with the main GLB, `world_config.json`, and `objects/tree_lod_01.glb` through `tree_lod_03.glb`. A bare `GLTFLoader` import contains the Blender scene but does not add the extended grass population or this culling system. The loader must support `EXT_texture_webp` and `EXT_mesh_gpu_instancing` (the pinned Three.js version does). Retain alphaTest 0.4, double-sided foliage, sRGB color textures, mipmaps and anisotropic filtering.

The runtime first rejects off-screen chunk bounds, then tests individual plant bounds against the camera frustum. Distance limits remove small ground cover before larger plants. Grass density decreases with distance; canopy trees switch to simpler meshes with a hysteresis band. Surviving transforms are packed into shared GPU instance batches, with uploads restricted to their active ranges. Camera position and direction changes trigger culling updates. This provides frustum and distance culling, not occlusion queries; plants hidden behind other plants can still be rendered. Raw instance totals are intentionally much larger than the visible workload.

## Rebuild

Activate `.venv` and set `BLENDER_BIN`, then:

```powershell
python scripts/prepare_textures.py
python scripts/blender_runner.py all --config config/forest_workflow.yaml
```

Texture names, source mapping and target sizes are controlled by `config/textures.yaml`. Scene parameters, seeds, cameras and densities are in `config/forest_workflow.yaml`; atlas meshes, UVs and scatter generation are in `blender/jobs/forest.py`. Generated output is not the source of truth.

## Validation and limits

Structural checks and exact object state are recorded in `output/forest/validation.json` and `scene_state.json`. Three Blender views and three browser screenshots provide visual evidence. `npm test` in `web/` checks loading, runtime exceptions, view switching, the wind toggle, keyboard travel, tree LOD use, off-screen rejection, visible-instance capacity and a draw-call budget; results are saved in `output/forest/browser_validation.json`. Its per-view statistics distinguish the total population from submitted instances and triangles.

After rebuilding, run the standalone asset round-trip check, `npm test`, and `python scripts/package_forest.py` to refresh the delivery ZIPs. Packaging refuses failed or stale build evidence.

This is a textured procedural approximation, not a pixel-identical recreation. Surface detail comes from the supplied generated color images; there are no calibrated normal/roughness maps or scanned tree models. The scene uses a finite terrain patch, and overview or unrestricted orbit movement can reveal its edges. Headless browser timing uses SwiftShader software rendering here and is not a certified GPU frame-rate target. Profile on the intended device. LOD transitions are discrete; collision and pointer-lock first-person controls are not implemented.

Technical references: [Three.js InstancedMesh](https://threejs.org/docs/pages/InstancedMesh.html), [GLTFLoader](https://threejs.org/docs/pages/GLTFLoader.html), and [texture color management](https://threejs.org/manual/en/color-management.html).

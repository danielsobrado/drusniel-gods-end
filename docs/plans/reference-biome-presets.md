# Reference biome treatment for Highfield and Galewind

Repository baseline: `7872bac` (understory improvements). Status: runtime isolation, field, grass/terrain response, clustered props, collisions, preset transaction, palettes, tests and benchmark harness are in place. Plant GLBs/atlases are **not** created in this pass. `biomes.referenceScrub.enabled` stays `false` until assets exist and the 10% GPU/processing gate is measured on device.

Saved specification with the user's subsequent authorization to create the plant assets directly in Blender. Asset creation replaces the external scan/import dependency; rendering, collision, isolation, and acceptance requirements remain unchanged.

## 1. Agreed outcome

Only `sunny` (Highfield) and `windy` (Galewind) receive the reference treatment. Highfield is warm daylight with olive/straw grass masses, leafy shrubs, prickly-pear cactus, and exposed rocks. Galewind uses the same biome placement with darker cloudy lighting and stronger directional bending. Preserve `goldenHour`, `rainy`, `calm`, `bowed`, and `moonlight`; `goldenHour` remains the startup preset.

Include solid cactus/rock obstacles, terrain integration, safe preset switching, bounded instancing and LOD. Original Blender-created assets are authorized; any newly downloaded material must be CC0 or MIT. Screenshots establish art direction, not the reference game's renderer or measured performance.

Delivery gate: processing and valid GPU frame-time median/p95 must remain within 10% of each original preset on the same device, backend, resolution, quality and route. Leave the feature disabled when this gate is unverified or fails. Do not claim completion from unchanged FPS alone.

## 2. Existing implementation and integration points

- `src/grass/ProceduralVegetationField.js:161` already provides density, growth, moisture, understory and paths. Extend its use; do not replace it.
- `src/grass/GrassFieldLayout.js:1` defines high/medium/low/veryLow geometry LODs. There is no zelda-field preset and no Near/Mid/Far/Terrain grass architecture in this checkout.
- Grass uses Mesh plus InstancedBufferGeometry; understory separately supports mesh/billboard replacement.
- High blade thresholds are 42/70/126/140 units, with 12544/5625/2500/625 candidate instances per 25-unit tile before compaction. Preserve these initially.
- `src/grass/grassShapes.js:26` documents a historical widening experiment costing 44% frame time without changing triangles. Bound covered pixels, not only triangle count.
- `src/config/loadConfig.js:4` is the configuration merge order. Merged sunny blade height is 2.5, despite older documentation quoting 1.5.
- Ten understory variants, shared wind, grass/ground palette sharing and the 2 ms vegetation scheduler already exist.
- During planning, 35 relevant existing tests passed; no proposed-feature GPU validation had yet run.

## 3. Isolation and interfaces

Add `public/reference-biome.yaml` last in CONFIG_FILES. Put shared settings under `biomes.referenceScrub` (seed 28411). Only sunny/windy have `biomeProfile: referenceScrub` and `referenceLook` overrides. Keep their original base values in existing configuration files.

Add pure `resolvePresetConfig(config, presetName)`: clone the original preset, merge referenceLook only when the referenced biome is enabled, resolve style against cinematic.style, and never mutate input. Disabling the biome must restore original settings. Use the same resolver in environment and foliage consumers.

Create per-config appearance uniforms using the MeadowPalette WeakMap pattern. Preserve original values for unselected presets. Existing shader constants occur in RecoveredGrassMaterial, MeadowPalette, AdventurePalette, and GroundMaterial. Never mutate cinematic.style during a switch. Cache legacy and reference material graphs; only the reference grass graph samples the new field. Reuse reference materials between sunny/windy; color and wind changes must not recompile. Preserve both render families and user-selected grass shape.

Add BiomePropSystem with prepare(profile, focus, {signal}), commit(preparedState), setQuality(quality), update(delta, camera, playerPosition), and dispose(). Reuse vegetation scheduling and LOD helpers, not one mesh per plant/cell. EnvironmentController.setPreset stays the synchronous final cut; asynchronous preparation belongs in GrassDemo's preset action (`src/app/GrassDemo.js:383`).

## 4. Field, grass and terrain

ReferenceBiomeField derives a shared 1024x1024 RGBA8 texture from existing ecology. R=dryness, G=vigor, B=mass, A=soft ground exposure around solid props. Seeded CPU noise computes:

```
dryness = clamp(0.65 * (1 - moisture) + 0.35 * noise32m)
vigor = clamp(growth * (1 - 0.25 * dryness))
mass = clamp(0.75 * noise8m + 0.25 * noise24m)
```

Build once per terrain/layout revision and share between weather presets. Existing paths, water, alpine and coast exclusions remain authoritative. Do not repurpose existing vegetation texture channels. Match CPU bilinear interpolation to GPU texel centers. The 2400x1600 landscape produces approximately 2.35x1.56-unit texels; exact prop footprints need spatial tests, not this coarse texture. Budget 4 MiB GPU plus 4 MiB CPU bytes and one upload.

Use three smoothly blended grass responses, sampled at stationary roots:

| Region | Mass | Height | Width | Retention |
|---|---|---:|---:|---:|
| Short | below .38 | .60 | .85 | .70 |
| Broad | .38-.68 | 1.00 | 1.15 | 1.00 |
| Tall | above .68 | 1.30 | .65 | .85 |

Blend across .08-wide threshold intervals. Apply shape response before interaction, preserve terrain placement and cinematic wind. Retention uses stable world hashes after existing eligibility, with no added source instances. Preserve instanceData.y LOD ranks. GrassTile compaction caches must include layout revision. Stage affected compaction rather than showing mixed layouts.

Blend static random bend direction toward preset wind by .45 in sunny and .85 in windy. Keep shared gust noise. Expand culling bounds for maximum archetype height plus horizontal bend.

| Grass parameter | sunny | windy |
|---|---:|---:|
| bladeHeight | 1.30 | 1.20 |
| bladeWidth | .22 | .22 |
| bladeStiffness | .90 | .65 |
| baseBend | .12 | .28 |
| windIntensity | 1.70 | 2.80 |
| windDirection | 35 | 75 |
| windNoiseScale | .30 | .30 |
| simulationSpeed | .90 | 1.05 |
| sheen | .08 | .10 |
| billboard height | .90 | .85 |
| billboard width | 1.35 | 1.35 |

Wind parameters apply to both families. Shared colors: green root #4a5426, green tip #a7ac55, dry root #6e6530, dry tip #c1b253. Root brightness .72, gradient power 1.90, fill .04, backlight .50, ground tip mix .18. Weather changes illumination, not dryness locations.

Grass and terrain use the same pigment/field. Keep turf normals, derivative filtering, path/river/shore/cliff/snow logic. Add soft soil exposure around props. Terrain carries vegetation color beyond existing grass range; no new distant grass cards or 280-unit grass range.

## 5. Blender assets and composition

User revision: create original prickly-pear and two irregular leafy shrub assets directly in Blender instead of requiring external downloads. Use `G:\Blender Foundation\Blender 4.5\blender.exe` in a separate `--background --factory-startup --python` process; preserve the open unsaved scene. Commit a repeatable script, source blend, runtime GLBs, atlas outputs and provenance manifest. Do not use ImageGen for these geometry-native assets.

Create a cactus from flattened oval pads joined into an asymmetric branching silhouette, with thick lower woody pads, smaller upper pads, olive colors, subtle areoles in the baked texture and no individual spine meshes. Normalize to one unit height, base pivot; instance heights .9/1.4/1.9. Build small/large shrubs from curved lanceolate leaves around branching stems, with open irregular silhouettes, darker interiors and olive highlights. Bake generated source materials into exportable maps. Reuse two numerically sorted existing rock templates after pebble classification (`src/world/rockPack.js:58`). Keep existing trees/positions/colliders and match detailed/billboard canopy color.

| Asset | Near maximum triangles | Mid maximum triangles | Far |
|---|---:|---:|---|
| Cactus | 2400 | 600 | 8-view atlas |
| Small shrub | 190 | 96 | 8-view atlas |
| Large shrub | 276 | 140 | 8-view atlas |
| Each rock | 900 | 200 | mid mesh |

Cactus texture limit: shared 1024-square color and normal maps. Shrubs: one shared 1024-square leaf atlas. Far atlas: 8 horizontal views of 128x128, unlit albedo, with aligned framing, base pivot and declared width/height. Validate all eight views. No runtime 4K textures. Leaf masks use cutoff .35, depth writing, transparent=false, mipmaps and supported alpha-to-coverage. Preserve coverage in mips. Do not run new atlases through existing understory prepareAtlas, which disables mipmaps and chooses nearest filtering. Record internally generated provenance, author/tool, script checksum, license/rights record and file paths; never invent third-party attribution.

Placement: deterministic 32-unit grid, one jittered cluster center per cell retained at probability .55. Reject paths, water, alpine exclusion, slope > .55, existing trunks/rocks/structures and accepted solid footprints. Members lie within four units, each independently height/exclusion checked. Dryness >= .60 and understory < .35: two cactus + small shrub. Understory >= .35: three mixed shrubs. Other eligible centers: two shrubs and one rock when secondary hash < .25. Keep solid footprint radius plus one unit from paths, sampling the footprint for exclusions. Layout/solid IDs are camera-, quality- and weather-independent. Only decorative shrub density changes with quality.

Existing wild grass/understory use the shared mass and prop exclusions. Add optional total caps after deterministic generation, sorted by distance and stable ID; current count is per-variant capacity, not a global cap.

| Quality | Wild-grass cap | Understory cap |
|---|---:|---:|
| performance | 96 | 64 |
| balanced | 160 | 96 |
| high | 240 | 128 |
| ultra | 320 | 160 |

Selected wild grass/understory do not cast shadows; preserve other presets' quality-controlled behavior. Apply shared tint to both imported meshes and billboards while preserving texture detail.

## 6. Rendering, weather and collisions

Instance pools are per asset and LOD: cactus + two shrubs x3 representations =9 main batches, two rocks x2=4, total <=13. Count shadow passes separately. High/Ultra near-to-mid 18-24, mid-to-billboard 55-65; Balanced/Performance 12-18 and 40-50. Visibility 160 across qualities so obstacle rendering exceeds collision range. Rocks retain mid geometry. Complementary dither transitions preserve tint, transforms and wind phase. Only near cactus/rocks cast new shadows, <=3 shadow batches. Exclude new props from water reflections. Repartition at .1 seconds during ordinary movement, forcing refresh on teleport/cell/preset changes; conservative deformed bounds.

Reuse foliageWind detailed-near/simple-far blending at 20-32 units. Shrub bend/flutter sunny .08/.015, windy .14/.025. Cactus .015/0. Rocks static. No CPU wind matrices.

| Setting | sunny | windy |
|---|---|---|
| sun color/intensity | #fff1ce /3.10 | #c4b687 /1.15 |
| sun/sky position | [-30,50,35] | [-35,18,40] |
| hemisphere sky | #b7c7c6 | #788177 |
| hemisphere ground | #595638 | #454735 |
| hemisphere intensity | .60 | .40 |
| ambient color/intensity | #d5d1ad /.18 | #969982 /.12 |
| environment intensity | .35 | .20 |
| fog color/density | #b4c3b8 /.0017 | #777963 /.0025 |
| cloud threshold | .60 | .18 |
| rain | false | false |

Windy horizon #a5a17d, zenith #41473d, ground #474734. Sunny retains current sky colors initially. Lower cloud threshold means more clouds. Selected canopy shadow #293a22, light #929a4a, tint .75, fill .16. Update TreeLeafMaterial and TreeSystem billboard shading together. Retain current post passes, shadow maps and atmospheric model.

Extend WorldCollisionSystem with addPreparedConvex(shape, transform, {group,id}), setGroupEnabled(group, enabled), removeGroup(group); preserve existing APIs. Cached cactus main-mass convex hull and rock hulls <=32 vertices; no leaf/shrub collision. Active requires group enabled AND proximity. Use existing 50/70 activation hysteresis and a larger body retention ring. Stream around player, not tour camera.

Preset transaction: resolve/load assets before closing iris; stage field, instance buffers and affected compaction with shared 2 ms scheduler. Close iris, freeze movement, validate destination against player capsule, find safe pose if needed, atomically commit graphics/exclusions/colliders/environment/audio, restore movement, reopen. Current IrisTransition awaits async callbacks. Test current XZ then radius 1..12 rings, 16 angles each in fixed order; reject invalid terrain/slope/water/destination obstacles. Root height uses rootToFeet+groundOffset. Preserve yaw/orientation, translate camera with player, reset vertical velocity. If no safe pose retain old preset. Leaving while standing on a new rock follows same rule; sunny/windy share layout and normally do not relocate. Generation IDs discard stale preparation, failed jobs never publish partial state. Cover direct startup, reduced motion, rapid switching, disposal, recovery.

## 7. Performance gates

New main batches <=13; extra shadow batches <=3; additional prop triangles <=120000 per main pass; new GPU asset/field allocation <=32 MiB excluding driver shader caches; runtime assets <=16 MiB. Target p95 <=.25 ms extra prop visibility/LOD/collision bookkeeping. Reuse one total 2 ms scheduler. Cooperative jobs need bounded sort/copy/collider batches; profile publication separately.

Extend scripts/debug/scene-benchmark.js and FrameProfiler. Record commit/preset/quality/backend/browser/GPU/viewport/pixel ratio, processing/interval/GPU median/p95/p99, draws/triangles/collider counts/LOD populations, generation/compaction/publication/collision timings, shader creation, allocations, first/warm switch time.

Each selected preset/quality: alternate disabled baseline and enabled feature, 5-second warmup +30-second capture, three repetitions, stationary and moving. Use opening meadow, forest, river, lake, coast plus close shrubs/cactus, low grass angle, both LOD boundaries and running across cells. WebGPU and supported WebGL, fixed resolution. Add gameplay-camera visual capture separately from existing six-unit-high benchmark camera.

Gate each scenario's processing median/p95 and valid GPU median/p95 at <=1.10 baseline. Do not average away failures. Missing GPU timestamps are a limitation, not zero GPU cost.

If over budget, in order: decorative shrubs 80% then 60%; wild/understory caps 80%; prop near transition inward six units; broad width 1.15->1.10; selected grass retention reduced 5%. Retest each failing case. Do not reduce resolution, alter other presets or relax the gate. If still failing/unverified leave enabled=false and report blocker.

## 8. Validation and delivery

Tests: two-preset-only resolution and restoration; no config mutation/state leakage; field texel/CPU parity and boundaries; deterministic clumps/IDs across traversal/quality/weather; caps across variants; exclusions; original grass LOD ranks; revision cache invalidation; complementary transitions; collision group policy; safe activation/removal; stale-job cancellation; asset errors/rapid switch/reduced motion/disposal/recovery; asset triangle/texture/material/provenance limits. Compile both shader variants on WebGPU and WebGL, check billboard color and alpha parity.

Run `rtk npm test`, `rtk npm run lint`, `rtk npm run build`; inspect generated-file changes. Capture identical before/after gameplay views. Sunny must show readable olive/straw masses, openings, cactus pads, embedded rocks, matched distant terrain. Windy shares positions with stronger directional bend and darker readable lighting, restrained transmission, no rain. No tile-grid patterns, sliding plants, LOD flash/double silhouettes, invisible colliders, path/water intrusion or mixed state after iris opening. Compare all five untouched presets' config/images/population/collisions/frame cost.

Order: save spec; capture baseline; isolated resolution/materials; Blender assets; field/grass/terrain; clustered props/LOD; colliders/transaction; weather palettes; regression/visual/recovery/performance validation; enable only after acceptance. Deliver manifest/preparation script/source and optimized assets, images, benchmark results and honest remaining limitations.

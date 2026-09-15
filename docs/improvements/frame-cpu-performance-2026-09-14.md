# Frame-loop CPU performance pass (14 September 2026)

Comparison baseline: the working tree at `12f1d5e`. Goal: reduce per-frame cost with no visual change. Density, draw distance, LOD thresholds, shadow and reflection resolution, post-processing quality and blade counts are untouched.

## Where the time went

A headless Playwright capture (`scripts/browser/run-movement-benchmark.mjs`, Chrome WebGPU, RTX 4080, 1280 × 720, pixel ratio 1) and a V8 CPU profile of the dense-forest run showed that project code was only about 3% of CPU self time. The rest was three.js itself:

| Function | Share of self time |
|---|---:|
| `Object3D.updateMatrixWorld` | 16.5% |
| `Matrix4.multiplyMatrices` | 9.1% |
| `_renderObjectDirect` (per-draw dispatch) | 10.4% |
| `writeBuffer` (uniform uploads) | 5.8% |
| `_projectObject` (render-list traversal) | 5.4% |

A scene census at the forest pose explained the first two rows: 6,741 `Object3D`s, all with `matrixAutoUpdate` on, of which 5,846 (87%) never change their world matrix even while the camera moves. Every render pass (beauty, depth/normals, planar reflections, cube captures) recomposed and re-multiplied all of them.

## Changes

### Object3D matrix update cache (`src/core/matrixUpdateCache.js`)

Installed from `main.js`. `Object3D.prototype.updateMatrix` remembers the last composed position, quaternion and scale and returns early when none of the ten components changed, so the local matrix is not recomposed and the world matrix is not flagged dirty. Because the dirty flag is skipped, `updateMatrixWorld` is also patched: every world-matrix recompute bumps a per-object version, and a child re-derives whenever its own transform changed, it was forced by an ancestor, it was re-parented, its parent's version moved, or the parent manages its world matrix by hand. `updateWorldMatrix()` (used by `getWorldPosition`) bumps the version only when the matrix actually changed, so per-frame world-position reads on the player and camera do not force the graph. `add`/`remove`/`clear` bump a scene-graph version that other caches key on. Objects with a `pivot` bypass the compose cache. `test/matrixUpdateCache.test.js` checks static objects compose once, moved parents update children, re-parenting refreshes the world matrix, a 200-frame random walk over a 60-node tree stays bit-identical to explicit composition, and the regression found in review: a parented GLTF subtree whose intermediate node has an identity transform (the character Armature) must re-derive its world matrix.

Kill switch: `?matrixCache=0` restores stock three.js behaviour.

### Reflection mask cache (`src/water/reflectionMask.js`)

Planar and cube captures hid `excludeFromReflection` objects and paused shadow updates by traversing the whole scene per capture, twice per frame at Ultra. The traverse result is now cached per scene against the scene-graph version. Every `excludeFromReflection` flag in the codebase is set before the object is added to the scene, which the cache relies on. `test/reflectionMask.test.js` covers hiding/restoring, cache invalidation on add/remove/clear, and exception safety. Kill switch: `?reflectionMaskCache=0`.

### Grass tiles (`GrassField.js`, `GrassTile.js`, `GrassFieldLayout.js`)

- Tile emptiness (outside the terrain, or in the empty-tile set) is cached on `tile.isEmpty` when tiles reposition or the set is remapped, instead of building a string key per tile per frame. The `isEmpty` field existed but had never been wired up.
- Tile meshes use `matrixAutoUpdate = false` and recompose their matrix only in `setPosition()`; the per-frame `updateMatrixWorld()` call per tile is gone.
- The occlusion/frustum box is built by offsetting the shared template bounds by the tile position, which is bit-identical to `Box3.applyMatrix4` for a translation.
- LOD thresholds are squared once per update; the per-frame stats object literal is gone.

### Interaction map (`src/grass/InteractionMap.js`)

Recovery decayed all 65,536 texels every frame while any ink existed, and scrolling cleared and copied the whole texture. Both now operate on a tracked ink rectangle that contains every non-zero texel. Outside it every red byte is 0, and both `floor(0 × r)` and a translated 0 stay 0, so the result is byte-exact; the existing differential test against a full-work reference still passes. The full-work scroll is kept as the test seam.

### Coastal jungle culling (`src/biome/CoastalJungleCulling.js`)

Visibility limit and keep fraction were resolved per record; they now resolve once per kind per update. A conservative squared-distance early-out precedes the exact `sqrt` comparison, which is unchanged.

### Smaller per-frame savings

- `WorldCollisionSystem.update()` only calls Rapier `setEnabled` when a collider's enabled state changes (previously every collider, every frame) and maintains an active count for the profiler instead of a per-frame `filter()`.
- `LeafSystem` marks its instance buffer for upload only when at least one leaf was active.
- `UnderstorySystem`/`WildGrassSystem` cache their resolved settings per preset/quality pair instead of re-merging defaults, quality and preset every frame.
- `WaterSurface` computes the signed coast distance directly (`coastDistanceAt`) instead of evaluating the full swash/moisture field for one scalar, and only gathers sea-tile stats when the profiler is on.
- `PlayerController` caches the camera target offset in `handleResize()` instead of reading `window.innerWidth` twice per frame.
- `CharacterMotion` drops a full-rig `updateWorldMatrix(true, true)`; the bone reads that follow already refresh their ancestor chains.

## Bugs fixed on the way

- Snow deformation and snow powder were stepped twice per frame: once by `WorldNavigation.update()` and again in `GrassDemo.#renderFrame()`. Particle integration, ambient emission and the recovery timer all ran at double rate. The `#renderFrame` copy is removed; the navigation version (which handles tour/free-fly focus and grounded contact) is the one that stays. Snow now behaves at its configured rates.
- `GrassDemo.#detectSurface()` sampled water containment and five ecology channels every frame to produce a surface label nothing consumed. Removed.
- `scripts/browser/run-movement-benchmark.mjs` crashed after the first scenario on Windows because `URL.pathname` yields `/F:/...`; screenshots now use `fileURLToPath`.
- `GrassTile.isEmpty` was declared with a comment claiming `remapEmptyTiles()` set it, but nothing ever did.

## Evaluated and not done

- Sharing the grass vertex shader's `modelWorldMatrix * instancePosition` between its three uses: the expression is identical and in the same stage, so the shader compiler already merges it; the TSL change would add compile risk for no measurable gain.
- Batching the 1,600 tree meshes into `BatchedMesh`/`InstancedMesh` per material would halve draw calls (854 at the forest pose) and is the next large CPU win, but it touches per-tree tint, fade, shadows and LOD and is a separate piece of work.

## Measurement

Same harness as the baseline. GPU power state on this machine changes per page load and scales every timing by about 1.9× uniformly (identical draw calls, triangles, target sizes and capture counts), so sessions are compared only when both were in the fast state (run-0 bloom mark ≈ 0.3 ms). Reports: `.cache/movement-performance/baseline.json`, `optimized-high-healthy.json` (all changes on), `caches-off-high-healthy.json` (`?matrixCache=0&reflectionMaskCache=0`, small changes still on).

Quality High, processing median in ms (lower is better):

| Scenario | Speed | Baseline | Caches off | All on | All on vs baseline |
|---|---:|---:|---:|---:|---:|
| Dense forest | 9 | 11.8 | 11.0 | 9.8 | −17% |
| Dense forest | 180 | 10.8 | 10.1 | 8.3 | −23% |
| Meadow | 9 | 7.8 | 7.4 | 5.9 | −24% |
| Meadow | 180 | 9.3 | 8.2 | 7.0 | −25% |
| River | 9 | 7.5 | 6.9 | 5.8 | −23% |
| River | 180 | 8.7 | 8.0 | 6.4 | −26% |
| Jungle coast | 9 | 7.5 | 7.0 | 5.6 | −25% |
| Jungle coast | 180 | 9.8 | 8.7 | 7.7 | −21% |
| Snow | 9 | 5.7 | 4.9 | 3.8 | −33% |
| Snow | 180 | 5.9 | 5.1 | 4.0 | −32% |
| **Mean** | | **8.48** | **7.73** | **6.43** | **−24%** |

P95 processing fell in every run (for example forest/9 14.5 → 11.9 ms, snow/180 9.1 → 6.6 ms), and the rAF interval median fell wherever it was not vsync-bound. GPU render-query medians fell 10–25% in grass-heavy views, consistent with fewer per-object uniform writes. Draw calls, triangles, tile counts and grass memory are identical to the baseline at every run index. No console or page errors in any session.

In the forest CPU profile, `multiplyMatrices` self time fell 77% and `updateMatrixWorld` 18%, with GC time halved. Per-draw dispatch (`_renderObjectDirect`, `writeBuffer`) is now the dominant remaining CPU cost.

Ultra was not re-captured in a fast-state session before the run was stopped; the removed work is CPU-side and quality-independent, and the earlier (power-state-confounded) Ultra sessions showed the same profile shifts.

## Verification

`node --test` (412 tests, including the three new suites), `eslint .` clean, `npm run check:docs` unchanged.

# Performance

This document describes the performance strategy exactly as implemented on current `main`.

It is not a target design. The 15% frame-time reduction mentioned in planning is a measurement target, not an established result. Capture before/after numbers with the opt-in profiler before claiming a win.

## Primary performance controls

The current runtime exposes or uses these main controls:

- renderer pixel ratio,
- grass quality profile (default **Ultra**),
- grass type / shape,
- grass distance-based LOD and tile culling,
- cinematic distance fade of individual stems,
- tree high/low LOD and distance culling,
- instanced falling leaves,
- local player-centered rain,
- cached terrain height sampling and an optional cached terrain-normal texture,
- shader warm-up before the first frame,
- vegetation rebuild jobs with a shared 2 ms CPU budget,
- GPU occlusion with open-view probe cooldown.

Antialiasing, post effects and reflection-refresh budgets stay on their existing quality tables. Ultra does not lower grass density or draw distance.

## Opt-in profiling

Development builds accept `?profile=1`. That is the only new user-accessible interface.

With profiling enabled, `GrassDemo` records per-frame **processing time** (work inside `#renderFrame`) separately from **rAF interval** (which includes vsync wait). JSON is exposed on the existing development object:

```text
window.__grassDemo.getProfileResults()
window.__grassDemo.lastBenchmark
window.__grassDemo.lastTopologyComparison
```

The recorded payload includes:

```text
actual backend
viewport size and drawing-buffer size
pixel ratio
median / P95 / P99 processing and interval
CPU subsystem times (grass, meadow, wild grass, understory, vegetation jobs, water, render, and when profiling: scene, depthResolve, gtao, bloom, composite, gpuProgram, gpuPipeline, cubeReflections, planarReflections)
draw calls and triangles
reflection capture counts
grass tile compaction milliseconds
occlusion prepare time and GPU render-query time when timestamp queries resolve (null if unavailable)
```

Nested cinematic CPU marks are **inclusive**. `render` contains scene traversal, draw submission, nested reflections, post, and any shader/pipeline creation that ran inside that call. `scene` contains planar captures and creation that ran during the beauty pass. `gpuProgram` / `gpuPipeline` are also nested inside `render` (often inside `scene`). Do not subtract nested marks from their parents to reconstruct processing time. `composite` is the exclusive leftover of that one draw callback after the inclusive nested `updateBefore` times.

Cold-hitch inspection uses `hitch.creation`: program and pipeline **duration plus creation counts**. Creation occurring during the stall does not by itself explain a multi-second hitch; `outsideCreationMs` is the inclusive `render` time not spent in those wrappers and still needs investigation. Keep hitch samples separate from settled medians.

A full protocol lives at `/scripts/debug/scene-benchmark.html`. It measures opening meadow, dense forest, river, lake and coast, each stationary and moving across vegetation cells, with three repetitions, five seconds of warm-up and 30 seconds of measurement. A Topology A/B button records the dense-forest first-arrival hitch with warm-up disabled, waits for the scene to settle, then repeats that full protocol as **shared / duplicated / shared** so run order is not a one-way heat bias. A Quick button exists only for development iteration.

Warm-up drops the first-arrival hitch, so medians describe settled frames only. Record `hitch.maxProcessingMs` / `framesOver100ms` from the zero-warm-up forest capture separately; do not fold that stutter into the topology comparison.

Those captures use a free camera: the avatar is hidden and restored, the player capsule is placed at character-root height (`ground + rootToFeet + groundOffset`) under the lens, and the camera sits at eye height looking at the scenario target. `PlayerController.setEnabled(false)` alone leaves the character mesh in the scene, so colocating the camera with the player puts the lens inside the body and invalidates relocated timings. Passing terrain height into `setPosition()` would bury the feet and interaction points.

Forced WebGL 2 uses `?renderer=webgl` together with `?profile=1`.

With `?profile=1`, the renderer is constructed with `trackTimestamp: true`. GPU durations come from `resolveTimestampsAsync('render')` on a later frame. That query is GPU **render-query** time (`resolveTimestampsAsync('render')`), not total GPU cost including compute. Unsupported backends and unresolved queries are stored as `null`, never as a zero-duration sample. Draw counts use `info.render.drawCalls` (per frame), not cumulative `calls`. A first-view hitch that overruns the warm-up/measure window still records that frame so the run can finish. Hitch samples keep `hitch.creation` (program/pipeline duration and counts, plus time outside those wrappers) and `hitch.firstMarks`. Nested marks stay inclusive.

## Renderer pixel ratio

`getRendererPixelRatio()` uses:

```text
mobile viewport -> mobilePixelRatio
otherwise       -> min(devicePixelRatio, pixelRatioCap)
```

Current values:

```yaml
renderer:
  pixelRatioCap: 2
  mobileBreakpoint: 768
  mobilePixelRatio: 1
```

The UI also allows a runtime pixel-ratio override clamped to `0.5 .. pixelRatioCap`.

## Grass quality profiles

Current profiles are:

| Profile | Fog multiplier | Shadow map | Blade max distance | Billboard max distance |
|---|---:|---:|---:|---:|
| Performance | 1.5 | 1024 | 80 | 120 |
| Balanced | 1.25 | 2048 | 100 | 140 |
| High | 1.0 | 4096 | 140 | 160 |
| Ultra | 0.9 | 4096 | 220 | 220 |

Ultra is the default (`ui.initialQuality`). Changing quality rebuilds grass geometry and the tile pool, updates directional-light shadow-map size, and cancels in-flight vegetation rebuilds.

## Grass GPU work

Blade templates store `2S + 1` vertices for `S` segments and `2S - 1` triangles. High detail is 11 vertices / 9 triangles; the previous unshared strip stored 19 vertices with the same nine triangles. `test/grassGeometry.test.js` checks that slender, reed and broadleaf keep that silhouette.

Styled cinematic grass builds one specialized position node:

- terrain height and visibility are sampled once and shared by planting, wind and distance LOD,
- stems that are frustum-hidden, zero-coverage, or fully masked skip further deformation,
- the cinematic wind model omits recovered wind (which previously still ran at intensity 0),
- recovered per-blade height hashes are omitted because cinematic height patches overwrite them,
- static bend, interaction and cinematic motion remain.

That sharing is per vertex shader invocation, not yet per stem. Terrain, visibility and wind still recompute on every vertex of a blade. Vertex welding is the first cost experiment; stem-invariant caches and mid/far density changes come after it.

Short diagnostic samples on an RTX 4080 at Ultra, 3440 × 1440, opening view, measured median CPU processing around 21 ms with about 19 ms in the `render` section. GPU timestamps from `resolveTimestampsAsync('render')` were about 8 ms with grass enabled and about 3 ms with grass hidden; that is GPU render-query time, not an isolated grass shader timer and not total GPU cost including compute. Hiding grass also changes later passes, so the difference is marginal scene cost. The CPU `render` mark is the whole cinematic `pipeline.render()` call: scene traversal, material updates, draw submission, nested reflection captures, then depth resolve / GTAO / bloom / composite. It does not yet implicate individual effects. Coverage samples and density stay unchanged until that breakdown names the expensive work.

When a terrain-normal texture is available, slope lighting samples that texture instead of four height taps per vertex. The four-tap height difference remains the fallback and is used to generate the cached map, so coordinate mapping matches the grass height texture.

Verify specialization with `/scripts/gpu/grass-shader-check.html` (WebGPU or `?renderer=webgl`). Unit tests inspect construction flags and the TSL graph for the recovered height-hash constant `24634.6345`.

`/scripts/gpu/blade-topology-check.html` renders shared and duplicated blade templates with the cinematic grass material at matched times. It reports per-pixel differences and optional GPU timestamps. That check does not change density. Matched-time captures of the tested shapes were pixel-identical, which is why production keeps the shared templates.

On 10 September 2026 a same-session Topology A/B ran on an RTX 4080 at Ultra, WebGPU, 3440 × 1440, pixel ratio 1: forest hitch with warm-up disabled, five seconds of settle, then 5 s + 30 s × 3 for shared templates and again for the duplicated strip. Cameras, settings and animation sequences matched. Density was unchanged. High-detail templates were 11 vertices versus 19; triangle counts matched.

Keep the forest hitch separate from those settled medians. Nested marks on the stall frame stay inclusive: do not subtract `scene` or planar time from `render`. Inspect creation **durations and counts together**.

An instrumented cold capture (fresh load, Ultra default, no quality switch) recorded 4104.5 ms processing, inclusive `render` 4044.1 ms, inclusive `scene` 4043.5 ms. `gpuProgram` was 0 ms / 0 creations and `gpuPipeline` was 0 ms / 0 creations, so `outsideCreationMs` is the whole inclusive render (4044.1 ms). Inclusive `planarReflections` was 1166.6 ms inside `scene`, not extra. Grass peaked at 57.3 ms, compaction at 53.7 ms, GPU render-query max 23.6 ms. Program or pipeline creation did not run in those wrappers on the stall frame, so it cannot explain the 4.10 s. Time outside those marks still needs investigation. Neither this instrumentation nor the earlier 4275 ms sample (CPU `render` 4214 ms, no creation split) establishes the cause.

A later hitch of 15.86 s after `setQuality('ultra')` on an already-Ultra session is contaminated; do not use it as the cold result. That stall also showed 0/0 creation. Hitch samples stay out of settled medians.

First settled comparison (shared then duplicated only; run-order heat possible). Median of three repetition medians, milliseconds:

| View | Mode | Shared CPU | Dup. CPU | Shared GPU | Dup. GPU |
|---|---|---:|---:|---:|---:|
| Opening meadow | Stationary | 10.3 | 10.6 | 6.23 | 6.49 |
| Opening meadow | Moving | 10.7 | 11.2 | 6.82 | 7.21 |
| Dense forest | Stationary | 12.7 | 12.9 | 7.08 | 7.47 |
| Dense forest | Moving | 13.6 | 14.0 | 6.68 | 7.21 |
| River | Stationary | 9.9 | 10.6 | 5.51 | 5.70 |
| River | Moving | 10.2 | 10.6 | 4.78 | 4.92 |
| Lake | Stationary | 8.3 | 9.1 | 2.62 | 2.62 |
| Lake | Moving | 8.6 | 9.3 | 2.49 | 2.49 |
| Coast | Stationary | 7.4 | 8.3 | 3.67 | 3.74 |
| Coast | Moving | 7.6 | 8.6 | 4.13 | 4.19 |

Grass-heavy GPU savings on that first comparison were about 0.3–0.5 ms (4–7%) with non-overlapping three-rep ranges. CPU processing stayed above GPU render-query time in every view. The 11.8 ms forest `render` median is the whole cinematic render call, not post-processing alone. Independent medians are not a partition. Shared ran first and duplicated second, so those deltas may include session heat.

A later shared / duplicated / shared protocol on the same machine, viewport and quality compared the three legs to each other after the hitch capture. Nested marks stayed inclusive. That session’s hitch was the contaminated 15.86 s sample and is not mixed into these medians. Each 30 s window recorded about 30 frames (interval median ~1003 ms), so these GPU absolute values are not comparable to the ~6 ms table above.

Stationary median of three repetition medians, milliseconds:

| View | Shared CPU | Dup. CPU | Shared-repeat CPU | Shared GPU | Dup. GPU | Shared-repeat GPU |
|---|---:|---:|---:|---:|---:|---:|
| Opening meadow | 12.9 | 12.1 | 12.3 | 32.8 | 34.2 | 47.7 |
| Dense forest | 17.0 | 14.1 | 14.1 | 42.6 | 63.0 | 57.5 |
| River | 12.5 | 11.7 | 11.7 | 29.4 | 44.1 | 47.6 |
| Lake | 10.3 | 10.2 | 9.9 | 38.1 | 31.0 | 31.6 |
| Coast | 9.4 | 9.1 | 9.3 | 40.1 | 32.8 | 33.0 |

Shared-repeat CPU tracks duplicated in every view; the first shared leg is the high outlier. Shared-repeat GPU also tracks duplicated on lake, coast, river, and forest moving. Switching back to shared templates does not recover the first shared GPU numbers. That is session drift and sample noise, not a confirmed topology frame-time save. Sharing stays for the pixel-identical templates. It is not a 15% frame-time result. Effects, coverage samples and density stay unchanged. Hitch cause remains unestablished; the remaining stall time is inclusive `scene` work outside the creation wrappers (and, on the cold capture, about 2.88 s of that is also outside nested planar).

## Vegetation rebuilds

Meadow details, imported wild grass and imported understory no longer rebuild synchronously when the camera enters a new 12-unit cell.

They share one resumable job scheduler with a 2 ms CPU budget per frame:

```text
queue a replacement job
keep the currently visible instances
sample terrain/ecology from a padded origin-independent cache
write staging arrays
sort, build instance matrices and bounds as later budgeted steps
upload populated ranges once on completion
```

Quality changes, preset changes, relocation and disposal cancel the active job. Incomplete buffers and outdated settings are not published.

Seeded placement order and filters are unchanged. Distance-sorted wild-grass/understory assignment still happens at publish time.

## Grass tile compaction

Cinematic tiles still compact mask-hidden stems when a recycled tile first needs a LOD geometry. Compaction time is recorded on `grass.stats.compactionMs` / `compactionTiles` so remaining movement spikes can be attributed separately from vegetation jobs.

## GPU occlusion

`GpuOcclusion` still renders solid occluders to a depth target, builds a max-depth pyramid, and writes same-frame indirect arguments. Open views that save too few triangles enter a probe cooldown and draw normally.

Additional CPU savings:

- CPU staging buffers and GPU bind groups are reused until candidate capacity or the depth target changes,
- instance world bounds are cached until geometry, instance transforms or instance counts change,
- views with no usable candidates or occluders now enter the same probe cooldown (they previously returned every frame and re-collected).

Conservative visibility checks are unchanged. Assess occlusion with timings, not triangle counts alone: Three's `TRIS` counter does not subtract zero-instance indirect draws.

The private r180 indirect-draw bridge remains disabled on the pinned r185 build; ordinary rendering is used.

## Water and reflections

The expanded landscape uses one water mesh with lake and sea planar reflections plus an upstream cube probe. Capture cadence is gated by camera position and `ReflectionBudget`. Capture counts are on `water.stats`. See [Water performance](water-performance.md).

High is now the startup default and uses cached lake reflections plus the ocean sky approximation. Only Ultra renders live planar views. Imported understory replaces distant meshes with baked billboards and drops their shadow passes. Imported foliage also skips full wind noise beyond 32 units, blending to simple sway over 20–32 units. These approximations retain per-frame camera response and animation; they trade distant detail for less rendering work. See [LOD system](lod-system.md) and [Procedural vegetation](procedural-vegetation.md).

## Terrain sampling

Cinematic expansion rasterizes a 1536-square CPU height field. Grass and water normally use a 2048-square GPU height texture. Runtime height queries interpolate the CPU grid. Shader slope lighting may use the derived normal texture.

## Most expensive current knobs

In practical order, the settings with the largest likely impact are:

1. renderer pixel ratio,
2. grass max distance and Ultra tile pool size,
3. grass LOD density and blade detail,
4. directional shadow-map resolution and cinematic post (GTAO, bloom, coverage samples),
5. planar reflection resolution and refresh cadence,
6. tree count / cloned tree complexity,
7. rain fill when the volume is visible,
8. vegetation rebuilds and grass tile compaction while moving.

## Current architecture trade-offs

Strong performance choices already implemented:

```text
grass instancing and specialized cinematic shaders
camera-centered tile reuse
grass tile/frustum/mask culling and stem compaction
shared LOD geometries
cached terrain height and optional terrain normals
no grass shadow casting
resumable vegetation population with retained instances
instanced falling leaves
local rain volume
shader precompilation
mobile pixel-ratio reduction
occlusion probe cooldown
```

Current expensive/non-batched areas:

```text
tree hierarchy cloning
per-tree material cloning
animated bird hierarchy cloning
CPU-updated interaction texture
planar reflection scene captures
```

Loading-time optimization and broader tree-rendering rewrites are separate work.

## Measurement protocol

Compare each change independently against a baseline recorded with the same backend, viewport, pixel ratio and Ultra settings. Retain a change only when its benefit exceeds run-to-run variation. A repeatable regression above 5% in demanding views is a failure.

Use processing-time percentiles, not FPS alone: a 144 Hz display can hide a 4 ms CPU improvement behind vsync.

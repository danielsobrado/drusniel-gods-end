# Reflection and sea performance

The expanded water path separates geometry density from reflection refresh policy. Sea detail adds no new render pass. Lake/river geometry stays on the root water mesh; the ocean is 48 frustum-culled child meshes sharing one material, clock and capture resources.

## Reflection budget

High, Balanced and Performance use the cached upstream/lake cube capture and analytical/live-sky ocean reflection without live planar updates during movement. Ultra keeps live planar lake and sea reflections through `ReflectionBudget`.

`ReflectionBudget` invalidates on relevant camera or quality/weather changes. `water.stats` tracks cube, lake-planar and sea-planar capture counts. Profiling also records reflection wall time separately from the main render path.

The ocean changes do not increase the configured reflection cadence. Hiding the root water mesh for cube capture also hides its sea-tile children. Refraction remains owned by the water material and is disposed with it, preserving renderer-recovery isolation.

## Geometry budget

The quality-specific 48-tile lattice allocates approximately 59,976 / 119,394 / 225,024 / 318,912 sea vertices for Performance / Balanced / High / Ultra. Corresponding triangle counts are 113,256 / 229,308 / 436,968 / 622,224. These totals replace the previous single merged-sea accounting and must not be interpreted as main-view submissions.

Each tile has its own storm-expanded bounds and `frustumCulled = true`. `water.stats` reports both allocated totals and visible main-view tile/vertex/triangle counts. Reflection submissions are tracked separately and must not be added to those main-view counts as if they were visible geometry.

Fine normal detail is reduced first by distance and quality. Medium detail remains visible farther offshore. Mipmapped mean slope and second slope moment provide filtered variance so distant unresolved detail broadens explicit specular instead of turning into high-frequency shimmer.

## Regression protocol

Use the same backend, resolution, quality, preset and camera route for before/after comparisons. Record processing median/P95, valid GPU median/P95 when available, reflection wall time/capture counts, draw calls and triangles. The repository regression threshold is 10%; missing GPU timestamps are a limitation, not zero GPU cost.

`/scripts/gpu/sea-check.html` is a correctness harness, not a performance benchmark. CI runs it in Chromium WebGL 2 using SwiftShader and attempts WebGPU only when the browser exposes WebGPU. Integrated visual/performance review remains available through `/scripts/debug/sea-review.html` and the existing scene/reflection benchmark modules.

The historical reflection measurements previously recorded in this repository remain hardware-specific reference data; this coast/offshore delivery does not claim a new frame-time improvement without a matching hardware run. When no suitable hardware measurement is available, report that explicitly.

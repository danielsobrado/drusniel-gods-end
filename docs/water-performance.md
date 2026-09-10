# Reflection performance

The expanded map exposed excessive reflection rendering: lake/sea planar captures ran every frame and the stationary inland cubemap rendered six views every 0.75 seconds. Isolating the planar captures removed most of the steady frame cost; removing periodic cubemap captures reduced spikes. Disabling water geometry or bank rocks separately made little further difference in the measured river view.

High is the startup default. High, Balanced and Performance use the cached lake/upstream cubemap and an analytic ocean sky reflection, with no planar captures during movement. Reflection directions and water normals still update every frame, so turning does not wait for a new image. Nearby shoreline parallax and moving reflected objects are approximate. The fixed cubemap captures initially and on environment invalidation; the legacy lake-only path retains its existing cadence.

Ultra retains live planar reflections. `ReflectionBudget` refreshes on every camera world-transform or projection change, including slow motion, tiny turns, parent-rig movement, zoom and aspect changes. Stationary Ultra views refresh every 250 ms. The shader samples live textures in current screen coordinates, so throttling a moving view would reintroduce sliding and snapping. Quality and weather changes invalidate the budget. Cached qualities also branch around the unused planar texture samples.

Capture counts for cube, lake planar and sea planar refreshes live on `water.stats`. Opt-in `?profile=1` includes those counts in `getProfileResults()`.

A same-session WebGPU lake comparison at 1280 × 900 kept the rest of the scene on High and changed only water quality. Two cached runs averaged 15.8 and 13.9 ms/frame, versus 19.2 ms for live reflections. Each cached run made zero planar captures; Ultra made 90 in 90 measured moving frames. All three reused the existing cubemap. These whole-frame measurements depend on hardware, warm-up and scene conditions; they are not a universal FPS guarantee.

## Camera-motion regression

Open `/scripts/gpu/reflection-motion-check.html` (append `?renderer=webgl` for the fallback backend). It renders the production water material with frozen waves and static markers, then compares translated, rotated, slowly moving and zooming cameras against a freshly captured reference at each quality. Results are also available through `window.__reflectionMotionCheck`. Ultra must capture every moving frame; the other three qualities must produce the same cached-reflection image with zero planar captures. All 20 sequences pass on both backends. Node tests cover quality switching, idle cadence, parent transforms, projection changes and fixed-probe invalidation.

Before this correction, the GPU check captured only one or two of eight frames per sequence. At 128 × 128, it found 4,179 differing pixels during translation and 5,331 during rotation. A full-scene WebGPU lake check also measured reflection misalignment of up to 1.28 pixels and gaps of five frames during gentle motion. Refreshing each moving frame removed that misalignment. Moving views now perform more planar captures; the original moving-view savings below are historical and do not describe the corrected policy.

After the correction, all five GPU sequences matched the fresh reference exactly on both WebGPU and WebGL, with eight captures in eight frames. The full lake scene also captured all 90 measured moving frames with alignment error below `1e-10` pixels and no render errors.

## Original performance comparison

With the development scene loaded, run this in browser developer tools:

```js
await (await import('/scripts/debug/reflection-benchmark.js')).benchmarkReflections()
```

The debug harness temporarily places the camera in the river view, measures stationary and moving views with the fix, then restores the previous reflection frequency for comparison. It restores camera, player and capture methods in `finally`. Each measurement discards 20 warm-up frames and records 120 animation-frame intervals. Avoid other rendering tabs, resizing, scene settings changes or active tours during measurement. Results measure whole-frame cadence, not isolated GPU time; they are hardware/browser dependent.

A same-session comparison at 1440 × 900, Ultra, headless Chrome WebGL2 gave:

| Camera | Reflection behavior | Mean frame time | Median | P95 |
| --- | --- | ---: | ---: | ---: |
| Moving | Previous | 35.0 ms | 34.7 ms | 76.3 ms |
| Moving | Budgeted | 26.2 ms | 21.0 ms | 34.8 ms |
| Stationary | Previous | 32.4 ms | 27.8 ms | 34.8 ms |
| Stationary | Budgeted | 22.8 ms | 20.9 ms | 27.9 ms |

This is a roughly 25% reduction in average moving-view frame time, not a universal FPS guarantee. Automated tests exercise moving/idle capture cadence and the actual `WaterSurface.update` fixed-probe path, including invalidation. Future water changes should run this visual benchmark as well as geometry tests: compilation and geometry correctness alone do not detect excess scene captures.

A repeat using the saved harness measured 33.2 → 24.2 ms mean frame time while moving (27% lower). Its P95 was approximately 35 ms in both modes; the larger periodic spikes in the first run were not present in every sample. Average frame-time reduction was repeatable.

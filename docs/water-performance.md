# Reflection performance

The expanded map exposed excessive reflection rendering: lake/sea planar captures ran every frame and the stationary inland cubemap rendered six views every 0.75 seconds. Isolating the planar captures removed most of the steady frame cost; removing periodic cubemap captures reduced spikes. Disabling water geometry or bank rocks separately made little further difference in the measured river view.

`ReflectionBudget` refreshes planar reflections on every camera world-transform or projection change for Ultra, High and Balanced. The water shader samples these textures in current screen coordinates, so throttling a moving view leaves reflections attached to an old view until they jump on refresh. Exact matrix comparisons also catch slow motion, tiny turns, parent-rig movement, zoom and aspect changes. Stationary views refresh every 250 ms so reflected foliage can still animate. Performance skips planar captures. Quality and weather changes invalidate the budget. The enhanced fixed cubemap captures initially and on environment invalidation; the legacy lake path retains its existing cadence. Existing reflection resolution scales and scene exclusions still apply.

Capture counts for cube, lake planar and sea planar refreshes live on `water.stats`. Opt-in `?profile=1` includes those counts in `getProfileResults()`.

## Camera-motion regression

Open `/scripts/gpu/reflection-motion-check.html` (append `?renderer=webgl` for the fallback backend). It renders the production water material with frozen waves and static markers, then compares translated, rotated, slowly moving and zooming cameras against an unthrottled reference. Results are also available through `window.__reflectionMotionCheck`. Each moving frame must match the reference within one color value and produce a fresh capture. Node tests cover idle cadence, Performance, parent transforms, projection changes and fixed-probe invalidation.

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

## Coast implementation review

The graded sea grid replaces 66,049 coarse sea vertices with approximately
265,856 vertices, concentrating geometry around the surf and playable water.
Wave detail fades with distance and quality; the reflection refresh policy above
is retained. Refraction captures are now local to the water material and render
target, so an HDR scene pass cannot reuse a canvas-format texture after renderer
recovery. Captures are disposed with the material.

A matching 1280 × 720 coastal pass in native headless Chrome on Metal measured
approximately 16.67 ms mean and 16.8 ms P95 for both the original sea and the
updated offshore, transition, beach and curved-shore views. Both runs were
refresh-rate limited. These results do **not** measure isolated GPU cost or prove
that the denser geometry is free.

The existing reflection benchmark measured 16.67 ms mean with the current
policy for stationary and moving views; its historical-policy comparison was
16.67 ms stationary and 17.64 ms moving. These refresh-rate-limited numbers are
validation of the harness, not a new performance improvement claim.

Local comparison captures and JSON reports are in `.cache/sea-review/`:
`before-*.png`, `after-*.png`, `beach-day.png`, `beach-rain.png`,
`beach-clearing.png`, and `beach-dry-again.png`. The daylight/rain sequence advances
moisture analytically by 60 seconds of rain, 10 seconds of clearing, then 400
seconds of drying, while rendering the actual scene and continuing wave motion.
See [Coast and beach](coast.md) for the runtime review and GPU-check entry points.

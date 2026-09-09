# Reflection performance

The expanded map exposed excessive reflection rendering: lake/sea planar captures ran every frame and the stationary inland cubemap rendered six views every 0.75 seconds. Isolating the planar captures removed most of the steady frame cost; removing periodic cubemap captures reduced spikes. Disabling water geometry or bank rocks separately made little further difference in the measured river view.

`ReflectionBudget` refreshes moving-camera reflections at most every 80 / 100 / 160 ms for Ultra / High / Balanced. Stationary views refresh every 250 ms so reflected foliage can still animate. Performance skips planar captures. Quality and weather changes invalidate the budget. The enhanced fixed cubemap captures initially and on environment invalidation; the legacy lake path retains its existing cadence. Main-view resolution, geometry, water animation and quality remain unchanged. Reflection motion is less frequent than main-view motion.

## Reproduce the comparison

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

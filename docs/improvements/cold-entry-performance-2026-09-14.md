# Cold-entry and movement performance — 14 September 2026

Baseline: `2c38bf5`, pulled before this work. This follows the buffer-reuse work in [the previous report](movement-performance-2026-09-13.md).

## Changes

Startup now prepares the actual cinematic scene pass and nested lake/sea reflection passes. A direct `compileAsync(scene, camera)` prepared a different render context, leaving the first visit to another region to initialize its rendering resources during movement. The new preparation waits for jungle assets, exposes future LOD variants with automatic LOD selection paused, and temporarily sets shared geometry draw ranges to zero. Visibility, culling, geometry ranges, LOD selection and reflection budgets are restored even if rendering fails. Shadows are refreshed afterward. Selected quality and instance populations are preserved.

The final capture prepared 6,741 scene objects and 307 geometries in 1.67 seconds, including the submitted GPU work. This moves work into loading; it is not a total startup-time comparison. `getProfileResults().warmup` exposes the measured cost.

Coastal jungle density weighting no longer creates an array and callback for every blade, and rejects samples outside the jungle’s Z bounds before evaluating the coast. Bounds remain editable, including reversed and numeric-string bounds. A separate comparison matched 86,400 samples against the original implementation.

## Measurement

Chrome/WebGPU, Apple M4 Pro / ANGLE Metal, 1280 × 720, DPR 1. Same committed browser harness and sequential baseline/final runs. The initial 9-unit/s route captures four seconds without warmup and includes relocation. Each 180-unit/s route has one second of warmup and eight seconds of capture. Shader/driver caches and host scheduling can vary between launches.

| Quality / region | Entry CPU max before → after | Fast CPU P95 before → after | Fast interval P99 before → after |
| --- | ---: | ---: | ---: |
| High / forest | 146.6 → 25.1 ms | 12.3 → 12.3 ms | 21.8 → 20.2 ms |
| High / meadow | 30.0 → 15.5 ms | 10.9 → 10.4 ms | 20.9 → 19.5 ms |
| High / river | 24.0 → 14.4 ms | 9.3 → 9.3 ms | 20.0 → 19.6 ms |
| High / jungleCoast | 107.1 → 27.2 ms | 12.1 → 12.0 ms | 20.6 → 19.8 ms |
| High / snow | 9.9 → 10.7 ms | 7.6 → 8.2 ms | 19.6 → 19.7 ms |
| Ultra / forest | 259.3 → 68.0 ms | 19.7 → 18.9 ms | 27.9 → 27.4 ms |
| Ultra / meadow | 64.9 → 31.6 ms | 19.1 → 15.8 ms | 29.5 → 24.4 ms |
| Ultra / river | 48.8 → 27.2 ms | 15.7 → 14.2 ms | 28.3 → 24.9 ms |
| Ultra / jungleCoast | 53.0 → 37.2 ms | 24.6 → 21.8 ms | 30.2 → 25.2 ms |
| Ultra / snow | 10.5 → 10.1 ms | 12.5 → 12.4 ms | 20.3 → 19.9 ms |

All 20 captures completed without browser or render errors. All High frame intervals stayed below 33.33 ms. Ultra still had a 68 ms forest entry after the quality switch and a 37.4 ms jungle entry. Two fast Ultra captures also recorded isolated 60.9 / 95.5 ms intervals, with 14.5 / 18.0 ms of measured application CPU work; the measurements do not establish the cause of the remaining gap. Those outliers are retained in the results. This does not establish hitch-free Ultra performance.

Steady scene-render CPU work increased by about 1 ms in the High forest comparison, while reduced grass work offset most of it. The benefit is smaller entry stalls and lower tail latency on most fast routes, rather than a uniform reduction in every per-frame metric. Retained grass arrays finished at about 207.6 MiB on Ultra, similar to the baseline 207.1 MiB. Heap snapshots are not retained-heap measurements.

## Sustained fast turns

The additional soak covers 60 measured seconds per quality after five seconds of warmup, at 180 units/s with repeated sharp camera-heading changes. High captured 3,600 frames at 60.0 FPS, CPU P95 12.1 ms, and a 23.0 ms worst interval, with no intervals above 33.33 ms. Ultra captured 3,093 frames at 51.5 FPS, CPU P95 18.9 ms, and a 57.4 ms worst interval; six intervals exceeded 33.33 ms and one exceeded 50 ms. Neither run reported browser/render errors. This is a final-code smoke measurement, not a paired soak comparison against `2c38bf5`. Ultra remains above the available frame budget on this hardware.

## Verification

All 403 tests pass. The restoration helper has 100% line, branch and function coverage in the focused tests. Regression cases cover failed rendering, cancelled loading, hidden ancestor lights, shared draw ranges, future LODs, reflection cleanup, mutable/reversed region bounds and fade corners. Lint, build and documentation checks (349 assertions) pass. `npm audit` reports three existing high-severity development dependency findings in the wrangler/miniflare/sharp chain; dependencies were not changed.

## Reproduce

Start the app on port 5173 and install the separate harness dependencies as described in the previous report:

```sh
node scripts/browser/run-movement-benchmark.mjs cold-final 5173
node scripts/browser/run-movement-benchmark.mjs cold-final-soak 5173 --soak
```

Local raw evidence is under `.cache/movement-performance/`: `cold-baseline-2c38bf5.json`, `cold-final.json`, screenshots and the forest CPU profiles. Forest rendering was visually checked after preparation. These generated captures are ignored by git.

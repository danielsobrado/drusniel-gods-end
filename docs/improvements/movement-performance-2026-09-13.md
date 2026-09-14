# Movement performance investigation

Comparison baseline: `08088f7`. CPU investigation began on 13 September 2026 against `4682c1f` (the same grass hot path); hardware comparisons ran on 14 September. Before pushing, the patch was rebased onto the newer tree/rock asset update `93e7410` and revalidated.

Grass tiles previously disposed every cached geometry when their pool slot moved to a new location. The next visible frame cloned the geometry, filtered the population, allocated replacement instance arrays, and uploaded fresh buffers. Filtering also sampled all five ecology channels despite needing only density.

The change retains each tile's geometry and instance buffers, rewrites the populated prefix, and invalidates placement separately from resource ownership. Final disposal, quality changes, and cancelled preset staging still release their resources. A density-only sampler preserves the full ecology sampler's density, including jungle activation and boundary interpolation. Blade identities and configured populations are unchanged.

Position storage is allocated with the four-component stride required by WGSL before its first upload. Otherwise Three.js r185 pads and replaces the array during upload, making later CPU compaction and partial updates unsafe. Attributes use version-triggered updates: `DynamicDrawUsage` would upload all visible grass buffers every frame in this backend. A regression exercises the pinned Three.js WebGPU attribute uploader through empty, partial, and full populations.

## CPU reproduction

Run `node scripts/debug/grass-cpu-benchmark.mjs`. The deterministic fixture uses a 64 × 64 ecology grid, 25-unit tiles, three repetitions of 100 relocations, and High/Ultra candidate counts. It measures CPU filtering and buffer recycling without a renderer. The fixture excludes the coastal jungle override; it is not a full-scene FPS benchmark.

| Tile population | Before median | After median | Before P95 | After P95 |
| --- | ---: | ---: | ---: | ---: |
| High density: 12,544 candidates | 1.446 ms | 0.491 ms | 1.712 ms | 0.558 ms |
| Ultra density: 18,769 candidates | 2.248 ms | 0.733 ms | 2.525 ms | 0.791 ms |

These runs show approximately 69% less P95 CPU time for Ultra tile recycling. This is separate from the full-scene measurements below.

The focused regression suite covers retained buffer identities, exact surviving populations, empty-to-full recycling, layout revisions, cancelled staging, cleanup, density equivalence, and actual renderer buffer-upload behavior.

## Hardware movement comparison

Chrome/WebGPU using Apple M4 Pro / ANGLE Metal, 1280 × 720, device pixel ratio 1. Baseline and updated runs were sequential. Audio was disabled. The matrix moves the camera and player focus continuously around each region at 9 and 180 units/second; the character controller is replaced for deterministic camera paths. Each fast measurement has 1 second warmup and 8 seconds capture. The initial 9-unit run has no warmup and includes relocation into the region.

| Quality / region at 180 units/s | Before CPU P95 | After CPU P95 | Before interval P99 | After interval P99 |
| --- | ---: | ---: | ---: | ---: |
| High / forest | 13.0 ms | 11.5 ms | 23.0 ms | 22.3 ms |
| High / meadow | 11.7 ms | 10.3 ms | 23.1 ms | 21.7 ms |
| High / river | 9.6 ms | 8.8 ms | 21.8 ms | 21.1 ms |
| High / coastal jungle | 12.4 ms | 10.7 ms | 22.7 ms | 21.2 ms |
| High / snow | 7.5 ms | 7.2 ms | 21.5 ms | 20.7 ms |
| Ultra / forest | 20.3 ms | 17.1 ms | 26.0 ms | 23.8 ms |
| Ultra / meadow | 20.4 ms | 15.7 ms | 25.9 ms | 22.3 ms |
| Ultra / river | 15.7 ms | 13.9 ms | 23.2 ms | 22.5 ms |
| Ultra / coastal jungle | 24.6 ms | 20.6 ms | 29.6 ms | 24.3 ms |
| Ultra / snow | 12.2 ms | 10.9 ms | 21.7 ms | 21.5 ms |

All 20 updated matrix captures finished without browser or render errors. Initial relocation still causes setup spikes: the updated forest entry reached 137 ms on High and 145 ms on Ultra. These include first-use material/render setup and simultaneous tile population; the change does not eliminate every cold-entry or quality-switch hitch. GPU driver caches may differ between browser launches, so cold-entry maximum differences are not treated as a reliable optimization percentage.

## Sustained movement, turns, and memory

The soak test covers approximately 11,700 units per quality over 65 seconds, with 5 seconds warmup and 60 seconds capture. It moves at 180 units/second around a 180-unit radius, while camera heading sweeps sharply back and forth by up to 180 degrees.

| Metric | High before → after | Ultra before → after |
| --- | ---: | ---: |
| Average frame rate | 60.0 → 60.0 FPS | 49.8 → 54.0 FPS |
| CPU P95 | 14.3 → 12.1 ms | 28.2 → 22.3 ms |
| CPU P99 | 16.4 → 13.1 ms | 32.3 → 24.9 ms |
| Tile-compaction P95 | 5.4 → 3.5 ms | 12.6 → 6.9 ms |
| Frame intervals above 33.33 ms | 0 → 0 | 28 → 2 |
| Frame intervals above 50 ms | 0 → 0 | 1 → 0 |
| Worst frame interval | 31.1 → 26.3 ms | 50.3 → 37.2 ms |

The updated runs recorded 3,600 High and 3,242 Ultra frames without browser/render errors. Ultra is still heavier than a steady 60 FPS on this machine; zero hitches on every device or route is not established.

After integrating the newer tree/rock assets from `93e7410`, the repeated soak recorded 3,600 High and 3,222 Ultra frames, again without browser/render errors or intervals above 50 ms. CPU P95 was 12.0 / 22.7 ms and the worst interval was 25.8 / 39.1 ms. The paired comparison table above remains tied to the earlier asset set; this final run verifies the combined version.

Retained grass arrays settled around 76.7 MiB (High) and 169.6 MiB (Ultra), compared with 17.7 / 52.5 MiB of live masked arrays at the end of the baseline route. Updated cache counts settled at 681 / 1,249 geometries, within the finite 225 / 441 tile pools with four LODs per tile. The broader five-region matrix retained 90.5 / 207.7 MiB. This measures CPU arrays, not total GPU allocation. End-of-soak JS heaps were lower after reuse (379 / 646 MB versus 1,047 / 2,573 MB), but these are unforced-GC snapshots and must not be interpreted as retained-heap measurements.

## Character gameplay

Four additional captures retained character physics, animation, camera obstruction, and keyboard input. Normal sprint targeted 12 units/second; double-Shift boost targeted 120. Each had 2 seconds warmup and 15 seconds measurement. The player traveled approximately 201 / 1,893 units on High and 202 / 1,877 on Ultra, including warmup. All 3,524 captured frames had intervals below 33.33 ms, with no browser or render errors. The worst boosted interval was 21.8 ms on High and 27.4 ms on Ultra. These are updated-code smoke measurements, not matched baseline comparisons.

## Verification

- All 387 tests pass after integrating `93e7410`; the new regressions first failed against the old implementation.
- Buffer modules: 98.77% line coverage, 96.77% branch coverage; compaction has 100% line/branch coverage.
- Lint, production build, documentation/config checks (349 assertions), and `git diff --check` pass.
- `npm audit` reports three existing high-severity development-tool findings involving miniflare, sharp, and wrangler. Dependencies were not changed by this performance patch.

## Reproduce

Install the separate browser harness dependencies with `npm ci --prefix scripts/browser`, install Chrome, and start the app with `npm run dev -- --host 127.0.0.1`. Run:

```sh
node scripts/browser/run-movement-benchmark.mjs current 5173
node scripts/browser/run-movement-benchmark.mjs current-soak 5173 --soak
node scripts/browser/run-movement-benchmark.mjs current-gameplay 5173 --gameplay
```

The gameplay mode uses keyboard sprint and double-Shift exploration boost, retaining character physics and animation. Reports, screenshots, and the first forest CPU profile are saved under `.cache/movement-performance/`. Use an isolated baseline server and a different report label for comparisons, running one browser measurement at a time. Browser errors and missing movement cause a nonzero exit.

# Regional effect performance — 2026-09-18

Static review covered the recent snow, atmosphere and light-shaft commits through
`d44bb06`. The loading-screen update `6f08f50` was pulled before final validation.

## Changes

- Light-shaft mask and march targets initialize during warmup, sleep at exactly
  zero intensity, and refresh before contributing again. They survive effect
  switches. Depth and normal resolves run once per scene frame rather than once
  per nested post-processing render. Owned targets and materials are disposed.
- Valley fog keeps its original integration positions, sample count and density.
  Samples inside the near-clear interval skip terrain reads; samples above the
  fog ceiling skip pocket noise. Both cases previously multiplied their work by zero.
- Snow detail layers skip texture reads when their existing fade or coverage is
  zero. Explicit gradients preserve texture filtering inside branches. Snow relief,
  calm patches, textures, fade distances and shading controls remain unchanged.
- Snowfall, powder and footprint contact queries use conservative cached terrain
  height bounds. The bounds include emitter radius and maximum wind drift.
  Beach sand remains eligible for footprints and kicked particles. Live particles
  and existing footprints continue to age after leaving snow.
- Footprint recovery visits occupied pixels instead of scanning the entire field.
  Decay, rounding, gradients and scrolling are covered by byte-level regression tests.
- Camera-facing snowfall and powder use a single transparent draw pass.
- Lake and river geometry is partitioned into local visibility cells, preserving
  every triangle, winding, normal and attribute. Refraction no longer requires
  submitting the complete inland-water mesh when only a small reach is visible.
  Lake planar captures require a visible cell whose water level can use them;
  sea captures require a visible sea tile. Moving-camera capture updates are retained.
- Ocean normal detail, whitecaps and crest transmission are skipped on inland
  water. Inland foam is skipped on sea water. Sea detail stops sampling at its
  existing fade distances. Unused footstep ripple slots skip their arithmetic.
- Regional shaft setters also work when cinematic rendering is disabled.

## Evidence

All 463 Node tests, ESLint, the production build and 399 documentation/config
assertions pass. The original seven regression tests failed before the fixes.
Focused Node coverage is 100% of lines for the new effect target and snow-region
bounds, water geometry partitioning, reflection budget and snowfall; footprint
coverage exceeds 98%. The complete repository's Node-only coverage is lower,
because rendering callbacks and much of the app require a browser.

The production scene was exercised on Chrome's WebGPU and WebGL backends,
including returning to the lake/sea, waking and sleeping shafts, switching all
quality levels, TAA, sharpening, depth of field and shaft toggles. Both backends
completed without browser or shader validation errors. The GPU material harness
also passes on both: 1,040 sea-wave comparisons, 6,240 coast comparisons, finite
water normals and 34 production material frames.

The same Ultra scene on `d44bb06` and the changed code produced these actual draw
counts over twelve frames with the sun overhead and the view facing away from water:

| Work | Before | After |
| --- | ---: | ---: |
| Invisible light-shaft passes | 24 | 0 |
| Full-resolution depth resolves | 48 | 12 |
| Water draws / refraction copies / planar captures | 0 / 0 / 0 | 0 / 0 / 0 |

The zero-water row verifies inactivity, rather than claiming a saving in that
particular view. Water that is still visible in the distance continues rendering.
In the separate uphill-river view facing away from the lake, the baseline made
one unused lake capture over two stationary frames; the changed code made zero.
The local geometry tests prove that partitioning does not remove or simplify any
surface triangles. Captures of snow, river, lake, sea and meadow were inspected
against the pulled baseline; animation timing prevents a pixel-identical full-scene
comparison. These checks establish removed work and preserve the rendering controls;
they are not an FPS claim or proof that every possible source of stutter is eliminated.

`npm audit` still reports three existing high-severity development-tool advisories
(`miniflare`, `sharp`, `wrangler`). Dependency versions were not changed in this pass.
Vite also retains its existing large-bundle warning.

## Reproduce

Start the app with `npm run dev`, install the browser package's dependencies if
necessary, then run:

```sh
node scripts/browser/check-effect-activity.mjs
EFFECT_RENDERER=webgl node scripts/browser/check-effect-activity.mjs
node scripts/browser/run-gpu-checks.mjs --renderer=webgpu --base-url=http://127.0.0.1:5173
node scripts/browser/run-gpu-checks.mjs --renderer=webgl --base-url=http://127.0.0.1:5173
```

`EFFECT_BASE_URL` selects a different running checkout. `--baseline` records the
old code's counters without enforcing the new activity assertions. Screenshots and
JSON results go to `.cache/effect-performance` (or `EFFECT_OUTPUT`).

# Softer snow running and alpine trees

Running now lifts a low translucent plume. The wake has smooth fades at the ground, bow, crest and tail, with a derivative-aware erosion band instead of a hard alpha cutout. It uses one transparent pass, does not write depth, and casts no opaque sheet shadow. Powder particles ease in over 60 ms and fade out through alpha while retaining their growing footprint.

The shipped tuning lowers the reference wake height from 2.4 to 0.65 m and lifetime from 0.88 to 0.65 s. Curtain emission falls from 88 to 24 particles per reference metre, foot-contact emission from 18 to 10 particles, and running multiplier from 1.5 to 1.2. Shake amplitude is 0.012 instead of 0.05; streak strength is 0.18 instead of 1. Particle alpha also softens ambient snow and sand kicks through the shared pool.

In a controlled 2.5-second curved sprint with a 5 m reference character moving at 18 m/s, the peak packed wake amplitude fell from 2.25 to 0.56 m and active spray fell from roughly 440 to 65 particles. These are fixture measurements, not an FPS benchmark; random spray emission causes small count variations. The full scene was also inspected with the animated Drusniel character.

All four alpine trees now use paired twigs with pointed needle bundles and closed, rounded snow caps. Spruce upper crowns are fuller, while the exposed pine and storm fir retain their asymmetric silhouettes. Placement, three near materials, and two-card distant LODs are preserved. The atlases were rebaked and embedded in the GLBs.

| Tree | Previous high-detail triangles | Current |
| --- | ---: | ---: |
| Snow spruce | 24,110 | 24,058 |
| Windswept mountain pine | 10,118 | 9,144 |
| Young spruce | 13,038 | 11,270 |
| Old storm fir | 7,370 | 6,926 |

Validation:

- 467 Node tests pass, including particle lifetime alpha, wake blending flags, closed snow geometry, geometry budgets, embedded atlas parity, and existing regional activity tests.
- Lint, production build, and 401 documented configuration assertions pass.
- Focused Node coverage of the powder system, wake material construction and wake config resolver is 94.13% lines. GPU shader execution is checked separately in both backends.
- `snow-effects-check` reads back real GPU alpha values on WebGPU and WebGL 2: particle peak alpha rises from 0.031 during entry to 0.418, then falls to 0.018 before expiry. It verifies soft wake pixels and that both effects stop drawing after leaving snow and allowing existing particles to expire.
- Full-scene snow, river, lake, sea and meadow renders and an animated-character snow sprint completed with no captured browser or shader errors.
- `npm audit` still reports three pre-existing high-severity development dependency advisories through Wrangler / Miniflare's nested Sharp. Dependencies were not changed in this visual pass.

Reproduce the GPU regression against a running dev server:

```sh
node scripts/browser/run-gpu-checks.mjs --renderer=webgpu --base-url=http://127.0.0.1:5173 snow-effects-check
node scripts/browser/run-gpu-checks.mjs --renderer=webgl --base-url=http://127.0.0.1:5173 snow-effects-check
```

Regenerate alpine assets with the development server running:

```sh
npm run assets:alpine-trees
TREE_BAKE_START=10 TREE_BAKE_END=13 npm run assets:tree-billboards
npm run assets:alpine-trees
```

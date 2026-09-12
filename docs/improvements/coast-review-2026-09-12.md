# Coast and offshore implementation review — 2026-09-12

Reviewed incoming main: `4692147b82ef7682152b8c87bfa0c24a0b5f4477`, including `e98f6f7` (coastal ocean rendering) and `4692147` (CoastField consumer drift).

The core features in the [coast fixes](../plans/coast-fixes.md) and [offshore waves](../plans/offshore-waves.md) plans are implemented. This review corrected functional gaps in those commits rather than treating their presence as proof of completion. Validation limits and the performance comparison are recorded below.

## Fixed findings

| Finding | Correction and regression coverage |
| --- | --- |
| Softened swash and breakup exceeded the configured inland reach | The CPU/TSL front and coverage stay within the configured limit. Tests sample the full wave cycle just outside that limit. |
| Wash memory animated sand that visible water never reached and jumped at maximum run-up | Memory now uses a decaying finite history of actual water coverage. Tests cover impossible coverage and continuity at maximum run-up. |
| Ground film and ocean transparency used different shoreline masks | Both use the shared mean-depth `seaCoverage` ramp; ground film/foam use its complement. CPU/TSL parity includes intermediate shoreline samples. |
| Coast material depended on a river sampler or expanded terrain | An enabled sea also enables its ground treatment. The standalone production-ground harness exercises the shader without a river. |
| Offshore specular controls changed inland water appearance | Lake and river retain the established specular response; the sea selects its new roughness-aware response. A rendered comparison verifies ocean specular controls do not alter lake pixels. |
| Creeping clumps used their patch anchor's height after horizontal offsets | Every clump samples its own height and slope. A tilted-terrain test detects floating or buried roots. Removed a degenerate leaf triangle. |
| Invalid artistic bands reached smoothstep/depth expressions | Reject non-positive shelf depth, reversed grain fade bands, and invalid foam core/width combinations. |
| WebGPU preflight ran on `about:blank` and could falsely skip supported hardware | Probe from a secure application-origin page. Navigation/probe failures fail the check; unexpected renderer fallback after a successful probe also fails. |
| Existing tests assumed monolithic water and the former detail byte encoding | Updated inland/tile ownership assertions and decoded slope/moment tests. Preserved physical detail amplitude rather than changing it to satisfy an obsolete threshold. |

Additional placement controls now live in YAML: creeping-patch radius, ground offset and roughness; debris patch frequencies. Default appearance remains unchanged by this extraction. Shared CPU normal diagnostics include the full displacement envelope when checking transition normals.

## Local validation

- Node suite: **301 passed, 0 failed**.
- Lint and documentation checks passed; **324 configuration/document assertions** matched.
- Production build passed, with the existing large-bundle advisory.
- Required WebGL 2 and strict WebGPU browser checks passed. Each backend checked **1,040 wave/normal values**, **6,240 CoastField values**, finite water normals, and **34 production-material frames**, including inland specular isolation. Maximum CPU/GPU parity error was approximately **0.003897**, below the 0.004 harness tolerance.
- Integrated Chrome/Metal scene review exercised Performance, Balanced, High and Ultra in sunny, rainy and moonlight states. At the curved beach view, **21 of 48 sea tiles** were visible. Main-view vertices ranged from 33,213 (Performance) to 178,032 (Ultra).
- The actual renderer-recovery harness passed WebGPU restart followed by WebGL 2 fallback, preserving beach moisture and wave time. The two deliberately injected device-loss messages are expected; the completed stable-Chrome review had no other console errors.
- The reflection benchmark completed with approximately 16.7 ms median frame intervals in its four scenarios. Those results are refresh-rate limited and do **not** establish unchanged GPU cost.

Local captures and machine-readable evidence are in `.cache/sea-review/`: `review-sunny.png`, `review-rainy.png`, `review-moonlight.png`, `latest-review-report.json`, and the separate plan performance comparison. These are local review artifacts, not runtime assets or published screenshots.

## Delivery checks and limitations

- Matched baseline `c4911c7` and current working-tree comparison passed all **12 processing median/P95 metrics** against the 10% threshold. Worst increase: **5.13%**. Both runs used actual WebGPU in Chrome/Metal, 1280×720, High quality and sunny weather, with beach/transition/offshore stationary and 36-unit moving routes. Each route used 2 seconds warmup and 5 seconds measurement, one repetition. This is a short local regression sample, not a cross-device performance certification. GPU timestamp metrics were unavailable in both builds and remain unverified. See local `plan-performance-review.json` for raw timings.
- GitHub reported **zero workflow runs** for the reviewed incoming SHA. Local results are not remote CI certification; recheck the pushed commit separately.
- The dependency audit found three high-severity entries in the existing development-tool chain (`wrangler` → `miniflare` → nested `sharp`, advisory GHSA-rgj7-g3m4-5g8c). This rendering change does not update that dependency chain.
- Static captures, numerical parity and material rendering checks do not prove exact visual equivalence to Windrose or eliminate every possible driver-specific issue. The screenshots remain art-direction references.

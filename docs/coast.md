# Coast and beach

The eastern shore is driven by one shared analytical field. Daylight, rain and storm presets change the same terrain and water rather than switching to a separate beach biome.

## Shared CoastField contract

`src/world/CoastField.js` is the authority for the curved shoreline and beach state. `src/world/coast.js` only re-exports compatibility helpers. CPU and TSL consumers resolve the same `water.sea.coast` configuration and share these outputs:

- signed coast distance, positive toward the sea;
- analytical shelf depth outside the finite terrain height texture;
- beach-wave phase and run-up front;
- instantaneous thin-water coverage and broken foam front;
- residual wash memory and permanent shoreline moisture;
- ordinary vegetation, coastal groundcover and beach-scatter suitability.

Terrain shaping, the water shader, ground shading, coastal groundcover and beach debris all use that contract. `/scripts/gpu/sea-check.html` compares CPU and TSL results at curved coast positions, in dry and rainy states, including clocks beyond ten minutes.

## Swash and wet sand

The incoming and retreating waterline uses the same beach phase as the sea. The ground material renders a thin analytical film over inland sand; it is not a second water mesh or a fluid simulation. The sequence is visible water and foam, reflective wet sand, damp sand, then drying sand.

`waterCoverage`, `foamFront` and `washMemory` are coupled. Coverage and residual wash stay within the configured inland reach. Memory is a decaying history of actual coverage, avoiding wet strips that were never washed and abrupt resets at maximum run-up. Wave wash works in dry weather. Rain raises persistent beach moisture and slows the visual return to dry sand.

Both materials use `seaCoverage`, a smooth ramp over 0.015–0.15 units of mean analytical depth. Sea opacity follows this ramp and the ground film/foam use its complement. Optical depth still includes displaced wave height; the shared handoff avoids separate distance and depth cutoffs.

Fresh scene construction seeds accumulated beach moisture from the initial preset's resolved rain intensity. A recovered session restores its saved moisture and wave clock afterward. Preset and quality changes do not reseed the accumulator. Wetting and drying use frame-rate-independent exponential integration.

Sand remains dielectric. The two configured dry colors are mixed with broad variation and finer distance-filtered grain; saturation darkens the result, lowers roughness and flattens fine normals. Foam, film tint, roughness and spatial frequencies are configured under `water.sea.coast.sand`.

## Coast geometry and offshore waves

The inland lake/river geometry remains on `WaterSurface.mesh`. The sea is 48 child meshes built from a global coast-relative lattice. Adjacent tiles duplicate identical boundary samples, so quality changes do not introduce T-junctions. Tile bounds include the configured maximum storm displacement and ordinary Three.js frustum culling removes off-screen sea tiles from the main view.

Sea geometry is rebuilt only when water quality changes. The shared material, wave clock, refraction and reflection resources survive the replacement. `water.stats` reports total and main-view visible sea tile, vertex and triangle counts independently from reflection capture counts.

The geometry-scale ocean uses five zero-mean directional components with wavelengths 56, 38, 28, 20 and 16 world units. The default offshore amplitude is 1.6 and the storm multiplier is 1.65, giving a conservative vertical displacement bound of 2.64. Shallow-water attenuation still caps displacement against analytical depth and brings it to zero at the waterline.

Medium and fine sea normals come from a mipmapped slope texture whose alpha channel stores a second slope moment. Filtered mean slope and mean squared slope produce variance used to broaden explicit sun specular as detail becomes unresolved. Fine detail fades sooner than medium detail; the shared geometry wave phase never changes with quality.

Offshore whitecaps use displaced crest and steepness signals plus advected breakup. They fade toward the surf transition while shoreline foam comes from `CoastField.foamFront`. Crest transmission is view- and light-dependent rather than a fixed emissive tint.

## Live sky and reflections

The procedural `SkySystem` exposes the same gradient and halo node to the sea shader while omitting the sun disk from that sky sample. Water adds sun energy once through its own explicit specular path. The fallback sky colors remain available if no provider is present.

High, Balanced and Performance retain cached reflections. Ultra retains the existing live planar policy. Weather changes invalidate the existing reflection budgets; the ocean work does not add a new render pass.

## Sparse coastal ecology

`CoastalGroundcover` creates deterministic creeping-leaf instances 55–145 units inland. Active wash, underwater positions and steep slopes are rejected. The maximum patch count is 500 and the visible fraction follows the active quality setting. The system has no collisions and does not cast shadows.

`BeachScatter` keeps deterministic pebbles, shell-like pieces and twigs while taking its bands, density, seed, sizes, colors and slope threshold from `water.sea.coast.scatter`. Both systems explicitly dispose their geometry and materials with the world.

## Footprints, kicked sand and glints

Beach sand reuses the alpine snow interaction instead of carrying its own copy. `sampleSandCoverageCpu` in `CoastField.js` is the CPU match for the shader's coastal sand band. It covers sand above the waterline, and it reports dryness as the inverse of the shoreline's base moisture.

- **Footprints:** the player-following deformation field paints wherever there is snow or beach sand. The sand shader reads the field through `createDeformationNodes`, the same reader the snow uses. A print darkens the sand, the kicked berm dries a little lighter, and the print's slope bends the sand normal.
- **Kicked sand:** the powder pool throws sand-coloured puffs from footfalls on dry sand only, so wet sand near the swash stays still. The kick is lower and shorter-lived than snow powder, and ambient spindrift stays snow-only.
- **Glints:** dry sand reuses the snow's cell glints as quartz sparkle. The wet sand and the water film stay matte.

The tuning lives beside the other sand settings under `water.sea.coast.sand`: `footprint*`, `glint*` and `kick*`.

## Validation

Node tests cover CoastField configuration and invariants, phase wrapping, wetting/drying, deterministic ecology, sea bounds, tile topology and quality geometry. The real-render sea harness validates CPU/TSL displacement, normals and CoastField outputs, then renders the production water and ground fragment graphs. It also verifies that offshore specular controls do not change lake rendering. CI runs that harness in Chromium WebGL 2 through SwiftShader and attempts WebGPU separately when the runner reports hardware/API support from the application's secure origin. A renderer fallback after a successful adapter probe is a failure, not an unsupported skip.

Use `/scripts/debug/sea-review.html` for integrated coast, transition, offshore, lake and river review. Fixed visual review and hardware GPU measurements remain device-dependent; missing hardware measurements must be reported as a limitation rather than interpreted as zero cost.

See [Coast/offshore configuration](coast-offshore-config.md) and [Reflection performance](water-performance.md).

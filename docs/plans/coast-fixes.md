# Coast fixes: shared swash, beach materials, geometry, and validation

Status: **planned; this document does not report implementation or validation of the proposed changes.**

Saved: 2026-09-11. Reviewed baseline: `c4911c72dd111dc3874f843d1ef7dbae580f3930`.

Companion plan: [Offshore waves and surface detail](offshore-waves.md). Implement the shared contracts and geometry foundations here before integrating that rendering work. The selected delivery includes both plans.

## 1. Outcome and evidence

Create one believable coast whose materials and sea respond continuously to sunlight, waves, and weather. Windrose screenshots provide visual inspiration, not evidence of that game's implementation. Attached documents and quoted AI reviews are reference material; this plan records the user's requested outcome and the reviewed implementation decisions.

| Region | Daylight | Rain or storm |
| --- | --- | --- |
| Upper beach | Warm beige, matte, granular, mostly open sand | Darker, damp sand on the same geometry |
| Damp beach | Cooler, darker tan with irregular patches | Dark brown/olive-grey, slower drying |
| Active wash | Moving thin water and foam, followed by reflective wet sand | Stronger wash, more persistent foam and wetness |
| Shallows | Sand visible through clear turquoise water | Muted green/teal transmission and darker water |
| Offshore | Blue swells and restrained whitecaps | Rougher waves, more foam, lower visibility |

Preserve lake and river behavior, terrain layout, navigation, scene lighting architecture, renderer recovery, and reflection refresh budgets. Weather modifies the biome; do not author separate sunny and rainy beaches.

### Audit issues to resolve

1. Sand currently receives animated wash roughly 12–1 units inland, while zero inland ocean depth prevents visible water from reaching it. Couple visible swash and subsequent wetness.
2. Beach art controls are scattered through JavaScript. Move tunable appearance and placement values into YAML; numerical/model constants can remain in code.
3. Coastline, shelf, and placement calculations have multiple owners. Consolidate them behind one CPU/TSL field contract.
4. Approximately 266k sea vertices are merged with inland water. Add spatial culling and quality-dependent geometry before making performance claims.
5. A fresh rainy scene initializes accumulated beach moisture to zero. Distinguish established initial weather from live transitions and recovery.
6. Existing vegetation masks suppress growth near shore, but do not provide deliberate creeping coastal groundcover.

The reviewed SHA had no reported GitHub workflow runs. Previous local checks do not certify remote CI, and a refresh-rate-limited benchmark does not prove the denser water is free.

## 2. Shared model, configuration, and swash

### Authoritative CoastField

Make `src/world/CoastField.js` the public authority for signed coast distance, shelf height/depth, beach phase, run-up, moisture, and placement suitability. CPU and TSL implementations must consume the same resolved configuration. Existing `coast.js` exports become compatibility wrappers; avoid circular imports by placing any shared pure primitives below both wrappers and field consumers.

Route terrain, water, ground material, procedural vegetation, and beach scatter through this contract. Remove independent shoreline-distance and shelf calculations from consumers. Keep the analytic shelf continuous beyond the terrain texture bounds.

Add these shared outputs alongside the existing fields:

- `shoreRunup`: the analytical incoming/retreating swash front.
- `waterCoverage`: instantaneous thin-water coverage.
- `foamFront`: a continuous crest/front mask with irregular breakup.
- `washMemory`: residual wetness left after water retreats.
- `groundcoverSuitability`: eligibility for sparse creeping plants, separate from ordinary grass suitability.

Keep `waveWash` as a compatibility alias during migration. Use the existing beach phase and common clock for sea surf and ground swash. Ensure masks remain continuous when phase wraps; a one-sided pre-crest mask must not disappear abruptly at the next cycle.

### Visible water and moisture

Render the swash film and foam in the existing ground material on the ground geometry. Coverage changes reflected appearance, roughness, normal response, and foam. This is an analytical thin-film effect, not simulated water volume; it requires no extra render pass or intersecting inland ocean sheet.

Use a shared coastal coverage function to blend ground film into the sea through the existing approximately 0.015–0.15 shallow-depth opacity range. Do not introduce a hard depth handoff. Ground and sea must not show duplicate foam or an uncovered seam at the junction. Keep depth-limited sea displacement and centered wave heights.

The sequence must read as incoming water/foam, fresh reflective wet sand, damp sand, then drying. Rain increases baseline moisture and persistence without being required for wash. Start from the existing 12-unit maximum inland wash reach; expose reach, front width, retreat duration, breakup, and decay for art tuning. Tie residual wetness to the same front that produces visible coverage.

### Configuration and defaults

Add optional `water.sea.coast` groups for `curve`, `terrain`, `wave`, `swash`, `moisture`, `sand`, `vegetation`, and `scatter`. Resolve defaults once and share the result across CPU and TSL consumers. Reject non-finite values and invalid ordered bands with named configuration errors. Existing configurations without this section remain valid.

Move all artistic colors, roughness, detail frequencies, spatial bands, seeds, densities, sizes, slope limits, and wetting/drying timings into configuration. Retain current values unless this plan explicitly changes behavior. Numerical epsilons, hash mechanics, and geometry templates can remain in code.

- Preserve current coast shape and terrain shelf elevations. Depth is measured below configured sea level, not an absolute world elevation.
- Preserve the 13-unit beach wavelength and existing phase motion as the starting point.
- Preserve 18-second wetting and 100-second drying defaults with frame-rate-independent exponential integration.
- Preserve `#b39a72` and `#d6be96` as two **dry sand tonal colors**, not a wet/dry pair. Wetness modifies the resulting dry color.
- Preserve dry/wet roughness starting values of 0.97/0.24 and zero metalness. Saturation darkens sand and slightly flattens fine normals.
- Retain micro grain, approximately 1–4-unit mottling, and approximately 10–30-unit broad tonal variation, with distance filtering and no obvious repeating square texture.

On fresh scene construction, seed accumulated beach moisture from resolved initial rain intensity. Restore saved moisture and clock when recovering a session, overriding the fresh seed. Later preset or quality changes must not reseed moisture; sunny-to-rain transitions accumulate gradually and clearing weather dries gradually.

## 3. Sea geometry and sparse ecology

### Crack-safe sea tiles

Preserve `WaterSurface.mesh` as the existing root `Mesh`. Keep lake and river geometry on it; attach sea tile meshes as children with identity transforms and root-local vertex coordinates. All water shares the material, uniforms, clock, and capture resources. Hiding the root during reflection capture must hide every tile.

Partition a global quality-specific lattice into 48 tiles using these coast-relative boundaries:

- Across coast: `[-180, 80, 180, 650, 1100, 2000, 4500]`.
- Along coast: `[-3000, -1200, -850, -425, 0, 425, 850, 1200, 3000]`.

Pin tile and spacing-band endpoints in the global lattice. Adjacent tiles duplicate only identical boundary samples and attributes, with no missing cells or T-junctions. Curved shoreline alignment comes from the shared field.

| Quality | Surf (-10..80) | Inner sea (80..180) | Outer playable (180..650) | Far bands (650..1100 / 1100..2000 / 2000..4500) |
| --- | ---: | ---: | ---: | --- |
| Performance | 2 | 4 | 8 | 20 / 60 / 180 |
| Balanced | 1 | 3 | 6 | 15 / 45 / 120 |
| High | 1 | 2 | 4 | 10 / 30 / 90 |
| Ultra | 1 | 2 | 2 | 8 / 24 / 72 |

All spacings are world units. Retain 10-unit inland spacing before -10. Along-coast central spacing is 8/6/4/4 for Performance/Balanced/High/Ultra; shoulder spacing is 24/14/10/8 and distant spacing is 90/60/45/45. Central, shoulder, and distant boundaries are absolute z of 850 and 1200.

Rebuild sea buffers only when geometry quality changes. Construct replacements fully before attaching them and disposing old buffers. Do not reset wave time or recreate shared shader/capture resources. Enable tile frustum culling, retain the water occlusion-culling exemption, and expand each tile's box and sphere for the configured maximum storm displacement. With the companion defaults, the vertical bound is 2.64 units.

Document that root `.geometry` now represents inland water; aggregate bounds and statistics must include sea children. Add main-view visible tile, vertex, and triangle counts without conflating reflection submissions with the main view.

### Groundcover and scatter

Add seeded procedural creeping leaf patches, concentrated 55–145 units inland. Exclude active wash, underwater positions, and steep slopes. Use the dedicated shared suitability field so ordinary grass/understory behavior stays unchanged.

Start with a maximum of 500 patches, 1–3 clumps per patch, and quality fractions 0.35/0.60/0.85/1.00. Keep apparent playable beach area at least approximately 90% open sand. Use bounded instanced geometry, no collisions, no cast shadows by default, and explicit disposal. Procedural geometry avoids external asset dependencies.

Retain deterministic pebbles, shell-like objects, and twigs, moving their current tuning into configuration. Footprints require a future player trail/imprint system and are not static scatter.

## 4. Terra implementation ownership and order

Use `gpt-5.6-terra` implementation agents. Every worker must be told it is not alone in the codebase, must preserve others' edits, and must coordinate changes outside its ownership.

| Worker | Ownership |
| --- | --- |
| Coast model | Shared config and field, coast compatibility helpers, terrain integration, ground material, scatter configuration, field/material unit tests |
| Sea geometry | Sea lattice/tiles, water geometry and WaterSurface, quality lifecycle, bounds, geometry tests |
| Weather and ecology | Initial moisture and recovery integration, EnvironmentController/GrassDemo wiring, world construction, groundcover, lifecycle tests |
| Offshore rendering | Companion plan: sea waves/nodes/detail, WaterMaterial, SkySystem, shader parity checks |
| Validation | Browser runner, package/CI wiring, documentation, new integration harnesses, captures, benchmark evidence |

The coordinator first locks the resolved field, coverage, and constructor interfaces. Geometry, ecology, and offshore work then proceed independently. The offshore worker owns WaterMaterial changes for the swash handoff; the coast worker owns GroundMaterial. The weather/ecology worker owns application wiring, and the geometry worker owns WaterSurface constructor plumbing. Agree those shared interfaces before edits. Validation can prepare its runner concurrently, then exercise the integrated result.

## 5. Acceptance and delivery

- [ ] CPU/TSL parity covers signed distance, shelf/depth, beach phase, swash, and moisture on straight and curved coast sections, including outside terrain texture bounds.
- [ ] Swash and foam are continuous across phase wrapping and the ground/sea handoff. Wetness follows visible coverage and persists independently of rain.
- [ ] Fresh rainy startup is already wet; fresh sunny startup is dry except shore moisture/wash. Live changes accumulate smoothly; recovery restores saved state; quality changes do not reseed.
- [ ] Wave displacement remains centered and bounded by shallow depth. Geometry cells, winding, shared boundary attributes, aggregate bounds, storm bounds, quality replacement, and disposal are tested.
- [ ] Groundcover/scatter are deterministic, sparse, slope-safe, and excluded from active wash and water. Existing inland vegetation is preserved.
- [ ] Add a pinned Playwright development dependency and reusable runner. Normalize existing harness result contracts; fail on shader errors, rejected results, timeouts, and missing required backends.
- [ ] CI runs a required WebGL 2 check using Chromium/SwiftShader plus lint, unit tests, documentation checks, and production build. Run strict WebGPU checks on supported hardware separately; unsupported execution is not a pass or proof of hardware compatibility.
- [ ] Review moving offshore-to-beach routes, curved shores, daylight, rain, moonlight, low sun, all qualities, and renderer recovery. Inspect foam, wetness, sand clipping, seams, faceting, shimmer, and lake/river regressions.
- [ ] Capture reproducible before/after views and matching processing/GPU median and P95 timings. Run the existing reflection benchmark. Investigate regressions over the repository's 10% threshold; missing GPU timestamps are an explicit limitation, not zero cost.
- [ ] Update coast, water, configuration, lifecycle, and performance documentation with implemented behavior and measured evidence. Keep this plan's status accurate.
- [ ] For the later implementation delivery, synchronize with main, resolve conflicts, review the diff, run required checks and dependency audit, and complete the previously authorized push/merge. Verify remote CI against the exact final SHA; missing workflow runs remain unresolved.

Saving this plan does not start implementation or Git publishing. No fluid simulation, underwater rendering, footprints, boat mechanics, new global atmosphere presets, or extra rendering passes are included.

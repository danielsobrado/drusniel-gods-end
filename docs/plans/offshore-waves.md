# Offshore waves: Windrose-inspired swells and surface detail

Status: **planned; this document does not report implementation or validation of the proposed changes.**

Saved: 2026-09-11. Reviewed baseline: `c4911c72dd111dc3874f843d1ef7dbae580f3930`.

Dependency and companion: [Coast fixes](coast-fixes.md). The selected delivery includes the six coast audit fixes, browser validation, and this offshore rendering work. Land the shared field interfaces and tiled geometry foundations before integrating the final appearance.

## 1. Visual target and boundaries

Use the supplied Windrose ocean screenshots and layered seascape HTML as visual/shaping references. The target is moderately larger everyday swells with much richer medium and fine surface structure, rather than permanently storm-sized waves.

- Daylight: irregular blue swells, dark troughs, green/translucent crest edges, broken reflective highlights, and restrained whitecaps.
- Storm: larger/choppier swells, stronger and longer-lived fragmented foam, darker green/teal water, and reduced visibility through existing weather/atmosphere controls.
- Low sun: a broad, broken reflection path that follows surface orientation and the actual sun direction/color.
- Toward shore: smooth reduction into the existing small beach surf, clear turquoise shallows, and the companion plan's coherent swash/wet-sand response.

Reference screenshots do not establish the game's shader technique or performance. Adapt layered wave shaping into the existing Three.js TSL water system; do not replace it with a standalone HTML ray marcher or copy its camera/lighting setup.

Apply the new shading and wave behavior to sea water only. Preserve lake/river appearance, refraction ownership, renderer recovery, sea-level centering, lighting/weather integration, and reflection refresh budgets. No FFT simulation, fluid dynamics, underwater rendering, swimming, boat physics, footprints, new render passes, or new external assets are required.

## 2. Wave model and configuration

### Geometry-scale waves

Keep displacement and base normals derived from one shared wave function, with matching CPU and TSL evaluation. Preserve the existing normalized directions and layer weights while changing the offshore scale:

| Control | Planned default |
| --- | --- |
| Offshore amplitude | 1.6 world units (currently 1.2) |
| Beach amplitude | 0.25 world units, unchanged |
| Offshore transition | 30–180 units from shore, unchanged |
| Offshore wavelengths | 56, 38, 28, 20, 16 world units |
| Corresponding layer weights | 0.48, 0.25, 0.14, 0.08, 0.05 |
| Maximum weather amplitude multiplier | 1.65 |
| Default conservative storm displacement bound | 2.64 world units |

Continue using the curved coastline and analytical ocean depth supplied by CoastField. Preserve shallow-water attenuation and the existing depth cap; offshore changes must not enlarge beach waves by bypassing that envelope. Sharpen crests without introducing a positive mean-height bias. Include the spatial transition/envelope derivatives when computing base normals so normals follow displaced geometry across the transition.

Retain existing optional sea amplitude, choppiness, and transition controls. Add dimensionless sea controls `detailStrength`, `whitecapStrength`, and `crestTranslucency`, each defaulting to 1. Store additional artistic detail scales, filtering distances, foam thresholds/decay, and optical tuning under `water.sea.detail`; do not duplicate coast controls there. Resolve defaults consistently with the companion configuration contract.

Weather modifies amplitude, choppiness, normal strength, foam threshold, crest width, and foam persistence through existing rain/weather uniforms. Quality changes reduce fine detail, not the shared phase or wave clock.

### Medium and fine surface detail

Use geometric displacement for the five larger wave layers and shading normals for shorter features. Add irregular directional detail at multiple scales so the surface does not read as evenly repeated sine ridges or a smooth sheet with uniform noise.

Keep stable medium-scale normals visible farther offshore; attenuate fine detail earlier with viewing distance and footprint. Do not fade every detail band together at the current horizon cutoff.

Extend the existing normal-detail texture's unused alpha channel with a consistently encoded second slope moment. Mipmapped mean slope and mean squared slope provide filtered variance through `max(E(slope²) - |E(slope)|², 0)`. Choose normalization that avoids clipping source slopes/moments, and use the variance to broaden specular response as unresolved detail disappears. Preserve normal orientation and encoding across both render backends.

The existing texture height/breakup channel may modulate patterns, but must not be treated as the actual ocean crest height. Foam and large crest lighting must remain coupled to the displaced wave model.

## 3. Foam, transmission, and reflection

### Offshore whitecaps and surf continuity

Derive whitecap eligibility from the shared large-wave crest/steepness signal. Break up eligible crests with advected detail and apply a short trailing decay. Avoid foam in troughs, uniformly painted white ridges, and detached static patches.

Use approximate visible coverage targets of 2–4% in ordinary daylight and 6–10% in storms as art-review guidance, not a hardcoded per-frame coverage guarantee. Expose threshold, breakup, intensity, and persistence controls. Blend offshore whitecaps out through the offshore-to-surf transition while existing beach-phase surf takes over; avoid doubling the foam at the overlap.

Consume the companion CoastField coverage and foam outputs at the waterline. Ground film, visible surf, and residual sand wetness must agree on phase and shoreline. Do not reintroduce an independent coast calculation in WaterMaterial.

### Sunny shallows and crest transmission

Preserve the sunny/storm palette inputs and optical-depth/refraction path. In daylight, the shelf should read as sand visible through pale turquoise, then turquoise, teal-blue, and offshore blue. Rain shifts the same water toward muted green/teal and navy without changing the biome.

Replace a generic height-only cyan crest tint with a restrained view- and light-dependent transmission term. Favor thin, backlit crest regions and suppress the effect in troughs, low illumination, and unsuitable viewing directions. Drive color and energy from actual scene lighting; avoid a fixed green glow at night.

### Live sky and sun response

Pass an optional live sky-color provider through application construction to WaterSurface and WaterMaterial. Use the existing SkySystem uniforms so ocean reflection follows daylight, weather, moonlight, and low sun. Preserve the current fallback when the provider is absent.

Allow sky sampling for water to omit the sun disk while retaining sky gradient/halo. Account for the sun once through explicit water specular, preventing duplicate sun energy. The material is a custom MeshBasicNodeMaterial; implement roughness-aware specular in its explicit shading rather than assigning an unused PBR roughness node.

Use filtered normal variance and surface orientation to produce a broader broken sun path, retaining controlled highlights rather than unstable pinpricks. Keep existing planar/cube capture policies and budgets, including Ultra-only planar reflection policy at the reviewed baseline. Reuse owned refraction resources and disposal/recovery behavior.

Use a low-sun review fixture through existing lighting interfaces. Do not alter global environment presets merely to make comparison screenshots look warmer.

## 4. Terra ownership and integration

Use a `gpt-5.6-terra` offshore rendering worker for `seaWaves`, `seaNodes`, `seaDetail`, WaterMaterial, SkySystem, and associated CPU/GPU parity tests. Tell the worker it is not alone in the codebase and must preserve other agents' edits.

Coordinate with the companion workers before shared edits:

- Coast worker owns the resolved field/config contract and GroundMaterial. Offshore consumes those outputs and owns WaterMaterial's side of the swash handoff.
- Geometry worker owns WaterSurface and tiled sea geometry. Supply its required sky-provider and shared-node interfaces; do not independently rewrite that constructor.
- Weather/ecology worker owns GrassDemo and application wiring. Supply the optional sky-provider integration requirements through that owner.
- Validation worker owns the browser runner, CI, evidence collection, and documentation integration. Offshore owns shader parity harness changes; agree harness result contracts before runner integration.

Capture the baseline before changing waves. Integrate in this order: shared coast contract; geometry and quality bounds; wave spectrum/base normals; medium/fine filtering; whitecaps and transmission; live sky/specular; full visual and performance review.

## 5. Acceptance and delivery

- [ ] Test CPU/TSL wave parity over multiple times and curved coastal locations, transition continuity, finite normals, sea-level centering, bounded shallow displacement, and maximum weather bounds.
- [ ] Verify source detail encoding, slope-moment range, mip filtering, and stable normals/specular when moving toward the horizon. Geometry and normal detail must agree near transitions.
- [ ] Verify whitecaps track actual crests, break up irregularly, persist longer in storms, and yield continuously to small surf and ground swash.
- [ ] Review fixed captures and moving routes offshore, across the transition, and at curved beach sections under daylight, rain, moonlight, and low sun at every quality setting.
- [ ] Check dark troughs, restrained green crest transmission, a coherent sun-reflection path, clear shallows, and absence of faceting, repeating bands, shimmering, detached foam, clipping, or seams.
- [ ] Run required WebGL 2 browser checks and strict WebGPU checks on supported hardware. Test renderer recovery and quality/preset changes without clock resets, stale sky uniforms, leaked captures, or duplicated water.
- [ ] Confirm lake and river regressions are absent and reflection refresh counts remain within existing budgets.
- [ ] Compare matching baseline/final routes on the same device, backend, resolution, quality, preset, and camera. Record processing and valid GPU median/P95 timings, main-view geometry counts, and the existing reflection benchmark. Investigate regressions greater than 10%; unchanged capped FPS is insufficient evidence.
- [ ] Run lint, unit tests, documentation checks, and production build. Update water/config/performance documentation and save labeled comparison captures with reproducible settings.
- [ ] Complete integration and the previously authorized Git delivery together with the coast plan; verify CI on the exact pushed SHA. Report unrun hardware checks and missing GPU measurements explicitly.

Saving this plan does not start rendering implementation or Git publishing. Completion requires the measured and visual evidence above, not only a successful build.

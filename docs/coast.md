# Coast and beach

The eastern shore is one biome. Daylight shows warm beige sand and turquoise shallows; waves wet the shoreline in dry weather, and sustained rain darkens the same sand and strengthens the same ocean. Terrain layout and navigation remain unchanged. Ships, buildings and player footprints in the references are outside this implementation.

## Shared field

`src/world/CoastField.js` shares curved coast distance, continuous ocean depth and the 13-unit beach-wave phase between water, sand and placement. Positive distance means seaward. The seabed continues analytically outside the finite terrain texture. CPU samples and TSL nodes are compared by `/scripts/gpu/sea-check.html`.

Sand combines permanent shoreline dampness, recent wave wash and accumulated rain. Wash uses the last crest's age, with a smooth arrival before the next crest: an analytic periodic memory effect, not a persistent wetness map. Rain accumulates with an 18-second time constant and dries with a 100-second time constant. Rain also prolongs wash. Moisture and wave clock survive renderer recovery.

Sand is dielectric and becomes darker, smoother and less granular when wet. World-space grain, metre-scale mottling and broad color variation break up the surface without repeating square color tiles. Fine grain fades with distance. The existing rain ripple controller supplies rain impacts.

## Ocean and surf

`water.sea` accepts these optional controls in `public/cinematic-look.yaml`:

| Control | Default | Meaning |
| --- | ---: | --- |
| `offshoreAmplitude` | 1.2 | Offshore vertical envelope in world units |
| `beachAmplitude` | 0.25 | Small surf envelope |
| `choppiness` | 4 | Crest shaping, allowed range 0–6 |
| `transitionStart` | 30 | Start blending toward offshore waves |
| `transitionEnd` | 180 | Complete the offshore blend |

Optional `colors.sunny` and `colors.storm` objects each accept `shallow` and `deep` colors. Rain interpolates the palettes. Refraction and depth absorption preserve visible submerged sand instead of replacing it with opaque cyan.

Large waves use five irregularly oriented, zero-mean harmonics. Displacement and base normals derive from the same function. Noise-warped detail normals add the supplied Seascape reference's fine surface texture; distance and quality attenuate that detail. Storms increase amplitude up to 1.65 times, sharpen crests and strengthen fine normals. Surf foam travels with the shared phase, breaks up irregularly and persists longer in rain. Shallow displacement is capped below 42% of mean depth and reaches zero at the waterline.

The sea is one indexed, coast-following grid: 1-unit spacing across the surf, 2-unit spacing across playable offshore water, then graded spacing toward the horizon. Alongshore spacing is 4 units through the playable region. Shared vertices prevent strip cracks; bounds include maximum storm displacement. Lake and river keep their existing wave and quality paths. See [Water performance](water-performance.md) for reflection refresh policy.

## Vegetation, debris and weather

The shared suitability field excludes vegetation from the wash and lower beach, then introduces sparse upper-beach patches before inland vegetation. Three deterministic instanced batches add small pebbles, shell-like fragments and washed twigs. They follow terrain height and slope, exclude active wash, and add no collision geometry. Resources are released and rebuilt with the world. Footprints remain deferred to a player-driven trail system.

Weather remains in existing environment presets: `sunny` now uses neutral daylight, `goldenHour` retains its warm treatment, `rainy` supplies storm lighting and sea state, and `moonlight` retains night lighting. No separate beach biome or new preset-name interface is introduced.

## Review

Open `/scripts/debug/sea-review.html` for coastal and inland camera positions, weather/quality controls, diagnostics and the reflection benchmark. The GPU check accepts `?renderer=webgl` for WebGL 2; without it the check uses WebGPU. Node tests cover transition continuity, sea-level centering, storm bounds, mesh topology, rain accumulation, independent wash, and debris placement and disposal.

Screen-space reflection/refraction cannot recover objects absent from their captures. Swimming, underwater rendering and fluid simulation remain outside this change.

Refraction captures are owned per water material and render target, with explicit disposal. This prevents HDR/canvas format mismatches when the renderer recovers.

### Windrose reference refinement

The daylight coast uses warmer, less pale sand, stronger irregular mottling and a clearer damp margin. Sunny foam crests are narrower and their trailing wash is less persistent, leaving more turquoise water visible between bands. Sea reflections use a deeper blue palette. Clear-weather coastal haze is reduced to compensate for the low-elevation mist multiplier; inland views and storm haze keep their existing treatment.

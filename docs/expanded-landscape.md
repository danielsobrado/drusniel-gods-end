# Expanded landscape

The default cinematic scene intentionally replaces the reference map layout. It covers 2,400 × 1,600 world units (X = -800…1600, Z = -800…800), with boundary walls inset 30 units. The complete 640-unit lake footprint is inside those walls. The mountain-fed river is approximately 870 units long, beginning above the snow line and reaching the lake at Y = -17. An eastern coastline leads from dry land through a sandy beach to a deep sea at Y = -24.

## Terrain and places

`terrain.expansion` in `public/cinematic-look.yaml` enables this layout. `width`, `depth` and `center` control its rectangular extent; `size` supplies the square fallback. The original `Landscape002` is sampled before its runtime geometry is replaced. Its central meadow and lake basin seed the expanded height field; new rolling terrain, a ridged northern massif and a coastal shelf extend it. The old background mesh is hidden in this mode. Source GLBs are unchanged.

The base grid has five-unit spacing. Two conforming subdivision passes refine the river corridor before carving its bed. Adjacent triangles share split edges; the rendered mesh also builds the Rapier terrain collider and GPU height map. CPU terrain queries use a 1536-square raster, with a half-float fallback height texture. Grass and water normally use a 2048-square GPU height texture. The final mesh is approximately 346,000 triangles.

The western forest adds deterministic, larger tree clusters around a winding loop. The eastern rocky uplands use the shipped rock pack with varied boulder sizes and collision for large rocks. Northern elevation and slope blend exposed rock into snow, and vegetation thins below the snow line. Authored trees and props affected by the new relief are regrounded, and objects inside the river corridor are omitted. Placement data on disk remains unchanged.

`LandscapePaths` defines seven connected routes: River walk, Forest loop, Summit trail, Stone country, Lakeside circuit, Coastal approach, and Dune trail. Its shared mask drives ground shading, vegetation exclusion and footstep surface classification. The old dirt mask is retained for the unexpanded fallback. `public/vegetation.yaml` owns the final 1024-square ecology resolution and the 38-unit moisture distance; it loads after cinematic settings.

## River and lake

`water.river.points` lists world X, Z and full width at each course control point. `RiverCourse` derives non-increasing water heights from the mountain profile, following the continuous mountain profile upstream. A spatial index answers bank distance, surface height and flow queries. Its half-float field is shared by terrain shading and the water shader. The crossing near [88, -19] has a shallow carved bed. Existing locomotion, water footsteps and expanding movement ripples work there; no swimming or current-force mechanic is added.

The lake, river and sea occupy a single mesh and share one TSL material. A common river ownership mask prevents overlapping lake/river fragments. Both inland surfaces use the same wave phase and displacement at lake level. Flow decelerates through the last reach. Shading combines two-phase advected detail normals, depth absorption, screen-space refraction, Fresnel reflection, sun highlights, shallow foam, turbulent streaks, rain perturbation and footstep ripples. Slope-aware normals and elongated whitewater give steep reaches a falling-water appearance. Asymmetric bank erosion, feathered water edges and clustered stones break up the channel outline. Rock textures project from three axes to avoid stretching on steep banks. Wet stone, sediment and restrained caustic shading connect the water to its banks and bed.

The horizontal lake/mouth and sea use separate camera-dependent planar reflections at their respective elevations. Probes are gated by camera position so the inland and coastal views do not always render both reflections. Sloped upstream water uses the existing cube-probe approximation. Reflection passes omit camera-dependent fine foliage and reuse shadow maps. The shared refraction buffer is captured by Three's viewport node; there is no fluid simulation or ray tracing. Tiny or off-screen refracted details remain a screen-space approximation.

At the river mouth, directional ripple coordinates, channel foam and bank transparency ease into the lake response over the final two units of elevation. The lake grid owns the flat reach inside its footprint; the river ribbon remains responsible upstream and outside that footprint. This avoids the hard reflective patch, exposed-bed rim and cracks from independently tessellated waves. The blend reuses existing detail samples and adds no geometry, draw calls or reflection captures.

`water.sea` enables the coast and sets `level` (-24), `shoreX` (1000) and `depth` (95). The curved shoreline is shared by CPU terrain generation and TSL shoreline shading. Land separates the sea from the inland lake. Dry sand transitions to wet sand, turquoise shallows, and a seabed reaching 95 units below sea level. Coastal vegetation fades before the wet beach, and scattered washed stones use the same rock palette. Offshore water has larger storm-sensitive swells, advancing foam bands and deeper blue absorption. Its geometry extends beyond the playable seabed for an uninterrupted horizon. Underwater rendering and swimming are not implemented.

Water quality follows the existing quality setting: Performance uses the inland cube probe and an ocean sky approximation; Balanced, High and Ultra use planar reflection scales of 0.4, 0.75 and 1.0 respectively. The configured planar scale is the construction default. Full-scene cost depends on the forest visible from the camera and the reflection; no universal frame-rate target is claimed. Renderer recovery reconstructs the terrain, masks, geometry and owned reflection resources from configuration.

## Review and validation

The scenic tour passes the forest, headwaters, river, and lake before finishing at the beach facing the sea. Its camera remains terrain-cleared, and stopping restores the original view.

Run `npm run lint`, `npm test`, `npm run check:docs`, and `npm run build`. Landscape tests load the actual source GLB and verify the expanded bounds, lake containment, alpine relief, non-increasing river level, carved bed, ford, shared water attributes, and absence of unmatched interior triangle edges. They also verify that collision vertices come from the displayed mesh and route control points remain inside the map.

Visual review must cover the lake at a grazing angle, the river mouth, the ford, alpine headwaters, forest, and rocky uplands, plus rain, moonlight, Performance and the WebGL 2 backend. Check changing reflections, shallow/deep transitions, clear banks, and the river/lake join while moving the camera. Numeric geometry tests alone do not establish visual quality.

Reflection refresh budgets and the reproducible timing comparison are documented in [Water performance](water-performance.md).

The GPU regression page at `/scripts/gpu/water-mouth-check.html` (append `?renderer=webgl` for WebGL 2) renders the production water shader against a small river field. It checks lake/ribbon ownership, preservation of upstream and out-of-footprint river water, and matching mouth normals and opacity at multiple wave phases with and without rain. The original shader fails six of these checks; the corrected shader passes all nine on WebGPU and WebGL 2. Fixed-camera landscape review also checks the visible mouth from `[170, -11, 78]` looking at `[235, -17, 112]`.

Cascade flow coordinates use signed cross-channel distance and accumulated three-dimensional surface distance. This avoids world-space projection shear at bends. A downstream-decaying impact field adds landing foam; small cross-channel surface relief and larger steep-bank outcrops break up the ribbon. Cascade reflections and glints are reduced to keep whitewater from reflecting the distant lake probe like a mirror. These changes reuse the existing water draw and rock batches.

The sea wave controls, shared coastal field, weather-responsive sand and sparse beach debris are described in [Coast and beach](coast.md).

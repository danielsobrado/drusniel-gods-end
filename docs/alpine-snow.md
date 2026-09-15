# Alpine snow

The alpine terrain uses a Snowflow-inspired snow surface adapted to the existing Three.js/TSL ground material. It does not import Babylon.js, replace the expanded landscape terrain, or require a WebGPU-only rendering path. The implementation keeps the current terrain, Rapier collision, walkable snow routes, WebGPU/WebGL renderer selection, and cinematic lighting.

The design takes inspiration from the MIT-licensed `Noniv/snowflow_demo`: wind-shaped sastrugi, multi-scale surface detail, blue backscatter, grazing glints, accumulation controlled by terrain exposure, and a local persistent interaction field. No Snowflow runtime dependency or authored asset is copied into this repository.

## Alpine cirque

The summit is a purpose-built snowy cirque centered on `[-25, -655]`. The central basin stays above the full-snow elevation while an irregular ring of higher ridges surrounds it. The ring is broken into multiple peaks with angular variation rather than being a perfect circular crater, and the terrain blends back into the existing mountain field before leaving the alpine region.

`public/alpine.yaml` owns the basin height, rim dimensions, local terrain detail, treeline, route and local refinement budget. The alpine area receives one extra conforming subdivision pass so the steep silhouettes and snow/rock transitions do not expose the coarse five-metre world grid seen in the earlier summit screenshot. High trees are removed inside the configured alpine treeline, while lower forest outside the snow bowl remains intact.

The `Alpine Summit` teleport lands in the central snow basin. `Snow Peak` now lands on a high point of the surrounding rim, and the walkable alpine route connects Snow Pass, the basin and that rim peak.

## Accumulation

Snow coverage combines elevation, slope and prevailing-wind exposure. Lee-side drifts can accumulate lower than the nominal snow line while exposed faces are scoured. Steep faces retain the underlying rock treatment instead of becoming uniformly white.

<!-- effective-config: ground.snow -->
```yaml
altitude: { start: 84, full: 132 }
slope: { start: 0.34, full: 0.84 }
```

The same accumulation model has a CPU implementation used by the local footprint and powder systems, so interactions cannot appear on low grass or bare cliffs while the shader says there is no snow.

## Surface detail

The snow normal is assembled from world-space height-gradient style components before it is converted to the view-space normal used by the material. Wind-aligned sastrugi provide the largest local ridges, cross-wind ripples add medium detail, and a distance-faded grain layer handles the fine surface. Because the detail is generated in world space it does not inherit the stretched terrain UVs that would otherwise be visible on steep alpine faces.

The surface also uses restrained tonal modulation from the same sastrugi, ripple and exposure fields. This keeps broad snow from reading as a featureless white sheet under bright daytime lighting while preserving the physical normal response.

Close up, the procedural layers are joined by the Snow007C detail maps from ambientCG (CC0), stored web-sized under `public/Assets/ground/snow/`. The normal map is tiled at three scales, following Snowflow's snow material. Each scale fades out by the world-space size of the pixel, so grain exists only where it can be resolved and never shimmers. The layers are added as slopes onto the landform gradient. Trodden snow keeps less of its grain. The ambient-occlusion channel darkens grain crevices and shifts them blue as they darken, because a neutral darkening under a warm sun reads as tan rather than shaded snow. The roughness and colour maps vary the surface only around its configured tone. `ground.snow.detail.worldScale` converts Snowflow's tiling and fade distances to this world, where the rider is about 2.78 times taller.

Lighting reuses `foliageLight`, the same cinematic sun direction, colour and strength uniforms that the active environment preset updates. Two terms are ported from Snowflow's `lib/shading.wgsl` (MIT). The first is a back-scatter subsurface lobe: thin edges transmit brightly over a wide angle, deep snow only near straight-through, and trodden snow transmits less. The second is discrete glints: each world-space cell owns one jittered crystal facet, gated to grazing views of a low sun. Because facets are fixed to cells, glints stay in place as the camera moves.

## Local footprint field

A player-following RGBA `DataTexture` stores recent snow interaction in a 64 m window. The channels encode depression strength, displaced berm strength and a signed two-component normal perturbation. Only the local texture moves; the world terrain and collider are not rebuilt.

<!-- effective-config: ground.snow.deformation -->
```yaml
enabled: true
resolution: 512
worldSize: 64
minRadius: 0.16
maxRadius: 0.56
contactHeight: 0.75
recenterDistance: 8
decaySeconds: 120
bermDecaySeconds: 55
```

The field keeps its mapping origin stable while the player moves locally, then scrolls in whole texels after the player has moved eight metres from the field centre. This avoids a full 512-square buffer copy for every small movement while keeping stored tracks in the same world positions. Footprint painting is enabled only while the grounded character is moving, and an influence point must also be close enough to the terrain to count as foot contact. Free-fly and the scenic tour do not carve snow.

This integration deforms snow **visually** through color, roughness and normal response. It intentionally does not displace foot-scale terrain geometry: the expanded landscape terrain is much coarser than a footprint. True centimetre-scale silhouette deformation would require a dedicated near-player snow overlay or clipmap and should be treated as a separate feature rather than distorting the world terrain mesh.

## Powder and wind

The airborne snow follows the same principle as Snowflow's pooled spray: particles do not simply lose horizontal speed. Their horizontal velocity is pulled toward the configured prevailing wind, while vertical velocity converges on the configured terminal fall speed. Snow that reaches the surface settles and fades instead of falling through the terrain.

The same pooled draw call serves two emitters. Grounded foot contacts kick short-lived powder from the snow surface, while an ambient emitter creates near-ground spindrift around the active view. Both emitters use the CPU snow-coverage function, so lowlands and exposed rock do not create airborne snow. The ambient emitter follows the player, scenic-tour camera, or free-fly camera and therefore remains visible at alpine viewpoints even while the character is standing still.

The wind bearing is shared with the sastrugi and accumulation system through `ground.snow.wind.angleDegrees`. This keeps surface ridges, scouring, contact powder and ambient spindrift visually coherent rather than giving each feature a separate wind direction.

<!-- effective-config: ground.snow.powder -->
```yaml
enabled: true
capacity: 3000
particlesPerContact: 18
windSpeed: 3.2
terminalFallSpeed: 1.9
drag: 5.2
gravity: 9.81
ambient:
  enabled: true
  particlesPerSecond: 72
  radius: 20
```

## Snow-surf wake

Sprinting on snow surfs. The wake follows Snowflow's design: it is a swept mesh, not a particle effect. Its spine is the path the rider has taken, resampled every 30 cm (per 1.8 m of rider height) into a 96 x 3 float `DataTexture`. The mesh is a static lattice of (column, row, side), and `SnowWakeMaterial` places every vertex in the vertex shader. A long wake and a short one therefore cost the same buffer and the same 4.6 KB upload each frame.

The cross-section is a breaking wave integrated from a turning tangent. The tangent starts just below horizontal at the base. Its tip angle runs from 40 degrees, a low heaped bank, to 284 degrees, a lip that hangs back across its own face, and one curl parameter sets where between the two it lands. Wall height and curl are resolved per side from the carve, so the outside of a turn takes nearly all the snow. Carve is lateral acceleration, speed times yaw rate. The wall is tallest at a full-speed carve and collapses `lifeSeconds` after it is laid, so wake length is life x speed. The section, wall spread, lumps and erosion are ported from Snowflow's `lib/wake.wgsl` (MIT) into TSL. The two walls start close at the bow and spread behind it. Drifting gradient-noise lumps displace the wall along the section's own normal, weighted toward the free crest, and the lip shears back along the spine. Erosion softens only the top sixth of the section and dissolves the whole wall at the end of its life, so it never tears holes in a young wall. Normals are differenced out of the same `wakePoint` the geometry uses. Inside the barrel the concave side goes dark and blue, the thin lip transmits backlight, and the Snow007C normal map adds grain on two oblique projections.

Two spray populations come off the first few metres of the spine, emitted at fractional positions along it into the shared powder pool. A dense, slow curtain hugs the crest; ballistic grains and clods are flung clear, and a slower powder drift hangs over the trench. Emission uses the same wall heights and base spread as the mesh. Airborne snow is shaded after Snowflow's spray shader: each billboard is lit as a sphere, with a warm forward-scatter lobe when looking toward the sun. A loaded edge adds camera shake, and speed past the streak threshold adds screen-space speed streaks in the cinematic grade.

All wake lengths, heights and speeds are authored for a `referenceHeight` rider and scaled by the character's height. Spray velocities scale with the square root of that ratio, which keeps their arcs the same shape.

<!-- effective-config: ground.snow.wake -->
```yaml
capacity: 96
spineStep: 0.3
columns: 128
rows: 18
lifeSeconds: 0.88
maxHeight: 2.4
minSpeed: 2.2
fullSpeed: 4.3
```

## Performance

The persistent field is one 512 x 512 RGBA8 texture (1 MiB). Recovery runs at the configured interval rather than sweeping the array every render frame, and texture scrolling is amortized across eight metres of player travel. Snow surface rendering adds one local deformation texture sample plus procedural ALU to the ground material. Airborne snow uses one pooled instanced transparent draw call with a fixed capacity, no shadow pass and no per-frame object allocation. The extra terrain tessellation is restricted to the alpine region rather than increasing resolution across the full expanded landscape.

Visual review should cover Snow Pass, Snow Peak and Alpine Summit in sunny, golden-hour and rainy presets, plus WebGL 2. Verify that the summit reads as a snow basin surrounded by ridges, nearby high-altitude trees are gone, exposed cliffs remain rocky, sastrugi and airborne powder share one coherent wind direction, glints stay subtle, only contacting feet carve the surface, ambient spindrift stays close to snow, and old footprints soften rather than popping away.

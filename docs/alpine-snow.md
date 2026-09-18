# Alpine snow

The alpine terrain uses a Snowflow-inspired snow surface adapted to the existing Three.js/TSL ground material. It does not import Babylon.js, replace the expanded landscape terrain, or require a WebGPU-only rendering path. The implementation keeps the current terrain, Rapier collision, walkable snow routes, WebGPU/WebGL renderer selection, and cinematic lighting.

The design takes inspiration from the MIT-licensed `Noniv/snowflow_demo`: wind-shaped sastrugi, multi-scale surface detail, blue backscatter, grazing glints, accumulation controlled by terrain exposure, and a local persistent interaction field. No Snowflow runtime dependency or authored asset is copied into this repository.

## Alpine cirque

The summit is a purpose-built snowy cirque centered on `[-25, -655]`. The central basin stays above the full-snow elevation while an irregular ring of higher ridges surrounds it. The ring is broken into multiple peaks with angular variation rather than being a perfect circular crater, and the terrain blends back into the existing mountain field before leaving the alpine region.

The whole cirque, out to its outer blend radius (z -930), lies inside the terrain and the world bounds: the expanded terrain reaches z -1100 and the south boundary wall stands at z -960. The terrain used to stop at z -800 and the boundary at z -770, which cut through the south rim. From the basin that showed as a torn black wedge where the Snow Peak gorge ran off the end of the mesh, and the force field drew a cyan band along the rim.

The walls carry geological structure (`terrain.alpine.landform`), none of which reaches the walkable basin floor:

- **Couloirs and spurs** run straight down the fall line of both flanks, `spacing` metres apart around the ring and up to `amplitude` metres deep. The spurs' sides are steep enough to shed snow, so rock shows between snow-filled chutes.
- **Rock bands** step stretches of the upper walls into snow ledges and rock risers. Bed thickness varies around the ring, the bands tilt and pinch out (`tilt`), and only `coverage` of the wall carries them.
- **The crest** breaks into notches and pinnacles from ridged noise, instead of a rounded lip.

<!-- effective-config: terrain.alpine.landform -->
```yaml
couloirs: { amplitude: 14, spacing: 24 }
strata: { strength: 0.55, bandHeight: 12, coverage: 0.4 }
crest: { amplitude: 9 }
```

`public/alpine.yaml` owns the basin height, rim dimensions, local terrain detail, treeline, route and local refinement budget. The alpine area receives one extra conforming subdivision pass so the steep silhouettes and snow/rock transitions do not expose the coarse five-metre world grid seen in the earlier summit screenshot. High trees are removed inside the configured alpine treeline, while lower forest outside the snow bowl remains intact.

The `Alpine Summit` teleport lands in the central snow basin. `Snow Peak` is placed on the surrounding rim, and the walkable alpine route connects Snow Pass, the basin and that rim point. Where the graded routes cross the rim they run through terraced gorges (see [route gorges](#route-gorges)).

## Accumulation

Snow coverage combines elevation, slope and prevailing-wind exposure. Lee-side drifts can accumulate lower than the nominal snow line while exposed faces are scoured. Snow lies fully on ground gentler than about 33 degrees and not at all past about 63. `slope.noise` shifts both thresholds in patches tens of metres across (`snowSlopePatchCpu` and its GPU twin in `SnowSurface.js`), so rock breaks through a wall in places rather than along one contour of slope.

<!-- effective-config: ground.snow -->
```yaml
altitude: { start: 84, full: 132 }
slope: { start: 0.46, full: 0.84, noise: 0.12 }
```

Faces too steep to hold snow keep the rock treatment, darkened toward `rockTint` across the snow band. The tint is dark enough that exposed rock reads as a distinct value against snow and sky, rather than a pale grey that fades into both. Inside the band, patches of them and streaks down their fall line are glazed with water ice (`ground.snow.ice`): blue where it is thick, grey where thin rock shows through, and much glossier than the rock. The rock's fine normal detail is gradient noise; the product of sines it replaced printed a regular lattice of dimples down every steep face.

Snow on a walked route is packed (`ground.snow.path`): the route mask counts as compression, so the path is darker, bluer, smoother and less grainy than the loose snow beside it, with the same response footprints get. The compaction is strong enough to read as a trail from a distance, so the route shows the way without relying on the stones beside it.

Nothing grows through lying snow. Grass density, meadow details and broadleaf trees are gated by the CPU coverage rather than by height alone, because drifts reach well below the nominal snow line in the gorges. Path decoration keeps its stones but drops leaf litter on snow, and snow-laden conifers take the place of broadleaf trees on snowy ground below the tree line.

The same accumulation model has a CPU implementation used by the local footprint and powder systems, so interactions cannot appear on low grass or bare cliffs while the shader says there is no snow.

## Surface detail

The snow normal is built the way Snowflow's snow material builds it. The landform, the fine relief and carved footprints are all heightfield slopes, so they add as slopes before becoming a normal; only the detail map is a tangent-space normal, folded in last.

The fine relief is a TSL port of Snowflow's `terrainFineFiltered` (`lib/terrain.wgsl` and `lib/noise.wgsl`, MIT) in `snowNoiseNodes.js`: gradient noise with analytic derivatives, three octaves of ridged noise for the sastrugi, transverse wind ripples and grain. Sastrugi are compressed across the wind so their crests streak along it, and the wind veers across the field so the ridges break into patches instead of reading as corduroy. Slopes facing into the wind, and the crests of the large exposure pattern, are scoured into hard sastrugi; lee slopes and hollows keep their ripples (`relief.windward`). Everything is evaluated in Snowflow metres, so heights scale with `detail.worldScale` and slopes carry over unchanged. Each layer fades out as its wavelength approaches the pixel footprint. The fades start 1.6 times earlier than Snowflow's, because Snowflow resolves the remaining sub-pixel relief with TAA and TAA is off by default here. The relief also fades out on slopes too steep for lying snow, where a planar projection would only smear it into vertical streaks. Pixels without snow skip the relief entirely, so it costs nothing outside snow country.

Ripples form in fields about 33 Snowflow metres (92 m) across rather than corrugating every sheltered flat. Laid evenly, they printed a repeating corduroy under the camera.

Fresh snow is not wind-worked everywhere. Broad patches of wind-sheltered powder (`ground.snow.calm`), about `scale` metres across and covering about `coverage` of the snow, lie smooth and even: there the fine relief drops to `relief` and the detail normals, crevice occlusion and colour mottling to `detail` of their strength. Faces turned into the wind are never calm. The busy grain stays on the wind-worked snow between the patches, on packed routes and on scoured crests.

<!-- effective-config: ground.snow.calm -->
```yaml
scale: 34
coverage: 0.5
relief: 0.25
detail: 0.45
```

Crests brighten and troughs darken slightly with the relief height (`relief.toneContrast`), and wind-packed crests are a little smoother than the loose snow in the troughs.

Close up, the relief is joined by the Snow007C detail maps from ambientCG (CC0), stored web-sized under `public/Assets/ground/snow/`. The normal map is tiled at Snowflow's three scales and combined with reoriented normal mapping, each scale cross-faded out by the pixel footprint so grain only exists where it resolves. Snow007C's normals are much shallower than Snowflow's generated grain map (about 8 degrees of tilt against about 30), so `detail.strength` sits well above one. On steep snow the two coarser scales go triplanar, sampled with explicit gradients so only steep pixels pay for the extra projections. The tangent frame follows the planar projection, so the relief lights up the same way as the crevices baked into the maps. Trodden snow keeps less of its grain.

Crevice occlusion combines the ambient-occlusion and displacement channels at the grain and broad scales. It is normalised to a mean of one, so hollows darken and crests lift without the whole field darkening toward the camera as layers fade in. It darkens toward blue, because a neutral darkening under a warm sun reads as tan rather than shaded snow. The roughness and colour maps vary the surface only around its configured tone. `ground.snow.detail.worldScale` converts Snowflow's tiling and fade distances to this world, where the rider is about 2.78 times taller.

<!-- effective-config: ground.snow -->
```yaml
relief: { sastrugi: 1, ripples: 0.7, grain: 1, windward: 0.6, toneContrast: 0.06 }
detail: { worldScale: 2.78, strength: 2.4, cavity: 0.8 }
```

Lighting reuses `foliageLight`, the same cinematic sun direction, colour and strength uniforms that the active environment preset updates. Two terms are ported from Snowflow's `lib/shading.wgsl` (MIT). The first is a back-scatter subsurface lobe: thin edges transmit brightly over a wide angle, deep snow only near straight-through, and trodden snow transmits less. The second is discrete glints: each world-space cell owns one jittered crystal facet, gated to grazing views of a low sun. Because facets are fixed to cells, glints stay in place as the camera moves.

## Snow-country light

Snowflow's look rests on a low, warm sun raking across the snow under a cool, hazy sky. The presets are lit for the meadow, and under their high sun and green ground bounce even strong relief reads as a flat white sheet. `SnowAtmosphere.js` blends the active preset toward snow-country light by the ground height under the view (the player, or the camera while touring or free-flying), between `startHeight` and `fullHeight`:

- The sun is lowered to `sunElevationDegrees` without turning it, and is never raised if the preset's sun is already lower. The sky disc follows it. The sun is warmed slightly (`sunWarmth`) and strengthened (`sunIntensityScale`) against a sky that no longer has meadow under it.
- The hemisphere ground light becomes snow bounce: the preset's sky light with some of the sun in it (`sunBounce`), rather than green meadow. Sky, ambient and environment light are cooled and reduced so the sun carves the relief.
- Fog is desaturated, tinted cold and thickened. The horizon and zenith lose saturation, and the zenith takes some haze.
- Exposure and screen-space AO are scaled. A snowfield is the worst case for GTAO: open, smooth and bright, so most of what it returns is its own view-dependent bias.

The haze is kept thin and cool enough that the cirque walls 150 to 250 m away keep their rock bands and read as blue-grey against a lighter sky. Thicker, warmer haze washed every layer to the same pale beige.

Mist lies in the valleys and gorges (`atmosphere.valleyFog`, `src/rendering/valleyFog.js`). The preset haze thickens evenly with distance, so on its own it washes every wall alike and cannot settle in a gorge. The valley mist is a second absorber in the same fog node. Its density falls off exponentially with height above the local terrain (`height`) and is gone by `ceiling`, so it pools on gorge floors and in the valleys below the view while crests stand clear. Because the terrain under a view ray varies too much for a closed form, the density is marched along the ray in `samples` steps over at most `maxDistance`, reading the terrain heightfield at each step. Drifting noise, carried on the snow wind and sampled in the air rather than on surfaces, gathers it into banks (`pocketStrength`). The first metres of every ray stay clear (`nearClear`), so a wall beside the camera is not washed out. Sunlit mist scatters forward toward the low sun, a Henyey-Greenstein lobe (`scatter`, `sunScatter`), and falls to a cool shade (`shadeColor`) away from it. It scales with the snow-country weight and the march is skipped below it, so the lowlands pay nothing. In the gorge it costs about 0.2 ms of GPU time at 1600 x 780 on an RTX 4080.

<!-- effective-config: ground.snow.atmosphere.valleyFog -->
```yaml
density: 0.0055
height: 9
ceiling: 70
samples: 6
```

Everything is relative to the preset, so a moonlit or rainy summit stays moonlit or rainy. The blend eases at `fadeRate` while walking, so climbing to the snow line brings the light down over many seconds; a jump further than `snapDistance`, such as a teleport, snaps instead of sweeping the sun. `EnvironmentController.lighting` exposes the blended light, and the water reads its sun from it.

<!-- effective-config: ground.snow.atmosphere -->
```yaml
enabled: true
startHeight: 95
fullHeight: 140
snapDistance: 40
sunElevationDegrees: 15
sunIntensityScale: 1.7
exposureScale: 0.9
occlusionScale: 0.3
```

Sastrugi streak along the wind, and a sun raking straight down the ridges lights both flanks alike, so the relief reads as flat. Snowflow therefore holds the wind 70 to 80 degrees from the sun bearing. `ground.snow.wind.angleDegrees` is 150, about 76 degrees from the goldenHour sun, and well away from most preset suns.

<!-- effective: ground.snow.wind.angleDegrees = 150 -->

Exposed rock across the snow altitude band is multiplied by `ground.snow.rockTint`, so cliffs read as dark, cool alpine rock against the snow rather than warm meadow stone. The rock grain is gradient noise with height folded into both axes; the earlier product of sines printed a lattice of dots down every cliff face. Up in snow country the river reflects the live sky instead of the cube probe captured at the lake, which had put a green meadow in the headwaters, and its colour runs cold.

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
particlesPerContact: 10
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

Sprinting on snow raises a low, translucent powder plume. The wake follows Snowflow's design: it is a swept mesh, not a particle effect. Its spine is the path the rider has taken, resampled every 30 cm (per 1.8 m of rider height) into a 96 x 3 float `DataTexture`. The mesh is a static lattice of (column, row, side), and `SnowWakeMaterial` places every vertex in the vertex shader. A long wake and a short one therefore cost the same buffer and the same 4.6 KB upload each frame.

The cross-section is a breaking wave integrated from a turning tangent. The tangent starts just below horizontal at the base. Its tip angle runs from 40 degrees, a low heaped bank, to 284 degrees, a lip that hangs back across its own face, and one curl parameter sets where between the two it lands. Wall height and curl are resolved per side from the carve, so the outside of a turn takes nearly all the snow. Carve is lateral acceleration, speed times yaw rate. The wall is tallest at a full-speed carve and collapses `lifeSeconds` after it is laid, so wake length is life x speed. The section, wall spread, lumps and erosion are ported from Snowflow's `lib/wake.wgsl` (MIT) into TSL. The two walls start close at the bow and spread behind it. Drifting gradient-noise lumps displace the wall along the section's own normal, weighted toward the free crest, and the lip shears back along the spine. Erosion blends across a configurable alpha band, widened by pixel derivatives for fine detail. Smooth envelopes fade the base, bow, crest and tail; the sheet blends in one transparent pass with no depth writes or opaque cast shadow. Normals are differenced out of the same `wakePoint` the geometry uses. Inside the barrel the concave side takes a soft blue shade, the thin lip transmits backlight, and the Snow007C normal map adds grain on two oblique projections.

Two spray populations come off the first few metres of the spine, emitted at fractional positions along it into the shared powder pool. A sparse, slow curtain hugs the low crest; ballistic grains and clods are flung clear, and a slower powder drift hangs over the trench. Emission uses the same wall heights and base spread as the mesh. Airborne snow is shaded after Snowflow's spray shader: each billboard is lit as a sphere, with a warm forward-scatter lobe when looking toward the sun. A loaded edge adds restrained camera shake, and speed past the streak threshold adds faint screen-space speed streaks in the cinematic grade.

Particles ease in over 60 ms and dissipate through per-instance alpha rather than shrinking into solid dots. Their soft radial edges and slow size growth remain visible throughout the fade. The same fade applies to contact snow, ambient spindrift and sand kicks.

All wake lengths, heights and speeds are authored for a `referenceHeight` rider and scaled by the character's height. Spray velocities scale with the square root of that ratio, which keeps their arcs the same shape.

<!-- effective-config: ground.snow.wake -->
```yaml
capacity: 96
spineStep: 0.3
columns: 128
rows: 18
lifeSeconds: 0.65
maxHeight: 0.65
opacity: 0.42
alphaSoftness: 0.2
minSpeed: 2.2
fullSpeed: 4.3
```

## Snowfall

It snows where there is snow on the ground. `SnowfallSystem` is one instanced, GPU-animated flake field that follows the view, built like the rain system, but its intensity is not a weather preset value: each frame it samples the CPU snow coverage under the focus point (the player, or the camera while touring or free-flying) and ramps between `minCoverage` and `fullCoverage`. Walking up into the snow line fades the snowfall in, and the lowlands and the coast stay clear whatever the weather.

The ramp is eased with `fadeRate`, so crossing a bare ridge does not switch the weather on and off. Flakes drift on the same `ground.snow.wind.angleDegrees` the sastrugi, scouring and powder use, each on its own sway phase. They fade out within `nearFade` of the camera and are whole at three times that distance, so a flake crossing the lens never swells into a disc. Each flake fully faces the camera; an upright rain-style billboard turns edge-on seen from above. Flakes are lit by the same `foliageLight` uniforms as the rest of the snow, so they go grey at dusk rather than glowing.

<!-- effective: ground.snow.snowfall.nearFade = 4 -->

The field holds three flake populations in contiguous instance ranges of the one draw call (`snowfall.layers`): fine snow spread over a wide column to fill the distance, medium flakes around the player, and about one flake in a hundred large, dim and out of focus, allowed closer to the lens. All of them ride one wind. Gusts vary its speed (`gust`); the column drifts by the integral of that speed, so a gust never makes the wrapped field jump. Each flake also swirls across the wind with height (`turbulence`), so the fall does not read as a grid of dots sliding sideways.

<!-- effective-config: ground.snow.snowfall -->
```yaml
enabled: true
count: 12000
area: 70
speed: 3.4
minCoverage: 0.2
fullCoverage: 0.7
```

The field is one transparent instanced draw call with no shadow pass, and it is hidden entirely while the intensity is near zero, so it costs nothing outside the alpine region.

## Performance

The persistent field is one 512 x 512 RGBA8 texture (1 MiB). Recovery runs at the configured interval rather than sweeping the array every render frame, and texture scrolling is amortized across eight metres of player travel. On every ground pixel, snow shading adds one deformation texture sample, six Snow007C samples and the heightfield normal sample. The procedural relief, about seven gradient-noise evaluations, runs only where there is snow. The triplanar detail samples run only on steep snow. Airborne snow uses one pooled instanced transparent draw call with a fixed capacity, no shadow pass and no per-frame object allocation. The extra terrain tessellation is restricted to the alpine region rather than increasing resolution across the full expanded landscape. The snow-country blend runs on the CPU once per frame: a single terrain height sample, and a light update only while the weight changes.

Visual review should cover Snow Pass, Snow Peak and Alpine Summit in sunny, golden-hour and rainy presets, plus WebGL 2. Look toward, across and away from the sun. Verify that the summit reads as a snow basin surrounded by ridges, nearby high-altitude trees are gone, exposed cliffs remain rocky, sastrugi and airborne powder share one coherent wind direction, glints stay subtle, only contacting feet carve the surface, ambient spindrift stays close to snow, and old footprints soften rather than popping away.

## Route gorges

Walkable routes are graded into the terrain (`maxGrade`), and the ridges around the cirque are steeper than any walkable grade. Snow climb runs up to 114 m below the crest near `[-155, -561]`; the alpine cirque route runs 73 m below it at Snow Pass and 64 m at Snow Peak. With the plain `terrainWidth` blend those cuts were sheer slots, their 100 m walls drawn as a few stretched triangles each.

A route with a `cut` profile shapes those cuts as gorges instead (`LandscapePaths`). Past a flat floor of `floorWidth`, the wall rises at a mean `slope` through a quadratic `toe`, never above the natural terrain; where the route runs above the terrain, fill falls away at `fillSlope`. Along the route the mean slope varies by `slopeVariation`. Gullies and spurs, keyed to distance along the route and to the side, push the wall in and out by up to `meander` metres down its fall line. In patches the wall steps into benches about `benchHeight` apart. The benches hold snow and the risers are too steep for it, so the walls alternate snow shelves with rock and ice. Bench height and phase drift with position, so ledges tilt, pinch out at gullies and stop instead of stacking as contours. The rim where a wall meets the natural slope is rounded, and the rounding grows with the wall so the floor stays exact. Each cut segment looks laterally for terrain above its lowest possible wall, and shapes nothing beyond that reach.

<!-- effective-config: terrain.alpine.route.cut -->
```yaml
floorWidth: 13
slope: 1.8
benchHeight: 10
```

In the alpine region, triangles spanning more than 4.5 m of height get one extra subdivision after the regular alpine pass, which keeps the risers and crests from turning into sawteeth on the grid. That adds about 24,000 vertices to the terrain.

# Alpine snow

The alpine terrain uses a Snowflow-inspired snow surface adapted to the existing Three.js/TSL ground material. It does not import Babylon.js, replace the expanded landscape terrain, or require a WebGPU-only rendering path. The implementation keeps the current terrain, Rapier collision, walkable snow routes, WebGPU/WebGL renderer selection, and cinematic lighting.

The design takes inspiration from the MIT-licensed `Noniv/snowflow_demo`: wind-shaped sastrugi, multi-scale surface detail, blue backscatter, grazing glints, accumulation controlled by terrain exposure, and a local persistent interaction field. No Snowflow runtime dependency or authored asset is copied into this repository.

## Accumulation

Snow coverage combines elevation, slope and prevailing-wind exposure. Lee-side drifts can accumulate lower than the nominal snow line while exposed faces are scoured. Steep faces retain the underlying rock treatment instead of becoming uniformly white.

<!-- effective-config: ground.snow -->
```yaml
altitude: { start: 92, full: 142 }
slope: { start: 0.42, full: 0.78 }
```

The same accumulation model has a CPU implementation used by the local footprint and powder systems, so interactions cannot appear on low grass or bare cliffs while the shader says there is no snow.

## Surface detail

The snow normal is assembled from world-space height-gradient style components before it is converted to the view-space normal used by the material. Wind-aligned sastrugi provide the largest local ridges, cross-wind ripples add medium detail, and a distance-faded grain layer handles the fine surface. Because the detail is generated in world space it does not inherit the stretched terrain UVs that would otherwise be visible on steep alpine faces.

Lighting reuses `foliageLight`, the same cinematic sun direction/color/strength uniforms already updated from the active environment preset. The snow adds restrained blue backscatter and sparse view-dependent glints without creating another lighting state.

## Local footprint field

A player-following RGBA `DataTexture` stores recent snow interaction in a 64 m window. The channels encode depression strength, displaced berm strength and a signed two-component normal perturbation. Only the local texture moves; the world terrain and collider are not rebuilt.

<!-- effective-config: ground.snow.deformation -->
```yaml
enabled: true
resolution: 512
worldSize: 64
minRadius: 0.16
maxRadius: 0.42
contactHeight: 0.75
recenterDistance: 8
decaySeconds: 90
bermDecaySeconds: 45
```

The field keeps its mapping origin stable while the player moves locally, then scrolls in whole texels after the player has moved eight metres from the field centre. This avoids a full 512-square buffer copy for every small movement while keeping stored tracks in the same world positions. Footprint painting is enabled only while the grounded character is moving, and an influence point must also be close enough to the terrain to count as foot contact. Free-fly and the scenic tour do not carve snow.

This integration deforms snow **visually** through color, roughness and normal response. It intentionally does not displace foot-scale terrain geometry: the expanded landscape terrain is much coarser than a footprint. True centimetre-scale silhouette deformation would require a dedicated near-player snow overlay or clipmap and should be treated as a separate feature rather than distorting the world terrain mesh.

## Contact powder

Grounded foot contacts also emit short-lived local powder bursts. The powder system uses the same CPU snow-coverage test as the deformation field, so bare rock and low terrain do not produce snow particles. Walking emits restrained puffs while running scales the burst count. Particles are pooled in one instanced draw call and use a generated soft radial texture; no external particle asset is required.

<!-- effective-config: ground.snow.powder -->
```yaml
enabled: true
capacity: 144
particlesPerContact: 8
runningMultiplier: 1.75
emitDistance: 0.16
lifetimeMin: 0.45
lifetimeMax: 0.95
sizeMin: 0.12
sizeMax: 0.34
```

## Performance

The persistent field is one 512 x 512 RGBA8 texture (1 MiB). Recovery runs at the configured interval rather than sweeping the array every render frame, and texture scrolling is amortized across eight metres of player travel. Snow surface rendering adds one local deformation texture sample plus procedural ALU to the ground material. Contact powder adds one pooled instanced transparent draw call only when snow powder is enabled; it has no shadow pass and a fixed particle budget.

Visual review should cover Snow Pass and Snow Peak in sunny, golden-hour and rainy presets, plus WebGL 2. Verify that exposed cliffs remain rocky, sastrugi follow one coherent wind direction, glints stay subtle, only contacting feet carve the surface and kick powder, and old footprints soften rather than popping away.

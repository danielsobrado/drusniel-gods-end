# Cinematic rendering

`public/cinematic-look.yaml` is the final art-direction layer before painter settings. The default Golden Hour treatment combines muted green grass, warm directional light, a cool sky fill, low-lying mist, and a restrained post-processing stack. This is an intentional visual departure from the recovered reference; old parity screenshots are historical evidence, not acceptance criteria for this pass.

## Rendering and quality

The active GrassDemo owns CinematicLighting, CinematicPipeline, MeadowDetails, and ScenicTour. The default uses one compact 110-unit shadow region. Setting `cinematic.shadows.cascades` above one enables practical, fading cascades on WebGPU desktop over the configured distance. CSM is initialized with the gameplay camera before any reflection is captured. Resizing refreshes its frustums.

The scene uses exponential height-dependent fog whose color and density follow the active weather. Grass and tree leaves receive a small directional transmission approximation; it follows the sun's direction, color and intensity. It is an artistic approximation rather than full subsurface scattering.

The post-processing graph adds half-resolution GTAO, restrained bloom, saturation adjustment, a light vignette, and FXAA. Performance quality bypasses AO and bloom. Balanced reduces AO strength and halves reflection refresh frequency. GTAO affects shading; visibility culling is separate.

### Grass visibility and LOD

Configured blade densities are unchanged. Cinematic LODs use deterministic nested placement: every surviving stem keeps its position, rotation, color and wind phase. Individual stems shrink into their roots across a distance band before switching to a lower-density LOD. This replaces alpha-hashed crossfades of two overlapping 25-unit square meshes. Moving across a tile boundary recycles only the outgoing row or column.

Each tile compacts stems that the existing path/terrain mask already hides, using linear-filtered mask samples rather than an unrelated empty-tile grid. Cached buffers keep the original stem IDs. Painting invalidates those buffers; quality/type changes dispose them. No global density or grass-distance reduction is used to lower submitted geometry.

Detailed trees now use per-camera frustum culling with padded canopy bounds. Grass uses tile frustum/distance culling and mask compaction. There is no general occlusion-query or GPU Hi-Z system. A conservative CPU terrain-depth prototype was measured across 28 ground-level views: roughly 2 ms per camera update, with no extra tiles culled in 27 views. It was removed because its cost outweighed the benefit in this open landscape. Grass casts no shadows and is omitted from the coarse reflection probe, so main-view culling cannot remove shadow casters or reflected trees.

A fixed-camera Ultra check at `[123.44, 2.66, 32.04]`, 1440 by 900, compared tree frustum culling and mask compaction disabled/enabled. Submissions fell from 4,011,895 to 2,411,463 (40%). The optimized frame comprised 2,168,672 main-view triangles, 242,776 shadow triangles and 15 post-processing triangles. Grass accounted for 1,831,054 main-view triangles; compaction removed 36,644 already-masked stems. A separate six-face reflection refresh submitted about 1.41M triangles. These are one-view submission counts, not GPU timings or a universal frame-rate guarantee.

## Materials and vegetation

Ground shading consumes the YAML texture scales and metalness, supports DirectX normal-map Y inversion, adds broad color variation and moss tint, and blends wet shoreline/rain roughness. The material remains nonmetallic when wet.

MeadowDetails builds six instanced geometry groups: flowers, seed heads, ferns, reeds, leaf litter and small stones. Placement is seeded by world cell and filtered by terrain slope, grass mask, nearby tree cells and water elevation. No additional textures or downloaded assets are required. The outer ring scales out over 18 units. Quality controls candidates per cell; movement only rebuilds placement when entering a new 12-unit cell. The terrain grid is an approximation for small detail placement, not collision geometry.

Grass retains the authored mask and interaction system. Continuous world-space height patches replace abrupt changes in height at the detail-distance threshold. Existing tree LOD transitions remain in use. The cloud plane follows the camera and fades at its edges and toward the horizon, hiding its finite outline.

## Character and camera

The supplied Warden GLB contains one running clip. Runtime-generated quaternion clips provide a breathing idle and a walking cycle on its named rig. Authored idle/walk clips take priority when supplied. The original running animation remains unchanged. Playback rate follows locomotion speed; bounded two-joint foot placement adjusts planted feet to sampled terrain while leaving raised and airborne feet alone. The generated clips are a fallback, not motion capture, and the cloak is still skinned rather than cloth-simulated.

Camera framing and movement speed are expressed relative to visible model height instead of the GLB's import scale. The character initially faces into the scene. Existing mouse look, zoom, collision, grass painting and mobile controls remain available.

## Water and tour

Water uses the same high-resolution, half-float terrain height texture as grass for shallow transparency and depth color, sun highlights that follow weather, and six expanding movement ripples. A 256-pixel cube reflection is captured once after gameplay-camera shader compilation, then refreshed near the lake every 0.75 seconds (1.5 seconds on Balanced). Its position stays fixed at the lake so walking does not move the probe in discrete jumps. Main-view grass and small meadow details are excluded, and the six faces reuse the existing shadow map. Performance retains its initial reflection. This is a local cubemap approximation, not a planar or screen-space reflection.

The 30-second scenic tour follows a terrain-cleared camera spline from the player's position, through a nearby grove, to a sampled shore. It hides and pauses the character, then restores the saved view. Escape, movement keys, the tour button, or opening the painter ends it. This is a camera tour; it does not teleport the player or add an authored navigation path.

Scene settings start collapsed. H hides/restores the HUD. Settings retain all weather, quality, grass-type, interaction, and painting controls.

## Verification

Run `npm run lint`, `npm test`, `npm run check:docs`, and `npm run build`. Cinematic tests compare rasterized terrain heights with downward raycasts across rotated and overlapping surfaces, check face culling, verify animation-loop seams and untouched bind poses, and check that foot placement reduces ground error.

Visibility regression tests check nested LOD identities, unchanged configured counts, exact survivor IDs after path compaction, and filtered mask boundaries. `window.__grassDemo` is available only in development; `grass.stats` reports visible tiles and submitted/masked stems. The renderer's triangle counter counts submitted triangles, including shadow/reflection passes, not unique visible triangles. Four million submissions alone is not a frame-time budget or evidence of a bottleneck.

The cinematic terrain sampler projects each triangle into the height grid, avoiding a complete mesh raycast for every grid cell. The legacy sampler remains available when cinematic rendering is disabled. This only changes sampled heights; Rapier continues to use the terrain mesh for collisions.

Visual acceptance requires browser captures of the opening, walking, the shore, weather transitions, quality switches, both grass types, the painter and a mobile viewport. Frame rates depend on device, viewport, pixel ratio and selected quality; a local measurement is not a universal performance guarantee.

# Cinematic rendering

`public/cinematic-look.yaml` is the final art-direction layer before painter settings. The default Golden Hour treatment is a stylized adventure landscape: emerald grass with pale sunlit tips, warm sunlight, blue sky and distance haze, turquoise water, and broad soft cloud shapes. This is an intentional visual departure from the recovered reference; old parity screenshots are historical evidence, not acceptance criteria for this pass.

`cinematic.style` preserves grass counts, placement, LOD thresholds and draw distances. `MeadowPalette.js` shares the active blade preset's root/tip uniforms between terrain and both grass renderers, including weather transitions. `meadowPatchScale` controls broad, smooth world-space patches; grass samples these at its stationary root so wind and LOD changes cannot move the pigment. `groundTipMix` blends a little tip color into the common root/ground color. The old independent `groundGrass` tint is replaced by this shared palette; `groundPath` still colors the paths.

Styled terrain uses the same world-space mask projection and vertical orientation as grass. After grass loads, terrain borrows its live authoring texture so painting updates the soil/turf blend too. The raw mask retains soft edges; vegetation still uses its separate clearance/cutoff policy. This corrects the previous mirrored ground/path alignment without altering any planted blades.

`grassRootBrightness` supplies subtle root shading, while `grassGradientPower` keeps richer green through the blade and confines pale color toward the tip. `grassFill` gives terrain and grass the same small weather-sensitive ambient fill. `grassBacklight` controls directional transmission near the tips, replacing the constant white grazing-angle sheen in the styled grass. Grass normals sample terrain slope at the root, vary toward the tip, and are transformed into view space for Three's lighting. This costs four cached height-texture samples per vertex; no extra render pass or triangles are added.

`bladeWidthScale` narrows the existing blade template, with extra taper and per-blade width variation. `bladeCurve` adds a small quadratic rest curve before the existing wind deformation. Billboard cards retain their atlas silhouette but use the shared palette and slope lighting. The grass `sheen` control adds to directional transmission in this style. `foliageFill` continues to control the understory and tree bounce light. Detailed leaves and tree billboards use the same `canopyShadow`, `canopyLight` and `canopyTint` mapping. Set `cinematic.style.enabled: false` to bypass these treatments; the authored lighting and water settings remain independently adjustable.

## Rendering and quality

The active GrassDemo owns CinematicLighting, CinematicPipeline, MeadowDetails, and ScenicTour. The default uses one compact 110-unit shadow region. Setting `cinematic.shadows.cascades` above one enables practical, fading cascades on WebGPU desktop over the configured distance. CSM is initialized with the gameplay camera before any reflection is captured. Resizing refreshes its frustums.

The scene uses exponential height-dependent fog whose color and density follow the active weather. At long range its color converges to the same directional sky gradient, so fully obscured background mountains do not leave a flat polygon silhouette. The cinematic sky horizon starts at the weather's mist color. Sky centering updates world matrices immediately, including parented reflection cameras. Grass and tree leaves receive a small directional transmission approximation; it follows the sun's direction, color and intensity. It is an artistic approximation rather than full subsurface scattering.

The separate `Landscape046` backdrop fades in dense fog without writing depth, allowing clouds through after the hills are obscured. The walkable terrain retains opaque depth. Wind noise declares its scalar return type to prevent repeated nested type inference when the first reflection encounters additional tree materials.

The post-processing graph adds half-resolution GTAO, restrained bloom, saturation adjustment, a light vignette, and FXAA. Performance quality bypasses AO and bloom. Balanced reduces AO strength and halves reflection refresh frequency. GTAO affects shading; visibility culling is separate.

### Grass visibility and LOD

Configured blade densities are unchanged. Cinematic LODs use deterministic nested placement: every surviving stem keeps its position, rotation, color and wind phase. Individual stems shrink into their roots across a distance band before switching to a lower-density LOD. This replaces alpha-hashed crossfades of two overlapping 25-unit square meshes. Moving across a tile boundary recycles only the outgoing row or column.

Each tile compacts stems that the existing path/terrain mask already hides, using linear-filtered mask samples rather than an unrelated empty-tile grid. Cached buffers keep the original stem IDs. Painting invalidates those buffers; quality/type changes dispose them. No global density or grass-distance reduction is used to lower submitted geometry.

Detailed trees use per-camera frustum culling with padded canopy bounds. Grass uses tile frustum/distance culling and mask compaction. General GPU occlusion follows those filters; the previous CPU terrain-depth prototype remains removed.

### GPU occlusion

`GpuOcclusion` renders visible solid occluders into a separate full-resolution depth target, builds a maximum-depth mip pyramid on the GPU, and tests conservative projected object bounds against it. A compute pass writes indexed/non-indexed indirect draw arguments. Hidden objects get zero instances before the main view draws **in the same frame**. CPU readback is used only for statistics and deciding whether an open view merits another occlusion pass; object visibility never depends on an old-frame readback.

The WebGPU bridge is isolated in `src/rendering/GpuOcclusion.js` and targets the installed Three r180 backend's depth texture and indirect-buffer APIs. It installs arguments only at backend draw submission, after material nodes update shadows, and immediately restores shared geometry. Shadows, reflection cameras and depth passes use ordinary draws. The WebGL fallback bypasses this system. General culling operates per mesh/material group or instanced batch, not per individual triangle or tree billboard instance. Unknown skinning, morph and shader deformation stay visible unless a current world-space `userData.occlusionBounds` is supplied. Known tree wind uses padded local bounds (`occlusionPadding`); grass tiles publish their terrain/wind bounds every update and remain independent of recycled pool identities.

Transparent surfaces, alpha-tested/hashed foliage and unknown shader-deformed surfaces never serve as solid occluders. Camera/near-plane intersections bypass culling; bounds are rounded outwards with a two-pixel guard and a depth bias. The depth pyramid retains uncovered pixels, including padded non-power-of-two edges, at the far plane. Painting bypasses GPU culling. No configured blade density is reduced.

Controls are under `cinematic.occlusion` in `public/cinematic-look.yaml`: `enabled`, `minTriangles` (candidate cost), `minOccluderArea` (fraction of the screen), `boundsPadding` (world units), `pixelPadding`, and `depthBias`. Open landscapes may hide little geometry, so results below `minSavedTriangles` (25,000 by default) trigger a `probeInterval` of 30 frames. Intermediate frames render normally rather than repeatedly paying for an unproductive depth pass. Set `minSavedTriangles: 0` to profile continuous culling. This is a triangle-saving heuristic, not a GPU-time budget; occlusion is not guaranteed to improve every view.

The HUD's `GPU CULLED` counter is a recent asynchronous main-view sample, zero during backoff. `TRIS` remains Three's submitted count, including occluder depth, shadows and reflections; Three does not subtract zero-instance GPU indirect results. Use GPU timing, not that submission count alone, to assess performance.

A fixed-camera check at `[123, 1, 32]` looking toward `[60, 4, 40]` rejected 14 draws / 82,784 triangles. The enabled/disabled beauty buffers matched across all 4,636,736 half-float channels, with no GPU validation errors. Two open lake-facing views rejected no objects. The additional depth pass submitted roughly 49–51k triangles in those three views; short timing samples did not establish a consistent frame-time improvement. These measurements motivate the open-view backoff and are not a blanket performance claim.

A fixed-camera Ultra check at `[123.44, 2.66, 32.04]`, 1440 by 900, compared tree frustum culling and mask compaction disabled/enabled. Submissions fell from 4,011,895 to 2,411,463 (40%). The optimized frame comprised 2,168,672 main-view triangles, 242,776 shadow triangles and 15 post-processing triangles. Grass accounted for 1,831,054 main-view triangles; compaction removed 36,644 already-masked stems. A separate six-face reflection refresh submitted about 1.41M triangles. These are one-view submission counts, not GPU timings or a universal frame-rate guarantee.

## Materials and vegetation

Ground shading consumes the YAML texture scales and metalness, supports DirectX normal-map Y inversion, adds broad color variation and moss tint, and blends wet shoreline/rain roughness. The material remains nonmetallic when wet.

MeadowDetails builds six instanced geometry groups: flowers, seed heads, ferns, reeds, leaf litter and small stones. Placement is seeded by world cell and filtered by terrain slope, grass mask, nearby tree cells and water elevation. No additional textures or downloaded assets are required. The outer ring scales out over 18 units. Quality controls candidates per cell; movement only rebuilds placement when entering a new 12-unit cell. The terrain grid is an approximation for small detail placement, not collision geometry.

`MeadowGeometry.js` supplies folded, curved leaves with root-to-tip vertex colors, seven arching fern fronds with paired leaflets, three-blossom wildflowers with sepals and stamens, branching seed panicles, three-stem cattail clumps, curled leaf litter and moss-tinted stones. Width and height vary independently per instance. Geometry costs per clump are fern 896, flower 468, seed 438, reed 270, litter 96 and stone 80 triangles; these are opaque surfaces rather than alpha cards. At the opening position on Ultra, the generated batches contain 436,986 triangles before view culling. This is a placement sample, not a GPU timing or total scene budget. Grass density and candidate placement are unchanged.

Understory uses the configured vegetation `patchScale` and `backlight`, plus the adventure palette's weather-sensitive foliage fill. Whole-batch frustum bounds are rebuilt after relocation and padded for the maximum shader wind displacement. The complete animated shape scales away at the outer ring, including its wind offset. These bounds enable frustum culling; they do not add per-plant GPU occlusion or geometry LOD.

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

GPU regression checks run at `/scripts/gpu/occlusion-check.html` on the Vite development server. They exercise the actual WebGPU depth/compute/indirect path, compare enabled/disabled images pixel-for-pixel, and check camera cuts, transparency/cutouts, moving instanced batches, animation bounds, near-plane intersections, resizing, and GTAO compilation. The beauty pass explicitly uses single-sample depth: Three r180's GTAO normal reconstruction emits an invalid mip-level lookup for multisampled depth. FXAA still runs on the final image. `window.__occlusionCheck` resolves to the machine-readable result. Node tests cover draw groups and instance counts, conservative occluder eligibility, shared geometry, shadow/reflection isolation, state restoration and unsupported-backend/backoff behavior. Development diagnostics are at `window.__grassDemo.pipeline.gpuOcclusion.stats`.

The cinematic terrain sampler projects each triangle into the height grid, avoiding a complete mesh raycast for every grid cell. The legacy sampler remains available when cinematic rendering is disabled. This only changes sampled heights; Rapier continues to use the terrain mesh for collisions.

Visual acceptance requires browser captures of the opening, walking, the shore, weather transitions, quality switches, both grass types, the painter and a mobile viewport. Frame rates depend on device, viewport, pixel ratio and selected quality; a local measurement is not a universal performance guarantee.

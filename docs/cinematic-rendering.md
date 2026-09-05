# Cinematic rendering

`public/cinematic-look.yaml` is the final art-direction layer before painter settings. The default Golden Hour treatment combines muted green grass, warm directional light, a cool sky fill, low-lying mist, and a restrained post-processing stack. This is an intentional visual departure from the recovered reference; old parity screenshots are historical evidence, not acceptance criteria for this pass.

## Rendering and quality

The active GrassDemo owns CinematicLighting, CinematicPipeline, MeadowDetails, and ScenicTour. WebGPU desktop uses three practical, fading shadow cascades over 180 units with 2048-pixel maps. The WebGL and mobile startup path uses a compact 110-unit shadow region. CSM is initialized with the gameplay camera before any reflection is captured. Resizing refreshes its frustums.

The scene uses exponential height-dependent fog whose color and density follow the active weather. Grass and tree leaves receive a small directional transmission approximation; it follows the sun's direction, color and intensity. It is an artistic approximation rather than full subsurface scattering.

The post-processing graph adds half-resolution GTAO, restrained bloom, saturation adjustment, a light vignette, and FXAA. Performance quality bypasses AO and bloom. Balanced reduces AO strength and halves reflection refresh frequency. Grass geometry changes dissolve over 0.35 seconds; shared geometries are retained until their tile transitions end or the tile pool is rebuilt.

## Materials and vegetation

Ground shading consumes the YAML texture scales and metalness, supports DirectX normal-map Y inversion, adds broad color variation and moss tint, and blends wet shoreline/rain roughness. The material remains nonmetallic when wet.

MeadowDetails builds six instanced geometry groups: flowers, seed heads, ferns, reeds, leaf litter and small stones. Placement is seeded by world cell and filtered by terrain slope, grass mask, nearby tree cells and water elevation. No additional textures or downloaded assets are required. The outer ring scales out over 18 units. Quality controls candidates per cell; movement only rebuilds placement when entering a new 12-unit cell. The terrain grid is an approximation for small detail placement, not collision geometry.

Grass retains the authored mask and interaction system. Continuous world-space height patches replace abrupt changes in height at the detail-distance threshold. Existing tree LOD transitions remain in use.

## Character and camera

The supplied Warden GLB contains one running clip. Runtime-generated quaternion clips provide a breathing idle and a walking cycle on its named rig. Authored idle/walk clips take priority when supplied. The original running animation remains unchanged. Playback rate follows locomotion speed; bounded two-joint foot placement adjusts planted feet to sampled terrain while leaving raised and airborne feet alone. The generated clips are a fallback, not motion capture, and the cloak is still skinned rather than cloth-simulated.

Camera framing and movement speed are expressed relative to visible model height instead of the GLB's import scale. The character initially faces into the scene. Existing mouse look, zoom, collision, grass painting and mobile controls remain available.

## Water and tour

Water uses terrain-derived shallow transparency and depth color, sun highlights that follow weather, and six expanding movement ripples. A 256-pixel cube reflection is captured once after gameplay-camera shader compilation, then refreshed near the lake every 0.75 seconds (1.5 seconds on Balanced). Performance retains its initial reflection. This is a local cubemap approximation, not a planar or screen-space reflection.

The 30-second scenic tour follows a terrain-cleared camera spline from the player's position, through a nearby grove, to a sampled shore. It hides and pauses the character, then restores the saved view. Escape, movement keys, the tour button, or opening the painter ends it. This is a camera tour; it does not teleport the player or add an authored navigation path.

Scene settings start collapsed. H hides/restores the HUD. Settings retain all weather, quality, grass-type, interaction, and painting controls.

## Verification

Run `npm run lint`, `npm test`, `npm run check:docs`, and `npm run build`. Cinematic tests compare rasterized terrain heights with downward raycasts across rotated and overlapping surfaces, check face culling, verify animation-loop seams and untouched bind poses, and check that foot placement reduces ground error.

The cinematic terrain sampler projects each triangle into the height grid, avoiding a complete mesh raycast for every grid cell. The legacy sampler remains available when cinematic rendering is disabled. This only changes sampled heights; Rapier continues to use the terrain mesh for collisions.

Visual acceptance requires browser captures of the opening, walking, the shore, weather transitions, quality switches, both grass types, the painter and a mobile viewport. Frame rates depend on device, viewport, pixel ratio and selected quality; a local measurement is not a universal performance guarantee.

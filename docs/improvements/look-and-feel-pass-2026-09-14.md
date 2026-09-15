# Look-and-feel pass (14 September 2026)

Goal: a more filmic, cohesive image with no visible frame-time cost. Density, draw distance, LOD, shadow and reflection resolution are untouched. Everything below is small shader math, uniform tuning, or one-time configuration. Baseline for the comparison: the tree after the frame-loop CPU pass (`6baa9fc`).

## Review method

Two Opus agents ran in parallel: one captured "before" screenshots at fixed poses (opening meadow, a wide meadow view toward the mountains, dense forest, river, lake shore, jungle coast, snow summit, plus the meadow under the Highfield and Moonrise presets) with a headless WebGPU Chrome at 1920 × 1080 and HUD hidden; the other audited the post chain, lighting, sky, ground and grass color paths for cheap upgrades. Captures live in `.cache/look-review/before/`, `after/` (first iteration) and `final/`, each with a `manifest.json` of camera poses.

What the "before" set showed: flat, saturated lime grass with almost no tonal range, a single-line grade (saturation only), a nearly invisible vignette, aerial perspective close to zero, a hard-edged bright turf blob where grass meets the path, a bland horizon, and no cloud movement on the ground.

## Changes

### Post grading (`src/rendering/CinematicPipeline.js`, `cinematic.post` in `public/cinematic-look.yaml`)

The grade now runs in linear light ahead of the ACES output transform: saturation, a pivot-preserving contrast curve (`contrast`, pivot 0.18), a lift/gain split that cools shadows and warms highlights (`lift`, `gain`), highlight desaturation so sunlit grass tips bleach toward white instead of neon (`highlightDesaturation`), a wider soft vignette, and animated hash grain that also hides banding. All are uniforms, so presets can retune them. Exposure dropped from 0.98 to 0.94 to make room for the contrast. Cost is a handful of ALU per pixel.

### Aerial perspective (`src/rendering/CinematicLighting.js`, `cinematic.atmosphere`, preset `fogDensity`)

The sun-colored inscatter lobe is broader (`pow 3.5` instead of `pow 8`) and stronger, damped in dense fog so rainy weather stays grey. Height mist starts higher (14 m) and the atmosphere density rose from 0.00065 to 0.001; the default preset's fog density rose from 0.0009 to 0.0011. A first iteration at 0.0016 with the sky crossfade starting at 180 m dissolved the far tree line and the mountains, which read as "lower grass density" and "no far grass"; blade counts were identical (77,418 submitted in every variant), so the crossfade went back to 350–1000 m and the densities were pulled down.

### Grass color (`src/grass/RecoveredGrassMaterial.js`, `public/visual-refinement.yaml`)

Blade bases darken harder (`grassRootBrightness` 0.72 → 0.5 over the bottom 30%) and blend toward the meadow soil color over the bottom 18%, so blades meet the terrain instead of floating on a painted lawn. Per-instance variation is now a hue drift (cooler/darker versus warmer/yellower) instead of a brightness jitter. The patch tint range widened and the second noise octave carries more weight, so clumps differ in hue. Backlight transmission was an existing knob turned down (`grassBacklight` 0.58 → 1.05, blade `sheen` 0.055 → 0.12, foliage light cap 0.55 → 0.8, lobe `pow 3` → `pow 2.2`).

### Ground (`src/world/GroundMaterial.js`, `public/ground-material.yaml`, `ground.macroVariation`)

The path mask edge is dithered with the turf fibre and macro noise that were already computed, so grass and soil interpenetrate instead of meeting on a contour. The turf under grass is darker (× 0.72) to read as shaded soil beneath the canopy and to match the new blade bases. Macro color variation and roughness variation were raised from the bottom of their ranges.

### Cloud shadows (`src/rendering/cloudShadow.js`)

New: a two-octave value noise in world XZ, driven by the cloud system's wind, speed and coverage, multiplied into the sun-lit color of terrain and grass. Coverage lowers the threshold so overcast presets shade more of the field. Two noise taps per fragment, no extra pass; `clouds.shadowStrength` (default 0.4) sets the depth and 0 disables it exactly.

### Sky and foliage

The sky compresses toward the fog color near the horizon so it meets the terrain's aerial perspective instead of ending in a band. Tree leaf backlight rose from 0.5 to 0.8. Shadow radius 2.5 → 4 (free on this path).

## Regressions found by review and fixed

- **Character invisible.** The matrix-update cache from the CPU pass skipped the dirty flag for objects with an unchanged local transform. A loaded GLTF subtree whose intermediate node has an identity transform (the character's Armature) therefore never re-derived its world matrix after being parented, leaving the skinned mesh at the world origin. The cache now tracks a per-object world-matrix version and re-derives a child whenever its parent's version moves, it is re-parented, or the parent manages its world matrix by hand; `updateWorldMatrix()` bumps the version only when the matrix actually changed. Three regression tests cover the Armature case, `getWorldPosition` on a moved parent, and manually managed parents.
- **Far view washed out.** Fog values above; see "Aerial perspective".
- Upside-down tree billboards were reported but did not reproduce in any variant (instance Y scales positive and identical to the pre-change tree, including the two new alpine billboard groups); if it recurs, note the location and preset.

## Shadows on grass: pre-existing bug, fixed

Grass never received tree or character shadows. `RecoveredGrassMaterial` set `receivedShadowPositionNode` to the deformed object-space blade position, but three's `ShadowBaseNode` expects that override in world space, so every shadow-map lookup was offset by the tile position (up to 220 units) and landed outside the shadow frustum, which reads as "lit". The override now multiplies by `modelWorldMatrix`. The shadow term was already being evaluated per blade fragment, so the fix costs nothing extra.

The review took a long detour before finding this: the terrain does receive shadows (the character throws one on the path), but the shadow frustum is a ±55-unit box pinned to the player by `EnvironmentController.updateSunTarget()` every frame, so free-camera diagnostics far from the player could never show shadows. The standalone harness `scripts/gpu/shadow-check.html?step=N` (kept) rebuilds the app's lighting, fog, tonemapping, post pipeline and matrix patch step by step with a working shadow at every step, and is a useful reference if the cascaded-shadow branch in `CinematicLighting` (dormant at `cascades: 1`) is ever enabled to extend shadow range.

## Cost

Same-session A/B at the meadow pose, quality High, 1920 × 1080, stationary, fast GPU power state (bloom mark 0.2–0.3 ms), 240 frames each. GPU is the render-query median.

| Variant | CPU processing | GPU |
|---|---:|---:|
| All effects on (PCFSoft shadows) | 5.7–5.9 ms | 4.5–4.6 ms |
| Grade neutral (contrast, lift/gain, grain, vignette off) | 6.0 ms | 4.4 ms |
| Cloud shadows off | 5.9 ms | 4.6 ms |
| Shadow filter PCF instead of PCFSoft | 5.7 ms | 4.1 ms |
| Grass tiles hidden (share of the field) | 5.0 ms | 3.2 ms |
| 1280 × 720 instead of 1920 × 1080 | 5.8 ms | 3.6 ms |

The grade, cloud shadows and sky changes are each inside ±0.1 ms of noise. The one real GPU cost is the grass shadow fix: blades now run the shadow filter for real instead of failing the frustum test, so the shadow filter went from PCFSoft to PCF (`createWorld.js`), which keeps clean edges at 0.55 ms less; Basic was rejected for visible aliasing on the path. CPU processing stays 2–5 ms below the pre-pass baseline at both qualities (High 7.8 → 5.6–5.9 ms; Ultra 11.3 → 6.2–6.7 ms).

## Verification

`node --test` (424 tests, including the three new matrix-cache regressions), `eslint .` and `npm run check:docs` pass. Final screenshots in `.cache/look-review/final/`: the character renders whole at the start view and casts a shadow onto the path; tree trunks and canopies now shade the grass blades in the start, meadow and forest views; the far tree line and mountains stay readable in the wide meadow view. The river and jungle-coast horizons are still on the hazy side and are the first candidates for a further small fog reduction.

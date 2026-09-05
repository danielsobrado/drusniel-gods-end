# Visual Parity Checklist

Use this checklist after visual/runtime changes and before declaring a parity or quality pass complete. The repository now contains both recovered-reference behavior and deliberate improvements such as the cinematic wind model, so validate the effective runtime rather than relying on older screenshots or obsolete constants.

## 1. Baseline capture

Use the same conditions for both captures:

```text
viewport: desktop
quality: High
preset: Sunny
grass type: Blade
pixel ratio: 1
foot interaction: enabled
Grass Painter: disabled
```

Record the exact commit SHA and use the same camera position/orientation.

## 2. Camera

Verify:

- FOV is 45.
- near/far are 0.1 / 10000.
- desktop follow distance starts at 5.
- zoom stays inside configured min/max distance.
- shoulder framing remains stable while moving.
- camera cannot travel below the terrain; `terrainClearance` is enforced on desired and smoothed positions.
- terrain clearance does not incorrectly clamp the camera to an edge sample when it is outside terrain bounds.

Do not change character scale, grass height or world scale to fix a camera problem.

## 3. Character

Current effective Warden visual transform:

<!-- effective-config -->
```yaml
player:
  start: [2, 5, -5]
  modelScale: 1.35
  modelOffsetY: 0
  modelRotationY: 0
```

Acceptance checks:

- the Warden reads at a believable human scale against trees and terrain,
- feet remain visually close to the ground,
- increasing character visual scale does not alter Rapier capsule dimensions,
- the GLB hierarchy and skinning remain intact,
- movement clip plays for walk/run and fades to the static pose at idle,
- no camera/FOV compensation is used for character sizing.

`public/character-visual.yaml` owns the asset-specific 1.35 scale override.

## 4. Terrain and ground

Gameplay terrain is `Landscape002`; `Landscape046` is an additional ground-material target.

Verify:

- world scale remains unchanged,
- player and camera use the same intended terrain surface,
- grass roots track terrain height,
- PBR ground blend aligns with `blend2.jpg`,
- black mask areas correspond to grassy ground/grass coverage,
- white mask areas expose PBR soil,
- grass and soil UV frequencies remain 150 / 70,
- rain changes wetness/ripple response without breaking the base material.

## 5. Grass

Blade mode uses the recovered tapered segmented strip. Billboard mode uses the recovered single quad.

Verify:

- dense near grass does not expose obvious tile boundaries,
- LOD density decreases with distance,
- roots stay anchored,
- grass mask cutoff and terrain alignment remain coherent,
- Foot Interaction bends local grass and recovers over time,
- painter edits update grass coverage correctly.

## 6. Wind

The default enhanced runtime uses the cinematic wind field. The recovered wind path remains available as a comparison/fallback.

Cinematic acceptance checks:

- large gust structures advect through world space rather than oscillating in place,
- field-wide motion does not look like synchronized ocean waves,
- grass stems carry large gust motion while tips retain finer flutter,
- nearby blades have subtle response/stiffness variation,
- tree canopy, falling leaves and rain react coherently to the same prevailing gust state,
- wind direction remains dominated by the preset direction rather than random local noise,
- no system explodes into extreme deformation during a strong preset.

## 7. Trees and foliage

Verify:

- authored tree transforms are preserved,
- high/low/billboard LOD transitions do not visibly jump,
- tree roots meet terrain rather than float,
- high-detail foliage uses the shared wind field,
- trunk/lower canopy motion is restrained relative to outer foliage,
- falling leaves use a single instanced system and zone texture changes remain correct,
- leaf motion feels related to wind without matching grass one-for-one.

## 8. Birds

Verify:

- ten recovered-layout birds are present when configured,
- orbit direction/scale/height remain deterministic,
- animation clip 0 is started when available,
- orbit rotation is applied at the parent group,
- birds do not inherit unrelated terrain or wind transforms.

## 9. Rain

Verify:

- GPU-instanced rain remains stable at the configured count,
- rain volume follows the player/camera region,
- streak direction responds to the shared large-scale wind field,
- turbulence does not turn rain into random sideways noise,
- ground wetness/ripples and water ripples respond with rain intensity,
- rain audio and visuals transition together without abrupt pops.

## 10. Water

Verify:

- water reflection target is WebGPU-compatible,
- wave layers remain stable across camera movement,
- Fresnel/reflection response is view dependent,
- rain ripple response activates only when appropriate,
- water surface and water collider stay aligned,
- no reflection feedback or black render target appears.

## 11. Environment transitions

Verify:

- preset changes transition over the intended duration,
- light, sky, fog, cloud coverage, grass parameters and rain settle consistently,
- changing preset mid-transition starts from the current interpolated state,
- audio targets transition without blocking rendering,
- the cinematic wind field receives the changing preset direction/intensity without phase resets.

## 12. UI and loading

Verify:

- loading overlay reaches Ready before Start is enabled,
- rendering is already active behind the ready overlay,
- Start gates audio/session start and performs the reveal,
- controls remain readable on desktop/mobile,
- FPS/TRIS metrics do not overlap controls,
- Grass Painter remains an explicit reconstruction/developer tool,
- controls menus and slider values stay synchronized after changing preset/grass type/quality.

## 13. Collision and movement

Verify:

- Rapier player remains grounded on `Landscape002`,
- terrain collision is trimesh-based on the primary path,
- tree/prop/world collision remains registered,
- falling reset does not trigger during ordinary terrain traversal,
- visual character scale 1.35 does not silently resize the physics capsule,
- camera terrain clearance prevents below-ground views even at extreme zoom/pitch.

## 14. Performance

Compare like-for-like quality settings.

Check:

- grass remains instanced and LOD-managed,
- tree LOD is active,
- leaves and rain remain instanced,
- terrain height data is reused rather than rebuilt per frame,
- pixel ratio stays bounded,
- High remains interactive on the target desktop/mobile hardware,
- cinematic wind does not introduce unnecessary CPU per-blade work.

## 15. Sign-off captures

Capture at minimum:

```text
Sunny / High / Blade
Golden Hour / High / Blade
Rain / High / Blade
Wind / High / Blade
Moonlight / High / Blade
Sunny / High / Billboard
Grass Painter enabled
```

Compare in this order:

```text
camera composition
character physical scale
terrain/ground alignment
grass height and density
wind character
lighting / fog / sky
foliage/tree placement and LOD
rain/water behavior
UI placement
performance
```

Fix the earliest incorrect layer first. Do not tune several unrelated constants to hide one underlying scale, camera, terrain or asset problem.

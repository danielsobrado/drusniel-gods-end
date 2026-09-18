# Player Controller

This document describes the player controller exactly as implemented on current `main`. It is intended to be detailed enough for another AI to reproduce the same movement feel, model loading, animation state changes, terrain grounding, grass influence points and integration with the camera/audio systems without guessing.

## Source files

```text
src/player/PlayerController.js
src/app/GrassDemo.js
public/config.yaml
public/player-controls.yaml
public/visual-parity.yaml
public/character-visual.yaml
```

For camera-specific math and input behavior, also read `docs/camera-system.md`. For rig/skinning details, read `docs/character-rig-and-armour.md`.

---

## 1. Responsibilities

`PlayerController` owns:

```text
player gameplay root
model loading
fallback player mesh
keyboard input
camera-yaw-relative locomotion
acceleration/deceleration
world-bound checks
terrain Y placement
facing rotation
movement/idle animation state
animation playback-rate adjustment
player enable/disable state
third-person camera state
grass interaction influence points
surface-aware movement state exposed to AudioSystem
```

It drives a Rapier kinematic character controller (`src/player/PlayerPhysics.js`), so gravity,
capsule collision, slope climbing and slope sliding against the terrain trimesh are implemented.

It does **not** implement jumping or root motion. Prop/tree/world collision is registered separately by `WorldCollisionSystem`.

---

## 2. Runtime transform hierarchy

The controller creates:

```text
PlayerController.root : THREE.Group
```

and adds it to the scene immediately.

Conceptually:

```text
scene
  |
  +-- player root
       position = gameplay position
       rotation.y = gameplay facing
       |
       +-- placeholder capsule, initially visible
       |
       +-- Drusniel dark elf GLB, after load
            scale / local offset / local orientation
            skeleton
            skinned character mesh
            animations
```

The root owns world movement. The imported GLB is a visual child and keeps its internal rig hierarchy intact.

---

## 3. Start position

The effective recovered configuration is:

```yaml
player:
  start: [2, 5, -5]
```

Rapier initializes the gameplay body and then the player is explicitly positioned at this start transform.

---

## 4. Placeholder fallback

Before GLB loading completes, the controller creates:

```text
CapsuleGeometry(0.34, 0.92, 6, 12)
MeshStandardMaterial
color 0xd7d9d2
roughness 0.72
```

The placeholder mesh is positioned at:

```text
y = 1
```

and casts shadows.

If the Warden GLB loads, the placeholder is hidden. If loading fails, it remains as the visible player and a warning is logged.

The placeholder capsule is visual only. Rapier uses the configured `capsuleHalfHeight` and `capsuleRadius` separately.

---

## 5. Player GLB loading

Configured asset:

```text
Assets/Drusniel_Dark_Elf.glb
```

Loader stack:

```text
GLTFLoader
  + DRACOLoader
```

Draco decoder path is configured under `assets.dracoDecoderPath`.

The Draco loader is disposed in `finally`, whether loading succeeds or fails.

---

## 6. Effective visual transform

The merged effective values are:

<!-- effective-config -->
```yaml
player:
  modelScale: 1.35
  modelOffsetY: 0
  modelRotationY: 0
```

Applied as:

```text
model.scale.setScalar(1.35)
model.position.y = 0
model.rotation.y = 0
```

The Warden-specific scale is isolated in `public/character-visual.yaml`, loaded after recovered visual parity values. Do not change camera FOV, grass height, or world scale to compensate for character asset sizing.

---

## 7. Mesh preparation

Every mesh under the loaded player model is traversed.

Current behavior:

```text
castShadow = true
receiveShadow = true
geometry.computeVertexNormals() when available
if object.name contains 'FootSphere' -> visible = false
```

This hiding behavior supports optional replacement assets with `FootSphere` helpers. The current Warden asset has none.

---

## 8. Animation clip mapping

Configured names:

```yaml
player:
  animations:
    idle: null
    walk: Walking
    run: Running
```

Actions are indexed by their exact exported clip names. The dark elf asset provides an authored walk and an authored run, so the two states use different clips. A null idle mapping fades the current action out to the static asset pose.

The mixer is:

```text
new THREE.AnimationMixer(model)
```

The controller does not rename clips or retarget animation tracks.

---

## 9. Animation state setup

The animation state stores:

```text
mixer
actions keyed by exported clip name
the current action
```

Initialization leaves the model in its static pose because `idle` is null.

When changing state, the next action is reset, faded in and played while the previous action fades out.

Normal changes use the effective recovered fade:

```yaml
animationFadeSeconds: 0.25
```

---

## 10. Missing animation fallback

When the requested action is unavailable, the action is faded out and the model returns to its static pose. A missing clip does not make model loading fail.

---

## 11. Movement keys

Recognized input codes are exactly:

```text
KeyW
KeyA
KeyS
KeyD
ShiftLeft
ShiftRight
```

Keydown is ignored when:

```text
player controller disabled
focused target is input/select/textarea/button/contenteditable
key is not in the recognized movement set
```

Keyup removes the code from the active-key set.

Window blur clears input state.

---

## 12. Camera-relative movement vectors

Movement direction is derived from current camera yaw.

Forward:

```text
forward = (sin(yaw), 0, cos(yaw))
```

Right:

```text
right = (forward.z, 0, -forward.x)
```

W/S and A/D produce a combined direction which is clamped to unit length, preventing diagonal input from exceeding the selected speed.

---

## 13. Walk and run speed

Current values:

<!-- effective-config: player -->
```yaml
walkSpeed: 2.5
runSpeed: 15
```

Either Shift key requests running.

---

## 14. Acceleration and deceleration

Effective motion configuration:

<!-- effective-config: player.motion -->
```yaml
acceleration: 20
deceleration: 16
stopSpeed: 0.06
runStateThreshold: 0.85
animationFadeSeconds: 0.25
walkAnimationRate: 1
runAnimationRate: 1
minAnimationRate: 0.72
maxAnimationRate: 1.18
```

Speed is ramped linearly toward the selected target speed by `acceleration * deltaSeconds`. With no input, grounded horizontal speed is reduced by `deceleration * deltaSeconds` until it reaches zero.

---

## 15. Movement state

After movement:

```text
speed = horizontalVelocity.length()
moving = speed >= 0.1
running = moving && sprintRequested
```

The retained `motion.stopSpeed`, `runStateThreshold`, and animation-rate fields are configuration records but are not all active in the current controller path.

---

## 16. Rapier movement

When physics is available, gravity is accumulated in vertical velocity, horizontal and vertical displacement are passed to `PlayerPhysics.move()`, and the returned position/grounded state becomes the gameplay root transform.

If grounded while falling, vertical velocity resets to zero.

---

## 17. Terrain fallback movement

If Rapier initialization fails, movement falls back to the `TerrainSampler`. X and Z are checked separately against terrain bounds, then Y is snapped to sampled terrain height plus `groundOffset`.

This fallback is resilience behavior, not the primary physics implementation.

---

## 18. Facing direction

Input direction is converted to desired yaw with:

```text
atan2(direction.x, direction.z)
```

The controller applies shortest-angle rotation toward it using the effective `turnSpeed`.

<!-- effective-config: player -->
```yaml
turnSpeed: 18
```

---

## 19. Animation state selection

Every update:

```text
if horizontal speed < 0.1 -> idle
else if running -> run
else -> walk
```

The mixer advances by `deltaSeconds` before movement processing.

---

## 20. Disable behavior

`setEnabled(false)` is used by Grass Painter mode.

It clears input, zeros horizontal velocity and movement state, and returns to the configured idle/static pose.

---

## 21. Grass influence helper discovery

The current configuration does not define `influenceObjects`, because the Warden GLB has no dedicated foot helpers. If optional names are configured for a future asset, the controller searches the model by those exact names and keeps objects that exist.

---

## 22. Influence radius from GLB helpers

For each helper:

```text
get world position
get world scale
compute geometry bounding sphere when possible
radius = boundingSphere.radius * max(worldScale.x, worldScale.z)
```

If no geometry radius is available, `grass.interaction.footRadius` is used before scale multiplication.

---

## 23. Exact fallback influence points

When no configured helper objects are found, as with the current Warden, the controller creates two points from root orientation.

Forward from root facing:

```text
forward = (sin(root.rotation.y), 0, cos(root.rotation.y))
```

Right:

```text
right = (forward.z, 0, -forward.x)
```

Fallback point 1:

```text
root + right * 0.18 + forward * 0.18
```

Fallback point 2:

```text
root - right * 0.18 - forward * 0.18
```

Both use the configured grass interaction foot radius.

---

## 24. Surface-aware movement state

The controller exposes:

```text
{
  moving,
  running,
  speed,
  surface
}
```

Default surface argument is `grass`. In normal app flow, `GrassDemo` supplies `water`, `grass` or `mud` after surface detection.

---

## 25. Relationship to AudioSystem

`AudioSystem` consumes movement state and animation phase for surface-aware footsteps. The controller does not choose footstep samples itself.

---

## 26. Relationship to grass interaction

Every frame `GrassDemo` passes:

```text
player.getPosition()
player.getInfluencePoints()
```

into `GrassField.update()`.

Those points are painted into `InteractionMap`, not applied directly to individual grass objects.

See `docs/grass-interaction.md`.

---

## 27. Relationship to camera

The same `PlayerController` owns the third-person camera state because movement must be relative to camera yaw and the camera follows the player body.

The exact camera vectors, pointer-lock logic, shoulder offset, mobile behavior, zoom damping and terrain clearance are documented in `docs/camera-system.md`.

---

## 28. Current non-features

Do not add these during exact-parity implementation unless explicitly creating a new behavior layer:

```text
jump
root-motion world translation
combat
stamina
crouching
swimming
water buoyancy
```

Gravity, capsule collision, slope climbing and slope sliding are implemented through Rapier. Tree, prop, authored world-bound and named trimesh collision is registered separately by `src/physics/WorldCollisionSystem.js`.

`player.jumpSpeed` is configured but no jump key exists in `MOVEMENT_KEYS`, so it is inert.

---

## 29. Exact reproduction checklist

A correct recreation should satisfy all of these:

- create a separate gameplay root and visual model child,
- use effective start `[2, 5, -5]`,
- use Warden visual transform `scale 1.35`, `offsetY 0`, `rotationY 0`,
- load the Draco-enabled Warden GLB with graceful fallback,
- hide optional FootSphere meshes without removing them,
- use WASD relative to camera yaw,
- normalize diagonal movement,
- use walk 2.5 and run 15,
- use linear acceleration 20 / deceleration 16,
- use turn speed 18,
- map walk and run to the clip names the selected character declares (`Walking`/`Running` on the current rig), fading out for idle,
- preserve the FootSphere/fallback influence logic,
- expose movement/surface state to audio rather than choosing sounds in the player class.

---

## 30. Visual debugging order

If movement or character feel differs, debug in this order:

```text
1. effective merged camera/player YAML values
2. player GLB scale and offset
3. camera yaw convention
4. forward/right movement vector signs
5. acceleration/deceleration
6. Rapier / fallback terrain grounding
7. facing angle convention
8. animation clip names
9. camera follow composition
```

Do not tune camera or grass scale to compensate for a wrong character asset scale.

---

## 31. Rapier physics

### Construction

The current runtime creates the Warden controller with the authored `Landscape002` gameplay terrain mesh and these effective values:

<!-- effective-config: player -->
```yaml
start: [2, 5, -5]
modelScale: 1.35
modelOffsetY: 0
eyeHeight: 0.5
walkSpeed: 2.5
runSpeed: 15
jumpSpeed: 8
gravity: -25
capsuleHalfHeight: 1
capsuleRadius: 0.7
```

The initial camera position used to construct the Rapier body is `[11.7, 3, 11]`. Gameplay then places the player at `[2, 5, -5]`.

`capsuleHalfHeight` and `capsuleRadius` build the actual player collider in `PlayerPhysics.js`; visual `modelScale` is independent of the collider dimensions.

### Controller

`@dimforge/rapier3d-compat`, with:

```text
character offset = 0.01
snap to ground   = 0.2
max slope climb  = 45 degrees
min slope slide  = 60 degrees
terrain friction = 1
player friction  = 0
player restitution = 0
```

The body is `kinematicPositionBased()` and its translation is stored at `visualY - eyeHeight`.

### Terrain collision

The terrain is converted to Rapier triangle-mesh colliders. The gameplay terrain passed to the player is `Landscape002`; `Landscape046` is also a ground material target but is not the primary player terrain.

### Per-frame order

```text
acceleration       = 20
deceleration       = 16
rotation speed     = 18
fall reset height  = 20
```

1. add `gravity * dt` to vertical velocity,
2. derive movement from camera-relative input,
3. accelerate toward walk/run speed,
4. apply deceleration only with no movement input while grounded,
5. write vertical displacement as `verticalVelocity * dt`,
6. call `computeColliderMovement`,
7. read computed movement/grounded state,
8. zero negative vertical velocity when grounded,
9. update the kinematic body translation,
10. update the visual target,
11. step the Rapier world.

If the body falls more than 20 units below the construction-time spawn reference, it respawns at `player.start` via `spawnAtStart()`, which ignores the configured height and places the character on the terrain (`sampleHeight + rootToFeet + groundOffset`). A fixed height buried the 5-unit characters about half a unit in the ground at the start, where the Rapier controller treated the surrounding terrain edges as walls and the player ran in place.

### Model transform

The Warden GLB is a visual child of the player target with scale 1.35 and no local Y offset.

### Contact shadow

`ContactShadow` lays a soft, cool occlusion blob on the terrain under the character, aligned to the terrain normal and wider across the shoulders than toe to heel. The low snow-country sun throws the real shadow long and sideways, or loses it inside a shaded gorge, and a standing character then looks suspended. The blob shrinks and fades as the feet leave the ground (`fadeHeight` of the character's height), so a jump still reads as height above it. It hides with the character. `player.contactShadow` can override `radius`, `fadeHeight`, `opacity` and `color`, or disable it. The opacity is high because bright snow sits deep in HDR: a blob at half opacity still tonemaps to light grey.

### Implementation rule

When player behavior differs from this document, compare code and effective configuration before changing unrelated world, camera or grass constants. Do not hide collision errors with a terrain-height fallback unless Rapier initialization itself fails.

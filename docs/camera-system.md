# Camera System

This document records the recovered reference camera baseline and the current clean-room implementation that reproduces it.

## Recovered projection

The browser-delivered demo constructs the gameplay camera with:

```yaml
camera:
  fov: 45
  near: 0.1
  far: 10000
```

An earlier repository baseline used FOV 52 / far 6000. That is obsolete for parity work.

## Recovered controller constants

The recovered controller behavior establishes these values:

```yaml
camera:
  distance: 5
  minDistance: 1.5
  pitch: -0.25
  controls:
    initialYaw: 0
    targetHeight: 1
    cameraHeight: 4
    shoulderOffset: 1.2
    mobileBreakpoint: 768
    mobileDistance: 7
    desktopDistance: 5
    mouseSensitivity: 0.001
    minPitch: -0.8
    maxPitch: 0.7
    followSharpness: 8
    terrainClearance: 0.4
```

The current YAML is layered from:

```text
config.yaml
ground-material.yaml
player-controls.yaml
visual-parity.yaml
character-visual.yaml
cinematic-wind.yaml
painter-cursor.yaml
```

Later files override earlier values. `visual-parity.yaml` carries the recovered projection values, while `character-visual.yaml` carries the Warden-specific visual scale correction.

## Player constants related to camera feel

Recovered movement/controller values include the movement values below. The Warden uses an asset-specific visual scale of 1.35 because the replacement GLB is authored smaller than the previous player asset.

<!-- effective-config -->
```yaml
player:
  modelScale: 1.35
  modelOffsetY: 0
  walkSpeed: 2.5
  runSpeed: 15
  turnSpeed: 18
  motion:
    acceleration: 20
    deceleration: 16
```

Do not compensate for character sizing by changing FOV, grass height, or world scale. Character visual sizing belongs in the character-specific YAML transform.

## Current implementation

`src/player/PlayerController.js` owns:

- camera-relative WASD movement,
- yaw/pitch state,
- pointer-lock look,
- drag-look fallback,
- zoom distance,
- third-person target and shoulder offset,
- camera follow damping,
- terrain clearance.

The camera target starts from the player root, adds `targetHeight`, then applies the configured right/shoulder target offset.

The desired camera offset is built from:

```text
(-shoulderOffset, cameraHeight, distance)
```

then rotated by yaw and pitch before being added to the target.

## Initial state

Current parity initialization is:

```text
yaw = 0
pitch = -0.25
desktop distance = 5
mobile distance = 7
```

The camera is placed directly at the initial desired position. It does not animate in from the origin.

## Look input

Pointer-lock look uses the recovered desktop sensitivity:

```text
0.001
```

Pitch is clamped to:

```text
-0.8 .. 0.7
```

The original contains additional browser/mobile handling. Reproduce those only from recovered evidence, not generic third-person-controller conventions.

## Terrain relationship

The gameplay terrain is `Landscape002`.

The camera samples the repository `TerrainSampler` and enforces `terrainClearance` on both the desired and smoothed camera position. This prevents orbit/zoom motion from passing below the terrain surface.

## Physics boundary

The recovered original uses a Rapier-backed character/collision path. The current repository uses Rapier for the player and a terrain sampler for camera clearance and fallback grounding.

## Grass Painter

Normal gameplay camera control is disabled while Grass Painter is active. Painter uses `OrbitControls` over the same camera, then gameplay follow resumes when painter mode exits.

## Parity checklist

Before tuning scene scale or grass height, verify:

- FOV is 45.
- near/far are 0.1 / 10000.
- Warden model scale is 1.35.
- initial pitch is -0.25.
- desktop/mobile distances are 5 / 7.
- target height is 1.
- camera height is 4.
- shoulder offset is 1.2.
- terrain clearance is 0.4.
- gameplay terrain is `Landscape002`.
- painter mode is not active during reference screenshots.

A wrong FOV, target mesh, camera distance, or character asset scale can make otherwise-correct scene geometry look wrong, so those must be validated independently.

# Runtime Lifecycle

This document describes the current `main` startup and frame lifecycle. Recovered browser-delivered behavior remains the higher-priority parity source when implementation details differ.

## Entry point

`src/main.js` loads the merged YAML configuration, creates `GrassDemo`, and awaits `GrassDemo.start()`.

Runtime configuration is merged in this order:

```text
config.yaml
ground-material.yaml
player-controls.yaml
visual-parity.yaml
painter-cursor.yaml
```

## Recovered loading stages

The visible loading contract is recovered directly from the browser bundle and lives in `src/ui/loadingStages.js`:

```text
Initializing...                 0%
Initializing renderer...       0%
Loading environment...         0%
Loading world...               5%
Loading player...             25%
Setting up collision system... 40%
Setting up foliage            55%
Growing grass...              65%
Loading audio...              75%
Compiling shaders...          80%
Ready                        100%
```

`LoadingUi` updates the progress bar with `scaleX(progress / 100)`, updates the percentage/status labels, and fills the wordmark from bottom to top over one second with a `power2.out` equivalent.

At `100%` the Start button becomes interactive over one second.

## World creation order

`createWorld()` now follows the recovered high-level startup order:

```text
scene + camera
renderer setup
loading stage: renderer
await renderer.init()
base lights
loading stage: environment
HDR environment
loading stage: world
terrain GLB
terrain animation mixer
terrain sampler
recovered ground material
procedural sky + clouds
```

The clean-room `TerrainSampler` remains an adapter used by gameplay/fallback systems; it is not a claim about the original source layout.

## Player and collision startup

After the renderer canvas is attached:

```text
loading stage: player
PlayerController
Rapier player physics
Drusniel dark elf GLB + movement animation

loading stage: collision
WorldCollisionSystem
world props
ZoneIndex
TreeSystem + tree colliders
recovered world colliders
LeafSystem
```

The player is created before the separate world collision system, matching the recovered ordering.

## Foliage, grass, water, rain and audio

The remaining startup order is:

```text
loading stage: foliage
BirdSystem

loading stage: grass
GrassField
Grass Painter attachment

WaterSurface
RainSystem

loading stage: audio
AudioSystem.init()
EnvironmentController
DemoUi
```

`AudioSystem.init()` prepares buffers and scene audio objects but does not start playback.

## Shader warmup and ready state

Before the public Start gate:

```text
loading stage: shaders
await renderer.compileAsync(scene, camera)
register resize handler
run initial resize
loading stage: ready
renderer.setAnimationLoop(...)
```

The render loop therefore starts while the loading overlay is still visible. This matches the recovered browser behavior.

## Start gate

Audio is not unlocked by an arbitrary pointer or keyboard event.

The Start button is the explicit browser-audio gate. On click:

```text
await audio.start()
player.setPosition(2, 5, -5)
disable loading-overlay pointer events
disable Start-button pointer events
animate loading reveal for 3 seconds with power4.inOut
expand reveal radius to 120vmax
remove loading overlay
```

The reconstructed overlay uses the recovered timing and selector semantics while keeping a clean-room text wordmark rather than copying the original logo asset.

## Resize behavior

`GrassDemo.#resize()` updates:

```text
PlayerController.handleResize()
camera aspect
camera projection matrix
renderer pixel ratio
renderer size
```

`PlayerController.handleResize()` switches the recovered desktop/mobile camera distance and creates/destroys the mobile touch controls at the 768px camera breakpoint.

## Per-frame time

Each frame uses:

```text
deltaSeconds = min(clock.getDelta(), 0.05)
elapsedSeconds = clock.elapsedTime
```

## Current per-frame order

The current executable order is:

```text
1.  environment.update(deltaSeconds)
2.  player.update(deltaSeconds)
3.  terrainAnimations.update(deltaSeconds)
4.  leaves.update(deltaSeconds)
5.  clouds.update(deltaSeconds)
6.  trees.update(deltaSeconds)
7.  rain.update()
8.  birds.update(deltaSeconds)
9.  detect player surface
10. audio.update(deltaSeconds)
11. collisions.update()
12. grass.update(deltaSeconds, elapsedSeconds, playerPosition, influencePoints)
13. environment.updateSunTarget(playerPosition)
14. renderer.render(scene, camera)
15. ui.update(deltaSeconds)
```

The environment controller is a clean-room interpolation adapter for behavior that the recovered application delegated to GSAP; its explicit frame position is therefore repository behavior rather than a claim about original source structure.

## Surface detection

Footstep surface selection is:

```text
water first
grass mask second
mud otherwise
```

## Ownership and teardown

`GrassDemo.dispose()` stops the animation loop, aborts listeners, removes a still-visible loading overlay, then disposes UI, painter, grass, foliage, collisions, player/Rapier world, weather, water, audio, environment, terrain animations, sky/clouds and renderer resources.

This teardown is a clean-room robustness addition and does not alter the normal rendered result.

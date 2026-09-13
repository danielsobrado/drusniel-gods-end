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

The visible loading contract lives in `src/ui/loadingStages.js`:

```text
Opening the way...                 0%
Lighting the horizon...            0%
Waking the sky...                  0%
Shaping the wilds...               5%
Choose your traveler...           20%
Preparing your traveler...        25%
Setting the boundaries...         40%
Awakening the forest...           55%
Weaving the undergrowth...        65%
Waking the soundscape...          75%
Polishing the final details...    80%
The way is open                  100%
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
MeadowDetails / WildGrassSystem / UnderstorySystem (resumable populate jobs)

WaterSurface
BoundaryBarrier
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
1.  player.update(deltaSeconds)
2.  tour.update(deltaSeconds)
3.  terrainAnimations.update(deltaSeconds)
4.  leaves.update(deltaSeconds)
5.  clouds.update(deltaSeconds)
6.  trees.update(deltaSeconds)
7.  rain.update()
8.  birds.update(deltaSeconds)
9.  detect player surface
10. audio.update(deltaSeconds)
11. collisions.update()
12. grass.update(...)
13. environment.updateSunTarget(focus)
14. cinematicLighting.update()
15. meadow / wildGrass / understory.update (queue rebuilds)
16. vegetationJobs.tick()            // shared 2 ms budget
17. boundaryBarrier.update(...)
18. water.update(...)
19. pipeline.render()                // occlusion prepare + beauty/post
20. ui.update(deltaSeconds)
```

With `?profile=1`, those steps are timed into JSON on `window.__grassDemo.getProfileResults()`.

The environment controller is a clean-room interpolation adapter for behavior that the recovered application delegated to GSAP; it applies on preset/quality changes rather than every frame.

## Surface detection

Footstep surface selection is:

```text
water first
grass mask second
mud otherwise
```

## Ownership and teardown

`GrassDemo.dispose()` stops the animation loop, aborts listeners, removes a still-visible loading overlay, then disposes UI, painter, grass, foliage, collisions, player/Rapier world, weather, water, audio, environment, terrain animations, sky/clouds and renderer resources.

Renderer recovery preserves explicit grass edits without replacing the distinct blade and billboard preset defaults. Controls are initialized from the restored state, and camera zoom is restored after resizing. Automatic recovery retries WebGPU once, then uses WebGL if that retry loses its device, including during startup. Forced WebGPU never switches backends. Late player models and physics worlds are released after cancellation; a pending audio resume cannot restart a disposed scene.

To exercise the full restart path, enter the Vite app with `?renderer=auto&character=drusniel`, then run `const { checkRendererRecovery } = await import('/scripts/gpu/recovery-check.js'); await checkRendererRecovery()` in the browser console. It checks two consecutive losses, grass settings, controls and zoom. Reload and pass `{ loseDuringRestart: true }` to check a device loss while the replacement is still starting. These checks deliberately consume the page's recovery budget.

This teardown is a clean-room robustness addition and does not alter the normal rendered result.

# Reference Parity and Evidence Levels

This repository is a clean-room reconstruction of a browser-delivered Three.js demo. The goal is observable parity with the recovered reference while keeping the new implementation maintainable.

## Evidence order

When sources disagree, use this order:

1. recovered browser-delivered code,
2. recovered literal asset/object names and constants,
3. current executable code implementing that recovered behavior,
4. effective merged YAML configuration,
5. subsystem documentation,
6. visual inference from screenshots.

Recovered behavior takes precedence over an older clean-room implementation or document. Do not replace a recovered formula with a conventional Three.js pattern merely because the conventional version is cleaner.

## Evidence levels

### Recovered literal

Names, values, asset paths and formulas read directly from the delivered bundle or recovered asset data. Examples include the configured player GLB, `terrain2.glb`, `TreePositions`, recovered rain/water constants, authored tree/prop transforms and collision dimensions.

### Reference-observed behavior

Behavior visible in the running reference where the exact internal implementation was not initially known. Examples include third-person control, grass interaction, weather presets, painting, vegetation LOD and ambient audio.

### Clean-room adapter

New code used to reproduce or support the recovered behavior. `TerrainSampler`, the current class boundaries, resilience fallbacks and lifecycle cleanup are examples. These are authoritative for this repository when recovered evidence does not specify a different behavior, but they are not claims about the unavailable original source layout.

### Fallback behavior

Resilience paths used only when a required reference asset or subsystem cannot be created. Examples include flat terrain, the procedural player capsule, procedural trees/birds and solid-sky fallback. They are not the target visual state.

## Current recovered gameplay scope

The current repository includes recovered Rapier player collision and recovered world collision behavior:

- kinematic player capsule and terrain trimesh collision,
- slope climb/slide and ground snapping,
- authored world-bound boxes,
- distance-gated tree and lantern box colliders,
- Stone convex-hull colliders,
- named `WaterCollider` / `HouseCollider` trimesh proxies.

Rain also reproduces the recovered wet-response path: interpolated rain intensity, ground ripple normals, water rain normals and material roughness interpolation.

There is still no jump mechanic even though `player.jumpSpeed` remains configured.

## High-sensitivity visual values

Treat these as parity-sensitive:

```text
camera FOV / pitch / distance / shoulder framing
player visual scale and offset
terrain target and transform
ground UV scales and mask orientation
grass blade geometry, density, LOD and hard visibility thresholds
grass wind/detail formulas and color sheen
sun direction/intensity
sky and cloud formulas
fog density
HDR environment intensity
water geometry, waves and reflection
rain geometry and intensity
UI layout and painter cursor
```

## High-sensitivity behavioral values

Treat these as parity-sensitive:

```text
camera-relative movement
linear acceleration/deceleration
Shift/mobile sprint selection
animation clip names and cross-fades
Rapier grounding/collision
grass interaction scrolling/recovery
painter controls and mask convention
five-second power2.inOut environment transitions
surface-specific footsteps
rain/water/wetness transition coupling
tree LOD hysteresis/cross-fade
```

Do not add a run-speed threshold or animation-rate scaling unless new recovered evidence requires it; current player state selection is based on horizontal speed plus the sprint request.

## Configuration is not behavior by itself

A YAML key can be active, overridden, retained for reference, or inert. Use `npm run config:dump` for the effective merged value and inspect the owning runtime consumer before changing behavior.

The runtime currently merges five YAML files; see `config-reference.md` for the exact order.

## Asset parity is separate from code parity

Equivalent code cannot produce the same result with materially different terrain, character proportions, rig/animation timing, vegetation silhouettes, ground textures, HDR lighting or audio. Treat an asset replacement as a new parity exercise.

## Browser and GPU variation

The renderer uses Three.js WebGPU/TSL with an optional WebGL backend. Small backend/browser/driver differences can occur. Validate screenshots on the same browser/backend before changing recovered formulas to compensate for a driver-level difference.

## Do-not-invent rule

If behavior is absent from recovered evidence, current code and configuration, do not add a plausible engine feature and present it as parity. Examples of features still absent include jumping, root-motion locomotion, volumetric clouds, bird flocking, post-processing bloom, SSAO and motion blur.

## Change rule

When implementation changes any recovered/configured behavior, review the owning subsystem document in the same change. When recovered evidence contradicts current code, fix the code and the document together.

“Exact” in this repository therefore means: reproduce recovered behavior first, preserve verified current adapters where the original internals remain unknown, and keep inference clearly separated from evidence.

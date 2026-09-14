# Grass Test Documentation

These documents are an implementation specification for reproducing the browser-delivered reference demo as closely as possible with the assets and behavior we recovered.

## Evidence order

For parity work, use this order:

1. recovered browser-delivered code,
2. recovered literal asset/object names and constants,
3. current executable code implementing recovered behavior,
4. effective merged YAML configuration,
5. subsystem documentation,
6. visual inference from screenshots.

Do not replace a recovered formula with a generic Three.js pattern because it looks cleaner. Do not tune around a coordinate-system or asset-target bug with arbitrary visual constants.

## Start here

Read these first:

1. [Recovered original parity specification](recovered-original-parity.md) — behavior and constants recovered directly from the browser-delivered code.
2. [AI reproduction playbook](ai-reproduction-playbook.md) — implementation order and subsystem dependencies.
3. [Visual parity checklist](visual-parity-checklist.md) — acceptance checks for the reference look.
4. [Reference parity](reference-parity.md) — evidence levels and clean-room boundaries.
5. [Configuration reference](config-reference.md) — merged YAML configuration.
6. [Asset contract](asset-contract.md) — required files and exact GLB object names.
7. [Runtime lifecycle](runtime-lifecycle.md) — startup and per-frame ordering.

Before modifying a subsystem, read both `recovered-original-parity.md` and that subsystem's document.

## Core rendering and world

- [Rendering architecture](rendering-architecture.md) — WebGPU/TSL renderer, lighting, node materials, instancing and fallbacks.
- [Cinematic rendering](cinematic-rendering.md) — default lighting, grass style, occlusion, meadow jobs and visual review.
- [Runtime lifecycle](runtime-lifecycle.md) — startup and frame update order.
- [Configuration reference](config-reference.md) — merged YAML sources and consumers.
- [Asset contract](asset-contract.md) — exact assets and GLB names.
- [Performance](performance.md) — quality controls, specialized grass shaders, vegetation jobs and opt-in `?profile=1` timings.
- [Reference parity](reference-parity.md) — recovered versus clean-room behavior.
- [Visual parity checklist](visual-parity-checklist.md) — visual acceptance criteria.

## Terrain and environment

- [Terrain system](terrain-system.md) — `Landscape002` gameplay terrain, GLB preprocessing and clean-room height sampling.
- [Expanded landscape](expanded-landscape.md) — default 2,400 × 1,600 map, river/lake/sea and routes.
- [Ground PBR textures](ground-pbr-textures.md) — recovered grass/dirt TSL blend material.
- [Recovered world props](world-props.md) — exact Stone and Lantern source preparation, authored transforms and collision shapes.
- [Sky and clouds](sky-cloud-system.md) — procedural TSL sky and cloud system.
- [Environment presets](environment-presets.md) — preset interpolation and subsystem coordination.
- [Wind system](wind-system.md) — grass/tree/leaf/cloud/rain wind behavior.
- [Rain system](rain-system.md) — GPU rain and wet-environment integration.
- [Water system](water-system.md) — recovered lake geometry, waves, reflection and rain response.
- [Water performance](water-performance.md) — planar/cube capture budgets and `water.stats`.

## Grass

- [Grass system](grass-system.md) — tile, geometry, material, mask and LOD pipeline.
- [Grass interaction](grass-interaction.md) — player-centered persistent interaction map.
- [Grass painter](grass-painter.md) — recovered hard-circle mask editing, orbit camera and export.
- [LOD system](lod-system.md) — grass and tree LOD/quality behavior.

## Character and camera

- [Player controller](player-controller.md) — movement, Rapier physics and animation.
- [Camera system](camera-system.md) — recovered 45-degree third-person camera baseline and current controller.
- [Character rig and armour](character-rig-and-armour.md) — Warden GLB hierarchy and animation ownership.

## Vegetation and wildlife

- [Tree system](tree-system.md) — recovered authored tree world data, high/billboard LOD and foliage materials.
- [Procedural vegetation](procedural-vegetation.md) — ecology field, meadow/wild-grass/understory jobs.
- [Leaf system](leaf-system.md) — falling leaf instancing, variants and zones.
- [Bird system](bird-system.md) — source cloning, animation and orbit motion.
- [Zone system](zone-system.md) — GLB zone helpers.

## Audio

- [Audio system](audio-system.md) — browser unlock, ambience, bird calls and footsteps.

## Interface

- [UI look and feel](ui-look-and-feel.md) — live-reference control structure, reconstruction styling, responsive behavior and painter boundary.

## Working documents

Audit findings and the improvement plan live in [improvements/](improvements/README.md). They are historical working documents, not parity specification, and rank below the six evidence levels above.

Saved implementation plans and review evidence:

- [Coast fixes](plans/coast-fixes.md) — shared swash and wetness, configurable beach materials, sea tiles, sparse ecology, and validation.
- [Offshore waves](plans/offshore-waves.md) — Windrose-inspired swells, filtered surface detail, whitecaps, transmission, and live sky reflections.
- [Coast implementation review](improvements/coast-review-2026-09-12.md) — corrected findings, local rendering checks, performance comparison, and validation limits.
- [Frame-loop CPU performance pass](improvements/frame-cpu-performance-2026-09-14.md) — static matrix cache, reflection-mask cache, grass tile and interaction-map savings, fixed double snow update, before/after captures.

## Documentation quality contract

Every subsystem document should identify, where relevant:

```text
recovered evidence
source files
asset/object names
configuration keys and effective values
initialization order
per-frame behavior
formulas/constants
coordinate systems
material/shader behavior
interactions with other systems
fallbacks
known clean-room deviations
visual/behavioral validation criteria
```

If recovered code contradicts a subsystem document, fix the implementation and documentation from recovered evidence rather than preserving the older assumption.

### Effective values are checked mechanically

Do not derive effective values by reading one YAML file. Runtime currently merges:

```text
config.yaml
ground-material.yaml
player-controls.yaml
visual-parity.yaml
painter-cursor.yaml
characters.yaml
```

Use `npm run config:dump` and annotate asserted values with either:

```text
<!-- effective-config: player -->
<!-- effective: terrain.targetMeshName = Landscape002 -->
```

`npm run check:docs` validates these assertions in CI.

## Current high-value parity boundaries

The recovered Rapier player path is implemented: kinematic capsule, slope climb/slide, ground snapping and terrain trimesh colliders.

World collision is also implemented by `src/physics/WorldCollisionSystem.js`:

```text
authored world bounds      -> box colliders
tree collider definitions  -> box colliders
Lantern                     -> box colliders
Stone                       -> convex-hull colliders
WaterCollider/HouseCollider -> trimesh colliders
```

World colliders are distance-gated with active/inactive hysteresis.

The public HUD structure now follows the live reference control groups and button menus. Exact original public CSS is still a reconstruction boundary.

There is still no jump mechanic despite `player.jumpSpeed` being configured. Final fixed-camera reference captures are also required before claiming complete visual parity.

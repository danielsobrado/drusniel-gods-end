# RPG Grass

Clean-room reconstruction of a browser-delivered reference demo using Three.js. The repository contains newly written application code plus copied reference assets used for parity validation.

The default presentation now uses a cinematic art pass. See [Cinematic rendering](docs/cinematic-rendering.md) for the lighting, quality budgets, procedural locomotion, and visual review notes. This intentionally changes the recovered look.

## Parity rule

For parity work, use this evidence order:

```text
1. recovered browser-delivered code
2. recovered literal asset/object names and constants
3. current executable code implementing recovered behavior
4. effective merged YAML configuration
5. subsystem documentation
6. screenshot inference
```

Start with `docs/README.md`. Do not tune around a contradiction before checking recovered evidence.

## Implemented reference systems

- `WebGPURenderer` with TSL/node materials and optional WebGL backend
- recovered terrain/ground blend using `Landscape002` and `Landscape046`
- camera-centered tiled grass with four quality LODs
- recovered single-quad billboard grass path
- player-centered persistent grass interaction
- recovered hard-circle Grass Painter with Add/Erase mask export
- Samurai GLB with exact `Idle`, `Walk.001`, `Run` actions
- camera-relative player locomotion and third-person shoulder camera
- recovered Rapier player capsule/terrain collision
- recovered world, tree, Stone, Lantern and named collision proxies
- recovered authored tree and prop world transforms
- high-detail tree foliage plus instanced far-tree representation
- zone-aware falling leaves with automatically detected texture variants
- cloned/animated birds with deterministic orbit behavior
- procedural TSL sky and recovered horizontal cloud plane
- recovered GPU-instanced rain and wet-material response
- recovered generated water plane, geometric waves and one-time cube reflection
- seven environment presets with five-second `power2.inOut` transitions
- wind/rain/insect/lake/bird/footstep audio
- reference-structured custom-button HUD plus reconstruction styling
- lifecycle cleanup, config validation and resilience fallbacks

## Run

```bash
npm ci
npm run dev
```

Validation/build:

```bash
npm run lint
npm test
npm run check:docs
npm run build
```

## Controls

Gameplay:

```text
WASD        move
Shift       sprint
click       pointer lock / browser-audio unlock
mouse       look while pointer locked
```

Mobile uses the on-screen movement/look controls.

Grass Painter:

```text
LMB         paint
RMB         rotate
Shift+RMB   pan
MMB         zoom
1           Add Grass
2           Erase
[ / ]       brush size
8           save mask
P           continuous paint toggle
```

Mouse wheel zooms the third-person camera between `camera.minDistance` and `camera.maxDistance` on desktop. Desktop drag-look outside painter mode is still not exposed.

## Configuration

Runtime configuration is deep-merged in this order:

```text
1. public/config.yaml
2. public/ground-material.yaml
3. public/player-controls.yaml
4. public/visual-parity.yaml
5. public/character-visual.yaml
6. public/cinematic-wind.yaml
7. public/cinematic-look.yaml
8. public/painter-cursor.yaml
```

Nested objects merge recursively. Arrays and scalar values replace the earlier value. Use `npm run config:dump` instead of merging these files manually.

## Asset contract

Reference assets live under `public/Assets/`. Names inside `terrain2.glb` and `Samurai-v1.glb` are runtime metadata, including terrain targets, tree sources, zones, collision proxies, bird source, animation names and `FootSphere` helpers. Authored world transforms are stored in `public/tree-world.json` and `public/world-props.json`.

Read `docs/asset-contract.md` before replacing an asset.

## Documentation

Use `docs/README.md` as the index. The most important documents are:

```text
docs/recovered-original-parity.md
docs/ai-reproduction-playbook.md
docs/visual-parity-checklist.md
docs/reference-parity.md
docs/config-reference.md
docs/asset-contract.md
docs/runtime-lifecycle.md
```

Subsystem documents separate recovered reference behavior from clean-room adapters and fallbacks.

## Validation boundary

Passing lint/tests/build proves repository consistency, not final visual parity. Before calling the reconstruction complete, compare fixed-camera captures of the reference and this implementation for Sunny, Golden Hour, Rain, Wind, Moonlight, multiple quality levels, both grass types and Grass Painter.

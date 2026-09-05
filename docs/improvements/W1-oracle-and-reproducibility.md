# W1 — Oracle and reproducibility

**Effort** ~6-8h · **Gates** everything else · **Render risk** none (no `src/` behavior changes)

Two problems, both of which make every later change unverifiable:

1. The acceptance oracle asserts values the runtime does not use.
2. The renderer dependency floats, so "it looks different" is ambiguous between a code change and a dependency resolution.

---

## 1. Lockfile

Do this first. It takes fifteen minutes and it removes the largest uncontrolled variable in the repository.

[../../package.json](../../package.json) pins `three` at `^0.180.0`. No lockfile is committed, and [../../.github/workflows/ci.yml](../../.github/workflows/ci.yml) line 21 runs `npm install`, not `npm ci`. A `three` 0.181 release changes TSL codegen. With no lockfile there is no way to distinguish *"the scene looks different because of my refactor"* from *"the scene looks different because npm resolved a new minor."*

For a visual-parity project, a floating renderer is a larger uncontrolled variable than every refactor in W3 combined.

```text
npm install --package-lock-only
```

Commit the result — [../../.gitignore](../../.gitignore) does not exclude it. Then change the CI step to `npm ci`.

All five dependencies float: `three ^0.180.0`, `@dimforge/rapier3d-compat ^0.20.0`, `js-yaml ^4.1.0`, `vite ^7.1.4`, `wrangler ^4.0.0`. The lockfile pins all of them; leave the `^` ranges in `package.json` as they are.

**Checklist**
- [ ] `package-lock.json` committed
- [ ] CI uses `npm ci`
- [ ] `rm -rf node_modules && npm ci && npm run build` succeeds

---

## 2. Make effective configuration derivable

Configuration is deep-merged from four files at runtime ([../../src/config/loadConfig.js](../../src/config/loadConfig.js)):

```text
1. public/config.yaml
2. public/ground-material.yaml
3. public/player-controls.yaml
4. public/visual-parity.yaml
```

Obtaining an effective value today requires mentally merging four files. That is precisely why the drift in section 4 happened — every wrong value in the documents is a *pre-override* value that was correct against `config.yaml` alone.

- Export `mergeConfig` from `loadConfig.js`. It is currently module-private; exporting is behavior-neutral.
- Add `scripts/dump-config.mjs` reading the four YAML files from `public/` and merging them **through that same exported function**, so the script and the application cannot diverge. Expose as `npm run config:dump`.

### Merge semantics worth writing down

`mergeConfig` recurses only when *both* sides are plain objects (`isRecord`). Arrays are replaced wholesale, not merged or concatenated.

This is not a hypothetical. `config.yaml` lines 207-216 define `trees.types` as `{ zone, leaves }` entries; `visual-parity.yaml` lines 64-73 define a same-length `trees.types` as `{ zones, highLeaves, collider }` entries. Because arrays replace, **the entire `config.yaml` block is dead configuration.** [../../src/world/TreeSystem.js](../../src/world/TreeSystem.js) defensively reads both spellings (`definition.highLeaves ?? definition.leaves` at line 156, `source.zones ?? (source.zone ? [source.zone] : [])` at line 201), so nothing is broken today — but anyone editing the `config.yaml` block will see no effect whatsoever.

The same landmine applies to `ground.materialTargets`. Document the rule prominently in [../config-reference.md](../config-reference.md).

**Checklist**
- [ ] `mergeConfig` exported
- [ ] `scripts/dump-config.mjs` added, `npm run config:dump` works
- [ ] Array-replace rule documented in `config-reference.md`
- [ ] Dead `trees.types` block in `config.yaml` annotated as superseded

---

## 3. Mechanical doc guard

A one-time correction has already been tried and already failed (see [README.md](README.md)). The check must be mechanical.

Add `scripts/check-docs-config.mjs`, exposed as `npm run check:docs`. It walks `docs/**/*.md`, finds **opt-in annotated blocks**, parses them with `js-yaml`, and asserts every leaf equals the merged configuration at that path.

```markdown
<!-- effective-config: player -->
​```yaml
modelOffsetY: -2.2
walkSpeed: 2.5
​```
```

Plus a scalar form for single names:

```markdown
<!-- effective: terrain.targetMeshName = Landscape002 -->
```

Failure output should name the file, line, path and both values:

```text
docs/visual-parity-checklist.md:73  player.modelOffsetY: doc says -0.2, effective is -2.2
```

### Why opt-in and not "check every yaml block"

Many fenced blocks in `docs/` are legitimately *not* effective config: recovered-original values, deliberate single-file pre-merge values, code constants, and illustrative snippets. Auto-checking all of them produces noise, and a noisy check gets switched off. Opt-in also scales the section 4 work — annotate the seven `modelOffsetY` blocks, run the checker, and it enumerates every wrong value for you.

### Red-green discipline

**Build the checker before correcting the documents, and require it to FAIL on the current tree** across the known-bad set:

```text
modelOffsetY    7 sites
targetMeshName  10 sites
fov / far       3 sites
speeds          2 sites
player.start    1 site
```

A checker that passes on a tree you already know is broken is worthless. Only after it reports all of those should the corrections land.

**Checklist**
- [ ] Checker written, fails on current tree across the known-bad set
- [ ] Wired into CI so a commit touching `public/*.yaml` cannot merge with stale docs
- [ ] Rule added to the "Documentation quality contract" section of [../README.md](../README.md)

---

## 4. Correct the documents

Order matters — the checklist is the oracle, so it goes first.

### 4.1 The acceptance oracle

[../visual-parity-checklist.md](../visual-parity-checklist.md):

| Line | Asserts | Effective | Source of override |
|---|---|---|---|
| 35 | `fov: 52` | `45` | `visual-parity.yaml:25` |
| 37 | `far: 6000` | `10000` | `visual-parity.yaml:27` |
| 71 | `start: [2, 0, -5]` | `[2, 5, -5]` | `visual-parity.yaml:9` |
| 73 | `modelOffsetY: -0.2` | `-2.2` | `player-controls.yaml:27`, `visual-parity.yaml:11` |
| 81-83 | walk 4.2 / run 7.2 / turn 10 | 2.5 / 15 / 18 | `visual-parity.yaml:15-23` |
| 114, 150 | `Landscape046` | `Landscape002` | `visual-parity.yaml:7` |

### 4.2 `modelOffsetY` — seven sites

`-0.2` → `-2.2` in:

```text
ai-reproduction-playbook.md:139
asset-contract.md:488
camera-system.md:60
character-rig-and-armour.md:72
config-reference.md:409
player-controller.md:146
visual-parity-checklist.md:73
```

[../player-system.md](../player-system.md) already has it right and explains why it matters: `-0.2` makes the visible Samurai sit about two world units too high relative to the Rapier capsule and terrain.

### 4.3 `targetMeshName` — ten sites

`Landscape046` → `Landscape002` in `asset-contract.md` (lines 125, 174, 181, 197, 211, 778) and `ai-reproduction-playbook.md` (lines 155, 200, 295, and the object list at 377).

**Not a blanket find-replace.** `Landscape046` is legitimately correct in `ground.materialTargets` — the ground *material* is applied to both meshes, while only `Landscape002` is the height-sampling target. `ai-reproduction-playbook.md:377` ("Apply the generated material to `Landscape002` and `Landscape046` when present") is already correct and must be left alone.

`terrain-system.md`, `camera-system.md`, `player-system.md` and `../README.md:44` already say `Landscape002`.

### 4.4 Player physics claims

[../player-controller.md](../player-controller.md) line 41 states the controller *"does not implement a physics engine, jumping, root motion or obstacle collision,"* and its section 30 lists `gravity`, `slope sliding`, `capsule collision` and `Rapier physics` as absent.

[../../src/player/PlayerPhysics.js](../../src/player/PlayerPhysics.js) is a complete Rapier kinematic character controller: kinematic capsule body (lines 34-48), 45°/60° slope climb and slide angles (lines 7-8, 31-32), terrain trimesh colliders built from GLB geometry (lines 52-79). It is constructed at `PlayerController.js:136-149` and integrated every frame at `PlayerController.js:344-364`.

Jumping genuinely is absent — `player.jumpSpeed: 8` is configured but there is no jump key in `MOVEMENT_KEYS` and no jump mechanic. Keep that line; correct the rest.

Related: [../README.md](../README.md) line 105 says *"the full Rapier player/prop/tree collision path is not yet reproduced."* The prop and tree halves are still accurate; the player half is not. Narrow the claim rather than deleting it.

### 4.5 Stale movement and camera values

`player-controller.md` lines 327-329, 344-353 and 496 give walk 4.2 / run 7.2 / turn 10 / acceleration 10 / deceleration 14 / fade 0.16. Effective values from `visual-parity.yaml:15-23` are 2.5 / 15 / 18 / 20 / 16 / 0.25. `camera-system.md` lines 61-66 already has the correct set — a direct document-to-document contradiction.

Also missing from both effective listings: `player.gravity: -25` (consumed at `PlayerPhysics.js:28` and `PlayerController.js:345`).

`config-reference.md` lines 69-76 list `fov: 52` / `far: 6000`; effective is 45 / 10000. The same section cites `PlayerController.#getDefaultCameraDistance()`, **which does not exist** — the real selection is inline at `PlayerController.js:63-65` and `:436-438`. Also absent from its table: `camera.initialPosition`, `controls.safariLookMultiplier`, `controls.mobileLookSensitivity`, `controls.mobileJoystickRadius`.

### 4.6 "Unused" claims that are wrong

| Document | Claim | Reality |
|---|---|---|
| `config-reference.md:433` | `capsuleHalfHeight` / `capsuleRadius` unused | `PlayerPhysics.js:42-45` builds the player collider from both |
| `grass-system.md:396` | `bladeSide` not read | `GrassMaterial.js:111` declares it, `:132-141` drives `normalNode` with it |
| `grass-system.md:1358`, `config-reference.md:269` | `useTextureColor` / `atlasColumns` / `atlasRows` unconsumed | `GrassMaterial.js:656-683` reads all three whenever grass type is `billboard`, a UI-selectable mode |
| `lod-system.md:938-962`, `config-reference.md:544-552` | `highHysteresis` / `billboardHysteresis` / `transitionDuration` / `windFrequency` not wired | `TreeSystem.js:362,365-366,370-371,387` and `TreeLeafMaterial.js:19-22,34-52` consume them |

### 4.7 Tree LOD section describes code that does not exist

`lod-system.md` lines 786, 817-818, 860-870, 920-925, 953 describe a hardcoded `TRANSITION_WIDTH = 16`, a continuous `smoothstep` distance blend, a low model that rotates to face the camera each frame via `atan2`, and `entry.high.rotation.z` wind sway. Grepping `TreeSystem.js` for `TRANSITION_WIDTH`, `atan2` and `rotation.z` returns zero matches.

The actual implementation:

```text
#desiredLod()      TreeSystem.js:359-372   hysteresis state machine on config thresholds
#transition()      TreeSystem.js:374-402   opacity cross-fade over trees.transitionDuration
#buildBillboards() TreeSystem.js:271-310   pre-baked InstancedMesh, fixed rotation, never camera-facing
leaf wind          TreeLeafMaterial.js     TSL vertex shader, not an Euler rotation
```

Rewrite the section against the code.

### 4.8 Interaction map scroll truncation

`InteractionMap.#scroll()` truncates the **per-frame** delta (`Math.trunc(delta * pixelsPerWorldUnit)` at lines 70-71), so sub-pixel motion is discarded rather than accumulated — walking slowly never scrolls the map. This is baked into how the scene currently behaves.

Record it in [../grass-interaction.md](../grass-interaction.md) as current behavior. **Do not change it** (see W3 section 3).

### 4.9 `painterEnabled` — document only, decided

[../../src/grass/GrassMaterial.js](../../src/grass/GrassMaterial.js) line 69 reads `config.painter.enabled` **once, at construction**, and bakes it into the TSL graph as a plain JavaScript ternary at lines 186, 334, 363, 509 and 533. No setter exists.

The live painter state is a different object entirely: `GrassPainter.enabled`, toggled by `GrassField.togglePainter()` (`GrassField.js:155`) from the UI button (`DemoUi.js:123`). `painter.enabled` is `false` in `config.yaml:133` with no override in any of the other three files.

Net effect: **that shader branch is unreachable.** The material always compiles the non-painter path.

Wiring it live would change painter-mode rendering in three ways — blades currently killed by `bounds ∧ frustum ∧ withinDistance` would render, and the `useDetail` (`maxDistance·0.5`) and `useDetailedWind` (`maxDistance·0.7`) thresholds would be bypassed, compounding with the existing forced `lodName = 'low'` at `GrassField.js:235`. Expect a significant painter-mode performance drop, since per-blade GPU culling is what keeps that mode interactive.

Under the repository's own rule this is not obviously a bug to fix. **Decision: document it in [../grass-painter.md](../grass-painter.md), change no code.** Record the construction-time-only behavior, the two-variable split, and the fact that the branch is dead. If it is ever wired up, that is a separate, explicitly-revertable commit requiring a parity re-baseline of both the painter and non-painter states — the compiled shader graph changes even when the flag is off, because a static-folded branch becomes a dynamic one.

### 4.10 Absent config keys

`config.assets.grassAtlas` is read at `GrassAtlas.js:52` but exists in **none** of the four YAML files, so the demo always falls back to a procedurally-drawn canvas atlas (`GrassAtlas.js:20-49`) with a console warning. Document the absence in `config-reference.md` and `asset-contract.md`. Adding the key would change billboard rendering, so this is a documentation item only.

`config.ground.surfaceResolution` and `config.ground.sourceTerrainMeshes` are read by `src/world/TerrainSurface.js`, which is never imported (see W3 section 1). Both are moot; the module is slated for deletion.

### 4.11 Dead configuration to annotate

Zero consumers anywhere in `src/`:

```text
ground.anisotropy, ground.metalness,
ground.grassTextureScale, ground.groundTextureScale    GroundMaterial.js:13-16 hardcodes matching constants
camera.distance, camera.minDistance, camera.maxDistance  only controls.desktopDistance/mobileDistance are read
camera.controls.zoomSensitivity, .zoomSharpness          there is no wheel handler at all
player.jumpSpeed                                          no jump mechanic exists
```

The zoom keys are worth flagging loudly: `config-reference.md` section 2 lists them unannotated, as if live, and the root `README.md` documents `wheel  zoom` under Controls — but no wheel event listener exists anywhere in the codebase. Either the control is missing or the documentation is; record which.

`config-reference.md` lines 175-183 lists all four `ground.*` keys as active. They are not.

**Checklist**
- [ ] 4.1 checklist corrected (do first)
- [ ] 4.2 seven `modelOffsetY` sites
- [ ] 4.3 ten `targetMeshName` sites, `materialTargets` mentions preserved
- [ ] 4.4 physics claims corrected, jump exception preserved, `../README.md:105` narrowed
- [ ] 4.5 movement/camera values, `#getDefaultCameraDistance()` reference removed
- [ ] 4.6 four "unused" claims corrected
- [ ] 4.7 tree LOD section rewritten against code
- [ ] 4.8 scroll truncation recorded
- [ ] 4.9 `painterEnabled` documented, no code touched
- [ ] 4.10 absent keys documented
- [ ] 4.11 dead config annotated, wheel-zoom discrepancy resolved

---

## 5. Structural fix — the duplicate player document

Two documents describe the player subsystem and contradict each other, and **only the inaccurate one is indexed.** [../player-system.md](../player-system.md) is accurate (correct `-2.2`, correct Rapier description, correct capsule values) but appears nowhere in [../README.md](../README.md). [../player-controller.md](../player-controller.md) is linked from the index and carries every error in sections 4.4 and 4.5.

Leaving both, with one unlinked, guarantees recurrence. Either fold `player-system.md` into `player-controller.md`, or point the index at `player-system.md` and delete the other. Do not leave two.

**Checklist**
- [ ] One player document, reachable from `docs/README.md`
- [ ] `docs/README.md` index lists every file in `docs/` and no file that does not exist

---

## Verification

```text
npm run config:dump                          prints the merged configuration
npm run check:docs                           must FAIL pre-fix on the known-bad set, pass after
rm -rf node_modules && npm ci && npm run build   succeeds from the lockfile
```

Then spot-check by hand that `npm run check:docs` catches a deliberately reintroduced error: change one annotated `modelOffsetY` back to `-0.2` and confirm the checker names the file, line and both values.

No `src/` file is modified in W1, so no visual parity check is required. Capture the ten fixed-camera reference states listed in the root `README.md` at the end of W1 — with a corrected checklist and a pinned dependency tree, this is the first point at which those captures are trustworthy, and W3 needs them as its baseline.

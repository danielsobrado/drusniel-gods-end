# W3 — Hot path

**Effort** ~7-9h · **Sections 1-2 depend on** W1 · **Section 3 depends on** W2 · **Render risk** none by construction

Every change here is behavior-neutral, and each carries an explicit argument for why. Several plausible optimizations were **deliberately rejected** because the neutrality argument does not hold — those are recorded too, so they do not get "discovered" and applied later.

Quantities below are measured against the real merged configuration:

```text
grass.interaction.resolution  256      → 65,536 iterations per recovery pass
grass.tileSize                25
quality.high.blade.maxDistance 140     → gridSize 13 → 169 tiles
tree-world.json                        → 504 trees
leaves.count                  1000     → ~334 per zone
```

## Before starting

Capture the ten fixed-camera reference states from the root `README.md` (Sunny, Golden Hour, Rain, Wind, Moonlight, Performance, High, Blade, Billboard, Grass Painter). **Capture them after W1**, not before — the checklist that defines them is wrong until then, and the dependency tree is unpinned.

No commit in this workstream is intended to change output, so any visible difference against those captures is a regression.

---

## 1. Land immediately — trivially neutral

One commit, no argument required.

### Hardcoded fall-recovery spawn

[../../src/player/PlayerController.js](../../src/player/PlayerController.js) line 361:

```js
if (result.position.y < this.spawnPosition.y - FALL_RESET_HEIGHT) {
  this.setPosition(2, 5, -5);
```

`(2, 5, -5)` is a magic-number copy of `config.player.start`. Line 143 in the same file already does it properly:

```js
this.setPosition(...this.config.player.start);
```

Effective `player.start` is `[2, 5, -5]` (`visual-parity.yaml:9`), so the literal and the config are currently byte-identical — this is making line 361 match line 143, not changing behavior. It only works today by coincidence; editing `player.start` in either YAML silently desyncs fall-recovery from the actual spawn point.

Note in passing: `this.spawnPosition` (line 85) is seeded from `config.camera.initialPosition`, not `config.player.start`, and is used only for this Y-threshold comparison. Confusing name, not a defect — leave it, or rename it in the same commit.

### Dead module

Delete [../../src/world/TerrainSurface.js](../../src/world/TerrainSurface.js) — 45 lines, exported but never imported anywhere in `src/`. (`createWorld.js:36` matches only the unrelated string literal `'FallbackTerrainSurface'`.) It also reads two config keys that exist in no YAML file, so deleting it removes a phantom configuration surface. Git retains the history.

### Dead methods

`GrassField.setBladeHeight()` (`:143-145`), `setPainterEnabled()` (`:151-153`) and `getEstimatedBladeCount()` (`:242-249`) have zero callers. The UI's blade-height slider actually routes through `EnvironmentController.setGrassParameter` → `GrassMaterial.setPreset`, and the painter toggle uses `togglePainter()`.

**Checklist**
- [ ] `PlayerController.js:361` reads config
- [ ] `TerrainSurface.js` deleted
- [ ] Three `GrassField` methods deleted
- [ ] Build green, app starts, player still recovers from a fall

---

## 2. Provably neutral — land individually

One commit each, so any of them can be reverted alone if a capture diff appears.

### 2.1 Per-leaf `Euler` allocation

[../../src/foliage/LeafSystem.js](../../src/foliage/LeafSystem.js) line 92:

```js
this.quaternion.setFromEuler(new THREE.Euler(
  elapsedSeconds * 0.8 + particle.phase,
  particle.phase,
  elapsedSeconds * 1.1 + particle.phase * 0.5,
));
```

Up to 334 allocations per frame, roughly 20,000 per second. `setFromEuler` reads `_x/_y/_z/_order` and does not retain the object, so hoisting to a reused `this.euler.set(...)` is exact. The class already keeps reusable `quaternion`, `matrix` and `scale` members (lines 14-16); the `Euler` is the one that was missed.

While here: line 99 calls `this.meshes.get(particle.zone)` inside the loop, though line 78 has already `continue`d every particle whose zone differs from `this.currentZone`. The lookup is redundant up to 334 times per frame — hoist it above the loop.

### 2.2 Tile key strings

[../../src/grass/GrassField.js](../../src/grass/GrassField.js) line 225 builds a template literal per tile per frame purely to probe a `Set`:

```js
const key = `${tile.mesh.userData.tileX}:${tile.mesh.userData.tileZ}`;
```

169 string allocations per frame at high quality, 361 at ultra, for data that changes only when the camera crosses a tile boundary. The same key is built again at line 165 in `remapEmptyTiles()`.

Replace the `Set<string>` with a per-tile `isEmpty` boolean written in `remapEmptyTiles()`, which already iterates the same tile objects.

**Record this in the commit message:** during `#applyQuality`, `remapEmptyTiles()` runs while all tiles are still at position (0,0) with `userData.tileX === undefined`, so today *every* tile collapses onto the single key `"undefined:undefined"`. Per-tile flags give each tile its own entry — which is equivalent, because all tiles are at the same position and `tileHasGrass` returns the same answer for all of them. And `cameraTile` is `NaN` at that point, so `#repositionTiles()` re-runs before the next render regardless. The change is neutral, but the reasoning is non-obvious enough to write down.

### 2.3 Bounding sphere recomputed every frame

`PlayerController.js:457-469`, called every frame through `GrassDemo.js:186`:

```js
object.geometry?.computeBoundingSphere?.();
```

This walks every vertex of the geometry's local position attribute. Because those are raw local positions rather than GPU-skinned output, the result is invariant frame to frame. Compute once after the model loads.

Also hoist the two `new THREE.Vector3()`, the `.map()` and the two `{ position, radius }` object literals into a reused fixed-length array. The consumer (`InteractionMap.paintSphere`) reads them synchronously within the frame and never retains them, so reuse is safe.

### 2.4 Terrain centre recomputed every frame

`GrassField.js:204` (every frame) and `:174` (on every tile-boundary crossing):

```js
const terrainCenter = this.terrainSampler.bounds.getCenter(new THREE.Vector3());
```

`TerrainSampler.bounds` is written only inside `build()` (line 31) and `#buildFlatFallback()` (lines 73-76), never afterwards. `GrassField.init()` runs at `GrassDemo.js:87`, after `createWorld` at `:36`, so the bounds are final by then. Cache the centre in `init()`.

### 2.5 Quality lookup inside the per-tile loop

`GrassField.js:191` — `#selectLod()` re-resolves `#getQuality()` (two property indirections through `config.quality[qualityName][type]`) once per visible tile, though `update()` already resolved it at line 213. Hoist `this.#getQuality().lod` out of the loop and pass it in.

### 2.6 Full tree scan for a boolean

[../../src/world/TreeSystem.js](../../src/world/TreeSystem.js) line 414 walks all 504 trees every frame:

```js
for (const tree of this.trees) this.#updateTransition(tree, deltaSeconds);
```

`#updateTransition` early-returns immediately for any tree with `transitioning === false`, which is nearly all of them nearly all the time. Maintain a `Set` of transitioning trees instead: add in `#transition()` (line 377, where `transitioning = true`), remove in `#updateTransition()` (line 398, where it is cleared). Exact, and order-independent — each tree touches only its own materials and its own instance index.

**Do not touch the second loop at line 420.** It is already throttled by `trees.lodUpdateInterval` (0.1s), and line 421 is a `continue`, not a filter — it must visit every non-transitioning tree to evaluate the hysteresis thresholds. Restricting it would break LOD switching.

### 2.7 `Object.entries` per frame

[../../src/audio/AudioSystem.js](../../src/audio/AudioSystem.js) line 70:

```js
for (const [key, audio] of Object.entries(this.loops)) this.#fade(audio, this.targets[key], deltaSeconds);
```

`this.loops` has four fixed keys that never change after construction; this allocates one outer array plus four pair arrays every frame, and runs before the `enabled` gate on the next line. Precompute the entry list in the constructor.

### Rejected — `ZoneIndex`

[../../src/world/ZoneIndex.js](../../src/world/ZoneIndex.js) line 24 does a full linear box scan every frame with no "still in the same zone" fast path. It looks like an easy win and it is not one: `getZone` returns the **first** match in `Map` insertion order, so checking the current zone's boxes first can flip which zone wins wherever boxes overlap. Proving the zones never overlap costs more than the roughly 500 `containsPoint` calls it would save. Leave it.

**Checklist**
- [ ] 2.1 leaf `Euler` hoisted, mesh lookup hoisted
- [ ] 2.2 tile flags replace string keys, reasoning in commit message
- [ ] 2.3 bounding sphere computed once, influence array reused
- [ ] 2.4 terrain centre cached in `init()`
- [ ] 2.5 quality lookup hoisted
- [ ] 2.6 transitioning set; line 420 loop untouched
- [ ] 2.7 audio entries precomputed
- [ ] `ZoneIndex` left alone

---

## 3. Behind the W2 harnesses

The two largest wins. Both have a naive form that looks obviously correct and is wrong.

### 3.1 `InteractionMap` — key on ink, not on `enabled`

[../../src/grass/InteractionMap.js](../../src/grass/InteractionMap.js):

```text
:48  #recover()               65,536 iterations, EVERY frame, before the enabled check at :50
:59  texture.needsUpdate      unconditional → 256KB DataTexture upload every frame
:43  new THREE.Vector2        per frame
```

This runs in full when interaction is toggled off in the UI and when the player is standing still.

**The naive fix violates a written acceptance criterion.** Skipping recovery when `enabled === false` freezes existing bends on screen permanently, but [../visual-parity-checklist.md](../visual-parity-checklist.md) line 324 requires:

> disabling Foot Interaction stops new bending while old influence fades.

Key on **whether any ink is present**, not on the flag:

- Track `this.peak`, an integer high-water mark of the red channel. Update it in `paintSphere` at line 118.
- `#recover()`: return early when `peak === 0`; otherwise run the loop and set `peak = Math.floor(peak * recoverySpeed)`.
- `#scroll()`: skip when `peak === 0`.
- `texture.needsUpdate`: set only when bytes actually changed — ink was present before recovery, or a paint happened, or `clear()` ran.
- `clear()` resets `peak = 0`. **`setEnabled()` must not** — leaving decay running is exactly what line 324 requires.
- Hoist the per-frame `Vector2` at line 43 to a scratch member.

**Why this is exact, not approximate.** `Math.floor` is monotonic, so for any pixel `p ≤ peak`, `floor(p·r) ≤ floor(peak·r)`. Once `floor(peak·r)` reaches 0, every pixel is 0, and `floor(0·r) = 0` — the loop is bit-exact idempotent from then on, so skipping it changes nothing. The scroll skip is exact for the same reason: scrolling only translates values, the green and blue channels are never written non-zero anywhere in the class, and alpha is 255 in both `#clearPixels` and the scroll write, so translating an all-zero red channel reproduces an identical buffer.

Payoff: the 65,536-iteration loop and the 256KB upload both disappear whenever the player stands still, and permanently once interaction is disabled and the residual ink has faded.

**Do not also "fix" the scroll truncation.** `#scroll()` truncates the *per-frame* delta at lines 70-71, so sub-pixel motion is discarded rather than accumulated and slow walking never scrolls the map. That is baked into how the scene currently looks. It is documented in W1 section 4.8; leave the code alone.

### 3.2 `EnvironmentController` — settle latch

[../../src/world/EnvironmentController.js](../../src/world/EnvironmentController.js) lines 152-179 have no early-out. Once a preset transition finishes, forever, every frame:

```text
4 array literals      the `for (const field of [...])` loops at :90, :164, :169
1 object literal      :201  grass.setPreset({ grass: ... })
1 spread + toArray    :204-207  sky.setPreset({ ...current.sky, sunPosition: ....toArray() })
~14 Color copy/lerp pairs
~30 uniform writes    across both grass materials, sky, clouds and fog
```

**The neutrality argument is frame-to-frame idempotence, not `lerp(a,b,1) === b`.** In IEEE-754, `a + (b − a)·1` is not guaranteed bit-equal to `b`, so do not rest the case on the endpoint. Rest it on this instead: once `elapsed` saturates at `TRANSITION_SECONDS`, `start`, `target` and `t` are all frozen, so every subsequent frame recomputes the *bit-identical* value it produced the frame before, and `#apply()` writes bit-identical uniforms. Skipping frames 2..N is exact regardless of the endpoint question.

That dictates the shape — **one full converged update, then latch:**

```js
update(dt) {
  if (this.#settled) return;
  // ...existing body unchanged...
  if (this.elapsed >= TRANSITION_SECONDS) this.#settled = true;
}
```

Never latch on the *previous* frame's `elapsed`, or the converged `#apply()` never runs and the transition ends one frame short of its target.

**The trap.** `#apply()` at lines 198-200 reads `config.quality[this.quality].fogMultiplier` and writes `scene.fog.density`. But `setQuality()` at lines 139-141 only assigns `this.quality`:

```js
setQuality(name) {
  if (this.config.quality[name]) this.quality = name;
}
```

It relies entirely on the next `update()` to push the value through. Once latched — and settled is the steady state, since quality is changed long after any preset transition — **a quality change would never update fog density.** Visible regression, covered by two checklist sections. `setQuality()` must call `#apply()` or clear the latch. `setPreset()` must clear the latch (it already resets `elapsed = 0`). `setGrassParameter()` already calls `#apply()` itself and is safe as-is.

Verified prerequisites: `GrassMaterial.setPreset` (lines 696-709) is pure assignment and fully idempotent, and nothing outside the class reads `environment.current`, so the write-only `current.rain` at line 177 is safe to stop updating. **Still confirm before landing** that `trees.setWindStrength`, `clouds.setCoverage` and `sky.setPreset` are pure setters with no phase or time accumulation.

**Checklist**
- [ ] W2 harnesses exist and pass first
- [ ] 3.1 peak tracking; `setEnabled` does not reset it; scroll truncation untouched
- [ ] 3.2 latch set *after* the converged update; `setQuality` and `setPreset` clear or re-apply
- [ ] Downstream setters confirmed pure
- [ ] Both differential harnesses byte-identical across the full walk

---

## 4. Deduplication — last, and strictly parameterized

Do this after everything above, and only as parameterized helpers that preserve each call site's exact current values.

### Texture setup — 8 copies

```text
GroundMaterial.js:18-36    loadTerrain.js:11-17     WorldPropSystem.js:12-19
GrassAtlas.js:8-18         TreeSystem.js:85-89      TerrainSampler.js:106-112
GrassMask.js:28-34         InteractionMap.js:25-29
```

Neutral **only** if each site keeps its exact property set. The sites genuinely differ: `TerrainSampler:107` and `GrassMask:30` set `flipY = false`; `InteractionMap` does not. A "one true helper" that normalizes silently flips two textures. Verify by diffing the resulting property set per site before and after.

### Shadow and rain-roughness traversal — 4 copies

```text
loadTerrain.js:19-25        rainRoughness 0.1
PlayerController.js:114-121 rainRoughness 0.1 (config.player.rainRoughness ?? 0.1)
TreeSystem.js:38-56         rainRoughness 0.4   ← different
WorldPropSystem.js:21-25    rainRoughness 0.1
```

Neutral **only** if `rainRoughness` stays a parameter. Unifying the constant changes one material. This is the trap in this cluster.

### Rejected — `getObjectByName` helper

13+ call sites (`TerrainSampler.js:14`, `loadTerrain.js:60`, `WaterSurface.js:23,53`, `BirdSystem.js:28`, `WorldPropSystem.js:61-62`, `TreeSystem.js:154-157,207`, `ZoneIndex.js:9`, `createWorld.js:47`, others), each with its own warn / throw / silent convention. Checklist section 23 explicitly tests failure-path behavior with a missing optional asset, so unifying the convention *is* a behavior change in precisely the dimension that section measures. Low payoff, real risk. Leave it.

**Checklist**
- [ ] Texture helper parameterized; per-site property sets diffed, `flipY` preserved
- [ ] Traversal helper parameterized; 0.4 preserved for trees
- [ ] `getObjectByName` left alone

---

## Verification

**Automated:** both W2 differential harnesses byte-identical across the randomized walk; `npm test` and `npm run lint` green.

**In-app** (`npm run dev`) — each of these targets a specific risk above:

```text
grass bends underfoot and recovers                         3.1
bends still FADE after toggling Foot Interaction off       3.1, checklist :324
switching quality still changes fog density                3.2, the setQuality trap
preset transitions still run their full five seconds       3.2, latch timing
tree LOD still cross-fades without popping                 2.6
leaves still tumble and respawn correctly                  2.1
grass tiles still appear and cull at boundaries            2.2, 2.4, 2.5
player still recovers from falling off the terrain         1
```

**Parity:** diff the ten fixed-camera captures taken at the end of W1. No commit in this workstream is intended to change output, so **any visible difference is a regression** — bisect to the individual commit rather than tuning around it.

**Measurement:** compare `renderer.info.render.triangles` and frame timing before and after, on the same fixed camera state. Triangle count should be unchanged; frame time should drop.

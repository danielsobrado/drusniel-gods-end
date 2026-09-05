# W4 — Lifecycle and robustness

**Effort** ~7h · **Depends on** W1 · **Parallel with** W3 (disjoint concerns) · **Render risk** none — failure-path and teardown behavior only

Nothing in this application is ever torn down, and failures surface either as a cryptic `TypeError` at startup or as a silently frozen frame at runtime.

Impact today is muted: [../../src/main.js](../../src/main.js) constructs exactly one `GrassDemo` per page load and never disposes it. These become real defects the moment the demo is remounted, embedded in a page that routes, or hot-reloaded during development.

---

## 1. Event listeners

39 `addEventListener` calls across six files. **Zero** `removeEventListener`. **Zero** `AbortController`. Every handler is an anonymous arrow, so none of them could be removed even if something wanted to.

Two of the six files are already correct, and the breakdown by target matters more than the total:

| File | Count | Targets | State |
|---|---|---|---|
| `MobileControls.js` | 11 | own DOM elements inside `this.root` | **correct** — `destroy()` line 197 calls `this.root?.remove()`, detaching the subtree so handlers become collectible |
| `AudioSystem.js` | 2 | `window`, both `{ once: true }` | **correct** — self-removing |
| `DemoUi.js` | 13 | own overlay elements | leaks: no `destroy()`, nothing removes the overlay |
| `PlayerController.js` | 6 | `domElement` ×1, `document` ×2, `window` ×3 | leaks |
| `GrassPainter.js` | 6 | `canvas` ×3, `window` ×3 | leaks |
| `GrassDemo.js` | 1 | `window` resize | leaks |

**Nine of these survive any DOM teardown** — the `document` and `window` handlers in `PlayerController` (lines 205, 208, 214, 218, 219), `GrassPainter` (lines 77, 84, 85) and `GrassDemo` (line 118). Removing the canvas or the overlay does not detach them; they hold their owning object alive and keep firing.

**Fix:** give each subsystem an `AbortController` and pass `{ signal }` to every `addEventListener`, then abort it in that subsystem's teardown. [../../src/player/MobileControls.js](../../src/player/MobileControls.js) is the in-repo pattern to follow for the shape of a `destroy()`; the signal approach generalizes it to handlers on `window` and `document`, which `root.remove()` cannot reach.

Leave the two already-correct files alone.

**Checklist**
- [ ] `AbortController` per subsystem, `{ signal }` on all 26 leaking listeners
- [ ] `MobileControls` and `AudioSystem` unchanged
- [ ] After teardown, resizing the window and pressing movement keys produce no errors

---

## 2. Dispose chain

Three classes implement a full `dispose()`:

```text
GrassField.dispose()       GrassField.js:255-262
TreeSystem.dispose()       TreeSystem.js:427-440
WorldPropSystem.dispose()  WorldPropSystem.js:91-94
```

A repository-wide search for callers of these returns **zero**. [../../src/app/GrassDemo.js](../../src/app/GrassDemo.js), the top-level orchestrator, has no `dispose()` of its own, so there is no path that could ever reach them. They are dead code that looks like cleanup.

These classes own GPU or WASM resources and have **no dispose method at all**:

```text
PlayerController   loaded GLTF materials, listeners
PlayerPhysics      Rapier World, rigid bodies, colliders, character controller
GrassPainter       OrbitControls, cursor mesh, a canvas appended to document.body
GrassMask, InteractionMap, LeafSystem, BirdSystem, RainSystem,
WaterSurface, CloudSystem, SkySystem, AudioSystem, DemoUi
```

**Fix:** add `GrassDemo.dispose()` that reaches every subsystem, and add the missing per-subsystem methods it needs to call.

[../../src/player/PlayerPhysics.js](../../src/player/PlayerPhysics.js) needs particular care: `RAPIER.World`, its rigid bodies and its colliders are WASM-backed. **JavaScript garbage collection cannot reclaim them** — the world must be explicitly freed, or every remount permanently leaks Rapier's WASM heap.

`GrassPainter` appends a canvas directly to `document.body`; that node must be removed, not just dereferenced.

**Checklist**
- [ ] `GrassDemo.dispose()` exists and reaches all subsystems
- [ ] The three existing `dispose()` methods are actually called
- [ ] Missing `dispose()` methods added, including `PlayerPhysics` freeing the Rapier world
- [ ] `GrassPainter`'s `document.body` canvas removed
- [ ] `renderer.dispose()` and `setAnimationLoop(null)` in the right order

---

## 3. Configuration validation

[../../src/config/loadConfig.js](../../src/config/loadConfig.js) checks only that each YAML file parses to a non-null object. There is no key or type checking of the merged result.

Some sites read deep paths with no guard, and would throw `TypeError: Cannot read properties of undefined` on a hand-edited or partial YAML:

```text
config.grass.interaction    InteractionMap.js:5, PlayerController.js:81-82,465, DemoUi.js:52
config.assets.audio         AudioSystem.js:24
config.assets.leaves[zone]  LeafSystem.js:24
```

The inconsistency is telling: each of those `grass.interaction` sites treats the *child* field as optional (`interaction.enabled !== false`, defaulting true when absent) while never guarding the parent object. Meanwhile `loadTerrain.js`, `loadEnvironment.js`, `GrassAtlas.js` and `GroundMaterial.js` all use `config.assets?.xxx` defensively for the very same `assets` object. The codebase already treats individual asset paths as optional — just not consistently.

**Fix:** validate at load time, and scope it to keys that are *unconditionally dereferenced*:

```text
config.grass.interaction
config.assets.audio
config.painter
config.quality[ui.initialQuality]
config.presets[initial preset]
config.terrain
config.player
config.camera
```

**Keep tolerated absences tolerated.** `assets.grassAtlas` (absent from every YAML today — see W1 section 4.10), `assets.grassMask` and `zones` are all designed to fall back with a warning. Validating them would convert checklist section 23's "continue with warnings" into a hard startup failure, which is itself a behavior change.

The goal is a named error — "`grass.interaction` missing from merged config" — instead of a `TypeError` from deep inside a constructor.

**Checklist**
- [ ] Validation covers only unconditionally-dereferenced keys
- [ ] Optional assets still fall back with a warning, not an error
- [ ] A YAML with `grass.interaction` removed produces a named error naming the key

---

## 4. Render-loop error boundary

[../../src/main.js](../../src/main.js) lines 8-15 wrap `loadConfig()` and `demo.start()` in one try/catch, so a startup throw shows "Unable to start the demo." Survivable, though with no indication of which key was wrong — section 3 addresses that.

**Nothing protects code that runs after `start()` resolves.** Neither the render loop (`renderer.setAnimationLoop(() => this.#render())`, `GrassDemo.js:121`) nor any DOM event handler has an enclosing try/catch anywhere in the codebase. Three.js re-arms the frame callback only after it returns, so an uncaught exception inside `#render()` silently freezes the last rendered frame with nothing on screen and a single console entry.

Worth noting what is *not* broken: every async path in this codebase — `loadTerrain`, `loadEnvironment`, `GrassAtlas`, `GroundMaterial`, `GrassMask.load`, `PlayerController.loadModel`, `PlayerPhysics.create`, `AudioSystem.unlock` via `Promise.allSettled`, and all `audio.play()` calls — is already properly caught. Promise handling is in good shape. The gap is specifically the ongoing render loop.

**Fix:** wrap `#render()`'s body in try/catch that **logs once behind a guard flag and continues**. Logging every frame floods the console at 60fps and makes the actual first error unfindable.

Continuing rather than stopping is deliberate: the loop keeps running today, so halting it on error would itself be a behavior change. The aim is to make the existing failure mode diagnosable, not to change it.

Consider a matching boundary in `LoadingUi`/`DemoUi` handlers, where a throw currently kills the interaction with no feedback.

**Checklist**
- [ ] `#render()` body wrapped, log-once guard flag
- [ ] Loop continues after a throw rather than halting
- [ ] A deliberate throw inside `#render()` yields exactly one console error and a still-running loop

---

## 5. Partial construction in `createWorld`

[../../src/world/createWorld.js](../../src/world/createWorld.js) lines 141-149:

```js
try {
  sky = new SkySystem(scene, config);
  clouds = new CloudSystem(scene, config);
} catch (error) {
  logger.warn('Procedural TSL sky/cloud setup failed; continuing without it.', error);
  scene.background = new THREE.Color(config.world.skyColor);
}
```

`SkySystem`'s constructor builds geometry and material and calls `scene.add(this.mesh)` before returning (`SkySystem.js:45-51`). If `CloudSystem` then throws, `sky` is already live and attached to the scene, the `scene.background` fallback is visually moot because the opaque `BackSide` sky sphere occludes it, and the half-constructed sky is never disposed.

Separately, `EnvironmentController.#apply()` line 204 uses `this.sky?.setPreset(...)`, so if both end up `null` every later preset switch silently stops updating the sky, with only the one-time startup warning to explain it.

Low likelihood — TSL node construction rarely throws — but the handler does not do what it appears to do. Either dispose and detach a partially-constructed `sky` in the catch, or construct both before adding either to the scene.

**Checklist**
- [ ] Catch leaves no half-constructed system attached to the scene
- [ ] Fallback background is actually visible when it applies

---

## Verification

No `src/` behavior changes on the success path, so the parity captures should be untouched. Confirm that first, then exercise the failure paths deliberately — each of these is the point of the corresponding section:

```text
call GrassDemo.dispose() from the console                            2
  → resizing afterwards produces no errors                           1
  → renderer.info.memory drops                                       2
  → the Rapier world is freed                                        2
  → the painter canvas is gone from document.body                    2

throw deliberately inside #render()                                  4
  → exactly one console error, loop still running

load a YAML with grass.interaction removed                           3
  → a named error, not a cryptic TypeError

load a YAML with assets.grassAtlas absent (the current state)        3
  → still falls back with a warning, does not fail

force SkySystem/CloudSystem construction to throw                    5
  → nothing half-constructed is left in the scene
```

The dispose test is the one worth doing carefully. `renderer.info.memory` returning to roughly its pre-start values is the signal that the chain in section 2 actually reaches everything, rather than reaching the three classes that already had methods.

# Bird System

This document describes the visual bird implementation exactly as it exists on current `main`. It is written as a reproduction specification, including deterministic random-consumption order, source-clone behavior, animation assignment, orbit formulas, fallback geometry and explicit non-features.

Bird **audio** is a separate global system documented in `docs/audio-system.md`; it is not attached to visual bird positions.

## Source files

```text
src/foliage/BirdSystem.js
src/app/GrassDemo.js
src/world/TerrainSampler.js
src/utils/random.js
public/config.yaml
```

---

## 1. Construction inputs

`GrassDemo` creates:

```text
new BirdSystem({
  scene,
  terrainRoot,
  clips: terrainAnimationClips ?? [],
  terrainSampler,
  config
})
```

The bird system does not load its own GLB file. It reuses a named object and animation array from the already loaded terrain GLTF.

---

## 2. Source object contract

Configured:

```yaml
birds:
  sourceName: Birds
```

Lookup:

```text
terrainRoot?.getObjectByName('Birds')
```

If found:

```text
source.visible = false
```

The original object becomes a hidden template only.

Every visible runtime bird is a clone.

---

## 3. Clone method

Source birds are cloned using:

```text
clone()
```

from:

```text
three/addons/utils/SkeletonUtils.js
```

This matters if the source hierarchy contains skinned/animated objects; a plain shallow clone can produce incorrect skeleton sharing.

Do not switch to `source.clone()` during parity work without verifying animation behavior.

---

## 4. Fallback bird exact geometry

If `Birds` does not exist, each runtime entry gets a procedural fallback.

Fallback structure:

```text
THREE.Group
  + Mesh
```

Material:

```text
MeshStandardMaterial
color = 0x1f2422
roughness = 0.8
```

Geometry positions:

```text
(-0.8, 0, 0)
( 0.0, 0.22, 0)
( 0.8, 0, 0)
```

Triangle indices:

```text
[0, 1, 2]
```

This is a simple flat dark silhouette, not a procedural flapping wing model.

If source is missing, one warning is logged after construction.

---

## 5. Current configuration

```yaml
birds:
  sourceName: Birds
  count: 10
  minHeight: 5
  maxHeight: 10
  minOrbitRadius: 50
  maxOrbitRadius: 200
  minSpeed: 0.15
  maxSpeed: 0.25
  minScale: 3
  maxScale: 5
  bobAmount: 0.4
  bobSpeed: 1.5
  edgePadding: 20
  randomSeed: 1234
  orbitCenter: [0, 100, 0]
```

`edgePadding` currently exists but is not read by `BirdSystem`.

---

## 6. Deterministic random generator

Construction uses:

```text
createRandom(config.birds.randomSeed ?? 1234)
```

Current seed:

```text
1234
```

The project's seeded generator returns a reproducible sequence for the same seed.

This means visual placement can be screenshot-compared reliably **only if random calls are consumed in the same order**.

---

## 7. Exact random-consumption order per bird

For each index from `0` through `count-1`, random values are consumed in this order:

```text
1. scale
2. initial orbit angle
3. orbit radius
4. height
5. speed
6. bobbing phase
```

Specifically:

```text
scale  = lerp(minScale, maxScale, random())
angle  = random() * 2PI
radius = lerp(minOrbitRadius, maxOrbitRadius, random())
height = lerp(minHeight, maxHeight, random())
speed  = lerp(minSpeed, maxSpeed, random())
phase  = random() * 2PI
```

Changing this call order changes every later bird's deterministic parameters even with the same seed.

An exact recreation should preserve it.

---

## 8. Scale behavior

Runtime scale is applied with:

```text
bird.scale.multiplyScalar(scale)
```

It multiplies whatever scale exists on the source clone.

It does not overwrite the scale vector with `(scale,scale,scale)` from a clean identity.

Current random scalar range:

```text
3 .. 5
```

Therefore source asset scale is part of final visual size.

---

## 9. Orbit center

Constructor chooses:

```text
if config.birds.orbitCenter exists:
    new Vector3().fromArray(orbitCenter)
else:
    terrainSampler.bounds.getCenter(...)
```

Current explicit value:

```text
(0, 100, 0)
```

Because it is configured, current normal path does not derive bird center from terrain bounds.

---

## 10. Height semantics

Bird `height` is an offset added to `center.y`.

Current center Y is `100`, so static baseline Y lies in:

```text
105 .. 110
```

before bobbing.

This is important: `minHeight: 5` / `maxHeight: 10` are **not absolute world heights** in current configuration.

No terrain sampling is performed under each bird.

---

## 11. Orbit angle update

Each frame:

```text
angle += speed * deltaSeconds
```

Current speed range:

```text
0.15 .. 0.25 radians / second
```

Because `deltaSeconds` is used, angular movement is frame-rate independent.

Angles are not wrapped back into `[0,2PI]`; trigonometric functions handle accumulated values naturally.

---

## 12. Orbit position formula

World X/Z:

```text
x = center.x + cos(angle) * radius
z = center.z + sin(angle) * radius
```

Every bird follows a perfect horizontal circle with its own fixed radius.

There is no elliptical orbit or wandering center.

---

## 13. Vertical bob formula

World Y:

```text
y = center.y
  + height
  + sin(elapsedSeconds * bobSpeed + phase) * bobAmount
```

Current:

```text
bobSpeed = 1.5
bobAmount = 0.4
```

The amplitude is therefore ±0.4 world units around the static height.

Phase differs deterministically per bird.

---

## 14. Final transform every frame

Each update performs:

```text
bird.position.set(x, y, z)
bird.rotation.y = -angle + PI/2
```

Only world position and Y rotation are changed by `BirdSystem`.

It does not update X/Z rotation for banking or pitch.

---

## 15. Heading convention

The current heading formula:

```text
-angle + PI/2
```

is intended to orient source forward along the tangent of the circular path.

Whether the visible model appears correctly forward depends on how the `Birds` source asset was authored.

Do not add an arbitrary additional 90/180-degree correction before checking the source asset orientation.

---

## 16. Animation mixer creation

Mixer is created only when both are true:

```text
source exists
clips.length > 0
```

Then:

```text
new THREE.AnimationMixer(bird)
```

Fallback procedural birds never receive an animation mixer.

---

## 17. Clip assignment is array-index based

For bird index `i`:

```text
clip = clips[i % clips.length]
```

Then:

```text
mixer.clipAction(clip).play()
```

There is no clip-name filtering such as "Fly".

This means the **order of `terrainAnimationClips` is part of current behavior**. That order is the `assets.terrainParts` order; the flight clip ships in `Assets/terrain/fauna/birds.glb`, the only part with an animation.

If the terrain GLB contains unrelated animation clips, they can be assigned to bird clones by index.

A replacement asset should account for this or the code must intentionally be changed.

---

## 18. Mixer update

Per frame, after transform:

```text
mixer?.update(deltaSeconds)
```

Every animated bird has its own mixer.

There is no shared mixer for all clones.

---

## 19. Update position in app frame

Current `GrassDemo` order around foliage is:

```text
trees.update
leaves.update
birds.update
rain.update
```

Bird animation/movement therefore happens before weather/environment interpolation later in that frame.

BirdSystem itself does not currently read environment state, so this ordering has little visual coupling beyond general render timing.

---

## 20. Relationship to terrain

`TerrainSampler` is supplied but used only as fallback source for orbit center when `orbitCenter` is absent.

Birds do not:

```text
sample terrain height under flight path
avoid terrain peaks
avoid trees
use terrain zones
use terrain mask
land on terrain
```

Current explicit center makes their world height mostly independent of terrain.

---

## 21. Relationship to player

Birds do not query player position.

They do not:

```text
flee from player
follow player
change orbit center with player
spawn/despawn around camera
attack/interact
```

The orbit center remains fixed.

---

## 22. No LOD or culling policy in BirdSystem

BirdSystem itself has no:

```text
distance culling
frustum check
LOD mesh switch
billboard replacement
quality-level behavior
```

Ordinary Three.js object frustum behavior may still apply to clone meshes unless their source properties disable it, but BirdSystem has no explicit custom culling algorithm.

`edgePadding: 20` is unused.

---

## 23. Bird audio is independent

Visual bird count and orbit do not affect bird-call timing.

`AudioSystem`:

```text
uses its own bank
starts with 2.5s timer
cycles calls round-robin
uses deterministic varying delay formula
plays globally/non-positionally
```

There is no relation between visual bird index and audio bird index.

---

## 24. Fallback behavior

If source is missing:

```text
10 fallback triangles are still created
same deterministic scale/orbit/height/speed/phase system applies
no mixers are created
warning is logged once
```

This lets the world retain moving bird silhouettes instead of losing the subsystem entirely.

---

## 25. Current non-features

Do not add during exact parity:

```text
boids/flocking
random steering
waypoints
terrain avoidance
tree avoidance
player avoidance
perching
landing/takeoff state
banking
wing procedural animation
weather reaction
night/day spawning
LOD
spatial bird audio
GPU instancing
```

These would create a different bird system.

---

## 26. Exact reproduction checklist

A faithful recreation should:

- search the terrain GLB for exact name `Birds`,
- hide source when found,
- clone with SkeletonUtils,
- create exactly `count=10` entries,
- use seed 1234,
- preserve exact six-random-values-per-bird consumption order,
- multiply source scale by a random 3..5 scalar,
- use orbit center `[0,100,0]`,
- use radius 50..200,
- use static height offset 5..10 above center,
- use speed .15..25 rad/s,
- use bob ±.4 at speed 1.5 with per-bird phase,
- use exact circular X/Z formulas,
- set heading to `-angle + PI/2`,
- assign animation `clips[index % clips.length]` with one mixer per bird,
- use the exact fallback triangle/material when source is absent,
- keep bird audio separate and non-positional,
- leave `edgePadding` unused.

---

## 27. Visual validation

With current assets/config, verify:

```text
birds form several circles of different radii rather than one ring
sizes vary substantially because scale range is 3..5
altitude varies modestly around ~105..110 world Y plus bob
movement is slow and smooth
birds face tangent to their path
relative initial arrangement repeats across reloads
visual bird movement does not react when switching Sunny/Rain/Wind
```

If arrangement changes every reload, deterministic random consumption has been altered.

---

## 28. Debugging order

If birds look wrong:

```text
1. Is source `Birds` found?
2. Is source hidden but clones visible?
3. Is orbitCenter really [0,100,0]?
4. Did random call order change?
5. Is source scale being multiplied rather than replaced?
6. Are radius/height interpreted as offsets correctly?
7. Is heading sign `-angle + PI/2` correct for the asset?
8. Does GLTF animation array contain intended bird clips in usable order?
9. Is fallback being used unexpectedly?
```

Do not randomize orientation/paths to hide an asset-orientation or clip-order problem.

# Leaf System

This document explains how the falling leaves currently work in `grass-test`.

## Overview

The falling-leaf effect is implemented by `src/foliage/LeafSystem.js`.

It is a local, player-centered particle effect. It does not simulate every leaf attached to every tree. Instead, it keeps a reusable pool of leaf cards around the player and changes the active texture family based on the current vegetation zone.

The main responsibilities are:

- `LeafSystem` — falling leaf simulation and instanced rendering.
- `ZoneIndex` — determines whether the player is in the yellow, green, or white vegetation region.
- `TerrainSampler` — supplies terrain height for ground contact.
- `GrassDemo` — creates and updates the system every frame.
- `public/config.yaml` — texture paths and simulation parameters.

## Runtime flow

```text
terrain/zones/zones.glb
    |
    +--> YellowZone
    +--> GreenZone
    +--> WhiteZone
            |
            v
        ZoneIndex
            |
      player position
            |
            v
        LeafSystem
            |
            +--> choose active leaf family
            +--> update movement
            +--> apply wind and gravity
            +--> sample terrain height
            +--> recycle leaves
            +--> update instance matrices
            |
            v
       InstancedMesh
```

`GrassDemo` creates the leaf system after the terrain, player, zone index, and tree system are available, then calls:

```js
this.leaves.update(deltaSeconds, elapsedSeconds);
```

every frame.

## Leaf families and textures

There are three configured leaf textures:

```yaml
assets:
  leaves:
    yellow: Assets/leaf-yellow.png
    green: Assets/leaf-green.png
    white: Assets/leaf-whites.png
```

The implementation uses the fixed zone list:

```js
const ZONES = ['yellow', 'green', 'white'];
```

Each texture is loaded using `THREE.TextureLoader` and marked as sRGB because it contains visible color data:

```js
map.colorSpace = THREE.SRGBColorSpace;
```

## Geometry and material

Each leaf is visually a simple plane:

```js
new THREE.PlaneGeometry(1, 1)
```

The plane is then scaled per instance to create different leaf sizes.

Each zone uses a `THREE.MeshBasicMaterial`:

```js
new THREE.MeshBasicMaterial({
  map,
  transparent: true,
  alphaTest: 0.25,
  depthWrite: false,
  side: THREE.DoubleSide,
});
```

Important consequences:

- `MeshBasicMaterial` means leaf brightness is not affected by PBR lighting.
- `transparent: true` uses the PNG alpha channel.
- `alphaTest: 0.25` removes almost-transparent pixels around the card.
- `depthWrite: false` reduces transparent-card depth artifacts.
- `DoubleSide` keeps the leaf visible while it tumbles.

## Instancing

The system does not create one Three.js `Mesh` per leaf.

Instead, it creates one `THREE.InstancedMesh` per zone:

```text
yellow InstancedMesh
green  InstancedMesh
white  InstancedMesh
```

Each shares one geometry and one material while storing a separate transform matrix for each instance.

The configured population is:

```yaml
leaves:
  count: 1000
```

The code calculates:

```js
const countPerZone = Math.ceil(config.leaves.count / ZONES.length);
```

so with the current configuration:

```text
ceil(1000 / 3) = 334 instances per zone
```

The system therefore allocates 1002 instance slots in total, but under normal conditions only one zone mesh is visible and approximately 334 leaves are active.

## Per-leaf state

The CPU keeps lightweight state for every leaf:

```js
{
  zone,
  index,
  position,
  velocity,
  phase,
  size,
}
```

`zone` selects the texture family.

`index` identifies the leaf's slot in the zone's `InstancedMesh`.

`position` and `velocity` control movement.

`phase` gives every leaf a different animation offset so they do not move together.

`size` is chosen once from the configured size range.

## Deterministic random generation

The leaf population uses:

```js
createRandom(0x1eafcafe)
```

This fixed seed makes the generated population repeatable between runs.

The random generator controls values including:

- position around the player;
- vertical spawn height;
- initial fall speed;
- horizontal velocity;
- leaf size;
- wind/tumble phase.

That makes visual tuning easier because reloading does not create a completely unrelated particle layout.

## Player-centered spawning

Leaves spawn around the player's current X/Z position.

The current setting is:

```yaml
spawnRadius: 20
```

A random angle and radius are selected:

```js
const angle = random() * Math.PI * 2;
const radius = random() * config.leaves.spawnRadius;
```

Then:

```js
x = player.x + Math.cos(angle) * radius;
z = player.z + Math.sin(angle) * radius;
```

Conceptually:

```text
             local falling-leaf field

          .       .      .      .
      .        .              .

                 PLAYER

          .          .
             .              .
```

This avoids populating the complete world with particles that the player cannot see.

### Distribution note

The radius is sampled linearly. This produces a somewhat stronger concentration toward the center than a mathematically uniform disc distribution.

That is acceptable for the current visual effect because it keeps more activity near the player.

## Vertical spawning

On initial creation the vertical position is selected between:

```yaml
minHeight: -2
maxHeight: 5
```

relative to the player's current Y position.

After a leaf is recycled, it is placed higher:

```js
player.y + maxHeight * (0.5 + random() * 0.5)
```

With `maxHeight: 5`, recycled leaves appear about 2.5 to 5 world units above the player.

This makes the continuous effect look like new leaves are entering from above.

## Initial velocity

Each leaf receives small X/Z drift plus a downward Y velocity.

Horizontal velocity is approximately:

```text
-0.1 .. +0.1 world units/second
```

The starting fall speed comes from:

```yaml
minSpeed: 0.5
maxSpeed: 1.5
```

and is assigned as a negative Y velocity.

Different initial speeds prevent the leaves from falling as one synchronized layer.

## Wind and drift

Leaf wind is currently calculated on the CPU.

For each active leaf:

```js
const wind = Math.sin(
  elapsedSeconds * 1.3 + particle.phase
) * config.leaves.windStrength;
```

The X position gets a wind contribution:

```js
wind * 0.18
```

The Z position receives a second oscillation:

```js
Math.cos(elapsedSeconds + particle.phase) * 0.08
```

The current configuration is:

```yaml
windStrength: 1.2
```

Because every particle has a different `phase`, the leaves drift independently rather than moving in lockstep.

### Important limitation

Leaf wind is currently independent from the environment preset wind.

The environment controller changes grass wind and forwards that wind strength to the tree system, but `LeafSystem` reads the static `leaves.windStrength` configuration directly.

Therefore the `Wind`, `Calm`, `Rain`, and other presets do not currently change the strength of falling-leaf motion.

A future unified wind state should drive grass, trees, leaves, clouds, rain direction, and wind audio from the same direction/intensity values.

## Gravity

The implementation applies simple downward acceleration:

```js
particle.velocity.y -= config.leaves.gravity * deltaSeconds;
```

The current value is:

```yaml
gravity: 0.08
```

Vertical position is then updated with:

```js
particle.position.y +=
  particle.velocity.y *
  deltaSeconds *
  config.leaves.simulationSpeed;
```

The current `simulationSpeed` is `1`.

This is an artistic particle simulation rather than a physical aerodynamic model.

## Terrain interaction

Every active leaf samples the terrain height under its current X/Z position:

```js
const ground = terrainSampler.sampleHeight(
  particle.position.x,
  particle.position.z,
);
```

When the leaf reaches approximately:

```js
ground + 0.05
```

it is recycled above the player.

Conceptually:

```text
       falling leaf
            |
            v

--------------------- terrain
            |
            +--> recycle above player
```

This makes the effect follow hills and depressions instead of assuming that the ground is always at Y=0.

The current system does not bounce or leave static leaves on the ground.

## Distance recycling

A leaf is also recycled if it gets too far horizontally from the player.

Current values:

```yaml
spawnRadius: 20
despawnRadius: 30
```

The system compares squared distance:

```js
dx * dx + dz * dz > despawnRadius ** 2
```

so no square root is required.

The larger despawn radius creates a buffer around the spawn area. Leaves can drift naturally beyond their initial spawn radius before being reused.

## Tumbling rotation

Leaves rotate around multiple axes instead of always facing the camera.

The quaternion is rebuilt every frame from:

```js
new THREE.Euler(
  elapsedSeconds * 0.8 + particle.phase,
  particle.phase,
  elapsedSeconds * 1.1 + particle.phase * 0.5,
)
```

This produces continuous tumbling.

The texture remains visible during the full rotation because the leaf material is double-sided.

## Instance matrix updates

For every active particle the system combines:

```text
position + rotation + scale
```

into a matrix:

```js
matrix.compose(position, quaternion, scale);
```

The matrix is written to the correct instance slot:

```js
mesh.setMatrixAt(particle.index, matrix);
```

After all active particles are processed, only the visible zone's matrix buffer is marked dirty:

```js
mesh.instanceMatrix.needsUpdate = true;
```

This results in one instanced draw object rather than hundreds of independent scene objects.

## Vegetation zones

The zones are configured as:

```yaml
zones:
  yellow: YellowZone
  green: GreenZone
  white: WhiteZone
```

`ZoneIndex` finds those named objects inside the imported terrain hierarchy.

For each zone it:

1. traverses the zone object;
2. creates `THREE.Box3` bounds from its meshes;
3. hides the helper geometry;
4. stores the boxes for runtime point tests.

The zone objects are therefore authoring volumes, not visible environment meshes.

At runtime:

```js
zoneIndex.getZone(playerPosition)
```

returns `yellow`, `green`, `white`, or `null`.

## Switching leaf families

Each frame:

```js
this.currentZone =
  this.zoneIndex?.getZone(playerPosition) ?? this.currentZone;
```

Then only the matching zone mesh remains visible:

```js
mesh.visible = zone === this.currentZone;
```

Only particles belonging to the current zone are simulated:

```js
if (particle.zone !== this.currentZone) continue;
```

If the player is outside every known zone, the previous zone remains active.

The initial value is:

```js
this.currentZone = 'green';
```

so green leaves are the default before another zone is detected.

## Relationship to trees

The tree and falling-leaf systems use the same zone vocabulary but remain separate systems.

Tree definitions include values such as:

```yaml
- { high: Tree1_High, low: Tree1_Low, leaves: Leaves_LOD0, zone: yellow }
- { high: Tree4_High, low: Tree4_Low, leaves: Leaves_LOD0003, zone: white }
- { high: Tree7_High, low: Tree7_Low, leaves: Mesh_1001, zone: green }
```

Those `leaves` names refer to meshes embedded in the terrain/tree GLB. They are not the falling-leaf particles.

The current design is:

```text
TreeSystem
  GLB tree models and placement

LeafSystem
  PNG leaf cards moving around the player
```

They are visually coordinated by sharing `yellow`, `green`, and `white` zone names.

## Current configuration

```yaml
leaves:
  count: 1000
  spawnRadius: 20
  despawnRadius: 30
  minHeight: -2
  maxHeight: 5
  minSpeed: 0.5
  maxSpeed: 1.5
  minSize: 0.12
  maxSize: 0.3
  windStrength: 1.2
  gravity: 0.08
  simulationSpeed: 1
```

### `count`

Requested total population before division across the three leaf families.

### `spawnRadius`

Maximum initial distance around the player.

### `despawnRadius`

Distance from the player at which an instance is recycled.

### `minHeight` / `maxHeight`

Initial vertical spawn range relative to the player.

### `minSpeed` / `maxSpeed`

Initial downward velocity range.

### `minSize` / `maxSize`

Per-instance random scale.

### `windStrength`

Strength of the current CPU-side horizontal wind oscillation.

### `gravity`

Downward acceleration.

### `simulationSpeed`

Multiplier applied to vertical movement.

## Frame update order

The relevant `GrassDemo` sequence is:

```js
player.update(deltaSeconds);
grass.update(...);
trees.update(deltaSeconds, elapsedSeconds);
leaves.update(deltaSeconds, elapsedSeconds);
birds.update(deltaSeconds, elapsedSeconds);
rain.update(...);
water.update(...);
environment.update(deltaSeconds);
renderer.render(scene, camera);
```

The player position is therefore already current when `LeafSystem.update()` performs zone selection and distance recycling.

## Performance characteristics

With the current configuration, the system has approximately:

```text
3 InstancedMesh objects
334 instances per zone
1 visible zone at a time
~334 active particle updates per frame
1 instance-matrix buffer upload per frame
```

The active simulation is O(N), where N is the number of particles in the active family.

Each active leaf performs:

- wind calculations;
- position integration;
- terrain-height sampling;
- distance testing;
- quaternion construction;
- matrix composition;
- one `setMatrixAt` call.

The terrain sampling and CPU matrix work will become more important if the leaf count is increased significantly.

## Current limitations

### Wind is not synchronized with environment presets

The biggest logic mismatch is that leaf wind uses static `leaves.windStrength` instead of the active environment wind.

### Leaves do not originate from individual trees

They appear around the player rather than being emitted from nearby tree canopies.

### No persistent ground leaves

Terrain contact immediately recycles an instance.

### No collision with trees, rocks, player, or water

Only terrain height is checked.

### No rain response

Rain currently does not alter leaf movement, weight, color, or spawn rate.

### No leaf quality profiles

Performance/Balanced/High/Ultra do not currently change leaf count or simulation radius.

### Frustum culling is disabled

Each zone mesh uses:

```js
mesh.frustumCulled = false;
```

This is safe for a local particle field but means the active mesh is still submitted even if the camera is facing away from it.

### Inactive families pause

Only the current zone's particles are updated. When another family becomes active again, it resumes from its previous positions. The distance and terrain checks normally recycle stale particles quickly, but the inactive simulation is not continuous.

### Transparent instance ordering is approximate

Instanced transparent cards are not individually sorted back-to-front. `alphaTest` and disabled depth writing reduce artifacts but do not completely solve transparent overlap ordering.

## Recommended next version

The next useful improvement is to keep the local pooled approach but connect spawning to nearby trees and unify wind.

```text
EnvironmentState
    |
    +--> WindState
            direction
            strength
            gust

TreeSystem / NearbyTreeIndex
    |
    +--> canopy center
    +--> canopy radius
    +--> vegetation zone
            |
            v
        LeafSystem
            |
            +--> pooled instances
            +--> spawn from nearby canopies
            +--> shared wind state
            +--> terrain/water recycling
            +--> quality-aware count
```

This keeps the important optimization — only simulating leaves near the player — while making them appear to come from real trees.

## Possible GPU version

For much larger populations, most animation could move to WebGPU/TSL.

Static per-instance data could contain:

```text
spawn position
fall speed
phase
size
rotation seed
zone/species
```

The shader could derive movement from time and a shared wind state, greatly reducing CPU matrix updates.

The CPU would then mainly handle emitter selection, occasional reseeding, and zone changes.

## Relevant files

```text
public/config.yaml
src/app/GrassDemo.js
src/foliage/LeafSystem.js
src/world/ZoneIndex.js
src/world/TreeSystem.js
src/world/TerrainSampler.js
```

The ownership model is:

```text
LeafSystem
  falling-leaf simulation and instanced rendering

ZoneIndex
  world-position to vegetation-zone mapping

TerrainSampler
  terrain height for recycling

TreeSystem
  tree instances using the same zone vocabulary

GrassDemo
  initialization and frame orchestration
```

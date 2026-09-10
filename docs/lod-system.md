# Level of Detail (LOD) System

This document explains how Level of Detail (LOD) currently works in `grass-test`.

The project uses LOD mainly for two expensive parts of the scene:

- grass
- trees

The two systems use different strategies because their rendering problems are different.

Grass uses a **camera-centered tile grid with multiple prebuilt geometries**. Trees use **high/low model pairs with distance-based cross-fading and final distance culling**.

Other systems such as rain, birds, falling leaves, sky, clouds, water, terrain, and the player do not currently have a dedicated LOD implementation.

## Why LOD is necessary

A scene can contain a very large amount of geometry near the camera without needing the same detail far away.

For grass, a blade close to the camera may need several vertical segments and high density. A blade 100+ world units away may occupy only a few pixels, so rendering the same geometry and density is wasteful.

For trees, the near version should preserve the full model while a distant version can be much simpler.

Conceptually:

```text
camera
  |
  |   high detail
  |-------------------
  |
  |       medium detail
  |---------------------------------
  |
  |              low detail
  |------------------------------------------------
  |
  |                         very low / culled
  |----------------------------------------------------------------
```

The goal is to spend GPU and CPU work where it is visible.

---

# 1. Grass LOD architecture

The grass pipeline is spread across:

```text
src/grass/GrassField.js
src/grass/GrassGeometryFactory.js
src/grass/GrassGeometry.js
src/grass/GrassTile.js
public/config.yaml
```

`GrassField` owns the LOD policy.

`GrassGeometryFactory` creates the geometry variants.

`GrassGeometry` defines how geometry detail and instance density translate into actual vertices and blades.

`GrassTile` is the lightweight scene object whose geometry is swapped as its LOD changes.

The high-level flow is:

```text
quality profile
      |
      v
four LOD definitions
      |
      v
GrassGeometryFactory
      |
      +--> high geometry
      +--> medium geometry
      +--> low geometry
      +--> veryLow geometry
      |
      v
camera-centered tile grid
      |
      v
per-frame distance + frustum test
      |
      v
select LOD geometry for each visible tile
```

---

# 2. Grass is divided into reusable tiles

Grass is not created as one enormous mesh covering the whole world.

Instead the visible region is divided into square tiles.

The current base configuration contains:

```yaml
grass:
  tileSize: 25
```

Each tile therefore represents approximately:

```text
25 x 25 world units
```

A `GrassTile` contains one `THREE.Mesh`:

```js
this.mesh = new THREE.Mesh(geometry, material);
```

Every tile shares the same grass material. The expensive part that changes for LOD is the geometry.

The tile tracks its current LOD in `userData`:

```js
this.mesh.userData.currentLOD = 'veryLow';
```

Changing LOD is therefore mostly a geometry reference swap:

```js
setGeometry(geometry, lodName) {
  if (this.mesh.geometry === geometry) return;
  this.mesh.geometry = geometry;
  this.mesh.userData.currentLOD = lodName;
}
```

No new grass geometry is generated each frame.

---

# 3. The four grass LOD levels

The system defines the fixed ordering:

```js
const LOD_ORDER = ['high', 'medium', 'low', 'veryLow'];
```

Each level has three important values:

```text
detail
  geometry complexity of each blade

density
  number of instances generated inside each tile

distance
  normalized distance threshold at which this level is selected
```

For example, the current `high` quality profile for blade grass is:

```yaml
high:
  blade:
    maxDistance: 140
    lod:
      high:     { detail: 5, density: 4.5, distance: 0.3 }
      medium:   { detail: 2, density: 3,   distance: 0.5 }
      low:      { detail: 1, density: 2,   distance: 0.9 }
      veryLow:  { detail: 1, density: 1,   distance: 1.0 }
```

Because `maxDistance` is `140`, those normalized thresholds correspond approximately to:

```text
high      <= 42 world units
medium    <= 70 world units
low       <= 126 world units
veryLow   <= 140 world units
culled    > 140 world units
```

The conversion is simply:

```text
actual distance = normalized threshold * maxDistance
```

---

# 4. How grass geometry detail works

For blade grass, `detail` controls the number of vertical blade segments.

The code does:

```js
const segments = Math.max(1, Math.round(detail));
```

For every segment boundary, two vertices are created. Adjacent segments share that pair through the index buffer. The tip is a single vertex.

A blade with:

```text
detail = 5
```

has enough segments to bend smoothly in the TSL grass deformation shader.

A blade with:

```text
detail = 1
```

is essentially a very simple vertical quad-like strip.

Conceptually:

```text
high detail blade

      /\
     /  \
    /----\
   /------\
  /--------\
 /----------\


low detail blade

    /\
   /  \
  /____\
```

The high-detail version contains more vertices, which means smoother wind and interaction deformation but more GPU vertex work.

---

# 5. Billboard grass has a different geometry strategy

Grass can currently use either:

```text
blade
billboard
```

Blade geometry uses the segmented strip described above.

Billboard geometry creates two crossed planes rotated 90 degrees from each other:

```text
      |
   ---+---
      |
```

This gives distant vegetation more visual volume than a single plane while remaining cheap.

The billboard template does not use the `detail` value to create additional vertical segments. Its complexity stays small; density is therefore the more important LOD parameter for billboard grass.

The quality profiles contain separate LOD settings for:

```yaml
blade:
  ...

billboard:
  ...
```

This allows the two rendering modes to be tuned independently.

---

# 6. How grass density works

Density directly affects the instance count inside each tile.

The code calculates:

```js
const gridCount = Math.max(1, Math.floor(tileSize * density));
const count = gridCount * gridCount;
```

With a tile size of `25`, approximate instance counts are therefore:

```text
density 1
25 x 25
= 625 blades per tile


density 2
50 x 50
= 2,500 blades per tile


density 3
75 x 75
= 5,625 blades per tile


density 4
100 x 100
= 10,000 blades per tile


density 4.5
112 x 112
= 12,544 blades per tile
```

This is an important point: density is quadratic.

Doubling density does not double the blade count. It roughly quadruples it.

That means this configuration change:

```yaml
density: 2
```

to:

```yaml
density: 4
```

can increase per-tile grass instances from roughly:

```text
2,500 -> 10,000
```

rather than merely doubling them.

Density is therefore one of the most powerful performance controls in the project.

---

# 7. Grass instance placement remains deterministic

Each LOD geometry creates its own instance positions using deterministic hashing and gradient noise.

For each logical grid cell the code derives:

- X/Z position jitter
- Y rotation
- wind phase/noise data

This avoids perfectly regular rows of grass.

Because the generation is deterministic, the same geometry can be reused by every tile.

The tile's world transform moves that local distribution into the correct world position.

This is substantially cheaper than creating unique geometry for every tile.

---

# 8. Grass geometries are prebuilt

When a quality profile is applied, `GrassField` rebuilds the four geometry variants:

```text
high
medium
low
veryLow
```

Each is stored in:

```js
this.geometries
```

Conceptually:

```js
this.geometries = {
  high: highGeometry,
  medium: mediumGeometry,
  low: lowGeometry,
  veryLow: veryLowGeometry,
};
```

Visible tiles reuse these shared geometries.

This is important because a scene may contain many grass tiles but only four actual geometry definitions for the active grass type and quality profile.

---

# 9. Camera-centered grass tile recycling

The grass grid follows the camera instead of covering the entire terrain permanently.

Each frame the system determines which logical tile contains the camera:

```js
const centerTileX = Math.floor((camera.x - terrainCenter.x) / tileSize);
const centerTileZ = Math.floor((camera.z - terrainCenter.z) / tileSize);
```

When the camera crosses into a new tile, the reusable tile grid is repositioned around that new center.

Conceptually:

```text
before camera moves

+---+---+---+---+---+
|   |   |   |   |   |
+---+---+---+---+---+
|   |   |   |   |   |
+---+---+---+---+---+
|   |   | C |   |   |
+---+---+---+---+---+
|   |   |   |   |   |
+---+---+---+---+---+


camera crosses a tile boundary

          ->

+---+---+---+---+---+
|   |   |   |   |   |
+---+---+---+---+---+
|   |   |   |   |   |
+---+---+---+---+---+
|   |   | C |   |   |
+---+---+---+---+---+
|   |   |   |   |   |
+---+---+---+---+---+
```

The visual grid stays around the camera while its world tile coordinates change.

This prevents the scene from requiring enough grass meshes to cover an arbitrarily large world.

---

# 10. Grass grid size depends on maximum draw distance

When a quality profile changes, the required tile grid is recalculated.

The code uses approximately:

```js
gridSize = oddCeiling((maxDistance * 2) / tileSize)
```

The value is forced to an odd number so there is a clear center tile.

For example:

```text
maxDistance = 140
tileSize = 25

280 / 25 = 11.2
ceil       = 12
next odd   = 13
```

So the system allocates approximately:

```text
13 x 13 = 169 reusable grass tiles
```

Not every tile is rendered. Distance, mask, terrain bounds, and frustum tests remove many of them.

---

# 11. Per-frame grass visibility tests

LOD selection happens only after a tile passes several visibility tests.

For each tile the code checks:

```text
1. maximum distance
2. grass mask
3. terrain bounds
4. camera frustum
```

Conceptually:

```text
tile
 |
 +-- outside max distance? ------> hide
 |
 +-- mask says no grass? --------> hide
 |
 +-- outside terrain? -----------> hide
 |
 +-- outside camera frustum? ----> hide
 |
 +-- otherwise ------------------> choose LOD
```

This is important because LOD alone is not enough. The cheapest object is the object that is not rendered at all.

---

# 12. Distance-based grass LOD selection

For a visible tile, distance is normalized against the quality profile's maximum grass distance:

```js
normalizedDistance = distance / maxDistance
```

Then the thresholds are checked in this order:

```text
high
medium
low
veryLow
```

The first matching threshold wins.

Simplified:

```js
if (distance <= high.distance) return 'high';
if (distance <= medium.distance) return 'medium';
if (distance <= low.distance) return 'low';
return 'veryLow';
```

The selected shared geometry is assigned to that tile.

---

# 13. Grass LOD is based on tile center, not every blade

The project does not calculate camera distance independently for every grass blade.

That would be far too expensive.

Instead the tile position is used:

```text
camera -> tile center distance
```

All blades in the tile therefore share the same LOD.

This greatly reduces CPU work:

```text
hundreds of tile decisions
```

instead of potentially:

```text
hundreds of thousands of blade decisions
```

The tradeoff is that an entire 25-unit tile can change LOD at once.

---

# 14. Grass frustum culling is handled manually

`GrassTile` explicitly has:

```js
mesh.frustumCulled = false;
```

This may look unusual.

The reason is that `GrassField` performs its own culling using a sphere for each tile:

```js
this.frustum.intersectsSphere(this.tileSphere)
```

The sphere is centered near the sampled terrain height and has a radius based on tile size.

This gives the grass system explicit control over visibility while avoiding incorrect automatic bounds caused by large GPU-side blade deformation.

---

# 15. Empty grass tiles are skipped

The grass mask is also used as an LOD-adjacent optimization.

`GrassField` tracks tiles that contain no grass in:

```js
this.emptyTiles
```

A tile is marked empty if the grass mask indicates there is no relevant grass in that region.

Such tiles are completely hidden rather than being assigned `veryLow` geometry.

This matters because large roads, water areas, bare ground, and other non-grass regions should cost almost nothing in the grass renderer.

---

# 16. Painter mode intentionally changes LOD behavior

When the grass painter is enabled, visible grass tiles are forced to:

```text
low
```

rather than using their normal camera-distance LOD.

The code effectively does:

```js
const lodName = painterEnabled
  ? 'low'
  : selectLod(distance);
```

This gives the editor a more stable geometry representation while painting the mask and avoids some visible geometry changes around the brush.

It is a deliberate editor-mode tradeoff rather than the normal runtime LOD policy.

---

# 17. Quality profiles control grass LOD globally

The project currently provides:

```text
Performance
Balanced
High
Ultra
```

Each profile can independently configure:

- shadow map size
- blade maximum distance
- blade LOD density/detail thresholds
- billboard maximum distance
- billboard LOD density/detail thresholds
- fog multiplier

This means a quality change is much more than a single resolution switch.

For grass it rebuilds the geometry variants and tile grid.

Conceptually:

```text
Performance
  fewer tiles
  lower density
  lower geometry detail
  shorter draw distance

Balanced
  middle ground

High
  higher density
  longer draw distance

Ultra
  most expensive density/detail
  longest draw distance
```

---

# 18. Example: High vs Ultra grass cost

For blade grass, `High` currently has:

```yaml
maxDistance: 140
high:
  detail: 5
  density: 4.5
```

`Ultra` has:

```yaml
maxDistance: 220
high:
  detail: 5
  density: 5.5
```

At a tile size of 25:

```text
High near tile
floor(25 * 4.5) = 112
112² = 12,544 instances

Ultra near tile
floor(25 * 5.5) = 137
137² = 18,769 instances
```

Ultra therefore increases both:

- per-tile near-field density
- total number of tiles potentially visible because of the longer draw distance

The real cost difference can be much larger than the density values alone suggest.

---

# 19. Tree LOD architecture

Trees use a separate LOD strategy implemented in:

```text
src/world/TreeSystem.js
public/config.yaml
```

Each configured tree type references a high and low source object, which ship together in that type's `Assets/terrain/trees/treeN.glb` part.

Example:

```yaml
trees:
  types:
    - high: Tree1_High
      low: Tree1_Low
      leaves: Leaves_LOD0
      zone: yellow
```

The source meshes are hidden after loading and cloned into scene instances at marker positions.

Each runtime tree stores both representations:

```text
high model
low model
```

The tree system then blends between them according to camera distance.

---

# 20. Tree high-detail distance

The current configuration uses:

```yaml
trees:
  highDistance: 170
```

Trees substantially closer than this use the high-detail representation.

Trees substantially farther use the low-detail representation.

The transition is not an instantaneous pop.

`TreeSystem` uses a three-state hysteresis machine, not a distance band. `#desiredLod()`
picks the target state from the tree's *current* state, so the switch distance differs depending
on which way the camera is moving:

```text
from HIGH:       stay HIGH while distance < highDistance + highHysteresis
from BILLBOARD:  go HIGH   when  distance < highDistance - highHysteresis
                 stay BILLBOARD while distance < billboardDistance + billboardHysteresis
                 otherwise HIDDEN
from HIDDEN:     stay HIDDEN while distance >= billboardDistance - billboardHysteresis
```

The hysteresis bands are what prevent a tree sitting exactly on a threshold from oscillating
between LODs. There is no `TRANSITION_WIDTH` constant and no distance-driven `smoothstep`.

---

# 21. Tree cross-fading

The tree LOD system changes opacity instead of instantly swapping models.

The cross-fade is driven by **elapsed time**, not by distance. Once `#desiredLod()` returns a
new state, `#transition()` records the starting opacities and `#updateTransition()` advances a
timer over `trees.transitionDuration` seconds:

```text
t = smoothStep01(transitionTime / transitionDuration)

high opacity      = lerp(transitionHighStart,      targetLOD === HIGH      ? 1 : 0, t)
billboard opacity = lerp(transitionBillboardStart, targetLOD === BILLBOARD ? 1 : 0, t)
```

Billboard opacity is written into a per-instance `treeOpacity_<typeIndex>` attribute rather
than a material property, because all billboards of one tree type share a single
`InstancedMesh`.

Conceptually:

```text
near                        far

HIGH  100% ------------------ 0%
             \          /
              \        /
LOW     0% ---------------- 100%
```

This reduces obvious LOD popping.

During the transition both representations can be rendered simultaneously, so the fade zone temporarily costs more than either LOD by itself.

---

# 22. Tree material cloning is required for independent fades

Tree source materials are cloned for each runtime clone.

This is important because opacity is changed individually during LOD transitions.

If every clone shared the exact same material object, fading one tree could fade all trees using that material.

`prepareClone()` therefore clones each mesh material before runtime opacity manipulation.

The tradeoff is higher material/object overhead compared with a fully instanced tree renderer.

---

# 23. Low-detail tree billboards use authored facing

The low-detail representation does **not** track the camera. `#buildBillboards()` bakes each
instance matrix once, using the tree's authored Y rotation:

```js
transform.rotation.set(0, tree.rotation, 0);
```

The instance matrix is uploaded once and never rewritten, so a billboard keeps its authored
facing for the life of the scene. It is a pre-baked impostor, not a camera-facing one.

Conceptually:

```text
          camera
            ^
            |
            |
       [ low tree ]
            |
       rotates toward
          camera
```

This is a very effective strategy for distant foliage because the viewer mainly needs the tree silhouette.

---

# 24. Trees are completely culled after billboard distance

The final tree distance is configured as:

```yaml
trees:
  billboardDistance: 500
```

When a tree is farther than that:

```js
entry.high.visible = false;
entry.low.visible = false;
```

So the tree LOD pipeline is approximately:

```text
0 ---------------- 170 -------------------------- 500

HIGH
        cross-fade
                  LOW / billboard-like
                                               CULLED
```

Unlike grass, tree culling is calculated per tree instance rather than per tile.

---

# 25. Tree LOD and wind

Wind sway is a TSL vertex shader in `TreeLeafMaterial.js`, applied to high-detail leaf
materials. No object-level `rotation.z` sway exists.

`TreeSystem.setWindStrength()` forwards the environment's current wind intensity to the leaf
material factory, so sway strength follows the active preset.

Billboards do not receive the leaf shader, so distant trees do not preserve the same visible
wind deformation as near trees.

---

# 26. Tree LOD configuration values

```yaml
highHysteresis: 8
billboardHysteresis: 10
transitionDuration: 1
```

All three **are** consumed. `highHysteresis` and `billboardHysteresis` widen the state-machine
bands in `#desiredLod()`; `transitionDuration` sets the cross-fade length in
`#updateTransition()`, floored by `MIN_TRANSITION_SECONDS`.

Changing these values does change tree LOD behavior.

---

# 27. Grass currently has no LOD hysteresis either

Grass changes LOD according to the current tile distance threshold.

There is no separate enter/exit threshold.

For example, a tile near a boundary can theoretically alternate between:

```text
high <-> medium
```

if the camera repeatedly crosses that exact distance.

Because the LOD unit is a relatively large tile and the geometry swap is cheap, this is usually acceptable, but a production system can reduce oscillation by adding hysteresis.

For example:

```text
enter medium at 45 m
return to high only below 40 m
```

instead of using one boundary in both directions.

---

# 28. Current LOD ownership

The ownership is intentionally separated:

```text
GrassField
  decides which grass tiles exist
  performs visibility checks
  chooses grass LOD

GrassGeometryFactory
  builds requested grass geometry variant

GrassGeometry
  defines blade/billboard complexity and instance density

GrassTile
  owns one reusable grass mesh
  swaps geometry references

TreeSystem
  selects and blends tree high/low representations
  performs tree distance culling

config.yaml
  owns quality and distance tuning values
```

This separation is good because LOD policy can be improved without putting geometry-generation logic into the main render loop.

---

# 29. What does not currently use LOD

The following systems currently do not have dedicated distance-based LOD:

```text
player
terrain geometry
water
rain
clouds
sky
birds
falling leaves
```

Some of these are already inexpensive enough that LOD is unnecessary.

Others could eventually benefit from it.

For example:

```text
leaves
  reduce count or disable beyond nearby player region

birds
  reduce animation/detail at extreme distance

terrain
  chunked geometry or mesh LOD for much larger worlds

water
  lower tessellation / reflection quality by distance
```

The sky and cloud shells are already single large procedural meshes, so conventional mesh LOD would offer little benefit.

---

# 30. Performance model

The grass system primarily reduces cost in three dimensions:

```text
visibility
  do not render invisible tiles

density
  render fewer grass instances farther away

geometry detail
  use fewer vertices per blade farther away
```

Tree LOD reduces cost through:

```text
model complexity
  high -> low

shadows
  high trees cast shadows
  low trees do not

distance culling
  low -> hidden
```

These are complementary strategies.

---

# 31. Practical tuning order

When optimizing the project, tune the LOD system in this order.

## 1. Maximum grass distance

This usually has the largest effect because it determines the size of the active tile grid.

```yaml
maxDistance
```

## 2. Grass density

Remember that instance count scales approximately with density squared.

```yaml
density
```

## 3. Grass detail

Reduce segmented blade geometry for medium/far ranges.

```yaml
detail
```

## 4. LOD thresholds

Move expensive LODs closer to the camera.

```yaml
distance
```

## 5. Tree high distance

Reduce the range of full tree geometry.

```yaml
highDistance
```

## 6. Tree maximum distance

Reduce distant tree draw range if necessary.

```yaml
billboardDistance
```

This order tends to produce larger performance gains before more invasive architectural changes are needed.

---

# 32. Debugging LOD

A useful development mode would color each grass LOD differently.

For example:

```text
high      red
medium    yellow
low       blue
veryLow   purple
```

This would make distance boundaries immediately visible.

The project already stores the current grass LOD in:

```js
mesh.userData.currentLOD
```

so a future debug overlay could report counts such as:

```text
Visible grass tiles: 61
High:      9
Medium:   12
Low:      25
Very Low: 15
```

For trees, similar debug colors could distinguish:

```text
high
transition
low
culled
```

This would make LOD tuning much easier than judging performance only from FPS.

---

# 33. Current limitations

## Grass LOD changes are discrete

Tiles swap geometry instantly at threshold boundaries.

There is no visual cross-fade between grass geometries.

The small size and high repetition of grass usually hide this, but transitions can still become visible in certain camera angles.

## No grass hysteresis

A tile can theoretically bounce between LOD levels near a threshold.

## Tree fade duplicates rendering temporarily

During the high/low transition both models are rendered.

This is visually smoother but temporarily more expensive.

## Tree LOD uses individual cloned objects

This is straightforward but not optimal for forests with thousands of trees.

## Tree configuration has unused LOD settings

`highHysteresis`, `billboardHysteresis`, and `transitionDuration` are currently not wired into the implementation.

## No screen-space LOD metric

Both grass and trees use world-space camera distance.

They do not currently account for:

- camera FOV
- viewport resolution
- projected object size
- device pixel ratio

A very large tree and a very small tree at the same distance therefore get the same distance-based decision.

---

# 34. Recommended next version

The current LOD design is a good baseline. A stronger production version should preserve its simplicity while adding better transition control.

Recommended architecture:

```text
LODManager
  |
  +-- quality profile
  +-- camera metrics
  +-- performance budget
  |
  +--> GrassLODPolicy
  |      +-- tile visibility
  |      +-- distance bands
  |      +-- hysteresis
  |      +-- optional dither fade
  |
  +--> TreeLODPolicy
         +-- high mesh
         +-- low mesh
         +-- impostor
         +-- cull
         +-- hysteresis
```

The grass renderer should remain tile-based.

The tree renderer should eventually move toward batched or instanced rendering instead of one cloned object hierarchy per tree.

A strong future tree chain would be:

```text
near
  full high-detail tree
      |
      v
medium
  simplified low mesh
      |
      v
far
  camera-facing impostor atlas
      |
      v
very far
  culled
```

For grass, a future transition could use stochastic/dithered fading between density levels rather than hard tile geometry swaps.

---

# 35. Relevant files

```text
public/config.yaml
src/grass/GrassField.js
src/grass/GrassGeometry.js
src/grass/GrassGeometryFactory.js
src/grass/GrassTile.js
src/world/TreeSystem.js
src/world/ZoneIndex.js
```

The current LOD system can be summarized as:

```text
GRASS
camera-centered reusable tile grid
        |
        +--> cull empty/outside/invisible tiles
        |
        +--> calculate tile distance
        |
        +--> high / medium / low / veryLow shared geometry

TREES
GLB marker instances
        |
        +--> high-detail model
        |
        +--> smooth distance cross-fade
        |
        +--> low camera-facing representation
        |
        +--> distance cull
```

The most important design choice is that LOD happens at a coarse object level — grass tile or tree instance — rather than per grass blade or per tree triangle. That keeps the runtime decision cost small enough to use every frame.
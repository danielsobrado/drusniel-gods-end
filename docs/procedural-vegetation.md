# Procedural Vegetation

Vegetation placement is generated at runtime. There is no painted vegetation mask in the active pipeline.

## Inputs

`ProceduralVegetationField` combines stable world signals:

- distance to authored dirt ways,
- terrain elevation,
- terrain slope,
- distance to water plus lowland tendency,
- tree trunk proximity,
- tree canopy/shade influence,
- deterministic macro and detail noise.

The dirt-way source comes from `assets.groundBlend`. That texture remains part of the recovered ground material and identifies grass-versus-soil surface areas. It is used only to seed distance-to-path; its pixels are not used directly as final vegetation coverage.

The legacy `assets.grassMask` value is explicitly `null` in the effective configuration.

## Runtime field

The field is built on a configurable square grid. Current settings live in `public/vegetation.yaml`.

For every field cell the builder computes:

```text
terrain Y
terrain normalized height
local slope
world distance to dirt way
world distance to water reference
lowland moisture tendency
tree shade
nearest tree distance
macro noise
detail noise
```

Those inputs are reduced into five CPU ecology values:

```text
density     probability that a grass candidate survives
growth      blade growth/height strength
moisture    wet-to-dry ecological signal
understory  preference for shaded/wet ground vegetation
path        dirt-way proximity influence
```

The formulas are deterministic. A fixed seed produces the same vegetation layout after reload.

## Dirt-way proximity

The ground blend is thresholded once at startup to find dirt-way source pixels. A two-pass distance transform converts those source pixels into approximate world-space distance.

The procedural model then applies:

```text
path clearance -> no vegetation on the core dirt way
path falloff    -> gradual vegetation recovery at the edge
```

This avoids a hard painted grass boundary while preserving the authored route of the original paths.

## Terrain response

Terrain height and slope come from `TerrainSampler`.

Higher terrain can reduce vegetation density. Increasing slope progressively suppresses grass and understory, with steep slopes reaching zero growth. Because the input is the actual `Landscape002` geometry, replacing or reshaping the terrain automatically changes the ecological result.

## Moisture

Moisture combines:

```text
water proximity
+ low elevation tendency
+ seeded macro variation
```

Wet lowlands therefore tend to support denser/taller growth and moisture-loving details, while elevated dry ground becomes shorter and sparser.

The model is deliberately procedural rather than a simulated hydrology solver. If terrain drainage data is introduced later, it can replace or augment the lowland term without changing the grass/material contract.

## Tree influence

Tree positions are already available before the vegetation field is built. They are rasterized into two signals:

```text
nearest trunk distance
canopy/shade influence
```

The trunk clearance produces a vegetation-free root zone immediately around trunks. Canopy influence reduces open-meadow grass while increasing the understory signal.

This creates a transition such as:

```text
open meadow -> tall grass / flowers / seed heads
woodland edge -> mixed shorter grass / ferns
under canopy -> ferns / leaf litter
trunk core -> no grass
```

## Grass density and height

Density and growth are separate ecology values.

CPU candidate compaction uses `density` with a coverage curve: healthy meadow keeps nearly every blade, and only thinner habitat is hash-thinned. Sparse regions still drop candidates instead of making every blade transparent.

The recovered grass shader still reads a compatibility mask whose red channel means exclusion (`grassStrength = 1 - red`). That channel now stores the **path and barren gate**, not continuous growth. Healthy meadow stays black, so blades keep authored width and height. Paths and zero-density cells stay white and are removed by the existing cutoff.

Growth remains a CPU ecology signal for understory and meadow-detail scale. It is no longer used to shrink every procedural blade, which made the carpet look thin and left the ground showing.

## Understory biomes

`MeadowDetails` samples the ecology field instead of a painted mask. Candidate details are selected by ecological conditions:

- strong path influence -> occasional stones and litter,
- high moisture -> reeds,
- strong tree/understory influence -> ferns and litter,
- open sufficiently dense meadow -> flowers and seed heads.

Plant scale and color also respond to moisture, understory and growth, so the secondary vegetation does not repeat one uniform scatter pattern over the entire world.

## GPU texture channels

`ProceduralVegetationField` uploads an RGBA texture for shader compatibility and future GPU consumers:

```text
R = path/barren exclusion (0 in healthy meadow)
G = moisture
B = understory
A = path influence
```

The R encoding is inverted relative to ecology coverage because the recovered grass shader historically interpreted red as exclusion and evaluates `1 - red` before its smooth growth gate. Continuous growth is not packed into R, so meadow blades are not uniformly shortened.

## Configuration

All ecological tuning belongs in `public/vegetation.yaml`. Important groups are:

```text
vegetation.path
vegetation.terrain
vegetation.moisture
vegetation.trees
vegetation.density
vegetation.height
vegetation.understory
vegetation.details
vegetation.noise
```

Do not reintroduce authored vegetation masks for visual tuning. Change the environmental rules or their parameters instead.

## Painter

The grass painter is not part of the active runtime pipeline. `GrassDemo` does not construct or restore `GrassMask`/`GrassPainter`, and the UI exposes no grass-painting control.

Historical mask/painter utility files may remain for compatibility/reference until they are deleted in a separate cleanup, but they are not loaded by `GrassField` or used to decide vegetation placement.

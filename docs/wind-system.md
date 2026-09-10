# Wind System

The default runtime uses the **cinematic wind model**. It deliberately improves on the recovered reference wind by replacing the visible far-field sine/cosine bands with an advected, multi-scale wind field and by giving each vegetation class a different physical response.

The exact recovered implementation is still preserved in `src/grass/RecoveredGrassMaterial.js` and is generated only when `wind.model` is not `cinematic`. Cinematic grass no longer evaluates recovered wind at intensity zero. Set `wind.model: recovered` to compare against the recovered source behavior.

## Source files

```text
src/weather/WindField.js
src/grass/GrassMaterial.js
src/grass/RecoveredGrassMaterial.js
src/world/TreeLeafMaterial.js
src/foliage/LeafSystem.js
src/weather/RainSystem.js
public/cinematic-wind.yaml
```

## Design

The wind field and the vegetation response are separate systems:

```text
prevailing direction
       +
large advected gusts
       +
medium turbulence
       +
small flutter
       +
gust inertia approximation
       |
       v
world-space wind field
       |
       +--> grass stems
       +--> grass tips
       +--> tree canopy / leaves
       +--> falling leaves
       +--> rain streaks
```

This avoids the old visual failure mode where the whole field looked like a synchronized water surface.

## Effective configuration

<!-- effective-config: wind -->
```yaml
model: cinematic
baseStrength: 0.18
minStrength: 0.06
maxStrength: 1.25
noiseScaleReference: 0.3
direction:
  variationDegrees: 12
  scale: 0.03
  speed: 0.035
large:
  scale: 0.015
  speed: 0.08
  strength: 0.70
medium:
  scale: 0.07
  speed: 0.21
  strength: 0.23
flutter:
  scale: 0.35
  speed: 0.70
  strength: 0.07
gust:
  threshold: 0.48
  peak: 0.86
  exponent: 1.6
  inertiaSeconds: 0.12
  inertiaGain: 0.20
response:
  blade:
    bendScale: 0.28
    tipFlutter: 0.035
    tipExponent: 5
    variationMin: 0.85
    variationMax: 1.15
  billboard:
    bendScale: 0.22
    tipFlutter: 0.025
    tipExponent: 4
    variationMin: 0.90
    variationMax: 1.10
  trees:
    bendScale: 0.08
    flutterScale: 0.025
    heightMeters: 8
    outerRadius: 3
  leaves:
    advection: 0.52
    turbulence: 0.22
```

## Advected field

Every noise layer moves through world space along the **prevailing** wind direction, plus a
bounded domain warp:

```text
sample = worldXZ * spatialScale - prevailingDirection * time * layerSpeed + warpOffset
```

The advection direction must be the constant prevailing direction, never the per-position local
direction from `direction.variationDegrees`. The offset is a direction multiplied by *elapsed
time*, so a direction that wobbles by `d` displaces the sample by `d * time` — an error that grows
without bound and makes the wind appear to accelerate the longer the app runs. The meander belongs
in the warp, which is added to the coordinate instead.

The previous implementation often sampled with time added directly to both noise axes or used explicit sine/cosine waves. Those approaches create repeating bands and reversible wave motion. Advecting the field instead makes gust structures travel across the terrain.

The three scales have different jobs:

- **large**: broad gust fronts and the main strength envelope,
- **medium**: local turbulence and direction breakup,
- **flutter**: small, fast detail used mostly at vegetation tips.

## Domain warp

All layers share one low-frequency warp vector that displaces their sample point:

```text
warpOffset = prevailing * alongNoise * amplitude
           + perpendicular * acrossNoise * amplitude * lateralGain
```

```yaml
  warp:
    scale: 0.01
    speed: 0.045
    amplitude: 0.85
    lateralGain: 1.6
```

It does two jobs. Because the warp advects more slowly than any layer, the composite field
*deforms* as it travels rather than sliding rigidly, so gust fronts form and dissolve instead of
sweeping past as clean parallel bands — the failure mode that is most obvious looking straight down
at the meadow. And because cross-wind displacement is gained up by `lateralGain`, gust cells
stretch along the wind and wander across it, the way real gust cells do; an isotropic warp reads as
boiling instead.

The displacement is bounded by `amplitude * (1 + lateralGain)` noise cells and is *added* to the
coordinate, never multiplied into the advection clock, so it cannot grow with elapsed time.

The lattice hash uses large mutually irrational coefficients (`12.9898`, `78.233`). Small ones bias
the gradient angles towards a few directions, which shows up as fronts repeatedly lining up with
the same axis.

## Gust shaping

Large noise is not used as a linear oscillator. It is shaped into intermittent events:

```text
gust = smoothstep(threshold, peak, largeNoise) ^ exponent
```

Most frames therefore stay near the baseline wind, with irregular stronger gusts instead of an endless left/right cycle.

## Inertia

The field also samples the large gust at `time - inertiaSeconds`.

```text
gustVelocity = currentGust - previousGust
strength += gustVelocity * inertiaGain
```

This is a stateless GPU-friendly approximation of plant inertia. It adds a small overshoot when a gust rises or falls without storing per-blade simulation state.

## Direction variation

The preset direction remains dominant. A very low-frequency advected field alters it by at most `direction.variationDegrees`.

This produces local variation without letting the field lose the global wind direction. Strong presets therefore still read as one coherent wind event.

## Grass response

`src/grass/GrassMaterial.js` constructs `RecoveredGrassMaterial` with feature flags. Cinematic wind omits the recovered wind graph instead of evaluating it at intensity zero. Cinematic height omits recovered per-blade height hashes because the cinematic height patch overwrites them. Terrain height, visibility and LOD coverage share one sample; stems that are already hidden skip further deformation. Cached terrain normals replace four height taps when that texture exists. Recovered placement, mask, interaction, static base bend, coloring and LOD behavior remain.

The stem response is angular:

```text
stemWeight = heightRatio ^ stiffness
bendAngle = fieldStrength * bendScale * PI/2 * stemWeight * instanceVariation
horizontal = bladeHeight * sin(bendAngle) * heightRatio
verticalDrop = bladeHeight * abs(cos(bendAngle) - 1) * heightRatio
```

Blade tips receive a separate high-frequency component:

```text
tipWeight = heightRatio ^ tipExponent
flutterOffset = flutter * windIntensity * tipFlutter * bladeHeight * tipWeight
```

The flutter direction is perpendicular to the main wind vector. Roots stay stable, stems follow large gusts, and tips move faster.

Per-instance response varies only within a narrow configured range. The variation breaks synchronization without turning the field into random noise.

## Recovered fallback

The old source-parity shader is retained as the previous `GrassMaterial.js` implementation in:

```text
src/grass/RecoveredGrassMaterial.js
```

Switching to:

```yaml
wind:
  model: recovered
```

restores the recovered near gradient-noise / far sine-cosine wind paths.

## Tree response

Tree foliage samples the same world-space wind field. Response is weighted by local vertex height and radial distance from the trunk:

- low/interior vertices move least,
- upper canopy vertices follow broad gusts,
- outer leaf vertices receive additional flutter.

The existing environment multiplier is preserved: `EnvironmentController` still drives tree wind speed from blade wind intensity times `trees.windSpeedMultiplier`.

## Falling leaves

Falling leaves sample the cinematic field once per frame at the player-centered leaf volume. This keeps the 1,000 CPU-managed leaves coherent without evaluating several noise octaves for every particle.

The field provides bulk advection and cross-wind turbulence. Existing per-leaf drift, floating motion and rotation remain, so individual leaves still separate naturally.

## Rain

Rain keeps the recovered instanced drop geometry, deterministic hash values, wrapping, length/width variation and opacity. In cinematic mode, however, its direction and strength come from the same gust field at the player-centered rain volume.

The existing environment multiplier remains active:

```text
rain wind input = blade windIntensity * rain.windStrengthMultiplier
```

A gust therefore bends grass, moves the tree canopy, carries falling leaves and tilts rain in the same direction.

## Presets and UI

Preset values still provide:

```text
windIntensity
windDirection
windNoiseScale
simulationSpeed
```

`windDirection` becomes the prevailing direction of the cinematic field. `windNoiseScale / wind.noiseScaleReference` scales the cinematic spatial frequencies, so existing presets retain their relative spatial character.

The live wind-strength and simulation-speed controls continue to work through the existing environment snapshots.

## Performance

Cinematic and recovered wind remain two construction paths of the same recovered material, selected by `wind.model`. Tree and rain wind remain GPU-side; falling leaves use one CPU wind-field sample per frame. See [Performance](performance.md) for shader specialization, vegetation jobs and opt-in profiling.

## Regression requirements

Do not replace the cinematic field with periodic sine/cosine displacement. Preserve these properties:

- world-space advection,
- three spatial/temporal scales,
- threshold-shaped gusts,
- delayed gust sample for inertia,
- limited local direction variation,
- separate stem and tip response,
- coherent direction across grass, trees, falling leaves and rain,
- recovered mode as a configuration fallback,
- all tuning values in `public/cinematic-wind.yaml`.

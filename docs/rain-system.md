# Rain System

Rain keeps the recovered GPU-instanced particle implementation, while the default cinematic wind model replaces only the wind vector used to advect and tilt the streaks.

## Source files

```text
src/weather/RainSystem.js
src/weather/WindField.js
src/world/EnvironmentController.js
src/world/GroundMaterial.js
src/water/WaterSurface.js
public/visual-parity.yaml
public/cinematic-wind.yaml
```

## Recovered particle architecture

The particle path remains one instanced draw:

```text
PlaneGeometry(1, 1)
  -> translated by (0, -0.5, 0)
  -> InstancedMesh(count = 10000)
  -> MeshBasicNodeMaterial
  -> TSL position/opacity animation
```

Drop position, size, fall speed, opacity and turbulence seeds still come from the recovered deterministic instance hashes. Vertical movement still uses mathematical `fract` wrapping through the configured top/bottom range.

## Effective rain values

<!-- effective-config: rain -->
```yaml
count: 10000
area: 20
top: 100
bottom: -100
speed: -45
windX: 0.8
windZ: 0.25
windStrength: 10
windStrengthMultiplier: 10
windVariation: 0.6
turbulence: 0.8
dropLength: 1.8
dropWidth: 0.035
opacity: 2
colorLinear: [0.78, 0.86, 1]
defaultRoughness: 0.2
```

`windX`/`windZ` remain the recovered fallback direction when `wind.model: recovered` is selected.

## Cinematic wind coupling

With the default `wind.model: cinematic`, `RainSystem` samples the shared wind field at the player-centered rain volume.

The environment continues to set:

```text
rain wind input = current blade windIntensity * windStrengthMultiplier
```

That input becomes the intensity of the same advected gust field used by vegetation. Per-drop `windVariation` is then applied on top, preserving the recovered visual diversity between streaks.

Rain turbulence is also modulated by the shared medium-scale turbulence field. Individual deterministic turbulence phases remain in place.

This means large gusts now produce one coherent event across grass, tree foliage, falling leaves and rain instead of independent periodic motions.

## Camera-facing streaks

The recovered camera-right widening and wind tilt are unchanged. The long axis stays vertical before wind tilt, and the streak is widened in camera space from the player-centered volume.

## Environment integration

Rain intensity is still interpolated by `EnvironmentController` over the environment transition. It drives:

- rain opacity/visibility,
- water rain ripples,
- ground ripple amount,
- wet-scene roughness.

The particle wind field changes direction and gust strength only; it does not replace those rain-response systems.

## Recovered fallback

Set:

```yaml
wind:
  model: recovered
```

and rain returns to the recovered fixed normalized `(windX, windZ)` direction with the existing wind-strength uniform.

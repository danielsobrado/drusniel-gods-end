# Sky and Cloud System

This document records the recovered sky and cloud behavior reproduced by `grass-test`.

## Evidence

Parity authority for this subsystem is the browser-delivered obfuscated bundle. The recovered classes are the sky class `Xi` and cloud class `bi`. Screenshots are validation only; they are not the source for shader formulas.

## Sky

`SkySystem` uses a `MeshBasicNodeMaterial` on a camera-following sphere.

Recovered geometry and render state:

```text
radius          5000
widthSegments   64
heightSegments  32
side            BackSide
depthWrite      false
depthTest       false
fog             false
toneMapped      true
renderOrder     -1000
name            Sky
frustumCulled   false
```

Before each render the sky sphere copies the active camera position. This keeps the sphere centered on the viewer exactly as the original does.

The shader uses:

```text
direction = normalize(positionWorldDirection)
up = [0, 1, 0]

h = smoothstep(horizonStart, horizonEnd, dot(direction, up))
color = mix(groundColor, horizonColor, h)
color = mix(color, zenithColor, pow(h, 1.5))

sunDot = max(dot(direction, normalize(sunDirection)), 0)
halo = pow(sunDot, haloPower)
disk = pow(sunDot, diskPower)

color = mix(color, sunHaloColor, halo)
color = mix(color, sunDiskColor, disk)
```

Recovered global horizon values:

```text
horizonStart = -0.15
horizonEnd   = 0.45
```

Preset colors, sun position, halo power and disk power continue to come from the environment preset. The environment controller owns the five-second preset interpolation.

## Clouds

The original clouds are not a sphere and do not use trigonometric pseudo-cloud bands. They are one horizontal `PlaneGeometry`.

Recovered runtime geometry and state:

```text
size            5000 x 5000
segments        1 x 1
height          120
rotation.x      -PI / 2
renderOrder     -100
frustumCulled   false

transparent     true
depthWrite      false
depthTest       true
side            BackSide
fog             true
```

The browser bootstrap passes a property named `windDirection`, but the recovered cloud constructor reads `wind`. Because of that mismatch, the original demo actually keeps the constructor default cloud wind:

```text
wind = [1, 0.2]
```

The reproduction stores that effective value explicitly in YAML instead of depending on the accidental argument-name mismatch.

Cloud time is a uniform advanced once per frame:

```text
uTime += deltaSeconds
```

The production demo does not enable `followCamera`, so the cloud plane remains centered at the world origin.

## Cloud noise

Clouds use deterministic value noise, not a texture.

Hash:

```text
hash(p) = fract(sin(dot(p, [127.1, 311.7])) * 43758.5453)
```

Value noise uses the four lattice corners and cubic interpolation:

```text
cell = floor(p)
local = fract(p)
fade = local * local * (3 - 2 * local)
```

FBM is exactly five octaves:

```text
noise(p)      * 0.5
noise(p * 2)  * 0.25
noise(p * 4)  * 0.125
noise(p * 8)  * 0.0625
noise(p * 16) * 0.03125
```

The three cloud-frequency bands are:

```text
drift = wind * time * speed

base = fbm(worldXZ * 0.008 + drift)
mid  = fbm(worldXZ * 0.018 + drift * 1.5)
fine = fbm(worldXZ * 0.045 + drift * 2.0)

combined = base * 0.65 + mid * 0.25 + fine * 0.10
densityAdjusted = combined * density
```

Alpha:

```text
cloudMask = smoothstep(
  coverage - softness,
  coverage + softness,
  densityAdjusted
)

detail = smoothstep(0.25, 0.75, fine)
alpha = cloudMask * mix(0.7, 1.0, detail) * opacity
```

Color:

```text
colorBlend = smoothstep(0.25, 0.8, combined)
color = mix(
  [0.65, 0.68, 0.72],
  [1.0, 1.0, 1.0],
  colorBlend
)
```

Recovered runtime cloud parameters:

```text
size      5000
height    120
coverage  0.52 at construction
softness  0.16
density   1.01
speed     0.1
wind      [1, 0.2]
opacity   0.85
```

`EnvironmentController` interpolates preset `cloudCoverage` and applies it with `setCoverage()`. The other cloud parameters remain global.

## Runtime update

`CloudSystem.update(deltaSeconds)` must run every rendered frame so its explicit time uniform advances. The shader does not use the global TSL `time` node in the original.

## Current parity status

The sky geometry, camera-follow behavior, horizon formula, sun formula, cloud plane, five-octave FBM, cloud color/alpha formulas, effective cloud wind and explicit cloud time update are recovered-code parity behavior.

The visible sky remains separate from the HDR environment map used for PBR illumination and reflections.

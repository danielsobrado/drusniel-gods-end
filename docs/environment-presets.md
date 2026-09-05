# Environment Presets

This document describes the environment preset system exactly as implemented on current `main`. It includes the transition algorithm, subsystem coupling, every current preset value, timing differences between systems, and visual validation notes so another AI can recreate the same weather/time-of-day feel without inventing missing behavior.

## Source files

```text
src/world/EnvironmentController.js
src/environment/SkySystem.js
src/environment/CloudSystem.js
src/grass/GrassField.js
src/grass/GrassMaterial.js
src/weather/RainSystem.js
src/water/WaterSurface.js
src/world/TreeSystem.js
src/audio/AudioSystem.js
src/app/GrassDemo.js
public/config.yaml
```

---

## 1. Preset keys and initial state

Current keys, in YAML order:

```text
sunny
goldenHour
rainy
windy
calm
bowed
moonlight
```

Initial preset:

```yaml
ui:
  initialPreset: sunny
```

Every preset contains:

```text
label
grass.blade
grass.billboard
lighting
sky
cloudCoverage
rain
```

Water base color/roughness/waves are global and are not stored in environment snapshots.

---

## 2. Snapshot structure

`EnvironmentController.snapshot()` converts configuration into a runtime object:

```text
grass.blade
  numeric fields
  baseColor as THREE.Color
  tipColor as THREE.Color

grass.billboard
  same fields

lighting
  color as THREE.Color
  directionalIntensity
  position as THREE.Vector3
  hemisphereSkyColor as THREE.Color
  hemisphereGroundColor as THREE.Color
  hemisphereIntensity
  ambientColor as THREE.Color
  ambientIntensity
  environmentIntensity

sky
  groundColor as THREE.Color
  horizonColor as THREE.Color
  zenithColor as THREE.Color
  sunHaloColor as THREE.Color
  sunDiskColor as THREE.Color
  haloPower
  diskPower
  sunPosition as THREE.Vector3
  fogColor as THREE.Color
  fogDensity

cloudCoverage
rain boolean
```

The controller owns three snapshots:

```text
current
start
target
```

---

## 3. Initial application

Construction reads:

```text
config.presets[config.ui.initialPreset]
```

and creates current/start/target copies of the same Sunny state.

It sets:

```text
elapsed = TRANSITION_SECONDS
```

then immediately calls `#apply()`.

There is therefore no five-second fade from generic world defaults into Sunny during startup; Sunny is applied as the initial environment state before the loading screen is removed.

---

## 4. Preset transition start

When `setPreset(name)` is called:

```text
start = clone(current)
target = snapshot(config.presets[name])
elapsed = 0
```

Because `start` is copied from the currently displayed interpolated state, selecting a third preset while a previous transition is still underway does not jump back to the old endpoint.

This is important for smooth interactive preset switching.

---

## 5. Transition duration and easing

Code constant:

```text
TRANSITION_SECONDS = 5
```

Per frame:

```text
elapsed = min(5, elapsed + deltaSeconds)
raw = elapsed / 5
t = raw * raw * (3 - 2 * raw)
```

This is a smoothstep-style ease with zero slope at start and finish.

Numeric values use linear interpolation with `t`; colors use `THREE.Color.lerp()` and positions use `Vector3.lerp()`.

---

## 6. Grass interpolation fields

Both blade and billboard states interpolate even if only one grass type is currently visible.

Numeric fields:

```text
bladeHeight
bladeWidth
bladeStiffness
baseBend
windIntensity
windDirection
windNoiseScale
simulationSpeed
sheen
```

Colors:

```text
baseColor
tipColor
```

`#apply()` passes both states into `GrassField.setPreset()`. `GrassField` selects:

```text
preset.grass[currentGrassType]
```

falling back to blade values when needed.

This means switching from blade to billboard during or after a preset transition uses a state that has already been kept in sync.

---

## 7. Lighting interpolation fields

Interpolated:

```text
directional light color
directional light relative position
directional intensity
hemisphere sky color
hemisphere ground color
hemisphere intensity
ambient color
ambient intensity
scene.environmentIntensity
```

The HDR image itself is never swapped between presets.

Only its contribution is changed through:

```text
scene.environmentIntensity
```

---

## 8. Sky interpolation fields

Interpolated:

```text
groundColor
horizonColor
zenithColor
sunHaloColor
sunDiskColor
sunPosition
haloPower
diskPower
fogColor
fogDensity
```

Current values are pushed into `SkySystem` every `#apply()`.

Visible sky sun and DirectionalLight use separately stored position vectors, even though the current presets intentionally make them correspond.

---

## 9. Fog and quality

Final fog color:

```text
scene.fog.color = current.sky.fogColor
```

Final fog density:

```text
scene.fog.density = current.sky.fogDensity
                  * quality[currentQuality].fogMultiplier
```

Quality multipliers:

```text
Performance 1.50
Balanced    1.25
High        1.00
Ultra       0.90
```

Therefore a preset screenshot must also specify quality level. Rain/Golden/etc. can look denser or clearer at different quality settings even though preset fog values are identical.

---

## 10. Sun follows the player

After `EnvironmentController.update()` each frame, `GrassDemo` calls:

```text
updateSunTarget(playerPosition)
```

which performs:

```text
sun.position = playerPosition + current.lighting.position
sun.target.position = playerPosition
sun.target.updateMatrixWorld()
```

The directional light therefore preserves its relative direction while following the player spatially.

Do not implement the current lighting position as a fixed absolute world coordinate if parity is required.

---

## 11. Cloud coverage

Only `cloudCoverage` is preset-controlled.

It is interpolated with the same five-second `t` and applied via:

```text
CloudSystem.setCoverage(current.cloudCoverage)
```

These remain global and do not change with presets:

```text
cloud speed
cloud wind direction
cloud softness
cloud density
cloud opacity
cloud color/shadowColor unless explicitly changed elsewhere
```

---

## 12. Tree wind coupling

Every `#apply()` calls:

```text
trees.setWindStrength(current.grass.blade.windIntensity)
```

Important consequences:

- tree wind strength follows the five-second interpolated **blade** wind intensity,
- it still uses blade wind intensity when visible grass type is billboard,
- tree wind does not receive preset grass direction/noise scale/simulation speed.

---

## 13. Rain timing is independent

When selecting a preset:

```text
rain.setIntensity(preset.rain ? 1 : 0)
```

This happens immediately at selection time.

`RainSystem` then damps its own `intensity` toward that target using lambda 5.

It does not use the five-second environment interpolation value.

---

## 14. Water rain timing is binary

At the same selection time:

```text
water.setRain(preset.rain)
```

This sets the water node uniform directly to `0` or `1`.

Water rain ripples therefore switch immediately, unlike visible rain opacity.

The water base color is not a preset field in current code.

---

## 15. Audio timing is independent

At preset selection:

```text
audio.setEnvironment({
  windIntensity: preset.grass.blade.windIntensity,
  rain: preset.rain
})

audio.playTransition()
```

Audio receives final target values immediately and then performs its own exponential volume fading.

It does not receive `current.grass.blade.windIntensity` every frame.

Therefore the wind sound can approach its final target on a different curve from the five-second visual wind transition.

---

## 16. Stored `current.rain` boolean

During the five-second update, controller stores:

```text
current.rain = raw >= 0.5 ? target.rain : start.rain
```

However, current `#apply()` does not use `current.rain` to drive RainSystem or WaterSurface.

The actual rain/water state was already triggered at preset selection as described above.

This stored boolean is therefore currently not the active weather-control path.

---

# Exact Current Presets

The values below are the current `public/config.yaml` values and are high-sensitivity parity data.

---

## 17. Sunny

Label:

```text
Sunny
```

### Blade grass

```yaml
bladeHeight: 1.5
bladeWidth: 0.2
bladeStiffness: 1
baseBend: 0
windIntensity: 1.7
windDirection: 0
windNoiseScale: 0.3
simulationSpeed: 1
baseColor: '#304f0b'
tipColor: '#74a116'
sheen: 0.25
```

### Billboard grass

```yaml
bladeHeight: 1
bladeWidth: 1.5
bladeStiffness: 1
baseBend: 0
windIntensity: 1.7
windDirection: 0
windNoiseScale: 0.3
simulationSpeed: 1
baseColor: '#304f0b'
tipColor: '#74a116'
sheen: 0.25
```

### Lighting

```yaml
color: '#ffd27a'
directionalIntensity: 5
position: [0, 30, 45]
hemisphereSkyColor: '#8fcaff'
hemisphereGroundColor: '#51402a'
hemisphereIntensity: 0.38
ambientColor: '#fff0c4'
ambientIntensity: 0.55
environmentIntensity: 0.32
```

### Sky / fog

```yaml
groundColor: '#c89b62'
horizonColor: '#91d5ff'
zenithColor: '#4174d9'
sunHaloColor: '#ffd77d'
sunDiskColor: '#fff9dc'
haloPower: 100
diskPower: 10000
sunPosition: [0, 30, 45]
fogColor: '#a8cbd0'
fogDensity: 0.005
```

```text
cloudCoverage = 0.65
rain = false
```

Visual intent from the current numbers: bright warm sun, blue/cyan sky, moderate clouds, green grass with darker roots and bright tips.

---

## 18. Golden Hour

Label:

```text
Golden Hour
```

### Blade grass

```yaml
bladeHeight: 1.5
bladeWidth: 0.2
bladeStiffness: 0.9
baseBend: 0.1
windIntensity: 1.5
windDirection: 45
windNoiseScale: 0.38
simulationSpeed: 0.95
baseColor: '#405b0c'
tipColor: '#b6b72a'
sheen: 0.25
```

### Billboard grass

Same wind/material values except:

```yaml
bladeHeight: 1
bladeWidth: 1.5
```

### Lighting

```yaml
color: '#ff9d4d'
directionalIntensity: 3
position: [-44, 18, 50]
hemisphereSkyColor: '#e99a72'
hemisphereGroundColor: '#4a2b20'
hemisphereIntensity: 0.28
ambientColor: '#d8784e'
ambientIntensity: 0.1
environmentIntensity: 0.25
```

### Sky / fog

```yaml
groundColor: '#a96b45'
horizonColor: '#ff9b5d'
zenithColor: '#51437f'
sunHaloColor: '#ffb35c'
sunDiskColor: '#fff0c0'
haloPower: 20
diskPower: 5800
sunPosition: [-44, 18, 50]
fogColor: '#c88973'
fogDensity: 0.005
```

```text
cloudCoverage = 0.55
rain = false
```

Compared with Sunny, the sun is lower, directional intensity is reduced, ambient light is much weaker, and the sky shifts strongly toward orange/purple.

---

## 19. Rain

Key:

```text
rainy
```

Label:

```text
Rain
```

### Blade grass

```yaml
bladeHeight: 1.5
bladeWidth: 0.2
bladeStiffness: 0.85
baseBend: 0.16
windIntensity: 2
windDirection: 0
windNoiseScale: 0.3
simulationSpeed: 1.05
baseColor: '#193f20'
tipColor: '#4f9b35'
sheen: 0.65
```

### Billboard grass

```yaml
bladeHeight: 1
bladeWidth: 1.5
bladeStiffness: 0.85
baseBend: 0.16
windIntensity: 2
windDirection: 0
windNoiseScale: 0.3
simulationSpeed: 1.05
baseColor: '#193f20'
tipColor: '#4f9b35'
sheen: 1
```

### Lighting

```yaml
color: '#9bc7d7'
directionalIntensity: 1
position: [-20, 35, 20]
hemisphereSkyColor: '#719fae'
hemisphereGroundColor: '#202f2b'
hemisphereIntensity: 0.38
ambientColor: '#719ca8'
ambientIntensity: 0.65
environmentIntensity: 0.2
```

### Sky / fog

```yaml
groundColor: '#435d5c'
horizonColor: '#83b5bd'
zenithColor: '#263f50'
sunHaloColor: '#9fbfc2'
sunDiskColor: '#d2e3df'
haloPower: 8
diskPower: 500
sunPosition: [-20, 35, 20]
fogColor: '#83aeb4'
fogDensity: 0.007
```

```text
cloudCoverage = 0.05
rain = true
```

Note the CloudSystem coverage semantics are shader-threshold based; a lower configured coverage threshold does not mean "fewer clouds" in the ordinary percentage sense. It makes more of the procedural noise pass the cloud threshold, producing a stormier/denser appearance.

---

## 20. Wind

Key:

```text
windy
```

Label:

```text
Wind
```

### Blade grass

```yaml
bladeHeight: 1.5
bladeWidth: 0.2
bladeStiffness: 0.72
baseBend: 0.18
windIntensity: 2.8
windDirection: 75
windNoiseScale: 0.3
simulationSpeed: 1.08
baseColor: '#304f0b'
tipColor: '#86b91a'
sheen: 0.25
```

### Billboard grass

Same wind/material values except:

```yaml
bladeHeight: 1
bladeWidth: 1.5
```

### Lighting

```yaml
color: '#ffd990'
directionalIntensity: 3
position: [-20, 35, 50]
hemisphereSkyColor: '#91cbea'
hemisphereGroundColor: '#4a3d28'
hemisphereIntensity: 0.34
ambientColor: '#dceee8'
ambientIntensity: 0.12
environmentIntensity: 0.3
```

### Sky / fog

```yaml
groundColor: '#b99a65'
horizonColor: '#91d0e8'
zenithColor: '#316fc5'
sunHaloColor: '#ffd58b'
sunDiskColor: '#fffbe5'
haloPower: 26
diskPower: 5400
sunPosition: [-20, 35, 50]
fogColor: '#a6c8cf'
fogDensity: 0.005
```

```text
cloudCoverage = 0.45
rain = false
```

This is the strongest normal dynamic-wind preset, primarily because `windIntensity = 2.8` and stiffness is reduced to `0.72`.

---

## 21. Calm

Label:

```text
Calm
```

### Blade grass

```yaml
bladeHeight: 1.5
bladeWidth: 0.2
bladeStiffness: 1
baseBend: 0.2
windIntensity: 0.65
windDirection: 0
windNoiseScale: 0.15
simulationSpeed: 0.98
baseColor: '#304f0b'
tipColor: '#86b91a'
sheen: 0.25
```

### Billboard grass

Same values except:

```yaml
bladeHeight: 1
bladeWidth: 1.5
```

### Lighting

```yaml
color: '#ffd995'
directionalIntensity: 3
position: [10, 40, 20]
hemisphereSkyColor: '#afd5ec'
hemisphereGroundColor: '#5c4b31'
hemisphereIntensity: 0.32
ambientColor: '#f4e4c0'
ambientIntensity: 0.2
environmentIntensity: 0.31
```

### Sky / fog

```yaml
groundColor: '#cfb27b'
horizonColor: '#b8dce1'
zenithColor: '#6289b8'
sunHaloColor: '#f5d18f'
sunDiskColor: '#fff7dc'
haloPower: 23
diskPower: 5000
sunPosition: [10, 40, 20]
fogColor: '#b7cfd0'
fogDensity: 0.005
```

```text
cloudCoverage = 0.70
rain = false
```

Calm still has static `baseBend = 0.2`; low dynamic wind does not mean perfectly vertical blades.

---

## 22. Bowed

Label:

```text
Bowed
```

### Blade grass

```yaml
bladeHeight: 1.5
bladeWidth: 0.2
bladeStiffness: 0.7
baseBend: 0.9
windIntensity: 0.6
windDirection: 1
windNoiseScale: 1
simulationSpeed: 0.8
baseColor: '#304f0b'
tipColor: '#86b91a'
sheen: 0.25
```

### Billboard grass

```yaml
bladeHeight: 1
bladeWidth: 1.5
bladeStiffness: 0.7
baseBend: 0.8
windIntensity: 0.6
windDirection: 1
windNoiseScale: 0.5
simulationSpeed: 0.8
baseColor: '#304f0b'
tipColor: '#86b91a'
sheen: 0.25
```

### Lighting

```yaml
color: '#ffd27a'
directionalIntensity: 3.2
position: [0, 20, 45]
hemisphereSkyColor: '#8fcaff'
hemisphereGroundColor: '#51402a'
hemisphereIntensity: 0.38
ambientColor: '#fff0c4'
ambientIntensity: 0.55
environmentIntensity: 0.32
```

### Sky / fog

```yaml
groundColor: '#c89b62'
horizonColor: '#91d5ff'
zenithColor: '#2864d8'
sunHaloColor: '#ffd77d'
sunDiskColor: '#fff9dc'
haloPower: 28
diskPower: 5500
sunPosition: [0, 20, 45]
fogColor: '#a8cbd0'
fogDensity: 0.005
```

```text
cloudCoverage = 0.65
rain = false
```

This preset is specifically useful for validating that `baseBend` is independent from dynamic wind: the grass should remain heavily leaned while moving less aggressively than the Wind preset.

---

## 23. Moonlight

Label:

```text
Moonlight
```

### Blade grass

```yaml
bladeHeight: 1.5
bladeWidth: 0.2
bladeStiffness: 1.05
baseBend: 0.08
windIntensity: 0.8
windDirection: 20
windNoiseScale: 0.3
simulationSpeed: 0.92
baseColor: '#24451d'
tipColor: '#65904b'
sheen: 0.3
```

### Billboard grass

Same values except:

```yaml
bladeHeight: 1
bladeWidth: 1.5
```

### Lighting

```yaml
color: '#8eafff'
directionalIntensity: 1.6
position: [-35, 20, 30]
hemisphereSkyColor: '#405f8e'
hemisphereGroundColor: '#151c1b'
hemisphereIntensity: 0.2
ambientColor: '#7895c4'
ambientIntensity: 0.55
environmentIntensity: 0.1
```

### Sky / fog

```yaml
groundColor: '#101715'
horizonColor: '#526f8c'
zenithColor: '#050b1c'
sunHaloColor: '#9fc9ff'
sunDiskColor: '#ffffff'
haloPower: 500
diskPower: 12000
sunPosition: [-35, 20, 30]
fogColor: '#263d52'
fogDensity: 0.005
```

```text
cloudCoverage = 0.20
rain = false
```

Moonlight uses much lower environment intensity (`0.1`) and strongly blue lighting/sky values. The very high halo/disk powers make the visible light source tight rather than broad.

---

## 24. Live grass slider behavior

Current UI exposes:

```text
Wind Strength -> windIntensity
Grass Height -> bladeHeight
Simulation Speed -> simulationSpeed
```

`setGrassParameter(name,value)` converts to Number, rejects non-finite values, then updates the named numeric field in:

```text
current blade + billboard
start blade + billboard
target blade + billboard
```

and calls `#apply()` immediately.

This means manual edits persist across the remainder of the current transition but selecting a new preset later replaces target values with that new preset's configured values.

---

## 25. Grass-type switching during a preset

`EnvironmentController` always keeps both blade and billboard states current.

If UI changes grass type:

```text
GrassField rebuilds geometry for new type
same current environment snapshot remains
next GrassField.setPreset applies new type values
```

For most presets, wind/color settings are intentionally similar across types while geometry dimensions differ. Bowed has additional blade-vs-billboard differences in base bend and noise scale.

---

## 26. Quality changes during a preset

UI quality change calls:

```text
grass.setQuality(name)
environment.setQuality(name)
```

`GrassField` changes:

```text
maxDistance
density/detail LODs
tile pool
shadow-map size
```

`EnvironmentController` changes only its selected fog multiplier.

It does not restart or reset the current preset transition.

---

## 27. Runtime frame placement

Current app frame order places:

```text
grass.update
trees.update
leaves.update
birds.update
rain.update
water.update
environment.update
environment.updateSunTarget
audio.update
render
```

So `EnvironmentController.update()` applies the newly interpolated values after grass/tree update logic for that frame but before rendering.

Grass shader uniforms and tree properties updated by environment application are visible to the render immediately.

---

## 28. Systems deliberately not controlled by presets

Current presets do not directly change:

```text
terrain PBR textures or wetness
water base color/wave speed/wave strength
leaf wind strength
leaf gravity/speed
bird speed/radius/count
cloud speed/wind direction/softness/density/opacity
camera
player movement speed
quality profile
renderer pixel ratio
```

Do not make these preset-dependent while claiming exact reproduction.

---

## 29. Exact reproduction checklist

A faithful preset system must:

- start in Sunny without a startup five-second fade,
- maintain `current`, `start`, and `target`,
- start new transitions from current interpolated state,
- use exactly five seconds,
- use `raw² * (3 - 2*raw)` easing,
- interpolate both blade and billboard grass snapshots,
- interpolate exact lighting/sky fields listed above,
- apply quality fog multiplier after preset fog density,
- keep HDR content fixed and interpolate environment intensity only,
- interpolate cloud coverage only,
- feed interpolated blade wind intensity to trees,
- set RainSystem target immediately on selection,
- set water rain flag immediately on selection,
- set audio target and play transition sound immediately on selection,
- keep water base appearance global,
- retain all exact preset numeric/color values.

---

## 30. Visual validation sequence

For parity testing, keep camera/quality fixed and switch through:

```text
Sunny -> Golden Hour -> Rain -> Wind -> Calm -> Bowed -> Moonlight
```

Observe each transition for at least five seconds.

Check:

```text
grass color and bend character
wind strength/direction
sun direction and intensity
sky ground/horizon/zenith colors
sun halo/disk size
fog depth
cloud coverage
rain fade
water ripple state
wind/rain/insect audio response
tree sway strength
```

The purpose is not merely to see different colors. Each preset is a coordinated state across grass, lighting, atmosphere and selected weather/audio systems.

---

## 31. Debugging order when a preset looks wrong

```text
1. verify correct preset key selected
2. verify active quality/fog multiplier
3. verify five-second transition has finished
4. verify current grass type
5. verify exact preset YAML values
6. verify EnvironmentController current/start/target values
7. verify sun follows player with relative preset position
8. verify SkySystem receives current sky values
9. verify cloud coverage threshold semantics
10. verify rain/water/audio timing separately from five-second interpolation
```

Do not tune water or terrain material to compensate for a wrong environment light/sky value.

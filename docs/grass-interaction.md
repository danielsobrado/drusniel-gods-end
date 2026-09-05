# Grass Interaction

This document describes player-to-grass interaction exactly as implemented on current `main`. It is intended to be detailed enough for another AI to reproduce the same temporary grass flattening, persistence, recovery and shader deformation without replacing it with per-blade CPU logic or a different interaction model.

## Source files

```text
src/player/PlayerController.js
src/grass/InteractionMap.js
src/grass/GrassField.js
src/grass/GrassMaterial.js
src/app/GrassDemo.js
public/config.yaml
```

The key architecture is:

```text
animated player helpers
       |
       v
CPU player-centered interaction texture
       |
       v
TSL grass material samples texture
       |
       v
GPU blade deformation
```

No individual grass object is searched or moved from JavaScript.

---

## 1. Configuration

Current values:

```yaml
grass:
  interaction:
    enabled: true
    resolution: 256
    worldSize: 75
    recoverySpeed: 0.94
    footRadius: 0.72
    strength: 1
```

Meaning:

```text
enabled       whether new influence is painted
resolution    texture width/height in pixels
worldSize     world-space width/height represented by the texture
recoverySpeed per-frame red-channel multiplier
footRadius    fallback player influence radius
strength      multiplier for painted influence
```

---

## 2. InteractionMap construction

`InteractionMap` creates:

```text
pixels       = Uint8Array(resolution * resolution * 4)
scrollPixels = Uint8Array(same length)
```

Both are RGBA byte buffers.

`#clearPixels()` performs:

```text
fill entire buffer with 0
for every alpha byte -> 255
```

So a cleared texel is:

```text
R=0 G=0 B=0 A=255
```

Only R is used by the grass shader.

---

## 3. DataTexture configuration

The texture is:

```text
THREE.DataTexture(
  pixels,
  resolution,
  resolution,
  RGBAFormat,
  UnsignedByteType
)
```

with:

```text
colorSpace = NoColorSpace
minFilter = LinearFilter
magFilter = LinearFilter
wrapS = ClampToEdgeWrapping
wrapT = ClampToEdgeWrapping
needsUpdate = true
```

Do not mark this as sRGB. Influence is numeric data, not display color.

---

## 4. Map center and local coverage

The map represents a square centered on player X/Z.

Default:

```text
75 x 75 world units
256 x 256 texels
```

Approximate sampling density:

```text
256 / 75 = 3.4133 texels per world unit
```

Approximate world size per texel:

```text
75 / 256 = 0.29297 world units
```

This local window is what makes interaction persistence practical without maintaining a world-sized texture.

---

## 5. Frame update order inside InteractionMap

`update(playerPosition, influencePoints)` performs exactly:

```text
1. nextCenter = player XZ
2. initialize lastCenter on first update
3. scroll previous map according to center delta
4. lastCenter = nextCenter
5. center = nextCenter
6. recover existing influence
7. if enabled, paint supplied influence points or fallback sphere
8. texture.needsUpdate = true
```

The order matters. Recovery occurs before new foot values are painted, so freshly painted influence is not immediately multiplied by `recoverySpeed` in the same update.

---

## 6. First-update behavior

`lastCenter` begins as `(0,0)`.

The code checks:

```text
if lastCenter.lengthSq() === 0:
    lastCenter = nextCenter
```

Then scrolling sees zero delta on that first initialized frame.

A subtle consequence is that if the true first player center is exactly world `(0,0)`, the zero-vector sentinel is indistinguishable from "not initialized". In normal current start position this is not important.

---

## 7. Scrolling with player movement

Center movement is converted to texel shifts:

```text
pixelsPerWorldUnit = resolution / worldSize
shiftX = trunc(deltaX * pixelsPerWorldUnit)
shiftY = trunc(deltaZ * pixelsPerWorldUnit)
```

Current defaults:

```text
pixelsPerWorldUnit ~= 3.4133
```

The use of `Math.trunc()` is important.

Sub-texel movement is discarded for that frame. The implementation does not retain fractional scroll remainder.

That means very small movement can produce several frames with no texture scroll, followed by an integer shift once the per-frame delta itself reaches a texel threshold. This is current behavior.

---

## 8. Exact scroll copy direction

For each destination pixel `(x,y)`:

```text
sourceX = x + shiftX
sourceY = y + shiftY
```

If the source is outside texture bounds, the destination remains cleared.

Otherwise only these values are copied:

```text
scrollPixels[target R] = pixels[source R]
scrollPixels[target A] = 255
```

G/B remain zero because the scratch buffer was cleared first.

After all pixels:

```text
pixels.set(scrollPixels)
```

This keeps old influence approximately fixed in world space while the local map follows the player.

---

## 9. Recovery

Recovery loops over red bytes only:

```text
R = floor(R * recoverySpeed)
```

Current:

```text
recoverySpeed = 0.94
```

This happens once per rendered update and is not multiplied by `deltaSeconds`.

Therefore recovery is frame-rate dependent.

Approximate remaining fraction after N frames:

```text
0.94 ^ N
```

Examples before byte-floor effects:

```text
10 frames -> ~0.539
30 frames -> ~0.156
60 frames -> ~0.024
```

At 60 FPS this decays much faster in real time than at 30 FPS because the multiplier is applied more often.

Do not convert it to time-based damping if reproducing current behavior exactly.

---

## 10. Primary influence sources

The current Warden GLB has no dedicated foot-helper meshes and `player.influenceObjects` is unset. `PlayerController` therefore supplies its two reusable root-relative fallback points.

Future assets may configure helper names. Any meshes whose names contain `FootSphere` are hidden during model traversal but remain attached to their animated hierarchy.

---

## 11. Foot helper radius calculation

For every found helper:

```text
getWorldPosition(position)
getWorldScale(scale)
computeBoundingSphere() if available
baseRadius = geometry.boundingSphere.radius or configured footRadius
radius = baseRadius * max(scale.x, scale.z)
```

Y scale is not included in the radius multiplier.

The output is:

```text
{ position, radius }
```

and is passed directly into `InteractionMap.update()`.

---

## 12. PlayerController fallback influence points

If no configured FootSphere helpers exist, `PlayerController.getInfluencePoints()` returns two reusable fallback points.

From root facing:

```text
forward = (sin(root.rotation.y), 0, cos(root.rotation.y))
right   = (forward.z, 0, -forward.x)
```

Point A:

```text
root + right * 0.18 + forward * 0.18
```

Point B:

```text
root - right * 0.18 - forward * 0.18
```

Both use configured:

```text
radius = 0.72
```

This is a fallback approximation, not actual foot animation.

---

## 13. InteractionMap fallback sphere

There is one additional fallback layer.

If `InteractionMap.update()` receives an empty `influencePoints` array while interaction is enabled, it paints one sphere at:

```text
playerPosition.x
playerPosition.y
playerPosition.z
```

with hard-coded radius:

```text
0.72
```

and current configured `strength`.

In the normal app path, `PlayerController` returns its two fallback points, so this final field-level fallback is rarely needed.

---

## 14. Runtime enable/disable behavior

`InteractionMap.enabled` starts from:

```text
interaction.enabled !== false
```

The UI calls:

```text
GrassField.setInteractionEnabled(enabled)
  -> InteractionMap.setEnabled(enabled)
```

When disabled:

```text
scrolling continues
recovery continues
texture upload continues
new influence painting stops
```

Existing flattened grass therefore recovers naturally instead of instantly snapping upright.

---

## 15. World-to-interaction-texture conversion

For a sphere center:

```text
uvX = (x - center.x) / worldSize + 0.5
uvY = (z - center.y) / worldSize + 0.5
```

Then pixel center:

```text
centerX = uvX * resolution
centerY = uvY * resolution
```

World radius to pixel radius:

```text
pixelRadius = abs(radius * resolution / worldSize)
```

If:

```text
pixelRadius < 0.5
```

painting returns immediately.

---

## 16. Paint rectangle optimization

Painting does not scan the whole 256x256 texture for each foot.

It calculates a clamped bounding rectangle:

```text
minX = floor(centerX - pixelRadius)
maxX = ceil(centerX + pixelRadius)
minY = floor(centerY - pixelRadius)
maxY = ceil(centerY + pixelRadius)
```

then loops only that region.

This keeps CPU work proportional to influence radius rather than full texture resolution.

---

## 17. Candidate texel world position

For candidate pixel `(px, py)`:

```text
worldX = center.x
       + (((px + 0.5) / resolution) - 0.5) * worldSize

worldZ = center.y
       + (((py + 0.5) / resolution) - 0.5) * worldSize
```

Using pixel center (`+0.5`) avoids evaluating at the texel corner.

---

## 18. Circular XZ rejection

For each candidate:

```text
dx = worldX - sphereX
dz = worldZ - sphereZ
distanceSquared = dx^2 + dz^2
```

If:

```text
distanceSquared > radius^2
```

that texel is skipped.

So even though the loop uses a square bounding rectangle, the painted footprint is circular in XZ before terrain intersection.

---

## 19. Terrain intersection test

The interaction sphere is not allowed to flatten grass under a sphere that is floating too high above the terrain.

For each XZ candidate:

```text
terrainHeight = terrainSampler.sampleHeight(worldX, worldZ)
horizontalRadius = sqrt(max(0, radius^2 - distanceSquared))
```

Reject when:

```text
sphereY - horizontalRadius > terrainHeight + 0.3
```

Interpretation:

```text
sphere bottom at this XZ cross-section
must reach to within 0.3 units above terrain
```

This makes foot-like volumes affect ground grass while reducing influence from elevated helpers.

---

## 20. Radial falloff and byte value

Falloff:

```text
falloff = 1 - sqrt(distanceSquared) / radius
```

New byte value:

```text
value = floor(255 * strength * falloff)
```

The red channel keeps:

```text
max(existingValue, newValue)
```

So overlapping influence volumes reinforce/retain the strongest local value; weaker new values do not erase a stronger footprint.

---

## 21. Shader data passed to GrassMaterial

`InteractionMap.getShaderData()` exposes:

```text
texture
center
worldSize
```

`GrassMaterial` stores uniforms for:

```text
interactionCenter
interactionWorldSize
```

and receives the texture node itself.

Every frame `GrassField` copies the current interaction center into the material uniform.

---

## 22. Shader interaction UV

For every grass instance world XZ:

```text
interactionUv = (worldXZ - interactionCenter)
              / interactionWorldSize
              + 0.5
```

The shader builds soft inside masks:

```text
insideX = smoothstep(0, 0.02, uv.x)
        * smoothstep(0, 0.02, 1 - uv.x)

insideY = smoothstep(0, 0.02, uv.y)
        * smoothstep(0, 0.02, 1 - uv.y)
```

Then samples clamped UV:

```text
influence = texture(interactionTexture, clamp(uv,0,1)).r
          * insideX
          * insideY
```

The edge masks prevent clamp-to-edge sampling from smearing influence infinitely beyond the local map.

---

## 23. Shader interaction amount

The sampled value is converted with:

```text
interactionAmount = smoothstep(0, 0.15, influence)
```

This makes relatively small nonzero values quickly become visually meaningful while still providing a smooth onset.

---

## 24. Deterministic flattening direction

The bend direction is not stored in the interaction map.

Instead it is derived per blade from world XZ:

```text
interactionAngle = fract(
    sin(dot(worldXZ, vec2(0.9898, 0.2330)))
    * 43758.5453
) * 2PI
```

This means two nearby blades can flatten in different deterministic directions even when sampling the same scalar influence value.

The result is less uniform than pushing all affected blades directly away from the foot.

---

## 25. Height-dependent interaction curve

Vertical ratio for interaction:

```text
interactionRatio = clamp(positionLocal.y / bladeHeight, 0, 1)
```

Curve angle:

```text
interactionCurve = interactionAmount
                 * PI/2
                 * 3
                 * interactionRatio
```

Horizontal amount:

```text
interactionHorizontal = bladeHeight
                      * effectiveGrassStrength
                      * sin(interactionCurve)
                      * interactionRatio
```

The extra `interactionRatio` means the blade root remains much more stable than the upper blade.

---

## 26. Interaction deformation before instance rotation

Local coordinates become:

```text
localX = positionLocal.x * widthScale
       + cos(interactionAngle) * interactionHorizontal

localZ = positionLocal.z * widthScale
       + sin(interactionAngle) * interactionHorizontal

localY = positionLocal.y
       * cos(interactionCurve)
       * bladeHeight
```

The X/Z local result is then rotated by the instance's random Y rotation.

This both pushes the blade sideways and lowers it with cosine, giving a bent/flattened result instead of merely shortening the blade.

---

## 27. Interaction combines with mask strength

`effectiveGrassStrength` comes from the permanent grass mask.

Therefore a blade in a weak mask region also receives a weaker interaction displacement.

This keeps transition edges from producing full-size flattening on nearly invisible grass.

---

## 28. Interaction combines with wind and base bend

The final grass vertex position later adds:

```text
base bend horizontal displacement
wind horizontal displacement
```

and subtracts their vertical drops.

So an interacted blade is not frozen. It can remain under active wind while flattened.

There is no special branch that turns wind off when `interactionAmount > 0`.

---

## 29. Permanent grass mask vs temporary interaction map

Do not confuse these systems.

`GrassMask`:

```text
canvas-backed
terrain-global UV mapping
black = grass
white = no grass
editable by Grass Painter
persistent during current session unless cleared/reloaded
can be exported as JPEG
```

`InteractionMap`:

```text
DataTexture
player-centered local mapping
black = no temporary influence
red = stronger temporary influence
scrolls and decays
not saved
```

Walking never paints the permanent mask.

---

## 30. CPU/GPU cost model

CPU work per frame includes:

```text
scroll texture when integer shift occurs
recovery loop over every RGBA texel red byte
paint one/two small influence regions
mark texture for upload
```

At 256x256, recovery touches:

```text
65,536 texels per frame
```

plus paint-region work.

GPU work is per rendered grass vertex sampling the interaction texture and evaluating the bend expressions.

This design avoids maintaining state for every grass instance.

---

## 31. Current non-features

The current interaction system does not implement:

```text
GPU render-target painting
compute-shader footprints
interaction direction texture
velocity-dependent flatten strength
NPC/object grass interaction by default
persistent world-space tracks outside the local map
mud deformation
water ripples from footsteps
footstep decals
terrain depression
```

These may be useful future features but are not current parity behavior.

---

## 32. Exact reproduction checklist

A faithful recreation must:

- create one 256x256 RGBA8 local DataTexture,
- keep it in `NoColorSpace`,
- represent exactly 75x75 world units by default,
- center it on player XZ,
- scroll with integer texel shifts using `Math.trunc`,
- decay red values with `floor(R * 0.94)` each update,
- continue recovery when interaction is disabled,
- use configured hidden helper meshes when present,
- calculate their radius from bounding sphere and X/Z world scale,
- use the exact two fallback positions when helpers are absent,
- apply terrain intersection with `+0.3` allowance,
- paint `max(existing,new)` radial falloff,
- use the edge-masked texture sample in the TSL material,
- convert influence with `smoothstep(0,0.15,...)`,
- derive flatten direction deterministically from world XZ,
- bend/lower blades by vertical ratio,
- keep wind/base bend active at the same time.

---

## 33. Visual validation

Test interaction by walking slowly and running through dense black-mask grass.

Correct behavior should show:

```text
localized flattening around animated feet
upper blade moving more than root
nearby blades bending in varied directions
tracks persisting briefly behind player
tracks recovering without a hard snap
wind continuing through flattened area
no permanent change to grass distribution mask
```

Then disable Foot Interaction while old footprints exist. New footprints should stop appearing, while old deformation should continue fading.

---

## 34. Debugging order

If grass interaction looks wrong, check:

```text
1. Are the root-relative fallback points in the expected positions?
2. If helpers are configured, are their world transforms changing with animation?
3. Is the configured/fallback radius reasonable?
4. Is InteractionMap center following player XZ?
5. Is texture marked needsUpdate?
6. Is the terrain-intersection test rejecting everything?
7. Is shader interaction UV using the same worldSize/center?
8. Is the edge mask accidentally zero?
9. Is influence red channel nonzero?
10. Is permanent grass mask strength near zero in that location?
```

Do not first increase `strength` to compensate for a coordinate-system bug.

---

## Scroll uses a truncated per-frame delta

`InteractionMap.#scroll()` converts the movement since the previous frame into whole texels and
truncates:

```text
shiftX = trunc(deltaX * resolution / worldSize)
shiftY = trunc(deltaZ * resolution / worldSize)
```

The remainder is **discarded rather than accumulated**, so any movement slower than one whole
texel per frame never scrolls the buffer at all.

At `resolution 256` and `worldSize 75` one texel is 0.293 world units, so the minimum speed
that scrolls at all depends on frame rate:

```text
 30 fps    8.8 units/s
 60 fps   17.6 units/s
144 fps   42.2 units/s
```

Effective `walkSpeed` is 2.5 and `runSpeed` is 15, so at 60fps and above **neither walking nor
running scrolls the map**. The scroll path is effectively dead at normal frame rates, and
whether it engages at all is frame-rate dependent.

The consequence is visible: `center` advances every frame while the pixel buffer does not, so
existing flattening stays glued to the player instead of remaining anchored in world space.

This is current behavior and is baked into how the scene looks. Do not "fix" it during parity
work -- accumulating the remainder would change flattening behavior everywhere.

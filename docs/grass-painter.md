# Grass Painter

This document describes the recovered grass painter behavior implemented on `main`.

For parity work, recovered browser-delivered behavior takes priority over earlier clean-room assumptions.

## Runtime ownership

The painter edits the same `GrassMask` canvas used by procedural grass rendering.

It does not edit individual grass instances and it does not write back to the source texture on disk.

Main files:

```text
src/grass/GrassPainter.js
src/grass/GrassMask.js
src/grass/painterMath.js
src/grass/GrassField.js
src/ui/GrassPainterUi.js
public/painter-cursor.yaml
```

## Effective painter configuration

The runtime YAML merge produces these recovered painter-specific values:

```yaml
painter:
  enabled: false
  resolution: 1024
  brushRadius: 5
  height: 5
  initialPaintValue: 83
  orbitCameraHeight: 50
  brush:
    minRadius: 1
    maxRadius: 100
    keyboardStep: 2
    terrainSpan: 370
    strokeSpacing: 0.3
  heightControl:
    min: 1
    max: 10
    maskRange: 200
  cursor:
    innerRadius: 0.9
    outerRadius: 1
    segments: 32
    opacity: 0.5
    color: '#ffffff'
  preview:
    size: 256
    top: 20
    left: 20
```

`resolution` comes from `visual-parity.yaml`; the recovered painter constants come from `painter-cursor.yaml`.

## Mask convention

The mask uses grayscale values:

```text
0   -> strongest grass
255 -> no grass
```

CPU sampling returns:

```text
grassStrength = 1 - red / 255
```

Erase always writes `255`.

## Recovered Add value

The painter starts with the recovered literal Add value:

```text
83
```

This is deliberately not recomputed from the default UI height during construction.

Once the Blade Height control changes, the value uses:

```text
paintValue = round((maxHeight - height) * maskRange / (maxHeight - minHeight))
```

with:

```text
minHeight = 1
maxHeight = 10
maskRange = 200
```

Examples:

```text
height 1  -> 200
height 5  -> 111
height 10 -> 0
```

## Brush radius conversion

The recovered UI brush size is not a direct mask-pixel radius.

It is converted using the recovered terrain span:

```text
pixelRadius = floor((brushRadius / 370) * maskResolution)
```

At the current 1024 mask resolution:

```text
brush 5   -> 13 px
brush 100 -> 276 px
```

## Hard circular brush

The recovered brush is hard-edged.

For every stamp, the painter visits integer pixels inside:

```text
offsetX^2 + offsetY^2 <= radius^2
```

Every included pixel is replaced with the selected grayscale value.

There is no radial feather, alpha blending, hardness curve or source-over gradient in the recovered path.

After a stroke update, the modified `ImageData` is committed back to the canvas and the `CanvasTexture` is marked for upload.

## Stroke interpolation

The recovered spacing is based on world brush size and the fixed terrain span:

```text
spacingUv = (brushRadius / 370) * 0.3
```

For movement from the previous UV to the new UV:

```text
steps = max(1, ceil(distanceUv / spacingUv))
```

Each intermediate point is linearly interpolated and stamped.

This prevents gaps during fast mouse movement while preserving the recovered brush-density rule.

## Terrain raycast

The painter raycasts the terrain with its orbit camera.

The recovered path requires a terrain hit with UV data:

```text
raycaster.intersectObject(terrain, false)[0]
```

The hit UV is cloned and optional `flipU` / `flipV` is applied.

The painter therefore uses the terrain mesh UV from the hit, not `TerrainSampler.worldToUv()`.

## Cursor

Recovered cursor geometry:

```text
RingGeometry(0.9, 1, 32)
```

Material:

```text
MeshBasicMaterial
color = white
opacity = 0.5
transparent = true
depthTest = false
```

The cursor is rotated flat on X:

```text
rotation.x = -PI / 2
```

It is placed directly on the terrain hit point.

The recovered cursor does not change color between Add and Erase modes.

## Painter camera

The painter owns a cloned orbit camera instead of directly handing gameplay camera input to `OrbitControls`.

When enabled:

```text
orbit camera <- current game camera transform
orbitCamera.position.y = 50
LEFT   = disabled for OrbitControls
MIDDLE = dolly
RIGHT  = rotate
```

The player controller is disabled and pointer lock is released.

Each painter frame:

```text
controls.update()
game camera <- orbit camera transform
```

This keeps rendering through the normal game camera while editing from the recovered overhead orbit mode.

## Mouse controls

Recovered mappings:

```text
LMB       paint
RMB       rotate
Shift+RMB pan
MMB       zoom
```

The browser context menu is suppressed while the painter event handlers are installed.

## Keyboard controls

Recovered shortcuts:

```text
[     brush - 2
]     brush + 2
1     Add mode
2     Erase mode
8     Save Mask
P     toggle continuous painting
```

Brush size is clamped to `1..100`.

`P` is case-insensitive because the handler receives `event.key` and checks the lower-case `p` path used by the recovered implementation.

## Continuous paint toggle

When `P` enables continuous painting, the painter immediately stamps at the last recorded mouse position when a valid terrain hit exists.

Pressing `P` again stops painting, clears the previous stroke UV and hides the cursor.

This is separate from holding LMB.

## Preview

The mask preview is a 256 x 256 canvas appended to `document.body`.

Recovered placement:

```text
top: 20px
left: 20px
2px white border
```

It is made visible only while painter mode is enabled.

The preview shows the full mask scaled into the 256 x 256 canvas.

## Painter UI

The recovered painter has its own panel instead of embedding all editing controls inside the normal demo controls.

The panel contains:

```text
Terrain Tool
Grass Painter
Add Grass / Erase
Brush Size
Blade Height
Clear All
Save Mask
shortcut help
```

`Clear All` asks for confirmation before replacing the whole mask with `255`.

The panel close button calls back into `GrassField.setPainterEnabled(false)` so the editor, player state and normal Controls button stay synchronized.

## LOD while painting

When painter mode is active, visible grass tiles use the recovered fixed LOD:

```text
low
```

Distance, terrain overlap, empty-mask and frustum visibility tests still run.

When painter mode is disabled, normal distance-selected LOD resumes on the next update.

## Empty-tile remapping

After painting or clearing, `GrassField.remapEmptyTiles()` rebuilds the CPU empty-tile set.

This lets newly painted grass regions become renderable and lets fully erased regions be skipped.

## Clear and save

Clear writes the full mask to:

```text
255
```

Save exports:

```text
grass-mask.jpg
image/jpeg
quality 0.95
```

JPEG is lossy. A saved and reloaded mask can therefore differ slightly from the exact in-memory grayscale values.

## Known limitation

The painter changes the procedural grass mask immediately, but the separately loaded ground-material blend texture is not replaced at runtime.

This means edited grass distribution can temporarily disagree with the ground grass/dirt appearance until the saved mask is used as the source asset and the scene is reloaded.

## Parity checklist

A recovered-parity painter should satisfy all of these:

- starts disabled,
- uses a 1024 backing mask in the current merged configuration,
- starts Add mode with paint value `83`,
- converts brush radius with terrain span `370`,
- uses hard circular pixel writes,
- interpolates strokes with factor `0.3`,
- uses terrain hit UVs,
- uses a white `RingGeometry(0.9, 1, 32)` cursor at opacity `0.5`,
- creates a separate orbit camera and raises it to Y `50`,
- disables player controls while editing,
- supports RMB rotate, Shift+RMB pan and MMB zoom,
- supports `[`, `]`, `1`, `2`, `8` and `P`,
- shows the recovered 256px top-left preview,
- asks before Clear All,
- exports `grass-mask.jpg`,
- forces visible grass tiles to `low` LOD while painter mode is active,
- closes through `GrassField` so UI state remains synchronized.

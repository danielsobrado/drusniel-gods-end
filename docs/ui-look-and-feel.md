# UI Look and Feel

This document separates UI behavior observed directly on the live reference demo from reconstruction-specific styling and tools.

## Evidence priority

For the public HUD, use this order:

1. live reference DOM and visible text,
2. recovered browser-delivered behavior,
3. current implementation,
4. screenshot inference.

The current live reference page exposes the control structure and labels clearly. Exact original CSS source has not been recovered into this repository, so pixel-level CSS values remain reconstruction values unless explicitly identified as recovered elsewhere.

## Source files

```text
src/ui/DemoUi.js
src/ui/GrassPainterUi.js
src/ui/LoadingUi.js
src/ui/Minimap.js
src/ui/minimapBake.js
src/styles.css
src/minimap.css
```

## Public reference control structure

The live demo exposes this control order:

```text
Controls
Preset
Grass Shape
Quality
Wind Strength
Grass Height
Pixel Ratio
Foot Interaction
Tonemapper
Temporal AA / Bloom / Light Shafts / Depth of Field / Sharpen / Film Grain / Vignette
  Focus Range / Blur Strength (indented under Depth of Field)
Join Waitlist
```

Simulation Speed is no longer on the panel; presets still author `simulationSpeed` per grass family. The post-effect rows come from `src/rendering/postEffects.js` and switch `CinematicPipeline` live; defaults are `cinematic.post.effects`.

Depth of Field is on by default and carries two sliders, listed in `POST_EFFECT_LEVELS` and seeded from `cinematic.post.depthOfField`: Focus Range (`focalRange`, 10–60) and Blur Strength (`bokehScale`, 0.2–1.6). Both drive uniforms the built effect graph already reads, so moving them costs no rebuild. The slider group folds away while the effect is off. `focusDistance` is deliberately not exposed: the pipeline tracks the character every frame, and a manual override would let the player defocus themselves.

The reference does not use native HTML selects for the first three controls. The DOM contains a current value plus a set of button options.

The reconstruction therefore uses custom choice menus for Preset, Grass Shape and Quality.

## Preset labels

Presets are named as places rather than as weather readouts:

| Config key | Label |
| --- | --- |
| `sunny` | Highfield |
| `goldenHour` | Emberfall |
| `rainy` | Greyrain |
| `windy` | Galewind |
| `calm` | Stillmeadow |
| `bowed` | Lowsway |
| `moonlight` | Moonrise |

`label` in `public/config.yaml` is the only source. The UI previously carried a `PRESET_LABEL_OVERRIDES` map that renamed two presets for the dropdown while the HUD brand line kept printing the raw config label, so the two disagreed on screen; that map is gone.

Configuration keys are unchanged. They are the join across `config.yaml`, `cinematic-look.yaml` and the audio presets in `visual-parity.yaml`, so they stay stable while labels are free to change.

## Grass Shape

Options name the silhouette, not the rendering technique:

```text
Slender     tapered blade, the default
Reed        narrow, near-parallel sides
Broadleaf   wide at the base, rounded edge
Tufted      textured atlas card
```

Each shape declares a render family (`blade` or `billboard`) that supplies its parameters, material, LOD and wind response — see `docs/grass-system.md`. Changing shape rebuilds the grass geometry and refreshes the visible wind, height and simulation-speed values from the current preset's **family** block.

Both preset and shape changes are played behind the circle iris (`src/ui/IrisTransition.js`), which also hides the geometry rebuild.

## Quality

Reference options:

```text
Performance
Balanced
High
Ultra
```

Selecting quality updates both grass quality and environment quality consumers through `GrassDemo` actions.

## Live sliders

The public HUD exposes three sliders:

```text
Wind Strength
Grass Height
Pixel Ratio
```

Effective ranges are still configuration-driven:

```yaml
windStrength: { min: 0, max: 3, step: 0.1 }
grassHeight: { min: 0.5, max: 3, step: 0.1 }
pixelRatio: { min: 0.5, max: 2, step: 0.25 }
```

The numeric output beside each slider is reconstruction UI; the runtime value is authoritative.

## Foot Interaction

The reference exposes a Foot Interaction control after the four sliders.

The reconstruction keeps it as a checkbox and delegates to:

```text
GrassField.setInteractionEnabled(enabled)
```

Disabling interaction stops new interaction painting while existing influence can continue to recover.

## Metrics

The live reference exposes:

```text
FPS
TRIS
```

The reconstruction keeps these as small top-right metrics and refreshes the displayed values approximately every 0.5 seconds.

## Bottom HUD

The live reference contains a brand image followed by these control hints:

```text
MOUSE  Look around
WASD   Walk
SHIFT  Run
```

It also exposes a second `JOIN WAITLIST` action and an `A product by techredux.co` link.

The reconstruction restores this bottom-HUD structure. It uses a text wordmark rather than copying the reference logo asset into the repository.

## Waitlist boundary

The public reference page contains a waitlist modal and signup flow.

This repository does not impersonate or duplicate that service. Both reconstructed waitlist actions open the official live demo in a new tab instead of collecting email addresses locally.

This is an intentional product boundary, not a parity bug.

## Grass Painter boundary

The public live control panel does not expose a Grass Painter button in its visible DOM.

The reconstructed demo keeps a small `Grass Painter` tool button because the recovered painter itself is a major parity subsystem and needs an accessible entry point during development and validation.

Treat this button as a reconstruction/developer extension. The painter panel itself follows recovered painter behavior documented in `grass-painter.md`.

## Choice menu behavior

Each choice control has:

```text
label
current-value trigger
hidden option button list
```

Opening one menu closes the others. Clicking outside closes all menus. Selecting an option:

1. updates the visible value,
2. updates the active option state,
3. closes the menu,
4. invokes the corresponding runtime action.

All window-level listeners are registered through an `AbortController` and removed by `DemoUi.dispose()`.

## Current reconstruction styling

The main panel remains intentionally secondary to the scene:

```text
compact typography
translucent dark-green background
soft backdrop blur
low-contrast border
lime interaction accent
small top-right metrics
```

Current desktop geometry:

```text
controls top: 45px
controls right: 28px
controls width: 218px
metrics top: 16px
metrics right: 28px
bottom HUD left: 28px
footer right: 28px
```

These CSS measurements describe current reconstruction behavior. They are not claimed as recovered original CSS constants.

## Minimap and world map

The minimap has no counterpart in the live reference; it is an exploration aid for the expanded landscape.

`Minimap` puts a circular map in the lower-right corner of the cinematic HUD, turned so the camera's view points up. An `N` badge rides the rim toward north (-Z, where the alpine massif stands), a pale arrow and view cone mark the player (or the free-fly/tour camera) at the centre, and navigation locations show as gold pins. A pill on the dial's lower rim names the biome underfoot. On desktop the mouse wheel over the dial zooms between 90 m and 720 m of radius.

Clicking or tapping the dial, or pressing `M`, opens the world map: the whole terrain north-up, with every location labelled, the player arrow and a biome legend. Selecting a pin or its label travels there through `WorldNavigation.teleport`. `M`, `Esc`, the close button or a click outside the panel closes it. It lives in the HUD overlay, so `H` hides it along with the rest of the interface.

`minimapBake.js` builds the image once, 2.5 m per pixel, from the same CPU queries the world uses: terrain height and hillshade, sea and lake levels, the river course, snow and sand coverage, the western forest weight, the coastal-jungle region, slope- and altitude-based rock, and the landscape paths, with faint 20 m contours and a dark dot per placed tree. Each pixel also records its biome id, which is what the rim label reads. The bake is a generator stepped in 8 ms slices on timers, so it finishes during loading without blocking it; the dial appears once it is done. A dial redraw is a single rotated `drawImage` and is skipped while the view is still.

Sizing follows the shorter screen side: `clamp(84px, 19vmin, 184px)`, capped at 112px on touch screens so the dial stays below the mobile `RUN` button (150px above the corner). Below 768px wide or 500px tall the dial moves to a 16px/20px safe-area inset and the metrics line moves above it; on desktop the metrics sit to the dial's left.

## Mobile behavior

At the reconstruction's `860px` CSS breakpoint:

```text
Controls becomes a compact toggleable right-side panel
choice menus remain button-based
control hints are hidden
bottom product/waitlist footer is hidden
text brand remains at bottom-left
Grass Painter becomes a bottom sheet
mask preview is hidden
```

The renderer/player mobile breakpoint remains separate at `768px`.

## Loading UI

`LoadingUi` is still a reconstruction loading screen, not a recovered copy of the public site's startup presentation.

It reports application stages and fades away after shader compilation. Do not treat its current typography, gradient or timing as reference evidence.

## Acceptance checklist

Public-HUD parity should verify:

- Preset is a button menu, not a native select,
- Grass Shape is a button menu,
- Quality is a button menu,
- preset labels match `config.yaml` exactly, with the dropdown and the HUD brand line showing the same name,
- Grass Shape lists Slender, Reed, Broadleaf and Tufted,
- preset and shape changes play the circle iris,
- four live sliders remain wired,
- Foot Interaction remains wired,
- Join Waitlist appears after Foot Interaction,
- FPS and TRIS are visible when stats are enabled,
- MOUSE / WASD / SHIFT hints are present on desktop,
- bottom `JOIN WAITLIST` and product link are present on desktop,
- external waitlist actions do not collect user data in this reconstruction,
- closing/disposal removes window listeners,
- Grass Painter remains clearly understood as a reconstruction/developer extension.

## Reproduction rule

Do not replace the public control structure with dat.GUI, lil-gui, Leva, native select boxes or a generic debug panel during parity work.

When exact reference CSS becomes available, replace reconstruction styling from source evidence rather than visually tuning arbitrary values.

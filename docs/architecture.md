# Architecture

Drusniel Wilds is a small procedural Three.js environment. Runtime behavior is defined by this repository and `public/config.yaml`; the project does not depend on scene metadata embedded in external models.

## Modules

- `NatureApp` owns renderer lifecycle, camera follow, input wiring and subsystem updates.
- `PlayerController` owns player movement and the procedural avatar.
- `GrassField` owns deterministic grass placement and wind animation.
- `RainSystem` owns the optional procedural rain field.
- `createWorld` creates the ground and lighting.
- `Hud` exposes the small runtime control surface.

## Design rules

Configuration belongs in YAML. Runtime modules receive only the configuration they need. Rendering systems own and dispose their Three.js resources. No subsystem relies on hidden mesh names, baked transforms or external scene conventions.

# Character Rig and Animation

This document describes the current Drunsiel Warden player asset and how the runtime integrates it.

## Playable roster

`public/characters.yaml` lists the characters offered on the loading screen. The
choice is made before the player GLB is fetched, because it decides which asset
is loaded and how tall the capsule ends up:

```yaml
characters:
  default: drusniel
  roster:
    - id: drusniel
      model: Assets/Drunsiel_Warden_biped_Animation_Running_withSkin.glb
    - id: enanillo
      model: Assets/Enanillo_Dwarven_Running_withSkin.glb
```

`src/config/characterRoster.js` applies the selection by rewriting `assets.player`
and merging the entry's `player` block over the effective player config, so every
system downstream keeps reading `config.player` and nothing else changes shape.
`?character=<id>` preselects an entry and skips the picker, which keeps headless
and screenshot runs from stalling on a gate that needs a click.

Values below describe the default character, Drusniel.

## Asset and loader

The configured player asset is:

```yaml
assets:
  player: Assets/Drunsiel_Warden_biped_Animation_Running_withSkin.glb
```

`PlayerController.loadModel()` loads it through `GLTFLoader` with the configured Draco decoder. The imported `gltf.scene` remains intact as a visual child of `PlayerController.root`.

```text
Three.js Scene
└── PlayerController.root
    ├── procedural capsule placeholder
    └── gltf.scene
        └── Armature
            ├── char1 (skinned mesh)
            └── 24-joint skeleton
```

The gameplay root owns world translation, terrain placement, and facing rotation. The imported scene owns its mesh, material, skeleton, and animation.

## Model transform

<!-- effective-config -->
```yaml
player:
  modelScale: 1.35
  modelOffsetY: 0
  modelRotationY: 0
```

These values are applied directly to `gltf.scene`. World locomotion is then applied to the parent gameplay root. `character-visual.yaml` owns the Warden-specific scale override so asset sizing is independent from recovered camera and movement values.

## Mesh and rig preparation

Every imported mesh receives shadows, rain roughness metadata, and generated vertex normals when available. The controller does not replace the Warden material or reconstruct its skeleton.

The GLB currently contains:

```text
mesh: char1
skin: Armature
joints: 24
animation: Armature|running|baselayer
```

Skin indices, weights, inverse bind matrices, animation tracks, and bone hierarchy all come from the GLB.

## Animation mapping

<!-- effective-config: player -->
```yaml
animations:
  idle: null
  walk: Armature|running|baselayer
  run: Armature|running|baselayer
```

The asset contains one movement clip, so walking and running share it. When the player stops, the controller fades out the movement action and returns to the GLB's static pose. The mixer advances once per player update with `deltaSeconds`.

Animation does not provide world translation. `PlayerController` moves the gameplay root, keeping the animation in place relative to that root.

## Grass interaction

The Warden GLB has no `FootSphere` helper meshes and the current configuration does not set `player.influenceObjects`. `PlayerController.getInfluencePoints()` therefore uses two reusable points offset around the gameplay root.

Those points are grass-interaction metadata, not physics colliders. See `docs/grass-interaction.md` for the interaction-map behavior.

## Replacement contract

A future player GLB must provide:

- one importable scene root,
- valid mesh/skeleton bindings,
- clips matching `player.animations`,
- an in-place animation suitable for code-driven locomotion.

Optional animated helper meshes can be named through `player.influenceObjects`; otherwise the root-relative fallback remains active. Scale, local Y offset, and forward orientation can be adjusted through YAML.

Both shipped characters are the same 24-joint armature with the same bone names, so
a clip authored against one skin binds by name and plays on the other. A roster entry
lists such borrowed clips in `player.animationSources`, and `PlayerController` merges
them into the mixer alongside the clips in the character's own GLB. Enanillo uses this
to get an authored walk from `Enanillo_Dwarven_Walking_withSkin.glb`; Drusniel has no
authored walk and keeps the procedural `Cinematic_walk` fallback.

## Implementation boundaries

- One player GLB is loaded per session; the character cannot be changed without a reload.
- There is no animation-retargeting system; `animationSources` relies on identical bone names, not retargeting.
- There is no runtime armour inventory/equipment system.
- There is no code-defined bone-name map.
- The runtime preserves the exported GLB hierarchy.
- Player world translation comes from `PlayerController`, not root motion.

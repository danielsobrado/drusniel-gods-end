# Character Rig and Animation

This document describes the current Drunsiel Warden player asset and how the runtime integrates it.

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

## Implementation boundaries

- One player GLB is loaded.
- There is no animation-retargeting system.
- There is no runtime armour inventory/equipment system.
- There is no code-defined bone-name map.
- The runtime preserves the exported GLB hierarchy.
- Player world translation comes from `PlayerController`, not root motion.

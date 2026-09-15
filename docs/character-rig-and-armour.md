# Character Rig and Animation

This document describes the current Drusniel dark elf player asset and how the runtime integrates it.

## Playable roster

`public/characters.yaml` lists the characters offered on the loading screen. The
choice is made before the player GLB is fetched, because it decides which asset
is loaded and how tall the capsule ends up:

```yaml
characters:
  default: drusniel
  roster:
    - id: drusniel
      model: Assets/Drusniel_Dark_Elf.glb
    - id: enanillo
      model: Assets/Enanillo_Dwarven.glb
    - id: paladin
      model: Assets/Radiant_Paladin.glb
    - id: cleric
      model: Assets/Arcane_Wizard.glb
    - id: serpent
      model: Assets/Serpent_Master.glb
    - id: wizard
      model: Assets/Devout_Cleric.glb
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
  player: Assets/Drusniel_Dark_Elf.glb
```

`PlayerController.loadModel()` loads it through `GLTFLoader` with the configured Draco decoder. The imported `gltf.scene` remains intact as a visual child of `PlayerController.root`.

```text
Three.js Scene
└── PlayerController.root
    ├── procedural capsule placeholder
    └── gltf.scene
        └── Armature
            ├── output_unwrapped (skinned mesh)
            └── 28-joint skeleton
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
mesh: output_unwrapped
skin: Armature
joints: 28
animations: Running, Walking, restpose
```

`restpose` is the authored bind pose as a clip. Nothing maps to it: `animations.idle`
stays null, and the controller returns to the static pose by fading the movement
action out, which is the same thing without a mixer action to keep alive.

Skin indices, weights, inverse bind matrices, animation tracks, and bone hierarchy all come from the GLB.

## Animation mapping

<!-- effective-config: player -->
```yaml
animations:
  idle: null
  walk: Walking
  run: Running
```

The asset contains both movement clips, so walking and running use their own. When the player stops, the controller fades out the movement action and returns to the GLB's static pose. The mixer advances once per player update with `deltaSeconds`.

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

### Two rig generations

Two armatures ship. The original is 24 joints, exported in centimetres (`Hips` sits at
y=97.3) under an `Armature` node scaled 0.01, with its mesh named `char1` and clips
named `Armature|running|baselayer` and `Armature|walking_man|baselayer`. The re-authored
skins -- Drusniel, the Wizard, the Serpent Master -- are 28 joints: the same skeleton
plus four leaf bones (`LeftHand_End`, `RightHand_End`, `LeftToe_end`, `RightToe_end`),
exported in metres at `Armature` scale 1, mesh `output_unwrapped`, clips `Running` and
`Walking`.

| Character | Joints | Mesh | Units | Triangles | Ships as |
| --- | --- | --- | --- | --- | --- |
| `Drusniel_Dark_Elf.glb` | 28 | `output_unwrapped` | m | 31k | 1.6 MB |
| `Devout_Cleric.glb` | 28 | `output_unwrapped` | m | 88k | 2.6 MB |
| `Serpent_Master.glb` | 28 | `output_unwrapped` | m | 31k | 2.3 MB |
| `Enanillo_Dwarven.glb` | 24 | `char1` | cm | 54k | 1.2 MB |
| `Radiant_Paladin.glb` | 24 | `char1` | cm | 28k | 1.3 MB |
| `Arcane_Wizard.glb` | 24 | `char1` | cm | 43k | 1.4 MB |

**The unit change does not reach the screen.** `#applyModelScale()` measures the model
with `Box3.setFromObject`, and for a `SkinnedMesh` three.js takes `object.boundingBox`,
which `SkinnedMesh.computeBoundingBox()` fills from `getVertexPosition()` -- vertices put
through the bone transform -- and then multiplies that box by the mesh node's world
matrix. The two factors are inverses of each other across the generations:

| | skinned local height | mesh `matrixWorld` scale | measured native height |
| --- | --- | --- | --- |
| 24-joint | 170.0 | 0.01 | **1.700** |
| 28-joint | 1.7 | 1.0 | **1.700** |

So all six characters measure 1.700, all six get `scale = targetHeight / 1.700`, and
all six end up with the same `scaleRatio` of 2.179 -- which matters, because that ratio
also multiplies acceleration, the zoom clamps, the idle-speed threshold and the grass
foot radius. Every character except the dwarf is authored at `targetHeight: 5.0` and
stands exactly as tall as the others.

The agreement is a property of the skinned path only. The *unskinned* geometry bounds of
an old-rig GLB come out at 0.017, a hundredth of a new-rig one, so anything that measures
a roster GLB outside three.js -- an asset script, a thumbnail baker -- has to reproduce
the bone transform or it will read the two generations a hundredfold apart.

### Borrowing clips

Within a generation the bone names match, so a clip authored against one skin binds by
name and plays on the others. A roster entry lists such borrowed clips in
`player.animationSources`, and `PlayerController` merges them into the mixer alongside
the clips in the character's own GLB. Across generations the joint sets differ, so a
borrowed clip would bind partially; `test/characterRoster.test.js` refuses that.

Borrowing at runtime costs a whole extra GLB fetch, which is only worth it when the
clip genuinely lives with another character. No shipped character needs it any more,
so every roster entry carries an empty `animationSources`. The Serpent Master and the
Cleric also carry unused extra clips (dances, jumps, gestures) that came with their
exports; they cost a few kilobytes each and nothing maps to them.

Each character was authored as a separate GLB per clip, which meant shipping the skin
and its texture once per animation. `scripts/merge-glb-animations.mjs` rebinds clips
by bone name at build time so the skin ships once, then compresses the result with
Draco geometry and a WebP texture:

| Asset | Authored as | Ships as |
| --- | --- | --- |
| `Enanillo_Dwarven.glb` | 2 files, 23.4 MB | 1.2 MB |
| `Radiant_Paladin.glb` | 2 files, 15.2 MB | 1.3 MB |
| `Drusniel_Dark_Elf.glb` | 1 file, 17.8 MB | 1.6 MB |
| `Devout_Cleric.glb` | 1 file, 30.3 MB | 2.6 MB |
| `Serpent_Master.glb` | 1 file, 19.7 MB | 2.3 MB |
| `Arcane_Wizard.glb` | 1 file, 9.0 MB | 1.4 MB |

The four newest skins arrived with their clips already merged, so the script ran on them
with no `--clips` at all -- purely for the compression pass. Their bulk was uncompressed
PNG: the Wizard shipped a 8.1 MB base colour and a 13.4 MB metallic-roughness map, and
the WebP re-encode is most of the 91% saving.

Every asset carries a walk and a run of its own, which is why no roster entry borrows.
Neither compression format needs loader changes: `PlayerController` already attaches a
`DRACOLoader`, and `GLTFLoader` handles `EXT_texture_webp` natively.

The Paladin is the lightest mesh on the roster (28k triangles), so its texture dominates
the compressed size and the ratio is lower: most of its 15.2 MB was two copies of one
6.4 MB PNG.

## Implementation boundaries

- One player GLB is loaded per session; the character cannot be changed without a reload.
- There is no animation-retargeting system; `animationSources` relies on identical bone names, not retargeting.
- There is no runtime armour inventory/equipment system.
- There is no code-defined bone-name map.
- The runtime preserves the exported GLB hierarchy.
- Player world translation comes from `PlayerController`, not root motion.

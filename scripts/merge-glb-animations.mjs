/**
 * Merges animation clips from one or more GLBs into a single model GLB, then
 * optionally compresses the result.
 *
 * Characters in this project share one armature -- in two generations, 24 joints and
 * 28, the latter adding four leaf bones -- with identical bone names, which is why a
 * clip authored against one skin plays on another of the same generation.
 * `PlayerController` exploits that at runtime through `player.animationSources`: it
 * fetches each extra GLB purely to harvest `gltf.animations` and merge them into the
 * mixer. That is expensive when the extra GLB is a full duplicate of the skin -- the
 * Enanillo walk cycle shipped 11.7 MB of byte-identical mesh and texture to deliver
 * 10 KB of animation. This script does the same merge at build time so only the clips
 * ship.
 *
 * With no --clips the script is a compression pass alone, for skins that already
 * carry their clips.
 *
 * Clips are rebound by bone NAME, not by node index, because the two documents are
 * separate glTF files whose node numbering need not agree.
 *
 * Usage:
 *   node scripts/merge-glb-animations.mjs --model <glb> --clips <glb> [--clips <glb>]
 *                                         --out <glb> [--no-compress] [--check]
 *                                         [--texture-size <px>]
 *
 * --texture-size caps the compressed textures at that square size. Assets that
 * read small on screen (NPCs, props) use it; the character roster does not.
 */
import { statSync, writeFileSync } from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, draco, prune, textureCompress } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';

/** Quality for the WebP re-encode. 85 is the point where the dwarf skin shows no banding. */
const WEBP_QUALITY = 85;

function parseArgs(argv) {
  const options = { model: null, clips: [], out: null, compress: true, check: false, textureSize: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--model') options.model = argv[++i];
    else if (arg === '--clips') options.clips.push(argv[++i]);
    else if (arg === '--out') options.out = argv[++i];
    else if (arg === '--texture-size') options.textureSize = Number(argv[++i]);
    else if (arg === '--no-compress') options.compress = false;
    else if (arg === '--check') options.check = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.model) throw new Error('--model is required');
  if (!options.out) throw new Error('--out is required');
  return options;
}

async function createIO() {
  return new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'draco3d.decoder': await draco3d.createDecoderModule(),
      'draco3d.encoder': await draco3d.createEncoderModule(),
    });
}

function jointNames(document) {
  const skin = document.getRoot().listSkins()[0];
  if (!skin) return null;
  return skin.listJoints().map((joint) => joint.getName());
}

/**
 * Copies every animation out of `source` into `target`, rebinding each channel to the
 * target node of the same name.
 *
 * A channel that silently loses its target does not throw at load time -- it produces
 * a character whose arm never moves -- so an unmatched bone name is a hard error here.
 */
function copyAnimations(target, source, sourceLabel) {
  const byName = new Map();
  for (const node of target.getRoot().listNodes()) byName.set(node.getName(), node);

  const copied = [];
  for (const animation of source.getRoot().listAnimations()) {
    const name = animation.getName();
    if (target.getRoot().listAnimations().some((existing) => existing.getName() === name)) {
      throw new Error(`${sourceLabel}: clip "${name}" already exists in the model`);
    }

    const merged = target.createAnimation(name);
    const samplers = new Map();

    for (const channel of animation.listChannels()) {
      const targetNode = channel.getTargetNode();
      const boneName = targetNode?.getName();
      const bound = boneName ? byName.get(boneName) : null;
      if (!bound) {
        throw new Error(
          `${sourceLabel}: clip "${name}" targets bone "${boneName ?? '<none>'}", `
          + 'which does not exist in the model GLB',
        );
      }

      const sourceSampler = channel.getSampler();
      let sampler = samplers.get(sourceSampler);
      if (!sampler) {
        sampler = target.createAnimationSampler()
          .setInterpolation(sourceSampler.getInterpolation())
          .setInput(target.createAccessor()
            .setType(sourceSampler.getInput().getType())
            .setArray(sourceSampler.getInput().getArray().slice()))
          .setOutput(target.createAccessor()
            .setType(sourceSampler.getOutput().getType())
            .setArray(sourceSampler.getOutput().getArray().slice()));
        samplers.set(sourceSampler, sampler);
        merged.addSampler(sampler);
      }

      merged.addChannel(target.createAnimationChannel()
        .setTargetNode(bound)
        .setTargetPath(channel.getTargetPath())
        .setSampler(sampler));
    }

    copied.push(`${name} (${merged.listChannels().length} channels)`);
  }
  return copied;
}

function mb(bytes) {
  return `${(bytes / 1048576).toFixed(2)} MB`;
}

async function main(argv) {
  const options = parseArgs(argv);
  const io = await createIO();

  const model = await io.read(options.model);
  const modelJoints = jointNames(model);
  let inputBytes = statSync(options.model).size;

  for (const path of options.clips) {
    const source = await io.read(path);
    const sourceJoints = jointNames(source);
    // The rebinding below is by name, so a differing joint set means clips would bind
    // partially and animate a subset of the skeleton. Refuse rather than half-apply.
    if (modelJoints && sourceJoints
      && JSON.stringify([...modelJoints].sort()) !== JSON.stringify([...sourceJoints].sort())) {
      throw new Error(`${path}: joint set differs from the model GLB; these are not the same rig`);
    }
    const copied = copyAnimations(model, source, path);
    inputBytes += statSync(path).size;
    console.log(`merged from ${path}: ${copied.join(', ') || '(no animations)'}`);
  }

  await model.transform(dedup(), prune());

  if (options.compress) {
    await model.transform(
      textureCompress({
        encoder: sharp,
        targetFormat: 'webp',
        quality: WEBP_QUALITY,
        // Optional cap for assets that read small on screen; NPC skins use it.
        resize: options.textureSize > 0 ? [options.textureSize, options.textureSize] : null,
      }),
      // Defaults quantize generic attributes to 12 bits, which is lossless for the
      // 0-27 joint indices these rigs use.
      draco(),
    );
  }

  const output = Buffer.from(await io.writeBinary(model));

  const clips = model.getRoot().listAnimations().map((animation) => animation.getName());
  console.log(`clips in ${options.out}: ${clips.join(', ')}`);
  console.log(
    `${mb(inputBytes)} -> ${mb(output.length)} `
    + `(${(100 - (output.length / inputBytes) * 100).toFixed(1)}% smaller)`
    + (options.compress ? '' : ' [merge only, no compression]'),
  );

  if (options.check) {
    console.log('[check only, nothing written]');
    return;
  }
  writeFileSync(options.out, output);
}

await main(process.argv.slice(2));

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { MeshoptEncoder } from 'meshoptimizer';
import { NodeIO, VertexLayout } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco from 'draco3dgltf';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { meshSimplifierReady, simplifiedStage } from '../src/rendering/meshSimplify.js';
import {
  geometrySignature,
  NPC_LOD_RATIOS,
  npcStageKey,
  SCENE_PREPROCESSING_MANIFEST,
  SCENE_PREPROCESSING_VERSION,
  scenePreprocessingSettings,
  STRUCTURE_STAGES,
} from '../src/assets/scenePreprocessing.js';
import { PLACEMENTS } from '../src/world/structurePlacements.js';
import { NPC_KINDS } from '../src/npc/npcKinds.js';

// Bakes the house and NPC simplification stages StructureSystem and NpcSystem
// used to compute on every startup (~1 s of main-thread meshoptimizer work).
// Each GLB is decoded with the same Draco version the browser loads, its
// textures are dropped, and the result is parsed by three's own GLTFLoader so
// the traversal order and attribute layout match the runtime exactly. The
// stages come from the runtime's simplifiedStage itself; the runtime checks a
// signature of every decoded primitive before it uses one.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'public', SCENE_PREPROCESSING_MANIFEST);
// Index sequences (meshopt's lossless codec, which keeps the exact order),
// then gzip: 6.8 MiB of raw indices become under 1 MiB on the wire.
const DATA_NAME = 'scene-preprocessing.bin.gz';
const DATA = path.join(path.dirname(MANIFEST), DATA_NAME);
const force = process.argv.includes('--force');

const meshoptimizerVersion = JSON.parse(await readFile(path.join(ROOT, 'node_modules/meshoptimizer/package.json'), 'utf8')).version;
const threeVersion = JSON.parse(await readFile(path.join(ROOT, 'node_modules/three/package.json'), 'utf8')).version;

const sources = [
  // Generated houses have no stages to bake; their GLBs load only in the
  // ?village=glb comparison mode, which simplifies at runtime instead.
  ...[...new Set(PLACEMENTS.filter((placement) => !placement.procedural).map((placement) => placement.path))].map((file) => ({ file, kind: 'structure' })),
  ...[...new Set(Object.values(NPC_KINDS).map((kind) => kind.model))].map((file) => ({ file, kind: 'npc' })),
];

const hashes = {};
for (const source of sources) {
  hashes[source.file] = createHash('sha256').update(await readFile(path.join(ROOT, 'public', source.file))).digest('hex');
}

async function upToDate() {
  try {
    const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
    const data = await readFile(DATA);
    return manifest.settings === scenePreprocessingSettings()
      && manifest.meshoptimizer === meshoptimizerVersion && manifest.three === threeVersion
      && manifest.dataSha256 === createHash('sha256').update(data).digest('hex')
      && sources.every((source) => manifest.sources[source.file]?.sha256 === hashes[source.file])
      && Object.keys(manifest.sources).length === sources.length;
  } catch {
    return false;
  }
}

if (!force && await upToDate()) {
  console.log('Scene preprocessing is up to date.');
  process.exit(0);
}

// Separate (not interleaved) attributes, as the browser's Draco decode yields.
const io = new NodeIO()
  .setVertexLayout(VertexLayout.SEPARATE)
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'draco3d.decoder': await draco.createDecoderModule() });

// Decoded geometry with no textures or extensions, as a plain GLB that
// GLTFLoader parses without a decoder, a transcoder or an image loader.
async function decodedScene(file) {
  const document = await io.read(path.join(ROOT, 'public', file));
  for (const texture of document.getRoot().listTextures()) texture.dispose();
  for (const extension of document.getRoot().listExtensionsUsed()) extension.dispose();
  const glb = await io.writeBinary(document);
  const buffer = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength);
  const gltf = await new GLTFLoader().parseAsync(buffer, '');
  return gltf.scene;
}

const chunks = [];
let offset = 0;
function store(indices) {
  const encoded = MeshoptEncoder.encodeIndexSequence(indices, indices.length, 4);
  const descriptor = { offset, bytes: encoded.length, count: indices.length };
  chunks.push(Buffer.from(encoded));
  offset += encoded.length;
  return descriptor;
}

await meshSimplifierReady;
await MeshoptEncoder.ready;
const manifest = {
  version: SCENE_PREPROCESSING_VERSION,
  settings: scenePreprocessingSettings(),
  meshoptimizer: meshoptimizerVersion,
  three: threeVersion,
  data: `Assets/generated/${DATA_NAME}`,
  sources: {},
};
for (const source of sources) {
  const started = performance.now();
  const scene = await decodedScene(source.file);
  // The same selection and order as StructureSystem.#prepareStages and
  // NpcSystem.#prepareLods: each distinct geometry once, in traversal order.
  const seen = new Set();
  const primitives = [];
  scene.traverse((object) => {
    if (!object.isMesh || seen.has(object.geometry)) return;
    if (source.kind === 'structure' && object.isSkinnedMesh) return;
    seen.add(object.geometry);
    const geometry = object.geometry;
    const requests = source.kind === 'structure'
      ? Object.entries(STRUCTURE_STAGES)
      : NPC_LOD_RATIOS.filter((ratio) => ratio < 1).map((ratio) => [npcStageKey(ratio), { ratio }]);
    const stages = {};
    for (const [key, options] of requests) {
      const stage = simplifiedStage(geometry, options);
      stages[key] = stage === geometry ? 'source' : store(Uint32Array.from(stage.index.array));
    }
    primitives.push({
      ordinal: primitives.length,
      signature: geometrySignature(geometry),
      vertexCount: geometry.attributes.position.count,
      stages,
    });
  });
  manifest.sources[source.file] = { sha256: hashes[source.file], primitives };
  console.log(`${source.file}: ${primitives.length} primitives in ${Math.round(performance.now() - started)} ms`);
}

const raw = Buffer.concat(chunks);
// dataBytes is the inflated size the runtime checks; the hash is of the file.
manifest.dataBytes = raw.length;
const data = gzipSync(raw, { level: 9 });
manifest.dataSha256 = createHash('sha256').update(data).digest('hex');
await mkdir(path.dirname(MANIFEST), { recursive: true });
// Complete files first, then swap them in: the data before the manifest that
// points at it.
await writeFile(`${DATA}.tmp`, data);
await writeFile(`${MANIFEST}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`);
await rename(`${DATA}.tmp`, DATA);
await rename(`${MANIFEST}.tmp`, MANIFEST);
console.log(`Baked scene preprocessing: ${sources.length} sources, ${(data.length / 1048576).toFixed(2)} MiB compressed indices.`);

// Re-encodes the baked medieval house albedo textures as KTX2 (Basis UASTC,
// Zstandard-supercompressed) inside their GLBs.
//
// A 4096^2 WebP decodes to 64 MB of RGBA8 (85 MB with mips) per house, all
// uploaded in one go when the village streams in. UASTC transcodes to a GPU
// block format (BC7/ASTC/ETC2) at a quarter of that and skips the decode, so the
// sharper bake costs about what the old 2048^2 RGBA8 texture did.
//
//   node scripts/encode-structure-ktx2.mjs [dir]   (needs toktx on PATH, or TOKTX)
//
// Runtime: StructureSystem hands GLTFLoader the shared KTX2 loader.
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import draco3d from 'draco3dgltf';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRTextureBasisu } from '@gltf-transform/extensions';

const DIRECTORY = process.argv[2] ?? 'public/Assets/terrain/structures/medieval';
const TOKTX = process.env.TOKTX ?? 'toktx';

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => (code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`))));
  });
}

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'draco3d.encoder': await draco3d.createEncoderModule(),
  });
const temporary = await mkdtemp(path.join(os.tmpdir(), 'grass-structure-ktx2-'));

try {
  for (const name of (await readdir(DIRECTORY)).filter(file => file.startsWith('medieval-house') && file.endsWith('.glb'))) {
    const file = path.join(DIRECTORY, name);
    const document = await io.read(file);
    const textures = document.getRoot().listTextures().filter(texture => texture.getMimeType() !== 'image/ktx2');
    if (!textures.length) {
      console.log(`${name}: already KTX2`);
      continue;
    }
    for (const [index, texture] of textures.entries()) {
      const png = path.join(temporary, `${name}-${index}.png`);
      const ktx2 = path.join(temporary, `${name}-${index}.ktx2`);
      await sharp(Buffer.from(texture.getImage())).png().toFile(png);
      await run(TOKTX, [
        '--t2', '--2d', '--genmipmap',
        '--encode', 'uastc', '--uastc_quality', '2',
        // Rate-distortion optimisation lets Zstandard shrink the file a lot
        // for a barely visible cost on a painted albedo.
        '--uastc_rdo_l', '1.0', '--zcmp', '18',
        '--assign_oetf', 'srgb', '--assign_primaries', 'bt709',
        ktx2, png,
      ]);
      texture.setImage(new Uint8Array(await readFile(ktx2))).setMimeType('image/ktx2');
      if (texture.getURI()) texture.setURI(texture.getURI().replace(/\.[a-z0-9]+$/i, '.ktx2'));
    }
    document.createExtension(KHRTextureBasisu).setRequired(true);
    document.getRoot().listExtensionsUsed()
      .filter(extension => extension.extensionName === 'EXT_texture_webp')
      .forEach(extension => extension.dispose());
    await writeFile(file, await io.writeBinary(document));
    console.log(`${name}: ${textures.length} texture(s) -> KTX2`);
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}

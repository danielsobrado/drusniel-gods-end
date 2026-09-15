import { mkdir, readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { createHash } from 'node:crypto';

export const TEXTURE_SOURCES = [
  ['bark-painted', '06_35_58', 'bark'],
  ['bark-rugged', '06_36_05', 'bark'],
  ['bark-peeling', '06_37_01', 'bark'],
  ['bark-knotted', '06_40_29', 'bark'],
  ['leaves-green', '06_44_41', 'leaf'],
  ['leaves-gold', '06_50_12', 'leaf'],
  ['leaves-pale', '06_52_54', 'leaf'],
];
export const TEXTURE_DIRECTORY = 'public/Assets/terrain/fantasy-textures';

export async function prepareStylizedTreeTextures() {
  await mkdir(TEXTURE_DIRECTORY, { recursive: true });
  const textures = new Map(), records = [];
  for (const [name, time, kind] of TEXTURE_SOURCES) {
    const source = `assets-source/stylized-textures/ChatGPT Image Sep 14, 2026, ${time} AM.png`;
    const original = await readFile(source);
    const side = 512;
    const extension = kind === 'bark' ? 'jpg' : 'png';
    const resized = sharp(original).resize(side, side, { kernel: 'lanczos3' });
    const image = kind === 'bark'
      ? await resized.jpeg({ quality: 80, mozjpeg: true }).toBuffer()
      : await resized.png({ palette: true, colours: 128, dither: 0, effort: 10 }).toBuffer();
    await writeFile(`${TEXTURE_DIRECTORY}/${name}.${extension}`, image);
    textures.set(name, image);
    records.push({ name, source, file: `${name}.${extension}`, width: side, height: side,
      originalBytes: original.length, bytes: image.length, alpha: kind === 'leaf' });
  }
  await writeFile(`${TEXTURE_DIRECTORY}/manifest.json`, JSON.stringify({
    source: 'User-supplied ChatGPT-generated artwork, 2026-09-14',
    processing: 'Lanczos resize; JPEG bark; indexed PNG foliage with transparency; original artwork preserved in assets-source',
    textures: records,
  }, null, 2) + '\n');
  console.log('Stylized textures:', records.map(r => `${r.name} ${Math.round(r.bytes / 1024)} KiB`).join(', '));
  return textures;
}

export function applyStylizedTreeTextures(doc, type, textures) {
  const barkNames = ['painted', 'rugged', 'knotted', 'peeling', 'knotted', 'peeling', 'painted', 'rugged', 'knotted'];
  const leafName = type <= 3 ? 'gold' : type <= 6 ? 'pale' : 'green';
  for (const material of doc.getRoot().listMaterials()) {
    const mode = material.getAlphaMode();
    if (mode === 'BLEND') continue; // Far-tree images are baked separately.
    const bark = mode === 'OPAQUE';
    const name = bark ? `bark-${barkNames[type - 1]}` : `leaves-${leafName}`;
    const map = material.getBaseColorTexture();
    if (!map) continue;
    map.setImage(textures.get(name)).setMimeType(bark ? 'image/jpeg' : 'image/png').setName(name);
    material.setBaseColorFactor([1, 1, 1, 1]).setRoughnessFactor(0.9).setMetallicFactor(0);
    material.setNormalTexture(null).setMetallicRoughnessTexture(null);
    material.setExtras({ ...material.getExtras(), stylizedTexture: name });
  }
}

export async function applyBakedTreeBillboard(doc, type, textures) {
  let baked;
  try { baked = JSON.parse(await readFile(`${TEXTURE_DIRECTORY}/billboard-${type}.json`, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const hash = createHash('sha256').update(Buffer.concat([...textures.values()])).digest('hex');
  if (baked.sourceHash !== hash) return;
  const low = doc.getRoot().listNodes().find(n => n.getName() === `Tree${type}_Low`);
  const image = await readFile(`${TEXTURE_DIRECTORY}/billboard-${type}.png`);
  low.traverse(node => {
    for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
      const position = primitive.getAttribute('POSITION');
      const uv = primitive.getAttribute('TEXCOORD_0');
      // The bake indexes corners in the draco-decoded runtime order, which is
      // not the authored order, so match each authored corner by its UV.
      const matched = baked.uvs && uv
        ? matchBakedCornersByUv(position.getArray(), uv.getArray(), baked)
        : new Float32Array(baked.positions);
      position.setArray(matched);
      primitive.getMaterial().getBaseColorTexture().setImage(image).setMimeType('image/png');
    }
  });
}

function matchBakedCornersByUv(positions, uvs, baked) {
  const matched = new Float32Array(positions.length);
  const bakedCount = baked.uvs.length / 2;
  for (let index = 0; index < uvs.length / 2; index += 1) {
    const u = uvs[index * 2], v = uvs[index * 2 + 1];
    const x = positions[index * 3], y = positions[index * 3 + 1], z = positions[index * 3 + 2];
    let best = 0, bestDistance = Infinity;
    for (let candidate = 0; candidate < bakedCount; candidate += 1) {
      // The two cards share their seam UVs; break ties by staying on the
      // card whose corners lie nearest the authored corner.
      const uvDistance = Math.hypot(baked.uvs[candidate * 2] - u, baked.uvs[candidate * 2 + 1] - v);
      const positionDistance = Math.hypot(baked.positions[candidate * 3] - x,
        baked.positions[candidate * 3 + 1] - y, baked.positions[candidate * 3 + 2] - z);
      const distance = uvDistance + positionDistance * 1e-4;
      if (distance < bestDistance) { bestDistance = distance; best = candidate; }
    }
    matched.set(baked.positions.slice(best * 3, best * 3 + 3), index * 3);
  }
  return matched;
}

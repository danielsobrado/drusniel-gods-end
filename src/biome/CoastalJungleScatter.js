// The source world does not author its floor into the scene: at load time it
// scatters grass, groundcover and a few understory plants over every chunk
// outside the hero patch, all from one seeded LCG. Replaying that sequence puts the same plants
// in the same places as the original.
const LAYERS = [
  { count: 'grassPerChunk', prefixes: ['grass'] },
  { count: 'groundcoverPerChunk', prefixes: ['groundcover'] },
  { count: 'undergrowthPerChunk', prefixes: ['fern', 'broadleaf', 'palm'] },
];

// The original chose among its catalog in glTF mesh order, which for this
// scene is name order within each prefix.
export function coastalJungleScatterAssets(names, prefixes) {
  const sorted = [...new Set(names ?? [])].sort();
  return prefixes.flatMap((prefix) => sorted.filter((name) => name.startsWith(`${prefix}_`)));
}

export function scatterCoastalJungleFloor(settings, assetNames, visit) {
  const extent = Number(settings?.extent);
  const size = Number(settings?.chunkSize);
  const plantExtent = Number(settings?.plantExtent ?? 0);
  const pathClearance = Number(settings?.pathClearance ?? 0.5);
  if (!(extent > 0) || !(size > 0)) return 0;
  let seed = Number(settings.seed) >>> 0;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const layers = LAYERS.map((layer) => ({
    count: Math.max(0, Math.floor(Number(settings[layer.count]) || 0)),
    assets: coastalJungleScatterAssets(assetNames, layer.prefixes),
  }));

  let visited = 0;
  for (let x = -extent; x < extent; x += size) {
    for (let z = -extent; z < extent; z += size) {
      for (const { count, assets } of layers) {
        for (let index = 0; index < count; index += 1) {
          const px = x + random() * size;
          const pz = z + random() * size;
          if (Math.abs(px) < plantExtent && Math.abs(pz) < plantExtent) continue;
          // The authored trail (ForestPath) follows x = 1.8 sin(0.11 y) in Blender's Y.
          if (Math.abs(px - 1.8 * Math.sin(-pz * 0.11)) < pathClearance) continue;
          // Draws stay in the original order even for a missing asset.
          const asset = assets[Math.floor(random() * assets.length)];
          const scale = 0.65 + random() * 0.65;
          const yaw = random() * Math.PI * 2;
          if (asset === undefined) continue;
          visit(asset, px, pz, yaw, scale);
          visited += 1;
        }
      }
    }
  }
  return visited;
}

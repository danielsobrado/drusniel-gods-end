import { logger } from '../utils/logger.js';
import { resolvePresetConfig } from '../config/resolvePresetConfig.js';
import { BiomeFootprints, findSafeBiomePosition } from './BiomePlacement.js';

export function resolveSafePose(demo, prepared) {
  const occupied = prepared?.active ? prepared.solids : new BiomeFootprints();
  const player = demo.player;
  return findSafeBiomePosition({
    position: player.getPosition(),
    terrain: demo.world.terrainSampler,
    ecology: demo.grass.vegetation,
    occupied,
    radius: player.metrics.radius,
    rootToFeet: player.metrics.rootToFeet,
    groundOffset: player.metrics.groundOffset,
    waterY: (demo.config.water?.position?.[1] ?? 0) - 0.1,
  });
}

export async function preparePresetChange(demo, name, generation) {
  const resolved = resolvePresetConfig(demo.config, name);
  const signal = demo.abortController.signal;
  if (!resolved?.activeBiome) {
    const layout = await demo.grass.prepareLayout(null, { signal });
    return { generation, name, active: false, resolved, layout };
  }
  const prepared = await demo.biome.prepare(resolved.biome, demo.player.getPosition(), {
    signal, generation, ecology: demo.grass.vegetation, terrain: demo.world.terrainSampler,
  });
  if (prepared?.missing) throw new Error(prepared.error ?? 'Biome assets are unavailable.');
  const layout = await demo.grass.prepareLayout({
    field: prepared.field, solids: prepared.solids,
  }, { signal });
  return { generation, name, active: true, resolved, prepared, layout };
}

export function commitPresetChange(demo, payload) {
  const wasEnabled = demo.player.enabled;
  demo.player.setEnabled(false);
  try {
    if (payload.generation !== demo.presetGeneration) {
      return { applied: false, reason: 'stale' };
    }
    const pose = resolveSafePose(demo, payload.prepared);
    if (!pose) {
      if (demo.grass.pendingLayout?.revision === payload.layout?.revision) demo.grass.abortLayout();
      return { applied: false, reason: 'unsafe' };
    }
    demo.biome.commit(payload.prepared ?? { active: false, generation: payload.generation });
    demo.grass.commitLayout(payload.layout);
    demo.biome.setPreset(payload.name);
    demo.environment.setPreset(payload.name);
    demo.player.translateRoot(pose.x, pose.y, pose.z);
    return { applied: true, pose };
  } catch (error) {
    logger.error('Preset commit failed; restoring movement.', error);
    return { applied: false, reason: 'error' };
  } finally {
    demo.player.setEnabled(wasEnabled);
  }
}

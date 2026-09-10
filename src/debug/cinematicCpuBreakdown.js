const originals = new WeakMap();

export function wrapNodeUpdateBefore(node, stats, key) {
  if (!node || typeof node.updateBefore !== 'function') return false;
  if (originals.has(node)) return true;
  const original = node.updateBefore.bind(node);
  originals.set(node, original);
  node.updateBefore = (frame) => {
    const start = performance.now();
    try {
      return original(frame);
    } finally {
      stats[key] = (stats[key] ?? 0) + (performance.now() - start);
    }
  };
  return true;
}

export function resetCpuStats(stats) {
  stats.scene = 0;
  stats.depthResolve = 0;
  stats.gtao = 0;
  stats.bloom = 0;
  stats.composite = 0;
  return stats;
}

export function accountComposite(stats, totalMs) {
  const nested = (stats.scene ?? 0) + (stats.depthResolve ?? 0) + (stats.gtao ?? 0) + (stats.bloom ?? 0);
  stats.composite = Math.max(0, totalMs - nested);
  return stats;
}

export function applyCpuMarks(profiler, stats) {
  if (!profiler?.marks || !stats) return;
  for (const [name, value] of Object.entries(stats)) {
    if (!Number.isFinite(value)) continue;
    profiler.marks[name] = (profiler.marks[name] ?? 0) + value;
  }
}

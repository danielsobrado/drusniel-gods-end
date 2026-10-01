const activeConfigs = new WeakSet();

export function setCoastalJungleRuntimeActive(config, active) {
  if (!config || typeof config !== 'object') return;
  if (active) activeConfigs.add(config);
  else activeConfigs.delete(config);
}

export function isCoastalJungleRuntimeActive(config) {
  return Boolean(config && typeof config === 'object' && activeConfigs.has(config));
}

const COARSE_POINTER_QUERY = '(pointer: coarse)';

export function isMobileStartup(config, runtime = globalThis) {
  const settings = config.ui?.mobileStartup;
  if (!settings?.enabled) return false;

  const width = Number(runtime.innerWidth);
  const height = Number(runtime.innerHeight);
  const maxShortSide = Number(settings.maxShortSide);
  if (!(width > 0) || !(height > 0) || !(maxShortSide > 0)) return false;
  if (Math.min(width, height) > maxShortSide) return false;

  if (settings.requireCoarsePointer === false) return true;
  return Boolean(runtime.matchMedia?.(COARSE_POINTER_QUERY)?.matches);
}

export function applyMobileStartupProfile(config, runtime = globalThis) {
  if (!isMobileStartup(config, runtime)) return false;

  const settings = config.ui.mobileStartup;
  if (settings.initialQuality && config.quality?.[settings.initialQuality]) {
    config.ui.initialQuality = settings.initialQuality;
  }

  const cap = Number(settings.pixelRatioCap);
  const currentCap = Number(config.renderer?.pixelRatioCap);
  if (cap > 0 && Number.isFinite(cap)) {
    config.renderer.pixelRatioCap = Number.isFinite(currentCap)
      ? Math.min(currentCap, cap)
      : cap;
  }

  return true;
}

export function mobileWarmupTravelDistance(config) {
  return Number(config.ui.mobileStartup.warmupTravelDistance);
}

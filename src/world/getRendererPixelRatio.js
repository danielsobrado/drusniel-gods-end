export function getRendererPixelRatio(config) {
  const configured = Number(config.ui?.pixelRatio);
  if (Number.isFinite(configured)) return configured;
  return Math.min(window.devicePixelRatio, config.renderer.pixelRatioCap);
}

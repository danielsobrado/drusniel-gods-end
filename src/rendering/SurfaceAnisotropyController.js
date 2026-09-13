const DEFAULT_LEVEL = 16;
const MIN_LEVEL = 1;
const MAX_LEVEL = 16;
const PATH_NAME_PATTERN = /(path|trail|road)/i;

function materialList(material) {
  if (Array.isArray(material)) return material;
  return material ? [material] : [];
}

function addMaterialTextures(textures, material) {
  for (const entry of materialList(material)) {
    for (const value of Object.values(entry ?? {})) {
      if (value?.isTexture) textures.add(value);
    }
    for (const value of entry?.userData?.textures ?? []) {
      if (value?.isTexture) textures.add(value);
    }
  }
}

export function resolveSurfaceAnisotropy(config) {
  const settings = config?.renderer?.surfaceAnisotropy ?? {};
  const requestedLevel = Number(settings.level);
  const level = Number.isFinite(requestedLevel)
    ? Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, Math.round(requestedLevel)))
    : DEFAULT_LEVEL;
  return {
    enabled: settings.enabled === true,
    level,
  };
}

export function collectSurfaceAnisotropyTextures(demo) {
  const textures = new Set();
  const terrainMaterial = demo?.world?.terrainTarget?.material ?? demo?.world?.ground?.material;
  addMaterialTextures(textures, terrainMaterial);

  const pathTexture = demo?.world?.terrainSampler?.paths?.texture;
  if (pathTexture?.isTexture) textures.add(pathTexture);
  const expansionPathTexture = demo?.world?.expansion?.paths?.texture;
  if (expansionPathTexture?.isTexture) textures.add(expansionPathTexture);

  demo?.world?.scene?.traverse?.((object) => {
    if (!PATH_NAME_PATTERN.test(String(object?.name ?? ''))) return;
    addMaterialTextures(textures, object.material);
  });

  return textures;
}

export function applySurfaceAnisotropy(demo, enabled = resolveSurfaceAnisotropy(demo?.config).enabled) {
  const settings = resolveSurfaceAnisotropy(demo?.config);
  const active = Boolean(enabled);
  if (demo?.config?.renderer) {
    demo.config.renderer.surfaceAnisotropy ??= {};
    demo.config.renderer.surfaceAnisotropy.enabled = active;
    demo.config.renderer.surfaceAnisotropy.level = settings.level;
  }

  const textures = collectSurfaceAnisotropyTextures(demo);
  const anisotropy = active ? settings.level : MIN_LEVEL;
  for (const texture of textures) {
    texture.anisotropy = anisotropy;
    texture.needsUpdate = true;
  }
  return { enabled: active, level: settings.level, textures: textures.size };
}

export class SurfaceAnisotropyController {
  constructor(demo) {
    this.demo = demo;
    this.control = null;
    this.input = null;
    this.disposed = false;
    this.onChange = () => this.apply(this.input?.checked === true);
  }

  apply(enabled = resolveSurfaceAnisotropy(this.demo?.config).enabled) {
    return applySurfaceAnisotropy(this.demo, enabled);
  }

  mount() {
    if (this.disposed || this.control) return this.control;
    const panel = this.demo?.ui?.element?.querySelector?.('[data-controls-panel]');
    if (!panel) return null;

    const label = document.createElement('label');
    label.className = 'toggle-row';
    label.dataset.surfaceAnisotropy = '';

    const text = document.createElement('span');
    text.textContent = 'Surface Anisotropy';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.surfaceAnisotropyToggle = '';
    input.checked = resolveSurfaceAnisotropy(this.demo.config).enabled;
    input.addEventListener('change', this.onChange);

    label.append(text, input);
    const interactionRow = panel.querySelector('[data-interaction]')?.closest('label');
    panel.insertBefore(label, interactionRow ?? null);

    this.control = label;
    this.input = input;

    const coastalJungleTask = this.demo?.coastalJungle?.initTask;
    if (coastalJungleTask?.then) {
      Promise.resolve(coastalJungleTask).then(() => {
        if (!this.disposed) this.apply();
      }).catch(() => {});
    }

    return label;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.input?.removeEventListener('change', this.onChange);
    this.control?.remove();
    this.control = null;
    this.input = null;
    this.demo = null;
  }
}

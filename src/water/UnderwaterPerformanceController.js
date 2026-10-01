const DEFAULTS = Object.freeze({
  enabled: true,
  hysteresis: 0.75,
  // Terrestrial vegetation is pointless water further than a stride below the
  // surface, so it leaves with the underwater sea LOD instead of six metres down.
  vegetationCullDepth: 1.5,
  // Mist and shadows are cheap next to foliage, but still fade well before the
  // old deep-water depths so an underwater view is not lit and occluded for a
  // scene the player cannot see.
  atmosphereCullDepth: 3,
  shadowCullDepth: 4,
  terrain3dLodDepth: 1.5,
});

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function resolveSettings(config) {
  const source = config.cinematic?.water?.underwaterPerformance;
  return {
    enabled: Boolean(config.cinematic?.enabled) && source !== undefined
      ? (source.enabled ?? DEFAULTS.enabled)
      : false,
    hysteresis: Math.max(0, finite(source.hysteresis, DEFAULTS.hysteresis)),
    vegetationCullDepth: Math.max(0, finite(source.vegetationCullDepth, DEFAULTS.vegetationCullDepth)),
    atmosphereCullDepth: Math.max(0, finite(source.atmosphereCullDepth, DEFAULTS.atmosphereCullDepth)),
    shadowCullDepth: Math.max(0, finite(source.shadowCullDepth, DEFAULTS.shadowCullDepth)),
    terrain3dLodDepth: Math.max(0, finite(source.terrain3dLodDepth, DEFAULTS.terrain3dLodDepth)),
  };
}

function thresholdState(active, depth, threshold, hysteresis) {
  if (!Number.isFinite(depth)) return false;
  return active
    ? depth >= Math.max(0, threshold - hysteresis)
    : depth >= threshold;
}

function setSystemsEnabled(systems, enabled) {
  for (const system of systems) system?.setRenderEnabled?.(enabled);
}

export class UnderwaterPerformanceController {
  constructor({
    camera,
    water,
    cinematicLighting = null,
    vegetation = [],
    atmosphere = [],
    config,
  }) {
    this.camera = camera;
    this.water = water;
    this.cinematicLighting = cinematicLighting;
    this.vegetation = vegetation;
    this.atmosphere = atmosphere;
    this.settings = resolveSettings(config);
    this.depth = Number.NEGATIVE_INFINITY;
    this.vegetationCulled = false;
    this.atmosphereCulled = false;
    this.shadowsCulled = false;
    this.terrainOptions = {
      underwaterDepth: Number.NEGATIVE_INFINITY,
      underwater3dLodDepth: this.settings.terrain3dLodDepth,
    };
    this.stats = {
      depth: Number.NEGATIVE_INFINITY,
      vegetationCulled: false,
      atmosphereCulled: false,
      shadowsCulled: false,
    };
  }

  update() {
    if (!this.settings.enabled || !this.camera || !this.water) {
      this.#applyDepth(Number.NEGATIVE_INFINITY);
      return this.stats;
    }

    const { x, y, z } = this.camera.position;
    const level = this.water.surfaceLevelAt(x, z);
    const depth = level === null ? Number.NEGATIVE_INFINITY : level - y;
    this.#applyDepth(depth);
    return this.stats;
  }

  #applyDepth(depth) {
    this.depth = Number.isFinite(depth) ? depth : Number.NEGATIVE_INFINITY;
    this.terrainOptions.underwaterDepth = this.depth;
    this.water?.setPerformanceDepth?.(this.depth);

    const { hysteresis } = this.settings;
    const vegetationCulled = thresholdState(
      this.vegetationCulled,
      this.depth,
      this.settings.vegetationCullDepth,
      hysteresis,
    );
    if (vegetationCulled !== this.vegetationCulled) {
      this.vegetationCulled = vegetationCulled;
      setSystemsEnabled(this.vegetation, !vegetationCulled);
    }

    const atmosphereCulled = thresholdState(
      this.atmosphereCulled,
      this.depth,
      this.settings.atmosphereCullDepth,
      hysteresis,
    );
    if (atmosphereCulled !== this.atmosphereCulled) {
      this.atmosphereCulled = atmosphereCulled;
      setSystemsEnabled(this.atmosphere, !atmosphereCulled);
    }

    const shadowsCulled = thresholdState(
      this.shadowsCulled,
      this.depth,
      this.settings.shadowCullDepth,
      hysteresis,
    );
    if (shadowsCulled !== this.shadowsCulled) {
      this.shadowsCulled = shadowsCulled;
      this.cinematicLighting?.setShadowRenderEnabled?.(!shadowsCulled);
    }

    Object.assign(this.stats, {
      depth: this.depth,
      vegetationCulled: this.vegetationCulled,
      atmosphereCulled: this.atmosphereCulled,
      shadowsCulled: this.shadowsCulled,
    });
  }

  dispose() {
    setSystemsEnabled(this.vegetation, true);
    setSystemsEnabled(this.atmosphere, true);
    this.cinematicLighting?.setShadowRenderEnabled?.(true);
    this.water?.setPerformanceDepth?.(Number.NEGATIVE_INFINITY);
    this.depth = Number.NEGATIVE_INFINITY;
  }
}

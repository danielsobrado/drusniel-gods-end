import { uniform } from 'three/tsl';

// Cheap procedural surface detail (config surfaceDetail, see
// public/surface-detail.yaml): rock streaks, strata, crevices and ledges,
// height-blended terrain transitions, scree, beach pebbles, bark weathering,
// wet waterlines and worn path fringes. Structural values (scales, bands) are
// constants baked into the shaders; every strength is a live uniform, so an
// effect can be toned or switched off at runtime (and A/B tested) without a
// rebuild. The heavier blocks branch on their strength, so 0 skips them.

const PREFIX = 'surfaceDetail';
const states = new WeakMap();

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function number(source, key, fallback, path, { min = -Infinity, max = Infinity } = {}) {
  const value = source?.[key] ?? fallback;
  const result = Number(value);
  if (!Number.isFinite(result) || result < min || result > max) {
    throw new Error(`${path}.${key} must be a finite number in [${min}, ${max}].`);
  }
  return result;
}

function pair(source, key, fallback, path) {
  const value = source?.[key] ?? fallback;
  if (!Array.isArray(value) || value.length !== 2 || !value.every((item) => Number.isFinite(Number(item)))) {
    throw new Error(`${path}.${key} must be a pair of numbers.`);
  }
  return value.map(Number);
}

function section(config, name) {
  const value = config?.[name];
  return isRecord(value) ? value : {};
}

/** Resolves surfaceDetail from the merged config, filling every default. */
export function resolveSurfaceDetailConfig(config) {
  const source = config?.surfaceDetail;
  const enabled = isRecord(source) && source.enabled !== false;
  const on = (value) => (enabled ? value : 0);
  const rock = section(source, 'rock');
  const streaks = section(rock, 'streaks');
  const strata = section(rock, 'strata');
  const curvature = section(rock, 'curvature');
  const ledges = section(rock, 'ledges');
  const distance = section(rock, 'distance');
  const waterline = section(rock, 'waterline');
  const blend = section(source, 'blend');
  const scree = section(source, 'scree');
  const coastEdge = section(source, 'coastEdge');
  const pebbles = section(source, 'pebbles');
  const bark = section(source, 'bark');
  const props = section(source, 'props');
  const pathFringe = section(source, 'pathFringe');
  const scatter = section(source, 'beachScatter');
  const p = (name) => `${PREFIX}.${name}`;
  const result = {
    enabled,
    rock: {
      streaks: {
        strength: on(number(streaks, 'strength', 0.35, p('rock.streaks'), { min: 0, max: 1 })),
        width: number(streaks, 'width', 1.1, p('rock.streaks'), { min: 0.01 }),
        length: number(streaks, 'length', 24, p('rock.streaks'), { min: 0.01 }),
        ochre: number(streaks, 'ochre', 0.35, p('rock.streaks'), { min: 0, max: 1 }),
      },
      strata: {
        dip: pair(strata, 'dip', [0.14, -0.08], p('rock.strata')),
        warp: number(strata, 'warp', 2.5, p('rock.strata'), { min: 0 }),
        warpScale: number(strata, 'warpScale', 0.006, p('rock.strata'), { min: 0 }),
        strength: on(number(strata, 'strength', 1, p('rock.strata'), { min: 0, max: 1 })),
      },
      curvature: {
        crevice: on(number(curvature, 'crevice', 0.4, p('rock.curvature'), { min: 0, max: 1 })),
        edge: on(number(curvature, 'edge', 0.25, p('rock.curvature'), { min: 0, max: 1 })),
        scale: number(curvature, 'scale', 0.08, p('rock.curvature'), { min: 1e-4 }),
        step: number(curvature, 'step', 6, p('rock.curvature'), { min: 0.1 }),
      },
      ledges: {
        strength: on(number(ledges, 'strength', 0.85, p('rock.ledges'), { min: 0, max: 1 })),
        threshold: number(ledges, 'threshold', 0.6, p('rock.ledges'), { min: 0, max: 1 }),
      },
      distance: {
        strength: on(number(distance, 'strength', 0.18, p('rock.distance'), { min: 0, max: 1 })),
        scale: number(distance, 'scale', 0.0025, p('rock.distance'), { min: 0 }),
        range: pair(distance, 'range', [150, 600], p('rock.distance')),
      },
      waterline: {
        strength: on(number(waterline, 'strength', 0.6, p('rock.waterline'), { min: 0, max: 1 })),
        height: number(waterline, 'height', 1.6, p('rock.waterline'), { min: 0.01 }),
      },
    },
    blend: {
      strength: on(number(blend, 'strength', 1, p('blend'), { min: 0, max: 1 })),
      contrast: number(blend, 'contrast', 1.6, p('blend'), { min: 0 }),
      width: number(blend, 'width', 0.22, p('blend'), { min: 0.01, max: 0.5 }),
      distance: pair(blend, 'distance', [40, 110], p('blend')),
    },
    scree: {
      strength: on(number(scree, 'strength', 0.8, p('scree'), { min: 0, max: 1 })),
      cell: number(scree, 'cell', 0.9, p('scree'), { min: 0.01 }),
      distance: number(scree, 'distance', 70, p('scree'), { min: 1 }),
    },
    coastEdge: {
      warp: on(number(coastEdge, 'warp', 7, p('coastEdge'), { min: 0 })),
      scale: number(coastEdge, 'scale', 0.035, p('coastEdge'), { min: 0 }),
    },
    pebbles: {
      strength: on(number(pebbles, 'strength', 1, p('pebbles'), { min: 0, max: 1 })),
      cell: number(pebbles, 'cell', 0.34, p('pebbles'), { min: 0.01 }),
      density: number(pebbles, 'density', 0.008, p('pebbles'), { min: 0, max: 1 }),
      strand: number(pebbles, 'strand', 0.02, p('pebbles'), { min: 0, max: 1 }),
      strandHeight: pair(pebbles, 'strandHeight', [0.7, 2.8], p('pebbles')),
      distance: number(pebbles, 'distance', 45, p('pebbles'), { min: 1 }),
    },
    bark: {
      moss: on(number(bark, 'moss', 0.7, p('bark'), { min: 0, max: 1 })),
      wet: on(number(bark, 'wet', 0.8, p('bark'), { min: 0, max: 1 })),
      snow: on(number(bark, 'snow', 0.8, p('bark'), { min: 0, max: 1 })),
      tint: on(number(bark, 'tint', 0.12, p('bark'), { min: 0, max: 0.5 })),
      base: on(number(bark, 'base', 0.35, p('bark'), { min: 0, max: 1 })),
      baseHeight: number(bark, 'baseHeight', 1.2, p('bark'), { min: 0.01 }),
    },
    props: {
      waterline: on(number(props, 'waterline', 0.7, p('props'), { min: 0, max: 1 })),
      height: number(props, 'height', 1.2, p('props'), { min: 0.01 }),
      dust: on(number(props, 'dust', 0.35, p('props'), { min: 0, max: 1 })),
    },
    pathFringe: {
      strength: on(number(pathFringe, 'strength', 0.9, p('pathFringe'), { min: 0, max: 1 })),
      band: pair(pathFringe, 'band', [0.02, 0.35], p('pathFringe')),
      color: typeof pathFringe.color === 'string' ? pathFringe.color : '#c2ad62',
    },
    beachScatter: {
      enabled: enabled && scatter.enabled !== false,
      tone: number(scatter, 'tone', 0.35, p('beachScatter'), { min: 0, max: 1 }),
      dust: number(scatter, 'dust', 0.5, p('beachScatter'), { min: 0, max: 1 }),
      wetHeight: number(scatter, 'wetHeight', 1.4, p('beachScatter'), { min: 0 }),
    },
  };
  if (!(result.pebbles.strandHeight[1] > result.pebbles.strandHeight[0])) {
    throw new Error(`${PREFIX}.pebbles.strandHeight must rise.`);
  }
  if (!(result.rock.distance.range[1] > result.rock.distance.range[0])) {
    throw new Error(`${PREFIX}.rock.distance.range must rise.`);
  }
  if (!(result.blend.distance[1] > result.blend.distance[0])) {
    throw new Error(`${PREFIX}.blend.distance must rise.`);
  }
  if (!(result.pathFringe.band[1] > result.pathFringe.band[0])) {
    throw new Error(`${PREFIX}.pathFringe.band must rise.`);
  }
  return result;
}

/**
 * The resolved settings plus a live strength uniform for each effect, shared
 * by every material built from this config. `rain` is the current rain
 * intensity (EnvironmentController sets it) for wet bark.
 */
export function getSurfaceDetail(config) {
  if (states.has(config)) return states.get(config);
  const settings = resolveSurfaceDetailConfig(config);
  const u = (value) => uniform(value);
  const state = {
    settings,
    rain: uniform(0),
    streaks: u(settings.rock.streaks.strength),
    strata: u(settings.rock.strata.strength),
    crevice: u(settings.rock.curvature.crevice),
    edge: u(settings.rock.curvature.edge),
    ledges: u(settings.rock.ledges.strength),
    distance: u(settings.rock.distance.strength),
    waterline: u(settings.rock.waterline.strength),
    blend: u(settings.blend.strength),
    scree: u(settings.scree.strength),
    coastEdge: u(settings.coastEdge.warp),
    pebbles: u(settings.pebbles.strength),
    barkMoss: u(settings.bark.moss),
    barkWet: u(settings.bark.wet),
    barkSnow: u(settings.bark.snow),
    barkTint: u(settings.bark.tint),
    barkBase: u(settings.bark.base),
    propWaterline: u(settings.props.waterline),
    propDust: u(settings.props.dust),
    pathFringe: u(settings.pathFringe.strength),
  };
  states.set(config, state);
  return state;
}

/** Names of the strength uniforms, for debugging and A/B captures. */
export const SURFACE_DETAIL_EFFECTS = Object.freeze([
  'streaks', 'strata', 'crevice', 'edge', 'ledges', 'distance', 'waterline', 'blend', 'scree', 'coastEdge',
  'pebbles', 'barkMoss', 'barkWet', 'barkSnow', 'barkTint', 'barkBase', 'propWaterline', 'propDust', 'pathFringe',
]);

function finiteNumber(value, name, {
  min = Number.NEGATIVE_INFINITY,
  max = Number.POSITIVE_INFINITY,
  exclusiveMin = false,
} = {}) {
  const number = Number(value);
  const belowMin = exclusiveMin ? !(number > min) : number < min;
  if (!Number.isFinite(number) || belowMin || number > max) {
    throw new Error(`${name} must be a finite number in the configured range.`);
  }
  return number;
}

function integer(value, name, options) {
  const number = finiteNumber(value, name, options);
  if (!Number.isInteger(number)) throw new Error(`${name} must be an integer.`);
  return number;
}

function section(config, key, prefix) {
  const value = config[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${prefix}.${key} must be an object.`);
  }
  return value;
}

export function resolveSnowWakeConfig(config) {
  if (!config) throw new Error('ground.snow.wake configuration is required.');
  if (config.enabled === false) return { enabled: false };
  const prefix = 'ground.snow.wake';
  const positive = (source, key, path = prefix) => finiteNumber(source[key], `${path}.${key}`, { min: 0, exclusiveMin: true });
  const unit = (source, key, path = prefix) => finiteNumber(source[key], `${path}.${key}`, { min: 0, max: 1 });

  const minSpeed = finiteNumber(config.minSpeed, `${prefix}.minSpeed`, { min: 0 });
  const fullSpeed = positive(config, 'fullSpeed');
  if (fullSpeed <= minSpeed) throw new Error(`${prefix}.fullSpeed must be greater than ${prefix}.minSpeed.`);

  const spray = section(config, 'spray', prefix);
  const shake = section(config, 'shake', prefix);
  const streaks = section(config, 'streaks', prefix);
  const streakStart = finiteNumber(streaks.startSpeedRatio, `${prefix}.streaks.startSpeedRatio`, { min: 0 });
  const streakFull = positive(streaks, 'fullSpeedRatio', `${prefix}.streaks`);
  if (streakFull <= streakStart) {
    throw new Error(`${prefix}.streaks.fullSpeedRatio must be greater than ${prefix}.streaks.startSpeedRatio.`);
  }
  if (typeof config.color !== 'string' || config.color.length === 0) {
    throw new Error(`${prefix}.color must be a color string.`);
  }

  return {
    enabled: true,
    referenceHeight: positive(config, 'referenceHeight'),
    capacity: integer(config.capacity, `${prefix}.capacity`, { min: 8, max: 512 }),
    spineStep: positive(config, 'spineStep'),
    columns: integer(config.columns, `${prefix}.columns`, { min: 2, max: 512 }),
    rows: integer(config.rows, `${prefix}.rows`, { min: 1, max: 64 }),
    lifeSeconds: positive(config, 'lifeSeconds'),
    bowLead: finiteNumber(config.bowLead, `${prefix}.bowLead`, { min: 0 }),
    maxHeight: positive(config, 'maxHeight'),
    halfWidth: finiteNumber(config.halfWidth, `${prefix}.halfWidth`, { min: 0 }),
    minSpeed,
    fullSpeed,
    minCoverage: unit(config, 'minCoverage'),
    carveAcceleration: positive(config, 'carveAcceleration'),
    transmission: finiteNumber(config.transmission, `${prefix}.transmission`, { min: 0 }),
    roughness: unit(config, 'roughness'),
    color: config.color,
    spray: {
      curtainPerMetre: finiteNumber(spray.curtainPerMetre, `${prefix}.spray.curtainPerMetre`, { min: 0 }),
      driftPerMetre: finiteNumber(spray.driftPerMetre, `${prefix}.spray.driftPerMetre`, { min: 0 }),
      maxPerFrame: integer(spray.maxPerFrame, `${prefix}.spray.maxPerFrame`, { min: 0, max: 1024 }),
    },
    shake: {
      amplitude: finiteNumber(shake.amplitude, `${prefix}.shake.amplitude`, { min: 0 }),
      loadThreshold: unit(shake, 'loadThreshold', `${prefix}.shake`),
      gain: finiteNumber(shake.gain, `${prefix}.shake.gain`, { min: 0 }),
      decay: positive(shake, 'decay', `${prefix}.shake`),
    },
    streaks: {
      strength: finiteNumber(streaks.strength, `${prefix}.streaks.strength`, { min: 0, max: 4 }),
      startSpeedRatio: streakStart,
      fullSpeedRatio: streakFull,
    },
  };
}

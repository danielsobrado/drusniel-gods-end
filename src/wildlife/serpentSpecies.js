import { coastalJungleRegionCenter } from '../world/CoastalJungleRegion.js';
import { resolveSerpentShape } from './serpentShape.js';

// The giant serpents' species. Shapes are in metres; behaviour distances in
// metres and speeds in m/s. A config entry (wildlife.serpents[]) picks one by
// `species` and may override any of these per snake.
export const SERPENT_SPECIES = Object.freeze({
  // Reticulated python: long, gold-netted, a slit-eyed wedge of a head.
  reticulated: {
    label: 'Python',
    shape: { length: 260, radius: 5, heightRatio: 0.84, headLength: 14.5, headWidth: 4.4, headHeight: 2.7, scaleRows: 64 },
    behaviour: {
      speed: 4.1, fleeSpeed: 8.2, wavelength: 65, amplitude: 0.75, turnRate: 0.16,
      alertDistance: 110, retreatDistance: 45, headLift: 24, neckLength: 60,
    },
    skin: { clearcoat: 0.35, iridescence: 0.45 },
    eye: { iris: ['#f2b43a', '#a45a12'], pupil: 'slit' },
  },
  // Green anaconda: shorter, far heavier, olive with black spots; it keeps its
  // head low and does not rear much.
  anaconda: {
    label: 'Anaconda',
    shape: { length: 210, radius: 6.5, heightRatio: 0.9, headLength: 15, headWidth: 5.2, headHeight: 2.9, scaleRows: 60 },
    behaviour: {
      speed: 3.2, fleeSpeed: 6.4, wavelength: 55, amplitude: 0.7, turnRate: 0.14,
      alertDistance: 100, retreatDistance: 40, headLift: 13, neckLength: 45,
    },
    skin: { clearcoat: 0.45, iridescence: 0.2 },
    eye: { iris: ['#b8a246', '#5a4a1c'], pupil: 'slit' },
  },
  // King cobra: long and lean, dark with pale chevrons. Alarmed, it rears a
  // third of its length off the ground and spreads its hood.
  cobra: {
    label: 'King cobra',
    shape: { length: 250, radius: 3.6, heightRatio: 0.92, headLength: 11.5, headWidth: 3.3, headHeight: 2.1, scaleRows: 44 },
    behaviour: {
      speed: 5.5, fleeSpeed: 11, wavelength: 70, amplitude: 0.8, turnRate: 0.2,
      alertDistance: 130, retreatDistance: 50, headLift: 48, neckLength: 75,
    },
    // Hood: up to `spread` times as wide (and flatter) from just behind the
    // head over `length` of the body.
    hood: { spread: 2.8, length: 0.13 },
    skin: { clearcoat: 0.4, iridescence: 0.3 },
    eye: { iris: ['#3a2410', '#1a0f06'], pupil: 'round' },
  },
});

const COMMON = Object.freeze({
  habitat: 'jungle',
  home: null,
  roamRadius: 200,
  avoid: [],
  maxDistance: 1500,
  maxSlope: 0.5,
  seed: 5113,
});

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function pair(value) {
  return Array.isArray(value) && value.length === 2 && value.every(v => Number.isFinite(Number(v)))
    ? value.map(Number) : null;
}

/**
 * One snake's settings: its species' defaults under the entry's overrides.
 * A jungle snake lives only while the coastal jungle does and, without a
 * home, roams from the middle of the strip. A meadow snake needs a home.
 */
export function resolveSerpentSettings(entry = {}, config = {}) {
  const speciesId = SERPENT_SPECIES[entry.species] ? entry.species : 'reticulated';
  const species = SERPENT_SPECIES[speciesId];
  const habitat = entry.habitat === 'meadow' ? 'meadow' : 'jungle';
  const jungle = config?.biomes?.coastalJungle;
  const settings = { species: speciesId, label: entry.label ?? species.label, habitat };
  settings.enabled = entry.enabled !== false && (habitat !== 'jungle' || jungle?.enabled === true);
  for (const [key, fallback] of Object.entries({ ...COMMON, ...species.behaviour })) {
    if (typeof fallback === 'number') settings[key] = numberOr(entry[key], fallback);
  }
  const center = habitat === 'jungle' ? coastalJungleRegionCenter(jungle?.region, config?.water?.sea) : null;
  settings.home = pair(entry.home) ?? (center ? [center.x, center.z] : null);
  if (!settings.home) settings.enabled = false;
  settings.avoid = (Array.isArray(entry.avoid) ? entry.avoid : [])
    .map(zone => ({ center: pair(zone?.center), radius: numberOr(zone?.radius, 0) }))
    .filter(zone => zone.center && zone.radius > 0);
  settings.shape = resolveSerpentShape({ ...species.shape, ...(entry.shape ?? {}) });
  settings.hood = species.hood ?? null;
  settings.skin = species.skin;
  settings.eye = species.eye;
  return settings;
}

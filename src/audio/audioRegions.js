import { resolveAmbientRegions, sampleAmbientRegions } from '../weather/ambientRegions.js';
import { coastDistanceAt } from '../world/CoastField.js';
import { coastalJungleProfileWeight } from '../world/CoastalJungleRegion.js';
import { sampleSurfaceCpu } from '../world/SnowDeformationField.js';

// Coverage above which a footstep sounds like snow or sand.
const COVERAGE_STEP = 0.5;
// Painted path strength above which a step lands on the path.
const PATH_STEP = 0.45;
// Slope step for the surface sample, in metres.
const SURFACE_STEP = 1;

/**
 * Where the listener is, for the audio. Region weights are the ones the
 * ambient particle layer uses (so the surf is heard where the breakers show
 * and the jungle bed where the canopy is), and the ground under a footstep
 * comes from the same CPU snow/sand coverage the ground shader follows.
 */
export class AudioRegions {
  constructor({ config, terrainSampler = null, river = null, snowWeight = () => 0 }) {
    this.config = config;
    this.terrainSampler = terrainSampler;
    this.river = river;
    this.snowWeight = snowWeight;
    this.regions = resolveAmbientRegions(config);
    this.sampleHeight = terrainSampler ? (x, z) => terrainSampler.sampleHeight(x, z) : null;
    const altitude = config.ground?.snow?.enabled ? config.ground.snow.altitude : null;
    this.rockHeight = altitude ? Number(altitude.start) : Infinity;
  }

  get seaLevel() {
    return this.regions.sea?.level ?? 0;
  }

  /** Region weights at x/z: { snow, sand, surf, jungle, water, lake, meadow }. */
  sample(x, z) {
    return sampleAmbientRegions(this.regions, x, z, {
      snowWeight: this.snowWeight(),
      river: this.river,
      sampleHeight: this.sampleHeight,
    });
  }

  /** World x of the waterline at z, or null without a sea. */
  coastX(z) {
    return this.regions.sea ? -coastDistanceAt(0, z, this.regions.sea) : null;
  }

  /** Footstep surface at x/z. `wet` turns bare paths to mud. */
  surfaceAt(x, z, { wet = false } = {}) {
    const surface = this.terrainSampler ? sampleSurfaceCpu(this.terrainSampler, x, z, SURFACE_STEP, this.config) : null;
    if (surface?.snow > COVERAGE_STEP) return 'snow';
    if (surface?.sand > COVERAGE_STEP) return 'sand';
    if ((this.terrainSampler?.paths?.sample(x, z) ?? 0) > PATH_STEP) return wet ? 'mud' : 'gravel';
    // Bare rock above the snow line, where the snow has been scoured away.
    if (surface && surface.y > this.rockHeight) return 'gravel';
    if (coastalJungleProfileWeight(x, z, this.config) > COVERAGE_STEP) return 'leaves';
    return 'grass';
  }
}

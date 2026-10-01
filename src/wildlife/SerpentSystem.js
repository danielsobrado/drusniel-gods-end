import * as THREE from 'three/webgpu';
import { logger } from '../utils/logger.js';
import { GiantSerpent } from './GiantSerpent.js';
import { resolveSerpentSettings } from './serpentSpecies.js';
import { serpentScaleCoordinates, serpentStations } from './serpentShape.js';
import { createScaleTileData, createSerpentPatternData, serpentPatternSize } from './serpentSkin.js';
import { createSkinTexture } from './serpentMaterial.js';

const TILE_SIZE = 512;

/**
 * The giant serpents listed in wildlife.serpents. They share one scale tile;
 * each has its own coat. Both are drawn by one worker after load (a few
 * seconds of CPU); until then the textures hold a neutral olive.
 */
export class SerpentSystem {
  constructor({ scene, terrain, config, jungle = null, lake = null, expansion = null }) {
    const entries = Array.isArray(config?.wildlife?.serpents) ? config.wildlife.serpents : [];
    const settings = entries
      .map((entry, index) => resolveSerpentSettings({ seed: 5113 + index * 977, ...entry }, config))
      .filter(entry => entry.enabled);
    this.serpents = [];
    this.skinReady = settings.length === 0;
    if (!settings.length || !terrain) return;
    this.tileTexture = createSkinTexture({
      width: TILE_SIZE, height: TILE_SIZE, fill: [128, 128, 255, 128], colorSpace: THREE.NoColorSpace,
      name: 'Serpent scales',
    });
    const jobs = [];
    for (const entry of settings) {
      const stations = serpentStations(entry.shape);
      const scaleCoordinates = serpentScaleCoordinates(stations, entry.shape);
      const patternTexture = createSkinTexture({
        ...serpentPatternSize(entry.shape, scaleCoordinates.at(-1)), fill: [96, 96, 64, 0],
        colorSpace: THREE.SRGBColorSpace, name: `Serpent coat (${entry.label})`,
      });
      this.serpents.push(new GiantSerpent({
        scene, terrain, config, settings: entry, tileTexture: this.tileTexture, patternTexture,
        jungle, lake, expansion,
      }));
      jobs.push({ species: entry.species, shape: entry.shape, seed: entry.seed, texture: patternTexture });
    }
    this.#paint(jobs);
  }

  #paint(jobs) {
    const request = {
      tile: { size: TILE_SIZE },
      coats: jobs.map(({ species, shape, seed }) => ({ species, shape, seed })),
    };
    const apply = ({ tile, coats }) => {
      if (this.disposed) return;
      this.tileTexture.image.data.set(tile.data);
      this.tileTexture.needsUpdate = true;
      coats.forEach((coat, index) => {
        jobs[index].texture.image.data.set(coat.data);
        jobs[index].texture.needsUpdate = true;
      });
      this.skinReady = true;
    };
    const inline = () => setTimeout(() => {
      if (this.disposed) return;
      apply({
        tile: createScaleTileData(request.tile),
        coats: request.coats.map(({ species, shape, seed }) => {
          const stations = serpentStations(shape);
          return createSerpentPatternData({
            shape, stations, scaleCoordinates: serpentScaleCoordinates(stations, shape), species, seed,
          });
        }),
      });
    }, 0);
    try {
      this.worker = new Worker(new URL('./serpentSkin.worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = ({ data }) => {
        apply(data);
        this.worker?.terminate();
        this.worker = null;
      };
      this.worker.onerror = (error) => {
        logger.warn('Serpent skin worker failed; building the skins on the main thread.', error);
        this.worker?.terminate();
        this.worker = null;
        inline();
      };
      this.worker.postMessage(request);
    } catch {
      inline();
    }
  }

  update(deltaSeconds, camera, playerPosition = null) {
    for (const serpent of this.serpents) serpent.update(deltaSeconds, camera, playerPosition);
  }

  /** One minimap marker per snake, traced along its body. */
  minimapMarkers() {
    const markers = [];
    for (const serpent of this.serpents) {
      const path = serpent.minimapPath();
      if (!path) continue;
      const [x, z] = path[0];
      markers.push({ kind: 'serpent', label: serpent.settings.label, x, z, path });
    }
    return markers;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.worker?.terminate();
    this.worker = null;
    for (const serpent of this.serpents) {
      serpent.dispose();
      serpent.patternTexture?.dispose();
    }
    this.tileTexture?.dispose();
    this.serpents.length = 0;
  }
}

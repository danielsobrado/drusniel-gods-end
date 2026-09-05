import { createGrassGeometry } from './GrassGeometry.js';

export class GrassGeometryFactory {
  constructor(config) {
    this.config = config;
  }

  create({ type, detail, density }) {
    return createGrassGeometry({
      type,
      detail,
      density,
      tileSize: this.config.grass.tileSize,
      bladeHeight: this.config.grass[type].bladeHeight,
      stable: Boolean(this.config.cinematic?.enabled),
    });
  }
}

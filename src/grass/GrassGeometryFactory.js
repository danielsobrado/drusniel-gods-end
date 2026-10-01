import { createGrassGeometry } from './GrassGeometry.js';

export class GrassGeometryFactory {
  constructor(config) {
    this.config = config;
  }

  create({ type, shape, detail, density, shareVertices = true }) {
    return createGrassGeometry({
      type,
      shape,
      detail,
      density,
      tileSize: this.config.grass.tileSize,
      bladeHeight: this.config.grass[type].bladeHeight,
      stable: Boolean(this.config.cinematic?.enabled),
      shareVertices,
    });
  }
}

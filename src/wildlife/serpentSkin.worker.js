import { resolveSerpentShape, serpentScaleCoordinates, serpentStations } from './serpentShape.js';
import { createScaleTileData, createSerpentPatternData } from './serpentSkin.js';

// Builds the serpents' skins off the main thread: about a second of CPU per
// coat on a desktop, which would otherwise land in the middle of loading.
self.onmessage = ({ data }) => {
  const tile = createScaleTileData(data.tile);
  const coats = data.coats.map(({ species, shape: options, seed }) => {
    const shape = resolveSerpentShape(options);
    const stations = serpentStations(shape);
    const scaleCoordinates = serpentScaleCoordinates(stations, shape);
    return createSerpentPatternData({ shape, stations, scaleCoordinates, species, seed });
  });
  self.postMessage({ tile, coats }, [tile.data.buffer, ...coats.map(coat => coat.data.buffer)]);
};

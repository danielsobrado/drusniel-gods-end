import { generateSurfaceData } from './houseTextureData.js';

// Generates house surfaces off the main thread: { name } in, the RGBA albedo
// and normal texels out (transferred, not copied).
self.onmessage = ({ data: { name } }) => {
  const { size, color, normal } = generateSurfaceData(name);
  self.postMessage({ name, size, color, normal }, [color.buffer, normal.buffer]);
};

import { createSeaNodes } from '../../src/water/seaNodes.js';
import { positionWorld, cameraPosition, normalize } from 'three/tsl';

let originalColor;
export function inspectSea(demo, mode) {
  const w = demo.water;
  originalColor ??= w.material.colorNode;
  const nodes = createSeaNodes(w.params.sea, w.uniforms.clock, w.uniforms.rain);
  w.material.colorNode = mode === 'normal' ? nodes.normal(positionWorld.xz).mul(0.5).add(0.5)
    : mode === 'height' ? positionWorld.y.sub(w.params.sea.level).mul(0.3).add(0.5)
      : mode === 'view' ? normalize(cameraPosition.sub(positionWorld)).mul(0.5).add(0.5) : originalColor;
  w.material.needsUpdate = true;
}

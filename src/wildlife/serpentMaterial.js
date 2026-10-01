import * as THREE from 'three/webgpu';
import {
  abs, atan, attribute, cameraPosition, color, float, fract, mix, normalMap, positionLocal, positionWorld, sin,
  smoothstep, sqrt, texture, uv, vec2, vec3,
} from 'three/tsl';
import { coastalJungleHazePresence } from '../biome/CoastalJungleMaterial.js';

// Scales per tile edge, both ways (see createScaleTileData).
const TILE_SCALES = 16;

/** Final-sized texture filled with a neutral value until the worker's data lands. */
export function createSkinTexture({ width, height, fill, colorSpace, name }) {
  const data = new Uint8Array(width * height * 4);
  for (let index = 0; index < data.length; index += 4) data.set(fill, index);
  const result = new THREE.DataTexture(data, width, height);
  result.name = name;
  result.colorSpace = colorSpace;
  result.wrapS = result.wrapT = THREE.RepeatWrapping;
  result.minFilter = THREE.LinearMipmapLinearFilter;
  result.magFilter = THREE.LinearFilter;
  result.generateMipmaps = true;
  result.anisotropy = 8;
  result.needsUpdate = true;
  return result;
}

/**
 * Serpent skin. The tile gives every scale its bevel, crevice and a slight
 * tone of its own; the belly swaps it for broad ventral plates. The coat comes
 * from the body pattern. A light clearcoat and a thin-film sheen give the
 * oily, faintly rainbow gloss of python scales in sunlight.
 */
export function createSerpentSkinMaterial({
  tileTexture, patternTexture, shape, totalRows, haze = null, clearcoat = 0.35, iridescence = 0.45,
}) {
  const material = new THREE.MeshPhysicalNodeMaterial({ name: 'Jungle serpent skin' });
  const bodyUv = uv();
  const s = attribute('bodyS', 'float');
  const rows = float(totalRows);
  const scaleUv = vec2(bodyUv.x.mul(shape.scaleRows / TILE_SCALES), bodyUv.y.mul(rows).div(TILE_SCALES));
  // Broader plates over the crown of the head.
  const headMask = smoothstep(shape.headLength * 0.85, shape.headLength * 1.15, s).oneMinus();
  const bodyTile = texture(tileTexture, scaleUv);
  const headTile = texture(tileTexture, scaleUv.mul(0.5).add(0.37));
  const tile = mix(bodyTile, headTile, headMask);
  const coat = texture(patternTexture, bodyUv);
  const belly = coat.a;

  // Ventral plates: one per two scale rows, rising to an overlapping rear edge.
  const plate = fract(bodyUv.y.mul(rows).mul(0.5));
  const plateGroove = smoothstep(0, 0.09, plate);
  const plateNormal = vec2(0, plate.mul(0.35).sub(0.1).mul(plateGroove).negate());
  const scaleNormal = tile.xy.mul(2).sub(1);
  const normalXY = mix(scaleNormal, plateNormal, belly);
  const normalZ = sqrt(normalXY.dot(normalXY).oneMinus().max(0.0001));
  const occlusion = mix(tile.z, plateGroove.mul(0.55).add(0.45), belly);
  const perScale = tile.w;
  const tangentNormal = normalMap(vec3(normalXY, normalZ).mul(0.5).add(0.5), vec2(1.15));
  material.normalNode = tangentNormal;
  material.clearcoatNormalNode = tangentNormal;

  let albedo = coat.rgb.mul(perScale.mul(0.28).add(0.86)).mul(occlusion.mul(0.6).add(0.4));
  if (haze?.enabled !== false && haze) {
    const amount = smoothstep(haze.start ?? 18, haze.end ?? 85, positionWorld.sub(cameraPosition).length())
      .mul(haze.strength ?? 0.28).mul(coastalJungleHazePresence);
    albedo = mix(albedo, color(haze.color ?? '#91b1b7'), amount);
  }
  material.colorNode = albedo;
  material.roughnessNode = float(0.36).add(perScale.mul(0.12)).add(occlusion.oneMinus().mul(0.4))
    .add(belly.mul(0.12)).min(1);
  material.metalnessNode = float(0);
  // Crevices between scales catch no highlight; the scale faces do.
  material.specularIntensityNode = occlusion.mul(occlusion).mul(0.75);
  material.clearcoatNode = occlusion.mul(clearcoat);
  material.clearcoatRoughnessNode = float(0.3);
  // Thin film on the dorsal scales only.
  material.iridescenceNode = belly.oneMinus().mul(occlusion).mul(iridescence);
  material.iridescenceIORNode = float(1.55);
  material.iridescenceThicknessNode = perScale.mul(220).add(280);
  return material;
}

/**
 * Snake eye in its own sphere space (+z out of the head): a streaked iris
 * around a vertical slit (pythons, boas) or a round pupil (cobras), under a
 * clear glossy spectacle.
 */
export function createSerpentEyeMaterial({ iris: [irisInner, irisOuter] = ['#f2b43a', '#a45a12'], pupil = 'slit' } = {}) {
  const material = new THREE.MeshPhysicalNodeMaterial({ name: 'Jungle serpent eye' });
  const p = positionLocal.normalize();
  const radial = vec2(p.x, p.y).length();
  const angle = atan(p.y, p.x);
  const streaks = sin(angle.mul(38)).mul(0.5).add(0.5).mul(sin(angle.mul(11).add(radial.mul(9))).mul(0.5).add(0.5));
  const iris = mix(color(irisInner), color(irisOuter), smoothstep(0.2, 0.75, radial))
    .mul(streaks.mul(0.25).add(0.8));
  const rim = smoothstep(0.62, 0.86, radial);
  // Vertical slit widest at the middle, or a round pupil.
  const slitHalfWidth = p.y.mul(p.y).oneMinus().max(0).mul(0.13);
  const pupilMask = pupil === 'round'
    ? smoothstep(0.3, 0.34, radial).oneMinus()
    : smoothstep(slitHalfWidth, slitHalfWidth.add(0.035), abs(p.x)).oneMinus();
  const pupilShape = pupilMask.mul(smoothstep(0.1, 0.3, p.z));
  const front = smoothstep(-0.1, 0.35, p.z);
  const eye = mix(color('#140d06'), mix(iris, color('#2a1606'), rim), front);
  material.colorNode = mix(eye, color('#020201'), pupilShape);
  material.roughnessNode = float(0.25);
  material.clearcoatNode = float(1);
  material.clearcoatRoughnessNode = float(0.02);
  material.specularIntensityNode = float(1);
  return material;
}

export function createSerpentTongueMaterial() {
  const material = new THREE.MeshPhysicalNodeMaterial({ name: 'Jungle serpent tongue', side: THREE.DoubleSide });
  // Dark at the root, near black at the forked tips.
  material.colorNode = mix(color('#5a1a24'), color('#120708'), smoothstep(0.2, 0.9, positionLocal.z));
  material.roughnessNode = float(0.3);
  material.clearcoatNode = float(0.6);
  material.clearcoatRoughnessNode = float(0.15);
  return material;
}

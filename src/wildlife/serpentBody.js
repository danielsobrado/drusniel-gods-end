import * as THREE from 'three/webgpu';
import {
  SERPENT_EYE_THETA, SERPENT_MOUTH_THETA, sectionOutline, serpentScaleCoordinates, serpentSection, serpentStations,
  smoothstep,
} from './serpentShape.js';

// The serpent is one tube, deformed on the CPU along a spine every frame, so
// the main, shadow and every other pass draw the same surface. Its rest pose
// lies along -z: ring i sits at z = -s_i, x toward the right side, y up. Each
// frame supplies a position and an orthonormal frame per ring
// (side, up, forward toward the head) and the rest offsets are re-expressed in it.

const gauss = (x) => Math.exp(-x * x);

// Radial sculpting of the head on top of the smooth section: brow ridges over
// the eyes, eye sockets, nostrils, the lip groove curving up at the jaw hinge
// and the jaw muscles behind it.
function headRelief(s, theta, shape) {
  const t = s / shape.headLength;
  if (t > 1.3) return 1;
  const side = Math.abs(theta);
  let relief = 1;
  relief += 0.07 * gauss((t - 0.34) / 0.13) * gauss((side - SERPENT_EYE_THETA * 0.72) / 0.22);
  relief -= 0.05 * gauss((t - 0.34) / 0.07) * gauss((side - SERPENT_EYE_THETA) / 0.12);
  relief -= 0.06 * gauss((t - 0.07) / 0.03) * gauss((side - 0.55) / 0.12);
  const mouth = SERPENT_MOUTH_THETA - 0.14 * smoothstep(0.55, 1, t);
  relief -= 0.045 * gauss((side - mouth) / 0.045) * (1 - smoothstep(0.92, 1.02, t));
  relief += 0.06 * gauss((t - 0.9) / 0.16) * gauss((side - 2.25) / 0.45);
  return relief;
}

/** Local transform of an eye in the rest pose: centre, and outward axis. */
export function serpentEyeRest(shape, side = 1) {
  const s = shape.headLength * 0.34;
  const section = serpentSection(s, shape);
  const theta = SERPENT_EYE_THETA * side;
  const outline = sectionOutline(theta);
  const relief = headRelief(s, theta, shape);
  const radius = shape.headWidth * 0.17;
  const surface = new THREE.Vector3(outline.x * section.w * relief, outline.y * section.h * relief, -s);
  // Out of the head, turned a little forward, half sunk into its socket.
  const axis = new THREE.Vector3(Math.sin(theta) * 1.0, Math.cos(theta) * 0.55, 0.35).normalize();
  const centre = surface.clone().addScaledVector(axis, -radius * 0.42);
  return { centre, axis, radius };
}

export function createSerpentGeometry(shape, { radialSegments = 32, stationSpacing } = {}) {
  const stations = serpentStations(shape, stationSpacing);
  const scaleCoordinates = serpentScaleCoordinates(stations, shape);
  const totalRows = scaleCoordinates[scaleCoordinates.length - 1];
  const rings = stations.length;
  const ringSize = radialSegments + 1;
  const count = rings * ringSize;
  const rest = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const bodyS = new Float32Array(count);
  const section = { w: 0, h: 0 };
  const outline = { x: 0, y: 0 };
  for (let i = 0; i < rings; i += 1) {
    const s = stations[i];
    serpentSection(s, shape, section);
    for (let k = 0; k <= radialSegments; k += 1) {
      // The seam runs along the belly, where nobody looks.
      const theta = Math.PI + (k / radialSegments) * Math.PI * 2;
      const signed = Math.atan2(Math.sin(theta), Math.cos(theta));
      sectionOutline(theta, outline);
      const relief = headRelief(s, signed, shape);
      const v = i * ringSize + k;
      rest[v * 3] = outline.x * section.w * relief;
      rest[v * 3 + 1] = outline.y * section.h * relief;
      rest[v * 3 + 2] = -s;
      uvs[v * 2] = 0.5 + k / radialSegments;
      uvs[v * 2 + 1] = scaleCoordinates[i] / totalRows;
      bodyS[v] = s;
    }
  }

  // Rest normals and tangents from the surface itself (across the seam too),
  // stored in ring-local axes so a frame change is a rotation.
  const normals = new Float32Array(count * 3);
  const tangents = new Float32Array(count * 4);
  const around = new THREE.Vector3(), along = new THREE.Vector3(), normal = new THREE.Vector3();
  const at = (i, k, target) => target.fromArray(rest, (i * ringSize + k) * 3);
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  for (let i = 0; i < rings; i += 1) {
    for (let k = 0; k <= radialSegments; k += 1) {
      const v = i * ringSize + k;
      const prevK = k === 0 ? radialSegments - 1 : k - 1;
      const nextK = k === radialSegments ? 1 : k + 1;
      around.subVectors(at(i, nextK, a), at(i, prevK, b));
      along.subVectors(at(Math.min(rings - 1, i + 1), k, a), at(Math.max(0, i - 1), k, b));
      normal.crossVectors(around, along);
      const radial = at(i, k, a).setZ(0);
      if (normal.lengthSq() < 1e-12 || i === 0 || i === rings - 1) {
        normal.set(0, 0, i === 0 ? 1 : -1);
      } else if (normal.dot(radial) < 0) normal.negate();
      normal.normalize();
      normal.toArray(normals, v * 3);
      if (around.lengthSq() < 1e-12) around.set(1, 0, 0);
      around.normalize();
      tangents[v * 4] = around.x;
      tangents[v * 4 + 1] = around.y;
      tangents[v * 4 + 2] = around.z;
      // Bitangent = cross(normal, tangent) * w must run toward the tail (+v).
      tangents[v * 4 + 3] = a.crossVectors(normal, around).dot(along) >= 0 ? 1 : -1;
    }
  }

  const indices = [];
  for (let i = 0; i < rings - 1; i += 1) {
    for (let k = 0; k < radialSegments; k += 1) {
      const p = i * ringSize + k, q = p + 1, r = p + ringSize, t = r + 1;
      indices.push(p, q, r, q, t, r);
    }
  }
  const geometry = new THREE.BufferGeometry();
  const dynamic = (array, itemSize) => new THREE.BufferAttribute(array, itemSize).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', dynamic(rest.slice(), 3));
  geometry.setAttribute('normal', dynamic(normals.slice(), 3));
  geometry.setAttribute('tangent', dynamic(tangents.slice(), 4));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute('bodyS', new THREE.BufferAttribute(bodyS, 1));
  geometry.setIndex(indices);
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), shape.length);
  return { geometry, stations, scaleCoordinates, totalRows, rings, ringSize, rest, normals, tangents };
}

/**
 * Writes the deformed surface. `frames` holds 12 floats per ring: position,
 * side, up and forward (toward the head). `girth` scales each ring's section
 * (breathing), 1 when omitted. `flare` widens a ring sideways and flattens it
 * (a cobra's hood), 1 when omitted.
 */
export function deformSerpentGeometry(body, frames, girth = null, flare = null) {
  const { geometry, rings, ringSize, rest, normals, tangents } = body;
  const position = geometry.attributes.position.array;
  const normal = geometry.attributes.normal.array;
  const tangent = geometry.attributes.tangent.array;
  for (let i = 0; i < rings; i += 1) {
    const f = i * 12;
    const px = frames[f], py = frames[f + 1], pz = frames[f + 2];
    const sx = frames[f + 3], sy = frames[f + 4], sz = frames[f + 5];
    const ux = frames[f + 6], uy = frames[f + 7], uz = frames[f + 8];
    const fx = frames[f + 9], fy = frames[f + 10], fz = frames[f + 11];
    const scale = girth ? girth[i] : 1;
    const wide = flare ? flare[i] : 1;
    const scaleX = scale * wide, scaleY = scale / Math.sqrt(wide);
    for (let k = 0; k < ringSize; k += 1) {
      const v = i * ringSize + k;
      const o = v * 3;
      const ox = rest[o] * scaleX, oy = rest[o + 1] * scaleY;
      position[o] = px + sx * ox + ux * oy;
      position[o + 1] = py + sy * ox + uy * oy;
      position[o + 2] = pz + sz * ox + uz * oy;
      // Rest forward is +z, so a rest z component maps onto the forward axis.
      const nx = normals[o], ny = normals[o + 1], nz = normals[o + 2];
      normal[o] = sx * nx + ux * ny + fx * nz;
      normal[o + 1] = sy * nx + uy * ny + fy * nz;
      normal[o + 2] = sz * nx + uz * ny + fz * nz;
      const t = v * 4;
      const tx = tangents[t], ty = tangents[t + 1], tz = tangents[t + 2];
      tangent[t] = sx * tx + ux * ty + fx * tz;
      tangent[t + 1] = sy * tx + uy * ty + fy * tz;
      tangent[t + 2] = sz * tx + uz * ty + fz * tz;
    }
  }
  geometry.attributes.position.needsUpdate = true;
  geometry.attributes.normal.needsUpdate = true;
  geometry.attributes.tangent.needsUpdate = true;
}

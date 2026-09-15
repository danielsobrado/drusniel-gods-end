import * as THREE from 'three/webgpu';
import {
  Fn, Loop, attribute, cameraPosition, clamp, color, cross, dot, float, int, ivec2, max, min, mix, normalize,
  positionWorld, select, sin, smoothstep, textureLoad, time, transformNormalToView, varying, vec2, vec3,
} from 'three/tsl';
import { foliageLight } from '../rendering/CinematicLighting.js';
import {
  WAKE_BASE_ANGLE, WAKE_BASE_DROP, WAKE_CURL_TIP_ANGLE, WAKE_HEAP_TIP_ANGLE, WAKE_LATERAL, WAKE_LUMP,
  WAKE_SECTION_STEPS, WAKE_SHEAR, WAKE_SINK, WAKE_SPREAD, WAKE_SWEEP_POWER,
} from './snowWakeProfile.js';

// Every vertex of the wake is placed here from a static (column, row, side)
// lattice and the spine texture, so the buffer never changes with wake length.
export function createSnowWakeMaterial({ spineTexture, uniforms, columns, rows, settings, snow }) {
  const fetch = (index, row) => textureLoad(
    spineTexture,
    ivec2(int(clamp(index, 0, uniforms.entries.sub(1))), int(row)),
  );

  const spineIndex = (distance) => select(
    distance.lessThan(uniforms.bowGap),
    distance.div(max(uniforms.bowGap, 1e-4)),
    distance.sub(uniforms.bowGap).div(uniforms.step).add(1),
  );

  // Catmull-Rom through the resampled path; linear interpolation bands visibly
  // at every sample on a curving wall.
  const spinePosition = (index) => {
    const lower = index.floor();
    const t = index.sub(lower);
    const p0 = fetch(lower.sub(1), 0).xyz;
    const p1 = fetch(lower, 0).xyz;
    const p2 = fetch(lower.add(1), 0).xyz;
    const p3 = fetch(lower.add(2), 0).xyz;
    const t2 = t.mul(t);
    const t3 = t2.mul(t);
    return p1.mul(2)
      .add(p2.sub(p0).mul(t))
      .add(p0.mul(2).sub(p1.mul(5)).add(p2.mul(4)).sub(p3).mul(t2))
      .add(p0.negate().add(p1.mul(3)).sub(p2.mul(3)).add(p3).mul(t3))
      .mul(0.5);
  };

  const spineRow = (index, row) => {
    const lower = index.floor();
    const t = index.sub(lower);
    return mix(fetch(lower, row), fetch(lower.add(1), row), t.mul(t).mul(float(3).sub(t.mul(2))));
  };

  const tangentAngle = (s, curl) => {
    const tip = float(WAKE_HEAP_TIP_ANGLE).add(curl.mul(WAKE_CURL_TIP_ANGLE - WAKE_HEAP_TIP_ANGLE));
    return float(WAKE_BASE_ANGLE).add(tip.sub(WAKE_BASE_ANGLE).mul(s.pow(WAKE_SWEEP_POWER)));
  };

  // Mirrors wakeSection() in snowWakeProfile.js step for step.
  const wakeSection = Fn(([q, curl]) => {
    const covered = q.mul(WAKE_SECTION_STEPS);
    const x = float(0).toVar();
    const y = float(0).toVar();
    const fullY = float(0).toVar();
    const peak = float(1e-4).toVar();
    Loop(WAKE_SECTION_STEPS, ({ i }) => {
      const step = float(i);
      const angle = tangentAngle(step.add(0.5).div(WAKE_SECTION_STEPS), curl);
      const weight = clamp(covered.sub(step), 0, 1);
      const dy = angle.sin().div(WAKE_SECTION_STEPS);
      x.addAssign(angle.cos().div(WAKE_SECTION_STEPS).mul(weight));
      y.addAssign(dy.mul(weight));
      fullY.addAssign(dy);
      peak.assign(max(peak, fullY));
    });
    return vec2(x, y).div(peak);
  });

  const scale = uniforms.scale;
  const wakePoint = (column, q, side) => {
    const distance = column.mul(uniforms.length);
    const index = spineIndex(distance);
    const center = spinePosition(index);
    const orientation = spineRow(index, 1);
    const shape = spineRow(index, 2);
    const right = normalize(vec3(orientation.x, 0, orientation.y).add(vec3(1e-5, 0, 0)));
    const back = vec3(right.z.negate(), 0, right.x);
    const rightSide = side.greaterThan(0);
    const amplitude = select(rightSide, orientation.w, orientation.z);
    const curl = select(rightSide, shape.y, shape.x);
    const age = shape.z;
    const section = wakeSection(q, curl);
    const along = distance.div(scale);
    const lump = sin(along.mul(1.7).add(side.mul(3.1))).mul(sin(along.mul(0.63).add(1.3)))
      .mul(amplitude).mul(q).mul(WAKE_LUMP);
    const lateral = scale.mul(age.mul(WAKE_SPREAD).add(settings.halfWidth))
      .add(section.x.mul(amplitude).mul(WAKE_LATERAL))
      .add(lump);
    const height = section.y.mul(amplitude).sub(scale.mul(age.mul(age).mul(WAKE_SINK).add(WAKE_BASE_DROP)));
    const position = center
      .add(right.mul(side.mul(lateral)))
      .add(vec3(0, height, 0))
      .add(back.mul(section.y.mul(amplitude).mul(WAKE_SHEAR)));
    return { position, amplitude, curl, age, along, right };
  };

  const lattice = attribute('wake', 'vec3');
  const column = lattice.x;
  const q = lattice.y;
  const side = lattice.z;
  const point = wakePoint(column, q, side);

  // Normals are differenced out of the same wakePoint, so they cannot disagree
  // with the surface they shade.
  const rowStep = 0.5 / rows;
  const columnStep = 0.5 / Math.max(columns - 1, 1);
  const above = wakePoint(column, min(q.add(rowStep), 1), side).position;
  const below = wakePoint(column, max(q.sub(rowStep), 0), side).position;
  const ahead = wakePoint(column.add(columnStep), q, side).position;
  const differenced = normalize(cross(ahead.sub(point.position), above.sub(below)).add(vec3(0, 1e-6, 0)));
  const angle = tangentAngle(q, point.curl);
  const concave = point.right.mul(side.mul(angle.sin().negate())).add(vec3(0, angle.cos(), 0));
  const concaveNormal = differenced.mul(select(dot(differenced, concave).greaterThanEqual(0), float(1), float(-1)));

  const vNormal = varying(concaveNormal, 'vWakeNormal');
  const vQ = varying(q, 'vWakeQ');
  const vAge = varying(point.age, 'vWakeAge');
  const vCurl = varying(point.curl, 'vWakeCurl');
  const vAlong = varying(point.along, 'vWakeAlong');

  const material = new THREE.MeshStandardNodeMaterial({
    side: THREE.DoubleSide,
    roughness: settings.roughness,
    metalness: 0,
  });
  material.name = 'SnowSurfWake';
  material.positionNode = point.position;

  // An open sheet with a curl in it: both faces are seen, so turn the normal
  // toward the eye. The concave orientation says whether the eye is inside the
  // barrel, which has to go dark and blue or the wall reads as a cut-out.
  const viewDirection = normalize(cameraPosition.sub(positionWorld));
  const normal = normalize(vNormal);
  const facing = select(dot(normal, viewDirection).greaterThanEqual(0), float(1), float(-1));
  material.normalNode = transformNormalToView(normal.mul(facing));

  const barrel = select(
    facing.greaterThan(0),
    smoothstep(0.05, 0.75, vQ).mul(vCurl.mul(0.55).add(0.45)),
    float(0),
  );
  const occlusion = mix(float(1), float(0.3), barrel);
  // Darkening goes blue in proportion: light in a fold of snow has travelled
  // through snow, and a neutral darkening lands on tan under a warm sun.
  const caveTint = mix(vec3(1), vec3(0.55, 0.72, 1), occlusion.oneMinus().mul(0.95));
  // Oblique projections so the grain does not band on a near-vertical face.
  const grain = sin(dot(positionWorld, vec3(0.91, 0.23, -0.35)).mul(9.1))
    .mul(sin(dot(positionWorld, vec3(0.28, 0.84, 0.46)).mul(7.3)))
    .mul(0.035);
  material.colorNode = color(settings.color).mul(caveTint).mul(occlusion).mul(grain.add(1));

  // Thick at the base, thin and glowing at the lip when the sun is behind it.
  const thickness = mix(float(0.92), float(0.32), smoothstep(0.15, 0.95, vQ));
  const backlight = dot(viewDirection, foliageLight.direction.negate()).max(0).pow(snow.lighting.backscatterPower);
  material.emissiveNode = color(snow.colors.shadow)
    .mul(foliageLight.color)
    .mul(foliageLight.strength)
    .mul(backlight)
    .mul(thickness.oneMinus())
    .mul(occlusion)
    .mul(settings.transmission);

  // Counter-drifting breakup softens the lip and dissolves an ageing wall into
  // powder instead of letting it shrink as a solid.
  const drift = time.mul(0.4);
  // Fine enough to read as crumbling powder rather than holes torn in a sheet;
  // a young wall stays whole below its lip.
  const breakup = sin(vAlong.mul(13.3).add(vQ.mul(17.1)).add(drift))
    .mul(sin(vAlong.mul(5.7).sub(vQ.mul(29.3)).sub(drift.mul(0.75))))
    .mul(0.5)
    .add(0.5);
  const erosion = smoothstep(0.35, 1, vAge).mul(0.95).add(smoothstep(0.85, 1, vQ).mul(0.3));
  const keep = breakup.sub(erosion).add(0.5);
  material.opacityNode = keep;
  material.alphaTest = 0.5;
  material.maskShadowNode = Fn(() => keep.greaterThan(0.5))();
  return material;
}

import * as THREE from 'three/webgpu';
import {
  Fn, Loop, attribute, cameraPosition, clamp, color, cross, dot, float, fwidth, int, ivec2, max, mix, normalize,
  positionWorld, select, smoothstep, texture, textureLoad, time, transformNormalToView, varying, vec2, vec3,
} from 'three/tsl';
import { foliageLight } from '../rendering/CinematicLighting.js';
import { noise2 } from './snowNoiseNodes.js';
import { snowSubsurface } from './snowShadingNodes.js';
import {
  WAKE_BASE_ANGLE, WAKE_BASE_OFFSET, WAKE_BASE_SPREAD, WAKE_LATERAL, WAKE_LUMP, WAKE_NORM, WAKE_NORMAL_TIP_ANGLE,
  WAKE_SECTION_STEPS, WAKE_SHEAR, WAKE_SINK, WAKE_SPREAD_END, WAKE_SPREAD_START, WAKE_SWEEP_POWER, WAKE_THINNING,
  WAKE_TIP_ANGLE, WAKE_TIP_CURL,
} from './snowWakeProfile.js';

// The ground detail strength the wake's grain weights were tuned against.
const WAKE_DETAIL_REFERENCE = 2.4;

// The snow-surf wake, ported from Snowflow's wake.vertex.wgsl, wake.fragment.wgsl
// and lib/wake.wgsl (MIT, Maksymilian Dendura). Every vertex is placed here from
// a static (column, row, side) lattice and the spine texture, so the buffer
// never changes with wake length.
export function createSnowWakeMaterial({ spineTexture, uniforms, columns, rows, settings, snow, textures = null }) {
  const scale = uniforms.scale;
  const last = max(uniforms.count, 2).sub(1);
  const fetch = (index, row) => textureLoad(spineTexture, ivec2(int(clamp(index, 0, last)), int(row)));

  const wakeSection = Fn(([q, curl]) => {
    const tip = curl.mul(WAKE_TIP_CURL).add(WAKE_TIP_ANGLE);
    const point = vec2(0, 0).toVar();
    const dt = q.div(WAKE_SECTION_STEPS);
    Loop(WAKE_SECTION_STEPS, ({ i }) => {
      const t = float(i).add(0.5).mul(dt);
      const angle = tip.sub(WAKE_BASE_ANGLE).mul(t.pow(WAKE_SWEEP_POWER)).add(WAKE_BASE_ANGLE);
      point.addAssign(vec2(angle.cos(), angle.sin()).mul(t.mul(-WAKE_THINNING).add(1)).mul(dt));
    });
    return vec2(point.x.mul(WAKE_LATERAL), point.y).mul(WAKE_NORM);
  }).setLayout({
    name: 'snowWakeSection',
    type: 'vec2',
    inputs: [{ name: 'q', type: 'float' }, { name: 'curl', type: 'float' }],
  });

  // Catmull-Rom for position, smoothstep-weighted scalars: a piecewise-linear
  // spine bands the differenced normal at exactly the sample pitch.
  const wakeFrame = (u, side) => {
    const index = u.clamp(0, 1).mul(last);
    const lower = index.floor();
    const t = index.sub(lower);
    const p0 = fetch(lower.sub(1), 0).xyz;
    const p1 = fetch(lower, 0).xyz;
    const p2 = fetch(lower.add(1), 0).xyz;
    const p3 = fetch(lower.add(2), 0).xyz;
    const t2 = t.mul(t);
    const t3 = t2.mul(t);
    const center = p1.mul(2)
      .add(p2.sub(p0).mul(t))
      .add(p0.mul(2).sub(p1.mul(5)).add(p2.mul(4)).sub(p3).mul(t2))
      .add(p0.negate().add(p1.mul(3)).sub(p2.mul(3)).add(p3).mul(t3))
      .mul(0.5);
    const weight = smoothstep(0, 1, t);
    const b1 = fetch(lower, 1);
    const b2 = fetch(lower.add(1), 1);
    const c1 = fetch(lower, 2);
    const c2 = fetch(lower.add(1), 2);
    const left = side.lessThan(0);
    return {
      center,
      amplitude: select(left, mix(b1.z, b2.z, weight), mix(b1.w, b2.w, weight)),
      curl: select(left, mix(c1.x, c2.x, weight), mix(c1.y, c2.y, weight)),
      distance: mix(p1Distance(lower), p1Distance(lower.add(1)), weight),
      age: mix(c1.z, c2.z, weight),
      right: normalize(vec3(b1.x, 0, b1.y).add(vec3(1e-6, 0, 0))),
    };
  };
  const p1Distance = (index) => fetch(index, 0).w;

  const wakePoint = (u, q, side) => {
    const frame = wakeFrame(u, side);
    const section = wakeSection(q, frame.curl);
    const along = frame.distance.div(scale);
    const baseOffset = smoothstep(WAKE_SPREAD_START, WAKE_SPREAD_END, along)
      .mul(WAKE_BASE_SPREAD).add(WAKE_BASE_OFFSET).mul(scale);
    // Thrown snow is not a ruled surface: two-and-a-bit drifting octaves of
    // lumps along the section's own normal, weighted toward the free crest.
    const normalAngle = q.pow(WAKE_SWEEP_POWER)
      .mul(frame.curl.mul(WAKE_TIP_CURL).add(WAKE_NORMAL_TIP_ANGLE)).add(WAKE_BASE_ANGLE);
    const sectionNormal = vec2(normalAngle.sin().negate(), normalAngle.cos());
    const lump = noise2(vec2(along.mul(1.13).add(q.mul(0.9)).add(side.mul(17.3)), q.mul(1.7).add(5.1).add(time.mul(0.3))))
      .mul(0.55)
      .add(noise2(vec2(along.mul(3.31).sub(q.mul(1.7)).add(side.mul(31.7)).sub(time.mul(0.45)), q.mul(4.3).add(2.7)))
        .mul(0.3))
      .add(noise2(vec2(along.mul(8.7).add(side.mul(5.3)), q.mul(9.1).add(time.mul(0.9)))).mul(0.15))
      .mul(WAKE_LUMP)
      .mul(smoothstep(0.12, 0.72, q));
    const lateral = baseOffset.add(section.x.add(sectionNormal.x.mul(WAKE_LATERAL).mul(lump)).mul(frame.amplitude));
    const height = section.y.add(sectionNormal.y.mul(lump)).mul(frame.amplitude).sub(scale.mul(WAKE_SINK));
    // Thrown snow lags the thing that threw it: shear the lip back along the spine.
    const back = vec3(frame.right.z.negate(), 0, frame.right.x);
    const position = frame.center
      .add(frame.right.mul(side.mul(lateral)))
      .add(vec3(0, height, 0))
      .add(back.mul(q.mul(q).mul(WAKE_SHEAR).mul(frame.amplitude)));
    return { position, frame, sectionNormal };
  };

  const lattice = attribute('wake', 'vec3');
  const u = lattice.x;
  const q = lattice.y;
  const side = lattice.z;
  const point = wakePoint(u, q, side);

  // Normals are differenced out of the same wakePoint. The offsets flip near
  // either edge so a pair never straddles a clamp and returns a zero tangent.
  const du = 0.65 / Math.max(columns - 1, 1);
  const dq = 0.65 / Math.max(rows, 1);
  const su = select(u.greaterThan(0.5), float(-1), float(1));
  const sq = select(q.greaterThan(0.5), float(-1), float(1));
  const alongU = wakePoint(u.add(su.mul(du)), q, side).position.sub(point.position).mul(su);
  const alongQ = wakePoint(u, q.add(sq.mul(dq)), side).position.sub(point.position).mul(sq);
  const crossed = cross(alongQ, alongU);
  const crossedLength = crossed.length();
  // Mirrored walls reverse handedness, so orient toward the concave side
  // explicitly: the barrel shading below asks which side the eye is on.
  const concave = point.frame.right.mul(side.mul(point.sectionNormal.x)).add(vec3(0, point.sectionNormal.y, 0));
  const oriented = crossed.mul(select(dot(crossed, concave).greaterThanEqual(0), float(1), float(-1)));
  // Degenerate where the envelope has collapsed the strip onto its spine.
  const normal = select(crossedLength.greaterThan(1e-7), oriented.div(crossedLength.max(1e-8)), vec3(0, 1, 0));

  const vNormal = varying(normal, 'vWakeNormal');
  const vQ = varying(q, 'vWakeQ');
  const vAge = varying(point.frame.age, 'vWakeAge');
  const vCurl = varying(point.frame.curl, 'vWakeCurl');
  const vAlong = varying(point.frame.distance.div(scale), 'vWakeAlong');

  const material = new THREE.MeshStandardNodeMaterial({
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
    forceSinglePass: true,
    roughness: settings.roughness,
    metalness: 0,
  });
  material.name = 'SnowSurfWake';
  material.positionNode = point.position;

  // An open sheet with a curl in it: turn the normal toward the eye, and
  // remember whether the eye is inside the barrel.
  const viewDirection = normalize(cameraPosition.sub(positionWorld));
  const geometric = normalize(vNormal);
  const facing = select(dot(geometric, viewDirection).greaterThanEqual(0), float(1), float(-1));
  let shading = geometric.mul(facing);
  if (textures) {
    // Broken snow grain from the Snow007C normal map, on two oblique
    // projections so a near-vertical face does not band, each faded by pixel
    // footprint the way Snowflow fades its noise octaves.
    const worldScale = snow.detail.worldScale;
    const footprint = fwidth(positionWorld).length().mul(0.5).max(1e-4);
    const projected = vec2(
      dot(positionWorld, vec3(0.91, 0.23, -0.35)),
      dot(positionWorld, vec3(0.28, 0.84, 0.46)),
    );
    const fine = texture(textures.normal, projected.mul(7.5 / worldScale)).xy.mul(2).sub(1)
      .mul(smoothstep(0.012 * worldScale, 0.09 * worldScale, footprint).oneMinus().mul(0.5));
    const coarse = texture(textures.normal, projected.mul(1.7 / worldScale)).xy.mul(2).sub(1)
      .mul(smoothstep(0.09 * worldScale, 0.55 * worldScale, footprint).oneMinus().mul(0.35));
    const up = select(shading.y.abs().greaterThan(0.99), vec3(1, 0, 0), vec3(0, 1, 0));
    const tangent = normalize(cross(up, shading));
    const bitangent = cross(shading, tangent);
    const detail = fine.add(coarse).mul(snow.detail.strength / WAKE_DETAIL_REFERENCE);
    shading = normalize(shading.add(tangent.mul(detail.x)).add(bitangent.mul(detail.y)));
  }
  material.normalNode = transformNormalToView(shading);

  // Only the inside of the curl darkens, and it goes blue as it does: a broad
  // neutral darkening under a warm sun lands on tan, not on shaded snow.
  const barrel = select(
    facing.greaterThan(0),
    smoothstep(0.05, 0.75, vQ).mul(vCurl.mul(0.55).add(0.45)),
    float(0),
  );
  const occlusion = mix(float(1), float(0.65), barrel);
  const caveTint = mix(vec3(1), vec3(0.55, 0.72, 1), occlusion.oneMinus().mul(0.95));
  const albedo = color(settings.color);
  material.colorNode = albedo.mul(occlusion).mul(caveTint);

  // Thick at the base, thin at the lip: the lip lights up from inside when
  // the sun is behind it.
  const thickness = mix(float(0.92), float(0.32), smoothstep(0.15, 0.95, vQ));
  material.emissiveNode = snowSubsurface({
    normal: shading,
    light: foliageLight.direction,
    view: viewDirection,
    lightColor: foliageLight.color.mul(foliageLight.strength),
    thickness,
    strength: snow.lighting.sssStrength * 0.45 * settings.transmission,
    radius: 1.5,
  }).mul(albedo).mul(occlusion).mul(caveTint);

  // Erosion does two jobs only: soften the top sixth of the section, and
  // dissolve the whole wall at the end of its life. Counter-drifting octaves,
  // sheared off the axes, so the lip boils rather than scrolls.
  const breakAmount = smoothstep(0.84, 1.06, vQ).mul(mix(float(0.34), float(0.7), vAge))
    .add(smoothstep(0.68, 1, vAge).mul(0.95));
  const coarseBreak = noise2(vec2(
    vAlong.mul(6.9).add(vQ.mul(3.1)).add(time.mul(0.9)),
    vQ.mul(13).sub(vAlong.mul(2.2)).sub(time.mul(0.6)),
  )).mul(0.72).add(0.5);
  const fineBreak = noise2(vec2(
    vAlong.mul(19).sub(vQ.mul(9)).add(31.7).sub(time.mul(3.1)),
    vQ.mul(31).add(vAlong.mul(7)).add(time.mul(2.3)),
  )).mul(0.72).add(0.5);
  const keep = coarseBreak.mul(0.58).add(fineBreak.mul(0.42)).sub(breakAmount).add(0.5);
  // Blend the erosion over a finite band, widened for subpixel detail. Fade
  // every exposed boundary so a translucent sheet never ends in a hard line.
  const softness = max(float(settings.alphaSoftness), fwidth(keep));
  const erosion = smoothstep(float(0.5).sub(softness), float(0.5).add(softness), keep);
  const crest = smoothstep(0.5, 1, vQ).oneMinus();
  const base = smoothstep(0, 0.14, vQ);
  const tail = smoothstep(0.3, 1, vAge).oneMinus();
  const bow = smoothstep(0, 0.35, vAlong);
  material.opacityNode = erosion.mul(crest).mul(base).mul(tail).mul(bow).mul(settings.opacity);
  return material;
}

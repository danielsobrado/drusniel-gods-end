import * as THREE from 'three/webgpu';
import { HouseBuilder } from './houseKit.js';
import { generateHouseSurfaces } from './houseTextures.js';

// Procedural stand-ins for the five baked medieval village houses: the same
// silhouettes, storeys and details in a few thousand triangles, textured with
// surfaces generated at load instead of a 4K baked atlas per house. Each
// design is measured off the original's orthographic elevations
// (tools/house-viewer) in a frame centred on the original's bounds with the
// ground at y = 0, in metres; `origin` is where that centre sits in the GLB's
// own frame, so a built house lands exactly where the GLB did (placement,
// grounding and footprint colliders are unchanged). Node materials, like
// the rest of the renderer's hand-built materials.

const ROUGHNESS = { window: 0.35 };

/**
 * One material per surface, shared by every house. The caller owns them
 * (disposeHouseMaterials releases the materials and their textures).
 */
export async function createHouseMaterials({ signal, useWorkers } = {}) {
  const surfaces = await generateHouseSurfaces({ signal, useWorkers });
  const materials = {};
  for (const [name, { map, normalMap }] of surfaces) {
    materials[name] = new THREE.MeshStandardNodeMaterial({
      name: `house-${name}`, map, normalMap, vertexColors: true, roughness: ROUGHNESS[name] ?? 0.9, metalness: name === 'window' ? 0.2 : 0,
    });
  }
  materials.metal = new THREE.MeshStandardNodeMaterial({ name: 'house-metal', color: 0x2a2724, vertexColors: true, roughness: 0.55, metalness: 0.6 });
  return materials;
}

export function disposeHouseMaterials(materials) {
  for (const material of Object.values(materials ?? {})) {
    material.map?.dispose();
    material.normalMap?.dispose();
    material.dispose();
  }
}

// ------------------------------------------------------------------ 003
// L-shaped cottage: a main range with its ridge along z and a front wing on
// its -x side with the ridge along x. Stone ground floor, cream plaster
// upper storey between timber rails, red clay roofs, a rendered chimney on
// the +x wall and a stone stair in the L up to the wing's first-floor door.
function house003(k) {
  const floor = 2.0, eave = 5.0;
  // Main range.
  const mainStone = k.walls('stone', { x0: -0.9, x1: 3.9, z0: -3.3, z1: 4.8, y0: 0, y1: floor });
  k.plinth('stone', { x0: -0.9, x1: 3.9, z0: -3.3, z1: 4.8 });
  k.plinth('stone', { x0: -3.8, x1: -0.9, z0: 1.4, z1: 4.8 });
  const main = k.walls('plaster', { x0: -1.1, x1: 4.0, z0: -4.9, z1: 4.85, y0: floor, y1: eave });
  k.box('wood', [-1.15, floor - 0.12, -4.95], [4.05, floor + 0.08, 4.9], { tint: 0.8 });
  k.joists(main.back, floor - 0.05, { out: -1.4, spacing: 0.9 });
  for (const w of [main.front, main.right, main.back, main.left]) {
    if (w === main.front) continue;
    k.timberFrame(w, { y0: floor + 0.05, y1: eave - 0.1, spacing: w === main.back ? 1.3 : 2.6, braces: w === main.back ? 'cross' : 'none', openings: w === main.left ? [[0, 6]] : [] });
  }
  k.window(main.left, 3.3, 3.2, 3.0, 0.8, { shutters: false });
  k.window(main.left, 5.7, 3.3, 0.5, 0.6);
  k.window(mainStone.back, 2.6, 0.5, 0.8, 1.1, { arch: true });
  k.window(main.back, 2.5, 3.1, 1.0, 1.0);
  const mainRoof = k.gableRoof({
    x0: -1.1, x1: 4.0, z0: -4.9, z1: 4.85, axis: 'z', wallTop: eave, ridgeY: 7.35, overhang: 0.4, endOverhang: 0.35,
    gableFrame: ['start'], sweep: 0.92, gableTint: [0.72, 0.74, 0.8],
  });
  k.dormer(mainRoof, { at: -3.6, offset: 1.7, facing: '-x', w: 1.0, h: 1.0 });
  k.dormer(mainRoof, { at: -0.4, offset: 1.9, facing: '-x', w: 1.0, h: 0.8 });
  k.ridgeSpikes(mainRoof, { count: 5, from: 0.08, to: 0.6 });

  // Front wing.
  const wingStone = k.walls('stone', { x0: -3.8, x1: -0.9, z0: 1.4, z1: 4.8, y0: 0, y1: floor, skip: ['right'] });
  const wing = k.walls('plaster', { x0: -3.85, x1: -1.1, z0: 1.4, z1: 4.85, y0: floor, y1: eave, skip: ['right'] });
  k.box('wood', [-3.9, floor - 0.12, 1.35], [-1.1, floor + 0.08, 4.9], { tint: 0.8 });
  for (const w of [wing.back, wing.left]) k.timberFrame(w, { y0: floor + 0.05, y1: eave - 0.1, spacing: 2.8, braces: 'none' });
  // One plain plastered front across wing and main range, between rails.
  k.wallBeam(k.wall([-3.85, 4.85], [0, 0, 1], 7.85), -0.1, floor, 7.95, floor, 0.2);
  k.wallBeam(k.wall([-3.85, 4.85], [0, 0, 1], 7.85), -0.1, eave - 0.1, 7.95, eave - 0.1, 0.2);
  k.window(wing.left, 1.7, 3.2, 1.9, 0.9);
  k.door(wingStone.left, 1.6, 0.95, 1.9, { arch: false });
  k.door(wing.back, 1.8, 0.9, 1.9, { y: floor });
  k.quoins(wingStone.left, 'start', 0, floor, { tint: 1.1 });
  const wingRoof = k.gableRoof({
    x0: -3.85, x1: -1.1, z0: 1.4, z1: 4.85, axis: 'x', wallTop: eave, ridgeY: 7.1, overhang: 0.35, endOverhang: 0.35,
    openEnds: ['end'], gableFrame: true,
  });
  k.window(k.wall([-3.87, 3.6], [-1, 0, 0], 1.0), 0.5, 5.5, 0.5, 0.5, { sill: false, mullion: false });
  k.ridgeSpikes(wingRoof, { count: 3, from: 0.15, to: 0.75 });
  k.sign(wing.left, 3.1, 3.0);

  // The stair in the L, up to the wing's first-floor door.
  k.stairs('stone', [-2.0, 0, -2.5], [-2.0, floor, 1.35], 1.2, 9);
  k.beam('stone', [-2.65, 0.4, -2.5], [-2.65, floor + 0.45, 1.35], 0.18, { tint: 1.2 });

  k.chimney({ x: 4.05, z: 3.4, w: 0.75, d: 0.9, y0: 0, y1: 8.9, material: 'plaster', pots: 3, tint: 0.85, capTint: 0.35 });
}

// ------------------------------------------------------------------ 004
// Tavern: dark stone ground floor with pale quoins, a jettied plank-and-timber
// band, and a steep bell-swept red roof (ridge along z) that comes down to
// the band, with two dormers on its -x slope and a stone stack on +x.
function house004(k) {
  const floor = 2.5, eave = 3.75;
  const ground = k.walls('darkStone', { x0: -2.6, x1: 2.6, z0: -3.8, z1: 3.5, y0: 0, y1: floor, topShade: 0.5 });
  k.plinth('darkStone', { x0: -2.6, x1: 2.6, z0: -3.8, z1: 3.5 });
  for (const w of Object.values(ground)) {
    k.quoins(w, 'start', 0, floor, { material: 'darkStone', tint: 1.6 });
    for (const u of [w.length * 0.33, w.length * 0.66]) k.wallBeam(w, u, 0, u, floor, 0.2, { tint: 0.8 });
  }
  k.door(ground.back, ground.back.length / 2, 1.3, 2.1, { tint: 0.75 });
  k.window(ground.left, 2.2, 1.0, 0.7, 0.6);
  k.window(ground.left, 5.0, 1.0, 0.7, 0.6);
  k.window(ground.right, 3.6, 1.0, 0.8, 0.6);
  k.box('wood', [-3.0, floor - 0.1, -4.2], [3.0, floor + 0.12, 4.1], { tint: 0.75 });
  for (const w of [ground.left, ground.right]) k.joists(w, floor - 0.15, { out: 0.45, spacing: 1.0 });
  const band = {
    ...k.walls('planks', { x0: -2.9, x1: 2.9, z0: -4.1, z1: 4.0, y0: floor + 0.1, y1: eave, topShade: 0.3, skip: ['front', 'back'], tint: 0.8 }),
  };
  Object.assign(band, (({ front, back }) => ({ front, back }))(k.walls('plaster', { x0: -2.9, x1: 2.9, z0: -4.1, z1: 4.0, y0: floor + 0.1, y1: eave, topShade: 0.3, skip: ['left', 'right'], tint: [0.8, 0.72, 0.6] })));
  for (const w of Object.values(band)) {
    const end = w === band.front || w === band.back;
    k.timberFrame(w, { y0: floor + 0.15, y1: eave - 0.05, spacing: end ? 1.45 : 1.35, braces: end ? 'cross' : 'none' });
  }
  const roof = k.gableRoof({
    x0: -2.9, x1: 2.9, z0: -4.1, z1: 4.0, axis: 'z', wallTop: eave, ridgeY: 6.8, sweep: 0.55, overhang: 0.45, endOverhang: 0.55, sag: 0.15,
    gableMaterial: 'plaster', gableTint: [0.62, 0.6, 0.6], gableFrame: true,
  });
  for (const [z, dir] of [[4.0, 1], [-4.1, -1]]) {
    const w = k.wall([dir > 0 ? -0.45 : 0.45, z + dir * 0.02], [0, 0, dir], 0.9);
    k.window(w, 0.45, 4.2, 0.9, 0.8);
  }
  k.dormer(roof, { at: -2.3, offset: 2.2, facing: '-x', w: 1.0, h: 1.0 });
  k.dormer(roof, { at: 2.3, offset: 2.2, facing: '-x', w: 1.0, h: 1.0 });
  k.ridgeSpikes(roof, { count: 9, from: 0.02, to: 0.98, height: 0.9 });
  k.chimney({ x: 1.7, z: 1.7, w: 0.8, d: 0.8, y0: 3.0, y1: 6.9, material: 'darkStone', pots: 0, tint: 1.1 });
  k.sign(ground.left, 0.1, 2.9, { out: 0.9 });
}

// ------------------------------------------------------------------ 005
// Blacksmith: a long stone cottage (ridge along x) with a low timber upper
// band, two stacks and an open plank-roofed forge shed on posts behind it.
function house005(k) {
  const floor = 2.3, eave = 3.6;
  const ground = k.walls('darkStone', { x0: -3.6, x1: 3.4, z0: -1.0, z1: 4.5, y0: 0, y1: floor, topShade: 0.4 });
  k.plinth('darkStone', { x0: -3.6, x1: 3.4, z0: -1.0, z1: 4.5 });
  for (const w of Object.values(ground)) k.quoins(w, 'start', 0, floor, { material: 'darkStone', tint: 1.6 });
  k.window(ground.front, 1.6, 1.0, 0.9, 0.45, { mullion: false });
  k.window(ground.front, 5.3, 1.0, 0.9, 0.45, { mullion: false });
  k.window(ground.left, 3.0, 0.45, 0.9, 1.4, { arch: true });
  k.window(ground.right, 2.5, 0.45, 0.9, 1.4, { arch: true });
  k.door(ground.back, 1.7, 1.0, 2.0, { tint: 0.7 });
  k.window(ground.back, 4.6, 0.5, 0.9, 1.4, { arch: true });
  k.box('wood', [-4.0, floor - 0.1, -1.3], [3.8, floor + 0.12, 4.75], { tint: 0.75 });
  const band = k.walls('plaster', { x0: -3.9, x1: 3.7, z0: -1.25, z1: 4.7, y0: floor + 0.1, y1: eave, tint: [0.78, 0.7, 0.6], topShade: 0.4 });
  for (const w of Object.values(band)) k.timberFrame(w, { y0: floor + 0.15, y1: eave - 0.05, spacing: 1.3, braces: 'none' });
  k.gableRoof({
    x0: -3.9, x1: 3.7, z0: -1.25, z1: 4.7, axis: 'x', wallTop: eave, ridgeY: 6.4, sag: 0.25, overhang: 0.35, endOverhang: 0.9,
    gableMaterial: 'plaster', gableTint: [0.75, 0.68, 0.58], gableFrame: true, purlins: 3,
  });
  for (const [x, dir] of [[-3.9, -1], [3.7, 1]]) {
    const w = k.wall([x + dir * 0.02, dir > 0 ? 2.25 : 1.2], [dir, 0, 0], 1.05);
    k.window(w, 0.52, 4.0, 0.7, 0.6, { shutters: true });
  }
  k.chimney({ x: -2.7, z: -0.85, w: 0.85, d: 0.85, y0: 0, y1: 7.0, material: 'darkStone', pots: 0, tint: 0.9 });
  k.chimney({ x: 2.9, z: 2.9, w: 0.9, d: 0.75, y0: 3.0, y1: 6.6, material: 'darkStone', pots: 2, tint: 0.9 });
  // The forge shed: a plank lean-to on posts with knee braces.
  const [x0, x1, z0, z1] = [-4.0, 3.5, -5.0, -1.25];
  const hi = 3.55, lo = 3.05;
  k.poly('deck', [[x0, lo, z0], [x1, lo, z0], [x1, hi, z1], [x0, hi, z1]], { facing: [0, 1, 0], tint: [0.72, 0.7, 0.68] });
  k.poly('deck', [[x0, lo - 0.12, z0], [x1, lo - 0.12, z0], [x1, hi - 0.12, z1], [x0, hi - 0.12, z1]], { facing: [0, -1, 0], tint: 0.6 });
  k.poly('wood', [[x0, lo - 0.12, z0], [x1, lo - 0.12, z0], [x1, lo, z0], [x0, lo, z0]], { facing: [0, 0, -1], tint: 0.7 });
  for (const x of [x0 + 0.2, (x0 + x1) / 2, x1 - 0.2]) {
    // Posts reach below the ground line, like the plinth, for a falling slope.
    k.beam('wood', [x, -2, z0 + 0.2], [x, lo - 0.1, z0 + 0.2], 0.2);
    k.beam('wood', [x, lo - 0.9, z0 + 0.2], [x, lo - 0.15, z0 + 1.0], 0.12);
    k.beam('wood', [x, lo - 0.2, z0], [x, hi - 0.2, z1], 0.16, { tint: 0.8 });
  }
  // Forge hearth and anvil under the shed.
  k.box('darkStone', [-2.6, -2, -3.4], [-0.8, 0.75, -2.2], { tint: 0.8 });
  k.box('metal', [0.4, 0, -3.0], [0.8, 0.5, -2.7]);
  k.box('metal', [0.1, 0.5, -3.05], [1.1, 0.7, -2.65]);
}

// ------------------------------------------------------------------ 006
// Residential: a tall town house on a stone undercroft that starts 1.4 m up
// (a post runs down to the ground), two jettied timber storeys, a big
// hipped bell roof (ridge along x) with a cross gable toward +z, a back wing
// and dormers, and a slender stack.
function house006(k) {
  const base = 1.4, first = 4.6, second = 7.3, eave = 10.0;
  const plaster = [0.66, 0.56, 0.44];
  const stone = k.walls('darkStone', { x0: -4.9, x1: 5.0, z0: -4.3, z1: 4.3, y0: base, y1: first, topShade: 0.5 });
  k.plinth('darkStone', { x0: -4.9, x1: 5.0, z0: -4.3, z1: 4.3, top: base });
  for (const w of Object.values(stone)) k.quoins(w, 'start', base, first, { material: 'darkStone', tint: 1.6 });
  k.door(stone.back, 5.0, 1.1, 2.1, { arch: true, y: base, tint: 0.7 });
  k.door(stone.left, 4.0, 1.0, 2.0, { arch: true, y: base, tint: 0.7 });
  k.beam('wood', [-5.1, 0, 1.4], [-5.1, base + 0.3, 1.4], 0.18);
  const a = k.walls('plaster', { x0: -5.6, x1: 6.4, z0: -2.7, z1: 3.1, y0: first, y1: second, tint: plaster });
  k.box('wood', [-5.7, first - 0.15, -4.5], [6.5, first + 0.1, 4.5], { tint: 0.6 });
  // Railings round the terrace the jetty leaves on top of the undercroft.
  for (const [za, zb] of [[4.45, 4.45], [-4.45, -4.45]]) {
    k.beam('wood', [-5.6, first + 1.0, za], [6.4, first + 1.0, zb], 0.12, { tint: 0.6 });
    for (let x = -5.6; x <= 6.4; x += 0.6) k.beam('wood', [x, first, za], [x, first + 1.0, za], 0.07, { tint: 0.6 });
  }
  for (const w of Object.values(stone)) k.joists(w, first - 0.25, { out: 0.7, spacing: 0.7 });
  for (const w of Object.values(a)) {
    k.timberFrame(w, { y0: first + 0.1, y1: second - 0.05, spacing: 1.5, braces: 'diagonal', rails: [first + 1.0], tint: 0.65 });
    for (let u = 1.5; u < w.length - 1; u += 3.0) k.window(w, u + 0.75, first + 1.2, 0.7, 0.9, { sill: false });
  }
  const b = k.walls('plaster', { x0: -6.3, x1: 7.5, z0: -3.0, z1: 3.4, y0: second, y1: eave, tint: plaster });
  k.box('wood', [-6.4, second - 0.15, -3.1], [7.6, second + 0.1, 3.5], { tint: 0.75 });
  for (const w of Object.values(b)) {
    k.timberFrame(w, { y0: second + 0.1, y1: eave - 0.05, spacing: 1.4, braces: 'cross', rails: [second + 1.0], tint: 0.65 });
    for (let u = 1.4; u < w.length - 1; u += 2.8) k.window(w, u + 0.7, second + 1.1, 0.6, 0.8, { sill: false, mullion: false });
  }
  // Wings on the jettied storeys: a cross gable to +z and a wing to -z.
  const front = k.walls('plaster', { x0: -2.2, x1: 1.4, z0: 3.3, z1: 5.0, y0: first, y1: eave, tint: plaster, skip: ['back'] });
  for (const w of [front.front, front.left, front.right]) k.timberFrame(w, { y0: first + 0.1, y1: eave - 0.05, spacing: 1.2, braces: 'none', rails: [second], tint: 0.65 });
  k.window(front.front, 1.8, second + 0.8, 1.4, 1.0);
  k.window(front.front, 1.8, first + 1.0, 1.4, 1.0);
  const back = k.walls('plaster', { x0: -0.6, x1: 3.8, z0: -4.9, z1: -2.9, y0: first, y1: eave, tint: plaster, skip: ['front'] });
  for (const w of [back.back, back.left, back.right]) k.timberFrame(w, { y0: first + 0.1, y1: eave - 0.05, spacing: 1.4, braces: 'none', rails: [second], tint: 0.65 });
  const roof = k.gableRoof({
    x0: -6.3, x1: 7.5, z0: -3.0, z1: 3.4, axis: 'x', wallTop: eave, ridgeY: 13.7, sweep: 0.7, overhang: 0.45, endOverhang: 0.4, tint: 0.85,
    hips: [1.6, 1.8],
  });
  k.gableRoof({
    x0: -2.2, x1: 1.4, z0: 2.0, z1: 5.0, axis: 'z', wallTop: eave, ridgeY: 12.9, sweep: 0.7, overhang: 0.4, endOverhang: 0.35,
    openEnds: ['start'], gableFrame: true, gableTint: plaster,
  });
  k.gableRoof({
    x0: -0.6, x1: 3.8, z0: -4.9, z1: -1.5, axis: 'z', wallTop: eave, ridgeY: 12.6, sweep: 0.7, overhang: 0.4, endOverhang: 0.35,
    openEnds: ['end'], gableFrame: true, gableTint: plaster,
  });
  k.dormer(roof, { at: 3.0, offset: 1.9, facing: '+z', w: 1.0, h: 0.9 });
  k.dormer(roof, { at: 5.2, offset: 1.9, facing: '+z', w: 1.0, h: 0.9 });
  k.dormer(roof, { at: -4.0, offset: 1.9, facing: '+z', w: 1.0, h: 0.9 });
  k.dormer(roof, { at: -3.3, offset: 1.9, facing: '-z', w: 1.0, h: 0.9 });
  k.ridgeSpikes(roof, { count: 7, from: 0.14, to: 0.86 });
  k.chimney({ x: -2.2, z: 0.4, w: 0.55, d: 0.55, y0: 11, y1: 15.3, material: 'darkStone', pots: 1, tint: 0.8 });
}

// ------------------------------------------------------------------ 009
// Tavern on a plank deck: a stone storey with arched windows over a stone
// cellar, a dark timber-framed storey, and a bell-swept slate roof whose
// ridge (along x) sags between its ends.
function house009(k) {
  const deck = 2.0, first = 5.0, eave = 8.3;
  const dark = [0.24, 0.25, 0.29];
  k.box('darkStone', [-4.0, 0, -0.2], [-1.6, deck, 1.6], { tint: 0.8 });
  k.stairs('darkStone', [-1.0, 0, 0.7], [-1.6, deck, 0.7], 1.0, 4, { tint: 0.85 });
  // Deck boards run along z, ragged at both ends.
  for (let x = -4.3; x < 5.9; x += 0.34) {
    const z0 = -3.4 - k.random() * 0.8, z1 = 3.4 + k.random() * 0.8;
    k.box('deck', [x, deck - 0.12, z0], [x + 0.3, deck, z1], { tint: 0.7 + k.random() * 0.3 });
  }
  const stone = k.walls('darkStone', { x0: -4.0, x1: 5.1, z0: -3.1, z1: 3.2, y0: deck, y1: first, topShade: 0.4 });
  k.plinth('darkStone', { x0: -4.0, x1: 5.1, z0: -3.1, z1: 3.2, top: deck - 0.12 });
  for (const w of Object.values(stone)) k.quoins(w, 'start', deck, first, { tint: 0.75 });
  for (const u of [2.5, 4.9, 7.0]) k.window(stone.front, u, 3.3, 0.8, 1.1, { arch: true });
  for (const u of [2.1, 4.2, 6.6]) k.window(stone.back, u, 3.3, 0.8, 1.1, { arch: true });
  k.door(stone.right, 3.6, 1.0, 2.2, { y: deck, tint: 0.7 });
  k.window(stone.right, 1.8, 3.3, 0.8, 1.1, { arch: true });
  k.door(stone.left, 3.0, 1.0, 2.1, { y: deck, tint: 0.7 });
  k.stairs('darkStone', [6.3, deck - 1.4, 0.5], [5.2, deck, 0.5], 1.0, 4, { tint: 0.9 });
  k.box('wood', [-4.2, first - 0.1, -3.3], [5.4, first + 0.12, 3.4], { tint: 0.75 });
  const upper = k.walls('plaster', { x0: -4.1, x1: 5.3, z0: -3.2, z1: 3.3, y0: first + 0.1, y1: eave, tint: dark });
  for (const w of Object.values(upper)) {
    const long = w === upper.front || w === upper.back;
    const openings = long ? [[1.3, 3.0], [5.8, 7.6]] : [[2.2, 4.2]];
    k.timberFrame(w, { y0: first + 0.15, y1: eave - 0.05, spacing: long ? 1.55 : 1.6, braces: 'diagonal', rails: [first + 1.2], openings });
    for (const [o0, o1] of openings) k.window(w, (o0 + o1) / 2, first + 1.6, 0.9, 1.0);
  }
  const roof = k.gableRoof({
    x0: -4.1, x1: 5.3, z0: -3.2, z1: 3.3, axis: 'x', wallTop: eave, ridgeY: 11.9, sag: 0.5, sweep: 0.55, overhang: 0.5, endOverhang: 0.4,
    material: 'roofSlate', gableMaterial: 'plaster', gableTint: dark, gableFrame: true, purlins: 3,
  });
  k.ridgeSpikes(roof, { count: 6, from: 0.02, to: 0.98 });
  k.chimney({ x: 4.0, z: 1.3, w: 0.9, d: 0.9, y0: 8.0, y1: 12.0, material: 'darkStone', pots: 0, tint: 0.95 });
}

export const HOUSE_DESIGNS = Object.freeze({
  '003': { file: 'medieval-house-003', build: house003, seed: 3, origin: [-0.912, -0.066, -3.141], palette: { roofTiles: 0.85, wood: 0.8 } },
  '004': {
    file: 'medieval-house-004-tavern', build: house004, seed: 4, origin: [-0.006, -0.021, 0.003],
    palette: { darkStone: 0.45, wood: 0.55, planks: 0.55, plaster: 0.7, roofTiles: [1.35, 0.7, 0.45] },
  },
  '005': {
    file: 'medieval-house-005-blacksmith', build: house005, seed: 5, origin: [-0.864, -0.042, -1.014],
    palette: { darkStone: 0.4, stone: 0.5, wood: 0.5, plaster: 0.65, roofTiles: [0.6, 0.42, 0.38], deck: 0.75 },
  },
  '006': {
    file: 'medieval-house-006-residential', build: house006, seed: 6, grimeHeight: 1.4, groundY: 1.4, origin: [-2.2, -1.506, 1.481],
    palette: { darkStone: 0.4, stone: 0.5, wood: 0.45, plaster: 0.3, roofTiles: [0.95, 0.65, 0.55] },
  },
  '009': {
    file: 'medieval-house-009-tavern', build: house009, seed: 9, grimeHeight: 2.0, groundY: 1.9, origin: [-0.651, -2.252, -0.003],
    palette: { darkStone: 0.45, wood: 0.55, plaster: [0.15, 0.16, 0.19], roofSlate: 0.5, stone: 0.5 },
  },
});

/** Builds one house as a group of meshes (one per surface), in metres. */
export function buildHouse(id, materials) {
  const design = HOUSE_DESIGNS[id];
  const builder = new HouseBuilder({ seed: design.seed, grimeHeight: design.grimeHeight ?? 0, palette: design.palette });
  design.build(builder);
  const group = builder.build(materials, design.origin);
  group.name = `procedural-house-${id}`;
  group.userData.procedural = id;
  // The design's ground line in the built (origin-shifted) frame: placement
  // levels the house there, and its plinth reaches below.
  group.userData.groundY = (design.groundY ?? 0) + (design.origin?.[1] ?? 0);
  return group;
}

import { readFile } from 'node:fs/promises';
const buffer = await readFile('public/Assets/Drunsiel_Warden_biped_Animation_Running_withSkin.glb');
const gltf = JSON.parse(buffer.subarray(20, 20 + buffer.readUInt32LE(12)).toString());
console.log(JSON.stringify({
  animations: gltf.animations?.map(a => ({ name: a.name, channels: a.channels.length })),
  bones: gltf.nodes?.map(n => n.name).filter(n => /leg|foot|hip|spine|arm|thigh|calf/i.test(n)),
}, null, 2));

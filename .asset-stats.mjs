import {readFileSync} from 'node:fs';
const data=readFileSync('public/Assets/terrain/landscape/landscape.glb');
const json=JSON.parse(data.subarray(20,20+data.readUInt32LE(12)).toString());
console.log(JSON.stringify(json.meshes.map(m=>({name:m.name,primitives:m.primitives.map(p=>({vertices:json.accessors[p.attributes.POSITION].count,indices:json.accessors[p.indices]?.count}))}))));

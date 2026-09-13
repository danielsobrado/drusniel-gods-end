import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {MeshoptDecoder} from 'three/addons/libs/meshopt_decoder.module.js';
export const optimized=typeof FOREST_OPTIMIZED!=='undefined'&&FOREST_OPTIMIZED;
export const assetUrl=name=>`/assets/${name}.${optimized?'gltf':'glb'}`;
export const assetLoader=()=>new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);

import * as THREE from 'three';
import {createSky} from './sky.js';
import {createForestWorld,elevation} from './forest-world.js';
import {assetLoader,assetUrl} from './asset-loader.js';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
const scene=new THREE.Scene();scene.background=new THREE.Color('#a7c6d1');scene.fog=new THREE.FogExp2('#91b1b7',.018);
scene.add(createSky());
const camera=new THREE.PerspectiveCamera(62,innerWidth/innerHeight,.1,600);
const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setSize(innerWidth,innerHeight);renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));
renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1;
renderer.shadowMap.autoUpdate=false;
document.body.appendChild(renderer.domElement);
const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;controls.maxDistance=210;controls.minDistance=1;controls.maxPolarAngle=Math.PI*.58;
function reference(){camera.position.set(0,2.5,12);controls.target.set(0,4.4,-4);controls.update();}reference();
scene.add(new THREE.HemisphereLight('#d5e9f3','#41452a',1.8));
const sun=new THREE.DirectionalLight('#fff0c6',3);sun.position.set(-8,20,-12);sun.target.position.set(0,0,-3);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);Object.assign(sun.shadow.camera,{left:-25,right:25,top:25,bottom:-25,near:1,far:70});sun.shadow.normalBias=.035;scene.add(sun,sun.target);
const wind={value:1},time={value:0};let model,world;
const loaderUi=document.querySelector('#loader');
const loaderFill=document.querySelector('#loader-fill');
const loaderPct=document.querySelector('#loader-pct');
function setLoadProgress(loaded,total){
  if(!total){
    loaderFill.classList.add('indeterminate');
    loaderPct.textContent='Loading…';
    return;
  }
  loaderFill.classList.remove('indeterminate');
  const pct=Math.min(100,Math.round(100*loaded/total));
  loaderFill.style.width=pct+'%';
  loaderPct.textContent=pct+'%';
}
function hideLoader(){
  setLoadProgress(1,1);
  loaderUi.classList.add('done');
  setTimeout(()=>loaderUi.remove(),400);
}
function loadForest(url){
  return new Promise((resolve,reject)=>{
    assetLoader().load(url,resolve,(event)=>setLoadProgress(event.loaded,event.total),reject);
  });
}
try {
 const gltf=await loadForest(assetUrl('coastal_jungle'));model=gltf.scene;
 model.traverse(o=>{if(!o.isMesh)return;o.receiveShadow=true;o.castShadow=true;const materials=Array.isArray(o.material)?o.material:[o.material];for(const m of materials){if(m.map){m.map.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());}if(m.name.includes('atlas')){m.alphaTest=.4;m.transparent=false;m.side=THREE.DoubleSide;m.depthWrite=true;}if(m.name.includes('grass')){o.castShadow=false;}if(m.name.includes('atlas')&&!m.userData.wind){m.userData.wind=true;m.onBeforeCompile=shader=>{shader.uniforms.forestTime=time;shader.uniforms.windStrength=wind;shader.vertexShader='uniform float forestTime; uniform float windStrength;\n'+shader.vertexShader;shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nvec3 wp=position;\n#ifdef USE_INSTANCING\nwp=(instanceMatrix*vec4(position,1.0)).xyz;\n#endif\ntransformed.x+=sin(forestTime*1.4+wp.x*.7+wp.z*.6)*0.035*windStrength*min(abs(position.y),1.0);');};}}});
 const response=await fetch('/assets/world_config.json');if(!response.ok)throw Error('World configuration missing');
 const config=await response.json();world=await createForestWorld(gltf,config);
 scene.fog.density=config.fog_density;scene.add(world.root);world.update(camera,true);
 renderer.shadowMap.needsUpdate=true;window.forestReady=true;window.forestWorld=world;window.forestCamera=camera;window.forestLoadMs=performance.now();hideLoader();
} catch(e){
  loaderFill.classList.remove('indeterminate');
  loaderPct.textContent='Could not load forest';
  document.querySelector('#status').textContent='Could not load forest: '+e.message;
  throw e;
}
document.querySelector('#reset').onclick=reference;
document.querySelector('#alternate').onclick=()=>{camera.position.set(2,2.3,5);controls.target.set(-3,4.2,-8);controls.update();};
document.querySelector('#overview').onclick=()=>{camera.position.set(65,36,75);controls.target.set(0,8,0);controls.update();};
document.querySelector('#wind').onclick=e=>{wind.value=1-wind.value;e.target.textContent='Wind: '+(wind.value?'on':'off');};
addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);});
const keys=new Set();addEventListener('keydown',e=>keys.add(e.code));addEventListener('keyup',e=>keys.delete(e.code));addEventListener('blur',()=>keys.clear());
const forward=new THREE.Vector3(),side=new THREE.Vector3(),movement=new THREE.Vector3(),up=new THREE.Vector3(0,1,0),shadowCenter=new THREE.Vector3();
let frames=0,last=0,previous=performance.now();
const status=document.querySelector('#status');
renderer.setAnimationLoop(now=>{
  if(!last) last=now;
  time.value=now*.001;
  const delta=Math.min(.05,(now-previous)/1000);previous=now;
  camera.getWorldDirection(forward);forward.y=0;forward.normalize();side.crossVectors(forward,up);
  movement.set(0,0,0);
  if(keys.has('KeyW'))movement.add(forward);if(keys.has('KeyS'))movement.sub(forward);
  if(keys.has('KeyD'))movement.add(side);if(keys.has('KeyA'))movement.sub(side);
  if(movement.lengthSq()) {
    movement.normalize().multiplyScalar(delta*(keys.has('ShiftLeft')?18:7));
    camera.position.add(movement);controls.target.add(movement);
    camera.position.x=THREE.MathUtils.clamp(camera.position.x,-115,115);camera.position.z=THREE.MathUtils.clamp(camera.position.z,-115,115);
    camera.position.y=Math.max(camera.position.y,elevation(camera.position.x,camera.position.z)+1.2);
  }
  controls.update();
  const minimumHeight=elevation(camera.position.x,camera.position.z)+1.2;
  if(camera.position.y<minimumHeight){camera.position.y=minimumHeight;camera.lookAt(controls.target);}
  if(world){world.update(camera);if(camera.position.distanceToSquared(shadowCenter)>144){shadowCenter.copy(camera.position);sun.position.set(camera.position.x-8,20+elevation(camera.position.x,camera.position.z),camera.position.z-24);sun.target.position.set(camera.position.x,0,camera.position.z-12);renderer.shadowMap.needsUpdate=true;}}
  renderer.render(scene,camera);
  frames++;
  const elapsed=now-last;
  if(elapsed>=500){
    const fps=Math.round(frames*1000/elapsed);
    window.forestStats={fps,calls:renderer.info.render.calls,triangles:renderer.info.render.triangles,...world?.stats};
    status.textContent=`${fps} fps · ${renderer.info.render.calls} draws`;
    last=now;
    frames=0;
  }
});

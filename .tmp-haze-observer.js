(async()=>{
 const d=window.__grassDemo,r=d.world.renderer,{materialColor}=await import('/node_modules/three/build/three.tsl.js');const cache=new Map();
 d.world.scene.traverse(o=>{if(o.isMesh&&/stone|lantern/i.test(o.name)){if(!cache.has(o.material)){const m=r.library.fromMaterial(o.material);m.colorNode=materialColor;m.needsUpdate=true;cache.set(o.material,m);}o.material=cache.get(o.material);}});
 for(const preset of ['rainy','moonlight','sunny']){d.environment.setPreset(preset);d.environment.update(5);d.cinematicLighting.update();await window.__renderBeauty();}
 return {errors:window.__gpuErrors};
})()

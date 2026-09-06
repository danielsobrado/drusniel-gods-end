(async()=>{
 const d=window.__grassDemo;const {renderGroup}=await import('/node_modules/three/build/three.tsl.js');
 for(const u of [d.cinematicLighting.fogColor,d.cinematicLighting.fogDensity,...Object.values(d.world.sky.uniforms)])u.setGroup(renderGroup);
 d.world.scene.traverse(o=>{if(o.material)o.material.needsUpdate=true;});
 return {};
})()

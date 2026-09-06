(async()=>{
 const d=window.__grassDemo,r=d.world.renderer,cache=new Map();
 d.world.scene.traverse(o=>{if(o.isMesh&&/stone|lantern/i.test(o.name)){if(!cache.has(o.material))cache.set(o.material,r.library.fromMaterial(o.material));o.material=cache.get(o.material);}});
 await window.__renderBeauty();await window.__renderBeauty();return {converted:cache.size};
})()

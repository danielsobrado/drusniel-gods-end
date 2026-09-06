(async()=>{
 const d=window.__grassDemo,r=d.world.renderer;const seen=new Set();
 d.world.scene.traverse(o=>{if(o.isMesh&&/stone|lantern/i.test(o.name)){const m=o.material;if(!seen.has(m)){seen.add(m);m.needsUpdate=true;}}});
 await window.__renderBeauty();return {materials:seen.size};
})()

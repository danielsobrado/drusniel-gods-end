export async function benchmarkReflections() {
 const d=window.__grassDemo,w=d.water;
 if (!d.world.renderer.info.render.triangles) throw new Error('Wait for the scene to finish loading.');
 const originalUpdate=d.player.update, tourUpdate=d.tour.update;
 const position=d.player.getPosition().clone(), cameraPosition=d.world.camera.position.clone(), rotation=d.world.camera.quaternion.clone();
 d.player.update=()=>{};d.tour.update=()=>{};
 d.player.setPosition(130,5,90);d.world.camera.position.set(140,12,110);d.world.camera.lookAt(90,10,-100);
 const lake=w.lakeReflectionBudget.shouldRender,sea=w.seaReflectionBudget.shouldRender,update=w.update;
 let phase=0;
 const measure=moving=>new Promise(resolve=>{let last=performance.now(),skip=20;const t=[];
 const tick=now=>{if(moving){phase+=.025;d.world.camera.position.x=140+Math.sin(phase)*4;d.world.camera.lookAt(90,10,-100);}
 if(skip--<=0)t.push(now-last);last=now;if(t.length<120)requestAnimationFrame(tick);else{t.sort((a,b)=>a-b);resolve({median:t[60],p95:t[114],mean:t.reduce((a,b)=>a+b)/120});}};requestAnimationFrame(tick);});
 const r={};try {
 r.fixedStationary=await measure(false);r.fixedMoving=await measure(true);
 w.lakeReflectionBudget.shouldRender=()=>true;w.seaReflectionBudget.shouldRender=()=>true;
 let elapsed=0;w.update=function(delta,...args){elapsed+=delta;if(elapsed>=.75){this.reflectionInitialized=false;elapsed=0;}return update.call(this,delta,...args);};
 r.previousMoving=await measure(true);r.previousStationary=await measure(false);
 }finally{
 w.update=update;w.lakeReflectionBudget.shouldRender=lake;w.seaReflectionBudget.shouldRender=sea;
 d.player.setPosition(position.x,position.y,position.z);d.world.camera.position.copy(cameraPosition);d.world.camera.quaternion.copy(rotation);
 d.player.update=originalUpdate;d.tour.update=tourUpdate;
 }
 return r;
}

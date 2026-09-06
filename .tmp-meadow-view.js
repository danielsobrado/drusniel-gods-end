(async()=>{
 const d=window.__grassDemo,r=d.world.renderer;
 r.setAnimationLoop(null);r._animation.stop();document.querySelector('.loading-overlay')?.remove();
 d.player.enabled=false;d.tour.active=false;
 d.world.camera.position.set(10.2544,4.6975,9.054);
 d.world.camera.lookAt(12.8544,3.3475,5.554);d.world.camera.updateMatrixWorld();
 d.trees.update(1);d.trees.update(1);d.cinematicLighting.update();
 d.grass.update(0,30,d.player.getPosition());
 for(let i=0;i<3;i++){r._nodes.nodeFrame.frameId++;d.pipeline.render();await r.backend.device.queue.onSubmittedWorkDone();}
 return {errors:window.__gpuErrors,grass:d.grass.stats};
})()

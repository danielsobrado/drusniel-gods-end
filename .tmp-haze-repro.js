(async()=>{
 const d=window.__grassDemo,r=d.world.renderer;
 r.setAnimationLoop(null);r._animation.stop();document.querySelector('.loading-overlay')?.remove();d.player.enabled=false;d.tour.active=false;
 d.player.setPosition(136,d.world.terrainSampler.sampleHeight(136,35)+.05,35);
 d.world.camera.position.set(125,-1,32);d.world.camera.lookAt(141,-3,40);d.world.camera.updateMatrixWorld();
 d.environment.setPreset('sunny');d.environment.update(5);d.cinematicLighting.update();
 const focus=d.player.getPosition();d.environment.updateSunTarget(focus);d.trees.update(1);d.trees.update(1);d.grass.update(0,30,focus);d.meadow.update(0,focus,d.environment.current);
 for(let i=0;i<3;i++){r._nodes.nodeFrame.frameId++;d.pipeline.render();await r.backend.device.queue.onSubmittedWorkDone();}
 const props=[];d.world.scene.traverse(o=>{if(o.isMesh&&/stone|lantern/i.test(o.name))props.push({name:o.name,pos:o.position,material:o.material.type,fog:o.material.fog,uuid:o.material.uuid});});
 return {props:props.slice(0,15),count:props.length,errors:window.__gpuErrors};
})()

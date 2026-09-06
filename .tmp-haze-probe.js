(async()=>{
 const d=window.__grassDemo,r=d.world.renderer;
 for(const preset of ['rainy','moonlight','sunny']){d.environment.setPreset(preset);d.environment.update(5);d.cinematicLighting.update();r._nodes.nodeFrame.frameId++;d.pipeline.render();await r.backend.device.queue.onSubmittedWorkDone();}
 return {errors:window.__gpuErrors};
})()

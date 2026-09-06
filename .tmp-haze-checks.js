(async()=>{
 const d=window.__grassDemo,r=d.world.renderer;
 const {checkFoliageRendering}=await import('/scripts/gpu/foliage-check.js');
 const result=await checkFoliageRendering(r);
 r._nodes.nodeFrame.frameId++;d.pipeline.render();await r.backend.device.queue.onSubmittedWorkDone();
 return {...result,errors:window.__gpuErrors};
})()

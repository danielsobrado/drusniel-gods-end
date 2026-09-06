(async()=>{
 const d=window.__grassDemo,r=d.world.renderer;
 window.__renderBeauty=async()=>{r._nodes.nodeFrame.frameId++;d.pipeline.render({occlusionEnabled:false});await r.backend.device.queue.onSubmittedWorkDone();};
 await window.__renderBeauty();await window.__renderBeauty();
 return {fog:d.cinematicLighting.fogColor.value,sceneFog:d.world.scene.fog.color};
})()

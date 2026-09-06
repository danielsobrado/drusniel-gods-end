(async()=>{
 const d=window.__grassDemo,r=d.world.renderer;
 const {pass,rtt,renderOutput,vec4,mix}=await import('/node_modules/three/build/three.tsl.js');
 const {FloatType,RedFormat,NearestFilter}=await import('/node_modules/three/build/three.webgpu.js');
 const {ao}=await import('/node_modules/three/examples/jsm/tsl/display/GTAONode.js');
 const {fxaa}=await import('/node_modules/three/examples/jsm/tsl/display/FXAANode.js');
 const scene=pass(d.world.scene,d.world.camera,{samples:4});
 const depth=rtt(scene.getTextureNode('depth').r,null,null,{type:FloatType,format:RedFormat,minFilter:NearestFilter,magFilter:NearestFilter});
 const beauty=scene.getTextureNode('output');const occlusion=ao(depth,null,d.world.camera);
 occlusion.radius.value=.85;occlusion.resolutionScale=.5;
 d.pipeline.post.outputColorTransform=false;d.pipeline.post.outputNode=fxaa(renderOutput(vec4(beauty.rgb.mul(mix(1,occlusion.r,.18)),beauty.a)));d.pipeline.post.needsUpdate=true;
 for(let i=0;i<3;i++){await window.__renderBeauty();}
 return {errors:window.__gpuErrors};
})()

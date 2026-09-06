(async()=>{
 const d=window.__grassDemo,r=d.world.renderer;const draw=r.backend.draw;let state;
 r.backend.draw=function(ro,info){if(ro.object.name==='Stone'&&ro.scene===d.world.scene)state=ro.getNodeBuilderState();return draw.call(this,ro,info);};
 try{await window.__renderBeauty();}finally{r.backend.draw=draw;}
 return {shader:state.fragmentShader.slice(-8500),uniforms:state.bindings.flatMap(b=>b.bindings.filter(x=>x.uniforms).map(x=>({name:x.name,uniforms:x.uniforms.map(u=>({name:u.name,value:u.node?.value??u.value}))})))};
})()

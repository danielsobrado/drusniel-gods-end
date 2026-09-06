import { createServer } from 'vite';
const server=await createServer({plugins:[{name:'refresh',configureServer(s){s.middlewares.use('/__refresh',(_req,res)=>{s.moduleGraph.invalidateAll();res.end('ok');});}}],server:{host:'127.0.0.1',port:5176,strictPort:true,hmr:false,watch:null}});await server.listen();server.printUrls();

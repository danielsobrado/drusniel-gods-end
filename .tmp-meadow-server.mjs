import { createServer } from 'vite';
const server = await createServer({plugins:[{name:'review-refresh',configureServer(server){server.middlewares.use('/__refresh',(_req,res)=>{server.moduleGraph.invalidateAll();res.end('ok');});}}],server:{host:'127.0.0.1',port:5176,strictPort:true,hmr:false,watch:null}});
await server.listen();server.printUrls();

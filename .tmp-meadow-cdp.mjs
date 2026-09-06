/* global WebSocket */
import fs from 'node:fs';
const args=process.argv.slice(2), base='http://127.0.0.1:9224';
const targets=await fetch(base+'/json/list').then(r=>r.json());
let target=targets.find(t=>t.url.includes('5176'));
if(!target)target=await fetch(base+'/json/new?about:blank',{method:'PUT'}).then(r=>r.json());
const ws=new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r=>ws.addEventListener('open',r,{once:true}));
let id=0;const pending=new Map();
ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id);}});
const send=(method,params={})=>new Promise(r=>{pending.set(++id,r);ws.send(JSON.stringify({id,method,params}));});
await send('Page.enable');await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
if(args.includes('--open')||args.includes('--reload')){
 await send('Page.addScriptToEvaluateOnNewDocument',{source:`window.__gpuErrors=[];const request=GPUAdapter.prototype.requestDevice;GPUAdapter.prototype.requestDevice=async function(...args){const d=await request.apply(this,args);d.addEventListener('uncapturederror',e=>{if(window.__gpuErrors.length<5)window.__gpuErrors.push(e.error.message)});return d;};`});
 if(args.includes('--reload')){await fetch('http://127.0.0.1:5176/__refresh');await send('Page.reload',{ignoreCache:true});}
 else await send('Page.navigate',{url:'http://127.0.0.1:5176/?character=drusniel'});
 for(const t of targets)if(t.url.includes('5173'))await fetch(base+'/json/close/'+t.id);
}
await new Promise(r=>setTimeout(r,Number(args[args.indexOf('--wait')+1])||1000));
if(args.includes('--eval'))console.log(JSON.stringify(await send('Runtime.evaluate',{expression:fs.readFileSync(args[args.indexOf('--eval')+1],'utf8'),returnByValue:true,awaitPromise:true,userGesture:true})));
console.log(JSON.stringify(await send('Runtime.evaluate',{expression:'({errors:window.__gpuErrors,ready:!!window.__grassDemo?.pipeline,text:document.body.innerText.slice(0,750)})',returnByValue:true})));
if(args.includes('--screenshot')){const shot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(args[args.indexOf('--screenshot')+1],Buffer.from(shot.result.data,'base64'));}
ws.close();
